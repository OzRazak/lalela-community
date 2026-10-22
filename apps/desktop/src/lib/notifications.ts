// Notification preferences (Wave C3). One JSON blob persisted in the SQLite
// settings K/V (via the get_notification_prefs / set_notification_prefs
// commands, which reuse store::get_setting/set_setting) so that BOTH the
// frontend (detection OS notifications + NotificationBell feed filtering) and
// Rust (the backend-fired "Local model ready" notification) read the same gates.
//
// Unlike the legacy per-toggle settings in lib/settings.ts — which live in
// localStorage — these are in SQLite because the model-ready notification is
// posted from Rust, which can't see the frontend's localStorage. See
// docs/DECISIONS.md (2026-07-17).

import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { IS_MOBILE } from "@/lib/platform";

export interface NotificationPrefs {
  /** OS notification when a meeting is detected and the app isn't focused. */
  meetingDetection: boolean;
  /** OS notification (fired in Rust) when a local model finishes downloading. */
  modelReady: boolean;
  /** Whether overdue tasks appear in the NotificationBell feed. */
  overdueTasks: boolean;
  /** Whether team activity appears in the NotificationBell feed. */
  teamActivity: boolean;
  /** Detection kinds muted for the OS notification (canonical app ids — see
   *  DETECTION_KINDS and detect.rs `pick_kind`). */
  mutedDetectionKinds: string[];
}

/** The detectable meeting kinds. `id` matches the `kind` field on the
 *  `meeting://detected` event (detect.rs `pick_kind`). */
export const DETECTION_KINDS: Array<{ id: string; label: string }> = [
  { id: "Zoom", label: "Zoom" },
  { id: "Microsoft Teams", label: "Microsoft Teams" },
  { id: "Webex", label: "Webex" },
  { id: "Browser", label: "Browser (Google Meet, etc.)" },
];

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  meetingDetection: true,
  modelReady: true,
  overdueTasks: true,
  teamActivity: true,
  mutedDetectionKinds: [],
};

let cache: NotificationPrefs = DEFAULT_NOTIFICATION_PREFS;
let loaded = false;
const listeners = new Set<(p: NotificationPrefs) => void>();

/** Load prefs from SQLite once (called at app startup and lazily by the hook).
 *  Safe to call repeatedly. Missing key / parse failure / unavailable command
 *  all fall back to the built-in defaults. */
export async function loadNotificationPrefs(): Promise<NotificationPrefs> {
  try {
    const raw = await invoke<string | null>("get_notification_prefs");
    if (raw) cache = { ...DEFAULT_NOTIFICATION_PREFS, ...JSON.parse(raw) };
  } catch {
    /* keep defaults — e.g. the command isn't registered on this build */
  }
  loaded = true;
  listeners.forEach((fn) => fn(cache));
  return cache;
}

/** The current cached prefs (synchronous; reflects the last load/save). Used by
 *  event-time code paths like the meeting-detected handler. */
export function notificationPrefs(): NotificationPrefs {
  return cache;
}

/** Persist prefs to SQLite and notify subscribers/hooks. The in-memory cache
 *  updates immediately so the session reflects the choice even if the write
 *  fails. */
export async function setNotificationPrefs(next: NotificationPrefs): Promise<void> {
  cache = next;
  listeners.forEach((fn) => fn(cache));
  try {
    await invoke("set_notification_prefs", { json: JSON.stringify(next) });
  } catch {
    /* best-effort persistence */
  }
}

/** React hook: current prefs, re-rendering on load or save. Triggers the
 *  one-time load on first mount. */
export function useNotificationPrefs(): NotificationPrefs {
  const [prefs, setPrefs] = useState<NotificationPrefs>(cache);
  useEffect(() => {
    if (!loaded) void loadNotificationPrefs();
    listeners.add(setPrefs);
    setPrefs(cache);
    return () => {
      listeners.delete(setPrefs);
    };
  }, []);
  return prefs;
}

/** Fire the "Meeting detected" OS notification when appropriate:
 *  desktop only, only if detection notifications are enabled and this app kind
 *  isn't muted, and only when the main window isn't focused/visible (a user
 *  already looking at Lalela gets the in-app banner instead). Best-effort —
 *  never throws, never blocks the detection flow.
 *
 *  Debounce: the backend edge-triggers `meeting://detected` exactly once per
 *  detection session (detect.rs `was_meeting`), so hooking it here is naturally
 *  one-notification-per-session — no extra throttle needed. */
export async function notifyMeetingDetected(detected: {
  source: string;
  kind: string;
}): Promise<void> {
  if (IS_MOBILE) return;
  const prefs = notificationPrefs();
  if (!prefs.meetingDetection) return;
  if (detected.kind && prefs.mutedDetectionKinds.includes(detected.kind)) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    const win = getCurrentWindow();
    const [focused, visible] = await Promise.all([win.isFocused(), win.isVisible()]);
    if (focused && visible) return; // the in-app banner already covers this
    const { isPermissionGranted, requestPermission, sendNotification } = await import(
      "@tauri-apps/plugin-notification"
    );
    let granted = await isPermissionGranted();
    if (!granted) granted = (await requestPermission()) === "granted";
    if (!granted) return;
    const label = detected.source.charAt(0).toUpperCase() + detected.source.slice(1);
    sendNotification({
      title: "Meeting detected",
      body: `${label} looks like it's in a call — open Lalela to record.`,
    });
  } catch {
    /* notifications are best-effort */
  }
}
