import { trackEvent } from "@/lib/analytics";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  listActionItems,
  addActionItem,
  updateActionItem,
  deleteActionItem,
  listProjects,
  listMeetings,
  flattenProjectTree,
  getTaskStagesLocal,
  setTaskStagesLocal,
  type ActionItem,
  type MeetingMeta,
  type Project,
} from "@/lib/lalela";
import { EditableTitle } from "@/components/EditableTitle";
import { AssigneeCombobox, type AssigneeValue } from "@/components/AssigneeCombobox";
import {
  getTaskStages,
  isTaskOverdue,
  newStageId,
  normaliseStages,
  setTaskStages,
  stageForStatus,
  type TaskStage,
} from "@/lib/settings";
import { membersForProject } from "@/lib/actionItems";
import { cn } from "@/lib/utils";
import { IS_MOBILE } from "@/lib/platform";
import { useAuth } from "@/lib/auth";
import {
  listAssignedActionItems,
  pushActionItem,
  pushTaskStages,
  pullTaskStages,
  updateCloudActionItemStatus,
  deleteCloudActionItem,
  importSharedMeeting,
  pushNotification,
  myActorName,
  type Member,
} from "@/lib/sync";
import {
  CalendarClock,
  Check,
  FileText,
  Plus,
  Settings2,
  Trash2,
  User,
  Users,
  X,
} from "lucide-react";
// Amp: the teaching empty state (Spark mark + wayfinding copy).
import { EmptyState } from "@auxo/amp-primitives";

interface TasksViewProps {
  onOpenMeeting: (id: string) => void;
}

const DND_TASK = "application/x-lalela-task";

/** Global kanban of approved action items across all meetings. Columns are the
 * user's custom stages (a fixed terminal "Done" always last). Drag cards
 * between columns on desktop; on mobile a per-card dropdown moves them.
 * Suggestions that were never approved don't appear here — approve them in the
 * meeting's Action items tab. */
export function TasksView({ onOpenMeeting }: TasksViewProps) {
  const [items, setItems] = useState<ActionItem[]>([]);
  // Tasks OTHER people assigned to me (cloud mirror; needs sign-in).
  const [assigned, setAssigned] = useState<ActionItem[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [folderFilter, setFolderFilter] = useState<string>("");
  const [assigneeFilter, setAssigneeFilter] = useState<string>("");
  const [dragOver, setDragOver] = useState<string | null>(null);
  const [stages, setStages] = useState<TaskStage[]>(getTaskStages());
  const [editingStages, setEditingStages] = useState(false);
  const [meetings, setMeetings] = useState<MeetingMeta[]>([]);
  const [addingTask, setAddingTask] = useState(false);
  // Card whose title is being edited inline — its drag is suppressed so the
  // text selection doesn't start a drag.
  const [editingId, setEditingId] = useState<string | null>(null);
  // Members per project (for the assignee picker on owned cards). Best-effort;
  // cached so switching cards doesn't refetch.
  const [membersByProject, setMembersByProject] = useState<Record<string, Member[]>>({});
  const fetchedProjects = useRef(new Set<string>());
  const { user } = useAuth();

  useEffect(() => {
    listActionItems()
      .then((list) => setItems(list.filter((i) => i.status !== "suggested")))
      .catch(() => setItems([]));
    listProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
    // All meetings — the "Add task" composer attaches the new task to one.
    listMeetings()
      .then(setMeetings)
      .catch(() => setMeetings([]));
  }, []);

  useEffect(() => {
    if (!user) {
      setAssigned([]);
      return;
    }
    listAssignedActionItems(user.id)
      .then(setAssigned)
      .catch(() => setAssigned([]));
  }, [user]);

  // Stage DEFINITIONS are cross-device (phase21). Load order: localStorage
  // cache seeds the first paint (state initialiser above); then the SQLite
  // mirror (durable, offline), then the cloud (authoritative across devices).
  // A first sign-in with no cloud row seeds it from this device's columns so
  // existing custom boards propagate.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const localJson = await getTaskStagesLocal();
        if (localJson && !cancelled) {
          const local = normaliseStages(JSON.parse(localJson) as TaskStage[]);
          setStages(local);
          setTaskStages(local); // keep the fast cache in step
        }
      } catch {
        /* no mirror yet / bad JSON — the cache stands */
      }
      if (!user || cancelled) return;
      try {
        const cloud = await pullTaskStages(user.id);
        if (cancelled) return;
        if (cloud) {
          setStages(cloud);
          setTaskStages(cloud); // refresh cache
          void setTaskStagesLocal(JSON.stringify(cloud)); // refresh mirror
        } else {
          void pushTaskStages(user.id, getTaskStages()); // seed the cloud
        }
      } catch {
        /* offline — local mirror/cache is authoritative */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [user]);

  // Local items win on id clashes (an item I own that's also assigned to me).
  const all = useMemo(() => {
    const localIds = new Set(items.map((i) => i.id));
    return [...items, ...assigned.filter((a) => !localIds.has(a.id))];
  }, [items, assigned]);

  const isRemote = (id: string) => !items.some((i) => i.id === id);

  // Pull project members for every project that has a task (assignee picker).
  useEffect(() => {
    const ids = new Set<string>();
    for (const i of all) if (i.project_id) ids.add(i.project_id);
    const todo = [...ids].filter((id) => !fetchedProjects.current.has(id));
    if (todo.length === 0) return;
    todo.forEach((id) => fetchedProjects.current.add(id));
    Promise.all(todo.map((id) => membersForProject(id).then((m) => [id, m] as const)))
      .then((pairs) =>
        setMembersByProject((prev) => {
          const next = { ...prev };
          for (const [id, m] of pairs) next[id] = m;
          return next;
        }),
      )
      .catch(() => {});
  }, [all]);

  const assignees = useMemo(() => {
    const names = new Set<string>();
    for (const i of all) if (i.assignee_name) names.add(i.assignee_name);
    return [...names].sort((a, b) => a.localeCompare(b));
  }, [all]);

  const visible = all.filter(
    (i) =>
      (!folderFilter || i.project_id === folderFilter) &&
      (!assigneeFilter ||
        (assigneeFilter === "unassigned" ? !i.assignee_name : i.assignee_name === assigneeFilter)),
  );

  const projectName = (id: string | null) =>
    projects.find((p) => p.id === id)?.name ?? null;

  const persistStages = (next: TaskStage[]) => {
    setTaskStages(next);
    const normalised = getTaskStages(); // read back (Done pinned last)
    setStages(normalised);
    void setTaskStagesLocal(JSON.stringify(normalised)); // SQLite mirror
    if (user) void pushTaskStages(user.id, normalised); // cloud (cross-device)
  };

  /** Write one local item and mirror it to the cloud (exact stage id). */
  const patchLocal = async (item: ActionItem, changes: Partial<ActionItem>) => {
    const next: ActionItem = { ...item, ...changes };
    setItems((prev) => prev.map((i) => (i.id === item.id ? next : i)));
    try {
      const updated = await updateActionItem({
        id: next.id,
        title: next.title,
        assignee_name: next.assignee_name,
        assignee_uid: next.assignee_uid,
        due: next.due,
        status: next.status,
      });
      setItems((prev) => prev.map((i) => (i.id === item.id ? updated : i)));
      if (user) pushActionItem(user.id, updated).catch(() => {});
      return updated;
    } catch {
      setItems((prev) => prev.map((i) => (i.id === item.id ? item : i)));
      return null;
    }
  };

  const move = async (id: string, stageId: string) => {
    const terminal = !!stages.find((s) => s.id === stageId)?.terminal;
    if (isRemote(id)) {
      // Someone else's meeting — store the EXACT stage id in the cloud mirror
      // (phase21) so the move sticks on my board and every device. The owner,
      // whose columns may differ, still places it via their own stageForStatus.
      const item = assigned.find((i) => i.id === id);
      if (!item || item.status === stageId) return;
      setAssigned((prev) => prev.map((i) => (i.id === id ? { ...i, status: stageId } : i)));
      try {
        await updateCloudActionItemStatus(id, stageId);
      } catch {
        setAssigned((prev) => prev.map((i) => (i.id === id ? item : i)));
      }
      return;
    }
    const item = items.find((i) => i.id === id);
    if (!item || item.status === stageId) return;
    const updated = await patchLocal(item, { status: stageId });
    // Completions are team news in shared folders.
    if (updated && user && terminal && updated.project_id) {
      myActorName(user.id)
        .then((name) =>
          pushNotification({
            actorId: user.id,
            actorName: name,
            projectId: updated.project_id,
            kind: "task_done",
            title: `${name} completed a task`,
            body: updated.title,
            meetingId: updated.meeting_id,
          }),
        )
        .catch(() => {});
    }
  };

  const setDue = (item: ActionItem, due: string | null) => void patchLocal(item, { due });

  const reassign = (item: ActionItem, next: AssigneeValue) => void patchLocal(item, next);

  const remove = async (id: string) => {
    const before = items;
    setItems((prev) => prev.filter((i) => i.id !== id));
    try {
      await deleteActionItem(id);
      if (user) void deleteCloudActionItem(id);
    } catch {
      setItems(before);
    }
  };

  /** Manually add a task (attached to a meeting) straight into a column.
   * Throws so the composer can surface the error and stay open. */
  const addTask = async (input: {
    meetingId: string;
    title: string;
    status: string;
    due: string | null;
  }) => {
    const created = await addActionItem({
      meeting_id: input.meetingId,
      title: input.title.trim(),
      assignee_name: null,
      assignee_uid: null,
      due: input.due,
      status: input.status,
    });
    setItems((prev) => [created, ...prev]);
    trackEvent("task_created", { source: "tasks_view" });
    if (user) pushActionItem(user.id, created).catch(() => {});
  };

  return (
    <div className="flex h-full flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-6 py-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight">Tasks</h1>
          <p className="text-sm text-muted-foreground">
            Approved action items from all meetings —{" "}
            {IS_MOBILE ? "set each card's status to move it." : "drag cards between columns."}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={folderFilter}
            onChange={(e) => setFolderFilter(e.target.value)}
            className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
            title="Filter by folder"
          >
            <option value="">All folders</option>
            {flattenProjectTree(projects).map(({ project, depth }) => (
              <option key={project.id} value={project.id}>
                {" ".repeat(depth * 3)}
                {project.name}
              </option>
            ))}
          </select>
          <select
            value={assigneeFilter}
            onChange={(e) => setAssigneeFilter(e.target.value)}
            className="h-8 rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
            title="Filter by assignee"
          >
            <option value="">Everyone</option>
            <option value="unassigned">Unassigned</option>
            {assignees.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
          <button
            onClick={() => setEditingStages(true)}
            className="flex h-8 items-center gap-1.5 rounded-[var(--radius)] border border-border bg-card px-2.5 text-sm text-muted-foreground hover:text-foreground"
            title="Add, rename or reorder columns"
          >
            <Settings2 className="h-4 w-4" />
            Columns
          </button>
          <button
            onClick={() => setAddingTask(true)}
            disabled={meetings.length === 0}
            className="flex h-8 items-center gap-1.5 rounded-[var(--radius)] bg-primary px-2.5 text-sm font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-50"
            title={meetings.length === 0 ? "Record or import a meeting first" : "Add a task"}
          >
            <Plus className="h-4 w-4" />
            Add task
          </button>
        </div>
      </header>

      {all.length === 0 ? (
        <div className="flex flex-1 items-center justify-center p-6">
          <EmptyState
            title="No tasks yet"
            body={
              <>
                Tasks are the action items Lalela pulls from your meeting notes.
                Open a meeting → <span className="font-medium">Action items</span> →
                Generate, then approve the ones that matter — they land on this board.
              </>
            }
          />
        </div>
      ) : (
        <div
          className={cn(
            "flex-1 overflow-y-auto p-4",
            // Mobile: columns stack vertically (a multi-col drag board is
            // unusable on a phone). Desktop: a column grid sized to the stages.
            IS_MOBILE ? "flex flex-col gap-3" : "grid gap-4",
          )}
          style={
            IS_MOBILE
              ? undefined
              : { gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }
          }
        >
          {stages.map((col) => {
            const colItems = visible.filter(
              (i) => stageForStatus(i.status, stages).id === col.id,
            );
            // Drag-to-move is desktop-only; mobile moves via the per-card status
            // dropdown, so the column drop target is inert on touch.
            const dndProps = IS_MOBILE
              ? {}
              : {
                  onDragOver: (e: React.DragEvent) => {
                    if (e.dataTransfer.types.includes(DND_TASK)) {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOver(col.id);
                    }
                  },
                  onDragLeave: () => setDragOver((d) => (d === col.id ? null : d)),
                  onDrop: (e: React.DragEvent) => {
                    // Without preventDefault WebKit cancels the drop entirely.
                    e.preventDefault();
                    const id = e.dataTransfer.getData(DND_TASK);
                    setDragOver(null);
                    if (id) void move(id, col.id);
                  },
                };
            return (
              <div
                key={col.id}
                {...dndProps}
                className={cn(
                  "flex flex-col rounded-[var(--radius)] border border-border bg-surface",
                  !IS_MOBILE && "min-h-0",
                  dragOver === col.id && "ring-1 ring-accent",
                )}
              >
                <div className="flex items-center justify-between border-b border-border px-3 py-2">
                  <span className="text-sm font-semibold">{col.title}</span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                    {colItems.length}
                  </span>
                </div>
                <div className="flex-1 space-y-2 overflow-y-auto p-2">
                  {colItems.map((item) => {
                    const remote = isRemote(item.id);
                    const overdue = isTaskOverdue(item.due, item.status);
                    const isDate = /^\d{4}-\d{2}-\d{2}$/.test((item.due ?? "").trim());
                    const members = membersByProject[item.project_id ?? ""] ?? [];
                    return (
                      <div
                        key={item.id}
                        draggable={!IS_MOBILE && editingId !== item.id}
                        onDragStart={(e) => {
                          if (IS_MOBILE) return;
                          e.dataTransfer.setData(DND_TASK, item.id);
                          e.dataTransfer.effectAllowed = "move";
                        }}
                        className={cn(
                          "group rounded-[var(--radius)] border bg-card p-3",
                          overdue ? "border-danger/60" : "border-border",
                          !IS_MOBILE && editingId !== item.id && "cursor-grab active:cursor-grabbing",
                        )}
                      >
                        <div className="flex items-start gap-2">
                          {remote ? (
                            <p
                              className={cn(
                                "min-w-0 flex-1 text-sm",
                                col.terminal && "text-muted-foreground line-through",
                              )}
                            >
                              {item.title}
                            </p>
                          ) : (
                            <EditableTitle
                              value={item.title}
                              onSave={(next) => void patchLocal(item, { title: next })}
                              onEditingChange={(editing) =>
                                setEditingId(editing ? item.id : null)
                              }
                              className={cn(
                                "min-w-0 flex-1 text-sm",
                                col.terminal && "text-muted-foreground line-through",
                              )}
                            />
                          )}
                          {!remote && (
                            <button
                              onClick={() => void remove(item.id)}
                              className={cn(
                                "rounded p-0.5 text-muted-foreground hover:text-danger",
                                // No hover on touch — keep delete always visible.
                                IS_MOBILE
                                  ? "opacity-100"
                                  : "opacity-0 transition-opacity group-hover:opacity-100",
                              )}
                              title="Delete task"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </div>

                        {/* Assignee: editable for owned tasks, a pill for shared. */}
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          {remote ? (
                            <>
                              <span
                                className="flex items-center gap-1 rounded-full bg-primary/15 px-2 py-0.5 text-[11px]"
                                title="Assigned to you from someone else's meeting"
                              >
                                <Users className="h-3 w-3" />
                                shared
                              </span>
                              {item.assignee_name && (
                                <span className="flex items-center gap-1 rounded-full bg-accent/15 px-2 py-0.5 text-[11px] text-foreground">
                                  <User className="h-3 w-3" />
                                  {item.assignee_name}
                                </span>
                              )}
                            </>
                          ) : (
                            <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
                              <User className="h-3 w-3 shrink-0" />
                              <AssigneeCombobox
                                assigneeName={item.assignee_name}
                                assigneeUid={item.assignee_uid}
                                members={members}
                                usedNames={assignees}
                                onChange={(next) => reassign(item, next)}
                                triggerClassName="h-6 w-[9rem] px-1.5 text-[11px]"
                              />
                            </span>
                          )}
                        </div>

                        {/* Due date: editable for owned tasks, a pill for shared. */}
                        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                          {remote ? (
                            item.due && (
                              <span
                                className={cn(
                                  "flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]",
                                  overdue
                                    ? "bg-danger/15 text-danger"
                                    : "bg-muted text-muted-foreground",
                                )}
                              >
                                <CalendarClock className="h-3 w-3" />
                                {item.due}
                              </span>
                            )
                          ) : (
                            <span className="flex items-center gap-1">
                              <CalendarClock
                                className={cn(
                                  "h-3 w-3",
                                  overdue ? "text-danger" : "text-muted-foreground",
                                )}
                              />
                              <input
                                type="date"
                                value={isDate ? (item.due as string).trim() : ""}
                                onChange={(e) => setDue(item, e.target.value || null)}
                                className={cn(
                                  "h-6 rounded-[var(--radius)] border bg-card px-1 text-[11px]",
                                  overdue ? "border-danger text-danger" : "border-border",
                                )}
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
                          )}
                          <button
                            onClick={async () => {
                              // A shared task's meeting may not be local yet.
                              if (remote) {
                                try {
                                  await importSharedMeeting(item.meeting_id);
                                } catch {
                                  return; // not shared with me / offline
                                }
                              }
                              onOpenMeeting(item.meeting_id);
                            }}
                            className="flex min-w-0 items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
                            title={`Open ${item.meeting_title}${projectName(item.project_id) ? ` (${projectName(item.project_id)})` : ""}`}
                          >
                            <FileText className="h-3 w-3 shrink-0" />
                            <span className="max-w-36 truncate">{item.meeting_title}</span>
                          </button>
                        </div>

                        {/* Touch can't drag between columns — move via a dropdown. */}
                        {IS_MOBILE && (
                          <select
                            value={stageForStatus(item.status, stages).id}
                            onChange={(e) => void move(item.id, e.target.value)}
                            aria-label="Change status"
                            className="mt-2 h-8 w-full rounded-[var(--radius)] border border-border bg-card px-2 text-xs"
                          >
                            {stages.map((s) => (
                              <option key={s.id} value={s.id}>
                                {s.title}
                              </option>
                            ))}
                          </select>
                        )}
                      </div>
                    );
                  })}
                  {colItems.length === 0 && (
                    <p className="px-2 py-4 text-center text-xs text-muted-foreground">
                      {IS_MOBILE ? "Nothing here." : "Drop cards here"}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editingStages && (
        <StageEditor
          stages={stages}
          onSave={(next) => {
            persistStages(next);
            setEditingStages(false);
          }}
          onClose={() => setEditingStages(false)}
        />
      )}

      {addingTask && (
        <TaskComposer
          meetings={meetings}
          projects={projects}
          stages={stages}
          onAdd={addTask}
          onClose={() => setAddingTask(false)}
        />
      )}
    </div>
  );
}

/** Compose a manual task: pick the meeting it belongs to, a column and an
 * optional due date. Lands on the board immediately (and syncs to the cloud). */
function TaskComposer({
  meetings,
  projects,
  stages,
  onAdd,
  onClose,
}: {
  meetings: MeetingMeta[];
  projects: Project[];
  stages: TaskStage[];
  onAdd: (input: {
    meetingId: string;
    title: string;
    status: string;
    due: string | null;
  }) => Promise<void>;
  onClose: () => void;
}) {
  const sorted = useMemo(
    () => [...meetings].sort((a, b) => b.created_at - a.created_at),
    [meetings],
  );
  const [meetingId, setMeetingId] = useState(sorted[0]?.id ?? "");
  const [title, setTitle] = useState("");
  const [status, setStatus] = useState(stages[0]?.id ?? "approved");
  const [due, setDue] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const projectName = (id: string | null) => projects.find((p) => p.id === id)?.name ?? null;

  const submit = async () => {
    const t = title.trim();
    if (!t || !meetingId || busy) return;
    setBusy(true);
    setErr(null);
    try {
      await onAdd({ meetingId, title: t, status, due: due || null });
      onClose();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-[var(--radius)] border border-border bg-background p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Add a task</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Tasks belong to a meeting — pick which one this relates to. It lands on
          the board straight away; set an assignee on the card after.
        </p>

        <div className="mt-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Task</label>
            <input
              autoFocus
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void submit();
                }
              }}
              placeholder="What needs doing?"
              className="mt-1 h-9 w-full rounded-[var(--radius)] border border-border bg-card px-3 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Meeting</label>
            <select
              value={meetingId}
              onChange={(e) => setMeetingId(e.target.value)}
              className="mt-1 h-9 w-full rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
            >
              {sorted.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.title}
                  {projectName(m.project_id) ? ` — ${projectName(m.project_id)}` : ""}
                </option>
              ))}
            </select>
          </div>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground">Column</label>
              <select
                value={status}
                onChange={(e) => setStatus(e.target.value)}
                className="mt-1 h-9 w-full rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
              >
                {stages.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="text-xs font-medium text-muted-foreground">Due (optional)</label>
              <input
                type="date"
                value={due}
                onChange={(e) => setDue(e.target.value)}
                className="mt-1 h-9 w-full rounded-[var(--radius)] border border-border bg-card px-2 text-sm"
              />
            </div>
          </div>
          {err && <p className="text-xs text-danger">{err}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-[var(--radius)] border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={() => void submit()}
            disabled={!title.trim() || !meetingId || busy}
            className="flex items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:brightness-110 disabled:opacity-50"
          >
            <Plus className="h-4 w-4" />
            Add task
          </button>
        </div>
      </div>
    </div>
  );
}

/** Add / rename / reorder / delete the board's working columns. The terminal
 * "Done" stage is fixed (rename only) and always sits last. */
function StageEditor({
  stages,
  onSave,
  onClose,
}: {
  stages: TaskStage[];
  onSave: (stages: TaskStage[]) => void;
  onClose: () => void;
}) {
  // Split off the fixed terminal stage; only the working ones are editable.
  const [working, setWorking] = useState<TaskStage[]>(
    stages.filter((s) => !s.terminal).map((s) => ({ ...s })),
  );
  const [doneTitle, setDoneTitle] = useState(
    stages.find((s) => s.terminal)?.title ?? "Done",
  );

  const rename = (id: string, title: string) =>
    setWorking((w) => w.map((s) => (s.id === id ? { ...s, title } : s)));
  const removeStage = (id: string) => setWorking((w) => w.filter((s) => s.id !== id));
  const swap = (i: number, j: number) =>
    setWorking((w) => {
      if (j < 0 || j >= w.length) return w;
      const next = [...w];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const addStage = () =>
    setWorking((w) => [...w, { id: newStageId(), title: "New column" }]);

  const save = () => {
    const cleaned = working
      .map((s) => ({ ...s, title: s.title.trim() || "Untitled" }))
      .filter((s) => s.id);
    onSave([...cleaned, { id: "done", title: doneTitle.trim() || "Done", terminal: true }]);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-[var(--radius)] border border-border bg-background p-5 shadow-xl">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold">Board columns</h3>
          <button
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Add, rename or reorder your working columns. Tasks in a deleted column
          move back to the first column. Cloud sync tracks the standard To
          do / In progress / Done lifecycle.
        </p>

        <div className="mt-4 space-y-2">
          {working.map((s, i) => (
            <div key={s.id} className="flex items-center gap-1.5">
              <div className="flex flex-col">
                <button
                  onClick={() => swap(i, i - 1)}
                  disabled={i === 0}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  title="Move up"
                >
                  ▲
                </button>
                <button
                  onClick={() => swap(i, i + 1)}
                  disabled={i === working.length - 1}
                  className="text-muted-foreground hover:text-foreground disabled:opacity-30"
                  title="Move down"
                >
                  ▼
                </button>
              </div>
              <input
                value={s.title}
                onChange={(e) => rename(s.id, e.target.value)}
                className="h-8 flex-1 rounded-[var(--radius)] border border-border bg-card px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
              />
              <button
                onClick={() => removeStage(s.id)}
                disabled={working.length === 1}
                className="rounded p-1.5 text-muted-foreground hover:text-danger disabled:opacity-30"
                title={working.length === 1 ? "Keep at least one column" : "Delete column"}
              >
                <Trash2 className="h-4 w-4" />
              </button>
            </div>
          ))}

          <button
            onClick={addStage}
            className="flex items-center gap-1.5 rounded-[var(--radius)] border border-dashed border-border px-2.5 py-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <Plus className="h-4 w-4" />
            Add column
          </button>

          <div className="mt-3 border-t border-border pt-3">
            <label className="text-xs font-medium text-muted-foreground">
              Terminal column (crosses tasks out)
            </label>
            <input
              value={doneTitle}
              onChange={(e) => setDoneTitle(e.target.value)}
              className="mt-1 h-8 w-full rounded-[var(--radius)] border border-border bg-card px-2 text-sm outline-none focus:ring-2 focus:ring-ring"
            />
          </div>
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-[var(--radius)] border border-border px-3 py-1.5 text-sm hover:bg-muted"
          >
            Cancel
          </button>
          <button
            onClick={save}
            className="flex items-center gap-1.5 rounded-[var(--radius)] bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:brightness-110"
          >
            <Check className="h-4 w-4" />
            Save columns
          </button>
        </div>
      </div>
    </div>
  );
}
