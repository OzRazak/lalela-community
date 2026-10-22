//! Meeting auto-detect (Phase 8).
//!
//! A background poller spawns the one-shot Swift helper (`lalela-detect`) every
//! few seconds. The helper reports whether the mic is in use (Core Audio) and
//! which known conferencing apps/browsers are running. When the mic becomes
//! active *and* a known app is present — and we're not already recording — we
//! emit `meeting://detected { source }` so the UI can offer "Start recording?".
//! Edge-triggered (fires once per meeting), gated by shared enabled/recording
//! flags so the user stays in control.

use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

const POLL: Duration = Duration::from_secs(4);

#[derive(Deserialize)]
struct DetectStatus {
    #[serde(rename = "micInUse")]
    mic_in_use: bool,
    apps: Vec<String>,
}

/// Start the detector thread (no-op if the helper wasn't built). Runs for the
/// app's lifetime, gated by the shared `enabled` and `recording` flags.
pub fn spawn(app: AppHandle, enabled: Arc<AtomicBool>, recording: Arc<AtomicBool>) {
    let bin = match crate::sidecar::resolve("lalela-detect", option_env!("LALELA_DETECT_BIN").unwrap_or("")) {
        Some(p) => p.to_string_lossy().to_string(),
        None => return, // helper not built/bundled → auto-detect disabled
    };
    std::thread::spawn(move || {
        let mut was_meeting = false;
        loop {
            std::thread::sleep(POLL);
            if !enabled.load(Ordering::Relaxed) {
                was_meeting = false;
                continue;
            }
            // Suppress while recording, but keep the edge "high" so we don't
            // immediately re-prompt when recording stops mid-meeting.
            if recording.load(Ordering::Relaxed) {
                was_meeting = true;
                continue;
            }
            let status = poll(&bin);
            let meeting = status
                .as_ref()
                .map(|s| s.mic_in_use && !s.apps.is_empty())
                .unwrap_or(false);
            if meeting && !was_meeting {
                let (source, kind) = status
                    .as_ref()
                    .map(|s| (pick_source(&s.apps), pick_kind(&s.apps)))
                    .unwrap_or(("a meeting".to_string(), ""));
                // `source` is the display string; `kind` is the canonical app id
                // (matches the frontend mute list, see lib/notifications.ts) so
                // the UI can suppress detection notifications per app.
                let _ = app.emit(
                    "meeting://detected",
                    serde_json::json!({ "source": source, "kind": kind }),
                );
            }
            was_meeting = meeting;
        }
    });
}

fn poll(bin: &str) -> Option<DetectStatus> {
    let out = Command::new(bin).output().ok()?;
    let line = String::from_utf8_lossy(&out.stdout);
    serde_json::from_str::<DetectStatus>(line.trim()).ok()
}

/// Prefer naming a dedicated conferencing app over a generic browser.
fn pick_source(apps: &[String]) -> String {
    for pref in ["Zoom", "Microsoft Teams", "Webex"] {
        if apps.iter().any(|a| a == pref) {
            return pref.to_string();
        }
    }
    if apps.iter().any(|a| a == "Browser") {
        return "your browser (Google Meet?)".to_string();
    }
    "a meeting".to_string()
}

/// The canonical app id for the detected meeting — matches the frontend mute
/// list (`DETECTION_KINDS` in lib/notifications.ts) and the priority order of
/// `pick_source`. Empty string when only a generic/unknown source is present.
fn pick_kind(apps: &[String]) -> &'static str {
    for kind in ["Zoom", "Microsoft Teams", "Webex", "Browser"] {
        if apps.iter().any(|a| a == kind) {
            return kind;
        }
    }
    ""
}
