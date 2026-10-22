//! See Cargo.toml: a stand-in for the private `auxo-model-cache` crate, used
//! by the private repo's Windows CI patch and by the open-source Community
//! edition. Every call site is `#[cfg(target_os = "macos")]`.

use std::path::PathBuf;

/// Mirrors the real crate's signature. Always `Err` on purpose: callers fall
/// back to their own per-app models directory, which is exactly the behaviour
/// every non-macOS target already has.
pub fn shared_dir_adopting(_legacy_dirs: &[PathBuf]) -> Result<PathBuf, String> {
    Err("the shared model cache is not available in this build".into())
}
