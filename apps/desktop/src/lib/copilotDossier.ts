// Copilot ⇄ dossier fusion (CP3, Meeting Copilot family).
//
// Ties the pre-meeting dossier (CP2) into the live Meeting Copilot overlay:
//   1. `loadDossierContext()` — resolve the calendar event happening NOW to its
//      generated "Prep: …" note, then hand back a COMPACT prep-context string
//      (≤2k chars, for prompt injection) plus a parsed talking-points checklist.
//   2. `computeCovered()` — a pure, client-side keyword-overlap heuristic that
//      marks which planned talking points / questions have actually been raised
//      in the live transcript. No AI call — cheap, private, instant.
//
// Everything is graceful: no MS account, no live event, no dossier, or an
// unparseable note all resolve to `null` / an empty checklist, and the overlay
// works exactly as before.

import { dossierForEvent } from "@/lib/dossiers";
import { getMeeting } from "@/lib/lalela";
import { isMsConnected } from "@/lib/msauth";
import { currentCalendarEvent } from "@/lib/msgraph";
import { IS_MOBILE } from "@/lib/platform";

/** Cap on the prep-context string injected ahead of the transcript (~2k). */
export const DOSSIER_CTX_CHARS = 2000;
/** Time-box the "which event is happening now" probe so opening the overlay
 * never waits on the network (mirrors RecordingView's calendar match). */
const EVENT_PROBE_MS = 2500;
/** Keep the checklist tidy — a dossier lists 3–5 talking points + 2–3 questions. */
const MAX_ITEMS = 12;

/** One parsed checklist row from the dossier. */
export interface PlanItem {
  id: string;
  kind: "talking" | "question";
  text: string;
}

export interface DossierContext {
  /** The live meeting's title (event subject, else the note title). */
  eventTitle: string;
  /** Compact prep context for prompt injection (≤ {@link DOSSIER_CTX_CHARS}). */
  context: string;
  /** Parsed "Suggested talking points" + "Questions to ask" for "Your plan". */
  items: PlanItem[];
}

// --- Markdown parsing -------------------------------------------------------

interface Section {
  heading: string;
  body: string;
}

/** Split the dossier markdown into `##`-delimited sections (any `#` depth). */
function parseSections(md: string): Section[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  for (const line of md.split("\n")) {
    const m = /^\s{0,3}#{1,6}\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) sections.push(cur);
      cur = { heading: m[1].trim(), body: "" };
    } else if (cur) {
      cur.body += (cur.body ? "\n" : "") + line;
    }
  }
  if (cur) sections.push(cur);
  return sections;
}

const isTalking = (h: string) => /talking\s*point/i.test(h);
const isQuestions = (h: string) => /question/i.test(h);

/** Bullet / numbered lines in a section body, cleaned of markdown emphasis. */
function bulletLines(body: string): string[] {
  const out: string[] = [];
  for (const raw of body.split("\n")) {
    const m = /^(?:[-*•]|\d+[.)])\s+(.+)$/.exec(raw.trim());
    if (!m) continue;
    const t = m[1].replace(/[*_`]/g, "").trim();
    if (t.length >= 2) out.push(t);
  }
  return out;
}

/** Collect talking-point + question bullets into an ordered checklist. */
function parseItems(sections: Section[]): PlanItem[] {
  const items: PlanItem[] = [];
  let n = 0;
  for (const s of sections) {
    const kind: PlanItem["kind"] | null = isTalking(s.heading)
      ? "talking"
      : isQuestions(s.heading)
        ? "question"
        : null;
    if (!kind) continue;
    for (const text of bulletLines(s.body)) {
      items.push({ id: `p${n++}`, kind, text });
      if (items.length >= MAX_ITEMS) return items;
    }
  }
  return items;
}

/** Drop the generator's "---\n_Auto-prepared…_" trailer. */
function stripFooter(md: string): string {
  const idx = md.lastIndexOf("\n---");
  if (idx > 0 && /auto-prepared/i.test(md.slice(idx))) return md.slice(0, idx).trim();
  return md.trim();
}

/**
 * A compact prep context (≤2k). Uses the note as-is when it fits; otherwise
 * keeps whole sections in usefulness order (talking points + questions first,
 * then purpose, threads, people) until the budget is spent.
 */
function compactContext(md: string, sections: Section[]): string {
  const clean = stripFooter(md);
  if (clean.length <= DOSSIER_CTX_CHARS) return clean;

  const priority = ["talking point", "question", "why this meeting", "open thread", "people", "last time"];
  const rank = (h: string) => {
    const lh = h.toLowerCase();
    const i = priority.findIndex((p) => lh.includes(p));
    return i === -1 ? priority.length : i;
  };
  const ordered = [...sections].sort((a, b) => rank(a.heading) - rank(b.heading));

  let out = "";
  for (const s of ordered) {
    const block = `## ${s.heading}\n${s.body.trim()}`.trim();
    if (out.length + block.length + 2 > DOSSIER_CTX_CHARS) {
      const remaining = DOSSIER_CTX_CHARS - out.length - 2;
      if (remaining > 120) out += (out ? "\n\n" : "") + block.slice(0, remaining).trimEnd();
      break;
    }
    out += (out ? "\n\n" : "") + block;
  }
  return out || clean.slice(0, DOSSIER_CTX_CHARS).trimEnd();
}

// --- Loader -----------------------------------------------------------------

/**
 * Resolve the dossier for the meeting happening NOW, or null. Reuses
 * `currentCalendarEvent()` — the exact selector RecordingView used to match the
 * live recording — so the overlay lands on the same event, then the CP2
 * `event-id → meetingId` map, then the note's markdown (stored in `notes`).
 *
 * Never throws: any missing link (no MS account, no live event, no dossier,
 * empty note) resolves to null and the overlay runs dossier-free.
 */
export async function loadDossierContext(now = Date.now()): Promise<DossierContext | null> {
  if (IS_MOBILE || !isMsConnected()) return null;

  let event: Awaited<ReturnType<typeof currentCalendarEvent>> = null;
  try {
    event = await Promise.race([
      currentCalendarEvent(now).catch(() => null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), EVENT_PROBE_MS)),
    ]);
  } catch {
    return null;
  }
  if (!event?.id) return null;

  const rec = dossierForEvent(event.id);
  if (!rec) return null;

  let md = "";
  try {
    const meeting = await getMeeting(rec.meetingId);
    md = (meeting.notes ?? "").trim();
    if (!md) return null;
    const sections = parseSections(md);
    const eventTitle =
      (event.subject ?? "").trim() || meeting.title.replace(/^Prep:\s*/i, "").trim();
    return { eventTitle, context: compactContext(md, sections), items: parseItems(sections) };
  } catch {
    return null;
  }
}

// --- Coverage heuristic (pure, client-side, no AI) --------------------------

const COVERAGE_THRESHOLD = 0.6;

/** Function words + soft meta-verbs that carry no topical signal — stripped so
 * "Discuss the Q3 budget" matches on "q3"/"budget", not "discuss"/"the". */
const COVERAGE_STOPWORDS = new Set([
  "the", "and", "for", "with", "our", "your", "you", "yours", "their", "this",
  "that", "these", "those", "about", "into", "from", "have", "has", "had",
  "are", "was", "were", "been", "being", "will", "would", "should", "could",
  "can", "may", "might", "not", "but", "any", "all", "who", "what", "when",
  "where", "why", "how", "which", "whom", "get", "got", "make", "made", "need",
  "want", "discuss", "ask", "raise", "mention", "talk", "cover", "share",
  "them", "they", "his", "her", "its", "out", "off", "per", "via", "onto",
]);

/** Light stem: fold common English inflections so "budgets"/"budget",
 * "risks"/"risk" collapse. Only for words long enough to survive it. */
function stem(w: string): string {
  if (w.length > 4) return w.replace(/(?:ings?|ed|es|s)$/, "");
  return w;
}

/** Significant word-stems in a piece of text (lowercased alnum tokens ≥3 chars,
 * minus stopwords), stemmed. */
function significantStems(text: string): string[] {
  const out: string[] = [];
  for (const w of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) {
    if (w.length < 3 || COVERAGE_STOPWORDS.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

/**
 * Return the set of plan-item ids "covered" by the transcript so far. Coverage
 * is STICKY: `prev` (already-covered) ids are always kept, so an item raised
 * early stays checked even as the transcript ring-buffer scrolls past it. An
 * item is newly covered when ≥60% of its significant word-stems appear in the
 * transcript. Returns `prev` unchanged (same ref) when nothing new matches.
 */
export function computeCovered(
  items: PlanItem[],
  transcript: string,
  prev: Set<string>,
): Set<string> {
  if (items.length === 0) return prev;
  const have = new Set(significantStems(transcript));
  if (have.size === 0) return prev;

  let next: Set<string> | null = null;
  for (const it of items) {
    if (prev.has(it.id)) continue;
    const stems = [...new Set(significantStems(it.text))];
    if (stems.length === 0) continue;
    let hit = 0;
    for (const s of stems) if (have.has(s)) hit++;
    if (hit / stems.length >= COVERAGE_THRESHOLD) {
      if (!next) next = new Set(prev);
      next.add(it.id);
    }
  }
  return next ?? prev;
}
