//! macOS/desktop menu-bar tray (Wave C1).
//!
//! The whole module is compiled off iOS (`mod tray` is `#[cfg(not(ios))]` in
//! lib.rs, and the `tray-icon` tauri feature is likewise unioned in only for
//! non-iOS targets in Cargo.toml). It gives Lalela a menu-bar presence: quick
//! actions, the next few calendar events, a live-recording indicator, and a
//! real Quit. Closing the main window then keeps the app running (see
//! `lib.rs`'s `on_window_event` / close-to-tray handling).
//!
//! Portability: the only macOS-specific call is `icon_as_template(true)` (menu
//! bar icons are tinted by the OS). Everything else is plain Tauri tray/menu
//! API, so a future Windows port can reuse this module almost verbatim.

use std::sync::atomic::Ordering;
use std::sync::Mutex;

use serde::Deserialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder};
use tauri::tray::TrayIconBuilder;
use tauri::{AppHandle, Emitter, Manager};

/// Stable id so `set_tray_agenda` / recording changes can find the tray to
/// rebuild its menu.
pub const TRAY_ID: &str = "lalela-main";

/// One upcoming calendar event, pushed from the frontend (`trayAgenda.ts`).
#[derive(Debug, Clone, Deserialize)]
pub struct AgendaItem {
    pub title: String,
    /// Event start as epoch milliseconds. We render a timezone-free *relative*
    /// label ("in 25 min") from it, so no chrono/tz handling is needed.
    pub start: i64,
}

/// Tray-owned state: the current agenda. Managed by `init` so the
/// `set_tray_agenda` command and menu rebuilds can read/replace it.
#[derive(Default)]
pub struct TrayState {
    pub agenda: Mutex<Vec<AgendaItem>>,
}

/// Create the tray icon + initial menu. Called once from `lib.rs`'s setup
/// (already on the main thread there). Best-effort — a failure to build the
/// tray must never abort app startup.
pub fn init(app: &AppHandle) {
    app.manage(TrayState::default());

    let mut builder = TrayIconBuilder::with_id(TRAY_ID)
        .tooltip("Lalela")
        .on_menu_event(on_menu_event);

    if let Ok(menu) = build_menu(app) {
        builder = builder.menu(&menu);
    }
    if let Some(icon) = template_icon() {
        builder = builder.icon(icon).icon_as_template(true);
    }
    if let Err(e) = builder.build(app) {
        eprintln!("tray: failed to build tray icon: {e}");
    }
}

/// Replace the agenda and rebuild the menu (called by `set_tray_agenda`).
pub fn set_agenda(app: &AppHandle, items: Vec<AgendaItem>) {
    if let Some(state) = app.try_state::<TrayState>() {
        if let Ok(mut a) = state.agenda.lock() {
            *a = items;
        }
    }
    refresh(app);
}

/// Rebuild the menu + tooltip from current state (agenda + recording flag).
/// Safe to call from any thread — the actual tray mutation is marshalled onto
/// the main thread (required by the macOS tray backend).
pub fn refresh(app: &AppHandle) {
    let handle = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(tray) = handle.tray_by_id(TRAY_ID) else {
            return;
        };
        if let Ok(menu) = build_menu(&handle) {
            let _ = tray.set_menu(Some(menu));
        }
        let recording = handle
            .try_state::<crate::commands::AppState>()
            .map(|s| s.recording.load(Ordering::Relaxed))
            .unwrap_or(false);
        let _ = tray.set_tooltip(Some(if recording {
            "Lalela — Recording…"
        } else {
            "Lalela"
        }));
    });
}

/// First time the window is hidden to the tray, show one OS notification so the
/// app doesn't seem to have vanished. Tracked via the `close_to_tray_notified`
/// settings key so it fires exactly once per install. Reuses the notification
/// plugin already used for "Local model ready".
pub fn notify_first_hide(app: &AppHandle) {
    let Some(state) = app.try_state::<crate::commands::AppState>() else {
        return;
    };
    let already = {
        let Ok(conn) = state.db.lock() else {
            return;
        };
        if crate::store::get_setting(&conn, "close_to_tray_notified").as_deref() == Some("1") {
            true
        } else {
            let _ = crate::store::set_setting(&conn, "close_to_tray_notified", "1");
            false
        }
    };
    if already {
        return;
    }
    use tauri_plugin_notification::NotificationExt;
    let _ = app
        .notification()
        .builder()
        .title("Lalela is still running in the menu bar")
        .body("Closing the window keeps Lalela recording-ready. Click its menu-bar icon to reopen, or Quit from there.")
        .show();
}

/// Show + focus the main window (also un-minimises / un-hides after
/// close-to-tray).
fn show_main(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

fn on_menu_event(app: &AppHandle, event: tauri::menu::MenuEvent) {
    let id = event.id().as_ref();
    match id {
        "tray-open" => show_main(app),
        "tray-new-recording" => {
            show_main(app);
            // The frontend (App.tsx) listens for this and runs the exact same
            // "New recording" path as the ⌘K palette / Record button.
            let _ = app.emit("tray://new-recording", ());
        }
        "tray-quit" => {
            // Flip the real-quit flag so the close-to-tray guard steps aside,
            // then terminate. `exit` runs cleanup + drops the process.
            if let Some(state) = app.try_state::<crate::commands::AppState>() {
                state.real_quit.store(true, Ordering::Relaxed);
            }
            app.exit(0);
        }
        // Any upcoming-event row just brings the app forward.
        other if other.starts_with("tray-agenda-") => show_main(app),
        _ => {}
    }
}

fn build_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let recording = app
        .try_state::<crate::commands::AppState>()
        .map(|s| s.recording.load(Ordering::Relaxed))
        .unwrap_or(false);
    let agenda: Vec<AgendaItem> = app
        .try_state::<TrayState>()
        .and_then(|s| s.agenda.lock().ok().map(|a| a.clone()))
        .unwrap_or_default();

    let mut builder = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id("tray-open", "Open Lalela").build(app)?)
        .item(&MenuItemBuilder::with_id("tray-new-recording", "New recording").build(app)?)
        .separator();

    // Recording indicator (v1: a disabled row + tooltip — a template menu-bar
    // icon can't carry a red dot, macOS tints it flat, so a menu row is the
    // robust signal).
    if recording {
        builder = builder
            .item(
                &MenuItemBuilder::with_id("tray-recording", "● Recording…")
                    .enabled(false)
                    .build(app)?,
            )
            .separator();
    }

    // Up to 5 upcoming calendar events (only when the frontend has pushed some,
    // i.e. the user is signed into Microsoft).
    if !agenda.is_empty() {
        builder = builder.item(
            &MenuItemBuilder::with_id("tray-agenda-header", "Upcoming")
                .enabled(false)
                .build(app)?,
        );
        for (i, ev) in agenda.iter().take(5).enumerate() {
            let label = format!("{}  ·  {}", truncate(&ev.title, 36), fmt_when(ev.start));
            builder =
                builder.item(&MenuItemBuilder::with_id(format!("tray-agenda-{i}"), label).build(app)?);
        }
        builder = builder.separator();
    }

    builder = builder.item(&MenuItemBuilder::with_id("tray-quit", "Quit Lalela").build(app)?);
    builder.build()
}

/// A monochrome template icon derived from the bundled 128px app icon: keep the
/// alpha silhouette, force RGB to black — macOS tints template icons itself for
/// light/dark menu bars. Returns None if decode fails (tray then falls back to
/// the default window icon, non-template).
fn template_icon() -> Option<tauri::image::Image<'static>> {
    const SRC: &[u8] = include_bytes!("../icons/128x128.png");
    let img = image::load_from_memory(SRC).ok()?;
    // ~22pt @2x for the menu bar.
    let small = img.resize_exact(44, 44, image::imageops::FilterType::Lanczos3);
    let mut rgba = small.to_rgba8();
    for px in rgba.pixels_mut() {
        let a = px.0[3];
        px.0 = [0, 0, 0, a];
    }
    let (w, h) = (rgba.width(), rgba.height());
    Some(tauri::image::Image::new_owned(rgba.into_raw(), w, h))
}

/// Timezone-free relative label for an event start (epoch ms). "now", "in
/// 25 min", "in 2h", "in 1h 30m". Robust: no chrono, no local-tz math.
fn fmt_when(start_ms: i64) -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let mins = (start_ms - now) / 60_000;
    if mins <= 0 {
        "now".to_string()
    } else if mins < 60 {
        format!("in {mins} min")
    } else {
        let (h, m) = (mins / 60, mins % 60);
        if m == 0 {
            format!("in {h}h")
        } else {
            format!("in {h}h {m}m")
        }
    }
}

/// Trim + ellipsize a title to `max` chars (char-safe, never splits a UTF-8
/// codepoint).
fn truncate(s: &str, max: usize) -> String {
    let t = s.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let mut out: String = t.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn truncate_keeps_short_titles_and_ellipsizes_long_ones() {
        assert_eq!(truncate("  Standup  ", 36), "Standup");
        let long = "A very long meeting title that exceeds the tray label budget";
        let t = truncate(long, 10);
        assert!(t.ends_with('…'));
        assert_eq!(t.chars().count(), 10);
    }

    #[test]
    fn fmt_when_buckets_relative_times() {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as i64;
        assert_eq!(fmt_when(now - 60_000), "now");
        assert_eq!(fmt_when(now + 25 * 60_000), "in 25 min");
        assert_eq!(fmt_when(now + 120 * 60_000), "in 2h");
        assert_eq!(fmt_when(now + 90 * 60_000), "in 1h 30m");
    }

    #[test]
    fn agenda_item_deserializes_from_frontend_shape() {
        let item: AgendaItem =
            serde_json::from_str(r#"{"title":"Sync","start":1752000000000}"#).unwrap();
        assert_eq!(item.title, "Sync");
        assert_eq!(item.start, 1_752_000_000_000);
    }
}
