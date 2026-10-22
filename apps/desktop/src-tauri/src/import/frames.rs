//! Video slide extraction for audio imports (visual understanding).
//!
//! When an imported recording is a video, sample one frame every few seconds
//! via the bundled `lalela-frames` Swift helper (AVFoundation), segment the
//! run into distinct on-screen scenes by dHash distance (one representative
//! slide per scene — see `image_proc::slide_keyframes`), OCR each kept slide
//! with Apple Vision (fully on-device — nothing leaves the Mac), and hand
//! back staged WebP images whose captions carry the recognised slide text. The caller attaches them
//! to the meeting like live captures; captions join the FTS index so slides
//! are searchable.
//!
//! Strictly best-effort: a missing helper, an audio-only container, or an
//! unsupported one (AVFoundation cannot read mkv/webm) yields an empty list
//! and the import proceeds audio-only.

use std::path::Path;
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

/// Containers that may carry a visual track worth mining for slides.
const VIDEO_EXTENSIONS: &[&str] = &["mp4", "mkv", "webm"];

/// Seconds between sampled frames. Slides are held for many seconds; 5 s
/// keeps even an hour-long recording to ≤720 samples.
const FRAME_INTERVAL_SECS: u32 = 5;

/// Never attach more than this many slides to one meeting.
const MAX_SLIDES: usize = 80;

/// Caption cap so a text-dense slide can't bloat the meeting record.
const MAX_CAPTION_CHARS: usize = 2000;

/// True when the filename looks like a video container.
pub fn is_video_path(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| VIDEO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
}

/// A staged slide ready to be saved with the meeting: a WebP under the
/// app-data staging dir plus the OCR text destined for the image caption.
pub struct SlideImage {
    pub t_ms: i64,
    pub src_path: String,
    pub caption: String,
}

#[derive(Deserialize)]
struct OcrLine {
    path: String,
    text: String,
}

fn emit_status(app: &AppHandle, message: &str) {
    #[derive(serde::Serialize, Clone)]
    struct Status<'a> {
        state: &'static str,
        message: Option<&'a str>,
    }
    let _ = app.emit(
        "import://status",
        Status { state: "slides", message: Some(message) },
    );
}

/// Extract distinct, OCR-captioned slides from `video` into `staging`.
/// Best-effort; respects `cancel` between frames (keeping what's done).
pub fn extract_slides(
    app: &AppHandle,
    video: &Path,
    staging: &Path,
    cancel: &Arc<AtomicBool>,
) -> Vec<SlideImage> {
    let Some(bin) = crate::sidecar::resolve(
        "lalela-frames",
        option_env!("LALELA_FRAMES_BIN").unwrap_or(""),
    ) else {
        return Vec::new();
    };
    emit_status(app, "Reading slides from the video…");

    // Unique per-import scratch dir for the raw frames; removed before return.
    let tmp = staging.join(format!("frames-{}", crate::capture::image_id()));
    if std::fs::create_dir_all(&tmp).is_err() {
        return Vec::new();
    }
    let slides = extract_inner(app, &bin, video, staging, &tmp, cancel);
    let _ = std::fs::remove_dir_all(&tmp);
    slides
}

fn extract_inner(
    app: &AppHandle,
    bin: &Path,
    video: &Path,
    staging: &Path,
    tmp: &Path,
    cancel: &Arc<AtomicBool>,
) -> Vec<SlideImage> {
    // 1) Sample frames. Exit ≠ 0 = no video track / unsupported container.
    let ok = Command::new(bin)
        .arg("extract")
        .arg(video)
        .arg(tmp)
        .arg(FRAME_INTERVAL_SECS.to_string())
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        return Vec::new();
    }

    // 2) Collect frame-<t_ms>.jpg in time order.
    let mut frames: Vec<(i64, std::path::PathBuf)> = std::fs::read_dir(tmp)
        .map(|entries| {
            entries
                .flatten()
                .filter_map(|e| {
                    let p = e.path();
                    let name = p.file_name()?.to_str()?;
                    let t_ms: i64 = name.strip_prefix("frame-")?.strip_suffix(".jpg")?.parse().ok()?;
                    Some((t_ms, p))
                })
                .collect()
        })
        .unwrap_or_default();
    frames.sort_by_key(|(t, _)| *t);
    if frames.is_empty() {
        return Vec::new();
    }

    // 3) Reduce to one representative per distinct on-screen scene (dHash).
    // Each keeper is (first, rep): timestamp from where the screen appeared,
    // pixels/OCR from the scene's final sample.
    let mut decoded = Vec::with_capacity(frames.len());
    let mut hashes = Vec::with_capacity(frames.len());
    for (t_ms, path) in &frames {
        if cancel.load(Ordering::Relaxed) {
            return Vec::new();
        }
        let Ok(img) = crate::image_proc::decode(path) else { continue };
        hashes.push(crate::image_proc::dhash(&img));
        decoded.push((*t_ms, path.clone(), img));
    }
    let kept = crate::image_proc::slide_keyframes(&hashes, MAX_SLIDES);
    if kept.is_empty() {
        return Vec::new();
    }
    emit_status(app, &format!("Reading text on {} slide(s)…", kept.len()));

    // 4) OCR only the kept frames (one helper call; JSON line per image).
    let ocr_paths: Vec<&Path> = kept.iter().map(|&(_, rep)| decoded[rep].1.as_path()).collect();
    let mut text_by_path: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    if let Ok(out) = Command::new(bin).arg("ocr").args(&ocr_paths).output() {
        for line in String::from_utf8_lossy(&out.stdout).lines() {
            if let Ok(parsed) = serde_json::from_str::<OcrLine>(line) {
                text_by_path.insert(parsed.path, parsed.text);
            }
        }
    }

    // 5) Stage each kept slide as WebP with its OCR text as the caption.
    let mut slides = Vec::with_capacity(kept.len());
    for &(first, rep) in &kept {
        if cancel.load(Ordering::Relaxed) {
            break;
        }
        let t_ms = decoded[first].0;
        let (_, ref path, ref img) = decoded[rep];
        let Ok(bytes) = crate::image_proc::to_webp(img) else { continue };
        let dest = staging.join(crate::capture::capture_filename_ext("webp"));
        if std::fs::write(&dest, &bytes).is_err() {
            continue;
        }
        let mut caption = text_by_path
            .get(&path.to_string_lossy().to_string())
            .cloned()
            .unwrap_or_default()
            .trim()
            .to_string();
        if caption.len() > MAX_CAPTION_CHARS {
            let mut cut = MAX_CAPTION_CHARS;
            while !caption.is_char_boundary(cut) {
                cut -= 1;
            }
            caption.truncate(cut);
        }
        slides.push(SlideImage {
            t_ms,
            src_path: dest.to_string_lossy().to_string(),
            caption,
        });
    }
    slides
}
