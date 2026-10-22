import assert from "node:assert/strict";
import test from "node:test";

import {
  bumpCloudGeneration,
  cloudGeneration,
  enqueueCloudWrite,
  withTimeout,
} from "./meetingCloudQueue.ts";

const tick = () => new Promise((r) => setTimeout(r, 5));

test("image/notes writes for one meeting run in issue order behind a row write", async () => {
  const log: string[] = [];
  const id = "m-order";
  const g = cloudGeneration(id);
  const row = enqueueCloudWrite(id, g, async () => {
    await tick();
    await tick();
    log.push("row");
  });
  const img = enqueueCloudWrite(id, g, async () => {
    log.push("image");
  });
  const notes = enqueueCloudWrite(id, g, async () => {
    log.push("notes");
  });
  await Promise.all([row, img, notes]);
  assert.deepEqual(log, ["row", "image", "notes"]);
});

test("different meetings do not block each other", async () => {
  const log: string[] = [];
  const slow = enqueueCloudWrite("m-a", 0, async () => {
    await tick();
    await tick();
    log.push("a");
  });
  const fast = enqueueCloudWrite("m-b", 0, async () => {
    log.push("b");
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(log, ["b", "a"]);
});

test("delete fences queued row, image and notes writes (no resurrection/orphans)", async () => {
  const log: string[] = [];
  const id = "m-del";
  const g = cloudGeneration(id);
  const inflight = enqueueCloudWrite(id, g, async () => {
    await tick();
    log.push("row");
  });
  const queuedImage = enqueueCloudWrite(id, g, async () => {
    log.push("image");
  });
  const queuedRow = enqueueCloudWrite(id, g, async () => {
    log.push("row2");
  });
  await Promise.resolve(); // let the first write start (it is now in flight)
  // delete, exactly as deleteCloudMeeting does it
  bumpCloudGeneration(id);
  const del = enqueueCloudWrite(id, cloudGeneration(id), async () => {
    log.push("delete");
  });
  await Promise.all([inflight, queuedImage, queuedRow, del]);
  assert.deepEqual(log, ["row", "delete"]);
});

test("writes requested after a delete (re-created meeting) still go out", async () => {
  const id = "m-recreate";
  bumpCloudGeneration(id);
  const log: string[] = [];
  await enqueueCloudWrite(id, cloudGeneration(id), async () => {
    log.push("row");
  });
  assert.deepEqual(log, ["row"]);
});

test("a failing write does not wedge the queue", async () => {
  const id = "m-fail";
  const g = cloudGeneration(id);
  const bad = enqueueCloudWrite(id, g, async () => {
    throw new Error("boom");
  });
  const ok = enqueueCloudWrite(id, g, async () => "ran");
  await assert.rejects(bad);
  assert.equal(await ok, "ran");
});

test("a hung image turn releases the queue after the timeout", async () => {
  const id = "m-hang";
  const g = cloudGeneration(id);
  let aborted = false;
  const hung = enqueueCloudWrite(id, g, () =>
    withTimeout(
      (signal) =>
        new Promise<void>(() => {
          signal.addEventListener("abort", () => (aborted = true));
        }),
      20,
    ),
  );
  const log: string[] = [];
  const next = enqueueCloudWrite(id, g, async () => {
    log.push("next");
  });
  await assert.rejects(hung, /timed out/);
  await next;
  assert.equal(aborted, true);
  assert.deepEqual(log, ["next"]);
});
