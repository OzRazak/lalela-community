import { noAiHint } from "@/lib/edition";
import { trackEvent } from "@/lib/analytics";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/Button";
import { ReportAiButton } from "@/components/ReportAiContent";
import { EditableTitle } from "@/components/EditableTitle";
import { AssigneeCombobox, type AssigneeValue } from "@/components/AssigneeCombobox";
import {
  listActionItems,
  setMeetingActionItems,
  addActionItem,
  updateActionItem,
  deleteActionItem,
  type ActionItem,
  type FullMeeting,
} from "@/lib/lalela";
import { actionsModel, getTaskStages, isTaskOverdue, setActionsModel } from "@/lib/settings";
import { useModelPicker } from "@/lib/useModels";
import { clearBgTask, startBgTask, useBgTask } from "@/lib/bgTask";
import { extractActionItems, membersForProject } from "@/lib/actionItems";
import {
  pushActionItem,
  deleteCloudActionItem,
  pushNotification,
  myActorName,
  type Member,
} from "@/lib/sync";
import { useAuth } from "@/lib/auth";
import {
  AlertTriangle,
  CalendarClock,
  Check,
  CheckCircle2,
  Loader2,
  Plus,
  Sparkles,
  Trash2,
  User,
} from "lucide-react";

interface ActionItemsPanelProps {
  meeting: FullMeeting;
  onOpenSettings: () => void;
}

/** Display name for a task's stage id, honouring the user's custom columns. */
function stageTitle(status: string): string {
  const stage = getTaskStages().find((s) => s.id === status);
  if (stage) return stage.title;
  return status === "approved" ? "To do" : status === "in_progress" ? "In progress" : status;
}

/** Per-meeting action items: generate from the transcript, review the
 * suggestions (fix assignee, delete noise), approve each onto the global
 * Tasks board. Assignees are auto-matched to project members when possible. */
export function ActionItemsPanel({ meeting, onOpenSettings }: ActionItemsPanelProps) {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  // Distinct free-text assignee names used across ALL meetings' tasks — so a
  // name typed once here suggests everywhere afterwards.
  const [allNames, setAllNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);
  const { user } = useAuth();
  // Model for action-item extraction (T3): defaults to the user's global
  // default (local included); persisted across meetings.
  const { model, setModel, models } = useModelPicker(actionsModel);
  // Extraction runs as a detached task (T4) keyed by meeting: this panel is a
  // tab that unmounts on every tab switch, so a run kept in local state would
  // lose its result and indicator when the user clicks away. Detached, it
  // persists via setMeetingActionItems and is adopted on return.
  const runKey = `actions:${meeting.id}`;
  const task = useBgTask<ActionItem[]>(runKey);
  const busy = task.status === "running";

  useEffect(() => {
    let cancelled = false;
    listActionItems(meeting.id)
      .then((list) => !cancelled && setItems(list))
      .catch(() => {});
    membersForProject(meeting.project_id).then((m) => !cancelled && setMembers(m));
    // Suggestion pool: every assignee name already used on any task.
    listActionItems()
      .then((list) => {
        if (cancelled) return;
        const names = new Set<string>();
        for (const it of list) if (it.assignee_name) names.add(it.assignee_name);
        setAllNames([...names]);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [meeting.id, meeting.project_id]);

  // Fold in names from this meeting's own (possibly unsaved-to-cloud) items too.
  const usedNames = useMemo(() => {
    const names = new Set<string>(allNames);
    for (const it of items) if (it.assignee_name) names.add(it.assignee_name);
    return [...names];
  }, [allNames, items]);

  // Adopt an extraction that finished (possibly while this tab was unmounted).
  useEffect(() => {
    if (task.status === "done" && task.result) {
      setItems(task.result);
      clearBgTask(runKey);
    } else if (task.status === "error") {
      setError(task.error === "no-ai" ? "no-key" : (task.error ?? "Couldn't generate action items"));
      clearBgTask(runKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task.status]);

  const generate = () => {
    setError(null);
    void startBgTask<ActionItem[]>(runKey, {
      run: async () => {
        const extracted = await extractActionItems(meeting.segments, model, members, true);
        return await setMeetingActionItems(meeting.id, extracted);
      },
    });
  };

  const patch = async (item: ActionItem, changes: Partial<ActionItem>) => {
    try {
      const updated = await updateActionItem({
        id: item.id,
        title: changes.title ?? item.title,
        assignee_name: changes.assignee_name !== undefined ? changes.assignee_name : item.assignee_name,
        assignee_uid: changes.assignee_uid !== undefined ? changes.assignee_uid : item.assignee_uid,
        due: changes.due !== undefined ? changes.due : item.due,
        status: changes.status ?? item.status,
      });
      setItems((prev) => prev.map((x) => (x.id === item.id ? updated : x)));
      // Mirror to the cloud so matched assignees see it on their board.
      if (user && updated.status !== "suggested") {
        pushActionItem(user.id, updated).catch(() => {});
        // Notify the assignee when a task first lands on the board addressed
        // to them, or when it's re-assigned to them afterwards.
        const becameApproved = item.status === "suggested" && updated.status === "approved";
        const reassigned =
          changes.assignee_uid !== undefined && changes.assignee_uid !== item.assignee_uid;
        if (updated.assignee_uid && updated.assignee_uid !== user.id && (becameApproved || reassigned)) {
          myActorName(user.id)
            .then((name) =>
              pushNotification({
                actorId: user.id,
                actorName: name,
                recipientId: updated.assignee_uid,
                projectId: updated.project_id,
                kind: "task_assigned",
                title: `${name} assigned you a task`,
                body: updated.title,
                meetingId: updated.meeting_id,
              }),
            )
            .catch(() => {});
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const remove = async (id: string) => {
    try {
      await deleteActionItem(id);
      setItems((prev) => prev.filter((x) => x.id !== id));
      if (user) void deleteCloudActionItem(id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  /** Manually add a task straight to the board (no AI). Assignee/due are set
   * on the card afterwards with the existing controls. */
  const addTask = async () => {
    const title = newTitle.trim();
    if (!title || adding) return;
    setAdding(true);
    setError(null);
    try {
      const created = await addActionItem({
        meeting_id: meeting.id,
        title,
        assignee_name: null,
        assignee_uid: null,
        due: null,
        status: "approved",
      });
      setItems((prev) => [...prev, created]);
      trackEvent("task_created", { source: "meeting" });
      setNewTitle("");
      if (user) pushActionItem(user.id, created).catch(() => {});
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setAdding(false);
    }
  };

  const reassign = (item: ActionItem, next: AssigneeValue) => void patch(item, next);

  const suggested = items.filter((i) => i.status === "suggested");
  const board = items.filter((i) => i.status !== "suggested");

  const assigneeSelect = (item: ActionItem) => (
    <AssigneeCombobox
      assigneeName={item.assignee_name}
      assigneeUid={item.assignee_uid}
      members={members}
      usedNames={usedNames}
      onChange={(next) => reassign(item, next)}
      triggerClassName="h-7 w-44 px-1.5 text-xs"
    />
  );

  /** A due-date editor. `due` is stored as-is; a real date is written as
   * YYYY-MM-DD. Free-text AI dues (e.g. "Friday") that aren't a date show a
   * hint chip beside an empty picker so the user can pin a real deadline. */
  const dueInput = (item: ActionItem) => {
    const isDate = /^\d{4}-\d{2}-\d{2}$/.test((item.due ?? "").trim());
    const overdue = isTaskOverdue(item.due, item.status);
    return (
      <span className="flex items-center gap-1">
        <CalendarClock
          className={overdue ? "h-3.5 w-3.5 text-danger" : "h-3.5 w-3.5 text-muted-foreground"}
        />
        <input
          type="date"
          value={isDate ? (item.due as string).trim() : ""}
          onChange={(e) => void patch(item, { due: e.target.value || null })}
          className={
            "h-7 rounded-[var(--radius)] border bg-card px-1.5 text-xs " +
            (overdue ? "border-danger text-danger" : "border-border")
          }
          title={overdue ? "Overdue" : "Due date"}
        />
        {item.due && !isDate && (
          <span
            className="rounded-full bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
            title="From the transcript — pick a date to pin it"
          >
            {item.due}
          </span>
        )}
      </span>
    );
  };

  return (
    <div className="space-y-4 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={generate} disabled={busy || meeting.segments.length === 0}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {items.length ? "Regenerate action items" : "Generate action items"}
        </Button>
        <select
          value={model}
          onChange={(e) => {
            setModel(e.target.value);
            setActionsModel(e.target.value); // remembered across meetings
          }}
          className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
          title="AI model for action-item extraction"
        >
          {models.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <p className="text-xs text-muted-foreground">
          Suggestions appear below — approve each to send it to the Tasks board.
          {members.length > 0 && " Names are auto-matched to project members."}
        </p>
      </div>

      {/* Manual add — a task straight to the board without AI extraction. */}
      <div className="flex items-center gap-2">
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void addTask();
            }
          }}
          placeholder="Add a task to this meeting…"
          className="h-9 flex-1 rounded-[var(--radius)] border border-border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
        />
        <Button
          variant="outline"
          size="sm"
          onClick={() => void addTask()}
          disabled={!newTitle.trim() || adding}
        >
          <Plus className="h-4 w-4" />
          Add task
        </Button>
      </div>

      {error === "no-key" ? (
        <div className="flex items-center gap-2 rounded-[var(--radius)] border border-warning/40 bg-warning/10 p-2 text-sm">
          <AlertTriangle className="h-4 w-4 text-warning" />
          {noAiHint("To generate: sign in for free monthly AI, add your own key, or pick a local model.")}
          <button onClick={onOpenSettings} className="font-medium text-accent hover:underline">
            Open Settings →
          </button>
        </div>
      ) : error ? (
        <div className="rounded-[var(--radius)] border border-danger/30 bg-danger/10 p-2 text-sm text-danger">
          {error}
        </div>
      ) : null}

      {suggested.length > 0 && (
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold">Suggested ({suggested.length})</h3>
            <div className="flex items-center gap-1.5">
              <ReportAiButton
                surface="tasks"
                model={model}
                output={() =>
                  suggested
                    .map((i) => `- ${i.title}${i.assignee_name ? ` (${i.assignee_name})` : ""}${i.due ? ` — due ${i.due}` : ""}`)
                    .join("\n")
                }
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => suggested.forEach((i) => void patch(i, { status: "approved" }))}
              >
                <Check className="h-4 w-4" />
                Approve all
              </Button>
            </div>
          </div>
          <div className="space-y-2">
            {suggested.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-card px-3 py-2"
              >
                <EditableTitle
                  value={item.title}
                  onSave={(next) => void patch(item, { title: next })}
                  className="min-w-0 flex-1 text-sm"
                />
                {dueInput(item)}
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <User className="h-3.5 w-3.5" />
                  {assigneeSelect(item)}
                </span>
                <Button size="sm" onClick={() => void patch(item, { status: "approved" })}>
                  <Check className="h-4 w-4" />
                  Approve
                </Button>
                <button
                  onClick={() => void remove(item.id)}
                  className="rounded p-1 text-muted-foreground hover:text-danger"
                  title="Discard suggestion"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {board.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">On the board</h3>
          <div className="space-y-2">
            {board.map((item) => (
              <div
                key={item.id}
                className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-border bg-surface px-3 py-2"
              >
                <CheckCircle2
                  className={
                    item.status === "done"
                      ? "h-4 w-4 shrink-0 text-success"
                      : "h-4 w-4 shrink-0 text-muted-foreground"
                  }
                />
                <EditableTitle
                  value={item.title}
                  onSave={(next) => void patch(item, { title: next })}
                  className={
                    item.status === "done"
                      ? "min-w-0 flex-1 text-sm text-muted-foreground line-through"
                      : "min-w-0 flex-1 text-sm"
                  }
                />
                {dueInput(item)}
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <User className="h-3.5 w-3.5" />
                  {assigneeSelect(item)}
                </span>
                <span className="rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                  {stageTitle(item.status)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Manage these on the Tasks board in the sidebar.
          </p>
        </div>
      )}

      {items.length === 0 && !busy && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No action items yet — generate them from the transcript above.
        </p>
      )}
    </div>
  );
}
