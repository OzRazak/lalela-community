//! The bundled whisper.cpp engine behind the `AsrEngine` trait — a thin
//! wrapper over `crate::transcribe::Transcriber` so the historical path stays
//! byte-identical (same params, same hallucination filter, same timestamps).

use super::{AsrEngine, EngineBias, WHISPER_ID};
use crate::transcribe::{Segment, Transcriber};

pub struct WhisperEngine {
    inner: Transcriber,
}

impl WhisperEngine {
    pub fn new(model_path: &str) -> Result<Self, String> {
        Ok(Self { inner: Transcriber::new(model_path)? })
    }
}

impl AsrEngine for WhisperEngine {
    fn id(&self) -> &str {
        WHISPER_ID
    }

    fn transcribe(
        &mut self,
        audio_16k_mono: &[f32],
        offset_ms: i64,
        speaker: &str,
        bias: &EngineBias,
    ) -> Result<Vec<Segment>, String> {
        // Whisper's native biasing is the initial prompt (~224-token budget,
        // enforced upstream by the bias builder, not here).
        let prompt = bias.initial_prompt.as_deref().filter(|p| !p.is_empty());
        self.inner.transcribe(audio_16k_mono, offset_ms, speaker, prompt)
    }
}
