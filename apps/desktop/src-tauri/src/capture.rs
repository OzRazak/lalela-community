//! Screen capture (Phase 6).
//!
//! We deliberately shell out to macOS's built-in `/usr/sbin/screencapture`
//! rather than building a transparent always-on-top overlay window:
//!  - `-i` gives the *native* crosshair region/window picker users already know,
//!  - no extra heavy screen-capture crate, no window-transparency/self-capture
//!    timing hacks, and it respects the OS Screen Recording permission (TCC).
//!
//! Auto-capture uses the same tool without `-i` for a silent full-screen grab.

use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

fn nanos() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// A unique `cap-<nanos>.png` filename for a new capture.
pub fn capture_filename() -> String {
    format!("cap-{}.png", nanos())
}

/// A unique `cap-<nanos>.<ext>` filename (webp for screenshare auto-captures).
pub fn capture_filename_ext(ext: &str) -> String {
    format!("cap-{}.{ext}", nanos())
}

/// A unique throwaway filename for sampler probe shots (deleted after hashing).
pub fn sample_filename() -> String {
    format!("sample-{}.jpg", nanos())
}

/// A unique `img-<nanos>` id for a stored image.
pub fn image_id() -> String {
    format!("img-{}", nanos())
}

/// Sentinel error string the copilot's on-demand screen capture returns when
/// macOS Screen Recording permission (TCC) is not granted — the overlay maps it
/// to an actionable "grant Screen Recording" hint rather than showing a blank
/// (windowless) frame. Kept stable; the frontend matches on it.
pub const SCREEN_PERMISSION_ERR: &str = "COPILOT_SCREEN_PERMISSION";

// macOS `CGPreflightScreenCaptureAccess` — reports the CURRENT Screen Recording
// grant without prompting (10.15+). `screencapture` already respects TCC, but
// silently: with no grant it writes a windowless/desktop-only frame instead of
// failing. The copilot preflights this so a missing grant becomes a typed error.
// The C API returns a `bool`; like the AX checks in dictation.rs we read it as
// `u8` and compare, never as a Rust `bool` (whose non-0/1 bit patterns are UB).
#[cfg(target_os = "macos")]
#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGPreflightScreenCaptureAccess() -> u8;
}

/// Whether this process currently holds macOS Screen Recording permission,
/// checked WITHOUT prompting. Used by the Meeting Copilot's opt-in screen
/// awareness (CP4) to fail fast with an actionable hint.
#[cfg(target_os = "macos")]
pub fn has_screen_recording_permission() -> bool {
    // Safe: a parameterless CoreGraphics query that only reads the TCC grant.
    unsafe { CGPreflightScreenCaptureAccess() != 0 }
}

/// Capture the screen to `dest` via macOS `screencapture`.
///
/// `interactive` => the native region/window selection crosshair (the user can
/// also press Esc to cancel). Returns `Ok(true)` if an image file was written,
/// `Ok(false)` if the user cancelled (interactive only — no file produced).
pub fn screencapture(dest: &Path, interactive: bool) -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        return Err("Screen capture is only supported on macOS.".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }

    let mut cmd = Command::new("/usr/sbin/screencapture");
    cmd.arg("-x"); // mute the shutter sound
    if interactive {
        cmd.arg("-i"); // interactive region / window selection
    }
    cmd.arg(dest);

    // Cancelling an interactive capture (Esc) can exit non-zero and writes no
    // file, so we treat "file exists" as the source of truth rather than the
    // exit status.
    cmd.status().map_err(|e| format!("failed to run screencapture: {e}"))?;
    Ok(dest.exists())
}

/// Capture a single window (by CGWindowID) to `dest` as JPEG, silently, with
/// no window shadow. Used by screenshare auto-capture (Slice 4) so only the
/// meeting window — never the whole screen — is recorded.
///
/// Prefers the `lalela-window --capture` helper (ScreenCaptureKit): it shoots
/// the window even when it lives on another Space or behind a fullscreen app.
/// `screencapture -l` only sees windows composited on the active Space, so it
/// remains the fallback for a missing helper (or SCK refusing, e.g. locked
/// screen — where the CLI fails too and the sampler just skips the tick).
pub fn screencapture_window(window_id: u32, dest: &Path) -> Result<bool, String> {
    if !cfg!(target_os = "macos") {
        return Err("Screen capture is only supported on macOS.".into());
    }
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if let Some(bin) = crate::sidecar::resolve(
        "lalela-window",
        option_env!("LALELA_WINDOW_BIN").unwrap_or(""),
    ) {
        let status = Command::new(bin)
            .arg("--capture")
            .arg(window_id.to_string())
            .arg(dest)
            .status();
        let _ = status;
        if dest.exists() {
            return Ok(true);
        }
    }
    let status = Command::new("/usr/sbin/screencapture")
        .arg("-x") // no shutter sound
        .arg("-o") // no window shadow
        .args(["-t", "jpg"])
        .arg(format!("-l{window_id}"))
        .arg(dest)
        .status()
        .map_err(|e| format!("failed to run screencapture: {e}"))?;
    let _ = status; // window may have closed mid-shot; the file is the truth
    Ok(dest.exists())
}

/// A live ScreenCaptureKit stream held open on ONE window by the
/// `lalela-window --watch` helper. One-shot screenshots cannot photograph a
/// window that lives in a fullscreen Space (SCScreenshotManager error −3811);
/// a persistent stream can — it is what conferencing apps use for window
/// sharing. Held in the sampler state across ticks; dropping it SIGTERMs the
/// helper, which stops the stream (and the purple capture indicator).
pub struct WindowStream {
    pub window_id: u32,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl WindowStream {
    /// Spawn the helper and wait (bounded) for its READY line. `None` when the
    /// helper is missing, the window is gone, or SCK refuses the stream.
    pub fn start(window_id: u32) -> Option<WindowStream> {
        let bin = crate::sidecar::resolve(
            "lalela-window",
            option_env!("LALELA_WINDOW_BIN").unwrap_or(""),
        )?;
        let mut child = Command::new(bin)
            .arg("--watch")
            .arg(window_id.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;
        let stdin = child.stdin.take()?;
        let stdout = child.stdout.take()?;
        // Read READY on a helper thread so a wedged helper can't block the
        // sampler tick (mirrors the system-audio header wait).
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();
            let ok = reader.read_line(&mut line).is_ok();
            let _ = tx.send((ok, line, reader));
        });
        match rx.recv_timeout(Duration::from_secs(8)) {
            Ok((true, line, reader)) if line.trim() == "READY" => Some(WindowStream {
                window_id,
                child,
                stdin,
                stdout: reader,
            }),
            _ => {
                crate::system_tap::terminate_child(&mut child);
                None
            }
        }
    }

    /// Ask the helper for its newest frame. `false` on any failure — callers
    /// should drop the stream and fall back to one-shot capture next tick.
    /// Bounded: the helper answers every request within ~2 s by design.
    pub fn shoot(&mut self, dest: &Path) -> bool {
        if writeln!(self.stdin, "shoot {}", dest.display()).is_err() {
            return false;
        }
        if self.stdin.flush().is_err() {
            return false;
        }
        let mut line = String::new();
        match self.stdout.read_line(&mut line) {
            Ok(n) if n > 0 && line.trim() == "ok" => dest.exists(),
            _ => false,
        }
    }
}

impl Drop for WindowStream {
    fn drop(&mut self) {
        crate::system_tap::terminate_child(&mut self.child);
    }
}

/// Capture `window_id` to `dest` for the screenshare sampler, managing the
/// persistent stream slot: reuse a live stream on the same window, otherwise
/// try the one-shot paths, and only when those can't see the window (it lives
/// in a fullscreen Space) start — and keep — a stream on it.
pub fn capture_window(
    stream: &mut Option<WindowStream>,
    window_id: u32,
    dest: &Path,
) -> Result<bool, String> {
    if let Some(s) = stream.as_mut() {
        if s.window_id == window_id {
            if s.shoot(dest) {
                return Ok(true);
            }
        }
        // Target changed, or the stream died (window closed) — release it.
        *stream = None;
    }
    if screencapture_window(window_id, dest)? {
        return Ok(true);
    }
    if let Some(mut s) = WindowStream::start(window_id) {
        if s.shoot(dest) {
            *stream = Some(s);
            return Ok(true);
        }
    }
    Ok(false)
}

/// Move `src` to `dest`, falling back to copy+remove across volumes
/// (app-data staging and the save folder may live on different filesystems).
pub fn move_file(src: &Path, dest: &Path) -> Result<(), String> {
    if let Some(parent) = dest.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if std::fs::rename(src, dest).is_ok() {
        return Ok(());
    }
    std::fs::copy(src, dest).map_err(|e| e.to_string())?;
    let _ = std::fs::remove_file(src);
    Ok(())
}

/// The per-recording staging dir for images captured before a meeting is saved.
pub fn live_staging_dir(app_data: &Path) -> PathBuf {
    app_data.join("captures").join("live")
}
