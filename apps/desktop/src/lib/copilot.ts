// Meeting Copilot overlay (CP1) — thin invoke wrappers over the Rust backend.
// macOS desktop only; on other platforms `copilotStatus().supported` is false
// and the Settings section hides itself.

import { invoke } from "@tauri-apps/api/core";

export interface CopilotStatus {
  /** True only on macOS — gate the whole UI on this. */
  supported: boolean;
  /** Whether the global hotkey is currently armed. */
  enabled: boolean;
  /** Bound accelerator in Tauri format, e.g. "CmdOrCtrl+Shift+A". */
  shortcut: string;
  /** Whether the overlay is showing right now. */
  visible: boolean;
}

/** Current copilot status (support, enabled, shortcut, visibility). */
export const copilotStatus = () => invoke<CopilotStatus>("copilot_status");

/** Arm/disarm the copilot hotkey. */
export const setCopilotEnabled = (enabled: boolean) =>
  invoke<void>("set_copilot_enabled", { enabled });

/** Show the overlay (Settings "Try it"). */
export const copilotShow = () => invoke<void>("copilot_show");

/** Hide the overlay (the overlay's ✕). */
export const copilotHide = () => invoke<void>("copilot_hide");

/** Toggle the overlay's visibility. */
export const copilotToggle = () => invoke<void>("copilot_toggle");

// ── Screen awareness (CP4) — opt-in, on-demand screen capture ──────────────

/** Sentinel the Rust `copilot_capture_screen` command returns when macOS Screen
 * Recording permission is missing. Kept in lockstep with capture.rs. */
export const SCREEN_PERMISSION_ERR = "COPILOT_SCREEN_PERMISSION";

/** Thrown by {@link copilotCaptureScreen} when Screen Recording permission is
 * not granted — the overlay turns it into a "grant Screen Recording" hint. */
export class ScreenPermissionError extends Error {
  constructor() {
    super("screen-permission");
    this.name = "ScreenPermissionError";
  }
}

/**
 * Capture the current screen for the copilot's opt-in screen awareness (CP4).
 * Returns a base64 `data:` URL that lives ONLY in memory for the duration of the
 * request — the frame is never written to disk. Throws {@link ScreenPermissionError}
 * when Screen Recording permission is missing so the caller can prompt for it.
 * macOS only; on other platforms the command rejects.
 */
export async function copilotCaptureScreen(): Promise<string> {
  try {
    return await invoke<string>("copilot_capture_screen");
  } catch (e) {
    const msg = typeof e === "string" ? e : e instanceof Error ? e.message : String(e);
    if (msg.includes(SCREEN_PERMISSION_ERR)) throw new ScreenPermissionError();
    throw e instanceof Error ? e : new Error(msg);
  }
}
