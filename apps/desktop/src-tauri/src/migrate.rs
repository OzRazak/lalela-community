//! One-time migration of app data from the Clio-era identifier
//! (`digital.auxo.clio`) to `digital.auxo.lalela` (2026-07 product rename).
//!
//! Best-effort by design: every step logs and bails rather than panicking, and
//! a failed move leaves the old directory untouched so nothing is ever lost —
//! worst case the app starts fresh and the old data stays recoverable on disk.
//! Desktop only; nothing shipped on iOS under the old identifier.

#[cfg(desktop)]
pub fn migrate_from_clio(new_dir: &std::path::Path) {
    use std::fs;

    // The Community edition has its own identifier and never shipped as Clio:
    // it must not adopt (move) the official app's data.
    if cfg!(lalela_community) {
        let _ = new_dir;
        return;
    }

    let new_db = new_dir.join("lalela.db");
    if !new_db.exists() {
        if let Some(parent) = new_dir.parent() {
            let old_dir = parent.join("digital.auxo.clio");
            if old_dir.join("clio.db").exists() {
                // Tauri may have pre-created an empty new dir; clear it so the
                // atomic rename below can land. A non-empty new dir means the
                // user already has Lalela data — never clobber it.
                if new_dir.exists() {
                    let empty = fs::read_dir(new_dir)
                        .map(|mut d| d.next().is_none())
                        .unwrap_or(false);
                    if empty {
                        let _ = fs::remove_dir(new_dir);
                    } else {
                        eprintln!(
                            "[migrate] {} is not empty; leaving Clio data in place",
                            new_dir.display()
                        );
                        return;
                    }
                }
                match fs::rename(&old_dir, new_dir) {
                    Ok(()) => {
                        // Covers clio.db, models/, cloud/, logs/ in one move.
                        if let Err(e) = fs::rename(new_dir.join("clio.db"), &new_db) {
                            eprintln!("[migrate] db rename failed: {e}");
                        } else {
                            eprintln!("[migrate] app data moved from digital.auxo.clio");
                        }
                    }
                    Err(e) => {
                        eprintln!("[migrate] app-data move failed (old dir untouched): {e}");
                        return;
                    }
                }
            }
        }
    }

    // The WebKit data store (localStorage: settings, API key, prompts) and
    // caches are also keyed on the bundle identifier. The webview origin
    // (tauri://localhost) is unchanged, so keys survive the directory move.
    let home = std::env::var("HOME").unwrap_or_default();
    for sub in ["Library/WebKit", "Library/Caches"] {
        let old = std::path::Path::new(&home).join(sub).join("digital.auxo.clio");
        let new = std::path::Path::new(&home).join(sub).join("digital.auxo.lalela");
        if old.exists() && !new.exists() {
            if let Err(e) = fs::rename(&old, &new) {
                eprintln!("[migrate] {sub} move failed: {e}");
            }
        }
    }
}
