// A generic background-task store, kept in a module-level map OUTSIDE any React
// component. A task started under a key keeps running — and stays observable —
// no matter which view is mounted, so a generation the user walked away from
// still completes, persists its result where it belongs, and can be re-attached
// to (as running, then done) when the user returns.
//
// This generalises the T4 pattern that `summaryGen.ts` implements for meeting
// summaries. `ChatThread` uses it so a chat answer whose pane unmounted still
// lands in the right thread and is shown on return, instead of being stranded
// in an unopened History thread. summaryGen stays as its own (already-working)
// store; new detached surfaces should build on this one.

import { useSyncExternalStore } from "react";

export type BgStatus = "idle" | "running" | "done" | "error";

export interface BgState<T = unknown, M = unknown> {
  status: BgStatus;
  /** Describes the in-flight run (set when it starts), e.g. the chat question —
   * so a remount can show what's pending before the result arrives. */
  meta?: M;
  /** The completed result — retained so a returning view can adopt it even if
   * it mounted after the task finished. */
  result?: T;
  error?: string;
}

const IDLE: BgState = { status: "idle" };

const store = new Map<string, BgState>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

/** Stable snapshot: the same object reference until `set` replaces it, so
 * `useSyncExternalStore` doesn't loop. */
function snapshot(key: string): BgState {
  return store.get(key) ?? IDLE;
}

function set(key: string, next: BgState): void {
  store.set(key, next);
  emit();
}

/** True while a task for this key is in flight. */
export function isBgRunning(key: string): boolean {
  return snapshot(key).status === "running";
}

export interface StartBgOpts<T, M> {
  /** Describes the run for a mid-flight remount (e.g. the chat question). */
  meta?: M;
  /** The work. Runs detached from any view; must persist its own result so a
   * completion whose view unmounted isn't lost. */
  run: () => Promise<T>;
  /** Runs on success, even if the starting view has unmounted. */
  onSuccess?: (result: T) => Promise<void> | void;
  /** Runs on failure (mount-independent; mounted views also see `status`). */
  onError?: (e: unknown) => void;
}

/** Start a detached task under `key`. If one is already in flight for this key
 * it's a no-op, so a remount or a stray double-click can't stack runs. */
export async function startBgTask<T, M = unknown>(
  key: string,
  opts: StartBgOpts<T, M>,
): Promise<void> {
  if (isBgRunning(key)) return;
  set(key, { status: "running", meta: opts.meta });
  try {
    const result = await opts.run();
    set(key, { status: "done", meta: opts.meta, result });
    await opts.onSuccess?.(result);
  } catch (e) {
    set(key, {
      status: "error",
      meta: opts.meta,
      error: e instanceof Error ? e.message : String(e),
    });
    opts.onError?.(e);
  }
}

/** Drop a task's state back to idle once a view has adopted its result, so a
 * later mount doesn't re-adopt a stale completion. */
export function clearBgTask(key: string): void {
  if (store.has(key)) {
    store.delete(key);
    emit();
  }
}

/** Subscribe a component to one task's state. */
export function useBgTask<T = unknown, M = unknown>(key: string): BgState<T, M> {
  return useSyncExternalStore(
    subscribe,
    () => snapshot(key) as BgState<T, M>,
    () => snapshot(key) as BgState<T, M>,
  );
}
