//! On-device speaker diarization via sherpa-onnx (sherpa-rs). Runs as a
//! post-recording pass over the full mic audio to separate multiple in-person
//! voices that share one microphone, then relabels transcript segments.

use crate::transcribe::Segment;

/// A diarization turn: [start, end] in seconds for a given speaker index.
pub struct Turn {
    pub start: f32,
    pub end: f32,
    pub speaker: i32,
}

pub struct Diarizer {
    sd: sherpa_rs::diarize::Diarize,
}

impl Diarizer {
    pub fn new(segmentation_model: &str, embedding_model: &str) -> Result<Self, String> {
        let config = sherpa_rs::diarize::DiarizeConfig {
            // Negative num_clusters → auto-detect the number of speakers using the
            // distance threshold (so a solo meeting stays 1 speaker, and multi-voice
            // meetings split into N). A fixed count would wrongly split solo meetings.
            num_clusters: Some(-1),
            // 0.5 over-split badly in practice (one voice → "Speaker 1/3/5/8…").
            // Larger = merge more aggressively; 0.8 keeps genuinely different
            // voices apart while holding one voice together.
            threshold: Some(0.8),
            ..Default::default()
        };
        let sd = sherpa_rs::diarize::Diarize::new(segmentation_model, embedding_model, config)
            .map_err(|e| format!("diarization init failed: {e}"))?;
        Ok(Self { sd })
    }

    /// Diarize 16 kHz mono audio into speaker turns.
    pub fn compute(&mut self, samples_16k: Vec<f32>) -> Result<Vec<Turn>, String> {
        let segments = self
            .sd
            .compute(samples_16k, None)
            .map_err(|e| format!("diarization failed: {e}"))?;
        Ok(segments
            .into_iter()
            .map(|s| Turn {
                start: s.start,
                end: s.end,
                speaker: s.speaker,
            })
            .collect())
    }
}

/// Per-cluster voiceprint extraction (Slice 1). Reuses the SAME embedding
/// model diarization already downloads (titanet); called only when the user
/// opted into speaker recognition. Embeddings stay on-device.
pub struct SpeakerEmbedder {
    extractor: sherpa_rs::speaker_id::EmbeddingExtractor,
}

/// Cap the audio fed into one embedding at 30 s — plenty for a stable
/// voiceprint, keeps the pass fast on long meetings.
const EMBED_CAP_SAMPLES: usize = 16_000 * 30;

impl SpeakerEmbedder {
    pub fn new(embedding_model: &str) -> Result<Self, String> {
        let extractor = sherpa_rs::speaker_id::EmbeddingExtractor::new(
            sherpa_rs::speaker_id::ExtractorConfig {
                model: embedding_model.to_string(),
                ..Default::default()
            },
        )
        .map_err(|e| format!("embedding extractor init failed: {e}"))?;
        Ok(Self { extractor })
    }

    /// One embedding per diarization cluster, from up to 30 s of that
    /// cluster's concatenated audio. Clusters whose extraction fails are
    /// skipped (best-effort — auto-naming is an enhancement, never a blocker).
    pub fn embed_clusters(&mut self, audio_16k: &[f32], turns: &[Turn]) -> Vec<(i32, Vec<f32>)> {
        let mut clusters: Vec<i32> = turns.iter().map(|t| t.speaker).collect();
        clusters.sort_unstable();
        clusters.dedup();

        let mut out = Vec::new();
        for cluster in clusters {
            let mut samples: Vec<f32> = Vec::new();
            for t in turns.iter().filter(|t| t.speaker == cluster) {
                let a = ((t.start.max(0.0) * 16_000.0) as usize).min(audio_16k.len());
                let b = ((t.end.max(0.0) * 16_000.0) as usize).min(audio_16k.len());
                if b > a {
                    samples.extend_from_slice(&audio_16k[a..b]);
                }
                if samples.len() >= EMBED_CAP_SAMPLES {
                    samples.truncate(EMBED_CAP_SAMPLES);
                    break;
                }
            }
            // Under a second of speech gives junk embeddings — skip.
            if samples.len() < 16_000 {
                continue;
            }
            if let Ok(embedding) = self.extractor.compute_speaker_embedding(samples, 16_000) {
                out.push((cluster, embedding));
            }
        }
        out
    }
}

/// Relabel transcript segments by the diarization turn covering each segment's
/// midpoint. Only segments whose current speaker equals `only_from` are touched;
/// `prefix` builds the new label, e.g. "Speaker " → "Speaker 1".
pub fn relabel(segments: &mut [Segment], turns: &[Turn], prefix: &str, only_from: &str) {
    for seg in segments.iter_mut() {
        if seg.speaker != only_from {
            continue;
        }
        let mid_s = (seg.t0_ms + seg.t1_ms) as f32 / 2000.0;
        if let Some(turn) = turns
            .iter()
            .find(|t| mid_s >= t.start && mid_s <= t.end)
            .or_else(|| {
                // Fall back to the nearest turn if none strictly covers it.
                turns.iter().min_by(|a, b| {
                    let da = (mid_s - (a.start + a.end) / 2.0).abs();
                    let db = (mid_s - (b.start + b.end) / 2.0).abs();
                    da.partial_cmp(&db).unwrap_or(std::cmp::Ordering::Equal)
                })
            })
        {
            seg.speaker = format!("{prefix}{}", turn.speaker + 1);
        }
    }
}
