// Per-meeting summary-generation state, kept in a module-level store OUTSIDE
// any React component (T4). A generation started for meeting X keeps running
// and stays observable no matter which view is mounted, so MeetingDetailView
// can render instantly and read this meeting's status — it never blocks on a
// generation on its mount path, and navigating away/back never freezes.
//
// Why this exists: local generation runs in the `lalela-llm` sidecar over a
// single NDJSON channel and can take minutes. Previously the generate handler
// tracked progress in the view's own `busy` state, so leaving and re-entering
// the meeting lost that state (no indicator, completed summary missing on
// return). This store detaches generation from the view lifecycle.
//
// Streaming: the sidecar protocol is request → single final response today
// (no partial NDJSON), so `partial` stays unset. The field is kept so a future
// streaming path can feed tokens in without touching callers or the view.

import { aiErrorKind, aiRouteLabel, lastAiCall, modelFamily, trackEvent } from "./analytics";
import { useSyncExternalStore } from "react";

export type SummaryGenStatus = "idle" | "generating" | "done" | "error";

export interface SummaryGenState {
  status: SummaryGenStatus;
  /** Reserved for streamed partial tokens (sidecar doesn't stream yet). */
  partial?: string;
  /** The completed summary — retained so a returning view can adopt it even
   * if it mounted (and read the meeting) before generation finished. */
  summary?: string;
  error?: string;
}

const IDLE: SummaryGenState = { status: "idle" };

const store = new Map<string, SummaryGenState>();
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
function snapshot(meetingId: string): SummaryGenState {
  return store.get(meetingId) ?? IDLE;
}

function set(meetingId: string, next: SummaryGenState): void {
  store.set(meetingId, next);
  emit();
}

/** True while a generation for this meeting is in flight. */
export function isSummaryGenerating(meetingId: string): boolean {
  return snapshot(meetingId).status === "generating";
}

export interface StartSummaryGenOpts {
  /** Produce the summary (e.g. `aiGenerate(...)`). Runs detached from any view. */
  run: () => Promise<string>;
  /** Persist the result once generation succeeds (write to SQLite, etc.).
   * Runs even if the view that started the generation has unmounted. */
  onSuccess?: (summary: string) => Promise<void> | void;
  /** Surface an error to whatever view is mounted (e.g. map NoAiError). */
  onError?: (e: unknown) => void;
}

// "A summary now exists" listeners (auto-sort hooks in here to classify new
// meetings — see autoSort.ts). Fired AFTER onSuccess persisted the summary.
// Listeners are best-effort: one throwing never affects the generation.
type SummaryListener = (meetingId: string, summary: string) => void;
const summaryListeners = new Set<SummaryListener>();

export function onSummaryGenerated(cb: SummaryListener): () => void {
  summaryListeners.add(cb);
  return () => {
    summaryListeners.delete(cb);
  };
}

function notifySummaryGenerated(meetingId: string, summary: string): void {
  for (const l of summaryListeners) {
    try {
      l(meetingId, summary);
    } catch {
      /* best-effort */
    }
  }
}

/** Start a detached generation for `meetingId`. If one is already in flight for
 * this meeting it's a no-op (single sidecar channel — one at a time), so a
 * remount or a stray double-click can't stack generations. */
export async function startSummaryGen(
  meetingId: string,
  opts: StartSummaryGenOpts,
): Promise<void> {
  if (isSummaryGenerating(meetingId)) return;
  set(meetingId, { status: "generating" });
  const job = (async () => {
    try {
      const summary = await opts.run();
      const ai = lastAiCall();
      trackEvent("summary_generated", {
        ai_route: aiRouteLabel(ai?.route),
        model_family: modelFamily(ai?.model),
        success: true,
      });
      set(meetingId, { status: "done", summary });
      await opts.onSuccess?.(summary);
      notifySummaryGenerated(meetingId, summary);
    } catch (e) {
      const ai = lastAiCall();
      trackEvent("summary_generated", {
        ai_route: aiRouteLabel(ai?.route),
        model_family: modelFamily(ai?.model),
        success: false,
        error_kind: aiErrorKind(e),
      });
      set(meetingId, {
        status: "error",
        error: e instanceof Error ? e.message : String(e),
      });
      opts.onError?.(e);
    }
  })();
  inflight.set(meetingId, job);
  try {
    await job;
  } finally {
    if (inflight.get(meetingId) === job) inflight.delete(meetingId);
  }
}

/** In-flight generations (incl. their onSuccess persist), so a background
 * caller — the Atlas-pack "ready" trigger — can wait for a generation the
 * meeting view already started instead of starting a second one. */
const inflight = new Map<string, Promise<void>>();

/** Resolve once this meeting's in-flight generation (and its persist) has
 * finished; immediately when none is running. Never rejects. */
export function awaitSummaryGen(meetingId: string): Promise<SummaryGenState> {
  const job = inflight.get(meetingId);
  return (job ?? Promise.resolve()).then(() => snapshot(meetingId));
}

/** Subscribe a component to one meeting's generation state. */
export function useSummaryGen(meetingId: string): SummaryGenState {
  return useSyncExternalStore(
    subscribe,
    () => snapshot(meetingId),
    () => snapshot(meetingId),
  );
}
