// Retro-run one automation across past meetings (T1). Oz created his first
// automations and wants to (a) preview what they'd do to his existing history
// and (b) backfill sends into Artemis/other apps. This dialog scopes the run
// (all meetings / date range / folder / source), warns when the rule uses AI
// classification (real tokens/compute per meeting), then drives the shared
// engine's `runAutomationOnMeetings` with live progress + cancel. Everything
// rides the SAME `automation_runs` ledger as live runs, so re-runs no-op and
// ask-mode sends land in Pending approvals — the preview Oz asked for.

import { useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, Check, History, Loader2, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/utils";
import { IS_MOBILE } from "@/lib/platform";
import {
  flattenProjectTree,
  listMeetings,
  listProjects,
  type MeetingMeta,
  type Project,
} from "@/lib/lalela";
import { preflightCloudAiConsent } from "@/lib/ai";
import {
  automationsAiModels,
  runAutomationOnMeetings,
  sourceForMeetingId,
  type RetroRunProgress,
} from "@/lib/automations";
import type { Automation, Tag } from "@/lib/tags";

const SOURCES: { id: string; label: string }[] = [
  { id: "desktop", label: "Desktop" },
  { id: "web", label: "Web" },
  { id: "teams", label: "Teams" },
  { id: "readai", label: "Read AI" },
  { id: "granola", label: "Granola" },
  { id: "fathom", label: "Fathom" },
  { id: "fireflies", label: "Fireflies" },
];

const ANY_FOLDER = "__any__";
const UNFILED = "__unfiled__";

/** "YYYY-MM-DD" → local start-of-day ms (null when blank). */
function fromDateMs(v: string): number | null {
  if (!v) return null;
  const t = new Date(`${v}T00:00:00`).getTime();
  return Number.isNaN(t) ? null : t;
}
/** "YYYY-MM-DD" → local end-of-day ms (null when blank). */
function toDateMs(v: string): number | null {
  if (!v) return null;
  const t = new Date(`${v}T23:59:59.999`).getTime();
  return Number.isNaN(t) ? null : t;
}

interface Props {
  automation: Automation;
  tag: Tag | null;
  onClose: () => void;
  /** Called once the batch finishes (or is cancelled) so parent views refresh. */
  onRan?: () => void;
}

export function RetroRunDialog({ automation, tag, onClose, onRan }: Props) {
  const [metas, setMetas] = useState<MeetingMeta[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [loaded, setLoaded] = useState(false);

  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [folder, setFolder] = useState<string>(ANY_FOLDER);
  const [sources, setSources] = useState<string[]>([]);

  const [phase, setPhase] = useState<"config" | "running" | "done">("config");
  const [progress, setProgress] = useState<RetroRunProgress | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    void Promise.all([listMeetings(null).catch(() => []), listProjects().catch(() => [])]).then(
      ([m, p]) => {
        setMetas(m);
        setProjects(p);
        setLoaded(true);
      },
    );
  }, []);

  // Abort any in-flight run if the dialog unmounts.
  useEffect(() => () => abortRef.current?.abort(), []);

  const filtered = useMemo(() => {
    const fromMs = fromDateMs(from);
    const toMs = toDateMs(to);
    return metas.filter((m) => {
      if (fromMs != null && m.created_at < fromMs) return false;
      if (toMs != null && m.created_at > toMs) return false;
      if (folder !== ANY_FOLDER) {
        const pid = m.project_id ?? UNFILED;
        if (pid !== folder) return false;
      }
      if (sources.length && !sources.includes(sourceForMeetingId(m.id))) return false;
      return true;
    });
  }, [metas, from, to, folder, sources]);

  const usesAi = !!automation.ai_classify?.enabled && !!automation.ai_classify.hint?.trim();

  const toggleSource = (id: string) =>
    setSources((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]));

  const start = async () => {
    const ids = filtered.map((m) => m.id);
    if (ids.length === 0) return;
    // User-started: ask for cloud-AI consent now (once), so the engine's
    // background AI calls can run. "Not now" still runs the non-AI actions.
    // Each action's EFFECTIVE model counts (a cloud summary model behind an
    // on-device default still needs consent).
    const models = await automationsAiModels([automation]).catch(() => [] as string[]);
    if (models.length) await preflightCloudAiConsent(models).catch(() => false);
    setPhase("running");
    setProgress({
      total: ids.length,
      evaluated: 0,
      matched: 0,
      executed: 0,
      queued: 0,
      failed: 0,
      errors: 0,
      deferred: 0,
    });
    const ac = new AbortController();
    abortRef.current = ac;
    const final = await runAutomationOnMeetings(automation.tag_id, ids, {
      signal: ac.signal,
      concurrency: 3,
      onProgress: (p) => setProgress(p),
    });
    setProgress(final);
    setPhase("done");
    onRan?.();
  };

  const cancel = () => abortRef.current?.abort();

  const selectCls = "h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm";
  const label = "block text-xs font-semibold text-muted-foreground mb-1.5";
  const n = filtered.length;

  const tagChip = (
    <span
      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium"
      style={{ background: `${tag?.color ?? "#7c6cf5"}22`, color: tag?.color ?? "#7c6cf5" }}
    >
      <span className="h-2 w-2 rounded-full" style={{ background: tag?.color ?? "#7c6cf5" }} />
      {tag?.name ?? automation.tag_id}
    </span>
  );

  return (
    <div
      className={cn(
        "fixed inset-0 z-[60] flex",
        // Mobile: full-screen sheet. Desktop: centered fixed-width modal.
        IS_MOBILE ? "flex-col" : "items-center justify-center bg-black/40 p-4",
      )}
    >
      <div
        className={cn(
          "flex flex-col bg-background",
          IS_MOBILE
            ? "h-full w-full pt-[env(safe-area-inset-top)] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)]"
            : "max-h-[90vh] w-full max-w-lg rounded-[var(--radius)] border border-border shadow-xl",
        )}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3">
          <h2 className="flex items-center gap-2 text-base font-bold">
            <History className="h-4 w-4 text-primary" /> Run on past meetings
          </h2>
          <button
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4">
          <p className="mb-4 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            Evaluate {tagChip} against meetings you already have. Meetings it already handled are
            skipped; ask-mode sends land in Pending approvals.
          </p>

          {phase === "config" && (
            <div className="space-y-4">
              <div>
                <label className={label}>Date range (optional)</label>
                <div className="flex items-center gap-2 text-sm">
                  <input
                    type="date"
                    value={from}
                    onChange={(e) => setFrom(e.target.value)}
                    className={selectCls}
                    aria-label="From date"
                  />
                  <span className="text-xs text-muted-foreground">to</span>
                  <input
                    type="date"
                    value={to}
                    onChange={(e) => setTo(e.target.value)}
                    className={selectCls}
                    aria-label="To date"
                  />
                </div>
              </div>

              <div>
                <label className={label}>Folder</label>
                <select
                  value={folder}
                  onChange={(e) => setFolder(e.target.value)}
                  className={selectCls + " w-full"}
                >
                  <option value={ANY_FOLDER}>Any folder</option>
                  <option value={UNFILED}>Unfiled</option>
                  {flattenProjectTree(projects).map(({ project: p, depth }) => (
                    <option key={p.id} value={p.id}>
                      {" ".repeat(depth) + p.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className={label}>Source</label>
                <div className="flex flex-wrap gap-1.5">
                  {SOURCES.map((s) => (
                    <button
                      key={s.id}
                      type="button"
                      onClick={() => toggleSource(s.id)}
                      className={
                        "rounded-full border px-2.5 py-1 text-xs " +
                        (sources.includes(s.id)
                          ? "border-primary bg-primary/15 text-foreground"
                          : "border-border text-muted-foreground hover:bg-muted")
                      }
                    >
                      {s.label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  No source selected = all sources.
                </p>
              </div>

              <div className="rounded-[var(--radius)] border border-border bg-surface px-3 py-2 text-sm">
                {loaded ? (
                  <>
                    <span className="font-semibold text-foreground">{n}</span> meeting
                    {n === 1 ? "" : "s"} match this scope.
                  </>
                ) : (
                  <span className="text-muted-foreground">Counting meetings…</span>
                )}
              </div>

              {usesAi && n > 0 && (
                <div className="flex items-start gap-2 rounded-[var(--radius)] border border-warning/40 bg-warning/10 p-3 text-xs text-foreground">
                  <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warning" />
                  <span>
                    This rule uses AI classification. It will run AI on up to ~{n} meeting
                    {n === 1 ? "" : "s"} (only those the quick filters don&apos;t already match),
                    which uses tokens or local compute.
                  </span>
                </div>
              )}
            </div>
          )}

          {phase !== "config" && progress && (
            <div className="space-y-3">
              <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-primary transition-[width]"
                  style={{
                    width: `${progress.total ? (progress.evaluated / progress.total) * 100 : 100}%`,
                  }}
                />
              </div>
              <p className="text-sm">
                <span className="font-semibold">{progress.evaluated}</span> of {progress.total}{" "}
                evaluated · <span className="font-semibold">{progress.matched}</span> matched ·{" "}
                <span className="font-semibold">{progress.queued + progress.executed}</span>{" "}
                action{progress.queued + progress.executed === 1 ? "" : "s"}{" "}
                {progress.queued ? `queued` : "executed"}
              </p>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{progress.executed} executed now</span>
                <span>{progress.queued} queued for approval</span>
                {progress.failed > 0 && (
                  <span className="text-danger">{progress.failed} action(s) failed</span>
                )}
                {progress.errors > 0 && (
                  <span className="text-danger">{progress.errors} meeting(s) errored</span>
                )}
              </div>

              {phase === "running" && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Loader2 className="h-4 w-4 animate-spin" /> Running…
                </p>
              )}
              {phase === "done" && (
                <p className="flex items-center gap-2 text-sm text-success">
                  <Check className="h-4 w-4" />
                  {progress.evaluated < progress.total
                    ? "Stopped."
                    : "Done."}{" "}
                  {progress.queued > 0
                    ? "Review queued sends under Pending approvals."
                    : "Nothing left to approve."}
                </p>
              )}
            </div>
          )}
        </div>

        <div
          className={cn(
            "flex justify-end gap-2 border-t border-border px-5 py-3",
            IS_MOBILE && "pb-[calc(0.75rem+env(safe-area-inset-bottom))]",
          )}
        >
          {phase === "config" && (
            <>
              <Button variant="ghost" size="sm" onClick={onClose}>
                Cancel
              </Button>
              <Button size="sm" onClick={start} disabled={!loaded || n === 0}>
                <History className="h-4 w-4" /> Start
              </Button>
            </>
          )}
          {phase === "running" && (
            <Button variant="outline" size="sm" onClick={cancel}>
              Cancel run
            </Button>
          )}
          {phase === "done" && (
            <Button size="sm" onClick={onClose}>
              Done
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
