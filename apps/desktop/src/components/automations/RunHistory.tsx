// Recent automation runs (phase 19 / B7 — desktop). Reads the local SQLite
// ledger mirror (populated by the engine and the cloud pull) so it works
// offline, with status filter chips. This is the audit trail: every tag, move,
// workflow, summary and send the engines recorded, newest first.

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatDate, listMeetings, type MeetingMeta } from "@/lib/lalela";
import { listAutomationRuns, listTags, type AutomationRun, type RunStatus, type Tag } from "@/lib/tags";
import { listFolderRuleRuns, listFolderRules, type FolderRuleRun } from "@/lib/folderRules";
import { FolderRunList } from "@/components/folders/FolderAutomationsDialog";

const STATUS_STYLE: Record<RunStatus, string> = {
  done: "bg-success/15 text-success",
  pending_approval: "bg-warning/15 text-warning",
  failed: "bg-danger/15 text-danger",
  dismissed: "bg-muted text-muted-foreground",
};

const FILTERS: { id: "all" | RunStatus; label: string }[] = [
  { id: "all", label: "All" },
  { id: "done", label: "Done" },
  { id: "pending_approval", label: "Pending" },
  { id: "failed", label: "Failed" },
  { id: "dismissed", label: "Dismissed" },
];

function actionLabel(action: string): string {
  if (action === "send:atlas_pack") return "send → Atlas (proposed actions)";
  if (action.startsWith("send:")) return `send → ${action.slice("send:".length)}`;
  return action;
}

export function RunHistory() {
  const [runs, setRuns] = useState<AutomationRun[]>([]);
  const [tags, setTags] = useState<Map<string, Tag>>(new Map());
  const [meetings, setMeetings] = useState<Map<string, MeetingMeta>>(new Map());
  const [filter, setFilter] = useState<"all" | RunStatus>("all");
  // Folder automations (scheduled per-folder rules) keep their own run ledger;
  // their recent runs are listed above the per-meeting automation runs.
  const [folderRuns, setFolderRuns] = useState<FolderRuleRun[]>([]);
  const [ruleNames, setRuleNames] = useState<Map<string, string>>(new Map());

  const refresh = useCallback(async () => {
    const [rows, allTags, metas, fRuns, fRules] = await Promise.all([
      listAutomationRuns().catch(() => []),
      listTags().catch(() => []),
      listMeetings(null).catch(() => []),
      listFolderRuleRuns(null, 20).catch(() => []),
      listFolderRules(null).catch(() => []),
    ]);
    setFolderRuns(fRuns);
    setRuleNames(new Map(fRules.map((r) => [r.id, r.name])));
    setRuns(rows);
    setTags(new Map(allTags.map((t) => [t.id, t])));
    setMeetings(new Map(metas.map((m) => [m.id, m])));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = useMemo(
    () => (filter === "all" ? runs : runs.filter((r) => r.status === filter)),
    [runs, filter],
  );

  return (
    <div className="space-y-3">
      {folderRuns.length > 0 && (
        <section className="space-y-1.5 pb-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Folder automations
          </h3>
          <FolderRunList runs={folderRuns} tags={tags} ruleNames={ruleNames} />
        </section>
      )}
      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={
              "rounded-full border px-2.5 py-1 text-xs " +
              (filter === f.id
                ? "border-primary bg-primary/15 text-foreground"
                : "border-border text-muted-foreground hover:bg-muted")
            }
          >
            {f.label}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">No runs yet.</p>
      ) : (
        <ul className="space-y-1.5">
          {shown.map((r) => {
            const tag = tags.get(r.tag_id);
            const meeting = meetings.get(r.meeting_id);
            return (
              <li
                key={`${r.meeting_id}:${r.tag_id}:${r.action}`}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-card px-3 py-2 text-sm"
              >
                {tag && (
                  <span
                    className="rounded-full px-2 py-px text-[11px] font-medium"
                    style={{ background: `${tag.color}22`, color: tag.color }}
                  >
                    {tag.name}
                  </span>
                )}
                <span className="font-medium">{actionLabel(r.action)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">
                  {meeting?.title ?? r.meeting_id}
                </span>
                <span className={"rounded-full px-2 py-0.5 text-[11px] font-medium " + STATUS_STYLE[r.status]}>
                  {r.status.replace("_", " ")}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {r.ran_at ? formatDate(r.ran_at) : ""}
                </span>
                {r.status === "failed" && typeof r.detail?.error === "string" && (
                  // The failure reason (e.g. "Your Atlas key was rejected…") —
                  // failed sends must never be silent.
                  <p className="basis-full text-xs text-danger">{r.detail.error}</p>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
