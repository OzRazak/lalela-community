//! Speaker identity (Intelligence Layer, Slice 1): persistent voiceprints +
//! matching, Otter-style auto-naming with a user correction loop.
//!
//! Pure logic only — SQL lives in `store.rs`, embedding extraction in
//! `diarize.rs`. Privacy invariant: voiceprint embeddings are BIOMETRIC data —
//! they live in the local SQLite only, never sync to the cloud, and both
//! extraction and enrolment are gated on an explicit opt-in setting.

use serde::{Deserialize, Serialize};

/// Cosine similarity at or above this = the cluster voice is an enrolled
/// speaker (sherpa-onnx's own default for titanet embeddings).
pub const SIMILARITY_THRESHOLD: f32 = 0.5;

/// One person in the local speaker directory.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Speaker {
    pub id: String,
    pub name: String,
    /// Alternate spellings/labels seen for this person (import names etc.).
    pub aliases: Vec<String>,
    pub role: Option<String>,
    /// True when a voiceprint is enrolled (the embedding itself never leaves
    /// the backend — the frontend only sees this flag).
    pub has_voiceprint: bool,
    /// How many meetings this speaker has been observed in.
    pub meeting_count: i64,
    pub created_at: i64,
    pub updated_at: i64,
}

pub fn cosine(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let (mut dot, mut na, mut nb) = (0.0f32, 0.0f32, 0.0f32);
    for (x, y) in a.iter().zip(b) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}

/// Match one cluster embedding against enrolled voiceprints. Returns the best
/// `(speaker_index, similarity)` at or above the threshold.
pub fn best_match(embedding: &[f32], voiceprints: &[Vec<f32>]) -> Option<(usize, f32)> {
    let mut best: Option<(usize, f32)> = None;
    for (i, vp) in voiceprints.iter().enumerate() {
        let sim = cosine(embedding, vp);
        if sim >= SIMILARITY_THRESHOLD && best.map_or(true, |(_, b)| sim > b) {
            best = Some((i, sim));
        }
    }
    best
}

/// Fold a fresh observation into an enrolled voiceprint: normalized mean, so
/// the print drifts toward the speaker's true center over many meetings while
/// one noisy observation can't hijack it.
pub fn merge_voiceprint(enrolled: &[f32], observed: &[f32]) -> Vec<f32> {
    if enrolled.len() != observed.len() || enrolled.is_empty() {
        return enrolled.to_vec();
    }
    let mixed: Vec<f32> = enrolled.iter().zip(observed).map(|(a, b)| a * 0.7 + b * 0.3).collect();
    let norm = mixed.iter().map(|v| v * v).sum::<f32>().sqrt();
    if norm == 0.0 {
        return enrolled.to_vec();
    }
    mixed.into_iter().map(|v| v / norm).collect()
}

/// Voiceprint BLOB codec: little-endian f32s (matches the sidecar PCM codec).
pub fn embedding_to_blob(e: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(e.len() * 4);
    for v in e {
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

pub fn blob_to_embedding(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4).map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]])).collect()
}

/// Is this a diarization placeholder ("Speaker 1", "Speaker 2", …) rather than
/// a real name? Only placeholders are auto-replaced by voiceprint matches.
pub fn is_generic_label(label: &str) -> bool {
    let l = label.trim();
    l.strip_prefix("Speaker ")
        .map_or(false, |rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
}

/// Naming-accuracy metric for the gold set: fraction of reference labels the
/// matcher reproduced. `pairs` = (predicted, reference).
pub fn naming_accuracy(pairs: &[(String, String)]) -> f32 {
    if pairs.is_empty() {
        return 1.0;
    }
    let hits = pairs.iter().filter(|(p, r)| p.eq_ignore_ascii_case(r)).count();
    hits as f32 / pairs.len() as f32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unit(v: Vec<f32>) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.into_iter().map(|x| x / n).collect()
    }

    #[test]
    fn cosine_basics() {
        let a = vec![1.0, 0.0, 0.0];
        assert!((cosine(&a, &a) - 1.0).abs() < 1e-6);
        assert_eq!(cosine(&a, &[0.0, 1.0, 0.0]), 0.0);
        assert_eq!(cosine(&a, &[1.0, 0.0]), 0.0); // length mismatch = no match
        assert_eq!(cosine(&[], &[]), 0.0);
    }

    #[test]
    fn best_match_respects_threshold_and_picks_highest() {
        let vp_a = unit(vec![1.0, 0.1, 0.0, 0.0]);
        let vp_b = unit(vec![0.0, 0.0, 1.0, 0.1]);
        let probe = unit(vec![0.9, 0.2, 0.1, 0.0]); // clearly speaker A
        let (idx, sim) = best_match(&probe, &[vp_b.clone(), vp_a.clone()]).unwrap();
        assert_eq!(idx, 1);
        assert!(sim > 0.9);
        // Orthogonal probe matches nobody.
        let stranger = unit(vec![0.0, 1.0, 0.0, 0.0]);
        assert!(best_match(&stranger, &[vp_a, vp_b]).is_none());
    }

    #[test]
    fn merged_voiceprint_stays_normalized_and_still_matches() {
        let enrolled = unit(vec![1.0, 0.0, 0.0, 0.0]);
        let observed = unit(vec![0.8, 0.3, 0.0, 0.0]);
        let merged = merge_voiceprint(&enrolled, &observed);
        let norm: f32 = merged.iter().map(|v| v * v).sum::<f32>().sqrt();
        assert!((norm - 1.0).abs() < 1e-5);
        assert!(cosine(&merged, &enrolled) > 0.95);
        // Degenerate inputs leave the enrolled print untouched.
        assert_eq!(merge_voiceprint(&enrolled, &[1.0]), enrolled);
    }

    #[test]
    fn blob_roundtrip() {
        let e = vec![0.25f32, -1.5, 3.25e-3];
        assert_eq!(blob_to_embedding(&embedding_to_blob(&e)), e);
    }

    #[test]
    fn generic_labels() {
        assert!(is_generic_label("Speaker 1"));
        assert!(is_generic_label(" Speaker 12 "));
        for real in ["Me", "Others", "Thandi", "Speaker", "Speaker One", "Speaker 1b"] {
            assert!(!is_generic_label(real), "{real:?} should not be generic");
        }
    }

    #[test]
    fn naming_accuracy_metric() {
        let pairs = vec![
            ("Thandi".to_string(), "Thandi".to_string()),
            ("Speaker 2".to_string(), "Oz".to_string()),
        ];
        assert_eq!(naming_accuracy(&pairs), 0.5);
        assert_eq!(naming_accuracy(&[]), 1.0);
    }
}
