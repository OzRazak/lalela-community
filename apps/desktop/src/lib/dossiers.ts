// Automatic pre-meeting dossiers (CP2, part of the Meeting Copilot family).
//
// Before a calendar meeting starts, Lalela quietly prepares a briefing note so
// the user walks in with context. Everything runs DESKTOP-SIDE: the Microsoft
// Graph tokens live in the macOS Keychain (desktop-only), so there is no
// server that could assemble this — the generator has to be here.
//
// Shape (mirrors trayAgenda / the Teams-import poller):
//   • a poller that ticks on launch + every 15 min while the app is alive,
//   • one dossier PER calendar event ever (tracked by event id in localStorage),
//   • generation defaults to the on-device lane (local GGUF, then Apple) so it
//     costs ~nothing and never touches quota; falls back to the user's default
//     model only when no on-device model is available,
//   • every step is non-fatal and silent — a failed dossier logs to the console
//     and is retried on the next tick; an event is marked done ONLY after its
//     note has actually been saved (so a mid-flight failure never "burns" it).

import {
  appleLlmStatus,
  formatDate,
  getMeeting,
  listActionItems,
  localLlmStatus,
  saveMeeting,
  searchTranscripts,
  type ActionItem,
  type Attendee,
  type TranscriptHit,
} from "@/lib/lalela";
import {
  APPLE_MODEL_ID,
  DEFAULT_LOCAL_MODEL,
  getModel,
  getPrompts,
  LOCAL_MODEL_CATALOG,
  localModelId,
} from "@/lib/settings";
import { aiGenerate } from "@/lib/ai";
import { connectedAccount, isMsConnected } from "@/lib/msauth";
import {
  eventAttendees,
  graphDateMs,
  upcomingEvents,
  type GraphEvent,
} from "@/lib/msgraph";
import { IS_MOBILE } from "@/lib/platform";

// --- Preferences (Settings → "Meeting prep") --------------------------------

const KEYS = {
  enabled: "lalela.dossiers.enabled",
  leadHours: "lalela.dossiers.leadHours",
  map: "lalela.dossiers.map",
} as const;

/** Fires whenever a Meeting-prep preference changes, so the running scheduler
 * can re-tick immediately (flipping the toggle on shouldn't wait 15 min). */
export const DOSSIER_SETTINGS_CHANGED_EVENT = "lalela:dossier-settings-changed";

/** Fires after a dossier note is saved, so the meetings list refreshes and the
 * "Coming up" rail can surface its "Prep ready" affordance without a reload. */
export const DOSSIER_CHANGED_EVENT = "lalela:dossiers-changed";

/** Master switch. DEFAULT OFF (v1): it generates AI content on a schedule, so
 * the user opts in explicitly. */
export function getDossiersEnabled(): boolean {
  return localStorage.getItem(KEYS.enabled) === "true";
}
export function setDossiersEnabled(value: boolean): void {
  localStorage.setItem(KEYS.enabled, String(value));
  window.dispatchEvent(new CustomEvent(DOSSIER_SETTINGS_CHANGED_EVENT));
}

/** How far ahead a meeting must be to earn a dossier, in hours. Default 12.
 * Allowed: 6 / 12 / 24. */
export const DOSSIER_LEAD_OPTIONS = [6, 12, 24] as const;
export function getDossierLeadHours(): number {
  const n = Number(localStorage.getItem(KEYS.leadHours));
  return (DOSSIER_LEAD_OPTIONS as readonly number[]).includes(n) ? n : 12;
}
export function setDossierLeadHours(hours: number): void {
  localStorage.setItem(KEYS.leadHours, String(hours));
  window.dispatchEvent(new CustomEvent(DOSSIER_SETTINGS_CHANGED_EVENT));
}

// --- Event → dossier map (one dossier per event, forever) -------------------

export interface DossierRecord {
  /** The local meeting id of the generated "Prep: …" note. */
  meetingId: string;
  /** When the dossier was generated (epoch ms). */
  generatedAt: number;
}

type DossierMap = Record<string, DossierRecord>;

export function getDossierMap(): DossierMap {
  const raw = localStorage.getItem(KEYS.map);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as DossierMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** The dossier for a calendar event id, or null. Used by the "Coming up" rail. */
export function dossierForEvent(eventId: string | undefined | null): DossierRecord | null {
  if (!eventId) return null;
  return getDossierMap()[eventId] ?? null;
}

function markDossier(eventId: string, meetingId: string): void {
  const map = getDossierMap();
  map[eventId] = { meetingId, generatedAt: Date.now() };
  localStorage.setItem(KEYS.map, JSON.stringify(map));
}

// --- Model selection (on-device lane by default) ----------------------------

/**
 * The model a dossier should generate with. Prefers a DOWNLOADED local GGUF
 * (free, on-device, zero quota), then Apple's on-device model, and only falls
 * back to the user's default (cloud/BYOK/free) model when neither is present.
 * Latency is irrelevant here (background work), so cheapest-on-device wins.
 */
async function pickDossierModel(): Promise<string> {
  try {
    const statuses = await localLlmStatus(LOCAL_MODEL_CATALOG.map((s) => s.file));
    const present = new Set(statuses.filter((s) => s.present).map((s) => s.file));
    if (present.size > 0) {
      // Prefer the catalog default when it's downloaded, else the first present.
      if (present.has(DEFAULT_LOCAL_MODEL.file)) return localModelId(DEFAULT_LOCAL_MODEL);
      const spec = LOCAL_MODEL_CATALOG.find((s) => present.has(s.file));
      if (spec) return localModelId(spec);
    }
  } catch {
    /* status probe failed — fall through */
  }
  try {
    const apple = await appleLlmStatus();
    if (apple.available) return APPLE_MODEL_ID;
  } catch {
    /* Apple probe failed — fall through */
  }
  return getModel();
}

// --- The dossier prompt -----------------------------------------------------

const DEFAULT_DOSSIER_PROMPT = [
  "You are a meeting-prep assistant. Using ONLY the context provided (an upcoming",
  "calendar meeting, related past meetings, open action items and the user's",
  "workspace background), write a short pre-meeting briefing in Markdown so the",
  "user can walk in prepared. Use EXACTLY these sections, each as a `##` heading,",
  "and omit a section only if there is genuinely nothing to say for it:",
  "",
  "## Why this meeting matters",
  "One or two lines on the purpose / stakes, inferred from the title and history.",
  "",
  "## People",
  "Who the attendees are, drawn from past meetings — role, what they care about,",
  "recent involvement. One bullet per person. Skip people you know nothing about.",
  "",
  "## Last time you spoke",
  "Key points and decisions from the most relevant past meeting(s), with dates.",
  "",
  "## Open threads",
  "Unfinished action items or loose ends relevant to this meeting or these people.",
  "",
  "## Suggested talking points",
  "3–5 concrete things worth raising, grounded in the history.",
  "",
  "## Questions to ask",
  "2–3 sharp questions to move things forward.",
  "",
  "Be concise and specific. Do NOT invent facts, names, dates or commitments that",
  "are not in the context — if the history is thin, say so briefly rather than",
  "guessing. Write in the second person ('you').",
].join("\n");

/**
 * The system prompt for an event. Advanced (nice-to-have): if a library Prompt
 * is titled `Dossier: <keyword>` and `<keyword>` appears in the event title
 * (case-insensitive), use that prompt's text instead of the built-in default —
 * lets a user tailor prep for a recurring meeting kind.
 */
function pickDossierPrompt(title: string): string {
  const lowerTitle = title.toLowerCase();
  try {
    for (const p of getPrompts()) {
      const m = /^dossier:\s*(.+)$/i.exec(p.name.trim());
      if (!m) continue;
      const keyword = m[1].trim().toLowerCase();
      if (keyword && lowerTitle.includes(keyword) && p.text.trim()) return p.text;
    }
  } catch {
    /* prompt library unreadable — use the default */
  }
  return DEFAULT_DOSSIER_PROMPT;
}

// --- Context assembly -------------------------------------------------------

/** Cap on the retrieval context handed to the model (~8k chars). The workspace
 * card is added on top by `aiGenerate` (assembleSystemContext), same as every
 * other generation. */
const CONTEXT_BUDGET_CHARS = 8000;

const STOPWORDS = new Set([
  "the", "and", "for", "with", "our", "your", "you", "meeting", "meet", "call",
  "sync", "syncup", "weekly", "monthly", "daily", "biweekly", "catch", "catchup",
  "chat", "standup", "checkin", "check", "review", "session", "quick", "team",
  "about", "from", "into", "this", "that", "new", "update", "updates",
]);

/** Generic mailbox providers whose domain says nothing about the org. */
const GENERIC_DOMAINS = new Set([
  "gmail", "googlemail", "outlook", "hotmail", "live", "yahoo", "ymail",
  "icloud", "me", "mac", "proton", "protonmail", "aol", "msn", "gmx",
]);

function firstName(name: string): string {
  return name.trim().split(/\s+/)[0] ?? "";
}

/** Lowercased set of attendee names + first names to match action-item
 * assignees against. Excludes the connected user (a briefing is about the
 * OTHER people). */
function attendeeNameSet(others: Attendee[]): Set<string> {
  const set = new Set<string>();
  for (const a of others) {
    const name = (a.name ?? "").trim().toLowerCase();
    if (name) {
      set.add(name);
      const fn = firstName(name);
      if (fn.length >= 3) set.add(fn);
    }
  }
  return set;
}

/** Build a single FTS query from attendee names/emails + significant title
 * keywords. `search_transcripts` splits on whitespace, strips non-alphanumerics
 * per word and OR-matches — so we pre-tokenise emails ourselves (otherwise
 * "jo@acme.com" collapses to one junk token) and hand back space-separated
 * words. */
function buildSearchTerms(title: string, others: Attendee[]): string {
  const terms = new Set<string>();
  const add = (w: string) => {
    const t = w.toLowerCase().replace(/[^a-z0-9]/g, "");
    if (t.length >= 3 && !STOPWORDS.has(t)) terms.add(t);
  };

  for (const w of title.split(/\s+/)) add(w);

  for (const a of others) {
    for (const w of (a.name ?? "").split(/\s+/)) add(w);
    const email = (a.email ?? "").trim().toLowerCase();
    if (email.includes("@")) {
      const [local, domain] = email.split("@");
      for (const w of local.split(/[._\-+]/)) add(w);
      const label = (domain ?? "").split(".")[0];
      if (label && !GENERIC_DOMAINS.has(label)) add(label);
    }
  }

  // search_transcripts itself keeps only the first 12 terms.
  return [...terms].slice(0, 12).join(" ");
}

interface PastMeeting {
  id: string;
  title: string;
  created_at: number;
  summary: string;
  snippet: string;
}

function attendeeEmailSet(list: Attendee[]): Set<string> {
  const s = new Set<string>();
  for (const a of list) {
    const e = (a.email ?? "").trim().toLowerCase();
    if (e) s.add(e);
  }
  return s;
}

/** Rank FTS hits by (attendee overlap in the meeting's stored attendees, then
 * FTS relevance) and return the top 3–5, enriched with each meeting's full
 * summary. Enriching (`getMeeting`) is bounded to the top few candidates so the
 * background pass stays cheap. */
async function selectPastMeetings(
  hits: TranscriptHit[],
  others: Attendee[],
): Promise<PastMeeting[]> {
  const seen = new Set<string>();
  const ordered = hits.filter((h) => {
    if (seen.has(h.meeting_id)) return false;
    seen.add(h.meeting_id);
    return true;
  });

  const wantEmails = attendeeEmailSet(others);
  const wantNames = attendeeNameSet(others);

  const scored: Array<{ m: PastMeeting; overlap: number; rank: number }> = [];
  for (let i = 0; i < Math.min(ordered.length, 8); i++) {
    const h = ordered[i];
    let full;
    try {
      full = await getMeeting(h.meeting_id);
    } catch {
      continue;
    }
    let overlap = 0;
    for (const a of full.attendees ?? []) {
      const email = (a.email ?? "").trim().toLowerCase();
      const name = (a.name ?? "").trim().toLowerCase();
      if (email && wantEmails.has(email)) overlap++;
      else if (name && (wantNames.has(name) || wantNames.has(firstName(name)))) overlap++;
    }
    scored.push({
      m: {
        id: h.meeting_id,
        title: full.title,
        created_at: full.created_at,
        summary: full.summary ?? "",
        snippet: h.snippet ?? "",
      },
      overlap,
      rank: i,
    });
  }

  scored.sort((a, b) => b.overlap - a.overlap || a.rank - b.rank);
  return scored.slice(0, 5).map((s) => s.m);
}

/** Open (not-done) action items involving the attendees or coming from the
 * selected past meetings. One `list_action_items` call (the kanban feed). */
async function openActionItems(
  others: Attendee[],
  pastIds: Set<string>,
): Promise<ActionItem[]> {
  let all: ActionItem[];
  try {
    all = await listActionItems();
  } catch {
    return [];
  }
  const names = attendeeNameSet(others);
  const picked = all.filter((it) => {
    if (it.status === "done") return false;
    const assignee = (it.assignee_name ?? "").trim().toLowerCase();
    const byAttendee =
      assignee !== "" && (names.has(assignee) || names.has(firstName(assignee)));
    return byAttendee || pastIds.has(it.meeting_id);
  });
  return picked.slice(0, 12);
}

function clip(s: string, budget: number): string {
  const trimmed = s.trim();
  return trimmed.length <= budget ? trimmed : trimmed.slice(0, budget).trimEnd();
}

/** Assemble the retrieval context (everything except the workspace card, which
 * `aiGenerate` prepends). */
async function buildContext(
  title: string,
  startMs: number | null,
  others: Attendee[],
): Promise<string> {
  const parts: string[] = [];

  const when = startMs !== null ? formatDate(startMs) : "time unknown";
  const attLines = others
    .map((a) => `- ${a.name ?? a.email ?? "Unknown"}${a.email ? ` <${a.email}>` : ""}`)
    .join("\n");
  parts.push(
    `# Upcoming meeting\nTitle: ${title}\nWhen: ${when}` +
      (attLines ? `\nAttendees:\n${attLines}` : "\nAttendees: (none listed)"),
  );

  const query = buildSearchTerms(title, others);
  let hits: TranscriptHit[] = [];
  if (query) {
    try {
      hits = await searchTranscripts(query, null, 12);
    } catch {
      hits = [];
    }
  }

  const past = await selectPastMeetings(hits, others);
  if (past.length > 0) {
    const blocks = past.map((m) => {
      const body = (m.summary.trim() || m.snippet.trim() || "(no summary)").slice(0, 600);
      return `## ${m.title} — ${formatDate(m.created_at)}\n${body}`;
    });
    parts.push(`# Related past meetings\n\n${blocks.join("\n\n")}`);
  }

  const items = await openActionItems(others, new Set(past.map((m) => m.id)));
  if (items.length > 0) {
    const lines = items.map((it) => {
      const who = it.assignee_name ? ` — ${it.assignee_name}` : "";
      return `- ${it.title}${who} [${it.meeting_title}] (${it.status})`;
    });
    parts.push(`# Open action items\n${lines.join("\n")}`);
  }

  if (past.length === 0 && items.length === 0) {
    parts.push("# History\nNo related past meetings or open action items were found.");
  }

  return clip(parts.join("\n\n"), CONTEXT_BUDGET_CHARS);
}

// --- Generation -------------------------------------------------------------

/**
 * Generate and save ONE dossier for `event`. Returns the new meeting id, or
 * null if it was skipped/failed (never throws — the caller is a silent poller).
 * The event is marked done in the map ONLY after the note is saved.
 */
export async function generateDossier(event: GraphEvent): Promise<string | null> {
  const eventId = event.id;
  if (!eventId) return null;
  try {
    const title = (event.subject ?? "").trim() || "Untitled meeting";
    const startMs = graphDateMs(event.start);

    // All attendees (stored on the note); "others" excludes the connected user
    // — a briefing is about the other people.
    const allAttendees = eventAttendees(event);
    const me = connectedAccount();
    const myEmail = (me?.mail ?? "").trim().toLowerCase();
    const myName = (me?.displayName ?? "").trim().toLowerCase();
    const others = allAttendees.filter((a) => {
      const email = (a.email ?? "").trim().toLowerCase();
      const name = (a.name ?? "").trim().toLowerCase();
      if (email && email === myEmail) return false;
      if (!email && name && name === myName) return false;
      return true;
    });

    const context = await buildContext(title, startMs, others);
    const system = pickDossierPrompt(title);
    const model = await pickDossierModel();

    let markdown: string;
    try {
      markdown = (await aiGenerate(context, system, model)).trim();
    } catch (e) {
      // NoAiError / quota / offline / sidecar hiccup — silent, retry next tick.
      console.debug("[dossiers] generation skipped:", e);
      return null;
    }
    if (!markdown) return null;

    const body = `${markdown}\n\n---\n_Auto-prepared by Lalela Meeting Copilot before your meeting._`;
    const saved = await saveMeeting({
      title: `Prep: ${title}`,
      project_id: null,
      segments: [],
      notes: body,
      summary: "",
      images: [],
      attendees: allAttendees.length > 0 ? allAttendees : null,
    });

    markDossier(eventId, saved.id);
    window.dispatchEvent(new CustomEvent(DOSSIER_CHANGED_EVENT));
    return saved.id;
  } catch (e) {
    console.debug("[dossiers] dossier failed:", e);
    return null;
  }
}

// --- Scheduler --------------------------------------------------------------

const TICK_MS = 15 * 60 * 1000;

// A tick is in progress — never overlap ticks (a slow generation could outlast
// the interval). Within a tick, events are processed sequentially, so exactly
// one generation runs at a time and the rest queue behind it.
let ticking = false;

async function tick(): Promise<void> {
  if (IS_MOBILE || ticking) return;
  if (!getDossiersEnabled() || !isMsConnected()) return;
  ticking = true;
  try {
    const now = Date.now();
    const leadMs = getDossierLeadHours() * 60 * 60 * 1000;

    let events: GraphEvent[];
    try {
      // Scan the next 24h (generous cap); the lead window filters within it.
      events = await upcomingEvents(now, 1, 50);
    } catch {
      // Token expiry / offline / Graph hiccup — silent, retry next tick.
      return;
    }

    const due = events.filter((e) => {
      if (!e.id) return false;
      const start = graphDateMs(e.start);
      if (start === null || start < now) return false; // not yet started only
      if (start - now > leadMs) return false; // outside the lead window
      return !getDossierMap()[e.id]; // exactly one dossier per event
    });

    for (const e of due) {
      // Re-check the map each time — a prior iteration (or another surface)
      // may have just recorded it.
      if (e.id && getDossierMap()[e.id]) continue;
      await generateDossier(e);
    }
  } finally {
    ticking = false;
  }
}

/**
 * Start the pre-meeting dossier scheduler: tick once on launch, then every 15
 * minutes, plus immediately whenever a Meeting-prep preference changes (so
 * flipping the toggle on doesn't wait for the next interval). No-op on mobile.
 * Returns a stop function.
 */
export function startDossierScheduler(): () => void {
  if (IS_MOBILE) return () => {};
  void tick();
  const id = window.setInterval(() => void tick(), TICK_MS);
  const onSettings = () => void tick();
  window.addEventListener(DOSSIER_SETTINGS_CHANGED_EVENT, onSettings);
  return () => {
    window.clearInterval(id);
    window.removeEventListener(DOSSIER_SETTINGS_CHANGED_EVENT, onSettings);
  };
}
