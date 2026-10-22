// Wave C1: feed the next few calendar events into the macOS menu-bar tray.
//
// When signed into Microsoft, poll the calendar (now → +24h, first 5 events)
// on app start and every 5 minutes, and push a compact list to Rust
// (`set_tray_agenda`), which rebuilds the tray menu. When NOT signed in we push
// an empty list so the tray's agenda section is simply absent. Desktop-only —
// there is no tray (and no `set_tray_agenda` command) on iOS.

import { invoke } from "@tauri-apps/api/core";
import { IS_MOBILE } from "@/lib/platform";
import { isMsConnected } from "@/lib/msauth";
import { calendarView, graphDateMs } from "@/lib/msgraph";

/** The shape Rust's `AgendaItem` deserializes: title + epoch-ms start. */
export interface TrayAgendaItem {
  title: string;
  start: number;
}

const POLL_MS = 5 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS = 5;

/** The next few upcoming events (already ordered by start by Graph). */
async function fetchUpcoming(): Promise<TrayAgendaItem[]> {
  const now = Date.now();
  const events = await calendarView(
    new Date(now).toISOString(),
    new Date(now + WINDOW_MS).toISOString(),
  );
  return events
    .map((e) => ({
      title: (e.subject ?? "").trim() || "Untitled event",
      start: graphDateMs(e.start) ?? 0,
    }))
    .filter((e) => Number.isFinite(e.start) && e.start > 0)
    .sort((a, b) => a.start - b.start)
    .slice(0, MAX_EVENTS);
}

/** Push the current agenda (or an empty list) to the tray. Never throws. */
async function pushAgenda(): Promise<void> {
  let items: TrayAgendaItem[] = [];
  if (isMsConnected()) {
    try {
      items = await fetchUpcoming();
    } catch {
      // Token expiry / offline / Graph hiccup → leave the agenda cleared.
      items = [];
    }
  }
  try {
    await invoke("set_tray_agenda", { items });
  } catch {
    // Tray unavailable (e.g. tray build failed) — nothing to do.
  }
}

/**
 * Start the tray-agenda poller. Pushes once immediately, then every 5 minutes.
 * Returns a stop function (clears the interval). No-op on mobile.
 */
export function startTrayAgenda(): () => void {
  if (IS_MOBILE) return () => {};
  void pushAgenda();
  const id = window.setInterval(() => void pushAgenda(), POLL_MS);
  return () => window.clearInterval(id);
}
