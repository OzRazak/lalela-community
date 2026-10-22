//! Gold-set harness — speaker naming accuracy (Intelligence Layer, Slice 1).
//!
//! Runs the REAL matching logic (`speakers::best_match`, the same call
//! `stop_recording` makes) over fixture meetings in `tests/gold/speakers.json`
//! and prints a per-meeting + overall naming-accuracy score. Any change to
//! the matcher, threshold or enrolment math re-runs this; a drop below the
//! fixture's expected 100% fails the build.
//!
//! Growing the set: replace the synthetic embeddings with real extracted ones
//! (they are just f32 vectors) and add meetings — the harness scales as-is.
//! Summary-quality scoring (gold-set part b) lands with Slice 3, where an A/B
//! against the project brief exists to measure.

use lalela_lib::speakers::{best_match, is_generic_label, naming_accuracy};

use serde::Deserialize;

#[derive(Deserialize)]
struct Gold {
    enrolled: Vec<Enrolled>,
    meetings: Vec<GoldMeeting>,
}

#[derive(Deserialize)]
struct Enrolled {
    name: String,
    embedding: Vec<f32>,
}

#[derive(Deserialize)]
struct GoldMeeting {
    id: String,
    clusters: Vec<Cluster>,
}

#[derive(Deserialize)]
struct Cluster {
    label: String,
    embedding: Vec<f32>,
    /// Expected outcome: an enrolled name, or the generic label itself when
    /// the voice must NOT match anyone (stranger).
    reference: String,
}

#[test]
fn gold_speaker_naming_accuracy() {
    let raw = include_str!("gold/speakers.json");
    let gold: Gold = serde_json::from_str(raw).expect("gold/speakers.json parses");

    let prints: Vec<Vec<f32>> = gold.enrolled.iter().map(|e| e.embedding.clone()).collect();
    let mut all_pairs: Vec<(String, String)> = Vec::new();

    println!("\n=== GOLD SET: speaker naming ===");
    for meeting in &gold.meetings {
        let mut pairs: Vec<(String, String)> = Vec::new();
        for cluster in &meeting.clusters {
            let predicted = match best_match(&cluster.embedding, &prints) {
                Some((idx, _sim)) => gold.enrolled[idx].name.clone(),
                None => cluster.label.clone(), // unmatched voices keep the generic label
            };
            pairs.push((predicted, cluster.reference.clone()));
        }
        let score = naming_accuracy(&pairs);
        println!("  {:<22} accuracy = {:.2} ({} clusters)", meeting.id, score, pairs.len());
        all_pairs.extend(pairs);
    }

    let overall = naming_accuracy(&all_pairs);
    println!("  {:<22} accuracy = {overall:.2} ({} clusters)\n", "OVERALL", all_pairs.len());

    // Sanity on the fixture itself: it must exercise both outcomes.
    assert!(
        all_pairs.iter().any(|(_, r)| is_generic_label(r)),
        "gold set must include at least one stranger voice"
    );
    assert!(
        all_pairs.iter().any(|(_, r)| !is_generic_label(r)),
        "gold set must include at least one enrolled voice"
    );
    assert!(
        (overall - 1.0).abs() < f32::EPSILON,
        "naming accuracy regressed: {overall:.2} < 1.00 — a matcher/threshold change broke the gold set"
    );
}
