//! Lalela's alternative-ASR sidecar. Child process of the main app; speaks
//! newline-delimited JSON on stdin/stdout (mirrors lalela-llm):
//!
//!   {"op":"engines"}                                   -> {"ok":true,"engines":[…]}
//!   {"op":"load","engine":"parakeet","model_path":"…"} -> {"ok":true}
//!   {"op":"transcribe","pcm_b64":"<f32le>","offset_ms":0,
//!    "speaker":"Me","bias":{…}}                        -> {"ok":true,"segments":[…]}
//!
//! Any failure yields {"ok":false,"error":"…"}. stderr is logs only.
//!
//! Engines are feature-gated modules that implement `Engine`; this build
//! ships none (the host + protocol land first, per Slice 8 of the
//! Intelligence Layer PRD — Parakeet is the first real engine).

use std::io::{BufRead, Write};

use serde::{Deserialize, Serialize};

/// Canonical transcript line — must stay shape-identical to
/// `transcribe::Segment` in the app (t0_ms/t1_ms/text/speaker).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Segment {
    pub t0_ms: i64,
    pub t1_ms: i64,
    pub text: String,
    pub speaker: String,
}

#[derive(Debug, Deserialize)]
pub struct BiasTerm {
    pub term: String,
    #[serde(default)]
    pub weight: f32,
    #[serde(default)]
    pub sounds_like: Vec<String>,
}

#[derive(Debug, Default, Deserialize)]
pub struct EngineBias {
    #[serde(default)]
    pub initial_prompt: Option<String>,
    #[serde(default)]
    pub terms: Vec<BiasTerm>,
}

#[derive(Deserialize)]
struct Request {
    op: String,
    engine: Option<String>,
    #[allow(dead_code)] // consumed once the first engine lands
    model_path: Option<String>,
    pcm_b64: Option<String>,
    offset_ms: Option<i64>,
    speaker: Option<String>,
    bias: Option<EngineBias>,
}

#[derive(Serialize, Default)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    engines: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    segments: Option<Vec<Segment>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// A hosted speech engine. Implementations are feature-gated modules.
pub trait Engine {
    fn transcribe(
        &mut self,
        pcm_16k_mono: &[f32],
        offset_ms: i64,
        speaker: &str,
        bias: &EngineBias,
    ) -> Result<Vec<Segment>, String>;
}

/// Engine ids this build supports. Feature-gated engines append here.
fn available_engines() -> Vec<String> {
    Vec::new()
}

fn build_engine(id: &str, _model_path: Option<&str>) -> Result<Box<dyn Engine>, String> {
    Err(format!("engine \"{id}\" is not available in this build"))
}

/// Decode base64-encoded little-endian f32 PCM.
pub fn decode_pcm(b64: &str) -> Result<Vec<f32>, String> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("bad pcm_b64: {e}"))?;
    if bytes.len() % 4 != 0 {
        return Err("pcm_b64 length is not a multiple of 4".into());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

fn reply(out: &mut impl Write, resp: &Response) {
    let line = serde_json::to_string(resp)
        .unwrap_or_else(|_| r#"{"ok":false,"error":"response serialization failed"}"#.to_string());
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn err(out: &mut impl Write, msg: impl Into<String>) {
    reply(out, &Response { ok: false, error: Some(msg.into()), ..Default::default() });
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();
    let mut engine: Option<Box<dyn Engine>> = None;

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                err(&mut stdout, format!("bad request: {e}"));
                continue;
            }
        };
        match req.op.as_str() {
            "engines" => reply(
                &mut stdout,
                &Response { ok: true, engines: Some(available_engines()), ..Default::default() },
            ),
            "load" => {
                let Some(id) = req.engine.as_deref() else {
                    err(&mut stdout, "load requires \"engine\"");
                    continue;
                };
                match build_engine(id, req.model_path.as_deref()) {
                    Ok(e) => {
                        engine = Some(e);
                        reply(&mut stdout, &Response { ok: true, ..Default::default() });
                    }
                    Err(e) => err(&mut stdout, e),
                }
            }
            "transcribe" => {
                let Some(active) = engine.as_mut() else {
                    err(&mut stdout, "no engine loaded (send \"load\" first)");
                    continue;
                };
                let pcm = match req.pcm_b64.as_deref().map(decode_pcm) {
                    Some(Ok(p)) => p,
                    Some(Err(e)) => {
                        err(&mut stdout, e);
                        continue;
                    }
                    None => {
                        err(&mut stdout, "transcribe requires \"pcm_b64\"");
                        continue;
                    }
                };
                let bias = req.bias.unwrap_or_default();
                match active.transcribe(
                    &pcm,
                    req.offset_ms.unwrap_or(0),
                    req.speaker.as_deref().unwrap_or("Me"),
                    &bias,
                ) {
                    Ok(segments) => reply(
                        &mut stdout,
                        &Response { ok: true, segments: Some(segments), ..Default::default() },
                    ),
                    Err(e) => err(&mut stdout, e),
                }
            }
            other => err(&mut stdout, format!("unknown op: {other}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pcm_roundtrip() {
        use base64::Engine as _;
        let samples: Vec<f32> = vec![0.0, 0.5, -0.5, 1.0, -1.0];
        let mut bytes = Vec::new();
        for s in &samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        assert_eq!(decode_pcm(&b64).unwrap(), samples);
    }

    #[test]
    fn pcm_rejects_misaligned_input() {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD.encode([1u8, 2, 3]);
        assert!(decode_pcm(&b64).is_err());
        assert!(decode_pcm("not base64!!!").is_err());
    }

    #[test]
    fn segment_shape_matches_app_canonical_form() {
        let seg = Segment { t0_ms: 0, t1_ms: 1000, text: "hi".into(), speaker: "Me".into() };
        let json = serde_json::to_value(&seg).unwrap();
        assert_eq!(
            json,
            serde_json::json!({"t0_ms": 0, "t1_ms": 1000, "text": "hi", "speaker": "Me"})
        );
    }

    #[test]
    fn this_build_advertises_no_engines_and_rejects_load() {
        assert!(available_engines().is_empty());
        assert!(build_engine("parakeet", None).is_err());
    }

    #[test]
    fn request_parses_bias() {
        let req: Request = serde_json::from_str(
            r#"{"op":"transcribe","pcm_b64":"","bias":{"initial_prompt":"Auxo","terms":[{"term":"Lalela","weight":2.0}]}}"#,
        )
        .unwrap();
        let bias = req.bias.unwrap();
        assert_eq!(bias.initial_prompt.as_deref(), Some("Auxo"));
        assert_eq!(bias.terms[0].term, "Lalela");
    }
}
