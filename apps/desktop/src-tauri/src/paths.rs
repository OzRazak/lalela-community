//! Central data-directory resolution.
//!
//! Everything that needs the app's data dir (the SQLite index, capture/staging
//! folders, downloaded models, sidecar logs, and the meeting save-root
//! fallback) goes through this module so a SINGLE env var can redirect the
//! whole instance at a scratch location — without touching the user's real
//! data.
//!
//! Set `LALELA_DATA_DIR` to run a fully isolated copy of the app (demo
//! recordings, screenshots, throwaway testing):
//!
//! ```sh
//! LALELA_DATA_DIR=/tmp/lalela-demo pnpm tauri dev
//! ```
//!
//! When the var is unset (the normal case) this falls back to Tauri's standard
//! per-OS `app_data_dir()`, so shipping builds are unaffected — but they honor
//! the override too, which is intentional and useful for on-device demos.

use std::path::PathBuf;

/// Environment variable that overrides the OS app-data directory.
pub const DATA_DIR_ENV: &str = "LALELA_DATA_DIR";

/// The `LALELA_DATA_DIR` override, if set (and non-empty) — created if missing.
/// Returns `None` in the normal case so callers fall back to the OS dir.
///
/// Reads the env var on every call; it is read once at startup in practice and
/// the app never mutates it, so there is no caching complexity to get wrong.
pub fn data_dir_override() -> Option<PathBuf> {
    let raw = std::env::var_os(DATA_DIR_ENV)?;
    if raw.is_empty() {
        return None;
    }
    let path = PathBuf::from(raw);
    // Best-effort create so the very first lookup can't fail on a missing dir;
    // if it fails the caller's own create_dir_all / DB open surfaces the error.
    let _ = std::fs::create_dir_all(&path);
    Some(path)
}

/// Resolve the app data directory, honoring [`DATA_DIR_ENV`]. Every in-app
/// `app_data_dir()` lookup routes through here.
pub fn app_data_dir<R: tauri::Runtime, M: tauri::Manager<R>>(
    manager: &M,
) -> Result<PathBuf, String> {
    if let Some(dir) = data_dir_override() {
        return Ok(dir);
    }
    manager.path().app_data_dir().map_err(|e| e.to_string())
}
