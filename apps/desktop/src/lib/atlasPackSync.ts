// Pure merge plan for mirroring a meeting's local action items to the cloud
// before an Atlas-pack send (no imports — unit-tested with `node --test`).
//
// The cloud row is authoritative for workflow state: an ASSIGNEE moves a task
// on their board by writing `status` to the cloud only (TasksView remote move),
// so the owner's local copy can hold a stale status. Therefore:
//   - rows missing in the cloud are INSERTED in full (offline approvals);
//   - rows already in the cloud only get CONTENT columns (title, due,
//     meeting_title, project_id) patched when they differ — status and
//     assignee fields are never overwritten.

export interface LocalActionItem {
  id: string;
  meeting_id: string;
  project_id: string | null;
  title: string;
  assignee_name: string | null;
  assignee_uid: string | null;
  status: string;
  due: string | null;
  meeting_title: string;
}

export interface CloudActionItemContent {
  id: string;
  title: string | null;
  due: string | null;
  meeting_title: string | null;
  project_id: string | null;
}

export type ContentPatch = Partial<Pick<LocalActionItem, "title" | "due" | "meeting_title" | "project_id">>;

export interface ActionItemSyncPlan {
  inserts: (LocalActionItem & { owner_id: string })[];
  contentUpdates: { id: string; patch: ContentPatch }[];
}

const CONTENT_KEYS = ["title", "due", "meeting_title", "project_id"] as const;

/** `local` = the meeting's non-suggested local items; `cloud` = the content
 * columns of the meeting's cloud rows. */
export function planActionItemSync(
  ownerId: string,
  local: LocalActionItem[],
  cloud: CloudActionItemContent[],
): ActionItemSyncPlan {
  const byId = new Map(cloud.map((c) => [c.id, c]));
  const plan: ActionItemSyncPlan = { inserts: [], contentUpdates: [] };
  for (const item of local) {
    const remote = byId.get(item.id);
    if (!remote) {
      plan.inserts.push({ ...item, owner_id: ownerId });
      continue;
    }
    const patch: ContentPatch = {};
    for (const k of CONTENT_KEYS) {
      if ((remote[k] ?? null) !== (item[k] ?? null)) patch[k] = item[k] as never;
    }
    if (Object.keys(patch).length > 0) plan.contentUpdates.push({ id: item.id, patch });
  }
  return plan;
}
