//! Meeting-window resolution (Intelligence Layer, Slice 4).
//!
//! Spawns the one-shot `lalela-window` Swift helper, which lists on-screen
//! windows owned by known conferencing apps/browsers, and picks the capture
//! target: a dedicated conferencing app beats a browser, largest area wins.
//! Auto-capture then shoots ONLY that window — switching to email or another
//! app can never leak into the meeting record.

use std::process::Command;

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, serde::Serialize, PartialEq)]
pub struct MeetingWindow {
    pub id: u32,
    pub app: String,
    #[serde(default)]
    pub title: String,
    pub width: u32,
    pub height: u32,
    /// True for conferencing/browser windows (the auto-detect candidates) —
    /// lets the manual picker surface them first.
    #[serde(default)]
    pub meeting: bool,
}

#[derive(Deserialize)]
struct WindowList {
    windows: Vec<MeetingWindow>,
}

/// Dedicated conferencing apps (preferred over "Browser" — a browser window
/// might be anything; a Zoom/Teams window during a meeting is the meeting).
fn is_dedicated(app: &str) -> bool {
    matches!(app, "Zoom" | "Microsoft Teams" | "Webex")
}

/// Pick the capture target from the helper's candidates: dedicated app over
/// browser, then largest area. Pure — unit-tested below.
pub fn pick_target(mut windows: Vec<MeetingWindow>) -> Option<MeetingWindow> {
    windows.sort_by_key(|w| {
        let area = u64::from(w.width) * u64::from(w.height);
        // Sort descending: dedicated apps first, then by area.
        (std::cmp::Reverse(is_dedicated(&w.app)), std::cmp::Reverse(area))
    });
    windows.into_iter().next()
}

/// Resolve the current meeting window, or `None` when no conferencing window
/// is on screen (app minimized/closed) or the helper isn't built. Used by
/// auto-detect capture.
pub fn resolve_meeting_window() -> Option<MeetingWindow> {
    let bin = crate::sidecar::resolve(
        "lalela-window",
        option_env!("LALELA_WINDOW_BIN").unwrap_or(""),
    )?;
    let out = Command::new(bin).output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout);
    let list = serde_json::from_str::<WindowList>(line.trim()).ok()?;
    pick_target(list.windows)
}

/// List EVERY on-screen window (any app) for the manual capture picker.
/// Conferencing/browser windows are tagged `meeting: true` so the UI can show
/// them first. Empty when the helper isn't built.
pub fn list_all_windows() -> Vec<MeetingWindow> {
    let Some(bin) = crate::sidecar::resolve(
        "lalela-window",
        option_env!("LALELA_WINDOW_BIN").unwrap_or(""),
    ) else {
        return Vec::new();
    };
    let Ok(out) = Command::new(bin).arg("--all").output() else {
        return Vec::new();
    };
    let line = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<WindowList>(line.trim())
        .map(|l| l.windows)
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn w(id: u32, app: &str, width: u32, height: u32) -> MeetingWindow {
        MeetingWindow { id, app: app.into(), title: String::new(), width, height, meeting: false }
    }

    #[test]
    fn dedicated_app_beats_larger_browser_window() {
        let target = pick_target(vec![w(1, "Browser", 2560, 1440), w(2, "Zoom", 1280, 720)]);
        assert_eq!(target.unwrap().id, 2);
    }

    #[test]
    fn largest_window_wins_within_the_same_class() {
        let target = pick_target(vec![
            w(1, "Zoom", 800, 600),
            w(2, "Zoom", 1920, 1080),
            w(3, "Microsoft Teams", 1280, 720),
        ]);
        assert_eq!(target.unwrap().id, 2);
    }

    #[test]
    fn browser_is_used_when_no_dedicated_app_has_windows() {
        let target = pick_target(vec![w(7, "Browser", 1440, 900)]);
        assert_eq!(target.unwrap().id, 7);
        assert_eq!(pick_target(vec![]), None);
    }

    #[test]
    fn helper_json_parses() {
        let json = r#"{"windows":[{"id":42,"app":"Zoom","title":"Zoom Meeting","width":1512,"height":945}]}"#;
        let list: WindowList = serde_json::from_str(json).unwrap();
        assert_eq!(list.windows[0].id, 42);
        assert_eq!(list.windows[0].app, "Zoom");
    }
}
