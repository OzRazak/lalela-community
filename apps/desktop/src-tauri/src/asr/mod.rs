//! ASR engine abstraction (Intelligence Layer, Slice 8).
//!
//! One trait, many engines: whisper.cpp stays the bundled default and offline
//! floor; alternative engines (Parakeet, Granite) run OUT OF PROCESS in the
//! `lalela-asr` sidecar and are selected at runtime. Nothing downstream
//! (diarization, summaries, wiki) knows which engine produced a transcript —
//! every engine normalises to the canonical `Segment` shape from
//! `crate::transcribe`.
//!
//! Invariant (same one that put llama.cpp in `lalela-llm`): never link a
//! second speech runtime into the app process. whisper-rs vendors ggml;
//! NeMo/MLX/ONNX runtimes collide or bloat. New engines go in the sidecar.

pub mod biasing;
pub mod whisper;

#[cfg(desktop)]
pub mod sidecar_engine;

// Apple's on-device SpeechAnalyzer, offered as an optional engine on
// Apple-Intelligence hardware: macOS 26+ via a Swift helper process, iOS 26+ via
// the in-process bridge (App Store apps can't spawn helpers). Not the
// `lalela-asr` sidecar. The transport forks inside the module.
#[cfg(any(target_os = "macos", target_os = "ios"))]
pub mod apple_engine;

use serde::{Deserialize, Serialize};

use crate::transcribe::Segment;

/// The engine id of the bundled whisper.cpp path — the default and the
/// fallback whenever a requested engine is unavailable.
pub const WHISPER_ID: &str = "whisper";

/// The engine id of the optional Apple Speech path (macOS 26+ only).
pub const APPLE_ID: &str = "apple";

/// One biasing term for the decoder (populated by Slice 0/0-ext).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct BiasTerm {
    pub term: String,
    /// Relative priority when the bias budget is trimmed. 1.0 = normal.
    #[serde(default = "default_weight")]
    pub weight: f32,
    /// Optional "sounds like" hints (mispronunciations, near-homophones).
    #[serde(default)]
    pub sounds_like: Vec<String>,
}

fn default_weight() -> f32 {
    1.0
}

/// Engine-agnostic bias input. Each engine maps this to its native format:
/// whisper → `initial_prompt`; Parakeet/Granite → word-boost lists.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct EngineBias {
    /// Pre-rendered whisper initial prompt (Slice 0 sources it from the
    /// workspace card + attendees; Slice 0-ext adds the custom dictionary).
    pub initial_prompt: Option<String>,
    /// Structured terms for engines with native word-boosting.
    pub terms: Vec<BiasTerm>,
}

impl EngineBias {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.initial_prompt.as_deref().map_or(true, str::is_empty) && self.terms.is_empty()
    }
}

/// A speech engine. `transcribe` takes 16 kHz mono f32 PCM and returns
/// canonical segments with timestamps relative to the meeting start
/// (`offset_ms` pre-added), exactly like the historical whisper path.
pub trait AsrEngine: Send {
    fn id(&self) -> &str;

    fn transcribe(
        &mut self,
        audio_16k_mono: &[f32],
        offset_ms: i64,
        speaker: &str,
        bias: &EngineBias,
    ) -> Result<Vec<Segment>, String>;

    /// Flush any segments the engine is still holding. Engines with cross-window
    /// context (Apple Speech) finalize sentences late — the last sentence of a
    /// recording may only surface here. Stateless per-window engines keep the
    /// default no-op.
    fn finish(&mut self) -> Result<Vec<Segment>, String> {
        Ok(Vec::new())
    }
}

/// Picker metadata for the Settings UI.
#[derive(Debug, Clone, Serialize)]
pub struct EngineInfo {
    pub id: String,
    pub label: String,
    /// False when the engine is known but its sidecar/model is missing.
    pub available: bool,
    pub is_default: bool,
}

/// Outcome of resolving the user's engine choice against what is actually
/// present on this machine. Pure so it is unit-testable.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedEngine {
    pub id: String,
    /// True when the request could not be honored and whisper was substituted.
    pub fell_back: bool,
}

/// Resolve a requested engine id against what is present on this machine.
/// Unknown/absent engines fall back to whisper — recording must never fail
/// because an optional engine is missing. Pure (availability passed in) so it
/// is unit-testable without spawning a helper.
pub fn resolve_choice(
    requested: &str,
    sidecar_engines: &[String],
    apple_available: bool,
) -> ResolvedEngine {
    let requested = requested.trim();
    if requested.is_empty() || requested == WHISPER_ID {
        return ResolvedEngine { id: WHISPER_ID.into(), fell_back: false };
    }
    if requested == APPLE_ID {
        return if apple_available {
            ResolvedEngine { id: APPLE_ID.into(), fell_back: false }
        } else {
            ResolvedEngine { id: WHISPER_ID.into(), fell_back: true }
        };
    }
    if sidecar_engines.iter().any(|e| e == requested) {
        return ResolvedEngine { id: requested.into(), fell_back: false };
    }
    ResolvedEngine { id: WHISPER_ID.into(), fell_back: true }
}

/// Whether the optional Apple Speech engine is usable on this device (macOS 26+
/// or iOS 26+ with Apple Intelligence, and the helper/bridge present + reporting
/// available). False everywhere else. Cached in `apple_engine`, so cheap to call
/// repeatedly (but always off the main thread on iOS — see `list_asr_engines`).
pub fn apple_engine_available() -> bool {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        apple_engine::available_cached()
    }
    #[cfg(not(any(target_os = "macos", target_os = "ios")))]
    {
        false
    }
}

/// Engines the sidecar advertises right now (empty when the sidecar binary is
/// absent — e.g. iOS, or a build that doesn't bundle it).
pub fn sidecar_engines() -> Vec<String> {
    #[cfg(desktop)]
    {
        sidecar_engine::list_engines().unwrap_or_default()
    }
    // No sidecar on mobile (iOS + Android): no subprocesses.
    #[cfg(mobile)]
    {
        Vec::new()
    }
}

/// Everything the Settings picker shows: whisper first (always available),
/// then whatever the sidecar advertises.
pub fn list_all_engines() -> Vec<EngineInfo> {
    let mut out = vec![EngineInfo {
        id: WHISPER_ID.into(),
        label: "Whisper (accuracy — default)".into(),
        available: true,
        is_default: true,
    }];
    // Apple Speech — advertised only when actually usable, so the picker is
    // unchanged on ineligible machines.
    if apple_engine_available() {
        out.push(EngineInfo {
            id: APPLE_ID.into(),
            label: "Apple Speech (on-device)".into(),
            available: true,
            is_default: false,
        });
    }
    for id in sidecar_engines() {
        out.push(EngineInfo {
            label: sidecar_label(&id),
            id,
            available: true,
            is_default: false,
        });
    }
    out
}

fn sidecar_label(id: &str) -> String {
    match id {
        "parakeet" => "Parakeet (speed)".to_string(),
        "granite" => "Granite (experimental)".to_string(),
        other => other.to_string(),
    }
}

/// Build the engine the transcription worker will drive. `on_progress`
/// reports model-download progress (whisper path). Returns the engine plus an
/// optional user-facing notice (set when the choice fell back to whisper).
pub fn create_engine(
    app: &tauri::AppHandle,
    requested: &str,
    on_progress: impl Fn(u64, u64) + Send + Clone + 'static,
) -> Result<(Box<dyn AsrEngine>, Option<String>), String> {
    let resolved = resolve_choice(requested, &sidecar_engines(), apple_engine_available());
    let notice = if resolved.fell_back {
        Some(format!(
            "Transcription engine \"{requested}\" isn't available on this device — using Whisper instead."
        ))
    } else {
        None
    };

    if resolved.id == WHISPER_ID {
        let model = crate::models::ensure_model(app, on_progress)?;
        let engine = whisper::WhisperEngine::new(&model.to_string_lossy())?;
        return Ok((Box::new(engine), notice));
    }

    // Apple Speech — start its helper (macOS) / bridge session (iOS); a start
    // failure never fails the recording, it drops to whisper with a surfaced
    // notice (same contract as the sidecar).
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if resolved.id == APPLE_ID {
        match apple_engine::AppleAsrEngine::start() {
            Ok(engine) => return Ok((Box::new(engine), notice)),
            Err(e) => {
                let model = crate::models::ensure_model(app, on_progress)?;
                let engine = whisper::WhisperEngine::new(&model.to_string_lossy())?;
                return Ok((
                    Box::new(engine),
                    Some(format!("Apple Speech couldn't start ({e}) — using Whisper instead.")),
                ));
            }
        }
    }

    #[cfg(desktop)]
    {
        match sidecar_engine::SidecarEngine::start(&resolved.id) {
            Ok(engine) => return Ok((Box::new(engine), notice)),
            Err(e) => {
                // The sidecar advertised the engine but couldn't start it —
                // still never fail the recording; drop to whisper.
                let model = crate::models::ensure_model(app, on_progress)?;
                let engine = whisper::WhisperEngine::new(&model.to_string_lossy())?;
                return Ok((
                    Box::new(engine),
                    Some(format!(
                        "Transcription engine \"{}\" failed to start ({e}) — using Whisper instead.",
                        resolved.id
                    )),
                ));
            }
        }
    }

    // On mobile resolve_choice only ever returns whisper (handled at the top) or
    // — on iOS — apple (handled by the any(macos,ios) arm above, which returns).
    // Android has neither apple nor a sidecar, so it always returns whisper at
    // the top. Either way nothing else can reach here.
    #[cfg(mobile)]
    unreachable!("resolve_choice on mobile returns only whisper (or apple on iOS), handled above");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_or_whisper_requests_resolve_to_whisper_without_fallback() {
        for req in ["", "  ", "whisper"] {
            let r = resolve_choice(req, &["parakeet".into()], false);
            assert_eq!(r, ResolvedEngine { id: "whisper".into(), fell_back: false });
        }
    }

    #[test]
    fn advertised_sidecar_engine_is_honored() {
        let r = resolve_choice("parakeet", &["parakeet".into()], false);
        assert_eq!(r, ResolvedEngine { id: "parakeet".into(), fell_back: false });
    }

    #[test]
    fn unknown_engine_falls_back_to_whisper() {
        let r = resolve_choice("parakeet", &[], false);
        assert!(r.fell_back);
        assert_eq!(r.id, "whisper");
        let r = resolve_choice("granite", &["parakeet".into()], false);
        assert!(r.fell_back);
        assert_eq!(r.id, "whisper");
    }

    #[test]
    fn apple_is_honored_only_when_available() {
        // Available → resolves to apple, no fallback.
        let r = resolve_choice("apple", &[], true);
        assert_eq!(r, ResolvedEngine { id: "apple".into(), fell_back: false });
        // Unavailable → silently falls back to whisper (picker would have hidden
        // it, but a stale saved setting must still degrade gracefully).
        let r = resolve_choice("apple", &["parakeet".into()], false);
        assert!(r.fell_back);
        assert_eq!(r.id, "whisper");
    }

    #[test]
    fn engine_bias_emptiness() {
        assert!(EngineBias::none().is_empty());
        assert!(EngineBias { initial_prompt: Some(String::new()), terms: vec![] }.is_empty());
        assert!(!EngineBias { initial_prompt: Some("Auxo".into()), terms: vec![] }.is_empty());
        let with_terms = EngineBias {
            initial_prompt: None,
            terms: vec![BiasTerm { term: "Lalela".into(), weight: 2.0, sounds_like: vec![] }],
        };
        assert!(!with_terms.is_empty());
    }

    /// Regression guard for the canonical shape: any engine (here a fake one)
    /// must produce `Segment`s indistinguishable from the whisper path's.
    #[test]
    fn fake_engine_returns_canonical_segments() {
        struct Fake;
        impl AsrEngine for Fake {
            fn id(&self) -> &str {
                "fake"
            }
            fn transcribe(
                &mut self,
                _audio: &[f32],
                offset_ms: i64,
                speaker: &str,
                _bias: &EngineBias,
            ) -> Result<Vec<Segment>, String> {
                Ok(vec![Segment {
                    t0_ms: offset_ms,
                    t1_ms: offset_ms + 1000,
                    text: "hello".into(),
                    speaker: speaker.into(),
                }])
            }
        }
        let mut engine: Box<dyn AsrEngine> = Box::new(Fake);
        let segs = engine.transcribe(&[0.0; 16_000], 5000, "Me", &EngineBias::none()).unwrap();
        assert_eq!(segs.len(), 1);
        assert_eq!(segs[0].t0_ms, 5000);
        assert_eq!(segs[0].speaker, "Me");
        // Serialized shape must match what the frontend already consumes.
        let json = serde_json::to_value(&segs[0]).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"t0_ms": 5000, "t1_ms": 6000, "text": "hello", "speaker": "Me"})
        );
        // The trait's default finish() is a no-op flush — stateless engines
        // (whisper, sidecar) hold nothing back at end of recording.
        assert!(engine.finish().unwrap().is_empty());
    }
}
