// The desktop automation engine (phase 19 / B7) — the native-side twin of the
// cloud engine (apps/web/lib/automations/engine.ts). It evaluates a user's tag
// automations against locally-ingested meetings (native recordings, Teams
// imports, cloud pull-downs) and runs the matched actions, mirroring the web
// engine's semantics EXACTLY: same deterministic match, same AI-classify
// prompt/parse, same action set, same ledger guards.
//
// Dedupe source of truth is the SHARED cloud automation_runs ledger when signed
// in (unique on meeting+tag+action): whichever engine records the "tag" row
// first "wins" and runs the actions; the other treats it as done. We ALSO
// always record to the local SQLite ledger so the Automations UI works offline.
// Signed out, everything happens purely locally.
//
// AI runs through the one front door (aiGenerate) — local sidecar / BYOK / free
// proxy — so classification and summaries work even fully offline on a local
// model. Best-effort throughout: an automation failure must never break saving
// or importing a meeting; callers fire-and-forget with .catch.

import { countBucket, trackEvent } from "./analytics";
import {
  getMeeting,
  moveMeetingToProject,
  updateMeeting,
  listWorkflows,
  setWorkflowOutput,
  transcriptToText,
  type FullMeeting,
  type Workflow,
} from "@/lib/lalela";
import {
  addMeetingTag,
  hasAutomationRun,
  listAutomations,
  recordAutomationRun,
  type Automation,
  type AutomationAiClassify,
  type AutomationMatch,
  type AutomationSend,
  type RunStatus,
} from "@/lib/tags";
import {
  cloudAddMeetingTag,
  cloudHasAutomationRun,
  cloudRecordAutomationRun,
  currentUid,
  accessToken,
} from "@/lib/automationsSync";
import { aiGenerate, LALELA_API } from "@/lib/ai";
import { pushMeeting } from "@/lib/sync";
import { sendAtlasPack } from "@/lib/atlasPack";
import { getModel, resolveLegacyModel } from "@/lib/settings";
import { autogenModel } from "@/lib/autogen";
import { CLOUD_AI_CONSENT_EVENT, getCloudAiConsent, isAiConsentError } from "@/lib/aiConsent";
import {
  automationAiModels,
  classifyMatch,
  createKeyedLock,
  deferKey,
  lookupErrors,
  parseDeferred,
  splitDeferKey,
  type AutomationLookup,
} from "@/lib/automationsCore";

/** The facts a rule matches against — mirrors the cloud engine's MeetingFacts. */
export interface MeetingFacts {
  id: string;
  title: string;
  source: string; // 'desktop' | 'web' | 'teams' | 'readai' | 'granola' | …
  startedAt: string; // ISO
  attendees: { name?: string | null; email?: string | null }[] | null;
  /** Distinct diarized speaker names (generic labels excluded). */
  speakerNames: string[];
  /** First ~4k chars of the transcript — read by AI classification only. */
  transcriptExcerpt?: string;
}

const CLASSIFY_EXCERPT_CHARS = 4000;
const SUMMARY_INPUT_CHARS = 24000;
const WORKFLOW_INPUT_CHARS = 24000;

// ---- shape helpers (identical semantics to the web engine) ----

/** Derive the ingestion source from a meeting id. Native recordings and
 * audio imports have no connector prefix → "desktop". */
export function sourceForMeetingId(id: string): string {
  if (id.startsWith("conn-teams-")) return "teams";
  if (id.startsWith("web-")) return "web";
  const m = id.match(/^conn-([a-z0-9]+)-/i);
  if (m) return m[1].toLowerCase();
  return "desktop";
}

/** Distinct speaker names, minus generic diarization labels (they carry no
 * identity, so rules must not match on them). */
export function speakerNamesFrom(segments: { speaker?: string }[]): string[] {
  const names = new Set<string>();
  for (const s of segments) {
    const n = (s.speaker ?? "").trim();
    if (n && !/^(speaker\s*\w*|me|others|you)$/i.test(n)) names.add(n);
  }
  return [...names];
}

export function meetingFactsFrom(m: FullMeeting, sourceOverride?: string): MeetingFacts {
  const excerpt = transcriptToText(m.segments).slice(0, CLASSIFY_EXCERPT_CHARS);
  return {
    id: m.id,
    title: m.title,
    source: sourceOverride ?? sourceForMeetingId(m.id),
    startedAt: new Date(m.created_at).toISOString(),
    attendees: m.attendees ?? null,
    speakerNames: speakerNamesFrom(m.segments),
    transcriptExcerpt: excerpt,
  };
}

export function classifyPrompt(m: MeetingFacts, hint: string): { system: string; user: string } {
  const attendees = (m.attendees ?? [])
    .map((a) => [a.name, a.email].filter(Boolean).join(" "))
    .filter(Boolean);
  const who = [...attendees, ...m.speakerNames].join(", ") || "unknown";
  return {
    system:
      'You classify meetings. Decide whether this meeting matches the user\'s category description. Respond with ONLY the JSON object {"match": true} or {"match": false} — no prose, no code fences.',
    user: [
      `Category description: ${hint}`,
      "",
      `Meeting title: ${m.title}`,
      `Source: ${m.source} · Started: ${m.startedAt}`,
      `Participants: ${who}`,
      "",
      "Transcript excerpt:",
      (m.transcriptExcerpt ?? "").slice(0, CLASSIFY_EXCERPT_CHARS) || "(no transcript)",
    ].join("\n"),
  };
}

/** Defensive parse — anything that isn't an explicit {"match": true} is a no. */
export function parseClassifyResult(content: string): boolean {
  try {
    const json = content.match(/\{[\s\S]*?\}/);
    if (!json) return false;
    return (JSON.parse(json[0]) as { match?: unknown }).match === true;
  } catch {
    return false;
  }
}

/** OR across configured groups; schedule_window (when set) ANDs with the rest. */
export function deterministicMatch(match: AutomationMatch, m: MeetingFacts): boolean {
  const groups: boolean[] = [];

  if (match.title_keywords?.length) {
    const title = m.title.toLowerCase();
    groups.push(
      match.title_keywords.some((k) => k.trim() && title.includes(k.trim().toLowerCase())),
    );
  }
  if (match.attendee_emails?.length) {
    const emails = new Set(
      (m.attendees ?? [])
        .map((a) => a.email?.trim().toLowerCase())
        .filter((e): e is string => !!e),
    );
    groups.push(match.attendee_emails.some((e) => emails.has(e.trim().toLowerCase())));
  }
  if (match.attendee_names?.length) {
    const names = [...(m.attendees ?? []).map((a) => a.name ?? ""), ...m.speakerNames].map((n) =>
      n.toLowerCase(),
    );
    groups.push(
      match.attendee_names.some((q) => {
        const needle = q.trim().toLowerCase();
        return !!needle && names.some((n) => n.includes(needle));
      }),
    );
  }
  if (match.sources?.length) {
    groups.push(match.sources.includes(m.source));
  }

  if (groups.length === 0 || !groups.some(Boolean)) return false;

  const win = match.schedule_window as
    | { days?: number[]; start_hhmm?: string; end_hhmm?: string; utc_offset_minutes?: number }
    | undefined;
  if (win) {
    const offsetMin = win.utc_offset_minutes ?? 0;
    const local = new Date(Date.parse(m.startedAt) + offsetMin * 60_000);
    if (win.days?.length && !win.days.includes(local.getUTCDay())) return false;
    const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
    const parse = (hhmm: string) => {
      const [h, mnt] = hhmm.split(":").map(Number);
      return (h || 0) * 60 + (mnt || 0);
    };
    if (win.start_hhmm && minutes < parse(win.start_hhmm)) return false;
    if (win.end_hhmm && minutes > parse(win.end_hhmm)) return false;
  }
  return true;
}

// ---- ledger (cloud is source of truth when signed in; always also local) ----

/** True = this (meeting, tag, action) was already handled by either engine. */
async function ledgerHas(
  owner: string | null,
  meetingId: string,
  tagId: string,
  action: string,
): Promise<boolean> {
  if (owner) {
    try {
      if (await cloudHasAutomationRun(meetingId, tagId, action)) return true;
    } catch {
      /* cloud unreachable — fall back to local */
    }
  }
  try {
    return await hasAutomationRun(meetingId, tagId, action);
  } catch {
    return false;
  }
}

/** Record a run to both ledgers. Returns whether WE claimed it (true) — a
 * cloud unique-constraint violation means the cloud engine won (false). */
async function ledgerRecord(
  owner: string | null,
  run: {
    meeting_id: string;
    tag_id: string;
    action: string;
    status: RunStatus;
    detail?: Record<string, unknown>;
  },
): Promise<boolean> {
  let won = true;
  if (owner) {
    try {
      won = await cloudRecordAutomationRun({ owner_id: owner, ran_by: "desktop", ...run });
    } catch {
      won = true; // cloud unreachable — proceed locally
    }
  }
  await recordAutomationRun({ ran_by: "desktop", ...run }).catch(() => {});
  return won;
}

/** Every model a run of these automations can call, each action resolved the
 * way the engine resolves it (see automationsCore `automationAiModels`).
 * User-started runs preflight cloud-AI consent against this list. */
export async function automationsAiModels(list: Automation[]): Promise<string[]> {
  const needsWorkflows = list.some((a) => a.actions.workflow_id);
  const workflows = needsWorkflows ? await listWorkflows().catch(() => [] as Workflow[]) : [];
  const d = { defaultModel: getModel(), autogenModel: autogenModel(), resolve: resolveLegacyModel };
  const out = new Set<string>();
  for (const a of list) {
    const wf = a.actions.workflow_id
      ? (workflows.find((w) => w.id === a.actions.workflow_id)?.blocks ?? null)
      : null;
    for (const m of automationAiModels(a, wf, d)) out.add(m);
  }
  return [...out];
}

// ---- consent-deferred pairs ----
// A (meeting, automation) pair whose AI actions were skipped because cloud-AI
// consent was still unanswered. Its "tag" ledger row is already claimed, so
// without this marker a later run would return "already done" and the AI
// actions could never run. Device-local on purpose: only the engine that
// claimed the tag row (this one) may resume its actions.

const DEFER_STORE = "lalela.automations.consentDeferred";

function readDeferred(): Set<string> {
  try {
    return parseDeferred(localStorage.getItem(DEFER_STORE));
  } catch {
    return new Set();
  }
}

function setDeferred(meetingId: string, tagId: string, on: boolean): void {
  const s = readDeferred();
  const k = deferKey(meetingId, tagId);
  if (on === s.has(k)) return;
  if (on) s.add(k);
  else s.delete(k);
  try {
    localStorage.setItem(DEFER_STORE, JSON.stringify([...s]));
  } catch {
    /* storage full / unavailable — best-effort */
  }
}

let resumeInstalled = false;
/** When the user allows cloud AI, run the AI actions that were skipped while
 * the consent was unanswered (background, best-effort). Called once from App. */
export function installAutomationConsentResume(): void {
  if (resumeInstalled) return;
  resumeInstalled = true;
  window.addEventListener(CLOUD_AI_CONSENT_EVENT, () => {
    if (getCloudAiConsent() !== "granted") return;
    void (async () => {
      for (const k of readDeferred()) {
        const pair = splitDeferKey(k);
        if (!pair) continue;
        try {
          const m = await getMeeting(pair.meetingId);
          await evaluateAutomations(meetingFactsFrom(m), { only: pair.tagId });
        } catch {
          /* meeting gone / store hiccup — leave the marker for a later run */
        }
      }
    })();
  });
}

// ---- action executors ----

async function classify(m: MeetingFacts, cfg: AutomationAiClassify): Promise<boolean> {
  const { system, user } = classifyPrompt(m, cfg.hint ?? "");
  const out = await aiGenerate(user, system, cfg.model || undefined);
  return parseClassifyResult(out);
}

/** Run an ask/auto send against the hosted push routes (mirrors the web
 * ApprovalCard route mapping). Returns the ledger-detail result; throws on
 * failure. 409 (already sent) is treated as done. Exported so the approval
 * cards can finish an ask-mode send. */
export async function executeSend(
  meetingId: string,
  send: AutomationSend,
  /** `interactive`: the user just confirmed this send (approval card, a
   * workflow they ran) — an Atlas pack may then ask for cloud-AI consent. */
  opts: { interactive?: boolean } = {},
): Promise<Record<string, unknown>> {
  const token = await accessToken();
  if (!token) throw new Error("Sign in to send.");
  let path: string;
  let body: Record<string, unknown>;
  switch (send.destination) {
    case "artemis":
      if (!send.target?.id) throw new Error("This send needs a deal target.");
      path = "/api/crm/push";
      body = {
        meetingId,
        target: { type: "deal", id: send.target.id, name: send.target.name },
        // The note shows the meeting time in the user's zone (Fikelela bridge).
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
      break;
    case "artemis_lead_flow":
      path = "/api/crm/leadflow";
      body = { meetingId, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone };
      break;
    case "atlas":
      path = "/api/delivery/push";
      body = { meetingId };
      break;
    case "atlas_pack": {
      trackEvent("meeting_sent", { destination: "atlas_pack", trigger: "automation", success: true });
      // The "ready" trigger: generates the summary in the background if the
      // meeting has none (same generator as the meeting view), pushes the
      // meeting to the cloud, then sends. Failures throw with a user-facing
      // message → recorded on the run (History) / shown on the approval card.
      const r = await sendAtlasPack(meetingId, {
        includeTranscript: send.includeTranscript === true,
        interactive: opts.interactive === true,
      });
      return { ...r };
    }
    case "arete":
      if (!send.target?.id) throw new Error("This send needs a product target.");
      path = "/api/insights/push";
      body = { meetingId, target: { type: "product", id: send.target.id, name: send.target.name } };
      break;
    default:
      throw new Error(`Unknown destination ${send.destination}.`);
  }
  const res = await fetch(`${LALELA_API}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status === 409) return { alreadySent: true };
  trackEvent("meeting_sent", {
    destination: sendDestination(send.destination),
    trigger: "automation",
    success: res.ok,
  });
  if (!res.ok) throw new Error((j.error as string) ?? `Send failed (${res.status}).`);
  return j;
}

/** "Sent to Fikelela CRM. 3 to-dos sent." — the user-facing line for a send
 * result (mirrors apps/web/lib/sends.ts; the hosted routes add todosMessage). */
export function sendResultMessage(label: string, res: Record<string, unknown>): string {
  if (res.alreadySent) return `Already sent to ${label} earlier.`;
  const todos = typeof res.todosMessage === "string" && res.todosMessage ? ` ${res.todosMessage}` : "";
  if (res.kind === "lead" && typeof res.name === "string") return `${res.existed === true ? "Linked to existing lead" : "Created lead"} “${res.name}”.${todos}`;
  return `Sent to ${label}.${todos}`;
}

/** Destination id → the closed analytics list. */
function sendDestination(d: string): "atlas" | "atlas_pack" | "artemis" | "artemis_lead_flow" | "arete" | "other" {
  return d === "atlas" || d === "atlas_pack" || d === "artemis" || d === "artemis_lead_flow" || d === "arete"
    ? d
    : "other";
}

async function runWorkflowHeadless(
  workflow: Workflow,
  meetingId: string,
  transcriptText: string,
): Promise<void> {
  const outputs = new Map<string, string>();
  for (const block of workflow.blocks) {
    // Send blocks (T8): auto-mode pushes through the same executor as
    // automation sends; ask-mode is skipped here — headless can't confirm.
    if (block.type === "send" && block.send?.destination) {
      let result: string;
      if (block.send.mode === "auto") {
        const label = block.send.destination;
        const res = await executeSend(meetingId, block.send);
        result = res.alreadySent ? `Already sent to ${label} earlier.` : `Sent to ${label}.`;
      } else {
        result = "Skipped — this ask-mode send needs confirmation.";
      }
      outputs.set(block.id, result);
      await setWorkflowOutput(meetingId, workflow.id, block.id, result);
      continue;
    }
    const input =
      block.input === "transcript" ? transcriptText : outputs.get(block.input);
    if (input === undefined) {
      throw new Error(`Block "${block.name}" depends on a block that has not run.`);
    }
    const result = await aiGenerate(
      input.slice(0, WORKFLOW_INPUT_CHARS),
      block.prompt_text,
      block.model ? resolveLegacyModel(block.model) : undefined,
    );
    outputs.set(block.id, result);
    await setWorkflowOutput(meetingId, workflow.id, block.id, result);
  }
}

/** Per-action outcome tally for one automation on one meeting. `executed` =
 * actions that did work now (move / workflow / generated summary / auto-send);
 * `queued` = ask-mode sends parked in Pending approvals; `failed` = action-level
 * failures (recorded to the ledger as failed, not thrown). Idempotent no-ops
 * (already-ledgered actions, or a summary skipped because one exists) count as
 * none of these — they simply didn't happen this run. */
export interface ActionTally {
  executed: number;
  queued: number;
  failed: number;
  /** AI actions skipped because cloud-AI consent is unanswered — NOT ledgered,
   * so they stay retryable (see the consent-deferred pairs above). */
  deferred: number;
}

async function runActions(
  owner: string | null,
  facts: MeetingFacts,
  a: Automation,
): Promise<ActionTally> {
  const acts = a.actions;
  const uid = owner;
  const tally: ActionTally = { executed: 0, queued: 0, failed: 0, deferred: 0 };
  // Meeting body loaded lazily — only workflow/summary actions need it.
  let full: FullMeeting | null | undefined;
  const getBody = async () => {
    if (full === undefined) full = await getMeeting(facts.id).catch(() => null);
    return full;
  };

  // Move to folder — use the native move path so sync pushes the project change.
  if (acts.project_id) {
    if (!(await ledgerHas(owner, facts.id, a.tag_id, "move"))) {
      let status: RunStatus = "done";
      const detail: Record<string, unknown> = { project_id: acts.project_id };
      try {
        const updated = await moveMeetingToProject(facts.id, acts.project_id);
        if (uid) pushMeeting(uid, updated).catch(() => {});
      } catch (e) {
        status = "failed";
        detail.error = e instanceof Error ? e.message : String(e);
      }
      await ledgerRecord(owner, { meeting_id: facts.id, tag_id: a.tag_id, action: "move", status, detail });
      if (status === "done") tally.executed += 1;
      else tally.failed += 1;
    }
  }

  // Run the bound workflow headlessly (outputs persist like manual runs).
  if (acts.workflow_id) {
    if (!(await ledgerHas(owner, facts.id, a.tag_id, "workflow"))) {
      let status: RunStatus | "deferred" = "done";
      let detail: Record<string, unknown> = { workflow_id: acts.workflow_id };
      try {
        const wf = (await listWorkflows().catch(() => [])).find((w) => w.id === acts.workflow_id);
        const body = await getBody();
        if (!wf || wf.blocks.length === 0 || !body) {
          status = "failed";
          detail = { ...detail, error: !wf ? "workflow not found" : "empty workflow or meeting" };
        } else {
          await runWorkflowHeadless(wf, facts.id, transcriptToText(body.segments));
        }
      } catch (e) {
        if (isAiConsentError(e)) status = "deferred";
        else {
          status = "failed";
          detail = { ...detail, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (status === "deferred") tally.deferred += 1; // not ledgered → retryable
      else {
        await ledgerRecord(owner, { meeting_id: facts.id, tag_id: a.tag_id, action: "workflow", status, detail });
        if (status === "done") tally.executed += 1;
        else tally.failed += 1;
      }
    }
  }

  // Summary: generate with the bound prompt/model when the meeting has none.
  if (acts.summary_prompt_text || acts.summary_model || acts.prompt_id) {
    if (!(await ledgerHas(owner, facts.id, a.tag_id, "summary"))) {
      let status: RunStatus | "deferred" = "done";
      const detail: Record<string, unknown> = {
        prompt_id: acts.prompt_id,
        summary_model: acts.summary_model,
        generated: false,
      };
      try {
        const body = await getBody();
        const transcript = body ? transcriptToText(body.segments) : "";
        if (body && !body.summary.trim() && acts.summary_prompt_text && transcript.trim()) {
          const summary = await aiGenerate(
            transcript.slice(0, SUMMARY_INPUT_CHARS),
            acts.summary_prompt_text,
            acts.summary_model || undefined,
          );
          const updated = await updateMeeting(
            body.id,
            body.title,
            body.notes,
            summary,
            body.project_id,
          );
          full = updated;
          if (uid) pushMeeting(uid, updated).catch(() => {});
          detail.generated = true;
        }
      } catch (e) {
        if (isAiConsentError(e)) status = "deferred";
        else {
          status = "failed";
          detail.error = e instanceof Error ? e.message : String(e);
        }
      }
      if (status === "deferred") tally.deferred += 1; // not ledgered → retryable
      else {
        await ledgerRecord(owner, { meeting_id: facts.id, tag_id: a.tag_id, action: "summary", status, detail });
        // Only count a summary that actually generated — a meeting that already
        // had one is a clean skip, not an execution.
        if (status === "failed") tally.failed += 1;
        else if (detail.generated === true) tally.executed += 1;
      }
    }
  }

  // Sends: auto-mode executes immediately (signed in only); ask-mode — and any
  // signed-out send — queues as pending_approval for the approval cards.
  for (const send of acts.sends ?? []) {
    const action = `send:${send.destination}`;
    if (await ledgerHas(owner, facts.id, a.tag_id, action)) continue;
    if (send.mode === "auto" && uid) {
      let status: RunStatus | "deferred" = "done";
      let detail: Record<string, unknown> = { send };
      try {
        detail = { send, result: await executeSend(facts.id, send) };
      } catch (e) {
        // An Atlas pack whose missing summary needs cloud AI the user hasn't
        // answered for yet: skipped, not ledgered → retryable.
        if (isAiConsentError(e)) status = "deferred";
        else {
          status = "failed";
          detail = { send, error: e instanceof Error ? e.message : String(e) };
        }
      }
      if (status === "deferred") {
        tally.deferred += 1;
        continue;
      }
      await ledgerRecord(owner, { meeting_id: facts.id, tag_id: a.tag_id, action, status, detail });
      if (status === "done") tally.executed += 1;
      else tally.failed += 1;
    } else {
      await ledgerRecord(owner, {
        meeting_id: facts.id,
        tag_id: a.tag_id,
        action,
        status: "pending_approval",
        detail: { send },
      });
      tally.queued += 1;
    }
  }

  return tally;
}

// ---- per-automation core (shared by the live engine and the retro runner) ----

/** The outcome of evaluating ONE automation against ONE meeting. `matched` is
 * true whenever the rule applies to the meeting — including a meeting that was
 * already tagged on an earlier run (idempotent; `executed`/`queued` are then 0
 * because the shared ledger no-ops the actions). `alreadyDone` distinguishes
 * that idempotent case so callers can phrase "nothing new happened". */
export interface AutomationOutcome extends ActionTally {
  matched: boolean;
  matchedBy: "rule" | "ai" | null;
  alreadyDone: boolean;
}

const NO_MATCH: AutomationOutcome = {
  matched: false,
  matchedBy: null,
  alreadyDone: false,
  executed: 0,
  queued: 0,
  failed: 0,
  deferred: 0,
};

/** Evaluate a single automation against a single meeting, running its actions
 * if it matches and this engine claims the ledger's "tag" row. May throw
 * (ledger / store failures) — callers decide whether to swallow or surface. */
/** One evaluation per (meeting, automation) at a time, process-wide — shared
 * by the live engine, the consent-granted resume, manual "Run automations",
 * retro runs and folder rules, so a deferred retry can't execute twice. */
const pairLock = createKeyedLock();

function evaluateOneAutomation(
  owner: string | null,
  facts: MeetingFacts,
  a: Automation,
  strict = false,
): Promise<AutomationOutcome> {
  return pairLock.run(deferKey(facts.id, a.tag_id), () =>
    evaluateOneAutomationLocked(owner, facts, a, strict),
  );
}

async function evaluateOneAutomationLocked(
  owner: string | null,
  facts: MeetingFacts,
  a: Automation,
  strict = false,
): Promise<AutomationOutcome> {
  // Already handled on a prior run — matched, but nothing new to do. Unless
  // this engine skipped some of its AI actions for an unanswered cloud-AI
  // consent: then re-run the actions (each one no-ops if already ledgered).
  if (await ledgerHas(owner, facts.id, a.tag_id, "tag")) {
    if (readDeferred().has(deferKey(facts.id, a.tag_id))) {
      const tally = await runActions(owner, facts, a);
      setDeferred(facts.id, a.tag_id, tally.deferred > 0);
      return { matched: true, matchedBy: null, alreadyDone: false, ...tally };
    }
    return { matched: true, matchedBy: null, alreadyDone: true, executed: 0, queued: 0, failed: 0, deferred: 0 };
  }

  let matchedBy: "rule" | "ai" | null = deterministicMatch(a.match, facts) ? "rule" : null;
  // AI classification only runs when the cheap deterministic pass missed —
  // a non-answer is "no match", and so is a classifier FAILURE by default.
  // In strict mode (folder rules) a failure throws, so the caller counts the
  // meeting as an error to retry instead of "evaluated, no match".
  if (!matchedBy && a.ai_classify?.enabled && a.ai_classify.hint) {
    const cfg = a.ai_classify;
    const hit = await classifyMatch(() => classify(facts, cfg), strict);
    if (hit) matchedBy = "ai";
  }
  if (!matchedBy) return NO_MATCH;

  const won = await ledgerRecord(owner, {
    meeting_id: facts.id,
    tag_id: a.tag_id,
    action: "tag",
    status: "done",
    detail: { matched_by: matchedBy },
  });
  // Reflect the tag locally + in the cloud regardless of who won the race.
  await addMeetingTag(facts.id, a.tag_id, matchedBy).catch(() => {});
  void cloudAddMeetingTag(facts.id, a.tag_id, matchedBy);
  // The engine that claimed the "tag" row runs the actions; the other is a
  // clean no-op (the shared ledger guarantees a single executor).
  if (!won) {
    return { matched: true, matchedBy, alreadyDone: true, executed: 0, queued: 0, failed: 0, deferred: 0 };
  }
  const tally = await runActions(owner, facts, a);
  if (tally.deferred > 0) setDeferred(facts.id, a.tag_id, true);
  return { matched: true, matchedBy, alreadyDone: false, ...tally };
}

// ---- public entry points (fire-and-forget from the choke points) ----

/** Evaluate the user's automations against one meeting. By default every
 * enabled automation is considered; pass `only` (a tag id) to narrow to a
 * single automation (the retro-run path and the per-meeting one-off use this).
 * Returns an aggregate tally so callers can report what happened. */
export async function evaluateAutomations(
  facts: MeetingFacts,
  opts: { only?: string } = {},
): Promise<ActionTally & { matched: number }> {
  const agg = { matched: 0, executed: 0, queued: 0, failed: 0, deferred: 0 };
  const owner = await currentUid();
  let automations: Automation[];
  try {
    automations = (await listAutomations()).filter((a) => a.enabled);
  } catch {
    return agg; // migration missing — nothing to do
  }
  if (opts.only) automations = automations.filter((a) => a.tag_id === opts.only);
  if (automations.length === 0) return agg;

  for (const a of automations) {
    try {
      const r = await evaluateOneAutomation(owner, facts, a);
      if (r.matched) agg.matched += 1;
      agg.executed += r.executed;
      agg.queued += r.queued;
      agg.failed += r.failed;
      agg.deferred += r.deferred;
    } catch {
      /* next automation — never sink the batch */
    }
  }
  if (agg.matched > 0) {
    trackEvent("automation_run", {
      kind: "tag_rule",
      trigger: opts.only ? "manual" : "live",
      status: agg.failed > 0 ? "failed" : "ok",
      meetings: countBucket(1),
      executed: countBucket(agg.executed + agg.queued),
      failed: countBucket(agg.failed),
    });
  }
  return agg;
}

/** Live progress of a retro-run batch (one automation across many meetings). */
export interface RetroRunProgress {
  total: number;
  /** Meetings whose evaluation has finished (matched or not, error or not). */
  evaluated: number;
  /** Meetings the rule applies to (includes already-tagged, idempotent ones). */
  matched: number;
  /** Actions that ran now (move / workflow / generated summary / auto-send). */
  executed: number;
  /** Ask-mode sends parked in Pending approvals this run. */
  queued: number;
  /** Action-level failures recorded to the ledger. */
  failed: number;
  /** Meetings that threw while loading/evaluating (never aborts the batch). */
  errors: number;
  /** AI work skipped for an unanswered cloud-AI consent (an AI classify in
   * strict mode, or AI actions) — retryable, never an error. */
  deferred: number;
}

export interface RetroRunOptions {
  /** Abort between meetings. In-flight meetings finish; no new ones start. */
  signal?: AbortSignal;
  /** Meetings in flight at once (AI classify meters real tokens — keep small). */
  concurrency?: number;
  onProgress?: (p: RetroRunProgress) => void;
  /** Opt-in (folder automations only): count an AI-classify failure, a failed
   * automation lookup or a missing automation as per-meeting `errors` instead
   * of a silent "no match" / no-op. Default false = unchanged behaviour. */
  strict?: boolean;
}

/**
 * Retro-run ONE automation across a chosen set of past meetings. Loads each
 * meeting's transcript (the cost — one `get_meeting` per id), evaluates only the
 * given automation, and runs its actions through the same engine as live runs,
 * so the shared `automation_runs` ledger keeps re-runs idempotent and ask-mode
 * sends pile into Pending approvals (the preview Oz wants). The automation is
 * run as configured whether or not it is currently enabled — this is an
 * explicit, user-initiated action. A per-meeting failure is counted, not fatal.
 */
export async function runAutomationOnMeetings(
  tagId: string,
  meetingIds: string[],
  opts: RetroRunOptions = {},
): Promise<RetroRunProgress> {
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? 3, 5));
  const owner = await currentUid();
  const strict = opts.strict === true;
  const lookup: AutomationLookup<Automation> = await listAutomations().then(
    (list) => ({ ok: true as const, automation: list.find((a) => a.tag_id === tagId) }),
    () => ({ ok: false as const }),
  );
  const automation = lookup.ok ? lookup.automation : undefined;
  const progress: RetroRunProgress = {
    total: meetingIds.length,
    evaluated: 0,
    matched: 0,
    executed: 0,
    queued: 0,
    failed: 0,
    errors: 0,
    deferred: 0,
  };
  const notEvaluated = lookupErrors(lookup, meetingIds.length, strict);
  if (!automation || notEvaluated !== null) {
    progress.errors = notEvaluated ?? 0;
    progress.evaluated = progress.errors;
    opts.onProgress?.({ ...progress });
    return progress;
  }
  opts.onProgress?.({ ...progress });

  // Small-batch concurrency: process the ids in chunks, checking the abort
  // signal between chunks so cancel takes effect between meetings.
  for (let i = 0; i < meetingIds.length; i += concurrency) {
    if (opts.signal?.aborted) break;
    const chunk = meetingIds.slice(i, i + concurrency);
    await Promise.all(
      chunk.map(async (id) => {
        try {
          const m = await getMeeting(id);
          const r = await evaluateOneAutomation(owner, meetingFactsFrom(m), automation, strict);
          if (r.matched) progress.matched += 1;
          progress.executed += r.executed;
          progress.queued += r.queued;
          progress.failed += r.failed;
          progress.deferred += r.deferred;
        } catch (e) {
          if (isAiConsentError(e)) progress.deferred += 1;
          else progress.errors += 1;
        } finally {
          progress.evaluated += 1;
          opts.onProgress?.({ ...progress });
        }
      }),
    );
  }
  trackEvent("automation_run", {
    kind: "tag_rule",
    trigger: "retro",
    status: progress.errors + progress.failed > 0 ? "failed" : "ok",
    meetings: countBucket(progress.evaluated),
    executed: countBucket(progress.executed + progress.queued),
    failed: countBucket(progress.failed + progress.errors),
  });
  return progress;
}

/** Choke point: a freshly recorded native meeting. */
export async function evaluateAutomationsForMeeting(
  m: FullMeeting,
  source = "desktop",
): Promise<void> {
  await evaluateAutomations(meetingFactsFrom(m, source));
}

/** Choke point: meetings that just landed via import / cloud pull. Source is
 * derived from each id. The shared ledger makes cloud-pulled meetings (already
 * processed by the cloud engine) a no-op. */
export async function evaluateAutomationsForMeetingIds(ids: string[]): Promise<void> {
  for (const id of ids) {
    try {
      const m = await getMeeting(id);
      await evaluateAutomations(meetingFactsFrom(m));
    } catch {
      /* one bad meeting must not block the rest */
    }
  }
}
