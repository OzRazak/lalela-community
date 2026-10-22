//! Generic secret custody in the platform keychain (Slice 9).
//!
//! Named commands (`secret_set` / `secret_get` / `secret_delete`) rather than
//! provider-specific ones so future connections (Google Calendar, …) reuse the
//! same custody path. The first consumer is the Microsoft connection
//! (`src/lib/msauth.ts`), which stores its OAuth refresh token under service
//! "digital.auxo.lalela" — never in localStorage or SQLite.
//!
//! Desktop-only: the `keyring` crate talks to the macOS Keychain
//! (`apple-native`) and to the Windows Credential Manager (`windows-native`) —
//! same crate, same service name, same call sites (docs/WINDOWS.md 1.1). Other
//! targets return a clear error; iOS never registers these commands (see
//! lib.rs).

#[tauri::command]
pub fn secret_set(service: String, account: String, value: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        keyring::Entry::new(&service, &account)
            .and_then(|e| e.set_password(&value))
            .map_err(|e| format!("keychain write failed: {e}"))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (service, account, value);
        Err("secure secret storage is only available on macOS and Windows".into())
    }
}

/// `Ok(None)` when no secret is stored — callers treat that as "not connected".
#[tauri::command]
pub fn secret_get(service: String, account: String) -> Result<Option<String>, String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        match keyring::Entry::new(&service, &account).and_then(|e| e.get_password()) {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(format!("keychain read failed: {e}")),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (service, account);
        Err("secure secret storage is only available on macOS and Windows".into())
    }
}

/// Deleting a secret that doesn't exist is fine (idempotent disconnect).
#[tauri::command]
pub fn secret_delete(service: String, account: String) -> Result<(), String> {
    #[cfg(any(target_os = "macos", target_os = "windows"))]
    {
        match keyring::Entry::new(&service, &account).and_then(|e| e.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(format!("keychain delete failed: {e}")),
        }
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let _ = (service, account);
        Err("secure secret storage is only available on macOS and Windows".into())
    }
}
