//! Gold-set harness — import parsing (Intelligence Layer, Slice 2).
//!
//! Runs the real import parser over sample files in `tests/gold/imports/`
//! and asserts the classification contract: speaker-structured files become
//! transcripts with the right speakers/timestamps; prose stays a document
//! and is never dressed up as a fake transcript.

#![cfg(not(target_os = "ios"))]

use lalela_lib::import::preview_file;

fn gold(name: &str) -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/gold/imports").join(name)
}

#[test]
fn gold_otter_style_txt_is_a_timestamped_transcript() {
    let p = preview_file(&gold("otter-style.txt")).unwrap();
    assert_eq!(p.kind, "transcript");
    assert_eq!(p.detected.as_deref(), Some("timestamped-speakers"));
    assert_eq!(p.segments.len(), 4);
    assert_eq!(p.segments[1].speaker, "Thandi Mokoena");
    assert_eq!(p.segments[1].t0_ms, 19_000);
    assert!(p.segments[1].text.contains("PDF path"), "block continuation lines must merge");
    assert_eq!(p.segments[3].t0_ms, 70_000);
}

#[test]
fn gold_teams_style_vtt_is_a_transcript_with_voice_tags() {
    let p = preview_file(&gold("teams-style.vtt")).unwrap();
    assert_eq!(p.kind, "transcript");
    assert_eq!(p.detected.as_deref(), Some("vtt"));
    assert_eq!(p.segments.len(), 3);
    assert_eq!(p.segments[1].speaker, "Lindiwe Nkosi");
    assert_eq!(p.segments[1].t0_ms, 6_000);
}

#[test]
fn gold_prose_notes_stay_a_document() {
    let p = preview_file(&gold("meeting-notes.md")).unwrap();
    assert_eq!(p.kind, "document", "prose must never become a synthetic transcript");
    assert!(p.segments.is_empty());
    assert!(p.text.contains("ship the importer"));
}

#[test]
fn unsupported_extension_fails_with_a_clear_message() {
    let err = preview_file(std::path::Path::new("/tmp/nope.xyz")).unwrap_err();
    assert!(err.contains("unsupported file type"));
}
