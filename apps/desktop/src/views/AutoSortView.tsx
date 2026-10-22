import { noAiHint } from "@/lib/edition";
// "To sort" — the Meetings smart folder for auto-sorting (a Meetings scope,
// like "Shared with me"; the 6-destination nav is unchanged). Three parts:
//   1. Folder setup (first run): propose → Oz approves / renames / merges.
//   2. Batch sort: progress, cancel, resume, estimate, undo last run.
//   3. Review queue: suggestion + reason + transcript snippet, one-click
//      Accept / Pick another / Skip, with keyboard shortcuts.

import { trackEvent } from "@/lib/analytics";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Check,
  FolderPlus,
  FolderTree,
  Loader2,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Sparkles,
  Undo2,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { ReportAiButton } from "@/components/ReportAiContent";
import { useAuth } from "@/lib/auth";
import { aiRoute, type AiRoute } from "@/lib/ai";
import { autogenModel } from "@/lib/autogen";
import { formatDate, getMeeting, listProjects, type Project } from "@/lib/lalela";
import {
  approveFolders,
  approvedFolders,
  cancelAutoSort,
  createFolderAndFile,
  fileByHand,
  getSortConfig,
  getSortNewMeetings,
  getSortThreshold,
  onSortChanged,
  PAID_GAP_MS,
  proposeFolders,
  recentAutoSorts,
  setSortNewMeetings,
  setSortThreshold,
  skipInQueue,
  sortReviewQueue,
  sortStats,
  startAutoSort,
  undoLastAutoSort,
  useAutoSortRun,
  type SortRecord,
  type SortStats,
} from "@/lib/autoSort";
import {
  estimateRun,
  formatDuration,
  mergeProposals,
  sampleTranscript,
  type ProposedFolder,
} from "@/lib/autoSortCore";
import { cn } from "@/lib/utils";

const inputClass =
  "w-full rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-ring";

/** Free-tier allowance (tokens/month) — mirrors PLAN_TOKENS.free in ai.ts. */
const FREE_TIER_TOKENS = 200_000;

function pct(n: number | null | undefined): string {
  return n == null ? "—" : `${Math.round(n * 100)}%`;
}

// ── Settings block (also rendered in Settings → AI) ──────────────────────

export function AutoSortSettings({ onSaved }: { onSaved?: () => void }) {
  const [threshold, setThreshold] = useState(getSortThreshold());
  const [autoNew, setAutoNew] = useState(getSortNewMeetings());
  return (
    <div className="space-y-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-muted-foreground">
          File automatically when the classifier is at least {pct(threshold)} sure
        </label>
        <input
          type="range"
          min={0.5}
          max={0.95}
          step={0.05}
          value={threshold}
          onChange={(e) => {
            const v = Number(e.target.value);
            setThreshold(v);
            setSortThreshold(v);
            onSaved?.();
          }}
          className="w-full accent-[var(--color-accent)]"
        />
        <p className="text-xs text-muted-foreground">
          Lower files more meetings on its own; higher sends more to "To sort" for you to check.
          Meetings whose title doesn't match their content always go to "To sort".
        </p>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={autoNew}
          onChange={(e) => {
            setAutoNew(e.target.checked);
            setSortNewMeetings(e.target.checked);
            onSaved?.();
          }}
          className="accent-[var(--color-accent)]"
        />
        Sort new meetings into folders once their summary is ready
      </label>
      <p className="-mt-1 ml-6 text-xs text-muted-foreground">
        Uses your auto-generation model. A folder you chose yourself is never changed.
      </p>
    </div>
  );
}

// ── Folder setup ─────────────────────────────────────────────────────────

interface Row extends ProposedFolder {
  include: boolean;
}

function FolderSetup({ onDone, onCancel }: { onDone: () => void; onCancel?: () => void }) {
  const { user } = useAuth();
  const [rows, setRows] = useState<Row[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const propose = async () => {
    setBusy(true);
    setNote(null);
    try {
      const config = getSortConfig();
      const approvedIds = new Set(config?.folders.map((f) => f.id) ?? []);
      const hints = new Map(config?.folders.map((f) => [f.id, f.hint]) ?? []);
      const { proposals, usedAi, error } = await proposeFolders();
      setRows(
        proposals.map((p) => ({
          ...p,
          hint: p.hint || (p.existingId ? hints.get(p.existingId) ?? "" : ""),
          // Proposals are ticked; existing folders the AI skipped stay
          // unticked unless they were already approved.
          include: !p.existingId || usedAi || approvedIds.has(p.existingId),
        })),
      );
      if (!usedAi) {
        setNote(
          error === "no-ai"
            ? "No AI model is set up, so these come from your existing folders and frequent title words."
            : "The AI proposal didn't work out, so these come from your existing folders and frequent title words.",
        );
      }
    } finally {
      setBusy(false);
    }
  };

  const update = (i: number, patch: Partial<Row>) =>
    setRows((rs) => rs && rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const approve = async () => {
    if (!rows) return;
    setBusy(true);
    try {
      await approveFolders(
        rows.filter((r) => r.include && r.name.trim()),
        user?.id,
      );
      onDone();
    } catch (e) {
      setNote(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="rounded-[var(--radius)] border border-border bg-card p-4">
      <div className="mb-2 flex items-center gap-2">
        <FolderTree className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">Set up your folders</h2>
      </div>
      <p className="mb-3 text-sm text-muted-foreground">
        Lalela looks at your existing folders, the titles you use most and a sample of what your
        meetings are about, then proposes folders. Nothing is created until you approve.
      </p>
      {!rows ? (
        <div className="flex gap-2">
          <Button onClick={propose} disabled={busy}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
            Propose folders
          </Button>
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
        </div>
      ) : (
        <>
          {note && <p className="mb-2 text-xs text-muted-foreground">{note}</p>}
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  checked={r.include}
                  onChange={(e) => update(i, { include: e.target.checked })}
                  className="accent-[var(--color-accent)]"
                  title="Use this folder"
                />
                <input
                  value={r.name}
                  onChange={(e) => update(i, { name: e.target.value })}
                  className={cn(inputClass, "w-56 flex-none")}
                  aria-label="Folder name"
                />
                <input
                  value={r.hint}
                  placeholder="What goes here (optional)"
                  onChange={(e) => update(i, { hint: e.target.value })}
                  className={cn(inputClass, "min-w-40 flex-1")}
                  aria-label="Folder description"
                />
                <span className="w-16 text-[11px] text-muted-foreground">
                  {r.existingId ? "existing" : "new"}
                </span>
                <select
                  value=""
                  onChange={(e) => {
                    const into = Number(e.target.value);
                    setRows((rs) => rs && (mergeProposals(rs, i, into) as Row[]));
                  }}
                  className={cn(inputClass, "w-36 flex-none")}
                  aria-label="Merge into"
                >
                  <option value="">Merge into…</option>
                  {rows.map((o, j) =>
                    j === i ? null : (
                      <option key={j} value={j}>
                        {o.name}
                      </option>
                    ),
                  )}
                </select>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center gap-2">
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder='Add a folder, e.g. "PPS / Claims portal"'
              className={cn(inputClass, "w-72 flex-none")}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={!newName.trim()}
              onClick={() => {
                setRows((rs) => [...(rs ?? []), { name: newName.trim(), hint: "", include: true }]);
                setNewName("");
              }}
            >
              <FolderPlus className="h-4 w-4" />
              Add
            </Button>
          </div>
          <div className="mt-4 flex gap-2">
            <Button onClick={approve} disabled={busy || !rows.some((r) => r.include)}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Approve {rows.filter((r) => r.include).length} folders
            </Button>
            <Button variant="ghost" onClick={onCancel ?? (() => setRows(null))} disabled={busy}>
              Cancel
            </Button>
          </div>
        </>
      )}
    </section>
  );
}

// ── Batch panel ──────────────────────────────────────────────────────────

function BatchPanel({
  stats,
  folderCount,
  onEditFolders,
}: {
  stats: SortStats | null;
  folderCount: number;
  onEditFolders: () => void;
}) {
  const run = useAutoSortRun();
  const [route, setRoute] = useState<AiRoute | null>(null);
  const [undoMsg, setUndoMsg] = useState<string | null>(null);
  const model = autogenModel();

  useEffect(() => {
    aiRoute(model).then(setRoute, () => setRoute("none"));
  }, [model]);

  const busy = run.status === "running" || run.status === "cancelling";
  const remaining = busy ? Math.max(0, run.total - run.processed) : stats?.unsorted ?? 0;
  const secondsPerCall =
    run.msPerItem > 0
      ? run.msPerItem / 1000
      : route === "local"
        ? 12
        : route === "apple"
          ? 8
          : 3 + PAID_GAP_MS / 1000;
  const est = route ? estimateRun(remaining, folderCount, model, route, secondsPerCall) : null;
  const paid = route === "byok" || route === "free";

  return (
    <section className="rounded-[var(--radius)] border border-border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="mr-auto text-sm font-semibold">Sort my meetings</h2>
        <Button variant="ghost" size="sm" onClick={onEditFolders}>
          <FolderTree className="h-4 w-4" />
          Edit folders
        </Button>
        {stats?.last_run_id && !busy && (
          <Button
            variant="ghost"
            size="sm"
            onClick={async () => {
              const n = await undoLastAutoSort();
              setUndoMsg(`${n} meeting${n === 1 ? "" : "s"} moved back to Unfiled.`);
            }}
            title="Move every meeting the last run filed back to Unfiled"
          >
            <Undo2 className="h-4 w-4" />
            Undo last auto-sort ({stats.last_run_count})
          </Button>
        )}
      </div>

      <p className="mt-1 text-sm text-muted-foreground">
        {stats
          ? `${stats.unsorted} unsorted · ${stats.review} to review · ${stats.auto} auto-sorted · ${stats.manual} sorted by you`
          : "…"}
      </p>

      {busy || run.status === "paused" ? (
        <div className="mt-3 space-y-2">
          <div className="h-2 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-accent transition-[width]"
              style={{ width: `${run.total ? (run.processed / run.total) * 100 : 0}%` }}
            />
          </div>
          <p className="text-xs text-muted-foreground">
            {run.processed} / {run.total} · {run.filed} filed · {run.queued} to review
            {run.failed ? ` · ${run.failed} failed` : ""}
            {busy && est ? ` · about ${formatDuration(est.seconds)} left` : ""}
          </p>
          {run.error && run.status === "paused" && (
            <p className="text-xs text-danger">
              {run.error === "no-ai" ? "No AI model is available — check Settings → AI." : run.error}
            </p>
          )}
          <div className="flex gap-2">
            {busy ? (
              <Button variant="outline" size="sm" onClick={cancelAutoSort} disabled={run.status === "cancelling"}>
                <Pause className="h-4 w-4" />
                {run.status === "cancelling" ? "Stopping after this meeting…" : "Cancel"}
              </Button>
            ) : (
              <>
                <Button size="sm" onClick={() => void startAutoSort({ resume: true })}>
                  <Play className="h-4 w-4" />
                  Resume
                </Button>
                <Button variant="ghost" size="sm" onClick={cancelAutoSort}>
                  Stop
                </Button>
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-3 space-y-2">
          {est && remaining > 0 && (
            <p className="text-xs text-muted-foreground">
              {remaining} meetings · about {formatDuration(est.seconds)} on{" "}
              {route === "local"
                ? "your on-device model (free)"
                : route === "apple"
                  ? "Apple Intelligence (free, on-device)"
                  : route === "byok"
                    ? `your own key${est.usd != null ? ` · roughly $${est.usd.toFixed(2)}` : ""}`
                    : route === "free"
                      ? "Lalela's free allowance"
                      : "no model"}
              {paid ? ` · ~${Math.round(est.inputTokens / 1000)}k tokens` : ""}
            </p>
          )}
          {route === "free" && est && est.inputTokens > FREE_TIER_TOKENS / 2 && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
              This would use most or all of your monthly free allowance. Add your own key or pick a
              local model in Settings → AI for a large sort; it pauses safely if the allowance runs out.
            </p>
          )}
          {route === "none" && (
            <p className="text-xs text-danger">
              {noAiHint(
                "Set up a model first (Settings → AI): a free local model, Apple Intelligence, your own key, or sign in.",
              )}
            </p>
          )}
          {run.status === "error" && run.error && (
            <p className="text-xs text-danger">
              {run.error === "no-ai" ? "No AI model is available — check Settings → AI." : run.error}
            </p>
          )}
          {run.status === "done" && (
            <p className="text-xs text-muted-foreground">
              Last run: {run.filed} filed, {run.queued} sent to review
              {run.failed ? `, ${run.failed} failed (they stay unsorted)` : ""}.
            </p>
          )}
          {undoMsg && <p className="text-xs text-muted-foreground">{undoMsg}</p>}
          <Button
            onClick={() => void startAutoSort()}
            disabled={remaining === 0 || route === "none" || folderCount === 0}
          >
            <Sparkles className="h-4 w-4" />
            Sort {remaining} unsorted meeting{remaining === 1 ? "" : "s"}
          </Button>
        </div>
      )}
    </section>
  );
}

// ── Review queue ─────────────────────────────────────────────────────────

function ReviewQueue({
  items,
  projects,
  onOpenMeeting,
}: {
  items: SortRecord[];
  projects: Project[];
  onOpenMeeting: (id: string) => void;
}) {
  const { user } = useAuth();
  const [idx, setIdx] = useState(0);
  const [pick, setPick] = useState("");
  const [snippet, setSnippet] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const pickRef = useRef<HTMLSelectElement>(null);
  const folders = useMemo(() => approvedFolders(projects), [projects]);
  // "Pick another" offers every folder (approved first), not just approved.
  const allFolders = useMemo(() => {
    const all = approvedFolders(projects, {
      folders: projects.map((p) => ({ id: p.id, hint: "" })),
      approvedAt: 0,
    });
    const approvedIds = new Set(folders.map((f) => f.id));
    return [...folders, ...all.filter((f) => !approvedIds.has(f.id)).sort((a, b) => a.name.localeCompare(b.name))];
  }, [projects, folders]);
  const nameOf = (id: string | null) => allFolders.find((f) => f.id === id)?.name ?? null;

  const cur = items[Math.min(idx, items.length - 1)];
  useEffect(() => {
    if (idx > 0 && idx >= items.length) setIdx(Math.max(0, items.length - 1));
  }, [items.length, idx]);

  useEffect(() => {
    setPick("");
    setSnippet("");
    if (!cur) return;
    let live = true;
    getMeeting(cur.meeting_id)
      .then((m) => {
        if (!live) return;
        setSnippet(sampleTranscript(m.segments.map((s) => `${s.speaker}: ${s.text}`), 900));
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [cur?.meeting_id]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const suggestedId = cur && cur.folder_id && nameOf(cur.folder_id) ? cur.folder_id : null;
  const accept = () => {
    if (!cur) return;
    if (suggestedId) void act(() => fileByHand(cur.meeting_id, suggestedId));
    else if (cur.suggested_new_folder)
      void act(() => createFolderAndFile(cur.meeting_id, cur.suggested_new_folder!, user?.id));
  };
  const fileInto = (folderId: string) => cur && void act(() => fileByHand(cur.meeting_id, folderId));
  const skip = () => cur && void act(() => skipInQueue(cur.meeting_id));

  // Keyboard: Enter/A accept · 1–9 file into folder N · P pick · S skip ·
  // J/↓ next · K/↑ previous · O open the meeting.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable))
        return;
      if (e.metaKey || e.ctrlKey || e.altKey || !cur) return;
      const k = e.key.toLowerCase();
      if (k === "enter" || k === "a") accept();
      else if (k === "s") skip();
      else if (k === "j" || k === "arrowdown") setIdx((i) => Math.min(items.length - 1, i + 1));
      else if (k === "k" || k === "arrowup") setIdx((i) => Math.max(0, i - 1));
      else if (k === "o") onOpenMeeting(cur.meeting_id);
      else if (k === "p") pickRef.current?.focus();
      else if (/^[1-9]$/.test(k) && folders[Number(k) - 1]) fileInto(folders[Number(k) - 1].id);
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (items.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        Nothing to sort by hand right now.
      </p>
    );
  }

  return (
    <div className="grid gap-4 md:grid-cols-[minmax(0,16rem)_1fr]">
      <ul className="max-h-[60vh] space-y-1 overflow-y-auto">
        {items.map((it, i) => (
          <li key={it.meeting_id}>
            <button
              onClick={() => setIdx(i)}
              className={cn(
                "w-full rounded-[var(--radius)] px-3 py-2 text-left text-sm",
                i === idx ? "bg-primary/15 font-semibold" : "hover:bg-muted",
              )}
            >
              <span className="flex items-center gap-1.5">
                {it.title_mismatch && <AlertTriangle className="h-3.5 w-3.5 flex-none text-amber-600" />}
                <span className="truncate">{it.title}</span>
              </span>
              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                {nameOf(it.folder_id) ?? (it.suggested_new_folder ? `New: ${it.suggested_new_folder}` : "No match")} ·{" "}
                {pct(it.confidence)}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {cur && (
        <div className="space-y-3 rounded-[var(--radius)] border border-border bg-card p-4">
          <div>
            <button
              onClick={() => onOpenMeeting(cur.meeting_id)}
              className="text-left text-base font-semibold hover:underline"
              title="Open meeting (O)"
            >
              {cur.title}
            </button>
            <p className="text-xs text-muted-foreground">{formatDate(cur.created_at)}</p>
          </div>

          {cur.title_mismatch && (
            <p className="flex items-start gap-1.5 rounded-[var(--radius)] bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 flex-none" />
              The title doesn't seem to match what was discussed — the suggestion follows the content.
            </p>
          )}

          <div className="text-sm">
            <span className="text-muted-foreground">Suggested: </span>
            <span className="font-semibold">
              {nameOf(cur.folder_id) ??
                (cur.suggested_new_folder ? `New folder “${cur.suggested_new_folder}”` : "No matching folder")}
            </span>
            <span className="text-muted-foreground"> · {pct(cur.confidence)} sure</span>
            {cur.reason && (
              <p className="mt-1 text-muted-foreground">
                “{cur.reason}”{" "}
                <ReportAiButton
                  size="xs"
                  surface="auto_sort"
                  output={() =>
                    `Suggested: ${nameOf(cur.folder_id) ?? cur.suggested_new_folder ?? "none"}\nReason: ${cur.reason}`
                  }
                />
              </p>
            )}
          </div>

          {cur.summary_head && (
            <p className="line-clamp-3 text-xs text-muted-foreground">{cur.summary_head}</p>
          )}
          <pre className="max-h-48 overflow-y-auto whitespace-pre-wrap rounded-[var(--radius)] bg-muted p-3 font-sans text-xs text-muted-foreground">
            {snippet || "Loading transcript…"}
          </pre>

          <div className="flex flex-wrap items-center gap-2">
            {(suggestedId || cur.suggested_new_folder) && (
              <Button onClick={accept} disabled={busy}>
                {suggestedId ? <Check className="h-4 w-4" /> : <FolderPlus className="h-4 w-4" />}
                {suggestedId ? "Accept" : "Create folder & file"}
                <kbd className="ml-1 text-[10px] opacity-70">↵</kbd>
              </Button>
            )}
            <select
              ref={pickRef}
              value={pick}
              onChange={(e) => {
                setPick(e.target.value);
                if (e.target.value) fileInto(e.target.value);
              }}
              className={cn(inputClass, "w-60 flex-none")}
              aria-label="Pick another folder"
              title="Pick another folder (P, or 1–9)"
            >
              <option value="">Pick another folder…</option>
              {allFolders.map((f, i) => (
                <option key={f.id} value={f.id}>
                  {i < 9 && i < folders.length ? `${i + 1}. ` : ""}
                  {f.name}
                </option>
              ))}
            </select>
            <Button variant="ghost" onClick={skip} disabled={busy}>
              <SkipForward className="h-4 w-4" />
              Skip <kbd className="ml-1 text-[10px] opacity-70">S</kbd>
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Keys: ↵/A accept · 1–9 file into folder · P pick · S skip · J/K next/previous · O open
          </p>
        </div>
      )}
    </div>
  );
}

// ── View ─────────────────────────────────────────────────────────────────

export function AutoSortView({ onOpenMeeting }: { onOpenMeeting: (id: string) => void }) {
  useEffect(() => trackEvent("feature_used", { feature: "auto_sort", action: "opened" }), []);
  const [projects, setProjects] = useState<Project[]>([]);
  const [stats, setStats] = useState<SortStats | null>(null);
  const [queue, setQueue] = useState<SortRecord[]>([]);
  const [recent, setRecent] = useState<SortRecord[] | null>(null);
  const [editing, setEditing] = useState(false);
  const [configured, setConfigured] = useState(() => getSortConfig() !== null);
  const run = useAutoSortRun();

  const reload = useCallback(() => {
    listProjects().then(setProjects).catch(() => {});
    sortStats().then(setStats).catch(() => {});
    sortReviewQueue().then(setQueue).catch(() => {});
    setConfigured(getSortConfig() !== null);
  }, []);

  useEffect(() => {
    reload();
    return onSortChanged(reload);
  }, [reload]);
  // Refresh counts as a batch progresses (cheap: a few COUNT queries).
  useEffect(() => {
    if (run.processed % 5 === 0) reload();
  }, [run.processed, run.status, reload]);

  const folderCount = approvedFolders(projects).length;
  const nameOf = (id: string | null) => approvedFolders(projects).find((f) => f.id === id)?.name ?? "—";

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border px-6 py-4">
        <h1 className="text-xl font-bold tracking-tight">To sort</h1>
        <p className="text-sm text-muted-foreground">
          Lalela files meetings into your folders by what was discussed. Anything it isn't sure
          about waits here for you.
        </p>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        <div className="mx-auto max-w-4xl space-y-4">
          {!configured || editing ? (
            <FolderSetup
              onDone={() => {
                setEditing(false);
                reload();
              }}
              onCancel={configured ? () => setEditing(false) : undefined}
            />
          ) : (
            <BatchPanel stats={stats} folderCount={folderCount} onEditFolders={() => setEditing(true)} />
          )}

          {configured && (
            <section>
              <h2 className="mb-2 text-sm font-semibold">
                Waiting for you <span className="font-normal text-muted-foreground">({queue.length})</span>
              </h2>
              <ReviewQueue items={queue} projects={projects} onOpenMeeting={onOpenMeeting} />
            </section>
          )}

          {configured && (
            <details
              className="rounded-[var(--radius)] border border-border bg-card p-4"
              onToggle={(e) => {
                if ((e.target as HTMLDetailsElement).open) recentAutoSorts(100).then(setRecent).catch(() => {});
              }}
            >
              <summary className="cursor-pointer text-sm font-semibold">
                <RotateCcw className="mr-1.5 inline h-3.5 w-3.5" />
                Recently auto-sorted
              </summary>
              <ul className="mt-3 space-y-1.5 text-sm">
                {(recent ?? []).map((r) => (
                  <li key={r.meeting_id} className="flex gap-2">
                    <button onClick={() => onOpenMeeting(r.meeting_id)} className="truncate text-left hover:underline">
                      {r.title}
                    </button>
                    <span className="ml-auto flex-none text-xs text-muted-foreground">
                      → {nameOf(r.folder_id)} · {pct(r.confidence)}
                    </span>
                  </li>
                ))}
                {recent && recent.length === 0 && (
                  <li className="text-muted-foreground">Nothing auto-sorted yet.</li>
                )}
              </ul>
            </details>
          )}

          {configured && (
            <section className="rounded-[var(--radius)] border border-border bg-card p-4">
              <h2 className="mb-2 text-sm font-semibold">Settings</h2>
              <AutoSortSettings />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
