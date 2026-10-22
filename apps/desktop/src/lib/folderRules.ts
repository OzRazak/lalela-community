// Folder automations — the impure runner + scheduler. A folder rule runs over
// the meetings of one folder (optionally its subfolders, optionally only those
// filed since the last run) on a daily / weekly / monthly schedule, and does
// any of:
//   • digest        — one AI call over the meetings' summaries (same assembly
//                     and cap as Reports) → a "Folder report" (report_outputs)
//   • extract_tasks — suggested tasks for meetings that have none yet
//   • automations   — existing tag automations via runAutomationOnMeetings
//                     (the engine's own ledger keeps them idempotent)
//   • sends         — per-meeting auto sends through the existing lanes
//                     (executeSend: Atlas actions pack, Atlas, Artemis lead flow)
//
// Idempotency: the Rust ledger claims (rule, period) once — see
// src-tauri/src/folder_rules.rs — and per-meeting actions are ledgered per
// (rule, meeting, action). Pure schedule maths: folderRulesCore.ts.

import { countBucket, trackEvent } from "./analytics";
import { invoke } from "@tauri-apps/api/core";
import { aiGenerate } from "@/lib/ai";
import { getModel } from "@/lib/settings";
import {
  descendantProjectIds,
  getMeeting,
  listActionItems,
  listProjects,
  setMeetingActionItems,
} from "@/lib/lalela";
import {
  assembleContext,
  insertReportOutput,
  MEETING_CAP,
  notifyReportDone,
} from "@/lib/reports";
import { automationsAiModels, executeSend, runAutomationOnMeetings } from "@/lib/automations";
import { listAutomations } from "@/lib/tags";
import { autogenModel } from "@/lib/autogen";
import { isAiConsentError } from "@/lib/aiConsent";
import { currentUid } from "@/lib/automationsSync";
import { extractActionItems, membersForProject } from "@/lib/actionItems";
import { autoSortBusy } from "@/lib/autoSort";
import {
  actionScope,
  automationItemStatus,
  createRuleGate,
  folderRuleAiModels,
  runVerdict,
  stillDue,
  dueCheck,
  parseFolderRuleConfig,
  selectWindow,
  windowStart,
  type FolderRuleConfig,
} from "@/lib/folderRulesCore";

export interface FolderRule {
  id: string;
  project_id: string;
  name: string;
  enabled: boolean;
  /** JSON FolderRuleConfig (see folderRulesCore.ts). */
  config: string;
  last_run_at: number | null;
  last_period: string | null;
  created_at: number;
  updated_at: number;
}

export type FolderRunStatus = "running" | "done" | "empty" | "failed";

export interface FolderRuleRun {
  id: string;
  rule_id: string;
  period_key: string;
  trigger: "schedule" | "manual";
  status: FolderRunStatus;
  started_at: number;
  finished_at: number | null;
  meeting_count: number;
  output_id: string | null;
  /** JSON RunDetail. */
  detail: string;
  attempts: number;
}

export interface FolderReport {
  id: string;
  rule_id: string;
  rule_name: string;
  project_id: string;
  title: string;
  body_md: string;
  generated_at: number;
  meeting_count: number;
  scope_label: string;
}

interface FolderRuleMeeting {
  id: string;
  title: string;
  project_id: string | null;
  created_at: number;
  filed_at: number;
  summary: string;
}

/** What one run did — stored on the run row and shown in the history. */
export interface RunDetail {
  digest?: { output_id?: string; error?: string };
  /** `gave_up` = meetings that failed for the 3rd time this run and won't be
   * retried. `pending` = meetings waiting for cloud-AI consent (no attempt counted). */
  tasks?: {
    extracted: number;
    skipped: number;
    failed: number;
    pending?: number;
    gave_up?: number;
    error?: string;
  };
  /** `failed` = action-level failures (engine ledger); `errors` = meetings the
   * automation couldn't evaluate (carried forward; `gave_up` after 3). */
  automations?: {
    tag_id: string;
    matched: number;
    executed: number;
    queued: number;
    failed: number;
    errors?: number;
    /** Meetings whose AI work waits for cloud-AI consent (carried forward). */
    pending?: number;
    gave_up?: number;
    error?: string;
  }[];
  /** `pending` = waiting (e.g. signed out); retried on later runs without
   * counting an attempt. */
  sends?: { destination: string; sent: number; failed: number; pending?: number; gave_up?: number; error?: string }[];
  /** Meetings outside this run's window carried forward because an earlier
   * run left an action unfinished for them. */
  carried?: number;
  error?: string;
}

/** The local zone a new rule is anchored to. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function ruleConfig(rule: Pick<FolderRule, "config">): FolderRuleConfig {
  return parseFolderRuleConfig(rule.config, localTimeZone());
}

export function parseRunDetail(json: string): RunDetail {
  try {
    return (JSON.parse(json || "{}") as RunDetail) ?? {};
  } catch {
    return {};
  }
}

// ---- change notifications (the folder view refreshes its reports) ----

const listeners = new Set<() => void>();
export function onFolderRulesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
function emitChanged(): void {
  for (const l of listeners) l();
}

// ---- invoke wrappers ----

export const listFolderRules = (projectId: string | null) =>
  invoke<FolderRule[]>("folder_rules_list", { projectId });

/** One rule as it is in the store now (null when deleted). */
export const getFolderRule = (id: string) => invoke<FolderRule | null>("folder_rule_get", { id });

export async function saveFolderRule(rule: {
  id?: string;
  project_id: string;
  name: string;
  enabled: boolean;
  config: FolderRuleConfig;
}): Promise<FolderRule> {
  trackEvent("feature_used", { feature: "folder_automations", action: "rule_saved" });
  const saved = await invoke<FolderRule>("folder_rule_save", {
    rule: {
      id: rule.id ?? "",
      project_id: rule.project_id,
      name: rule.name,
      enabled: rule.enabled,
      config: JSON.stringify(rule.config),
      last_run_at: null,
      last_period: null,
      created_at: 0,
      updated_at: 0,
    },
  });
  emitChanged();
  return saved;
}

export async function deleteFolderRule(id: string): Promise<void> {
  await invoke("folder_rule_delete", { id });
  emitChanged();
}

export const listFolderRuleRuns = (ruleId: string | null, limit = 50) =>
  invoke<FolderRuleRun[]>("folder_rule_runs", { ruleId, limit });

export const listFolderReports = (projectIds: string[], limit = 50) =>
  invoke<FolderReport[]>("folder_reports_list", { projectIds, limit });

/** `busy` = another run of this rule is in flight (any trigger). */
const claimRun = (ruleId: string, periodKey: string, trigger: "schedule" | "manual") =>
  invoke<{ run: FolderRuleRun | null; busy: boolean }>("folder_rule_claim", {
    ruleId,
    periodKey,
    trigger,
  });

const finishRun = (
  runId: string,
  status: Exclude<FolderRunStatus, "running">,
  meetingCount: number,
  outputId: string | null,
  detail: RunDetail,
) =>
  invoke<void>("folder_rule_finish", {
    runId,
    status,
    meetingCount,
    outputId,
    detail: JSON.stringify(detail),
  });

const folderMeetings = (projectIds: string[]) =>
  invoke<FolderRuleMeeting[]>("folder_rule_meetings", { projectIds });

const itemsDone = (ruleId: string, action: string) =>
  invoke<string[]>("folder_rule_items_done", { ruleId, action });

const itemsUnfinished = (ruleId: string) =>
  invoke<string[]>("folder_rule_items_unfinished", { ruleId });

/** Returns the stored status ("gave_up" on the final failed attempt), or null
 * when the ledger write itself failed. */
const recordItem = (
  ruleId: string,
  meetingId: string,
  action: string,
  status: "done" | "failed" | "pending",
  detail: Record<string, unknown> = {},
) =>
  invoke<string>("folder_rule_record_item", {
    ruleId,
    meetingId,
    action,
    status,
    detail: JSON.stringify(detail),
  }).catch(() => null);

/** Rule-level single-flight within this window (the ledger covers the rest). */
const gate = createRuleGate();

/** True while this window is running the rule (the UI disables Run now). */
export function isFolderRuleRunning(ruleId: string): boolean {
  return gate.busy(ruleId);
}

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- the run ----

export interface FolderRunResult {
  /** False when the period was already claimed, or the rule is busy. */
  ran: boolean;
  /** True when refused because this rule is already running. */
  busy?: boolean;
  status?: Exclude<FolderRunStatus, "running">;
  meetingCount: number;
  outputId: string | null;
  detail: RunDetail;
}

/** Run one rule now. `schedule` runs carry the period they claim; manual runs
 * ("Run now") get a unique key so they never consume a period. A rule never
 * runs twice at once: refused with `busy` while another run of it (scheduled
 * or manual, this window or another) is in flight. */
/** Every model a run of `rule` can call (digest/tasks, its automations'
 * effective models, Atlas-pack summaries). The manual "Run now" preflights
 * cloud-AI consent against it. */
export async function folderRuleModels(rule: FolderRule): Promise<string[]> {
  const cfg = ruleConfig(rule);
  let autoModels: string[] = [];
  if (cfg.automation_tag_ids.length) {
    const ids = new Set(cfg.automation_tag_ids);
    const autos = (await listAutomations().catch(() => [])).filter((a) => ids.has(a.tag_id));
    autoModels = await automationsAiModels(autos);
  }
  return folderRuleAiModels(cfg, autoModels, {
    defaultModel: getModel(),
    autogenModel: autogenModel(),
  });
}

export async function runFolderRule(
  rule: FolderRule,
  opts: { trigger: "schedule" | "manual"; periodKey?: string; occurrence?: number; notify?: boolean },
): Promise<FolderRunResult> {
  const idle: FolderRunResult = { ran: false, meetingCount: 0, outputId: null, detail: {} };
  if (!gate.tryEnter(rule.id)) return { ...idle, busy: true };
  try {
    const now = Date.now();
    const key = opts.trigger === "manual" ? `manual:${now}` : (opts.periodKey ?? `manual:${now}`);
    // The caller's rule may be a stale snapshot (a sweep that spent minutes on
    // an earlier rule, or a dialog opened a while ago): re-read it from the
    // store right before claiming. Deleted → nothing to run. Scheduled runs
    // must still be enabled and due for the period the sweep planned.
    const before = await getFolderRule(rule.id);
    if (!before) return idle;
    if (opts.trigger === "schedule" && !stillDue(before, key, now, localTimeZone())) return idle;
    const claim = await claimRun(rule.id, key, opts.trigger);
    if (!claim.run) return { ...idle, busy: claim.busy };
    // Re-read once more under the claim: config and the "since last run"
    // baseline come from the store, never from the snapshot.
    const fresh = await getFolderRule(rule.id);
    if (!fresh) return idle; // deleted in between (its runs went with it)
    const result = await executeRun(fresh, claim.run, opts, now);
    trackEvent("automation_run", {
      kind: "folder_rule",
      trigger: opts.trigger,
      status: result.status ?? "skipped",
      meetings: countBucket(result.meetingCount),
    });
    return result;
  } finally {
    gate.leave(rule.id);
  }
}

async function executeRun(
  rule: FolderRule,
  run: FolderRuleRun,
  opts: { trigger: "schedule" | "manual"; occurrence?: number; notify?: boolean },
  now: number,
): Promise<FolderRunResult> {
  emitChanged(); // the history shows "running"

  const detail: RunDetail = {};
  let outputId: string | null = null;
  let meetingCount = 0;
  let status: Exclude<FolderRunStatus, "running"> = "done";
  try {
    const cfg = ruleConfig(rule);
    const projects = await listProjects();
    const folder = projects.find((p) => p.id === rule.project_id);
    if (!folder) throw new Error("This folder no longer exists.");
    const ids = cfg.include_subfolders ? descendantProjectIds(projects, rule.project_id) : [rule.project_id];
    const all = await folderMeetings(ids);
    const runAt = opts.trigger === "schedule" && opts.occurrence ? opts.occurrence : now;
    // The digest covers the window only. Per-meeting actions also re-try
    // meetings an earlier run left unfinished (failed with attempts left, or
    // pending), so moving the "since last run" baseline never strands them.
    const windowed = selectWindow(all, windowStart(cfg, rule.last_run_at, runAt));
    const carryIds = await itemsUnfinished(rule.id).catch(() => [] as string[]);
    const scoped = actionScope(windowed, all, carryIds);
    if (scoped.length > windowed.length) detail.carried = scoped.length - windowed.length;
    meetingCount = scoped.length;

    if (scoped.length === 0) {
      status = "empty";
    } else {
      // Units of work that succeeded / failed (a digest, a meeting × action).
      let ok = 0;
      let failed = 0;

      // 1. Digest → Folder report.
      if (cfg.digest.enabled && cfg.digest.prompt.trim() && windowed.length > 0) {
        try {
          const capped = windowed.slice(0, MEETING_CAP);
          const body = await aiGenerate(
            assembleContext(capped),
            cfg.digest.prompt,
            cfg.digest.model || getModel(),
          );
          const date = new Date().toLocaleDateString(undefined, {
            year: "numeric",
            month: "short",
            day: "numeric",
          });
          const sub = cfg.include_subfolders ? " (with subfolders)" : "";
          const windowDesc = cfg.window === "since_last_run" ? "new since last run" : "whole folder";
          const countDesc =
            windowed.length > capped.length
              ? `${capped.length} of ${windowed.length} meetings (most recent ${MEETING_CAP})`
              : `${capped.length} meeting${capped.length === 1 ? "" : "s"}`;
          const out = await insertReportOutput({
            report_id: rule.id,
            title: `${rule.name} — ${date}`,
            body_md: body,
            meeting_count: capped.length,
            scope_label: `folder “${folder.name}”${sub} · ${windowDesc} · ${countDesc}`,
          });
          outputId = out.id;
          detail.digest = { output_id: out.id };
          ok += 1;
          if (opts.notify) void notifyReportDone(rule.name, capped.length);
        } catch (e) {
          detail.digest = { error: errMsg(e) };
          failed += 1;
        }
      }

      // 2. Task extraction (suggested tasks; the user approves them on the board).
      if (cfg.extract_tasks) {
        const t = { extracted: 0, skipped: 0, failed: 0 } as NonNullable<RunDetail["tasks"]>;
        let tasksSettled = 0;
        try {
          const done = new Set(await itemsDone(rule.id, "tasks"));
          const model = cfg.digest.model || getModel();
          for (const m of scoped) {
            if (done.has(m.id)) continue;
            try {
              const existing = await listActionItems(m.id);
              if (existing.length > 0) {
                t.skipped += 1;
              } else {
                const full = await getMeeting(m.id);
                if (full.segments.length === 0) {
                  t.skipped += 1;
                } else {
                  const members = await membersForProject(full.project_id);
                  const items = await extractActionItems(full.segments, model, members);
                  await setMeetingActionItems(m.id, items);
                  t.extracted += items.length;
                }
              }
              await recordItem(rule.id, m.id, "tasks", "done");
              tasksSettled += 1;
            } catch (e) {
              if (isAiConsentError(e)) {
                // Cloud-AI consent unanswered: carry forward without spending
                // an attempt (runs once the user allows cloud AI).
                await recordItem(rule.id, m.id, "tasks", "pending", { error: errMsg(e) });
                t.pending = (t.pending ?? 0) + 1;
                continue;
              }
              t.failed += 1;
              t.error = errMsg(e);
              const stored = await recordItem(rule.id, m.id, "tasks", "failed", { error: errMsg(e) });
              if (stored === "gave_up") t.gave_up = (t.gave_up ?? 0) + 1;
            }
          }
        } catch (e) {
          t.error = errMsg(e);
        }
        detail.tasks = t;
        // Every meeting that settled (extracted or skipped) is a success.
        ok += tasksSettled;
        failed += t.failed + (t.error && t.failed === 0 ? 1 : 0);
      }

      // 3. Existing tag automations, one meeting at a time so each outcome is
      //    ledgered per meeting (`automation:<tag>`): a meeting whose
      //    evaluation threw is carried forward like a failed task/send (same
      //    3-attempt cap). Action-level failures stay in the engine's own
      //    ledger (Automations → History); the engine no-ops re-runs.
      if (cfg.automation_tag_ids.length) {
        detail.automations = [];
        for (const tagId of cfg.automation_tag_ids) {
          const action = `automation:${tagId}`;
          const a = { tag_id: tagId, matched: 0, executed: 0, queued: 0, failed: 0 } as NonNullable<
            RunDetail["automations"]
          >[number];
          const done = new Set(await itemsDone(rule.id, action).catch(() => [] as string[]));
          for (const m of scoped) {
            if (done.has(m.id)) continue;
            let p: {
              matched: number;
              executed: number;
              queued: number;
              failed: number;
              errors: number;
              deferred: number;
            };
            try {
              p = await runAutomationOnMeetings(tagId, [m.id], { concurrency: 1, strict: true });
            } catch (e) {
              p = { matched: 0, executed: 0, queued: 0, failed: 0, errors: 1, deferred: 0 };
              a.error = errMsg(e);
            }
            a.matched += p.matched;
            a.executed += p.executed;
            a.queued += p.queued;
            a.failed += p.failed;
            const itemStatus = automationItemStatus(p);
            if (itemStatus === "done") {
              await recordItem(rule.id, m.id, action, "done", { matched: p.matched });
              ok += 1;
            } else if (itemStatus === "pending") {
              // AI work skipped for an unanswered cloud-AI consent: carried
              // forward, no attempt spent.
              await recordItem(rule.id, m.id, action, "pending", {
                error: "Waiting for permission to use cloud AI.",
              });
              a.pending = (a.pending ?? 0) + 1;
            } else {
              a.errors = (a.errors ?? 0) + 1;
              failed += 1;
              const stored = await recordItem(rule.id, m.id, action, "failed", {
                error: a.error ?? "The automation could not evaluate this meeting.",
              });
              if (stored === "gave_up") a.gave_up = (a.gave_up ?? 0) + 1;
            }
          }
          detail.automations.push(a);
        }
      }

      // 4. Per-meeting sends through the existing lanes (auto mode).
      if (cfg.sends.length) {
        detail.sends = [];
        const uid = await currentUid();
        for (const send of cfg.sends) {
          const action = `send:${send.destination}`;
          const tally = { destination: send.destination, sent: 0, failed: 0 } as NonNullable<
            RunDetail["sends"]
          >[number];
          const done = new Set(await itemsDone(rule.id, action).catch(() => [] as string[]));
          if (!uid) {
            // Park every unsent meeting as pending (no attempt counted) so a
            // later signed-in run sends it, even once the window has moved on.
            for (const m of scoped) {
              if (done.has(m.id)) continue;
              await recordItem(rule.id, m.id, action, "pending", { error: "Sign in to send." });
              tally.pending = (tally.pending ?? 0) + 1;
            }
            tally.error = "Sign in to send.";
            detail.sends.push(tally);
            failed += tally.pending ?? 0;
            continue;
          }
          for (const m of scoped) {
            if (done.has(m.id)) continue;
            try {
              const res = await executeSend(m.id, {
                destination: send.destination,
                mode: "auto",
                ...(send.destination === "atlas_pack"
                  ? { includeTranscript: send.includeTranscript === true }
                  : {}),
              });
              tally.sent += 1;
              await recordItem(rule.id, m.id, action, "done", { result: res });
            } catch (e) {
              if (isAiConsentError(e)) {
                // Atlas pack needs a summary and cloud-AI consent is
                // unanswered: carry forward, no attempt spent.
                await recordItem(rule.id, m.id, action, "pending", { error: errMsg(e) });
                tally.pending = (tally.pending ?? 0) + 1;
                continue;
              }
              tally.failed += 1;
              tally.error = errMsg(e);
              const stored = await recordItem(rule.id, m.id, action, "failed", { error: errMsg(e) });
              if (stored === "gave_up") tally.gave_up = (tally.gave_up ?? 0) + 1;
            }
          }
          detail.sends.push(tally);
          ok += tally.sent;
          failed += tally.failed;
        }
      }

      // A failed digest fails the run (the period retries); otherwise the run
      // fails only when nothing succeeded. Partial per-meeting failures are
      // carried forward by the item ledger, so the baseline may advance.
      status = runVerdict({ digestFailed: !!detail.digest?.error, ok, failed });
    }
  } catch (e) {
    detail.error = errMsg(e);
    status = "failed";
  }

  await finishRun(run.id, status, meetingCount, outputId, detail).catch(() => {});
  emitChanged();
  return { ran: true, status, meetingCount, outputId, detail };
}

// ---- scheduler ----

let sweeping = false;

/** Run every enabled rule whose latest scheduled period hasn't run yet. One run
 * per rule per sweep, so missed periods catch up once. Best-effort: never
 * throws. Skips while an auto-sort batch is filing meetings. */
export async function runDueFolderRules(now = Date.now()): Promise<number> {
  if (sweeping || autoSortBusy()) return 0;
  sweeping = true;
  let ran = 0;
  try {
    const rules = await listFolderRules(null).catch(() => [] as FolderRule[]);
    if (rules.length === 0) return 0;
    // A rule whose folder was deleted stays dormant (not failed every period).
    const folders = new Set((await listProjects().catch(() => [])).map((p) => p.id));
    for (const rule of rules) {
      if (!folders.has(rule.project_id)) continue;
      const cfg = ruleConfig(rule);
      const d = dueCheck(rule, cfg.schedule, now);
      if (!d.due) continue;
      // runFolderRule re-reads the rule and re-checks due-ness for this
      // period right before claiming, so a rule paused / edited / deleted /
      // run while an earlier rule was busy is skipped, not run stale.
      try {
        const r = await runFolderRule(rule, {
          trigger: "schedule",
          periodKey: d.periodKey,
          occurrence: d.occurrence,
          notify: true,
        });
        if (r.ran) ran += 1;
      } catch {
        /* next rule */
      }
    }
  } finally {
    sweeping = false;
  }
  return ran;
}

const STARTUP_DELAY_MS = 20_000;
const SWEEP_INTERVAL_MS = 5 * 60_000;

/** Start the scheduler: a sweep shortly after launch (let sync / auto-sort
 * settle), then every 5 minutes and whenever the window regains focus.
 * Returns a disposer. */
export function installFolderRuleScheduler(): () => void {
  const sweep = () => {
    void runDueFolderRules().catch(() => {});
  };
  const t = setTimeout(sweep, STARTUP_DELAY_MS);
  const i = setInterval(sweep, SWEEP_INTERVAL_MS);
  window.addEventListener("focus", sweep);
  return () => {
    clearTimeout(t);
    clearInterval(i);
    window.removeEventListener("focus", sweep);
  };
}
