/** Platform detection for platform-gated rendering (Phase 4: iOS port; Android
 * port P1).
 *
 * A user-agent check is enough here: the app ships as a macOS desktop app, an
 * iOS app, or an Android app, and each WebView carries a distinguishing token
 * (WKWebView → iPhone/iPad; Android System WebView → "Android"). Swap for
 * `@tauri-apps/plugin-os` if finer detection is ever needed.
 */
/** Full-screen iPad: WKWebView reports a Macintosh user-agent there (no iPad
 * token — see #182), but unlike a real Mac it has touch points (every Mac
 * reports `maxTouchPoints === 0`). */
export const IS_IPAD: boolean =
  /iPad/.test(navigator.userAgent) ||
  (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);

/** iPhone OR iPad. iPad MUST count as iOS: before 1.3.10 a full-screen iPad
 * fell through to the macOS branch (IS_MOBILE false, IS_MACOS true), so the
 * App Store build rendered the desktop UI there — including the "Upgrade to
 * Pro" / "Buy more tokens" / "payments coming soon (Paystack)" placeholders
 * that got 1.1.11 rejected (Guidelines 2.1(b) / 3.1.1), the desktop updater
 * card, local-model downloads and screen capture, none of which exist on
 * iPadOS. iPad now gets the mobile layout and capability gates. */
export const IS_IOS: boolean = /iPhone|iPad|iPod/.test(navigator.userAgent) || IS_IPAD;

/** Android System WebView carries "Android" in its UA (never "Macintosh", so
 * the IS_IPAD Mac-UA sniff below can't misfire here). */
export const IS_ANDROID: boolean = /Android/.test(navigator.userAgent);

/** Mobile == iOS or Android. IS_MACOS keys off `!IS_MOBILE`, so it self-corrects
 * as Android joins the mobile family. */
export const IS_MOBILE = IS_IOS || IS_ANDROID;

/** Desktop macOS. Today every non-mobile build IS macOS (Windows/Linux ports
 * are planned but not shipped), so this is a reasonable proxy for gating
 * macOS-only desktop features. The backend is the real authority — features
 * like dictation return `supported: false` off macOS regardless. */
export const IS_MACOS: boolean = !IS_MOBILE && /Macintosh|Mac OS X/.test(navigator.userAgent);

/** Desktop Windows. The WebView2 user-agent carries "Windows NT". Mutually
 * exclusive with IS_MACOS. Used to make copy and platform-specific surfaces
 * (privacy deep-links, the ⌘K/Ctrl+K keycap, system-audio availability) tell
 * the truth on the Windows port. */
export const IS_WINDOWS: boolean = !IS_MOBILE && /Windows/.test(navigator.userAgent);

/** The everyday word for "this computer/phone" in user-facing copy, per
 * platform. Falls back to "device" for anything we don't recognise so no
 * surface can claim the wrong hardware. */
export const DEVICE_NOUN: string = IS_ANDROID
  ? "Android phone"
  : IS_IPAD
    ? "iPad"
    : IS_MOBILE
    ? "iPhone"
    : IS_WINDOWS
      ? "PC"
      : IS_MACOS
        ? "Mac"
        : "device";

/** Keyboard-chord label for user-facing copy. Windows has no ⌘ key; every
 * handler already accepts `metaKey || ctrlKey`, so only the LABEL has to
 * change. `chord("K")` → "⌘K" on macOS, "Ctrl K" on Windows. Use this for any
 * shortcut shown to the user so no surface claims a key the keyboard lacks. */
export function chord(key: string): string {
  return IS_WINDOWS ? `Ctrl ${key}` : `⌘${key}`;
}

/** OS settings deep-links used by permission and troubleshooting copy
 * (best-effort — ignored if the scheme is blocked). Windows uses the
 * `ms-settings:` URIs; macOS the System Settings URL scheme. */
export const SETTINGS_URI = {
  microphone: IS_WINDOWS
    ? "ms-settings:privacy-microphone"
    : "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
  sound: IS_WINDOWS
    ? "ms-settings:sound"
    : "x-apple.systempreferences:com.apple.preference.sound",
};

/** Where a user grants the microphone, in that OS's own words. */
export const MIC_SETTINGS_PATH: string = IS_MOBILE
  ? "Settings → Apps → Lalela → Microphone"
  : IS_WINDOWS
    ? "Settings → Privacy & security → Microphone"
    : "System Settings → Privacy & Security → Microphone";

/** Where a user picks the input device, in that OS's own words. */
export const SOUND_SETTINGS_PATH: string = IS_WINDOWS
  ? "Settings → System → Sound"
  : "System Settings → Sound";
