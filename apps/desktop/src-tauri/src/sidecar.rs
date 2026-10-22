//! Locate bundled sidecar helper binaries (the Swift `lalela-systemaudio` /
//! `lalela-detect` tools).
//!
//! In a distributed `Lalela.app` the helpers sit next to the main binary in
//! `Contents/MacOS/`. In `cargo run` / examples they don't, so we fall back to
//! the absolute path `build.rs` baked in at compile time (an `OUT_DIR` path).

use std::path::PathBuf;

/// Append the platform executable suffix (`.exe` on Windows, nothing
/// elsewhere) unless the name already carries it. Sidecars are named without
/// a suffix at every call site; on Windows the file on disk is `name.exe`.
pub fn exe_name(name: &str) -> String {
    let suffix = std::env::consts::EXE_SUFFIX;
    if suffix.is_empty() || name.ends_with(suffix) {
        name.to_string()
    } else {
        format!("{name}{suffix}")
    }
}

/// The path a bundled sidecar is expected at: beside the running executable.
/// Used for diagnostics ("not found — looked in …").
#[cfg(desktop)]
pub fn bundled_path(name: &str) -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    Some(exe.parent()?.join(exe_name(name)))
}

/// Resolve a sidecar by file name, preferring one next to the running
/// executable (the bundled case), else the compile-time `build_path`.
/// Returns `None` if neither exists. `name` is given WITHOUT an executable
/// suffix; `.exe` is appended on Windows.
pub fn resolve(name: &str, build_path: &str) -> Option<PathBuf> {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let candidate = dir.join(exe_name(name));
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    if !build_path.is_empty() {
        let candidate = PathBuf::from(build_path);
        if candidate.exists() {
            return Some(candidate);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exe_name_appends_platform_suffix_once() {
        let suffix = std::env::consts::EXE_SUFFIX;
        assert_eq!(exe_name("lalela-llm"), format!("lalela-llm{suffix}"));
        let already = format!("lalela-llm{suffix}");
        assert_eq!(exe_name(&already), already);
    }
}
