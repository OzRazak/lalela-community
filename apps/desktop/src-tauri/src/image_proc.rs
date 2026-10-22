//! Capture post-processing (Intelligence Layer, Slice 4): resize → WebP →
//! perceptual hash. Pure functions over the pure-Rust `image` crate (decode/
//! resize/hash) + libwebp via the `webp` crate for lossy encoding (the `image`
//! crate only writes lossless WebP, which is far too large for slide frames).
//!
//! The dHash + hamming distance drive the change-triggered sampler: save a
//! frame only when it is STABLE (equal-ish to the previous sample — not mid
//! animation/scroll) and CHANGED (differs from the last saved frame).

use std::path::Path;

use image::codecs::jpeg::JpegEncoder;
use image::imageops::FilterType;
use image::{DynamicImage, ExtendedColorType, ImageEncoder};

/// Longest edge of a saved capture. 1600px keeps slide text legible while
/// staying ~100–200 KB as WebP.
pub const MAX_WIDTH: u32 = 1600;

/// WebP quality for saved captures.
pub const WEBP_QUALITY: f32 = 80.0;

/// Two consecutive samples within this dHash distance = the frame is stable
/// (not mid-transition). 64-bit hash; identical frames are 0.
pub const STABLE_BITS: u32 = 4;

/// A sample must differ from the LAST SAVED frame by more than this to count
/// as new content (talking-head video jitters a few bits; a slide change is
/// typically 20+).
pub const CHANGED_BITS: u32 = 10;

pub fn decode(path: &Path) -> Result<DynamicImage, String> {
    image::open(path).map_err(|e| format!("could not decode capture: {e}"))
}

/// Difference hash: grayscale 9×8, each bit = "pixel brighter than its right
/// neighbour". Robust to resizing/compression, cheap, no deps.
pub fn dhash(img: &DynamicImage) -> u64 {
    let small = img.resize_exact(9, 8, FilterType::Triangle).to_luma8();
    let mut hash: u64 = 0;
    for y in 0..8 {
        for x in 0..8 {
            hash <<= 1;
            if small.get_pixel(x, y)[0] > small.get_pixel(x + 1, y)[0] {
                hash |= 1;
            }
        }
    }
    hash
}

pub fn hamming(a: u64, b: u64) -> u32 {
    (a ^ b).count_ones()
}

/// Resize to ≤`MAX_WIDTH` and encode as lossy WebP.
pub fn to_webp(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let resized = if img.width() > MAX_WIDTH {
        img.resize(MAX_WIDTH, u32::MAX, FilterType::CatmullRom)
    } else {
        img.clone()
    };
    let rgba = resized.to_rgba8();
    let encoder = webp::Encoder::from_rgba(&rgba, rgba.width(), rgba.height());
    Ok(encoder.encode(WEBP_QUALITY).to_vec())
}

/// Longest edge of a Meeting Copilot screen-awareness frame (CP4). Smaller than
/// `MAX_WIDTH` (persisted slides): the copilot only needs the on-screen deck /
/// document legible, and a lighter JPEG keeps the one-shot multimodal request
/// fast. The frame is base64'd into an in-memory data URL and NEVER written to
/// disk.
pub const COPILOT_MAX_EDGE: u32 = 1200;

/// JPEG quality (1–100) for a copilot screen-awareness frame (CP4).
pub const COPILOT_JPEG_QUALITY: u8 = 70;

/// Downscale so the longest edge ≤ `max_edge` (preserving aspect ratio), then
/// encode lossy JPEG at `quality`. Used ONLY by the copilot's on-demand screen
/// capture (`copilot_capture_screen`): the returned bytes become an in-memory
/// `data:` URL and are never persisted.
pub fn to_jpeg_downscaled(
    img: &DynamicImage,
    max_edge: u32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let scaled = if img.width().max(img.height()) > max_edge {
        // `resize` fits WITHIN the box, so passing `max_edge` for both bounds
        // scales the long edge to `max_edge` and keeps the aspect ratio.
        img.resize(max_edge, max_edge, FilterType::CatmullRom)
    } else {
        img.clone()
    };
    let rgb = scaled.to_rgb8();
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, quality)
        .write_image(rgb.as_raw(), rgb.width(), rgb.height(), ExtendedColorType::Rgb8)
        .map_err(|e| format!("jpeg encode failed: {e}"))?;
    Ok(buf)
}

/// Consecutive changed-but-never-settling ticks after which the motion
/// fallback below may save (≈10 s at the recording view's 2.5 s tick).
pub const UNSETTLED_TICKS: u32 = 4;

/// The motion fallback saves only on a change this strong vs the last saved
/// frame: a real slide change is typically 20+ bits, while an embedded
/// video/webcam tile drifting over time stays under it — otherwise a busy
/// tile would force a save every debounce window.
pub const FORCED_CHANGE_BITS: u32 = 20;

/// Should this live tick's sample be saved? `prev` = the previous sample's
/// hash (stability check), `last_saved` = hash of the last saved frame
/// (novelty check), `unsettled` = consecutive prior ticks that were changed
/// but not settled. Returns `(save, new_unsettled)`.
///
/// Primary rule: save when SETTLED (within `STABLE_BITS` of the previous
/// sample — not mid-transition) and CHANGED (differs from the last save by
/// more than `CHANGED_BITS`). A window with continuous motion (webcam tile,
/// playing video, animated dashboard) may never settle though, which used to
/// keep a genuinely new slide behind that motion out of the record forever.
/// The fallback: after `UNSETTLED_TICKS` changed-but-unsettled ticks, save
/// anyway if the frame is at least scene-stable (≤ `CHANGED_BITS` of motion
/// per tick) and STRONGLY changed vs the last save (> `FORCED_CHANGE_BITS`).
pub fn should_save_tick(
    current: u64,
    prev: Option<u64>,
    last_saved: Option<u64>,
    unsettled: u32,
) -> (bool, u32) {
    let changed = last_saved.map_or(true, |s| hamming(current, s) > CHANGED_BITS);
    if !changed {
        return (false, 0);
    }
    let settled = prev.is_some_and(|p| hamming(current, p) <= STABLE_BITS);
    if settled {
        return (true, 0);
    }
    let unsettled = unsettled + 1;
    let scene_stable = prev.is_some_and(|p| hamming(current, p) <= CHANGED_BITS);
    let strong = last_saved.map_or(true, |s| hamming(current, s) > FORCED_CHANGE_BITS);
    if unsettled >= UNSETTLED_TICKS && scene_stable && strong {
        (true, 0)
    } else {
        (false, unsettled)
    }
}

/// The distinct screens shown across an ordered run of frame hashes (one per
/// fixed-interval sample of an imported video), as at most `max`
/// `(first, rep)` index pairs: `first` = the sample where that screen
/// appeared (use its timestamp), `rep` = the scene's final sample (a
/// progressively built slide ends complete — save/OCR that one).
///
/// Scene-based on purpose: adjacent samples within `CHANGED_BITS` belong to
/// the same scene. Real screen shares jitter (webcam tiles, cursors,
/// animations), so at import's sparse sampling a `should_save`-style
/// "settled into the next sample" test rejects nearly everything — a busy
/// hour-long recording yielded two slides. A scene whose representative
/// matches any already-kept slide is a revisit (flipping back to the deck)
/// and is dropped; over `max`, the longest-held scenes win — a slide held
/// for minutes beats a scroll flash.
pub fn slide_keyframes(hashes: &[u64], max: usize) -> Vec<(usize, usize)> {
    struct Scene {
        first: usize,
        last: usize,
        samples: usize,
    }
    let mut scenes: Vec<Scene> = Vec::new();
    for (i, &h) in hashes.iter().enumerate() {
        match scenes.last_mut() {
            Some(s) if hamming(h, hashes[s.last]) <= CHANGED_BITS => {
                s.last = i;
                s.samples += 1;
            }
            _ => scenes.push(Scene { first: i, last: i, samples: 1 }),
        }
    }
    let mut kept: Vec<Scene> = Vec::new();
    for s in scenes {
        if kept
            .iter()
            .all(|k| hamming(hashes[s.last], hashes[k.last]) > CHANGED_BITS)
        {
            kept.push(s);
        }
    }
    if kept.len() > max {
        kept.sort_by_key(|s| std::cmp::Reverse(s.samples));
        kept.truncate(max);
        kept.sort_by_key(|s| s.first);
    }
    kept.into_iter().map(|s| (s.first, s.last)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgba, RgbaImage};

    /// A synthetic "slide": light background with a dark block whose position
    /// is parameterized, so different `offset`s = visibly different content.
    fn slide(offset: u32) -> DynamicImage {
        let mut img = RgbaImage::from_pixel(1920, 1080, Rgba([240, 240, 240, 255]));
        for y in 100..500 {
            for x in offset..(offset + 600) {
                img.put_pixel(x, y, Rgba([20, 20, 60, 255]));
            }
        }
        DynamicImage::ImageRgba8(img)
    }

    #[test]
    fn slide_keyframes_keeps_one_representative_per_scene() {
        let a = dhash(&slide(100));
        let b = dhash(&slide(900));
        let c = dhash(&slide(500));
        // Slide A (held 3 samples) → B (held 2) → C (held 2): one per scene,
        // timestamped at the scene's first sample, imaged from its last.
        assert_eq!(
            slide_keyframes(&[a, a, a, b, b, c, c], 80),
            vec![(0, 2), (3, 4), (5, 6)]
        );
        // A static video yields exactly one slide.
        assert_eq!(slide_keyframes(&[a, a, a, a], 80), vec![(0, 3)]);
        assert_eq!(slide_keyframes(&[], 80), Vec::<(usize, usize)>::new());
    }

    /// Regression: a busy recording where every sample shows a different
    /// screen. The old settle-into-next test rejected all of them (only the
    /// final frame, having no successor, survived) — an hour-long screen
    /// share yielded two slides. Every distinct screen must be kept.
    #[test]
    fn slide_keyframes_captures_every_screen_of_a_busy_video() {
        // Synthetic hashes in disjoint bit blocks: pairwise distance ≥ 16.
        let (a, b, c, d) = (0u64, 0xFFFF, 0xFFFF_0000, 0xFFFF_FFFF_0000_0000);
        assert_eq!(
            slide_keyframes(&[a, b, c, d], 80),
            vec![(0, 0), (1, 1), (2, 2), (3, 3)]
        );
    }

    #[test]
    fn slide_keyframes_folds_jitter_dedupes_revisits_and_prefers_held_scenes() {
        let (a, b, c, d) = (0u64, 0xFFFF, 0xFFFF_0000, 0xFFFF_FFFF_0000_0000);
        // Webcam-tile/cursor jitter (≤ CHANGED_BITS) stays one scene, and the
        // representative is the scene's LAST sample (builds end complete).
        let a_jit = a ^ 0b11;
        assert_eq!(slide_keyframes(&[a, a_jit, b, b], 80), vec![(0, 1), (2, 3)]);
        // Flipping back to an already-captured screen is not a new slide.
        assert_eq!(slide_keyframes(&[a, a, b, a], 80), vec![(0, 1), (2, 2)]);
        // Over the cap, longest-held scenes win, returned in time order.
        assert_eq!(
            slide_keyframes(&[a, b, b, b, c, d, d], 2),
            vec![(1, 3), (5, 6)]
        );
    }

    #[test]
    fn copilot_jpeg_is_downscaled_to_long_edge_and_is_jpeg() {
        // 1920×1080 synthetic slide → long edge clamped to COPILOT_MAX_EDGE.
        let bytes =
            to_jpeg_downscaled(&slide(100), COPILOT_MAX_EDGE, COPILOT_JPEG_QUALITY).unwrap();
        // JPEG SOI marker (FF D8 FF …).
        assert_eq!(&bytes[0..3], &[0xFF, 0xD8, 0xFF]);
        let decoded = image::load_from_memory(&bytes).expect("valid jpeg");
        assert!(decoded.width().max(decoded.height()) <= COPILOT_MAX_EDGE);
        assert_eq!(decoded.width(), COPILOT_MAX_EDGE); // 1920 long edge → 1200
    }

    #[test]
    fn copilot_jpeg_leaves_small_images_unscaled() {
        // Below the cap: kept at native size, still valid JPEG.
        let small = DynamicImage::ImageRgba8(RgbaImage::from_pixel(800, 600, Rgba([10, 20, 30, 255])));
        let bytes = to_jpeg_downscaled(&small, COPILOT_MAX_EDGE, COPILOT_JPEG_QUALITY).unwrap();
        let decoded = image::load_from_memory(&bytes).expect("valid jpeg");
        assert_eq!((decoded.width(), decoded.height()), (800, 600));
    }

    #[test]
    fn identical_frames_hash_identically_and_different_slides_differ() {
        let a = slide(100);
        assert_eq!(hamming(dhash(&a), dhash(&slide(100))), 0);
        assert!(hamming(dhash(&a), dhash(&slide(900))) > CHANGED_BITS);
    }

    #[test]
    fn webp_output_is_webp_scaled_and_small() {
        let bytes = to_webp(&slide(100)).unwrap();
        // RIFF....WEBP container magic.
        assert_eq!(&bytes[0..4], b"RIFF");
        assert_eq!(&bytes[8..12], b"WEBP");
        assert!(bytes.len() < 200 * 1024, "capture should be well under 200KB, got {}", bytes.len());
        // Decode via libwebp (the `image` crate is built without webp support).
        let decoded = webp::Decoder::new(&bytes).decode().expect("valid webp");
        assert!(decoded.width() <= MAX_WIDTH);
    }

    #[test]
    fn sampler_saves_once_per_slide_and_never_mid_transition() {
        let s1 = dhash(&slide(100));
        let s2 = dhash(&slide(900));

        // First stable sighting of a slide: prev == current, nothing saved yet.
        assert_eq!(should_save_tick(s1, Some(s1), None, 0), (true, 0));
        // Held slide after saving: stable but unchanged → no re-save.
        assert_eq!(should_save_tick(s1, Some(s1), Some(s1), 0), (false, 0));
        // Mid-transition (prev differs): unstable → wait (counter ticks up).
        assert_eq!(should_save_tick(s2, Some(s1), Some(s1), 0), (false, 1));
        // New slide, stable for two samples → save.
        assert_eq!(should_save_tick(s2, Some(s2), Some(s1), 0), (true, 0));
    }

    /// Regression: a captured window with continuous motion (webcam tile,
    /// playing video) never fine-settles, so a new slide behind that motion
    /// was never saved. After UNSETTLED_TICKS the fallback saves a
    /// scene-stable, strongly-changed frame — but tile-only drift (a change
    /// vs the last save that never gets STRONG) must stay unsaved.
    #[test]
    fn sampler_motion_fallback_saves_new_slides_but_not_tile_drift() {
        let saved = 0u64;
        // Same slide as saved, plus a jittering tile: 12 bits from the save,
        // 8 bits of motion per tick. Changed but weak → counter climbs, no
        // save no matter how long it goes on.
        let tile_a = 0xFFF_u64; // 12 bits vs saved
        let tile_b = 0xFC3F_u64; // 12 bits vs saved, 8 vs tile_a
        let (save, u) = should_save_tick(tile_a, Some(tile_b), Some(saved), UNSETTLED_TICKS + 5);
        assert!(!save);
        assert_eq!(u, UNSETTLED_TICKS + 6);

        // A real slide change under the same motion: strongly changed
        // (> FORCED_CHANGE_BITS) and scene-stable → saved once the counter
        // has run its course, not before.
        let slide2_a = 0xFFFF_FF00_0000_000F_u64; // 28 bits vs saved
        let slide2_b = 0xFFFF_FF00_0000_03FF_u64; // 6 bits of tile motion vs slide2_a
        assert_eq!(
            should_save_tick(slide2_a, Some(slide2_b), Some(saved), 0),
            (false, 1)
        );
        let (save, u) = should_save_tick(slide2_a, Some(slide2_b), Some(saved), UNSETTLED_TICKS - 1);
        assert!(save);
        assert_eq!(u, 0);

        // Full-frame motion (nothing scene-stable, e.g. a fullscreen video)
        // still never force-saves random frames.
        let far = !slide2_a;
        let (save, _) = should_save_tick(slide2_a, Some(far), Some(saved), UNSETTLED_TICKS + 3);
        assert!(!save);
    }
}
