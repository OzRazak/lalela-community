//! Crash breadcrumbs.
//!
//! A global panic hook that appends one line to `<app_data_dir>/crash.log`
//! before the process unwinds/aborts, so a crash on a machine we can't attach a
//! debugger to (a user's Windows PC) still says WHAT panicked and WHERE —
//! without needing a Windows Error Reporting minidump.
//!
//! Deliberately tiny and dependency-free: one `writeln!` on an append handle,
//! rolled over past `MAX_LOG_BYTES`. Zero cost while nothing panics.
//!
//! Same resolver as `sysaudio.log` — the app data dir, honoring
//! `LALELA_DATA_DIR`. The dir is only known once Tauri's `setup` runs, so the
//! hook is installed at the top of `run()` and the dir is handed to it in
//! `setup`; a panic before that falls back to `LALELA_DATA_DIR` if set, and is
//! otherwise printed by the default hook only.

use std::path::PathBuf;
use std::sync::OnceLock;

/// Roll the log over past this size (each crash is one line).
const MAX_LOG_BYTES: u64 = 64 * 1024;

static LOG_DIR: OnceLock<PathBuf> = OnceLock::new();

/// Point the hook at the resolved app data dir (called once from `setup`).
pub fn set_log_dir(dir: PathBuf) {
    let _ = LOG_DIR.set(dir);
}

fn log_dir() -> Option<PathBuf> {
    LOG_DIR
        .get()
        .cloned()
        .or_else(crate::paths::data_dir_override)
}

/// The one line a crash writes. Pure, so its shape is unit-testable.
pub fn crash_line(unix_secs: u64, message: &str, location: &str, thread: &str) -> String {
    // Keep it single-line: a multi-line panic message (assert_eq! prints three)
    // would otherwise look like three separate crashes.
    let message = message.replace(['\n', '\r'], " ⏎ ");
    format!("[{unix_secs}] panic: {message} at {location} (thread {thread})")
}

/// Extract the human message from a panic payload (`&str` / `String` cover
/// every `panic!`/`unwrap`/`assert` in practice).
fn payload_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "<non-string panic payload>".to_string()
    }
}

fn append(line: &str) {
    use std::io::Write;
    let Some(dir) = log_dir() else {
        return;
    };
    let path = dir.join("crash.log");
    if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_LOG_BYTES {
        let _ = std::fs::rename(&path, dir.join("crash.log.1"));
    }
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = writeln!(f, "{line}");
    }
}

/// Install the global panic hook (idempotent in practice — called once from
/// `run()`). Chains to the previous hook so stderr output is unchanged.
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let unix_secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let location = info
            .location()
            .map(|l| format!("{}:{}", l.file(), l.line()))
            .unwrap_or_else(|| "unknown location".to_string());
        let thread = std::thread::current()
            .name()
            .unwrap_or("unnamed")
            .to_string();
        append(&crash_line(
            unix_secs,
            &payload_message(info.payload()),
            &location,
            &thread,
        ));
        previous(info);
    }));
}

/// One recorded panic, as returned to the frontend's opt-in error reporter.
#[derive(serde::Serialize, Debug, PartialEq)]
pub struct CrashEntry {
    /// Unix seconds from the line's `[ts]` prefix — the reporter's cursor.
    pub ts: u64,
    /// The full crash line (the frontend scrubs it before sending anything).
    pub line: String,
}

/// Parse crash-log text into entries strictly newer than `after`, oldest
/// first, capped at `limit` (the newest `limit` win). Pure for testing.
pub fn entries_after(text: &str, after: u64, limit: usize) -> Vec<CrashEntry> {
    let mut out: Vec<CrashEntry> = text
        .lines()
        .filter_map(|l| {
            let rest = l.strip_prefix('[')?;
            let (ts, _) = rest.split_once(']')?;
            let ts: u64 = ts.parse().ok()?;
            (ts > after).then(|| CrashEntry { ts, line: l.to_string() })
        })
        .collect();
    if out.len() > limit {
        out.drain(..out.len() - limit);
    }
    out
}

/// Crash-log lines newer than `after` (unix secs), across the rolled
/// `crash.log.1` and the live `crash.log`. Read-only; used by the opt-in
/// error reporter so each panic is forwarded at most once (the frontend keeps
/// the cursor). Returns nothing when the log dir is unknown.
#[tauri::command]
pub fn crash_reports_since(after: u64) -> Vec<CrashEntry> {
    let Some(dir) = log_dir() else {
        return Vec::new();
    };
    let mut text = String::new();
    for name in ["crash.log.1", "crash.log"] {
        if let Ok(t) = std::fs::read_to_string(dir.join(name)) {
            text.push_str(&t);
            text.push('\n');
        }
    }
    entries_after(&text, after, 20)
}

/// Target OS + CPU arch of this build, for tagging error reports.
#[tauri::command]
pub fn build_target() -> (String, String) {
    (
        std::env::consts::OS.to_string(),
        std::env::consts::ARCH.to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn entries_after_filters_by_cursor_and_caps() {
        let text = "[10] panic: a at x.rs:1 (thread t)\n\
                    garbage line\n\
                    [20] panic: b at y.rs:2 (thread t)\n\
                    [30] panic: c at z.rs:3 (thread t)\n";
        let all = entries_after(text, 0, 20);
        assert_eq!(all.len(), 3);
        let newer = entries_after(text, 10, 20);
        assert_eq!(newer.iter().map(|e| e.ts).collect::<Vec<_>>(), vec![20, 30]);
        let capped = entries_after(text, 0, 1);
        assert_eq!(capped.len(), 1);
        assert_eq!(capped[0].ts, 30);
    }

    #[test]
    fn crash_line_carries_message_location_and_thread() {
        let line = crash_line(
            1_700_000_000,
            "attempt to subtract with overflow",
            "src/recording.rs:480",
            "worker",
        );
        assert_eq!(
            line,
            "[1700000000] panic: attempt to subtract with overflow \
             at src/recording.rs:480 (thread worker)"
        );
    }

    /// A multi-line panic (assert_eq!) must stay ONE log line, or a single
    /// crash reads as several.
    #[test]
    fn multi_line_panic_messages_are_folded_onto_one_line() {
        let line = crash_line(
            1,
            "assertion failed\n  left: 1\n right: 2",
            "a.rs:1",
            "main",
        );
        assert_eq!(line.lines().count(), 1);
        assert!(line.contains("⏎"));
    }

    #[test]
    fn payload_message_reads_both_str_and_string() {
        let s: Box<dyn std::any::Any + Send> = Box::new("boom");
        assert_eq!(payload_message(s.as_ref()), "boom");
        let s: Box<dyn std::any::Any + Send> = Box::new("boom".to_string());
        assert_eq!(payload_message(s.as_ref()), "boom");
        let s: Box<dyn std::any::Any + Send> = Box::new(7u8);
        assert_eq!(payload_message(s.as_ref()), "<non-string panic payload>");
    }
}
