import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Download, X, Loader2, AlertTriangle } from "lucide-react";
import {
  checkForUpdateDetailed,
  installAndRelaunch,
  recordUpdateCheck,
  UPDATE_ERROR_AFTER_FAILURES,
  type Update,
} from "@/lib/updater";
import { IS_STORE_BUILD } from "@/lib/distribution";

type State =
  | { kind: "idle" }
  | { kind: "available"; update: Update }
  | { kind: "downloading"; pct: number | null }
  /** The check itself failed (dead feed, offline, bad manifest) — shown only
   * after repeated failures, and never blocking. */
  | { kind: "check-error"; message: string }
  /** Downloading/installing an update that WAS found failed. */
  | { kind: "error"; message: string };

/** How often to look for a new build while the app stays open. */
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000; // 4 hours
/** "Later" snoozes that version for this long; a newer version shows straight away. */
const REMIND_AFTER_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Bottom-right pop-up that appears when a newer signed build is available.
 * Checks shortly after mount, then every few hours for as long as the app is
 * open (plus on window focus — interval timers are throttled while hidden and
 * paused during sleep, so focus is the catch-up trigger). On confirm,
 * downloads + installs + relaunches.
 *
 * A check that fails is NOT silence: after {@link UPDATE_ERROR_AFTER_FAILURES}
 * consecutive failures (counted across launches, so one flaky-wifi check stays
 * quiet) the same card reports that the check itself is broken, with a Retry.
 * Without this a dead update feed looks exactly like "you're up to date", and
 * everyone stays stranded on whatever build they first installed.
 * Self-contained — render it once. */
export function UpdateBanner() {
  const [state, setState] = useState<State>({ kind: "idle" });
  const snoozeRef = useRef<{ version: string; at: number } | null>(null);
  const downloadingRef = useRef(false);
  // "Couldn't check" is non-blocking: dismissing it silences it for this run,
  // and it comes back on the next launch if the feed is still broken.
  const errorDismissedRef = useRef(false);
  const lastCheckRef = useRef(0);

  useEffect(() => {
    // The Microsoft Store build has no updater config at all (it is stripped by
    // tauri.store.conf.json), so a check would throw and there would be nothing
    // to offer if it didn't — the Store delivers updates itself.
    if (IS_STORE_BUILD) return;

    let cancelled = false;

    const runCheck = async () => {
      if (downloadingRef.current) return; // never interrupt an install
      lastCheckRef.current = Date.now();
      const result = await checkForUpdateDetailed();
      if (cancelled) return;
      const failures = recordUpdateCheck(result);
      if (result.status === "error") {
        if (failures >= UPDATE_ERROR_AFTER_FAILURES && !errorDismissedRef.current)
          setState((s) =>
            s.kind === "downloading" || s.kind === "available"
              ? s
              : { kind: "check-error", message: result.message },
          );
        return;
      }
      // The feed answered — clear any stale "couldn't check" card.
      setState((s) => (s.kind === "check-error" ? { kind: "idle" } : s));
      if (result.status === "current") return;
      const update = result.update;
      const snooze = snoozeRef.current;
      if (
        snooze &&
        snooze.version === update.version &&
        Date.now() - snooze.at < REMIND_AFTER_MS
      )
        return;
      setState((s) => (s.kind === "downloading" ? s : { kind: "available", update }));
    };

    // Small delay so the first check doesn't compete with first paint.
    const t = setTimeout(runCheck, 3000);
    const interval = setInterval(runCheck, CHECK_EVERY_MS);
    const onFocus = () => {
      if (Date.now() - lastCheckRef.current >= CHECK_EVERY_MS) void runCheck();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      clearTimeout(t);
      clearInterval(interval);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  if (state.kind === "idle") return null;

  const dismiss = () => {
    if (state.kind === "available")
      snoozeRef.current = { version: state.update.version, at: Date.now() };
    if (state.kind === "check-error") errorDismissedRef.current = true;
    setState({ kind: "idle" });
  };

  const retryCheck = async () => {
    setState({ kind: "idle" });
    lastCheckRef.current = Date.now();
    const result = await checkForUpdateDetailed();
    recordUpdateCheck(result);
    if (result.status === "available") setState({ kind: "available", update: result.update });
    else if (result.status === "error") setState({ kind: "check-error", message: result.message });
  };

  const onUpdate = async () => {
    if (state.kind !== "available") return;
    const u = state.update;
    downloadingRef.current = true;
    setState({ kind: "downloading", pct: null });
    try {
      await installAndRelaunch(u, (d, total) => {
        setState({ kind: "downloading", pct: total ? Math.round((d / total) * 100) : null });
      });
      // relaunch() replaces the process — nothing below runs on success.
    } catch (e) {
      downloadingRef.current = false;
      setState({ kind: "error", message: String(e) });
    }
  };

  const downloading = state.kind === "downloading";

  return (
    <div className="fixed bottom-5 right-5 z-[60] w-80 rounded-[var(--radius)] border border-border bg-card p-4 shadow-lg">
      {!downloading && (
        <button
          onClick={dismiss}
          className="absolute right-2 top-2 text-muted-foreground hover:text-foreground"
          title="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      )}
      <div className="flex items-start gap-3">
        <div
          className={
            state.kind === "check-error"
              ? "mt-0.5 rounded-full bg-warning/10 p-2 text-warning"
              : "mt-0.5 rounded-full bg-accent/10 p-2 text-accent"
          }
        >
          {downloading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : state.kind === "check-error" ? (
            <AlertTriangle className="h-4 w-4" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </div>
        <div className="min-w-0">
          {state.kind === "available" && (
            <>
              <p className="text-sm font-semibold">Update available</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Lalela {state.update.version} is ready to install.
                {state.update.body ? ` ${state.update.body}` : ""}
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={onUpdate}>
                  Update &amp; restart
                </Button>
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  Later
                </Button>
              </div>
            </>
          )}
          {state.kind === "downloading" && (
            <>
              <p className="text-sm font-semibold">Updating…</p>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {state.pct === null ? "Downloading…" : `Downloading ${state.pct}%`} — Lalela will
                restart automatically.
              </p>
            </>
          )}
          {state.kind === "check-error" && (
            <>
              <p className="text-sm font-semibold">Couldn't check for updates</p>
              <p className="mt-0.5 break-words text-xs text-muted-foreground">
                {state.message} Lalela can't tell whether a newer version exists, so it may not
                be up to date.
              </p>
              <div className="mt-3 flex gap-2">
                <Button size="sm" onClick={retryCheck}>
                  Retry
                </Button>
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  Dismiss
                </Button>
              </div>
            </>
          )}
          {state.kind === "error" && (
            <>
              <p className="text-sm font-semibold">Update failed</p>
              <p className="mt-0.5 break-words text-xs text-muted-foreground">{state.message}</p>
              <div className="mt-3">
                <Button variant="ghost" size="sm" onClick={dismiss}>
                  Dismiss
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
