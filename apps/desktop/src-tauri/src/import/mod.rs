//! External transcript import (Intelligence Layer, Slice 2).
//!
//! Any transcript file (DOCX / PDF / TXT / MD / VTT) becomes a canonical
//! meeting record with provenance, running the same downstream as a live
//! recording. Extraction is Rust-native (docx-rs read path + pdf-extract) —
//! never agent-environment tooling, this runs inside the user's app.
//!
//! Honesty rule (PRD invariant): a file without speaker structure is stored
//! as a DOCUMENT (notes source), never dressed up as a fake transcript. And
//! text imports NEVER enrol voiceprints — there is no audio.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::transcribe::Segment;

// Audio-file import (Slice 7): decodes external recordings into the SAME
// transcription/diarization pipeline as a live recording (desktop-only,
// like this whole module).
pub mod audio;
#[cfg(desktop)]
pub mod frames;

/// What an import will become, shown to the user before saving.
/// (Deserialize too: the frontend hands the—possibly AI-structured—preview
/// back to `save_imported_meeting`.)
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImportPreview {
    /// "transcript" (speakers detected) or "document" (prose/notes).
    pub kind: String,
    /// Source file format: docx | pdf | txt | md | vtt.
    pub format: String,
    /// Which shape the parser recognised (None for documents).
    pub detected: Option<String>,
    /// Title suggestion (file stem).
    pub title: String,
    /// Parsed segments (empty for documents).
    pub segments: Vec<Segment>,
    /// Full extracted text (document body; also the input for AI structuring).
    pub text: String,
}

/// Document/transcript formats `preview_file` can extract (matches the arms
/// below and the picker filter in `commands::pick_import_file`).
pub const DOC_EXTENSIONS: &[&str] = &["docx", "pdf", "txt", "md", "vtt"];

/// Extract text and parse a file into an import preview.
pub fn preview_file(path: &Path) -> Result<ImportPreview, String> {
    let format = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .unwrap_or_default();
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported meeting")
        .to_string();

    let text = match format.as_str() {
        "docx" => extract_docx(path)?,
        "pdf" => extract_pdf(path)?,
        "txt" | "md" | "vtt" => {
            std::fs::read_to_string(path).map_err(|e| format!("could not read file: {e}"))?
        }
        other => {
            return Err(format!(
                "unsupported file type \".{other}\" — import DOCX, PDF, TXT, MD or VTT"
            ))
        }
    };
    Ok(preview_text(&text, &format, &title))
}

/// Parse already-extracted text (also used for AI-structured output).
pub fn preview_text(text: &str, format: &str, title: &str) -> ImportPreview {
    let (segments, detected) = parse_transcript(text);
    let kind = if segments.is_empty() { "document" } else { "transcript" };
    ImportPreview {
        kind: kind.to_string(),
        format: format.to_string(),
        detected,
        title: title.to_string(),
        segments,
        text: text.to_string(),
    }
}

fn extract_docx(path: &Path) -> Result<String, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("could not read file: {e}"))?;
    let docx = docx_rs::read_docx(&bytes).map_err(|e| format!("could not parse DOCX: {e:?}"))?;
    let mut out = String::new();
    for child in &docx.document.children {
        if let docx_rs::DocumentChild::Paragraph(p) = child {
            let line = p.raw_text();
            out.push_str(&line);
            out.push('\n');
        }
    }
    Ok(out)
}

fn extract_pdf(path: &Path) -> Result<String, String> {
    pdf_extract::extract_text(path).map_err(|e| format!("could not extract PDF text: {e}"))
}

// ---------- Transcript shape detection ----------

/// Parse "m:ss" / "mm:ss" / "h:mm:ss" (optionally with a ".mmm" fraction)
/// into milliseconds.
fn parse_ts(token: &str) -> Option<i64> {
    let token = token.trim();
    let (clock, frac) = match token.split_once('.') {
        Some((c, f)) => (c, f.parse::<i64>().unwrap_or(0)),
        None => (token, 0),
    };
    let parts: Vec<&str> = clock.split(':').collect();
    if parts.len() < 2 || parts.len() > 3 {
        return None;
    }
    let mut total: i64 = 0;
    for p in &parts {
        if p.is_empty() || p.len() > 2 || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        total = total * 60 + p.parse::<i64>().ok()?;
    }
    Some(total * 1000 + frac.min(999))
}

/// Strip one layer of (), [] or trailing ':' from a token.
fn unwrap_token(t: &str) -> &str {
    t.trim()
        .trim_end_matches(':')
        .trim_start_matches(['(', '['])
        .trim_end_matches([')', ']'])
}

/// A plausible person name for a speaker label: short, no sentence
/// punctuation, not itself a timestamp.
fn plausible_name(s: &str) -> bool {
    let s = s.trim();
    !s.is_empty()
        && s.len() <= 60
        && parse_ts(s).is_none()
        && !s.contains(['.', ',', '?', '!', ';'])
        && s.chars().any(|c| c.is_alphabetic())
        && s.split_whitespace().count() <= 5
}

/// One parsed line shape.
enum Line {
    /// "Name 0:05" or "Name (00:05):" — a header; text follows on later lines.
    Header { name: String, t_ms: i64 },
    /// "[0:05] Name: text" or "Name (0:05): text" or "Name: text" (t_ms 0).
    Full { name: String, t_ms: i64, text: String },
    Plain(String),
}

fn parse_line(line: &str) -> Line {
    let trimmed = line.trim();
    if trimmed.is_empty() {
        return Line::Plain(String::new());
    }

    // "[0:05] Name: text" — leading timestamp token, then "Name: text".
    let mut words = trimmed.splitn(2, char::is_whitespace);
    let first = words.next().unwrap_or_default();
    if let Some(t_ms) = parse_ts(unwrap_token(first)) {
        if let Some(rest) = words.next() {
            if let Some((name, text)) = rest.split_once(':') {
                if plausible_name(name) && !text.trim().is_empty() {
                    return Line::Full {
                        name: name.trim().to_string(),
                        t_ms,
                        text: text.trim().to_string(),
                    };
                }
            }
        }
    }

    // "Name 0:05" / "Name (00:05):" [+ optional trailing text] — Otter-style.
    let tokens: Vec<&str> = trimmed.split_whitespace().collect();
    for (i, tok) in tokens.iter().enumerate().skip(1) {
        if let Some(t_ms) = parse_ts(unwrap_token(tok)) {
            let name = tokens[..i].join(" ");
            let name = name.trim_end_matches(':').trim();
            if plausible_name(name) {
                let rest = tokens[i + 1..].join(" ");
                return if rest.trim().is_empty() {
                    Line::Header { name: name.to_string(), t_ms }
                } else {
                    Line::Full { name: name.to_string(), t_ms, text: rest.trim().to_string() }
                };
            }
            break;
        }
    }

    // "Name: text" — speaker line without a timestamp.
    if let Some((name, text)) = trimmed.split_once(':') {
        if plausible_name(name) && !text.trim().is_empty() {
            return Line::Full { name: name.trim().to_string(), t_ms: 0, text: text.trim().to_string() };
        }
    }

    Line::Plain(trimmed.to_string())
}

/// WEBVTT (Teams/Zoom exports): cues "hh:mm:ss.mmm --> …" with `<v Name>text`.
fn parse_vtt(text: &str) -> Vec<Segment> {
    let mut out = Vec::new();
    let mut current_t: Option<i64> = None;
    for line in text.lines() {
        let line = line.trim();
        if let Some((start, _end)) = line.split_once("-->") {
            current_t = parse_ts(start.trim());
            continue;
        }
        if line.is_empty() || line == "WEBVTT" || line.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Some(t_ms) = current_t else { continue };
        let (speaker, content) = if let Some(rest) = line.strip_prefix("<v ") {
            match rest.split_once('>') {
                Some((name, text)) => (
                    name.trim_end_matches('>').to_string(),
                    text.trim_end_matches("</v>").to_string(),
                ),
                None => ("Speaker".to_string(), line.to_string()),
            }
        } else {
            ("Speaker".to_string(), line.to_string())
        };
        let content = content.trim();
        if content.is_empty() {
            continue;
        }
        out.push(Segment { t0_ms: t_ms, t1_ms: t_ms, text: content.to_string(), speaker });
    }
    out
}

/// Detect + parse a transcript. Returns (segments, detected-shape); empty
/// segments = not a transcript (store as document).
pub fn parse_transcript(text: &str) -> (Vec<Segment>, Option<String>) {
    if text.trim_start().starts_with("WEBVTT") {
        let segs = parse_vtt(text);
        if !segs.is_empty() {
            return (segs, Some("vtt".to_string()));
        }
    }

    let mut segments: Vec<Segment> = Vec::new();
    let mut speaker_lines = 0usize;
    let mut nonempty_lines = 0usize;
    let mut timestamped = false;
    let mut current: Option<Segment> = None;

    for raw in text.lines() {
        match parse_line(raw) {
            Line::Plain(p) => {
                if p.is_empty() {
                    continue;
                }
                nonempty_lines += 1;
                // Continuation of an Otter-style block.
                if let Some(seg) = current.as_mut() {
                    if !seg.text.is_empty() {
                        seg.text.push(' ');
                    }
                    seg.text.push_str(&p);
                }
            }
            Line::Header { name, t_ms } => {
                nonempty_lines += 1;
                speaker_lines += 1;
                timestamped = true;
                if let Some(seg) = current.take().filter(|s| !s.text.is_empty()) {
                    segments.push(seg);
                }
                current = Some(Segment { t0_ms: t_ms, t1_ms: t_ms, text: String::new(), speaker: name });
            }
            Line::Full { name, t_ms, text } => {
                nonempty_lines += 1;
                speaker_lines += 1;
                if t_ms > 0 {
                    timestamped = true;
                }
                if let Some(seg) = current.take().filter(|s| !s.text.is_empty()) {
                    segments.push(seg);
                }
                segments.push(Segment { t0_ms: t_ms, t1_ms: t_ms, text, speaker: name });
            }
        }
    }
    if let Some(seg) = current.take().filter(|s| !s.text.is_empty()) {
        segments.push(seg);
    }

    let distinct_names: usize = {
        let mut names: Vec<&str> = segments.iter().map(|s| s.speaker.as_str()).collect();
        names.sort_unstable();
        names.dedup();
        names.len()
    };

    // A real transcript: several speaker lines forming most of the content,
    // from 2+ people — or fewer lines but explicitly timestamped. Anything
    // weaker is prose that happens to contain colons.
    let confident = (speaker_lines >= 4
        && distinct_names >= 2
        && speaker_lines * 2 >= nonempty_lines)
        || (timestamped && speaker_lines >= 2);

    if confident {
        let shape = if timestamped { "timestamped-speakers" } else { "speaker-lines" };
        (segments, Some(shape.to_string()))
    } else {
        (Vec::new(), None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn otter_style_name_ts_blocks() {
        let text = "\
Oz Razak  0:05
Morning everyone, let's get started.
We have a lot to cover.

Thandi Mokoena  0:32
Thanks Oz. The Auxo deal closed yesterday.
";
        let (segs, shape) = parse_transcript(text);
        assert_eq!(shape.as_deref(), Some("timestamped-speakers"));
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].speaker, "Oz Razak");
        assert_eq!(segs[0].t0_ms, 5000);
        assert!(segs[0].text.contains("lot to cover"));
        assert_eq!(segs[1].t0_ms, 32_000);
    }

    #[test]
    fn bracketed_ts_name_colon_lines() {
        let text = "\
[00:03] Oz: Welcome back.
[00:41] Thandi: Let's review the tasks.
[01:05] Oz: Sounds good.
";
        let (segs, shape) = parse_transcript(text);
        assert_eq!(shape.as_deref(), Some("timestamped-speakers"));
        assert_eq!(segs.len(), 3);
        assert_eq!(segs[1].speaker, "Thandi");
        assert_eq!(segs[1].t0_ms, 41_000);
        assert_eq!(segs[2].t0_ms, 65_000);
    }

    #[test]
    fn plain_speaker_colon_lines_without_timestamps() {
        let text = "\
Oz: Did the client sign?
Thandi: Yes, this morning.
Oz: Great, let's kick off next week.
Thandi: I'll set up the project folder.
";
        let (segs, shape) = parse_transcript(text);
        assert_eq!(shape.as_deref(), Some("speaker-lines"));
        assert_eq!(segs.len(), 4);
        assert!(segs.iter().all(|s| s.t0_ms == 0));
    }

    #[test]
    fn vtt_cues_with_voice_tags() {
        let text = "\
WEBVTT

1
00:00:03.000 --> 00:00:06.000
<v Oz Razak>Welcome to the standup.</v>

2
00:00:07.500 --> 00:00:09.000
<v Thandi>Yesterday I shipped the import flow.</v>
";
        let (segs, shape) = parse_transcript(text);
        assert_eq!(shape.as_deref(), Some("vtt"));
        assert_eq!(segs.len(), 2);
        assert_eq!(segs[0].speaker, "Oz Razak");
        assert_eq!(segs[0].t0_ms, 3000);
        assert_eq!(segs[1].t0_ms, 7500);
    }

    #[test]
    fn prose_is_a_document_not_a_fake_transcript() {
        let text = "\
Meeting notes: the team discussed the roadmap.
Key decision: ship the importer next week.
Note: Thandi raised a concern about timestamps.
";
        let (segs, shape) = parse_transcript(text);
        assert!(segs.is_empty(), "prose with colons must not become a transcript");
        assert!(shape.is_none());
        let preview = preview_text(text, "md", "notes");
        assert_eq!(preview.kind, "document");
    }

    #[test]
    fn timestamp_parsing() {
        assert_eq!(parse_ts("0:05"), Some(5000));
        assert_eq!(parse_ts("12:34"), Some(754_000));
        assert_eq!(parse_ts("1:02:03"), Some(3_723_000));
        assert_eq!(parse_ts("00:00:03.250"), Some(3250));
        assert_eq!(parse_ts("banana"), None);
        assert_eq!(parse_ts("12"), None);
        assert_eq!(parse_ts("123:45"), None);
    }

    #[test]
    fn docx_roundtrip_extraction() {
        // Build a DOCX with the writer half of docx-rs, then run the real
        // reader + parser over it — an end-to-end fixture with no binary blob.
        let docx = docx_rs::Docx::new()
            .add_paragraph(
                docx_rs::Paragraph::new()
                    .add_run(docx_rs::Run::new().add_text("Oz Razak  0:05")),
            )
            .add_paragraph(
                docx_rs::Paragraph::new()
                    .add_run(docx_rs::Run::new().add_text("Morning, quick sync today.")),
            )
            .add_paragraph(
                docx_rs::Paragraph::new()
                    .add_run(docx_rs::Run::new().add_text("Thandi Mokoena  0:20")),
            )
            .add_paragraph(
                docx_rs::Paragraph::new()
                    .add_run(docx_rs::Run::new().add_text("The importer parses DOCX now.")),
            );
        let dir = std::env::temp_dir().join("lalela-import-test");
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("fixture.docx");
        let file = std::fs::File::create(&path).unwrap();
        docx.build().pack(file).unwrap();

        let preview = preview_file(&path).unwrap();
        assert_eq!(preview.kind, "transcript");
        assert_eq!(preview.segments.len(), 2);
        assert_eq!(preview.segments[1].speaker, "Thandi Mokoena");
        assert_eq!(preview.segments[1].t0_ms, 20_000);
        let _ = std::fs::remove_file(&path);
    }
}
