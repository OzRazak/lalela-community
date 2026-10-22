//! Alternate app icon (Wave E1 follow-up) — macOS desktop only.
//!
//! A cosmetic reward: the same honor-system share/donate unlock as the themes
//! and badges (`src/lib/cosmetics.ts`) lets a user pick a re-coloured Lalela
//! mark. Nothing functional is ever gated — this is purely a look.
//!
//! IMPORTANT SCOPE CAVEAT (documented in docs/DECISIONS.md): this swaps the
//! **running app's Dock icon** by setting `-[NSApplication applicationIconImage:]`
//! at runtime. It does NOT change the static `.icns` inside the bundle — so the
//! Finder icon, the icon in a fresh Dock before launch, and Cmd-Tab before the
//! swap applies all stay the stock mark. A true alternate *bundle* icon would
//! need per-variant `.icns` files + `CFBundleAlternateIcons` (an iOS concept;
//! macOS has no first-party alternate-icon API), which is out of scope for v1.
//! The runtime swap re-applies on every launch, so the chosen icon is what the
//! user sees in the Dock the whole time the app is open.
//!
//! Why the whole module is `#[cfg(target_os = "macos")]`: `NSApplication` /
//! `NSImage` / `NSData` are AppKit, and `objc2` (with the exception feature) is a
//! macOS-only dep in Cargo.toml. Keeping this macOS-only keeps the
//! `aarch64-apple-ios` check and the (planned) Windows/Linux builds clean; the
//! iOS/other-desktop command wrappers in `commands.rs` are inert.

use objc2::rc::autoreleasepool;
use objc2::runtime::AnyObject;
use objc2::{class, msg_send};
use tauri::{AppHandle, Manager};

use crate::commands::AppState;
use crate::store;

/// SQLite `settings` key holding the active icon id. Source of truth for the
/// launch-time re-apply (Rust owns applying the icon, so it persists here rather
/// than in the frontend's localStorage where the unlock *ledger* lives).
pub const KEY_ACTIVE: &str = "cosmetics.app_icon";

/// The stock icon id — resets the running icon back to the bundle's `.icns`.
pub const DEFAULT_ID: &str = "default";

// The variant PNGs, embedded at compile time so the swap works identically in
// `tauri dev` and the packaged `.app` (no resource-dir lookup, no missing-file
// path). 512×512 (the source icon's native size) — ~24 KB each. Hue-rotated
// from `icons/icon.png`; the near-black canvas and white dot are unchanged
// (they carry no saturation), so only the sound-wave bars re-colour.
// Ids are unique across the whole cosmetics unlock ledger (the teal icon is
// "aqua", not "ocean", so it never shares an unlock with the Ocean *theme*).
const AQUA: &[u8] = include_bytes!("../icons/alt/aqua-512.png");
const CORAL: &[u8] = include_bytes!("../icons/alt/coral-512.png");
const VIOLET: &[u8] = include_bytes!("../icons/alt/violet-512.png");

/// The embedded bytes for a variant id, or `None` for the stock icon (which is
/// applied by resetting `applicationIconImage` to `nil`). Unknown ids fall back
/// to the stock icon, so a stale/garbage setting can never wedge the launch.
fn bytes_for(id: &str) -> Option<&'static [u8]> {
    match id {
        "aqua" => Some(AQUA),
        "coral" => Some(CORAL),
        "violet" => Some(VIOLET),
        _ => None, // "default" or anything unrecognised → stock .icns
    }
}

/// Whether `id` names a variant we can actually apply (used to validate before
/// persisting so we never store an id that would silently no-op at launch).
fn is_known(id: &str) -> bool {
    id == DEFAULT_ID || bytes_for(id).is_some()
}

/// The persisted active icon id (defaults to the stock icon).
pub fn active_id(app: &AppHandle) -> String {
    app.try_state::<AppState>()
        .and_then(|state| state.db.lock().ok().and_then(|c| store::get_setting(&c, KEY_ACTIVE)))
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_ID.to_string())
}

/// Persist the choice and apply it to the running Dock icon immediately.
/// Validates the id first so an unknown value never lands in the settings K/V.
pub fn set_active(app: &AppHandle, id: &str) -> Result<(), String> {
    if !is_known(id) {
        return Err(format!("unknown app icon {id:?}"));
    }
    {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(|_| "state poisoned")?;
        store::set_setting(&conn, KEY_ACTIVE, id)?;
    }
    apply(app, id)
}

/// Re-apply the persisted icon at startup (called from `lib.rs` setup, after
/// AppState is managed). A no-op for the default id — the bundle already shows
/// the stock icon, so there's nothing to swap.
pub fn init_from_settings(app: &AppHandle) {
    let id = active_id(app);
    if id == DEFAULT_ID {
        return;
    }
    if let Err(e) = apply(app, &id) {
        eprintln!("app_icon: could not apply {id:?} at launch: {e}");
    }
}

/// Set `-[NSApplication applicationIconImage:]` to the variant (or `nil` to
/// restore the stock icon). Runs on the main thread (an AppKit UI mutation)
/// inside an Objective-C exception barrier — a re-colour of the Dock icon must
/// never abort the host app, mirroring `dictation.rs`'s guarantee.
fn apply(app: &AppHandle, id: &str) -> Result<(), String> {
    let bytes = bytes_for(id);
    crate::commands::run_on_main(app, move || {
        objc2::exception::catch(move || unsafe {
            autoreleasepool(|_| {
                let ns_app: *mut AnyObject = msg_send![class!(NSApplication), sharedApplication];
                if ns_app.is_null() {
                    return;
                }
                // Some(bytes) → build an NSImage from the embedded PNG; None →
                // pass nil, which AppKit treats as "revert to the bundle icon".
                let image: *mut AnyObject = match bytes {
                    Some(b) => {
                        let data: *mut AnyObject = msg_send![
                            class!(NSData),
                            dataWithBytes: b.as_ptr() as *const std::ffi::c_void,
                            length: b.len(),
                        ];
                        if data.is_null() {
                            std::ptr::null_mut()
                        } else {
                            let alloc: *mut AnyObject = msg_send![class!(NSImage), alloc];
                            msg_send![alloc, initWithData: data]
                        }
                    }
                    None => std::ptr::null_mut(),
                };
                let _: () = msg_send![ns_app, setApplicationIconImage: image];
            })
        })
        .map_err(|exc| {
            let detail = exc
                .map(|e| format!("{e:?}"))
                .unwrap_or_else(|| "nil NSException".to_string());
            eprintln!("app_icon: setApplicationIconImage: threw: {detail}");
            "setting the app icon raised an Objective-C exception".to_string()
        })
    })
    .map_err(|e| format!("could not reach the main thread to set the app icon: {e}"))?
}
