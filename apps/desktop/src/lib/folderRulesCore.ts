// Folder automations — the PURE half (no Tauri, no React, no imports), so
// `node --test` can run it straight off the .ts file (folderRulesCore.test.ts).
//
//   parseFolderRuleConfig → the rule's JSON config with safe defaults
//   latestOccurrence / nextOccurrence / shiftPeriod → schedule maths in the
//                           rule's IANA time zone (DST-safe, wall-clock based)
//   periodKey / dueCheck  → "is this rule due, and for which period?" — the key
//                           the Rust ledger claims once per period
//   selectWindow          → "new since last run" by filed-at time
//
// The impure runner (ledger, AI, sends, scheduler) lives in folderRules.ts.

export type FolderCadence = "daily" | "weekly" | "monthly";
export type FolderWindow = "all" | "since_last_run";

export interface FolderSchedule {
  cadence: FolderCadence;
  /** Local wall-clock time "HH:MM" (24h) in `tz`. */
  time: string;
  /** weekly: 0 = Sunday … 6 = Saturday. */
  day_of_week: number;
  /** monthly: 1–31; months shorter than this run on their last day. */
  day_of_month: number;
  /** IANA zone the schedule is anchored to (captured when the rule is made). */
  tz: string;
}

/** Per-meeting sends a folder rule may run. Only destinations that need no
 * per-meeting target (deal / product) are offered; always "auto" mode because
 * a scheduled run has nobody to ask. */
export type FolderSendDestination = "atlas_pack" | "atlas" | "artemis_lead_flow";
export interface FolderSend {
  destination: FolderSendDestination;
  /** atlas_pack only: also send the full transcript (opt-in, default off). */
  includeTranscript?: boolean;
}

export interface FolderRuleConfig {
  schedule: FolderSchedule;
  window: FolderWindow;
  include_subfolders: boolean;
  /** One AI call over the in-scope meeting summaries → a Folder report. */
  digest: { enabled: boolean; prompt: string; model: string };
  /** Extract suggested tasks for in-scope meetings that have none yet. */
  extract_tasks: boolean;
  /** Existing tag automations to run over the in-scope meetings (the engine's
   * retro-run path; its own ledger keeps re-runs idempotent). */
  automation_tag_ids: string[];
  sends: FolderSend[];
}

export const DEFAULT_DIGEST_PROMPT =
  "You are writing a digest of one folder's recent meetings from their summaries. Produce a concise Markdown report with these sections:\n\n" +
  "## Overview\nA short paragraph on what happened in this period.\n\n" +
  "## Key points by meeting\nOne or two bullets per meeting (cite title and date).\n\n" +
  "## Decisions\n\n## Open items and owners\n\n## Patterns and themes\nAnything recurring across meetings.\n\n## Suggested focus for next period\n\n" +
  "Use only what is in the summaries; do not invent anything.";

export const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
] as const;

export function defaultFolderRuleConfig(tz: string): FolderRuleConfig {
  return {
    schedule: { cadence: "weekly", time: "08:00", day_of_week: 1, day_of_month: 1, tz },
    window: "since_last_run",
    include_subfolders: false,
    digest: { enabled: true, prompt: DEFAULT_DIGEST_PROMPT, model: "" },
    extract_tasks: false,
    automation_tag_ids: [],
    sends: [],
  };
}

const clampInt = (v: unknown, lo: number, hi: number, dflt: number): number => {
  const n = typeof v === "number" ? Math.trunc(v) : Number.NaN;
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : dflt;
};

/** "H:MM"/"HH:MM" → [h, m]; anything malformed → [8, 0]. */
export function parseHhmm(time: string): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!m) return [8, 0];
  const h = Number(m[1]);
  const mi = Number(m[2]);
  if (h > 23 || mi > 59) return [8, 0];
  return [h, mi];
}

const SEND_DESTS: FolderSendDestination[] = ["atlas_pack", "atlas", "artemis_lead_flow"];

/** Parse a stored config defensively: unknown/missing fields fall back to the
 * defaults so an older or hand-edited row can never crash the scheduler. */
export function parseFolderRuleConfig(json: string, fallbackTz: string): FolderRuleConfig {
  const d = defaultFolderRuleConfig(fallbackTz);
  let raw: Record<string, unknown> = {};
  try {
    const v = JSON.parse(json || "{}");
    if (v && typeof v === "object") raw = v as Record<string, unknown>;
  } catch {
    /* fall back to defaults */
  }
  const s = (raw.schedule ?? {}) as Record<string, unknown>;
  const cadence: FolderCadence =
    s.cadence === "daily" || s.cadence === "monthly" || s.cadence === "weekly"
      ? s.cadence
      : d.schedule.cadence;
  const [h, mi] = parseHhmm(typeof s.time === "string" ? s.time : d.schedule.time);
  const tz = typeof s.tz === "string" && isValidTimeZone(s.tz) ? s.tz : fallbackTz;
  const dg = (raw.digest ?? {}) as Record<string, unknown>;
  return {
    schedule: {
      cadence,
      time: `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`,
      day_of_week: clampInt(s.day_of_week, 0, 6, d.schedule.day_of_week),
      day_of_month: clampInt(s.day_of_month, 1, 31, d.schedule.day_of_month),
      tz,
    },
    window: raw.window === "all" ? "all" : "since_last_run",
    include_subfolders: raw.include_subfolders === true,
    digest: {
      enabled: typeof dg.enabled === "boolean" ? dg.enabled : d.digest.enabled,
      prompt: typeof dg.prompt === "string" ? dg.prompt : d.digest.prompt,
      model: typeof dg.model === "string" ? dg.model : "",
    },
    extract_tasks: raw.extract_tasks === true,
    automation_tag_ids: Array.isArray(raw.automation_tag_ids)
      ? raw.automation_tag_ids.filter((x): x is string => typeof x === "string" && !!x)
      : [],
    sends: Array.isArray(raw.sends)
      ? (raw.sends as Record<string, unknown>[])
          .filter((x) => x && SEND_DESTS.includes(x.destination as FolderSendDestination))
          .map((x) => ({
            destination: x.destination as FolderSendDestination,
            ...(x.destination === "atlas_pack" ? { includeTranscript: x.includeTranscript === true } : {}),
          }))
      : [],
  };
}

// ---- time-zone maths (wall clock in an IANA zone, via Intl) ----

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
  weekday: number; // 0 = Sunday
}

const fmtCache = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      weekday: "short",
    });
    fmtCache.set(tz, f);
  }
  return f;
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The wall-clock reading of instant `ms` in zone `tz`. */
export function wallClock(ms: number, tz: string): Wall {
  const parts: Record<string, string> = {};
  for (const p of formatter(tz).formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: WD[parts.weekday] ?? 0,
  };
}

/** UTC offset (ms) of zone `tz` at instant `ms` (positive east of UTC). */
function offsetAt(ms: number, tz: string): number {
  const w = wallClock(ms, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  return asUtc - Math.floor(ms / 60_000) * 60_000;
}

/** The instant whose wall clock in `tz` reads y-m-d h:mi. DST rules:
 * a time skipped by spring-forward resolves to the same clock time shifted
 * forward by the gap (02:30 → 03:30); a time that occurs twice at fall-back
 * resolves to one of the two (deterministically) — never zero, never twice. */
export function zonedTimeToUtc(
  y: number,
  m: number,
  d: number,
  h: number,
  mi: number,
  tz: string,
): number {
  const asUtc = Date.UTC(y, m - 1, d, h, mi);
  const o1 = offsetAt(asUtc, tz);
  const t1 = asUtc - o1;
  const o2 = offsetAt(t1, tz);
  if (o1 === o2) return t1;
  const t2 = asUtc - o2;
  const w2 = wallClock(t2, tz);
  if (w2.hour === h && w2.minute === mi && w2.day === d) return t2;
  // Neither reading lands on h:mi — the time is inside a spring-forward gap.
  return Math.max(t1, t2);
}

/** Calendar arithmetic on a plain date (no zone involved). */
function addDays(y: number, m: number, d: number, k: number): [number, number, number] {
  const t = new Date(Date.UTC(y, m - 1, d + k));
  return [t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()];
}
function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function addMonths(y: number, m: number, k: number): [number, number] {
  const idx = y * 12 + (m - 1) + k;
  return [Math.floor(idx / 12), (idx % 12) + 1];
}

/** The scheduled instant for the period containing the given local date. */
function occurrenceOn(s: FolderSchedule, y: number, m: number, d: number): number {
  const [h, mi] = parseHhmm(s.time);
  return zonedTimeToUtc(y, m, d, h, mi, s.tz);
}

/** The most recent scheduled instant at or before `now`. */
export function latestOccurrence(s: FolderSchedule, now: number): number {
  const w = wallClock(now, s.tz);
  if (s.cadence === "monthly") {
    for (let k = 0; k <= 2; k++) {
      const [y, m] = addMonths(w.year, w.month, -k);
      const t = occurrenceOn(s, y, m, Math.min(s.day_of_month, daysInMonth(y, m)));
      if (t <= now) return t;
    }
  } else {
    const step = s.cadence === "weekly" ? 7 : 1;
    const back = s.cadence === "weekly" ? (w.weekday - s.day_of_week + 7) % 7 : 0;
    for (let k = 0; k <= 2; k++) {
      const [y, m, d] = addDays(w.year, w.month, w.day, -back - k * step);
      const t = occurrenceOn(s, y, m, d);
      if (t <= now) return t;
    }
  }
  /* unreachable for valid schedules */
  return now;
}

/** The first scheduled instant strictly after `now`. */
export function nextOccurrence(s: FolderSchedule, now: number): number {
  const w = wallClock(now, s.tz);
  if (s.cadence === "monthly") {
    for (let k = 0; k <= 2; k++) {
      const [y, m] = addMonths(w.year, w.month, k);
      const t = occurrenceOn(s, y, m, Math.min(s.day_of_month, daysInMonth(y, m)));
      if (t > now) return t;
    }
  } else {
    const step = s.cadence === "weekly" ? 7 : 1;
    const fwd = s.cadence === "weekly" ? (s.day_of_week - w.weekday + 7) % 7 : 0;
    for (let k = 0; k <= 2; k++) {
      const [y, m, d] = addDays(w.year, w.month, w.day, fwd + k * step);
      const t = occurrenceOn(s, y, m, d);
      if (t > now) return t;
    }
  }
  return now;
}

/** `ms` moved by `k` whole periods in wall-clock terms (same local time;
 * monthly clamps to the target month's length). Used for the first-run window. */
export function shiftPeriod(s: FolderSchedule, ms: number, k: number): number {
  const w = wallClock(ms, s.tz);
  if (s.cadence === "monthly") {
    const [y, m] = addMonths(w.year, w.month, k);
    return zonedTimeToUtc(y, m, Math.min(w.day, daysInMonth(y, m)), w.hour, w.minute, s.tz);
  }
  const [y, m, d] = addDays(w.year, w.month, w.day, k * (s.cadence === "weekly" ? 7 : 1));
  return zonedTimeToUtc(y, m, d, w.hour, w.minute, s.tz);
}

/** Stable id of the period an occurrence belongs to — its local date. The Rust
 * ledger claims (rule, periodKey) once, so a period can never run twice. */
export function periodKey(s: FolderSchedule, occurrence: number): string {
  const w = wallClock(occurrence, s.tz);
  const date = `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")}`;
  return `${s.cadence}:${date}`;
}

export interface DueRuleFacts {
  enabled: boolean;
  last_period: string | null;
  /** Last edit (or creation). Occurrences before it never fire, so saving a
   * rule on Wednesday doesn't immediately run "last Monday's" digest. */
  updated_at: number;
}

export interface DueResult {
  due: boolean;
  occurrence: number;
  periodKey: string;
}

/** Is the rule due at `now`? Only the LATEST missed occurrence counts, so an
 * app that was closed for three weeks catches up with one run, not three. */
export function dueCheck(rule: DueRuleFacts, s: FolderSchedule, now: number): DueResult {
  const occurrence = latestOccurrence(s, now);
  const key = periodKey(s, occurrence);
  const due =
    rule.enabled && occurrence <= now && occurrence >= rule.updated_at && key !== rule.last_period;
  return { due, occurrence, periodKey: key };
}

/** Start of a run's "new since last run" window: the last successful run, or
 * (first run) one period before the run time. Null = whole folder. */
export function windowStart(
  cfg: Pick<FolderRuleConfig, "window" | "schedule">,
  lastRunAt: number | null,
  runAt: number,
): number | null {
  if (cfg.window === "all") return null;
  return lastRunAt ?? shiftPeriod(cfg.schedule, runAt, -1);
}

/** Meetings in the window: filed into the folder after `since` (filed-at is
 * the auto-sort / hand-move time, so an old meeting filed today counts as new).
 * Order is preserved. */
export function selectWindow<T extends { filed_at: number }>(meetings: T[], since: number | null): T[] {
  return since == null ? meetings : meetings.filter((m) => m.filed_at > since);
}

/** The meetings per-meeting actions (tasks, sends, automations) run over:
 * the window ∪ meetings with UNFINISHED items from earlier runs (failed with
 * attempts left, or pending, e.g. a send while signed out). Without the carry,
 * a meeting whose action failed would fall out of a "since last run" window
 * forever once the run advanced the baseline. Only meetings still in the
 * folder are carried; order follows `all` (newest first). */
export function actionScope<T extends { id: string }>(
  windowed: T[],
  all: T[],
  carryIds: Iterable<string>,
): T[] {
  const want = new Set(windowed.map((m) => m.id));
  for (const id of carryIds) want.add(id);
  return all.filter((m) => want.has(m.id));
}

/** In-memory, per-rule single-flight: a second run of the same rule (Run now
 * during a scheduled run, or a double-clicked Run now) is refused while the
 * first is in flight. The Rust ledger enforces the same across windows. */
export function createRuleGate() {
  const inFlight = new Set<string>();
  return {
    tryEnter(id: string): boolean {
      if (inFlight.has(id)) return false;
      inFlight.add(id);
      return true;
    },
    leave(id: string): void {
      inFlight.delete(id);
    },
    busy(id: string): boolean {
      return inFlight.has(id);
    },
  };
}

/** Sweep re-check against the rule as it is in the store RIGHT before
 * claiming: a rule paused, deleted, re-scheduled or already run (manually or
 * by another window) while an earlier rule's run was busy must not run from
 * the sweep's stale snapshot. Due only if the fresh rule still exists, is
 * enabled, and is due for the SAME period the sweep planned. */
export function stillDue(
  fresh: (DueRuleFacts & { config: string }) | undefined,
  plannedPeriodKey: string,
  now: number,
  fallbackTz: string,
): DueResult | null {
  if (!fresh) return null;
  const d = dueCheck(fresh, parseFolderRuleConfig(fresh.config, fallbackTz).schedule, now);
  return d.due && d.periodKey === plannedPeriodKey ? d : null;
}

/** Per-meeting outcome of running one automation over one meeting. Only an
 * evaluation that threw (`errors`) is retryable; action-level failures are
 * already recorded in the automation engine's own ledger (shown in
 * Automations → History) and re-running would no-op them. */
export function automationItemStatus(p: {
  errors: number;
  deferred?: number;
}): "done" | "failed" | "pending" {
  if (p.errors > 0) return "failed";
  // AI actions skipped for an unanswered cloud-AI consent: carried forward
  // without spending an attempt, so they run once the user allows cloud AI.
  if ((p.deferred ?? 0) > 0) return "pending";
  return "done";
}

/** Every model a run of this folder rule can call: digest + task extraction
 * (both on the digest model, else the default), the bound automations'
 * effective models (`automationModels`, see automationsCore
 * `automationAiModels`), and the auto-generation model for Atlas-pack sends
 * (they generate a missing summary). A manual run preflights cloud-AI consent
 * against this list. */
export function folderRuleAiModels(
  cfg: Pick<FolderRuleConfig, "digest" | "extract_tasks" | "automation_tag_ids" | "sends">,
  automationModels: string[],
  d: { defaultModel: string; autogenModel: string },
): string[] {
  const out = new Set<string>();
  const digestModel = cfg.digest.model || d.defaultModel;
  if (cfg.digest.enabled && cfg.digest.prompt.trim()) out.add(digestModel);
  if (cfg.extract_tasks) out.add(digestModel);
  if (cfg.automation_tag_ids.length) for (const m of automationModels) out.add(m);
  if (cfg.sends.some((s) => s.destination === "atlas_pack")) out.add(d.autogenModel);
  return [...out];
}

/** Final status of a non-empty run. A failed digest fails the run (the
 * period retries). Otherwise the run fails only when nothing it attempted
 * succeeded; partial per-meeting failures are carried forward by the item
 * ledger, so the baseline may advance. */
export function runVerdict(o: { digestFailed: boolean; ok: number; failed: number }): "done" | "failed" {
  if (o.digestFailed) return "failed";
  if (o.failed > 0 && o.ok === 0) return "failed";
  return "done";
}

/** "Every Monday at 08:00" etc. */
export function describeSchedule(s: FolderSchedule): string {
  switch (s.cadence) {
    case "daily":
      return `Every day at ${s.time}`;
    case "monthly":
      return s.day_of_month > 28
        ? `Monthly on day ${s.day_of_month} (or the last day) at ${s.time}`
        : `Monthly on day ${s.day_of_month} at ${s.time}`;
    default:
      return `Every ${WEEKDAYS[s.day_of_week] ?? "Monday"} at ${s.time}`;
  }
}
