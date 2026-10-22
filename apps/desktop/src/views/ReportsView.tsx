// Reports — a top-level view for "reflect over my meetings". Create/edit report
// definitions (a prompt + a scope + a cadence), run them now, and browse past
// outputs. Scheduled reports (daily/weekly) also run on app launch via
// runDueReports() (wired in App.tsx) and fire an OS notification on completion.
// Local SQLite is canonical (lib/reports.ts); the web app has the cloud twin.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  BarChart3,
  ChevronRight,
  Clock,
  Copy,
  Check,
  Loader2,
  Pencil,
  Play,
  Plus,
  Sparkles,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { CitedMarkdown } from "@/components/CitedMarkdown";
import { ReportAiButton } from "@/components/ReportAiContent";
// Amp: the teaching empty state (Spark mark + wayfinding copy) for the
// insights/reports surface.
import { EmptyState } from "@auxo/amp-primitives";
import { cn } from "@/lib/utils";
import { flattenProjectTree, listProjects, formatDate, type Project } from "@/lib/lalela";
import { listTags, type Tag } from "@/lib/tags";
import { useAvailableModels } from "@/lib/useModels";
import {
  deleteReport,
  deleteReportOutput,
  listReportOutputs,
  listReports,
  runReport,
  saveReport,
  REPORT_TEMPLATES,
  type Report,
  type ReportCadence,
  type ReportOutput,
  type ReportScopeType,
  type ReportTemplate,
  type DateRange,
} from "@/lib/reports";

const CADENCE_LABEL: Record<ReportCadence, string> = {
  manual: "Manual",
  daily: "Daily",
  weekly: "Weekly",
};

const SCOPE_LABEL: Record<ReportScopeType, string> = {
  all: "All meetings",
  folder: "Folder",
  tag: "Tag",
  date_range: "Date range",
};

/** Editor working state — a Report without server-managed timestamps. */
interface Draft {
  id: string; // "" = new
  name: string;
  prompt: string;
  scope_type: ReportScopeType;
  scope_value: string | null;
  cadence: ReportCadence;
  model: string;
}

function draftFromReport(r: Report): Draft {
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    scope_type: r.scope_type,
    scope_value: r.scope_value,
    cadence: r.cadence,
    model: r.model,
  };
}

function draftFromTemplate(t: ReportTemplate): Draft {
  return {
    id: "",
    name: t.name,
    prompt: t.prompt,
    scope_type: t.scope_type,
    scope_value: null,
    cadence: t.cadence,
    model: t.model,
  };
}

const BLANK_DRAFT: Draft = {
  id: "",
  name: "",
  prompt: "",
  scope_type: "all",
  scope_value: null,
  cadence: "manual",
  model: "",
};

export function ReportsView() {
  const [reports, setReports] = useState<Report[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Draft | null>(null);
  const [picking, setPicking] = useState(false); // template gallery open
  const [openReport, setOpenReport] = useState<Report | null>(null);
  const [runningId, setRunningId] = useState<string | null>(null);
  const [banner, setBanner] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [r, p, t] = await Promise.all([
      listReports().catch(() => []),
      listProjects().catch(() => []),
      listTags().catch(() => []),
    ]);
    setReports(r);
    setProjects(p);
    setTags(t);
    setLoading(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const nameForScope = useCallback(
    (r: Report | Draft): string => {
      if (r.scope_type === "folder") {
        return projects.find((p) => p.id === r.scope_value)?.name ?? "(pick a folder)";
      }
      if (r.scope_type === "tag") {
        return tags.find((t) => t.id === r.scope_value)?.name ?? "(pick a tag)";
      }
      if (r.scope_type === "date_range") {
        try {
          const d = r.scope_value ? (JSON.parse(r.scope_value) as DateRange) : null;
          return d ? `${d.from} – ${d.to}` : "(set dates)";
        } catch {
          return "(set dates)";
        }
      }
      return SCOPE_LABEL.all;
    },
    [projects, tags],
  );

  const handleRun = async (r: Report) => {
    setRunningId(r.id);
    setBanner(null);
    try {
      const res = await runReport(r, { interactive: true });
      await refresh();
      if (res.meetingCount === 0) {
        setBanner(`“${r.name}”: no meetings matched this report's scope yet.`);
      } else {
        setBanner(`“${r.name}” ran over ${res.meetingCount} meeting${res.meetingCount === 1 ? "" : "s"}.`);
        // Refresh the open detail panel if this report is showing.
        setOpenReport((cur) => (cur?.id === r.id ? { ...cur } : cur));
      }
    } catch (e) {
      setBanner(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningId(null);
    }
  };

  const handleDelete = async (r: Report) => {
    if (!window.confirm(`Delete the report “${r.name}” and all its saved outputs?`)) return;
    await deleteReport(r.id).catch(() => {});
    if (openReport?.id === r.id) setOpenReport(null);
    await refresh();
  };

  const handleSaved = async () => {
    setEditing(null);
    await refresh();
  };

  // Detail (outputs) overlay.
  if (openReport) {
    const live = reports.find((r) => r.id === openReport.id) ?? openReport;
    return (
      <ReportDetail
        report={live}
        scopeName={nameForScope(live)}
        running={runningId === live.id}
        onRun={() => handleRun(live)}
        onEdit={() => setEditing(draftFromReport(live))}
        onBack={() => setOpenReport(null)}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-2 border-b border-border px-6 py-4">
        <BarChart3 className="h-5 w-5 text-primary" />
        <h1 className="text-lg font-bold tracking-tight">Reports</h1>
        <div className="flex-1" />
        <Button size="sm" onClick={() => setPicking(true)}>
          <Plus className="h-4 w-4" />
          New report
        </Button>
      </header>

      <div className="flex-1 overflow-y-auto px-6 py-5">
        {banner && (
          <div className="mb-4 flex items-start gap-2 rounded-[var(--radius)] border border-border bg-muted/50 px-3 py-2 text-sm">
            <span className="flex-1">{banner}</span>
            <button onClick={() => setBanner(null)} className="text-muted-foreground hover:text-foreground">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}

        {loading ? (
          <div className="flex justify-center py-20 text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
          </div>
        ) : reports.length === 0 ? (
          <div className="mx-auto max-w-2xl">
            <div className="rounded-[var(--radius)] border border-dashed border-border">
              <EmptyState
                title="Reflect over your meetings"
                body="A report runs a prompt over a set of your meeting summaries — cross-meeting themes, a project rollup, a weekly reflection, sales insights. Start from a template below."
              />
            </div>
            <TemplateGallery
              onPick={(t) => setEditing(draftFromTemplate(t))}
              onBlank={() => setEditing({ ...BLANK_DRAFT })}
              className="mt-4"
            />
          </div>
        ) : (
          <div className="space-y-3">
            {reports.map((r) => (
              <div
                key={r.id}
                className="rounded-[var(--radius)] border border-border bg-card p-4 transition-colors hover:border-primary/40"
              >
                <div className="flex flex-wrap items-start gap-3">
                  <button
                    onClick={() => setOpenReport(r)}
                    className="group min-w-0 flex-1 text-left"
                    title="View saved outputs"
                  >
                    <p className="truncate font-semibold">{r.name}</p>
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
                      <span className="rounded-full bg-muted px-2 py-0.5">
                        {SCOPE_LABEL[r.scope_type]}
                        {r.scope_type !== "all" && `: ${nameForScope(r)}`}
                      </span>
                      <span className="rounded-full bg-muted px-2 py-0.5">{CADENCE_LABEL[r.cadence]}</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {r.last_run_at ? `last run ${formatDate(r.last_run_at)}` : "never run"}
                      </span>
                    </div>
                    <span className="mt-2 inline-flex items-center gap-0.5 text-xs font-medium text-accent group-hover:underline">
                      {r.last_run_at ? "View past results" : "No results yet — run it to create the first"}
                      {r.last_run_at && <ChevronRight className="h-3.5 w-3.5" />}
                    </span>
                  </button>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      size="sm"
                      onClick={() => handleRun(r)}
                      disabled={runningId === r.id}
                      title="Run now"
                    >
                      {runningId === r.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Play className="h-4 w-4" />
                      )}
                      Run now
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => setEditing(draftFromReport(r))} title="Edit">
                      <Pencil className="h-4 w-4" />
                    </Button>
                    <Button size="icon" variant="ghost" onClick={() => handleDelete(r)} title="Delete">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {picking && (
        <TemplatePicker
          onPick={(t) => {
            setPicking(false);
            setEditing(draftFromTemplate(t));
          }}
          onBlank={() => {
            setPicking(false);
            setEditing({ ...BLANK_DRAFT });
          }}
          onClose={() => setPicking(false)}
        />
      )}

      {editing && (
        <ReportEditor
          draft={editing}
          projects={projects}
          tags={tags}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      )}
    </div>
  );
}

// ---- template gallery / picker ----

function TemplateGallery({
  onPick,
  onBlank,
  className,
}: {
  onPick: (t: ReportTemplate) => void;
  onBlank: () => void;
  className?: string;
}) {
  return (
    <div className={cn("grid gap-3 sm:grid-cols-2", className)}>
      {REPORT_TEMPLATES.map((t) => (
        <button
          key={t.key}
          onClick={() => onPick(t)}
          className="rounded-[var(--radius)] border border-border bg-card p-4 text-left transition-colors hover:border-primary/50 hover:bg-muted/40"
        >
          <div className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-accent" />
            <span className="font-semibold">{t.name}</span>
          </div>
          <p className="mt-1.5 text-sm text-muted-foreground">{t.blurb}</p>
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            <span className="rounded-full bg-muted px-2 py-0.5">{SCOPE_LABEL[t.scope_type]}</span>
            <span className="rounded-full bg-muted px-2 py-0.5">{CADENCE_LABEL[t.cadence]}</span>
          </div>
        </button>
      ))}
      <button
        onClick={onBlank}
        className="flex items-center justify-center gap-2 rounded-[var(--radius)] border border-dashed border-border p-4 text-sm text-muted-foreground transition-colors hover:bg-muted/40 hover:text-foreground"
      >
        <Plus className="h-4 w-4" />
        Start from scratch
      </button>
    </div>
  );
}

function TemplatePicker({
  onPick,
  onBlank,
  onClose,
}: {
  onPick: (t: ReportTemplate) => void;
  onBlank: () => void;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6" onClick={onClose}>
      <div
        className="flex max-h-[85vh] w-full max-w-2xl flex-col rounded-[var(--radius)] border border-border bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-5">
          <h2 className="font-semibold">New report</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <p className="mb-3 text-sm text-muted-foreground">
            Pick a starting point — you can edit everything before saving.
          </p>
          <TemplateGallery onPick={onPick} onBlank={onBlank} />
        </div>
      </div>
    </div>
  );
}

// ---- editor ----

function todayISO(offsetDays = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function ReportEditor({
  draft,
  projects,
  tags,
  onClose,
  onSaved,
}: {
  draft: Draft;
  projects: Project[];
  tags: Tag[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const models = useAvailableModels();
  const [name, setName] = useState(draft.name);
  const [prompt, setPrompt] = useState(draft.prompt);
  const [scopeType, setScopeType] = useState<ReportScopeType>(draft.scope_type);
  const [scopeValue, setScopeValue] = useState<string | null>(draft.scope_value);
  const [cadence, setCadence] = useState<ReportCadence>(draft.cadence);
  const [model, setModel] = useState(draft.model);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const flatProjects = useMemo(() => flattenProjectTree(projects), [projects]);

  // Date-range state derived from scopeValue JSON.
  const range: DateRange = useMemo(() => {
    try {
      if (scopeValue) {
        const r = JSON.parse(scopeValue) as Partial<DateRange>;
        if (r.from && r.to) return { from: r.from, to: r.to };
      }
    } catch {
      /* fall through */
    }
    return { from: todayISO(-7), to: todayISO(0) };
  }, [scopeValue]);

  const setRange = (patch: Partial<DateRange>) =>
    setScopeValue(JSON.stringify({ ...range, ...patch }));

  const changeScopeType = (next: ReportScopeType) => {
    setScopeType(next);
    // Reset the target when switching scope kind so a stale id can't leak.
    if (next === "all") setScopeValue(null);
    else if (next === "date_range") setScopeValue(JSON.stringify({ from: todayISO(-7), to: todayISO(0) }));
    else setScopeValue(null);
  };

  const save = async () => {
    setErr(null);
    if (!name.trim()) return setErr("Give the report a name.");
    if (!prompt.trim()) return setErr("Add a prompt — what should this report produce?");
    if (scopeType === "folder" && !scopeValue) return setErr("Pick a folder for this report.");
    if (scopeType === "tag" && !scopeValue) return setErr("Pick a tag for this report.");
    if (scopeType === "date_range" && !scopeValue) return setErr("Set a date range.");
    setBusy(true);
    try {
      await saveReport({
        id: draft.id || undefined,
        name: name.trim(),
        prompt: prompt.trim(),
        scope_type: scopeType,
        scope_value: scopeType === "all" ? null : scopeValue,
        cadence,
        model,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-6">
      <div className="flex max-h-[88vh] w-full max-w-2xl flex-col rounded-[var(--radius)] border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border p-5">
          <h2 className="font-semibold">{draft.id ? "Edit report" : "New report"}</h2>
          <button onClick={onClose} className="rounded p-1 hover:bg-muted">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted-foreground">Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Weekly reflection"
              className="w-full rounded-[var(--radius)] border border-border bg-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
          </label>

          <div className="grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted-foreground">Scope</span>
              <select
                value={scopeType}
                onChange={(e) => changeScopeType(e.target.value as ReportScopeType)}
                className="w-full rounded-[var(--radius)] border border-border bg-background px-2 py-2 text-sm"
              >
                <option value="all">All meetings</option>
                <option value="folder">A folder</option>
                <option value="tag">A tag</option>
                <option value="date_range">A date range</option>
              </select>
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted-foreground">Cadence</span>
              <select
                value={cadence}
                onChange={(e) => setCadence(e.target.value as ReportCadence)}
                className="w-full rounded-[var(--radius)] border border-border bg-background px-2 py-2 text-sm"
              >
                <option value="manual">Manual (run when I click)</option>
                <option value="daily">Daily</option>
                <option value="weekly">Weekly</option>
              </select>
            </label>
          </div>

          {scopeType === "folder" && (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted-foreground">Folder</span>
              <select
                value={scopeValue ?? ""}
                onChange={(e) => setScopeValue(e.target.value || null)}
                className="w-full rounded-[var(--radius)] border border-border bg-background px-2 py-2 text-sm"
              >
                <option value="">Pick a folder…</option>
                {flatProjects.map(({ project, depth }) => (
                  <option key={project.id} value={project.id}>
                    {" ".repeat(depth * 2)}
                    {project.name}
                  </option>
                ))}
              </select>
            </label>
          )}

          {scopeType === "tag" && (
            <label className="block">
              <span className="mb-1 block text-xs font-semibold text-muted-foreground">Tag</span>
              <select
                value={scopeValue ?? ""}
                onChange={(e) => setScopeValue(e.target.value || null)}
                className="w-full rounded-[var(--radius)] border border-border bg-background px-2 py-2 text-sm"
              >
                <option value="">Pick a tag…</option>
                {tags.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
              </select>
              {tags.length === 0 && (
                <span className="mt-1 block text-xs text-muted-foreground">
                  No tags yet — create tags on meetings first (Automations), or use a folder/all.
                </span>
              )}
            </label>
          )}

          {scopeType === "date_range" && (
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-muted-foreground">From</span>
                <input
                  type="date"
                  value={range.from}
                  onChange={(e) => setRange({ from: e.target.value })}
                  className="w-full rounded-[var(--radius)] border border-border bg-background px-2 py-2 text-sm"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-semibold text-muted-foreground">To</span>
                <input
                  type="date"
                  value={range.to}
                  onChange={(e) => setRange({ to: e.target.value })}
                  className="w-full rounded-[var(--radius)] border border-border bg-background px-2 py-2 text-sm"
                />
              </label>
            </div>
          )}

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted-foreground">Model</span>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="w-full rounded-[var(--radius)] border border-border bg-background px-2 py-2 text-sm"
            >
              <option value="">Default model</option>
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </label>

          <label className="block">
            <span className="mb-1 block text-xs font-semibold text-muted-foreground">Prompt</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={9}
              placeholder="What should this report produce? e.g. Summarise the recurring themes across these meetings…"
              className="w-full rounded-[var(--radius)] border border-border bg-background p-2 text-sm outline-none focus:ring-2 focus:ring-primary/40"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              The report runs over each meeting&apos;s title, date and summary (not full transcripts).
            </span>
          </label>

          {err && <p className="text-sm text-danger">{err}</p>}
        </div>

        <div className="flex items-center gap-2 border-t border-border p-5">
          <div className="flex-1" />
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Save report"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---- detail (outputs) ----

function ReportDetail({
  report,
  scopeName,
  running,
  onRun,
  onEdit,
  onBack,
}: {
  report: Report;
  scopeName: string;
  running: boolean;
  onRun: () => void;
  onEdit: () => void;
  onBack: () => void;
}) {
  const [outputs, setOutputs] = useState<ReportOutput[] | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const refresh = useCallback(() => {
    listReportOutputs(report.id)
      .then((list) => {
        setOutputs(list);
        setSelectedId((prev) => (prev && list.some((o) => o.id === prev) ? prev : list[0]?.id ?? null));
      })
      .catch(() => setOutputs([]));
  }, [report.id]);

  // Refetch whenever the report reference changes (a run bumps it) or on mount.
  useEffect(refresh, [refresh, report.last_run_at, running]);

  const selected = outputs?.find((o) => o.id === selectedId) ?? null;

  const removeOutput = async (id: string) => {
    if (!window.confirm("Delete this saved output?")) return;
    await deleteReportOutput(id).catch(() => {});
    refresh();
  };

  const copy = async () => {
    if (!selected) return;
    await navigator.clipboard.writeText(selected.body_md);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center gap-3 border-b border-border px-6 py-4">
        <button onClick={onBack} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
          <ArrowLeft className="h-5 w-5" />
        </button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold tracking-tight">{report.name}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {SCOPE_LABEL[report.scope_type]}
            {report.scope_type !== "all" && `: ${scopeName}`} · {CADENCE_LABEL[report.cadence]}
          </p>
        </div>
        <Button size="sm" variant="ghost" onClick={onEdit} title="Edit">
          <Pencil className="h-4 w-4" />
          Edit
        </Button>
        <Button size="sm" onClick={onRun} disabled={running} title="Run now">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
          Run now
        </Button>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="w-72 shrink-0 overflow-y-auto border-r border-border p-3">
          {outputs === null ? (
            <div className="flex justify-center py-10 text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : outputs.length === 0 ? (
            <p className="px-2 py-6 text-center text-sm text-muted-foreground">
              No runs yet. Click “Run now” to generate the first one.
            </p>
          ) : (
            <div className="space-y-1.5">
              {outputs.map((o) => (
                <button
                  key={o.id}
                  onClick={() => setSelectedId(o.id)}
                  className={cn(
                    "w-full rounded-[var(--radius)] border px-3 py-2 text-left text-sm transition-colors",
                    o.id === selectedId
                      ? "border-primary/50 bg-primary/10"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <p className="truncate font-medium">{formatDate(o.generated_at)}</p>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{o.scope_label}</p>
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {selected ? (
            <div>
              <div className="mb-3 flex items-center gap-2">
                <h2 className="flex-1 text-base font-semibold">{selected.title}</h2>
                <button
                  onClick={copy}
                  className="inline-flex items-center gap-1 rounded-[var(--radius)] border border-border px-2 py-1 text-xs hover:bg-muted"
                >
                  {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
                  Copy
                </button>
                <ReportAiButton
                  size="xs"
                  surface="report"
                  output={selected.body_md}
                  className="rounded-[var(--radius)] border border-border px-2 py-1 text-xs"
                />
                <button
                  onClick={() => removeOutput(selected.id)}
                  className="inline-flex items-center gap-1 rounded-[var(--radius)] border border-border px-2 py-1 text-xs text-muted-foreground hover:text-danger"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <p className="mb-4 text-xs text-muted-foreground">{selected.scope_label}</p>
              <div className="md text-sm">
                <CitedMarkdown>{selected.body_md}</CitedMarkdown>
              </div>
            </div>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              Select a run on the left, or generate a new one.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
