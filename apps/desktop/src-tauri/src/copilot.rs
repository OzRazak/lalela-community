//! Meeting Copilot overlay (CP1) — macOS desktop only.
//!
//! A hotkey-summoned, always-on-top, translucent panel that gives on-demand AI
//! guidance during a live recording ("What should I say?" / follow-up questions
//! / a fast recap). It is **assistive and transparent**: a small footer says it
//! is private to the user, and the window is kept out of most screen shares —
//! best-effort, not a stealth tool.
//!
//! Why the whole module is `#[cfg(target_os = "macos")]`:
//!   * the overlay is created as a second `WebviewWindow` and hardened through
//!     AppKit (`NSWindow` sharing-type + collection-behaviour), which are macOS
//!     APIs, and it rides the same macOS-only global-shortcut plugin dictation
//!     uses. Keeping it macOS-only leaves the `aarch64-apple-ios` check and the
//!     (planned) Windows/Linux desktop builds clean.
//!
//! Relationship to dictation: both features register through the ONE global
//! shortcut handler initialised in `lib.rs`; the handler routes a key-press by
//! which accelerator fired (`is_our_shortcut`). The copilot never touches the
//! microphone or the app's Whisper engines — it only reads the live transcript
//! the recorder already emits (`transcript://segment`) frontend-side, so it can
//! coexist with a running recording (unlike dictation, which is mic-exclusive).
//!
//! AppKit hardening mirrors dictation.rs's hard-won safety rules: every ObjC
//! call runs on the main thread inside an exception barrier
//! (`objc2::exception::catch`), and any selector that might be absent is guarded
//! with `respondsToSelector:`. The overlay can therefore NEVER abort the host
//! app — a throw becomes a logged no-op.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use objc2::runtime::{AnyObject, Sel};
use objc2::{msg_send, sel};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

use crate::commands::AppState;
use crate::store;

/// Default global hotkey. `⌘⇧A` has no macOS *system* default and doesn't
/// collide with dictation's `⌘⇧D`. Toggling it shows/hides the overlay — which
/// doubles as the panic-hide. Persisted in the SQLite settings K/V; fixed in v1
/// (no rebind UI — see DECISIONS).
pub const DEFAULT_SHORTCUT: &str = "CmdOrCtrl+Shift+A";

/// The overlay window's Tauri label. Governed by the `default` + `copilot`
/// capabilities (see `capabilities/`).
const OVERLAY_LABEL: &str = "copilot";

/// SQLite `settings` keys (source of truth; mirrors the backend registration).
const KEY_ENABLED: &str = "copilot.enabled";
const KEY_SHORTCUT: &str = "copilot.shortcut";

// AppKit constants (NSUInteger = usize on 64-bit).
/// `NSWindowSharingNone` — keeps the panel out of most window/screen captures.
const NS_WINDOW_SHARING_NONE: usize = 0;
/// `NSWindowCollectionBehaviorCanJoinAllSpaces` (1 << 0).
const CB_CAN_JOIN_ALL_SPACES: usize = 1 << 0;
/// `NSWindowCollectionBehaviorStationary` (1 << 4).
const CB_STATIONARY: usize = 1 << 4;
/// `NSWindowCollectionBehaviorFullScreenAuxiliary` (1 << 8) — float over a
/// full-screen meeting instead of being hidden by it.
const CB_FULLSCREEN_AUXILIARY: usize = 1 << 8;

/// Managed state for the copilot (one per app).
#[derive(Default)]
pub struct CopilotState {
    /// The accelerator currently registered with the global-shortcut plugin, so
    /// the shared handler can route to us and we can unregister before rebinding.
    current_shortcut: Mutex<Option<String>>,
    /// Our own visibility bookkeeping. We order the panel in/out through AppKit
    /// (`orderFrontRegardless` / `orderOut:`) rather than Tauri's show/hide so
    /// showing never makes the window key or activates the app — so Tauri's own
    /// visibility flag is unreliable and we track it here.
    visible: AtomicBool,
}

// ─────────────────────────── settings + registration ───────────────────────

/// Register the hotkey iff the copilot is enabled in settings. Called at startup.
pub fn init_from_settings(app: &AppHandle) {
    let (enabled, shortcut) = read_settings(app);
    if enabled {
        if let Err(e) = register_shortcut(app, &shortcut) {
            eprintln!("copilot: could not register hotkey {shortcut:?}: {e}");
        }
    }
}

fn read_settings(app: &AppHandle) -> (bool, String) {
    let state = app.state::<AppState>();
    let Ok(conn) = state.db.lock() else {
        return (false, DEFAULT_SHORTCUT.to_string());
    };
    let enabled = store::get_setting(&conn, KEY_ENABLED).as_deref() == Some("true");
    let shortcut = store::get_setting(&conn, KEY_SHORTCUT)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
    (enabled, shortcut)
}

/// Persist enabled, then arm/disarm the hotkey to match. Disabling also hides
/// the overlay and tells it to unsubscribe (so a hidden window does zero work).
pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(|_| "state poisoned")?;
        store::set_setting(&conn, KEY_ENABLED, if enabled { "true" } else { "false" })?;
    }
    if enabled {
        let (_, shortcut) = read_settings(app);
        register_shortcut(app, &shortcut)?;
        let _ = app.emit_to(OVERLAY_LABEL, "copilot://enabled", true);
    } else {
        unregister_current(app);
        // Tell the overlay to tear down its listeners, then order it out.
        let _ = app.emit_to(OVERLAY_LABEL, "copilot://enabled", false);
        hide(app);
    }
    Ok(())
}

fn parse_shortcut(accel: &str) -> Result<Shortcut, String> {
    use std::str::FromStr;
    Shortcut::from_str(accel).map_err(|e| format!("invalid shortcut {accel:?}: {e}"))
}

fn register_shortcut(app: &AppHandle, accel: &str) -> Result<(), String> {
    let shortcut = parse_shortcut(accel)?;
    unregister_current(app);
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| e.to_string())?;
    if let Ok(mut cur) = app.state::<CopilotState>().current_shortcut.lock() {
        *cur = Some(accel.to_string());
    }
    Ok(())
}

fn unregister_current(app: &AppHandle) {
    let prev = app
        .state::<CopilotState>()
        .current_shortcut
        .lock()
        .ok()
        .and_then(|mut c| c.take());
    if let Some(accel) = prev {
        if let Ok(shortcut) = parse_shortcut(&accel) {
            let _ = app.global_shortcut().unregister(shortcut);
        }
    }
}

/// Whether `fired` is the copilot's currently-registered accelerator. Called by
/// the shared global-shortcut handler in `lib.rs` to decide copilot vs
/// dictation. Cheap (a lock + a string parse) and runs on the handler thread —
/// it never blocks or hops threads. Returns false when the copilot is disabled
/// (no registered accelerator), so dictation stays the default route.
pub fn is_our_shortcut(app: &AppHandle, fired: &Shortcut) -> bool {
    let Some(state) = app.try_state::<CopilotState>() else {
        return false;
    };
    let Some(accel) = state.current_shortcut.lock().ok().and_then(|c| c.clone()) else {
        return false;
    };
    parse_shortcut(&accel).map(|s| &s == fired).unwrap_or(false)
}

// ─────────────────────────── public entry points ───────────────────────────

/// The hotkey action (and panic-hide): show if hidden, hide if shown.
pub fn toggle(app: AppHandle) {
    let visible = is_visible(&app) && app.get_webview_window(OVERLAY_LABEL).is_some();
    if visible {
        hide(&app);
    } else {
        show(&app);
    }
}

/// Bring the overlay up without stealing focus. Creates it (hidden) on first
/// use, then orders it in via AppKit.
pub fn show(app: &AppHandle) {
    ensure_window(app);
    let app2 = app.clone();
    let _ = crate::commands::run_on_main(app, move || {
        if let Some(w) = app2.get_webview_window(OVERLAY_LABEL) {
            order_front_no_activate(&w);
        }
    });
    app.state::<CopilotState>().visible.store(true, Ordering::Relaxed);
    let _ = app.emit_to(OVERLAY_LABEL, "copilot://visibility", true);
}

/// Order the overlay out (panic-hide / ✕). The webview is NOT destroyed — its
/// cheap transcript ring buffer keeps filling so the next summon is warm.
pub fn hide(app: &AppHandle) {
    let app2 = app.clone();
    let _ = crate::commands::run_on_main(app, move || {
        if let Some(w) = app2.get_webview_window(OVERLAY_LABEL) {
            order_out(&w);
        }
    });
    app.state::<CopilotState>().visible.store(false, Ordering::Relaxed);
    // Let the overlay cancel any in-flight generation so a hidden panel does no
    // work beyond the cheap transcript ring-buffer append.
    let _ = app.emit_to(OVERLAY_LABEL, "copilot://visibility", false);
}

/// Current visibility (for `copilot_status`).
pub fn is_visible(app: &AppHandle) -> bool {
    app.try_state::<CopilotState>()
        .map(|s| s.visible.load(Ordering::Relaxed))
        .unwrap_or(false)
}

/// Called when a recording starts: if the copilot is enabled, pre-create the
/// (hidden) overlay so its transcript ring buffer fills from the very start of
/// the meeting — the first summon is then instant AND already has context. The
/// window is created exactly once and reused for the app's lifetime. No-op when
/// disabled, so a user who never turns the feature on pays nothing.
pub fn on_recording_started(app: &AppHandle) {
    let app = app.clone();
    // Off the caller's thread: `ensure_window` blocks on a main-thread hop.
    std::thread::spawn(move || {
        if read_settings(&app).0 {
            ensure_window(&app);
        }
    });
}

// ─────────────────────────── overlay window ─────────────────────────────────

/// Create the overlay once (hidden), positioned top-centre and AppKit-hardened.
/// Idempotent — returns immediately if it already exists (window reused, never
/// rebuilt). macOS window creation belongs on the main thread; callers run off
/// it, so we hop and block.
fn ensure_window(app: &AppHandle) {
    if app.get_webview_window(OVERLAY_LABEL).is_some() {
        return;
    }
    let app2 = app.clone();
    let _ = crate::commands::run_on_main(app, move || {
        if app2.get_webview_window(OVERLAY_LABEL).is_some() {
            return;
        }
        let built = WebviewWindowBuilder::new(
            &app2,
            OVERLAY_LABEL,
            WebviewUrl::App("copilot.html".into()),
        )
        .title("Meeting Copilot")
        // Larger default so streaming answers have room to breathe; the user can
        // resize (native edge-drag + the SE corner grip) and the size is
        // persisted/restored frontend-side (localStorage `copilot.overlay.size`).
        .inner_size(400.0, 460.0)
        .resizable(true)
        .min_inner_size(340.0, 220.0)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .visible(false) // created hidden; the ring buffer runs, we order it in on show
        .focused(false)
        .build();
        match built {
            Ok(w) => {
                position_top_center(&w);
                harden(&w);
            }
            Err(e) => eprintln!("copilot: could not create overlay window: {e}"),
        }
    });
}

/// Best-effort: centre horizontally near the top of the current (or primary)
/// monitor. Set while hidden, so there's no visible jump. Falls back to Tauri's
/// default placement if no monitor is reported.
fn position_top_center(w: &WebviewWindow) {
    let monitor = w
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| w.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return };
    let scale = monitor.scale_factor();
    let m: LogicalSize<f64> = monitor.size().to_logical(scale);
    let size: LogicalSize<f64> = w
        .inner_size()
        .map(|s| s.to_logical(scale))
        .unwrap_or(LogicalSize::new(400.0, 460.0));
    let x = ((m.width - size.width) / 2.0).max(0.0);
    let y = 28.0_f64;
    let _ = w.set_position(LogicalPosition::new(x, y));
}

/// Apply the private-overlay hardening. Best-effort and fully guarded — a throw
/// or an absent selector becomes a logged no-op, never a host-app abort.
///
/// What we achieve:
///   * `sharingType = NSWindowSharingNone` — the panel is kept out of most
///     screen shares and recordings (NOT guaranteed on macOS 15+, where
///     ScreenCaptureKit capturers may ignore it — the Settings copy says so).
///   * `collectionBehavior` = join-all-spaces | stationary | full-screen-aux —
///     the panel floats over a full-screen meeting and shows on every Space.
///
/// Non-activating: we do NOT flip the `NSWindowStyleMaskNonactivatingPanel`
/// style bit — it's a no-op on a plain `NSWindow` (it needs an `NSPanel`, which
/// Tauri doesn't expose) and OR-ing style bits risks resetting the borderless
/// state. Instead, `show()` orders the panel in with `orderFrontRegardless`
/// (not `makeKeyAndOrderFront:`), so summoning it never makes it key or
/// activates Lalela — the practical "don't steal focus" behaviour. (See
/// DECISIONS.)
fn harden(w: &WebviewWindow) {
    let Some(win) = ns_window_ptr(w) else {
        return;
    };
    guarded("harden", move || unsafe {
        if responds(win, sel!(setSharingType:)) {
            let _: () = msg_send![win, setSharingType: NS_WINDOW_SHARING_NONE];
        }
        if responds(win, sel!(setCollectionBehavior:)) {
            let behavior: usize =
                CB_CAN_JOIN_ALL_SPACES | CB_STATIONARY | CB_FULLSCREEN_AUXILIARY;
            let _: () = msg_send![win, setCollectionBehavior: behavior];
        }
    });
}

/// Order the panel to the front WITHOUT making it key or activating the app.
fn order_front_no_activate(w: &WebviewWindow) {
    let Some(win) = ns_window_ptr(w) else {
        return;
    };
    guarded("order_front", move || unsafe {
        let _: () = msg_send![win, orderFrontRegardless];
    });
}

/// Order the panel out (hide) — the webview keeps running.
fn order_out(w: &WebviewWindow) {
    let Some(win) = ns_window_ptr(w) else {
        return;
    };
    guarded("order_out", move || unsafe {
        let nil: *mut AnyObject = core::ptr::null_mut();
        let _: () = msg_send![win, orderOut: nil];
    });
}

// ─────────────────────── ObjC exception barrier ────────────────────────────

/// The raw `NSWindow` behind a Tauri window, or `None` if unavailable. macOS
/// only (the whole module is).
fn ns_window_ptr(w: &WebviewWindow) -> Option<*mut AnyObject> {
    match w.ns_window() {
        Ok(ptr) if !ptr.is_null() => Some(ptr.cast::<AnyObject>()),
        _ => None,
    }
}

/// Whether `obj` responds to `selector` (guard for selectors that might be
/// absent on an older runtime). Caller is already inside `unsafe` + the barrier.
unsafe fn responds(obj: *mut AnyObject, selector: Sel) -> bool {
    if obj.is_null() {
        return false;
    }
    msg_send![obj, respondsToSelector: selector]
}

/// Run an AppKit closure inside the ObjC exception barrier. MUST already be on
/// the main thread (all callers run inside a `run_on_main` hop). A thrown
/// `NSException` unwinding into Rust would abort the WHOLE host app ("Rust
/// cannot catch foreign exceptions") — `catch` turns it into a logged no-op, so
/// the overlay can never take the app down. `step` names the operation for logs.
fn guarded<F: FnOnce()>(step: &'static str, f: F) {
    let res = objc2::exception::catch(std::panic::AssertUnwindSafe(f));
    if let Err(exc) = res {
        let detail = exc
            .map(|e| format!("{e:?}"))
            .unwrap_or_else(|| "nil NSException".to_string());
        eprintln!("copilot: step={step} threw an Objective-C exception: {detail}");
    }
}
