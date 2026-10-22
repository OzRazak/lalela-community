// Apple Watch → iPhone sync visibility + manual trigger (mobile only).
//
// The watch records discreetly and hands each recording to the phone over
// WatchConnectivity, which delivers opportunistically. That pipeline is
// invisible today: a recording can be queued on the wrist, in transit, or
// importing on the phone with no surface to see it — and, before this, a file
// arriving while the app was open only appeared after a relaunch.
//
// This gives the "Uber-map" surety Oz asked for after a conference device test:
//   • a status pill — "Importing from Watch… (i/N)" while a drain runs, then
//     "N recording(s) on your Watch, waiting to sync" while the wrist still
//     holds some — hidden entirely when there is nothing to report;
//   • an always-available "Sync from Watch" control that drains the inbox on
//     demand and gives transient feedback.
//
// State comes from three Rust events (see lib/lalela.ts): `watch://scan` (drain
// progress), `watch://pending` (the wrist's waiting count, relayed from the
// watch's WatchConnectivity application context), and the `scan_watch_inbox`
// command's return value (count found on the phone right now).

import { useEffect, useRef, useState } from "react";
import { Watch, RefreshCw, Loader2 } from "lucide-react";
import { onWatchScan, onWatchPending, scanWatchInbox } from "@/lib/lalela";

export function WatchSync() {
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState<{ index: number; total: number } | null>(null);
  const [pendingOnWatch, setPendingOnWatch] = useState(0);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const toastTimer = useRef<number | null>(null);
  // Read the latest pending count inside the async tap handler without making
  // it a dependency (avoids re-binding the handler on every count change).
  const pendingRef = useRef(0);
  useEffect(() => {
    pendingRef.current = pendingOnWatch;
  }, [pendingOnWatch]);

  useEffect(() => {
    const subs = [
      onWatchScan((e) => {
        if (typeof e.found === "number") {
          // Start of a drain pass. found:0 (a bare launch/foreground scan) just
          // clears any stale importing state.
          if (e.found > 0) {
            setScanning(true);
            setProgress({ index: 0, total: e.found });
          } else {
            setScanning(false);
            setProgress(null);
          }
        } else if (typeof e.importing === "string") {
          setScanning(true);
          setProgress({ index: e.index ?? 0, total: e.total ?? 0 });
        } else if (typeof e.imported === "number") {
          setScanning(false);
          setProgress(null);
        }
      }),
      onWatchPending((count) => setPendingOnWatch(count)),
    ];
    return () => subs.forEach((p) => p.then((un) => un()));
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 4000);
  };

  const sync = async () => {
    setBusy(true);
    try {
      const found = await scanWatchInbox();
      if (found > 0) {
        showToast(`Importing ${found} recording${found === 1 ? "" : "s"}…`);
      } else if (pendingRef.current > 0) {
        showToast(
          `${pendingRef.current} still on your Watch — keep both apps open to speed up transfer`,
        );
      } else {
        showToast("Nothing waiting on the phone yet");
      }
    } catch {
      showToast("Couldn't reach the Watch inbox");
    } finally {
      setBusy(false);
    }
  };

  const active = scanning || pendingOnWatch > 0 || toast !== null;

  // Idle: the status pill is hidden; only the quiet manual trigger remains.
  if (!active) {
    return (
      <div className="flex justify-end px-4 pt-2">
        <button
          onClick={sync}
          disabled={busy}
          className="flex items-center gap-1.5 rounded-full px-2 py-1 text-xs text-muted-foreground active:scale-95 disabled:opacity-60"
          title="Pull any recordings waiting from your Apple Watch"
        >
          {busy ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Watch className="h-3.5 w-3.5" />
          )}
          Sync from Watch
        </button>
      </div>
    );
  }

  const statusText = scanning
    ? `Importing from Watch…${
        progress && progress.total > 0 && progress.index > 0
          ? ` (${progress.index}/${progress.total})`
          : ""
      }`
    : pendingOnWatch > 0
      ? `${pendingOnWatch} recording${pendingOnWatch === 1 ? "" : "s"} on your Watch, waiting to sync`
      : (toast ?? "");

  return (
    <div className="mx-4 mt-2 flex items-center gap-2 rounded-[var(--radius)] border border-border bg-muted/50 px-3 py-2 text-xs">
      {scanning || busy ? (
        <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-primary" />
      ) : (
        <Watch className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-foreground">{statusText}</span>
      <button
        onClick={sync}
        disabled={busy}
        className="flex shrink-0 items-center gap-1 rounded-full border border-border bg-card px-2.5 py-1 font-medium text-foreground active:scale-95 disabled:opacity-60"
        title="Pull any recordings waiting from your Apple Watch"
      >
        <RefreshCw className="h-3 w-3" />
        Sync
      </button>
    </div>
  );
}
