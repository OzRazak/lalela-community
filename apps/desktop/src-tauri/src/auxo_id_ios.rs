//! "Continue with Auxo ID" on iPhone/iPad — Rust half of the in-app browser
//! sheet (`gen/apple/Sources/lalela/AuxoIdAuthSession.swift`).
//!
//! The Mac app gets the sign-in back through a 127.0.0.1 loopback listener
//! (`msoauth.rs`); iOS suspends the app while Safari is in front, so instead
//! the web flow runs inside an `ASWebAuthenticationSession` that watches for
//! the `lalela` callback scheme and returns the final
//! `lalela://auxo-id?code=…&state=…` URL. The frontend then validates the state
//! and redeems the code exactly as on the Mac (`auxoIdDesktopCore.ts`).
//!
//! The Swift `@_cdecl` symbols resolve at app-link time (same as
//! `apple_bridge.rs`); `cargo check --target aarch64-apple-ios` just sees
//! undefined externs. iOS only.

#![cfg(target_os = "ios")]

use std::collections::HashMap;
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Mutex, OnceLock};

type Done = extern "C" fn(ctx: u64, url: *const c_char, error: *const c_char);

extern "C" {
    fn lalela_auxo_id_auth_start(url: *const c_char, scheme: *const c_char, ctx: u64, done: Done);
    fn lalela_auxo_id_auth_cancel();
}

/// The only callback scheme the sheet may complete on (the web app's
/// IOS_RETURN_URL is `lalela://auxo-id`).
const CALLBACK_SCHEME: &str = "lalela";

type Waiters = Mutex<HashMap<u64, mpsc::Sender<Result<String, String>>>>;

fn waiters() -> &'static Waiters {
    static W: OnceLock<Waiters> = OnceLock::new();
    W.get_or_init(|| Mutex::new(HashMap::new()))
}

static NEXT_CTX: AtomicU64 = AtomicU64::new(1);

/// Called by Swift exactly once per start, on the main thread. Copies the
/// strings out immediately (they're only valid for this call).
extern "C" fn on_done(ctx: u64, url: *const c_char, error: *const c_char) {
    let read = |p: *const c_char| -> Option<String> {
        if p.is_null() {
            None
        } else {
            // SAFETY: Swift passes a NUL-terminated string valid for this call.
            Some(unsafe { CStr::from_ptr(p) }.to_string_lossy().into_owned())
        }
    };
    let result = match read(url) {
        Some(u) => Ok(u),
        None => Err(read(error).unwrap_or_else(|| "failed".into())),
    };
    if let Some(tx) = waiters().lock().ok().and_then(|mut w| w.remove(&ctx)) {
        let _ = tx.send(result);
    }
}

/// Open `url` (the web app's /api/auth/auxo-id/desktop?return=ios… start URL)
/// in an in-app ASWebAuthenticationSession and resolve with the `lalela://`
/// callback URL. Errors are the Swift codes: "cancelled" (user closed the
/// sheet, or `auxo_id_web_auth_cancel`), "busy", "no_window", "start_failed",
/// "bad_url", or "failed: …".
#[tauri::command]
pub async fn auxo_id_web_auth(url: String) -> Result<String, String> {
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err("bad_url".into());
    }
    let c_url = CString::new(url).map_err(|_| "bad_url".to_string())?;
    let c_scheme = CString::new(CALLBACK_SCHEME).expect("static scheme has no NUL");
    let ctx = NEXT_CTX.fetch_add(1, Ordering::Relaxed);
    let (tx, rx) = mpsc::channel();
    waiters()
        .lock()
        .map_err(|_| "failed: lock poisoned".to_string())?
        .insert(ctx, tx);
    // SAFETY: both C strings outlive the call; Swift copies them before
    // returning and calls `on_done` (a 'static fn) exactly once later.
    unsafe { lalela_auxo_id_auth_start(c_url.as_ptr(), c_scheme.as_ptr(), ctx, on_done) };
    tauri::async_runtime::spawn_blocking(move || {
        rx.recv().unwrap_or_else(|_| Err("failed: no result".into()))
    })
    .await
    .map_err(|e| format!("failed: {e}"))?
}

/// Dismiss a live sheet (the app's own Cancel button). Its pending
/// `auxo_id_web_auth` resolves with "cancelled". No-op when none is open.
#[tauri::command]
pub fn auxo_id_web_auth_cancel() {
    // SAFETY: no arguments; Swift hops to the main queue itself.
    unsafe { lalela_auxo_id_auth_cancel() };
}
