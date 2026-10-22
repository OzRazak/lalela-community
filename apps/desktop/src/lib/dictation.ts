// System-wide dictation (Wave B2) — thin invoke/event wrappers over the Rust
// backend. macOS desktop only; on other platforms `dictationStatus().supported`
// is false and the Settings section hides itself.

import { trackEvent } from "./analytics";
import { invoke } from "@tauri-apps/api/core";
import { IS_WINDOWS } from "@/lib/platform";

export interface DictationStatus {
  /** True only on macOS — gate the whole UI on this. */
  supported: boolean;
  /** Whether the global hotkey is currently armed. */
  enabled: boolean;
  /** Bound accelerator in Tauri format, e.g. "CmdOrCtrl+Shift+D". */
  shortcut: string;
  /** Whether this app is trusted for Accessibility (required to paste). */
  accessibility: boolean;
  /** Whether a secure (password) field is focused right now. */
  secure_input: boolean;
}

/** Current dictation status (support, enabled, shortcut, permissions). */
export const dictationStatus = () => invoke<DictationStatus>("dictation_status");

/** Arm/disarm the dictation hotkey. */
export const setDictationEnabled = (enabled: boolean) => {
  trackEvent("feature_used", { feature: "dictation", action: enabled ? "enabled" : "disabled" });
  return invoke<void>("set_dictation_enabled", { enabled });
};

/** Re-bind the dictation hotkey to a new accelerator (Tauri format). */
export const setDictationShortcut = (shortcut: string) =>
  invoke<void>("set_dictation_shortcut", { shortcut });

/** Toggle a dictation session by hand (Settings "Try it" button). */
export const triggerDictation = () => invoke<void>("trigger_dictation");

/** Finish the active dictation (overlay Enter). */
export const finishDictation = () => invoke<void>("finish_dictation");

/** Cancel the active dictation (overlay Esc). */
export const cancelDictation = () => invoke<void>("cancel_dictation");

// ── Accelerator formatting ──────────────────────────────────────────────────

/** Render a Tauri accelerator string ("CmdOrCtrl+Shift+D") for display — as
 * macOS glyphs ("⌘⇧D"), or as Windows key names ("Ctrl+Shift+D"), since a PC
 * keyboard has none of these symbols. */
export function prettyShortcut(accel: string): string {
  const map: Record<string, string> = IS_WINDOWS
    ? {
        commandorcontrol: "Ctrl",
        cmdorctrl: "Ctrl",
        command: "Ctrl",
        cmd: "Ctrl",
        super: "Win",
        control: "Ctrl",
        ctrl: "Ctrl",
        alt: "Alt",
        option: "Alt",
        shift: "Shift",
        space: "Space",
        enter: "Enter",
        escape: "Esc",
      }
    : {
        commandorcontrol: "⌘",
        cmdorctrl: "⌘",
        command: "⌘",
        cmd: "⌘",
        super: "⌘",
        control: "⌃",
        ctrl: "⌃",
        alt: "⌥",
        option: "⌥",
        shift: "⇧",
        space: "Space",
        enter: "⏎",
        escape: "Esc",
      };
  return accel
    .split("+")
    .map((part) => {
      const key = part.trim().toLowerCase();
      return map[key] ?? part.trim().toUpperCase();
    })
    .join(IS_WINDOWS ? "+" : "");
}

/** Build a Tauri accelerator string from a keyboard event, or null if the
 * combination isn't a valid shortcut (no non-modifier key, or a modifier-only
 * press). Requires at least one modifier so global shortcuts don't swallow bare
 * keys. */
export function accelFromEvent(e: KeyboardEvent): string | null {
  const mods: string[] = [];
  if (e.metaKey) mods.push("CmdOrCtrl");
  if (e.ctrlKey) mods.push("Control");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  const key = e.key;
  // Ignore pure modifier presses.
  if (["Meta", "Control", "Alt", "Shift"].includes(key)) return null;
  if (mods.length === 0) return null;

  let code: string;
  if (key === " ") code = "Space";
  else if (/^[a-zA-Z]$/.test(key)) code = key.toUpperCase();
  else if (/^[0-9]$/.test(key)) code = key;
  else if (key.startsWith("Arrow")) code = key.replace("Arrow", "");
  else if (key.length === 1) code = key.toUpperCase();
  else code = key;

  return [...mods, code].join("+");
}
