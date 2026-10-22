// Reports (phase 20) — "reflect over my meetings". A report is a saved prompt
// + a scope (all / folder / tag / date_range) + a cadence. Running it resolves
// the scope to a set of recent meeting SUMMARIES (never full transcripts — keeps
// it cheap and privacy-safe), assembles them into context, runs the report's
// prompt through the one AI front door (aiGenerate), and stores the result as a
// report_outputs row. Local SQLite is canonical here (thin invoke wrappers over
// the Rust store); the web app has its own Supabase-backed twin with the same
// shape (docs/sql/phase20_reports.sql) — the two do not sync, mirroring
// workflows.

import { invoke } from "@tauri-apps/api/core";
import { aiGenerate } from "@/lib/ai";
import { getModel, resolveLegacyModel } from "@/lib/settings";
import { listProjects } from "@/lib/lalela";
import { listMeetingTags, listTags } from "@/lib/tags";
import { IS_MOBILE } from "@/lib/platform";

export type ReportScopeType = "all" | "folder" | "tag" | "date_range";
export type ReportCadence = "manual" | "daily" | "weekly";

export interface Report {
  id: string;
  name: string;
  prompt: string;
  scope_type: ReportScopeType;
  /** folder/project id, tag id, or a JSON {"from","to"} (ISO YYYY-MM-DD) — by
   * scope_type. Null for scope "all". */
  scope_value: string | null;
  cadence: ReportCadence;
  /** Model id override; "" = follow the user's current model. */
  model: string;
  last_run_at: number | null;
  created_at: number;
  updated_at: number;
}

export interface ReportOutput {
  id: string;
  report_id: string;
  title: string;
  body_md: string;
  generated_at: number;
  meeting_count: number;
  scope_label: string;
}

/** Lightweight meeting row for scope resolution (no transcript; capped summary). */
export interface ReportMeetingRow {
  id: string;
  title: string;
  project_id: string | null;
  created_at: number;
  summary: string;
}

export interface DateRange {
  from: string; // ISO YYYY-MM-DD (inclusive)
  to: string; // ISO YYYY-MM-DD (inclusive)
}

// Bound the token cost: at most this many of the most-recent in-scope meetings,
// each summary trimmed. Noted in the output's scope_label when it bites.
export const MEETING_CAP = 40;
const PER_MEETING_SUMMARY_CHARS = 1500;

// Cadence "due" thresholds. Slightly under the nominal interval so a launch a
// little before the same time next day/week still fires (mirrors the web cron).
const DAILY_MS = 23 * 60 * 60 * 1000;
const WEEKLY_MS = 6.9 * 24 * 60 * 60 * 1000;

// ---- invoke wrappers ----

export function listReports(): Promise<Report[]> {
  return invoke<Report[]>("list_reports");
}

/** Upsert; pass an empty id to create. */
export function saveReport(report: {
  id?: string;
  name: string;
  prompt: string;
  scope_type: ReportScopeType;
  scope_value: string | null;
  cadence: ReportCadence;
  model: string;
  last_run_at?: number | null;
}): Promise<Report> {
  return invoke<Report>("save_report", {
    report: {
      id: report.id ?? "",
      name: report.name,
      prompt: report.prompt,
      scope_type: report.scope_type,
      scope_value: report.scope_value,
      cadence: report.cadence,
      model: report.model,
      last_run_at: report.last_run_at ?? null,
      created_at: 0,
      updated_at: 0,
    },
  });
}

export function deleteReport(id: string): Promise<void> {
  return invoke("delete_report", { id });
}

export function touchReportLastRun(id: string, ranAt: number): Promise<void> {
  return invoke("touch_report_last_run", { id, ranAt });
}

export function listReportOutputs(reportId: string): Promise<ReportOutput[]> {
  return invoke<ReportOutput[]>("list_report_outputs", { reportId });
}

export function deleteReportOutput(id: string): Promise<void> {
  return invoke("delete_report_output", { id });
}

export function insertReportOutput(out: {
  report_id: string;
  title: string;
  body_md: string;
  meeting_count: number;
  scope_label: string;
}): Promise<ReportOutput> {
  return invoke<ReportOutput>("insert_report_output", {
    output: {
      id: "",
      report_id: out.report_id,
      title: out.title,
      body_md: out.body_md,
      generated_at: 0, // 0 → store stamps now_millis()
      meeting_count: out.meeting_count,
      scope_label: out.scope_label,
    },
  });
}

function listReportMeetings(): Promise<ReportMeetingRow[]> {
  return invoke<ReportMeetingRow[]>("list_report_meetings");
}

// ---- scope resolution (identical semantics to the web engine) ----

function parseDateRange(scopeValue: string | null): DateRange | null {
  if (!scopeValue) return null;
  try {
    const r = JSON.parse(scopeValue) as Partial<DateRange>;
    if (r.from && r.to) return { from: r.from, to: r.to };
  } catch {
    /* not JSON */
  }
  return null;
}

/** The set of meetings a report applies to, most-recent-first and capped.
 * `tagPairs` is only consulted for tag scope. */
export function resolveScopeMeetings(
  report: Pick<Report, "scope_type" | "scope_value">,
  meetings: ReportMeetingRow[],
  tagPairs: { meeting_id: string; tag_id: string }[],
): ReportMeetingRow[] {
  let scoped = meetings; // already ordered created_at DESC from the store
  switch (report.scope_type) {
    case "folder":
      scoped = report.scope_value
        ? meetings.filter((m) => m.project_id === report.scope_value)
        : [];
      break;
    case "tag": {
      if (!report.scope_value) {
        scoped = [];
        break;
      }
      const ids = new Set(
        tagPairs.filter((p) => p.tag_id === report.scope_value).map((p) => p.meeting_id),
      );
      scoped = meetings.filter((m) => ids.has(m.id));
      break;
    }
    case "date_range": {
      const range = parseDateRange(report.scope_value);
      if (!range) {
        scoped = [];
        break;
      }
      const fromMs = new Date(`${range.from}T00:00:00`).getTime();
      const toMs = new Date(`${range.to}T23:59:59.999`).getTime();
      scoped = meetings.filter((m) => m.created_at >= fromMs && m.created_at <= toMs);
      break;
    }
    case "all":
    default:
      scoped = meetings;
  }
  return scoped.slice(0, MEETING_CAP);
}

export function assembleContext(
  meetings: Pick<ReportMeetingRow, "title" | "created_at" | "summary">[],
): string {
  return meetings
    .map((m) => {
      const date = new Date(m.created_at).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
      const summary = m.summary.trim().slice(0, PER_MEETING_SUMMARY_CHARS) || "(no summary yet)";
      return `### ${m.title}\n${date}\n\n${summary}`;
    })
    .join("\n\n---\n\n");
}

async function scopeLabel(
  report: Pick<Report, "scope_type" | "scope_value">,
  used: number,
  totalInScope: number,
): Promise<string> {
  let scopeDesc = "all meetings";
  try {
    if (report.scope_type === "folder" && report.scope_value) {
      const name = (await listProjects()).find((p) => p.id === report.scope_value)?.name;
      scopeDesc = `folder “${name ?? report.scope_value}”`;
    } else if (report.scope_type === "tag" && report.scope_value) {
      const name = (await listTags()).find((t) => t.id === report.scope_value)?.name;
      scopeDesc = `tag “${name ?? report.scope_value}”`;
    } else if (report.scope_type === "date_range") {
      const r = parseDateRange(report.scope_value);
      scopeDesc = r ? `${r.from} – ${r.to}` : "date range";
    }
  } catch {
    /* name lookup best-effort */
  }
  const countDesc =
    totalInScope > used
      ? `${used} of ${totalInScope} meetings (most recent ${MEETING_CAP})`
      : `${used} meeting${used === 1 ? "" : "s"}`;
  return `${scopeDesc} · ${countDesc}`;
}

// ---- generation ----

export interface RunReportResult {
  output: ReportOutput | null;
  meetingCount: number;
}

/** Run a report now: resolve scope → assemble summaries → generate → store.
 * Returns `{ output: null }` when the scope currently has no meetings (the
 * run is still stamped so due-checks don't loop). Fires a desktop OS
 * notification on completion when `opts.notify` (used by scheduled runs). */
export async function runReport(
  report: Report,
  /** `interactive`: the user pressed Run (may ask for cloud-AI consent).
   * Scheduled runs (runDueReports) are background — skipped quietly while the
   * consent is unanswered, and retried on a later launch. */
  opts: { notify?: boolean; interactive?: boolean } = {},
): Promise<RunReportResult> {
  const [meetings, tagPairs] = await Promise.all([
    listReportMeetings(),
    report.scope_type === "tag" ? listMeetingTags() : Promise.resolve([]),
  ]);
  const scoped = resolveScopeMeetings(report, meetings, tagPairs);
  // resolveScopeMeetings caps to MEETING_CAP; the pre-cap total feeds the label.
  const preCap = countInScope(report, meetings, tagPairs);

  if (scoped.length === 0) {
    await touchReportLastRun(report.id, Date.now()).catch(() => {});
    return { output: null, meetingCount: 0 };
  }

  const context = assembleContext(scoped);
  const model = resolveLegacyModel(report.model) || getModel();
  const body = await aiGenerate(context, report.prompt, model, { interactive: opts.interactive === true });

  const now = new Date();
  const title = `${report.name} — ${now.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })}`;
  const label = await scopeLabel(report, scoped.length, preCap);

  const output = await insertReportOutput({
    report_id: report.id,
    title,
    body_md: body,
    meeting_count: scoped.length,
    scope_label: label,
  });
  await touchReportLastRun(report.id, now.getTime()).catch(() => {});

  if (opts.notify) void notifyReportDone(report.name, scoped.length);
  return { output, meetingCount: scoped.length };
}

/** Pre-cap count of in-scope meetings (for the "N of M" label). */
function countInScope(
  report: Pick<Report, "scope_type" | "scope_value">,
  meetings: ReportMeetingRow[],
  tagPairs: { meeting_id: string; tag_id: string }[],
): number {
  switch (report.scope_type) {
    case "folder":
      return report.scope_value
        ? meetings.filter((m) => m.project_id === report.scope_value).length
        : 0;
    case "tag": {
      if (!report.scope_value) return 0;
      const ids = new Set(
        tagPairs.filter((p) => p.tag_id === report.scope_value).map((p) => p.meeting_id),
      );
      return meetings.filter((m) => ids.has(m.id)).length;
    }
    case "date_range": {
      const range = parseDateRange(report.scope_value);
      if (!range) return 0;
      const fromMs = new Date(`${range.from}T00:00:00`).getTime();
      const toMs = new Date(`${range.to}T23:59:59.999`).getTime();
      return meetings.filter((m) => m.created_at >= fromMs && m.created_at <= toMs).length;
    }
    default:
      return meetings.length;
  }
}

function isDue(report: Report, now = Date.now()): boolean {
  if (report.cadence === "manual") return false;
  if (report.last_run_at == null) return true;
  const elapsed = now - report.last_run_at;
  return report.cadence === "daily" ? elapsed >= DAILY_MS : elapsed >= WEEKLY_MS;
}

/** Launch-time (and focus) check: run any scheduled reports that are due.
 * Fully best-effort — never throws, never blocks the UI. A generation failure
 * (e.g. no AI configured) leaves last_run_at untouched so it retries later. */
export async function runDueReports(): Promise<number> {
  let reports: Report[];
  try {
    reports = await listReports();
  } catch {
    return 0; // migration missing / not ready
  }
  const due = reports.filter((r) => isDue(r));
  let ran = 0;
  for (const r of due) {
    try {
      await runReport(r, { notify: true });
      ran += 1;
    } catch {
      /* next report — an AI/network failure retries on the next launch */
    }
  }
  return ran;
}

// ---- desktop OS notification (best-effort; desktop-only) ----

export async function notifyReportDone(name: string, meetingCount: number): Promise<void> {
  if (IS_MOBILE) return;
  try {
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    sendNotification({
      title: "Report ready",
      body: `“${name}” finished — ${meetingCount} meeting${meetingCount === 1 ? "" : "s"} analysed.`,
    });
  } catch {
    /* notifications are best-effort — never block a report */
  }
}

// ---- starter templates (one-click; opens the editor prefilled, not saved) ----

export interface ReportTemplate {
  key: string;
  name: string;
  blurb: string;
  prompt: string;
  scope_type: ReportScopeType;
  cadence: ReportCadence;
  model: string; // "" = default model
  /** Scope target (folder/tag) the user must pick before this can run. */
  needsScopeTarget?: boolean;
}

export const REPORT_TEMPLATES: ReportTemplate[] = [
  {
    key: "themes",
    name: "Cross-meeting themes",
    blurb: "Recurring themes and open questions across all your recent meetings.",
    scope_type: "all",
    cadence: "manual",
    model: "",
    prompt:
      "You are analysing a set of meeting summaries to surface cross-cutting themes. Read the summaries below and produce a concise Markdown briefing that identifies:\n\n" +
      "1. The recurring themes and topics that appear across multiple meetings.\n" +
      "2. How each theme is evolving over time.\n" +
      "3. Tensions, disagreements, or open questions that keep resurfacing.\n" +
      "4. Anything that seems important but under-discussed.\n\n" +
      "Group by theme, cite the meetings (by title and date) that support each point, and end with 3-5 things worth paying attention to next. Use ONLY what is in the summaries; do not invent anything.",
  },
  {
    key: "project_rollup",
    name: "Per-project rollup",
    blurb: "A status rollup for one folder — progress, decisions, blockers, next steps.",
    scope_type: "folder",
    cadence: "weekly",
    model: "",
    needsScopeTarget: true,
    prompt:
      "You are writing a status rollup for a single project/workstream from its recent meeting summaries. Produce a Markdown report with these sections:\n\n" +
      "## Where things stand\nA tight paragraph on current status.\n\n" +
      "## Progress since last period\nWhat moved forward, with the meetings that show it.\n\n" +
      "## Decisions made\n\n## Open items & blockers\nInclude the owner where known.\n\n## Risks or concerns\n\n## Next steps\n\n" +
      "Be specific and attribute points to meetings by title and date. Use only the summaries provided.",
  },
  {
    key: "weekly_reflection",
    name: "Weekly reflection",
    blurb: "A warm, honest reflection over your recent meetings — wins, slips, follow-ups.",
    scope_type: "all",
    cadence: "weekly",
    model: "",
    prompt:
      "You are my thinking partner for a weekly reflection over my recent meetings. From the summaries below, write a warm but honest Markdown reflection covering:\n\n" +
      "## What I spent my time on\nThe shape of the period.\n\n## Wins & progress\n\n## What's stuck or slipping\n\n## Decisions & commitments I made\nAnd to whom.\n\n## Follow-ups I owe people\n\n## One thing to focus on next\n\n" +
      "Speak to me in the second person. Ground every point in the meetings, and flag where I seem overcommitted or where something is falling through the cracks. Use only what is in the summaries.",
  },
  {
    key: "sales_insights",
    name: "Sales performance insights",
    blurb: "Pipeline signals, objections, and concrete coaching across your sales meetings.",
    scope_type: "tag",
    cadence: "weekly",
    model: "anthropic/claude-sonnet-5.5",
    needsScopeTarget: true,
    prompt:
      "You are a sales coach and revenue analyst reviewing a set of sales-meeting summaries (discovery calls, demos, negotiations, check-ins). Produce a Markdown report with these sections:\n\n" +
      "## Pipeline signals\nFor the deals/accounts discussed, what is progressing, what is stalling, and what is at risk — cite the meetings.\n\n" +
      "## Buying signals & objections\nConcrete objections, blockers, and competitor mentions, plus positive buying signals.\n\n" +
      "## What's working\nSpecific things the seller did well (discovery questions, framing, setting next steps).\n\n" +
      "## Improvement areas\nHonest, specific coaching: where discovery was shallow, next steps were vague, talk-time was lopsided, value wasn't tied to the buyer's problem, or follow-through slipped. Tie each to a moment in a meeting.\n\n" +
      "## Recommended next actions\nThe 3-5 highest-leverage moves across these opportunities.\n\n" +
      "Be direct and practical. Use only what is in the summaries; where they lack detail, say what to capture next time rather than inventing.",
  },
];
