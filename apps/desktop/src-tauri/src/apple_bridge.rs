//! In-process Rust↔Swift bridge to Apple's on-device AI on **iOS**.
//!
//! On macOS, Apple Intelligence runs in two out-of-process Swift helpers that
//! speak NDJSON over stdio (`src/apple_llm.rs`, `src/asr/apple_engine.rs`). iOS
//! App Store apps can't spawn child processes, so instead the Swift lives inside
//! the app target (`gen/apple/Sources/lalela/AppleAIBridge.swift`) and exposes a
//! tiny hand-rolled C ABI. This module is the Rust half of that ABI: it hands the
//! Swift side the EXACT SAME JSON request objects the NDJSON helpers use and gets
//! back the same reply objects — one request in, one reply out. Phases 4/5 reuse
//! this transport unchanged; only the ops they fill in differ.
//!
//! The two `@_cdecl` symbols resolve at app-link time (Swift compiles into the
//! same executable as this static lib). At `cargo check`/`cargo build --target
//! aarch64-apple-ios` they are simply undefined externs — that's fine, a
//! staticlib is not fully linked until Xcode links the app. Everything here is
//! `#![cfg(target_os = "ios")]` so macOS/desktop builds never see it.

#![cfg(target_os = "ios")]

use std::ffi::{CStr, CString};
use std::os::raw::c_char;

extern "C" {
    /// Swift `lalela_apple_ai_request`: JSON request string in, malloc'd JSON
    /// reply string out (NULL only on catastrophic allocation failure). The
    /// caller owns the returned buffer and must free it via the fn below.
    fn lalela_apple_ai_request(req: *const c_char) -> *mut c_char;
    /// Swift `lalela_apple_ai_free`: free a reply buffer returned above.
    fn lalela_apple_ai_free(p: *mut c_char);
}

/// One request in, one reply out. Serialises `body` to JSON, crosses into Swift,
/// copies the reply out, and ALWAYS frees the Swift-owned buffer before
/// returning — regardless of whether parsing the reply succeeds.
pub fn request(body: &serde_json::Value) -> Result<serde_json::Value, String> {
    let json = body.to_string();
    let c_req = CString::new(json)
        .map_err(|e| format!("apple bridge request had interior NUL: {e}"))?;

    // SAFETY: `c_req` is a valid NUL-terminated C string that stays alive across
    // the call; Swift copies its bytes immediately and returns either NULL or a
    // malloc'd NUL-terminated buffer that becomes ours to free.
    let reply_ptr = unsafe { lalela_apple_ai_request(c_req.as_ptr()) };
    if reply_ptr.is_null() {
        return Err("apple bridge returned null".into());
    }

    // Copy the reply out first, THEN free — so the buffer is released on every
    // path, even a non-UTF-8 reply.
    // SAFETY: `reply_ptr` is a non-null, Swift-malloc'd, NUL-terminated C string.
    let owned = unsafe { CStr::from_ptr(reply_ptr) }
        .to_str()
        .map(str::to_owned)
        .map_err(|e| format!("apple bridge reply was not UTF-8: {e}"));
    // SAFETY: `reply_ptr` came from the matching Swift allocator and is freed
    // exactly once here.
    unsafe { lalela_apple_ai_free(reply_ptr) };

    let owned = owned?;
    serde_json::from_str(&owned).map_err(|e| format!("apple bridge bad reply: {e}"))
}

/// Diagnostic health-check command: round-trips `{"op":"ping"}` through the
/// bridge and returns the raw reply (`{"ok":true,"pong":true}`). Not surfaced in
/// the UI — it exists so the bridge is exercised end-to-end and, crucially, so
/// the Rust→Swift `extern "C"` references keep the `@_cdecl` symbols from being
/// dead-stripped at app link. Runs off the main thread (spawn_blocking) so it is
/// safe once Phases 4/5 route real (async, main-queue-hopping) Apple calls
/// through the same path. Phase 4/5 replace/extend this with the real commands.
#[tauri::command]
pub async fn apple_bridge_ping() -> Result<serde_json::Value, String> {
    tauri::async_runtime::spawn_blocking(|| request(&serde_json::json!({ "op": "ping" })))
        .await
        .map_err(|e| format!("apple bridge task failed: {e}"))?
}
