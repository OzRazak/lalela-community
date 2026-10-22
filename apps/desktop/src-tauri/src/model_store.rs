//! Enumerate + classify the on-device model files for the "Manage local models"
//! Storage UI (desktop only). A resource audit found ~5.8 GB of downloaded
//! weights (three full local LLMs + whisper GGML + ONNX diarization models) that
//! nothing ever prunes — this module is the read side that lets the user see and
//! reclaim that space.
//!
//! The classification and label logic is pure (filesystem + strings only) so it
//! is unit-testable without a running app. The state-aware guards — unload the
//! resident LLM, refuse while a recording is live — live on the Tauri commands
//! in `commands.rs`; deletion validates paths against these same directories.

#![cfg(desktop)]

use std::path::PathBuf;

use serde::Serialize;
use tauri::AppHandle;

/// One model file found on disk in a model directory.
#[derive(Serialize, Clone)]
pub struct LocalModelFile {
    /// Bare file name, e.g. `gemma-3-4b-it-Q4_K_M.gguf`.
    pub file: String,
    /// Absolute path (what `delete_local_model` is called with).
    pub path: String,
    pub size_bytes: u64,
    /// `"llm"` (GGUF) · `"asr"` (whisper GGML) · `"diarization"` (ONNX).
    pub kind: &'static str,
    /// Best-effort friendly name. The frontend enriches LLM entries from the
    /// `LOCAL_MODEL_CATALOG`; this is the fallback (and the truth for whisper /
    /// diarization, which have no frontend catalog entry).
    pub label: String,
    /// The whisper base model transcription needs — the UI flags it as
    /// "needed for transcription — will re-download".
    pub is_base_asr: bool,
    /// Set by the command layer: this file is loaded in the LLM sidecar, or its
    /// engine is active in a live recording. The UI disables its Delete button.
    pub in_use: bool,
}

/// The whole on-disk model inventory for the Storage UI.
#[derive(Serialize)]
pub struct LocalModelList {
    pub models: Vec<LocalModelFile>,
    pub total_bytes: u64,
    /// The directory that was enumerated (shown in the UI as the storage location).
    pub dir: String,
}

/// The canonical model directory — the shared, download-once cache on macOS
/// (`~/Library/Application Support/digital.auxo.shared/models/`), else the
/// per-app `models/` dir. This is where the app reads and writes models today;
/// on macOS it has already adopted (hard-linked) anything from the legacy dir,
/// so enumerating it alone is complete.
pub fn primary_dir(app: &AppHandle) -> Result<PathBuf, String> {
    crate::local_llm::models_dir(app)
}

/// Every directory that may hold app-owned model files: the canonical dir plus
/// the legacy per-app `models/` dir. On macOS the shared cache adopts legacy
/// downloads by *hard-link*, so a pre-shared-cache file can have a twin in the
/// per-app dir that pins the same disk blocks until it too is removed. Deletion
/// validates against — and cleans — every entry here. On other desktop OSes the
/// two collapse to one (deduped).
pub fn model_dirs(app: &AppHandle) -> Result<Vec<PathBuf>, String> {
    let mut dirs = vec![primary_dir(app)?];
    let legacy = crate::paths::app_data_dir(app)?.join("models");
    if !dirs.contains(&legacy) {
        dirs.push(legacy);
    }
    Ok(dirs)
}

/// Classify a bare file name into `(kind, is_base_asr)`, or `None` to skip it
/// (partials, dotfiles, the manifest, logs, anything unrecognised).
pub fn classify(name: &str) -> Option<(&'static str, bool)> {
    if name.starts_with('.') {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    if lower.ends_with(".part") || lower.ends_with(".tmp") {
        return None;
    }
    if lower.ends_with(".gguf") {
        return Some(("llm", false));
    }
    if lower.ends_with(".onnx") {
        return Some(("diarization", false));
    }
    // Whisper GGML weights are `ggml-<name>.bin`; keep the net narrow so we never
    // list an unrelated `.bin` a sibling app happened to drop in the shared cache.
    if lower.starts_with("ggml-") && lower.ends_with(".bin") {
        return Some(("asr", name == crate::models::MODEL_FILE));
    }
    None
}

/// Best-effort friendly name for a recognised model file.
pub fn friendly_label(name: &str, kind: &str) -> String {
    match kind {
        // ggml-base.en.bin -> "Whisper base.en"
        "asr" => {
            let stem = name.strip_prefix("ggml-").unwrap_or(name);
            let stem = stem.strip_suffix(".bin").unwrap_or(stem);
            format!("Whisper {stem}")
        }
        "diarization" => match name {
            crate::models::SEG_MODEL_FILE => "Speaker segmentation (pyannote)".to_string(),
            crate::models::EMB_MODEL_FILE => "Speaker voiceprints (TitaNet)".to_string(),
            _ => name.strip_suffix(".onnx").unwrap_or(name).to_string(),
        },
        // The frontend overrides this with the catalog label when it recognises
        // the file; the stripped name is a sane fallback for anything else.
        "llm" => name.strip_suffix(".gguf").unwrap_or(name).to_string(),
        _ => name.to_string(),
    }
}

/// Enumerate every recognised model file in the canonical model directory,
/// sorted largest-first, with a running total. `in_use` is left `false` here and
/// filled by the command layer, which knows the loaded LLM + recording state.
pub fn list(app: &AppHandle) -> Result<LocalModelList, String> {
    let dir = primary_dir(app)?;
    let mut models: Vec<LocalModelFile> = Vec::new();
    let mut total: u64 = 0;
    if let Ok(entries) = std::fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() {
                continue;
            }
            let name = match path.file_name().and_then(|n| n.to_str()) {
                Some(n) => n.to_string(),
                None => continue,
            };
            let Some((kind, is_base_asr)) = classify(&name) else {
                continue;
            };
            let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            total += size;
            models.push(LocalModelFile {
                label: friendly_label(&name, kind),
                file: name,
                path: path.to_string_lossy().into_owned(),
                size_bytes: size,
                kind,
                is_base_asr,
                in_use: false,
            });
        }
    }
    models.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));
    Ok(LocalModelList {
        models,
        total_bytes: total,
        dir: dir.to_string_lossy().into_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_known_kinds() {
        assert_eq!(classify("gemma-3-4b-it-Q4_K_M.gguf"), Some(("llm", false)));
        assert_eq!(classify("pyannote-segmentation-3.0.onnx"), Some(("diarization", false)));
        // The default whisper base model is flagged is_base_asr = true.
        assert_eq!(classify(crate::models::MODEL_FILE), Some(("asr", true)));
        assert_eq!(classify("ggml-small.en.bin"), Some(("asr", false)));
    }

    #[test]
    fn skips_non_model_files() {
        assert_eq!(classify("index.json"), None);
        assert_eq!(classify(".DS_Store"), None);
        assert_eq!(classify("gemma-3-4b-it-Q4_K_M.gguf.part"), None);
        assert_eq!(classify("lalela-llm.log"), None);
        // A stray non-ggml .bin must not be mistaken for a whisper model.
        assert_eq!(classify("random.bin"), None);
    }

    #[test]
    fn friendly_labels() {
        assert_eq!(friendly_label("ggml-base.en.bin", "asr"), "Whisper base.en");
        assert_eq!(
            friendly_label(crate::models::EMB_MODEL_FILE, "diarization"),
            "Speaker voiceprints (TitaNet)"
        );
        assert_eq!(
            friendly_label("Qwen3-4B-Q4_K_M.gguf", "llm"),
            "Qwen3-4B-Q4_K_M"
        );
    }
}
