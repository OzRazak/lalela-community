//! Local transcription via whisper.cpp (whisper-rs), plus the shared transcript types.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

/// Sample rate whisper expects.
pub const WHISPER_RATE: u32 = 16_000;

/// One transcript line.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    /// Start time relative to the start of the meeting, in milliseconds.
    pub t0_ms: i64,
    pub t1_ms: i64,
    pub text: String,
    /// Speaker label. In Phase 1 (mic only) this is always "Me";
    /// real diarization labels arrive in Phase 2.
    pub speaker: String,
}

pub struct Transcriber {
    /// ONE **warm** Whisper decode state, built in `new()` and reused across
    /// every recording window instead of `create_state()`-ing a fresh one per
    /// call.
    ///
    /// Why persist the *state*, not just the context: each ~8 s window used to
    /// `WhisperContext::create_state()` and drop it, and dropping a Metal-backed
    /// `WhisperState` frees its compute buffers via `ggml_metal_free` — a
    /// teardown that, done repeatedly under Metal residency-set management,
    /// throws a foreign exception Rust can't catch (~1-in-25) and aborts the app.
    /// That is the exact mechanism behind the dictation crashes; a normal meeting
    /// (one drop per window) exposed the recording path to the same probabilistic
    /// abort. Reusing one state means `full()` is called repeatedly (it resets
    /// its own results each call, so windows never bleed into each other) and the
    /// Metal buffers are freed exactly ONCE — when this `Transcriber` is dropped
    /// at recording stop (the ASR engine is a local in the recording worker
    /// thread, not held across recordings, so nothing stays resident to trip the
    /// atexit residency-set assert on quit — see DECISIONS 2026-07-17).
    ///
    /// whisper-rs 0.16 `WhisperState` owns an `Arc` to its context and is
    /// `Send + Sync`, so it's a standalone owned value that keeps the model
    /// loaded with no separate handle. The `Mutex` gives `transcribe(&self)` the
    /// interior mutability `full()` needs (`&mut self`); it also serialises use,
    /// though the recording worker already drives windows sequentially on one
    /// thread so it never actually contends.
    state: Mutex<WhisperState>,
}

impl Transcriber {
    pub fn new(model_path: &str) -> Result<Self, String> {
        let ctx = WhisperContext::new_with_params(model_path, WhisperContextParameters::default())
            .map_err(|e| format!("failed to load model: {e}"))?;
        // Build the one warm state now; the state owns an `Arc` to `ctx`, so the
        // local `ctx` binding can drop here without unloading the model.
        let state = ctx.create_state().map_err(|e| e.to_string())?;
        Ok(Self { state: Mutex::new(state) })
    }

    /// Transcribe a buffer of 16 kHz mono f32 audio.
    /// `offset_ms` is added to every segment timestamp so callers can place a
    /// window correctly on the meeting timeline.
    ///
    /// `initial_prompt` biases the decoder toward given vocabulary (proper
    /// nouns, domain terms — whisper reads it as preceding context). `None`
    /// leaves the decode identical to the historical path.
    pub fn transcribe(
        &self,
        audio_16k_mono: &[f32],
        offset_ms: i64,
        speaker: &str,
        initial_prompt: Option<&str>,
    ) -> Result<Vec<Segment>, String> {
        if audio_16k_mono.is_empty() {
            return Ok(vec![]);
        }

        // Reuse the ONE warm state — no per-window create_state()/drop, so no
        // per-window ggml_metal_free. `full()` re-inits for this window's audio +
        // params, so successive windows stay independent (the dictation path
        // proves the same reuse is clean). Recover a poisoned lock rather than
        // wedging transcription forever if a past window panicked mid-decode.
        let mut state = self.state.lock().unwrap_or_else(|p| p.into_inner());

        let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
        params.set_n_threads(num_threads());
        params.set_translate(false);
        params.set_language(Some("en"));
        params.set_print_special(false);
        params.set_print_progress(false);
        params.set_print_realtime(false);
        params.set_print_timestamps(false);
        params.set_suppress_blank(true);
        if let Some(prompt) = initial_prompt.filter(|p| !p.is_empty()) {
            params.set_initial_prompt(prompt);
        }

        state
            .full(params, audio_16k_mono)
            .map_err(|e| format!("transcription failed: {e}"))?;

        let n = state.full_n_segments();
        let mut out = Vec::new();
        for i in 0..n {
            let Some(seg) = state.get_segment(i) else {
                continue;
            };
            let text = seg.to_str_lossy().map_err(|e| e.to_string())?;
            let trimmed = text.trim();
            if trimmed.is_empty() || is_hallucination(trimmed) {
                continue;
            }
            // whisper timestamps are in centiseconds (×10 = milliseconds).
            let t0 = seg.start_timestamp() * 10;
            let t1 = seg.end_timestamp() * 10;
            out.push(Segment {
                t0_ms: offset_ms + t0,
                t1_ms: offset_ms + t1,
                text: trimmed.to_string(),
                speaker: speaker.to_string(),
            });
        }
        Ok(out)
    }
}

/// Common Whisper hallucinations on silence/noise that should be dropped.
/// `pub(crate)` so the dictation path shares the exact same filter as the
/// recording `Transcriber` (both reuse one warm whisper state across passes).
pub(crate) fn is_hallucination(text: &str) -> bool {
    // Anything fully enclosed in brackets/parens, e.g. "[Silence]", "(music)".
    let t = text.trim();
    if (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('(') && t.ends_with(')')) {
        return true;
    }
    let normalized: String = t
        .to_lowercase()
        .chars()
        .filter(|c| c.is_alphanumeric() || c.is_whitespace())
        .collect();
    let normalized = normalized.trim();
    matches!(
        normalized,
        "you"
            | "thank you"
            | "thanks for watching"
            | "thank you for watching"
            | "please subscribe"
            | "bye"
            | "so"
    )
}

fn num_threads() -> std::os::raw::c_int {
    whisper_threads()
}

/// Whisper CPU decode threads, shared by recording, import and dictation.
///
/// Apple platforms (Metal does the heavy encoder work): all logical cores minus two for
/// the UI/audio threads — unchanged.
///
/// Everywhere else the whole decode runs on the CPU, and ggml's worker threads
/// busy-wait at every barrier: with more threads than FREE physical cores
/// (hyper-threads, or another app busy on the machine) each barrier waits for a
/// descheduled thread and throughput collapses. Measured on a 4-core/8-thread
/// Windows PC with a game running: 6 threads took ~30 s to finish a 5 s
/// dictation. Use half the logical cores (≈ the physical ones), at most 4 —
/// whisper.cpp's own default — and at least 2.
pub(crate) fn whisper_threads() -> std::os::raw::c_int {
    let n = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(4);
    threads_for(n, cfg!(any(target_os = "macos", target_os = "ios"))) as std::os::raw::c_int
}

fn threads_for(logical: usize, macos: bool) -> usize {
    if macos {
        logical.saturating_sub(2).max(2)
    } else {
        (logical / 2).clamp(2, 4)
    }
}

#[cfg(test)]
mod thread_tests {
    use super::threads_for;

    #[test]
    fn cpu_only_platforms_stay_at_or_below_physical_cores() {
        assert_eq!(threads_for(8, false), 4); // 4C/8T desktop
        assert_eq!(threads_for(4, false), 2); // 2C/4T laptop
        assert_eq!(threads_for(2, false), 2);
        assert_eq!(threads_for(32, false), 4); // whisper.cpp's own default cap
    }

    #[test]
    fn macos_is_unchanged() {
        assert_eq!(threads_for(10, true), 8);
        assert_eq!(threads_for(2, true), 2);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hallucination_filter_drops_known_filler() {
        for t in ["[Silence]", "(music)", "you", "Thank you.", "thanks for watching", "Bye!"] {
            assert!(is_hallucination(t), "expected {t:?} to be filtered");
        }
    }

    #[test]
    fn hallucination_filter_keeps_real_speech() {
        for t in ["Thanks for the update on the Auxo deal.", "So, let's start.", "You said it."] {
            assert!(!is_hallucination(t), "expected {t:?} to be kept");
        }
    }
}
