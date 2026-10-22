// One per-meeting serial queue for EVERY cloud write that can change a
// meeting's folder: full meeting pushes (sync.ts pushMeeting, used by hand
// moves, the meeting view, saves) and auto-sort's light folder writes
// (autoSort.ts). Writes for the same meeting land in the order they were
// issued, and auto-sort's queued write re-reads the local folder when its turn
// comes — so a hand move made after an auto-file always lands last in the
// cloud. Pure + dependency-free apart from the queue factory.
import { createKeyedQueue } from "./autoSortCore.ts";

export const meetingCloudQueue = createKeyedQueue();

// ── Delete fencing ───────────────────────────────────────────────────────
// A cloud write queued BEFORE a delete must not run after it (a queued row
// upsert would resurrect the meeting; an image/notes write would orphan data).
// Each meeting has a generation, bumped synchronously by delete. Writers
// capture it when they are REQUESTED and the queued task skips if it moved.
const generations = new Map<string, number>();

export function cloudGeneration(meetingId: string): number {
  return generations.get(meetingId) ?? 0;
}

/** Invalidate every write requested so far for this meeting (call on delete). */
export function bumpCloudGeneration(meetingId: string): void {
  generations.set(meetingId, cloudGeneration(meetingId) + 1);
}

/** Queue `fn` for the meeting, skipping it (resolving `undefined`) if the
 * meeting was deleted since `gen` was captured. */
export function enqueueCloudWrite<T>(
  meetingId: string,
  gen: number,
  fn: () => Promise<T>,
): Promise<T | undefined> {
  return meetingCloudQueue(meetingId, async () =>
    cloudGeneration(meetingId) === gen ? fn() : undefined,
  );
}

/** Default bound for one network-heavy queue turn (e.g. an image upload). */
export const CLOUD_TURN_TIMEOUT_MS = 30_000;

/** Run `fn` with an AbortSignal and a deadline. If the deadline passes first,
 * abort and reject, so the queue turn releases even if `fn` ignores the signal
 * (supabase-js storage.upload takes no signal). A timeout is a best-effort
 * failure - the next sync retries. */
export function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number = CLOUD_TURN_TIMEOUT_MS,
): Promise<T> {
  const ctrl = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      ctrl.abort();
      reject(new Error(`cloud write timed out after ${ms} ms`));
    }, ms);
  });
  return Promise.race([fn(ctrl.signal), deadline]).finally(() => clearTimeout(timer));
}
