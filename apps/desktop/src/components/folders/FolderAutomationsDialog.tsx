// "Automations for this folder" — per-folder scheduled rules (2026-10). Opened
// from the folder header in Meetings. Lists the folder's rules (schedule, next
// run, last run, Run now), edits them (schedule / scope / digest prompt / tasks
// / existing automations / sends), and shows each rule's run history. The
// engine + scheduler live in lib/folderRules.ts; the schedule maths in
// lib/folderRulesCore.ts.

import { trackEvent } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CalendarClock,
  History,
  Loader2,
  Pencil,
  Play,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { IS_MOBILE } from "@/lib/platform";
import { formatDate, formatTime } from "@/lib/lalela";
import { listAutomations, listTags, type Automation, type Tag } from "@/lib/tags";
import { useAvailableModels } from "@/lib/useModels";
import { preflightCloudAiConsent } from "@/lib/ai";
import {
  deleteFolderRule,
  listFolderRuleRuns,
  listFolderRules,
  localTimeZone,
  onFolderRulesChanged,
  parseRunDetail,
  ruleConfig,
  folderRuleModels,
  runFolderRule,
  isFolderRuleRunning,
  saveFolderRule,
  type FolderRule,
  type FolderRuleRun,
  type FolderRunResult,
} from "@/lib/folderRules";
import {
  DEFAULT_DIGEST_PROMPT,
  WEEKDAYS,
  defaultFolderRuleConfig,
  describeSchedule,
  nextOccurrence,
  type FolderCadence,
  type FolderRuleConfig,
  type FolderSendDestination,
} from "@/lib/folderRulesCore";

const SEND_OPTIONS: { id: FolderSendDestination; label: string; hint: string }[] = [
  {
    id: "atlas_pack",
    label: "Atlas (proposed actions)",
    hint: "Sends each new meeting's summary and action items to Atlas as proposed actions.",
  },
  { id: "atlas", label: "Atlas Delivery", hint: "Sends approved action items as delivery tickets." },
  { id: "artemis_lead_flow", label: "Fikelela CRM (create lead)", hint: "Creates a lead for the first person from outside your company, or logs the meeting on their deal." },
];

const STATUS_STYLE: Record<string, string> = {
  done: "bg-success/15 text-success",
  empty: "bg-muted text-muted-foreground",
  running: "bg-primary/15 text-foreground",
  failed: "bg-danger/15 text-danger",
};

interface Template {
  key: string;
  name: string;
  blurb: string;
  build: (tz: string) => FolderRuleConfig;
}

const STATUS_PROMPT =
  "You are writing a weekly status update for one project from its recent meeting summaries. Produce a Markdown report with these sections:\n\n" +
  "## Where things stand\nA tight paragraph on current status.\n\n## Progress this period\nWhat moved forward, citing meetings by title and date.\n\n" +
  "## Decisions made\n\n## Open items and blockers\nWith owners where known.\n\n## Risks\n\n## Next steps\n\nUse only the summaries provided.";

const COACHING_PROMPT =
  "You are summarising a week of coaching sessions from their summaries. Produce a Markdown digest covering:\n\n" +
  "## Themes we worked on\n\n## Breakthroughs and insights\n\n## Commitments made\nWho committed to what, by when.\n\n## Patterns to watch\n\n## Suggested focus for the next session\n\n" +
  "Be warm and specific, cite sessions by date, and use only what is in the summaries.";

const TEMPLATES: Template[] = [
  {
    key: "digest",
    name: "Weekly digest",
    blurb: "Every Monday 08:00: a digest of the meetings filed here since the last run.",
    build: (tz) => defaultFolderRuleConfig(tz),
  },
  {
    key: "status",
    name: "Weekly project status",
    blurb: "Every Friday 16:00: a status rollup across this folder and its subfolders.",
    build: (tz) => ({
      ...defaultFolderRuleConfig(tz),
      schedule: { cadence: "weekly", time: "16:00", day_of_week: 5, day_of_month: 1, tz },
      include_subfolders: true,
      digest: { enabled: true, prompt: STATUS_PROMPT, model: "" },
    }),
  },
  {
    key: "coaching",
    name: "Coaching digest",
    blurb: "Every Sunday 18:00: themes, commitments and focus from this week's sessions.",
    build: (tz) => ({
      ...defaultFolderRuleConfig(tz),
      schedule: { cadence: "weekly", time: "18:00", day_of_week: 0, day_of_month: 1, tz },
      digest: { enabled: true, prompt: COACHING_PROMPT, model: "" },
    }),
  },
  {
    key: "tasks",
    name: "Daily task sweep",
    blurb: "Every day 18:00: suggest tasks for new meetings here (no digest).",
    build: (tz) => ({
      ...defaultFolderRuleConfig(tz),
      schedule: { cadence: "daily", time: "18:00", day_of_week: 1, day_of_month: 1, tz },
      digest: { enabled: false, prompt: DEFAULT_DIGEST_PROMPT, model: "" },
      extract_tasks: true,
    }),
  },
];

function whenLabel(ms: number): string {
  return `${formatDate(ms)} ${formatTime(ms)}`;
}

function actionsSummary(cfg: FolderRuleConfig, tags: Map<string, Tag>): string {
  const parts: string[] = [];
  if (cfg.digest.enabled) parts.push("digest");
  if (cfg.extract_tasks) parts.push("extract tasks");
  for (const id of cfg.automation_tag_ids) parts.push(`automation “${tags.get(id)?.name ?? id}”`);
  for (const s of cfg.sends) parts.push(`send → ${SEND_OPTIONS.find((o) => o.id === s.destination)?.label ?? s.destination}`);
  return parts.length ? parts.join(" · ") : "no actions";
}

function runSummary(run: FolderRuleRun, tags: Map<string, Tag>): string {
  const d = parseRunDetail(run.detail);
  const parts: string[] = [];
  if (run.status === "empty") parts.push("No meetings in scope");
  if (d.error) parts.push(d.error);
  if (d.digest?.output_id) parts.push("Report saved");
  if (d.digest?.error) parts.push(`Digest failed: ${d.digest.error}`);
  if (d.carried) parts.push(`${d.carried} meeting${d.carried === 1 ? "" : "s"} retried from earlier runs`);
  if (d.tasks) {
    parts.push(`${d.tasks.extracted} task${d.tasks.extracted === 1 ? "" : "s"} suggested`);
    if (d.tasks.failed) parts.push(`${d.tasks.failed} task extraction${d.tasks.failed === 1 ? "" : "s"} failed`);
    if (d.tasks.gave_up) parts.push(`${d.tasks.gave_up} gave up after 3 attempts`);
  }
  for (const a of d.automations ?? []) {
    const name = tags.get(a.tag_id)?.name ?? a.tag_id;
    parts.push(
      `“${name}”: ${a.matched} matched, ${a.executed} ran, ${a.queued} awaiting approval` +
        `${a.failed ? `, ${a.failed} action${a.failed === 1 ? "" : "s"} failed` : ""}` +
        `${a.errors ? `, ${a.errors} meeting${a.errors === 1 ? "" : "s"} couldn't be checked (will retry)` : ""}` +
        `${a.gave_up ? `, ${a.gave_up} gave up after 3 attempts` : ""}` +
        `${a.error ? ` (${a.error})` : ""}`,
    );
  }
  for (const s of d.sends ?? []) {
    const label = SEND_OPTIONS.find((o) => o.id === s.destination)?.label ?? s.destination;
    parts.push(
      `${label}: ${s.sent} sent${s.failed ? `, ${s.failed} failed` : ""}` +
        `${s.pending ? `, ${s.pending} waiting to send` : ""}` +
        `${s.gave_up ? `, ${s.gave_up} gave up after 3 attempts` : ""}` +
        `${s.error ? ` (${s.error})` : ""}`,
    );
  }
  return parts.join(" · ");
}

function resultToast(r: FolderRunResult): string {
  if (r.busy) return "Already running. Wait for it to finish, then try again.";
  if (!r.ran) return "Nothing to run right now.";
  if (r.status === "empty") return "No meetings in scope — nothing to do.";
  if (r.status === "failed") return "The run failed — see History for details.";
  return `Done — ${r.meetingCount} meeting${r.meetingCount === 1 ? "" : "s"} processed.`;
}

interface Props {
  projectId: string;
  projectName: string;
  hasSubfolders: boolean;
  onClose: () => void;
}

type Mode = { kind: "list" } | { kind: "edit"; rule: FolderRule | null; template?: Template } | { kind: "history"; rule: FolderRule };

export function FolderAutomationsDialog({ projectId, projectName, hasSubfolders, onClose }: Props) {
  useEffect(() => trackEvent("feature_used", { feature: "folder_automations", action: "opened" }), []);
  const [rules, setRules] = useState<FolderRule[] | null>(null);
  const [tags, setTags] = useState<Map<string, Tag>>(new Map());
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [running, setRunning] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(() => {
    listFolderRules(projectId)
      .then(setRules)
      .catch(() => setRules([]));
  }, [projectId]);

  useEffect(() => {
    refresh();
    void Promise.all([listTags().catch(() => []), listAutomations().catch(() => [])]).then(([t, a]) => {
      setTags(new Map(t.map((x) => [x.id, x])));
      setAutomations(a);
    });
    return onFolderRulesChanged(refresh);
  }, [refresh]);

  const runNow = async (rule: FolderRule) => {
    setRunning((s) => new Set(s).add(rule.id));
    setToast(null);
    try {
      // User-started: ask for cloud-AI consent up front when the rule can use
      // AI (its own calls are background, like the scheduled runs).
      // Every effective model counts: digest/tasks, each bound automation's
      // own actions, and the autogen model Atlas-pack sends summarise with.
      const models = await folderRuleModels(rule).catch(() => [] as string[]);
      if (models.length) await preflightCloudAiConsent(models).catch(() => false);
      const r = await runFolderRule(rule, { trigger: "manual" });
      setToast(`${rule.name}: ${resultToast(r)}`);
    } catch (e) {
      setToast(`${rule.name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setRunning((s) => {
        const n = new Set(s);
        n.delete(rule.id);
        return n;
      });
      refresh();
    }
  };

  const toggleEnabled = async (rule: FolderRule) => {
    await saveFolderRule({
      id: rule.id,
      project_id: rule.project_id,
      name: rule.name,
      enabled: !rule.enabled,
      config: ruleConfig(rule),
    }).catch(() => {});
  };

  const remove = async (rule: FolderRule) => {
    if (!window.confirm(`Delete “${rule.name}”? Its saved folder reports and run history go too.`)) return;
    await deleteFolderRule(rule.id).catch(() => {});
  };

  const title =
    mode.kind === "edit"
      ? mode.rule
        ? "Edit folder rule"
        : "New folder rule"
      : mode.kind === "history"
        ? `History · ${mode.rule.name}`
        : "Automations for this folder";

  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] flex",
        IS_MOBILE ? "flex-col" : "items-center justify-center bg-black/40 p-4",
      )}
    >
      <div
        className={cn(
          "flex flex-col bg-background",
          IS_MOBILE
            ? "h-full w-full pt-[env(safe-area-inset-top)]"
            : "max-h-[90vh] w-full max-w-2xl rounded-[var(--radius)] border border-border shadow-xl",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="flex min-w-0 items-center gap-2 text-base font-bold">
            {mode.kind !== "list" && (
              <button
                onClick={() => setMode({ kind: "list" })}
                className="rounded p-0.5 text-muted-foreground hover:text-foreground"
                aria-label="Back"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <CalendarClock className="h-4 w-4 shrink-0 text-primary" />
            <span className="truncate">{title}</span>
          </h2>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {mode.kind === "list" && (
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <p className="mb-4 text-sm text-muted-foreground">
              Rules for <span className="font-medium text-foreground">{projectName}</span> run on a
              schedule over this folder's meetings. Digests appear under Folder reports at the top of
              the folder. Rules run on this Mac while Lalela is open; a run that was missed while it
              was closed runs once when it next opens.
            </p>
            {toast && (
              <div className="mb-3 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm">{toast}</div>
            )}
            {rules === null ? (
              <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
            ) : (
              <div className="space-y-2">
                {rules.map((rule) => {
                  const cfg = ruleConfig(rule);
                  const busy = running.has(rule.id) || isFolderRuleRunning(rule.id);
                  return (
                    <div
                      key={rule.id}
                      className="rounded-[var(--radius)] border border-border bg-card px-3 py-2.5"
                    >
                      <div className="flex items-start gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="truncate font-medium">{rule.name}</span>
                            {!rule.enabled && (
                              <span className="rounded-full bg-muted px-2 py-px text-[11px] text-muted-foreground">
                                Paused
                              </span>
                            )}
                          </div>
                          <p className="text-xs text-muted-foreground">
                            {describeSchedule(cfg.schedule)}
                            {cfg.schedule.tz !== localTimeZone() ? ` (${cfg.schedule.tz})` : ""} ·{" "}
                            {cfg.window === "since_last_run" ? "new since last run" : "all meetings"}
                            {cfg.include_subfolders ? " · with subfolders" : ""}
                          </p>
                          <p className="text-xs text-muted-foreground">{actionsSummary(cfg, tags)}</p>
                          <p className="mt-1 text-[11px] text-muted-foreground">
                            {rule.enabled
                              ? `Next run ${whenLabel(nextOccurrence(cfg.schedule, Date.now()))}`
                              : "Not scheduled"}
                            {rule.last_run_at ? ` · Last run ${whenLabel(rule.last_run_at)}` : " · Never run"}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <label className="mr-1 flex items-center gap-1 text-xs text-muted-foreground" title="Run on schedule">
                            <input type="checkbox" checked={rule.enabled} onChange={() => void toggleEnabled(rule)} />
                            On
                          </label>
                          <Button size="sm" variant="outline" disabled={busy} onClick={() => void runNow(rule)} title="Run now over the current scope">
                            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                            Run now
                          </Button>
                          <button
                            onClick={() => setMode({ kind: "history", rule })}
                            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                            title="Run history"
                          >
                            <History className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => setMode({ kind: "edit", rule })}
                            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
                            title="Edit"
                          >
                            <Pencil className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => void remove(rule)}
                            className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-danger"
                            title="Delete"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {rules.length === 0 && (
                  <p className="py-2 text-sm text-muted-foreground">No rules for this folder yet. Start from one of these:</p>
                )}
                <div className="grid gap-2 pt-2 sm:grid-cols-2">
                  {TEMPLATES.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => setMode({ kind: "edit", rule: null, template: t })}
                      className="rounded-[var(--radius)] border border-dashed border-border px-3 py-2 text-left hover:bg-muted"
                    >
                      <span className="flex items-center gap-1.5 text-sm font-medium">
                        <Plus className="h-3.5 w-3.5" /> {t.name}
                      </span>
                      <span className="block text-xs text-muted-foreground">{t.blurb}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {mode.kind === "edit" && (
          <RuleEditor
            projectId={projectId}
            projectName={projectName}
            hasSubfolders={hasSubfolders}
            rule={mode.rule}
            template={mode.template}
            automations={automations}
            tags={tags}
            onDone={() => setMode({ kind: "list" })}
          />
        )}

        {mode.kind === "history" && <RuleHistory rule={mode.rule} tags={tags} />}
      </div>
    </div>
  );
}

// ---- editor ----

function RuleEditor({
  projectId,
  projectName,
  hasSubfolders,
  rule,
  template,
  automations,
  tags,
  onDone,
}: {
  projectId: string;
  projectName: string;
  hasSubfolders: boolean;
  rule: FolderRule | null;
  template?: Template;
  automations: Automation[];
  tags: Map<string, Tag>;
  onDone: () => void;
}) {
  const models = useAvailableModels();
  const [name, setName] = useState(() => rule?.name ?? `${template?.name ?? "Weekly digest"} · ${projectName}`);
  const [enabled, setEnabled] = useState(rule?.enabled ?? true);
  const [cfg, setCfg] = useState<FolderRuleConfig>(() =>
    rule ? ruleConfig(rule) : (template ?? TEMPLATES[0]).build(localTimeZone()),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FolderRuleConfig>(k: K, v: FolderRuleConfig[K]) => setCfg((c) => ({ ...c, [k]: v }));
  const setSchedule = (patch: Partial<FolderRuleConfig["schedule"]>) =>
    setCfg((c) => ({ ...c, schedule: { ...c.schedule, ...patch } }));

  const hasAction =
    (cfg.digest.enabled && cfg.digest.prompt.trim().length > 0) ||
    cfg.extract_tasks ||
    cfg.automation_tag_ids.length > 0 ||
    cfg.sends.length > 0;

  const next = useMemo(() => nextOccurrence(cfg.schedule, Date.now()), [cfg.schedule]);

  const save = async () => {
    if (!name.trim()) return setError("Give the rule a name.");
    if (!hasAction) return setError("Pick at least one thing for the rule to do.");
    setSaving(true);
    setError(null);
    try {
      await saveFolderRule({ id: rule?.id, project_id: projectId, name: name.trim(), enabled, config: cfg });
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  };

  const label = "mb-1.5 block text-xs font-semibold text-muted-foreground";
  const field = "h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm";
  const toggleSend = (id: FolderSendDestination) =>
    set(
      "sends",
      cfg.sends.some((s) => s.destination === id)
        ? cfg.sends.filter((s) => s.destination !== id)
        : [...cfg.sends, { destination: id, ...(id === "atlas_pack" ? { includeTranscript: false } : {}) }],
    );

  return (
    <>
      <div className="flex-1 space-y-5 overflow-y-auto px-5 py-4">
        <div>
          <label className={label}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={cn(field, "w-full")} />
        </div>

        <section>
          <span className={label}>Schedule</span>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select
              value={cfg.schedule.cadence}
              onChange={(e) => setSchedule({ cadence: e.target.value as FolderCadence })}
              className={field}
              aria-label="How often"
            >
              <option value="daily">Every day</option>
              <option value="weekly">Every week</option>
              <option value="monthly">Every month</option>
            </select>
            {cfg.schedule.cadence === "weekly" && (
              <select
                value={cfg.schedule.day_of_week}
                onChange={(e) => setSchedule({ day_of_week: Number(e.target.value) })}
                className={field}
                aria-label="Day of the week"
              >
                {WEEKDAYS.map((d, i) => (
                  <option key={d} value={i}>
                    on {d}
                  </option>
                ))}
              </select>
            )}
            {cfg.schedule.cadence === "monthly" && (
              <select
                value={cfg.schedule.day_of_month}
                onChange={(e) => setSchedule({ day_of_month: Number(e.target.value) })}
                className={field}
                aria-label="Day of the month"
              >
                {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                  <option key={d} value={d}>
                    on day {d}
                  </option>
                ))}
              </select>
            )}
            <span className="text-muted-foreground">at</span>
            <input
              type="time"
              value={cfg.schedule.time}
              onChange={(e) => e.target.value && setSchedule({ time: e.target.value })}
              className={field}
              aria-label="Time"
            />
          </div>
          <p className="mt-1.5 text-xs text-muted-foreground">
            Next run {whenLabel(next)} · times are in {cfg.schedule.tz}
            {cfg.schedule.cadence === "monthly" && cfg.schedule.day_of_month > 28
              ? " · shorter months run on their last day"
              : ""}
          </p>
        </section>

        <section>
          <span className={label}>Which meetings</span>
          <div className="space-y-1.5 text-sm">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                checked={cfg.window === "since_last_run"}
                onChange={() => set("window", "since_last_run")}
              />
              Only meetings filed here since the last run
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" checked={cfg.window === "all"} onChange={() => set("window", "all")} />
              Every meeting in the folder (digests use the most recent 40)
            </label>
            {hasSubfolders && (
              <label className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={cfg.include_subfolders}
                  onChange={(e) => set("include_subfolders", e.target.checked)}
                />
                Include subfolders
              </label>
            )}
          </div>
        </section>

        <section className="space-y-3">
          <span className={label}>What it does</span>
          <div className="rounded-[var(--radius)] border border-border p-3">
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={cfg.digest.enabled}
                onChange={(e) => set("digest", { ...cfg.digest, enabled: e.target.checked })}
              />
              Write a folder report from the meeting summaries
            </label>
            {cfg.digest.enabled && (
              <div className="mt-2 space-y-2">
                <select
                  value={cfg.digest.model}
                  onChange={(e) => set("digest", { ...cfg.digest, model: e.target.value })}
                  className={cn(field, "w-full")}
                  aria-label="Model"
                >
                  <option value="">Default model</option>
                  {models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
                <textarea
                  value={cfg.digest.prompt}
                  onChange={(e) => set("digest", { ...cfg.digest, prompt: e.target.value })}
                  rows={7}
                  className="w-full rounded-[var(--radius)] border border-border bg-card px-2 py-1.5 font-mono text-xs"
                  aria-label="Report prompt"
                />
              </div>
            )}
          </div>

          <label className="flex items-start gap-2 rounded-[var(--radius)] border border-border p-3 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={cfg.extract_tasks}
              onChange={(e) => set("extract_tasks", e.target.checked)}
            />
            <span>
              <span className="font-medium">Suggest tasks</span>
              <span className="block text-xs text-muted-foreground">
                Extracts action items from each meeting that has none yet. They land on the Tasks board as
                suggestions for you to approve.
              </span>
            </span>
          </label>

          <div className="rounded-[var(--radius)] border border-border p-3 text-sm">
            <span className="font-medium">Run automations</span>
            <span className="block text-xs text-muted-foreground">
              Runs your existing automation rules over these meetings. Each rule's own conditions still apply,
              meetings it already handled are skipped, and Ask sends wait in Pending approvals.
            </span>
            {automations.length === 0 ? (
              <p className="mt-1.5 text-xs text-muted-foreground">You have no automations yet (Automations → Rules).</p>
            ) : (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {automations.map((a) => {
                  const tag = tags.get(a.tag_id);
                  const on = cfg.automation_tag_ids.includes(a.tag_id);
                  return (
                    <button
                      key={a.tag_id}
                      onClick={() =>
                        set(
                          "automation_tag_ids",
                          on
                            ? cfg.automation_tag_ids.filter((x) => x !== a.tag_id)
                            : [...cfg.automation_tag_ids, a.tag_id],
                        )
                      }
                      className={cn(
                        "rounded-full border px-2.5 py-1 text-xs",
                        on ? "border-primary bg-primary/15 text-foreground" : "border-border text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {tag?.name ?? a.tag_id}
                    </button>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-[var(--radius)] border border-border p-3 text-sm">
            <span className="font-medium">Send each meeting</span>
            <span className="block text-xs text-muted-foreground">
              Sends run automatically and once per meeting (you need to be signed in). For an approval step,
              use an automation with an Ask send instead.
            </span>
            <div className="mt-2 space-y-1.5">
              {SEND_OPTIONS.map((o) => {
                const s = cfg.sends.find((x) => x.destination === o.id);
                return (
                  <div key={o.id}>
                    <label className="flex items-center gap-2" title={o.hint}>
                      <input type="checkbox" checked={!!s} onChange={() => toggleSend(o.id)} />
                      {o.label}
                    </label>
                    {s && o.id === "atlas_pack" && (
                      <label className="ml-6 mt-1 flex items-center gap-2 text-xs text-muted-foreground">
                        <input
                          type="checkbox"
                          checked={s.includeTranscript === true}
                          onChange={(e) =>
                            set(
                              "sends",
                              cfg.sends.map((x) =>
                                x.destination === "atlas_pack" ? { ...x, includeTranscript: e.target.checked } : x,
                              ),
                            )
                          }
                        />
                        Also send the full transcript
                      </label>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </section>

        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Run on schedule
        </label>

        {(cfg.digest.enabled || cfg.extract_tasks) && (
          <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
            Each run uses your AI model: one call for the report, plus one per meeting for task suggestions.
            On a paid route that costs tokens.
          </p>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
      <div className="flex justify-end gap-2 border-t border-border px-5 py-3">
        <Button variant="outline" onClick={onDone}>
          Cancel
        </Button>
        <Button onClick={() => void save()} disabled={saving}>
          {saving && <Loader2 className="h-4 w-4 animate-spin" />}
          Save rule
        </Button>
      </div>
    </>
  );
}

// ---- history ----

function RuleHistory({ rule, tags }: { rule: FolderRule; tags: Map<string, Tag> }) {
  const [runs, setRuns] = useState<FolderRuleRun[] | null>(null);
  const refresh = useCallback(() => {
    listFolderRuleRuns(rule.id, 100)
      .then(setRuns)
      .catch(() => setRuns([]));
  }, [rule.id]);
  useEffect(() => {
    refresh();
    return onFolderRulesChanged(refresh);
  }, [refresh]);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
      {runs === null ? (
        <p className="py-6 text-center text-sm text-muted-foreground">Loading…</p>
      ) : runs.length === 0 ? (
        <p className="py-6 text-center text-sm text-muted-foreground">This rule hasn't run yet.</p>
      ) : (
        <FolderRunList runs={runs} tags={tags} />
      )}
    </div>
  );
}

/** Shared run list (the per-rule history and Automations → History). */
export function FolderRunList({
  runs,
  tags,
  ruleNames,
}: {
  runs: FolderRuleRun[];
  tags: Map<string, Tag>;
  ruleNames?: Map<string, string>;
}) {
  return (
    <ul className="space-y-1.5">
      {runs.map((r) => (
        <li
          key={r.id}
          className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm"
        >
          {ruleNames && <span className="font-medium">{ruleNames.get(r.rule_id) ?? "Deleted rule"}</span>}
          <span className="text-muted-foreground">{r.trigger === "manual" ? "Run now" : "Scheduled"}</span>
          <span className="text-muted-foreground">
            · {r.meeting_count} meeting{r.meeting_count === 1 ? "" : "s"}
          </span>
          <span className="flex-1" />
          <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium", STATUS_STYLE[r.status] ?? "")}>
            {r.status}
          </span>
          <span className="text-[11px] text-muted-foreground">{whenLabel(r.started_at)}</span>
          {runSummary(r, tags) && (
            <p className={cn("basis-full text-xs", r.status === "failed" ? "text-danger" : "text-muted-foreground")}>
              {runSummary(r, tags)}
            </p>
          )}
        </li>
      ))}
    </ul>
  );
}
