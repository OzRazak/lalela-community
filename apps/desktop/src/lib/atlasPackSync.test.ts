import assert from "node:assert/strict";
import test from "node:test";

import { planActionItemSync, type LocalActionItem } from "./atlasPackSync.ts";

// Run via `pnpm --filter @lalela/desktop test` (Node strips the types natively).

const item = (over: Partial<LocalActionItem> = {}): LocalActionItem => ({
  id: "a1",
  meeting_id: "m1",
  project_id: "p1",
  title: "Ship it",
  assignee_name: "Ann",
  assignee_uid: "u-ann",
  status: "approved",
  due: "Friday",
  meeting_title: "Sync",
  ...over,
});

test("rows missing in the cloud are inserted in full with the owner id", () => {
  const plan = planActionItemSync("owner", [item()], []);
  assert.deepEqual(plan.inserts, [{ ...item(), owner_id: "owner" }]);
  assert.deepEqual(plan.contentUpdates, []);
});

test("existing rows never get status or assignee written back (assignee moved it)", () => {
  // Local copy is stale ("approved"); the assignee marked it done in the cloud.
  const plan = planActionItemSync("owner", [item({ status: "approved", assignee_name: "Old" })], [
    { id: "a1", title: "Ship it", due: "Friday", meeting_title: "Sync", project_id: "p1" },
  ]);
  assert.deepEqual(plan, { inserts: [], contentUpdates: [] });
});

test("content edits on existing rows patch only the changed content columns", () => {
  const plan = planActionItemSync("owner", [item({ title: "Ship v2", due: null })], [
    { id: "a1", title: "Ship it", due: "Friday", meeting_title: "Sync", project_id: "p1" },
  ]);
  assert.deepEqual(plan.inserts, []);
  assert.deepEqual(plan.contentUpdates, [{ id: "a1", patch: { title: "Ship v2", due: null } }]);
  const keys = Object.keys(plan.contentUpdates[0].patch);
  assert.ok(!keys.includes("status") && !keys.includes("assignee_uid") && !keys.includes("assignee_name"));
});

test("mixed: one insert, one untouched", () => {
  const plan = planActionItemSync("o", [item({ id: "new" }), item()], [
    { id: "a1", title: "Ship it", due: "Friday", meeting_title: "Sync", project_id: "p1" },
  ]);
  assert.deepEqual(plan.inserts.map((i) => i.id), ["new"]);
  assert.deepEqual(plan.contentUpdates, []);
});
