//! watchOS companion ingest (iOS only at runtime; pure helpers are host-tested).
//!
//! The Apple Watch app (`gen/apple/LalelaWatch`) records mono 16 kHz PCM WAV and
//! hands each finished file to the paired iPhone over WatchConnectivity
//! `transferFile`. The iOS Swift receiver (`WatchConnectivityReceiver.swift`)
//! moves every delivered file into `<app_data_dir>/watch-inbox/`.
//!
//! This module drains that inbox on app launch and on foreground (see
//! `lib.rs`): decode (via `hound` — chosen because it is cross-platform, unlike
//! the desktop import's `symphonia`, which is gated off iOS) → whisper (the SAME
//! in-process `AsrEngine` the live iOS recorder uses) → `store::insert_meeting`,
//! then the inbox file is deleted. Watch recordings are single-mic, so there is
//! no diarization step (sherpa is desktop-only anyway).
//!
//! There is no new Swift→Rust call channel for ingest: the Swift side only files
//! the audio into a shared directory; Rust discovers it by scanning. Both sides
//! derive the directory from the OS Application Support location, so they agree.
//!
//! The module is compiled on iOS (where it runs) and under `test` (so the pure
//! decode/title helpers are exercised on the host); it is absent from the normal
//! desktop build, which has no watch inbox to drain.

use std::path::{Path, PathBuf};

use crate::transcribe::WHISPER_RATE;

/// Subdirectory of the app data dir the Swift receiver writes delivered watch
/// files into. MUST stay in lockstep with `watchInboxURL()` in
/// `WatchConnectivityReceiver.swift`.
pub const INBOX_DIRNAME: &str = "watch-inbox";

/// The filename prefix the watch app stamps onto every recording. The trailing
/// `YYYYMMDD-HHMMSS` is parsed back into the meeting title (no chrono dep).
const WATCH_PREFIX: &str = "lalela-watch-";

/// Chunks quieter than this RMS are treated as silence and skipped — same floor
/// the desktop audio-import path uses.
#[cfg(target_os = "ios")]
const SILENCE_RMS: f32 = 0.006;

#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
pub fn inbox_dir(data_dir: &Path) -> PathBuf {
    data_dir.join(INBOX_DIRNAME)
}

/// Decode a PCM/float WAV to 16 kHz mono f32. The watch already records mono
/// 16 kHz, so the resample is normally a no-op — but we downmix/resample
/// defensively so a differently-configured recorder still imports.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn decode_wav_16k(path: &Path) -> Result<(Vec<f32>, u32, i64), String> {
    let mut reader = hound::WavReader::open(path).map_err(|e| format!("open wav: {e}"))?;
    let spec = reader.spec();
    let channels = spec.channels.max(1) as usize;
    let source_rate = spec.sample_rate;

    let interleaved: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Int => {
            let max = (1i64 << (spec.bits_per_sample.saturating_sub(1))) as f32;
            reader
                .samples::<i32>()
                .filter_map(|s| s.ok())
                .map(|s| s as f32 / max)
                .collect()
        }
        hound::SampleFormat::Float => {
            reader.samples::<f32>().filter_map(|s| s.ok()).collect()
        }
    };
    if interleaved.is_empty() {
        return Err("no PCM samples in wav".into());
    }

    let mono = crate::audio::downmix_to_mono(&interleaved, channels);
    let samples_16k = if source_rate == WHISPER_RATE {
        mono
    } else {
        crate::audio::resample_to_16k(&mono, source_rate)
    };
    let duration_ms = (samples_16k.len() as i64) * 1000 / WHISPER_RATE as i64;
    Ok((samples_16k, source_rate, duration_ms))
}

/// Turn `lalela-watch-YYYYMMDD-HHMMSS.wav` into `Watch recording · YYYY-MM-DD
/// HH:MM`. Any other name falls back to a plain title.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn title_from_filename(name: &str) -> String {
    let stem = name
        .strip_suffix(".wav")
        .or_else(|| name.strip_suffix(".WAV"))
        .unwrap_or(name);
    if let Some(rest) = stem.strip_prefix(WATCH_PREFIX) {
        let parts: Vec<&str> = rest.split('-').collect();
        if parts.len() == 2
            && parts[0].len() == 8
            && parts[1].len() == 6
            && parts[0].bytes().all(|b| b.is_ascii_digit())
            && parts[1].bytes().all(|b| b.is_ascii_digit())
        {
            let (d, t) = (parts[0], parts[1]);
            return format!(
                "Watch recording · {}-{}-{} {}:{}",
                &d[0..4],
                &d[4..6],
                &d[6..8],
                &t[0..2],
                &t[2..4],
            );
        }
    }
    "Watch recording".to_string()
}

/// Peak-normalize a 16-bit PCM WAV in place toward −3 dBFS, boosting quiet
/// recordings by up to +20 dB. The watch mic sits far from the mouth and its
/// recordings come in quiet in noisy rooms; a gentle pre-whisper boost recovers
/// low-level speech. We NEVER attenuate (an already-loud file is left untouched)
/// and NEVER push the peak past the −3 dBFS target, so there is headroom and no
/// clipping. Any parse/IO error is swallowed — normalization is a best-effort
/// enhancement and must never fail (or delay) an import.
///
/// The rewrite goes through a sibling temp file whose name deliberately does
/// NOT end in `.wav`: the inbox scan filters on that extension, so an orphaned
/// partial (process killed between create and rename) is invisible to every
/// future scan instead of being counted and retried as a truncated recording.
#[cfg_attr(not(target_os = "ios"), allow(dead_code))]
fn normalize_wav_gain(path: &Path) {
    const TARGET_DBFS: f32 = -3.0;
    const MAX_GAIN_DB: f32 = 20.0;

    let mut reader = match hound::WavReader::open(path) {
        Ok(r) => r,
        Err(_) => return,
    };
    let spec = reader.spec();
    // Only the watch's canonical 16-bit integer PCM; anything else is left as-is.
    if spec.sample_format != hound::SampleFormat::Int || spec.bits_per_sample != 16 {
        return;
    }
    let samples: Vec<i16> = reader.samples::<i16>().filter_map(|s| s.ok()).collect();
    if samples.is_empty() {
        return;
    }
    let peak = samples
        .iter()
        .map(|s| (*s as i32).unsigned_abs())
        .max()
        .unwrap_or(0);
    if peak == 0 {
        return; // pure silence — nothing to normalize
    }

    let full_scale = i16::MAX as f32; // 32767
    let target_peak = full_scale * 10f32.powf(TARGET_DBFS / 20.0);
    let max_gain = 10f32.powf(MAX_GAIN_DB / 20.0);
    let gain = (target_peak / peak as f32).clamp(1.0, max_gain);
    if gain <= 1.0 + f32::EPSILON {
        return; // already at/above target — never attenuate
    }

    // Rewrite via a sibling temp file, then atomically swap it in. A failure at
    // any step leaves the original file untouched. Non-.wav extension on
    // purpose — see the doc comment: scans must never see a partial temp file.
    let tmp = path.with_extension("norm-tmp");
    let mut writer = match hound::WavWriter::create(&tmp, spec) {
        Ok(w) => w,
        Err(_) => return,
    };
    for s in &samples {
        let boosted = (*s as f32 * gain)
            .round()
            .clamp(i16::MIN as f32, i16::MAX as f32) as i16;
        if writer.write_sample(boosted).is_err() {
            let _ = std::fs::remove_file(&tmp);
            return;
        }
    }
    if writer.finalize().is_ok() {
        let _ = std::fs::rename(&tmp, path);
    } else {
        let _ = std::fs::remove_file(&tmp);
    }
}

// ===========================================================================
// iOS runtime wiring — the scan/import that drives the whisper engine and the
// SQLite store. Gated off the host build (which has no watch inbox) but pulls in
// the pure helpers above, which are also exercised by the host tests below.
// ===========================================================================
#[cfg(target_os = "ios")]
mod runtime {
    use super::{decode_wav_16k, inbox_dir, normalize_wav_gain, title_from_filename, SILENCE_RMS};
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::OnceLock;

    use tauri::{AppHandle, Emitter, Manager};

    use crate::commands::AppState;
    use crate::store::{self, SaveMeetingInput};
    use crate::transcribe::WHISPER_RATE;

    /// The app handle, stashed once during setup so the C entry points the Swift
    /// WatchConnectivity receiver calls (file-arrived, pending-changed) can reach
    /// Tauri without threading a handle through the FFI boundary.
    static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();

    /// Set while a worker thread is draining the inbox.
    static SCANNING: AtomicBool = AtomicBool::new(false);
    /// Set by any trigger that fires while a scan is already running, so a
    /// recording delivered mid-scan is drained in a follow-up pass instead of
    /// sitting until the next launch/foreground (the bug Oz hit at a conference:
    /// a file arriving while the app was already open never appeared).
    static RESCAN: AtomicBool = AtomicBool::new(false);

    /// Called once from `lib.rs` setup (iOS-gated) so the FFI entry points have a
    /// handle to emit/scan with. Idempotent.
    pub fn set_app_handle(app: AppHandle) {
        let _ = APP_HANDLE.set(app);
    }

    /// Swift → Rust: the WatchConnectivity receiver just dropped a new file into
    /// the inbox. Kick an immediate drain so a recording that arrives while the
    /// app is foregrounded appears without a relaunch.
    #[no_mangle]
    pub extern "C" fn lalela_watch_inbox_file_arrived() {
        if let Some(app) = APP_HANDLE.get() {
            spawn_scan(app.clone());
        }
    }

    /// Swift → Rust: the paired watch published a new pending-sync count via
    /// `updateApplicationContext`. Surfaced to the phone UI as `watch://pending`.
    #[no_mangle]
    pub extern "C" fn lalela_watch_pending_changed(count: i32) {
        if let Some(app) = APP_HANDLE.get() {
            let _ = app.emit(
                "watch://pending",
                serde_json::json!({ "count": count.max(0) }),
            );
        }
    }

    fn is_wav(p: &Path) -> bool {
        p.extension()
            .and_then(|x| x.to_str())
            .map(|x| x.eq_ignore_ascii_case("wav"))
            .unwrap_or(false)
    }

    /// Count the WAV files currently waiting in the inbox (0 on any error).
    fn count_inbox_wavs(app: &AppHandle) -> usize {
        let Ok(data_dir) = crate::paths::app_data_dir(app) else {
            return 0;
        };
        let Ok(entries) = std::fs::read_dir(inbox_dir(&data_dir)) else {
            return 0;
        };
        entries
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| is_wav(p))
            .count()
    }

    /// Manual drain entry point behind the `scan_watch_inbox` command: count what
    /// is waiting (so the UI can say "No new recordings" vs "Importing N…"), then
    /// kick the same background drain used on launch/foreground/file-arrival.
    pub fn scan_now(app: &AppHandle) -> usize {
        let count = count_inbox_wavs(app);
        spawn_scan(app.clone());
        count
    }

    /// Kick a drain of the watch inbox on a background thread. Model prep and
    /// transcription can take seconds–minutes, so this must never run on the
    /// thread that drives the UI / event loop. Triggers that arrive while a scan
    /// is already running set RESCAN and are picked up before the worker exits.
    pub fn spawn_scan(app: AppHandle) {
        // Register a scan request first, then try to become the sole worker.
        RESCAN.store(true, Ordering::SeqCst);
        if SCANNING.swap(true, Ordering::SeqCst) {
            return; // a worker is already running; it will observe RESCAN
        }
        std::thread::spawn(move || {
            loop {
                // Consume the outstanding request(s) for this pass.
                RESCAN.store(false, Ordering::SeqCst);
                if let Err(e) = scan_and_import(&app) {
                    eprintln!("watch-inbox scan failed: {e}");
                }
                // Release the slot BEFORE re-checking, so a trigger that lands
                // after this point spawns its own worker rather than being lost.
                SCANNING.store(false, Ordering::SeqCst);
                if !RESCAN.load(Ordering::SeqCst) {
                    break;
                }
                // A late trigger arrived; try to re-take the slot. If another
                // thread beat us to it, it owns the rescan and we can exit.
                if SCANNING.swap(true, Ordering::SeqCst) {
                    break;
                }
            }
        });
    }

    fn scan_and_import(app: &AppHandle) -> Result<(), String> {
        let data_dir = crate::paths::app_data_dir(app)?;
        let dir = inbox_dir(&data_dir);
        if !dir.exists() {
            return Ok(());
        }
        // Oldest first — the timestamped filename sorts chronologically.
        let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
            .map_err(|e| e.to_string())?
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| is_wav(p))
            .collect();
        files.sort();

        // Announce the pass so the phone UI can show an "importing from Watch"
        // pill. A zero-file pass (a bare launch/foreground with nothing waiting)
        // still emits found:0 so a listening UI can clear any stale state.
        let total = files.len();
        let _ = app.emit("watch://scan", serde_json::json!({ "found": total }));

        let mut imported = 0usize;
        for (i, path) in files.iter().enumerate() {
            let name = path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("recording.wav")
                .to_string();
            let _ = app.emit(
                "watch://scan",
                serde_json::json!({ "importing": name, "index": i + 1, "total": total }),
            );
            match import_one(app, path) {
                Ok(meeting_id) => {
                    let _ = std::fs::remove_file(path);
                    imported += 1;
                    // Nudge the frontend to refresh its meeting list (kept for
                    // existing listeners — App.tsx refreshes off this).
                    let _ = app.emit("watch://imported", &meeting_id);
                }
                // Leave a failed file in place so a later scan retries it (e.g.
                // the whisper model was still downloading). Never lose audio.
                Err(e) => eprintln!("watch-inbox import failed for {path:?}: {e}"),
            }
        }
        let _ = app.emit("watch://scan", serde_json::json!({ "imported": imported }));
        Ok(())
    }

    fn import_one(app: &AppHandle, path: &Path) -> Result<String, String> {
        // Best-effort loudness boost for quiet wrist recordings; never fails.
        normalize_wav_gain(path);
        let (samples_16k, source_rate, duration_ms) = decode_wav_16k(path)?;
        if samples_16k.is_empty() {
            return Err("recording contained no audio".into());
        }

        // Whisper — the same engine the live iOS recorder uses. On first run this
        // downloads the GGUF (seconds–minutes); we are already on a worker thread.
        let app_dl = app.clone();
        let (mut engine, _notice) =
            crate::asr::create_engine(app, crate::asr::WHISPER_ID, move |d, t| {
                let _ = app_dl.emit(
                    "model://progress",
                    serde_json::json!({ "downloaded": d, "total": t }),
                );
            })?;
        let bias = crate::asr::EngineBias::none();

        // Contiguous 30 s windows (whisper's native window); skip near-silent.
        const WINDOW: usize = WHISPER_RATE as usize * 30;
        let mut segments = Vec::new();
        let mut start = 0usize;
        while start < samples_16k.len() {
            let end = (start + WINDOW).min(samples_16k.len());
            let chunk = &samples_16k[start..end];
            if crate::audio::rms(chunk) >= SILENCE_RMS {
                let offset_ms = (start as i64) * 1000 / WHISPER_RATE as i64;
                let segs = engine.transcribe(chunk, offset_ms, "Speaker 1", &bias)?;
                segments.extend(segs);
            }
            start = end;
        }
        // Stateless per-window engines return nothing here, but be safe.
        segments.extend(engine.finish().unwrap_or_default());

        let filename = path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("watch-recording.wav")
            .to_string();
        let title = title_from_filename(&filename);

        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(|_| "state poisoned")?;
        let root = store::save_root(&conn, &state.fallback_root);
        let meeting = store::insert_meeting(
            &conn,
            SaveMeetingInput {
                title,
                project_id: None,
                segments,
                notes: String::new(),
                summary: String::new(),
                images: Vec::new(),
                attendees: None,
            },
            &root,
        )?;
        // Provenance identical to a desktop audio import (verified real audio).
        let _ = store::record_import_source(
            &conn,
            &meeting.id,
            "audio",
            "wav",
            &filename,
            "verified-audio",
            Some(duration_ms),
            Some(source_rate as i64),
        );
        Ok(meeting.id)
    }
}

#[cfg(target_os = "ios")]
pub use runtime::{scan_now, set_app_handle, spawn_scan};

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture(name: &str) -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("tests/fixtures/audio")
            .join(name)
    }

    #[test]
    fn parses_timestamped_watch_filename() {
        assert_eq!(
            title_from_filename("lalela-watch-20260715-143005.wav"),
            "Watch recording · 2026-07-15 14:30"
        );
    }

    #[test]
    fn falls_back_for_unexpected_names() {
        assert_eq!(title_from_filename("memo.wav"), "Watch recording");
        assert_eq!(
            title_from_filename("lalela-watch-bogus.wav"),
            "Watch recording"
        );
    }

    #[test]
    fn decodes_wav_to_16k_mono() {
        // tone.wav is a 2 s 440 Hz stereo tone at 44.1 kHz — decode must downmix
        // + resample to ~32000 samples of 16 kHz mono with real energy. This is
        // the exact path a watch recording takes (hound, not symphonia).
        let (samples, source_rate, duration_ms) =
            decode_wav_16k(&fixture("tone.wav")).expect("decode tone.wav");
        assert_eq!(source_rate, 44_100);
        assert!(
            (samples.len() as i64 - 32_000).abs() < 3_200,
            "expected ~32000 samples, got {}",
            samples.len()
        );
        assert!(
            (duration_ms - 2_000).abs() < 200,
            "expected ~2000 ms, got {duration_ms}"
        );
        assert!(
            crate::audio::rms(&samples) > 0.1,
            "decoded audio is near-silent"
        );
    }

    // --- gain normalization ---

    /// Write a mono 16 kHz 16-bit PCM WAV whose samples alternate ±`peak`.
    fn write_tone(path: &Path, peak: i16, n: usize) {
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: 16_000,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut w = hound::WavWriter::create(path, spec).expect("create wav");
        for i in 0..n {
            let s = if i % 2 == 0 { peak } else { -peak };
            w.write_sample(s).expect("write sample");
        }
        w.finalize().expect("finalize wav");
    }

    /// Peak of a 16-bit PCM WAV as absolute i32 (0 on any error).
    fn wav_peak(path: &Path) -> i32 {
        let mut r = hound::WavReader::open(path).expect("open wav");
        r.samples::<i16>()
            .filter_map(|s| s.ok())
            .map(|s| (s as i32).abs())
            .max()
            .unwrap_or(0)
    }

    fn dbfs(peak: i32) -> f32 {
        20.0 * (peak as f32 / i16::MAX as f32).log10()
    }

    #[test]
    fn quiet_wav_is_boosted_to_minus_3_dbfs() {
        // Peak ~0.1 full-scale (~ −20 dBFS) needs ~+17 dB, well under the cap.
        let dir = std::env::temp_dir().join(format!("lalela-norm-quiet-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("quiet.wav");
        write_tone(&path, 3_277, 2_000); // 0.1 * 32767
        normalize_wav_gain(&path);
        let out = dbfs(wav_peak(&path));
        assert!(
            (out - (-3.0)).abs() < 0.6,
            "expected ~ −3 dBFS after normalize, got {out:.2} dBFS"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn loud_wav_is_left_untouched() {
        // Peak ~ −0.8 dBFS: already above the −3 dBFS target, so gain would be
        // < 1 → clamped to 1 → the file must be byte-identical (never attenuate).
        let dir = std::env::temp_dir().join(format!("lalela-norm-loud-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("loud.wav");
        write_tone(&path, 30_000, 2_000);
        let before = std::fs::read(&path).unwrap();
        normalize_wav_gain(&path);
        let after = std::fs::read(&path).unwrap();
        assert_eq!(before, after, "an already-loud recording must not be modified");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn silent_wav_is_left_untouched() {
        let dir = std::env::temp_dir().join(format!("lalela-norm-silent-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("silent.wav");
        write_tone(&path, 0, 2_000);
        let before = std::fs::read(&path).unwrap();
        normalize_wav_gain(&path);
        let after = std::fs::read(&path).unwrap();
        assert_eq!(before, after, "pure silence must not be modified (no divide-by-zero)");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
