//! Client for the `lalela-asr` sidecar: alternative speech engines (Parakeet,
//! Granite) run out-of-process and speak newline-delimited JSON on
//! stdin/stdout, mirroring the `lalela-llm` protocol:
//!
//!   {"op":"engines"}                                  -> {"ok":true,"engines":["parakeet"]}
//!   {"op":"load","engine":"parakeet","model_path":…}  -> {"ok":true}
//!   {"op":"transcribe","pcm_b64":"<f32le>","offset_ms":0,
//!    "speaker":"Me","bias":{…}}                       -> {"ok":true,"segments":[…]}
//!
//! The app process never links a second speech runtime (ggml/NeMo/MLX
//! collision — the same invariant that made `lalela-llm` a sidecar).

use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

use base64::Engine as _;
use serde::Deserialize;

use super::{AsrEngine, EngineBias};
use crate::transcribe::Segment;

const SIDECAR_NAME: &str = "lalela-asr";

#[derive(Deserialize)]
struct Response {
    ok: bool,
    #[serde(default)]
    engines: Option<Vec<String>>,
    #[serde(default)]
    segments: Option<Vec<Segment>>,
    #[serde(default)]
    error: Option<String>,
}

/// Locate the sidecar binary: next to the app binary in a bundle, else the
/// cargo target dir during development (same strategy as `lalela-llm`).
fn resolve_binary() -> Option<std::path::PathBuf> {
    if let Some(p) = crate::sidecar::resolve(SIDECAR_NAME, "") {
        return Some(p);
    }
    if let Ok(target) = std::env::var("CARGO_TARGET_DIR") {
        for profile in ["release", "debug"] {
            let candidate = std::path::Path::new(&target).join(profile).join(SIDECAR_NAME);
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

fn roundtrip(stdin: &mut ChildStdin, stdout: &mut BufReader<ChildStdout>, req: &serde_json::Value) -> Result<Response, String> {
    let body = serde_json::to_string(req).map_err(|e| e.to_string())?;
    writeln!(stdin, "{body}").map_err(|e| format!("{SIDECAR_NAME} write failed: {e}"))?;
    stdin.flush().map_err(|e| e.to_string())?;
    let mut line = String::new();
    stdout
        .read_line(&mut line)
        .map_err(|e| format!("{SIDECAR_NAME} read failed: {e}"))?;
    if line.is_empty() {
        return Err(format!("{SIDECAR_NAME} exited unexpectedly"));
    }
    serde_json::from_str::<Response>(&line).map_err(|e| format!("{SIDECAR_NAME} bad response: {e}"))
}

fn spawn() -> Result<(Child, ChildStdin, BufReader<ChildStdout>), String> {
    let bin = resolve_binary().ok_or_else(|| format!("{SIDECAR_NAME} helper not found"))?;
    let mut child = Command::new(&bin)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("could not start {SIDECAR_NAME}: {e}"))?;
    let stdin = child.stdin.take().ok_or(format!("{SIDECAR_NAME} stdin unavailable"))?;
    let stdout = BufReader::new(child.stdout.take().ok_or(format!("{SIDECAR_NAME} stdout unavailable"))?);
    Ok((child, stdin, stdout))
}

/// Ask the sidecar which engines this build supports. `None`/empty when the
/// binary is missing — callers treat that as "whisper only".
pub fn list_engines() -> Option<Vec<String>> {
    let (mut child, mut stdin, mut stdout) = spawn().ok()?;
    let resp = roundtrip(&mut stdin, &mut stdout, &serde_json::json!({"op": "engines"})).ok();
    let _ = child.kill();
    let _ = child.wait();
    resp.and_then(|r| if r.ok { r.engines } else { None })
}

/// A running sidecar engine. Dropping it kills the child process.
pub struct SidecarEngine {
    id: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl SidecarEngine {
    pub fn start(engine_id: &str) -> Result<Self, String> {
        let (mut child, mut stdin, mut stdout) = spawn()?;
        let resp = roundtrip(
            &mut stdin,
            &mut stdout,
            &serde_json::json!({"op": "load", "engine": engine_id}),
        );
        match resp {
            Ok(r) if r.ok => Ok(Self { id: engine_id.to_string(), child, stdin, stdout }),
            Ok(r) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(r.error.unwrap_or_else(|| "engine load failed".into()))
            }
            Err(e) => {
                let _ = child.kill();
                let _ = child.wait();
                Err(e)
            }
        }
    }
}

impl AsrEngine for SidecarEngine {
    fn id(&self) -> &str {
        &self.id
    }

    fn transcribe(
        &mut self,
        audio_16k_mono: &[f32],
        offset_ms: i64,
        speaker: &str,
        bias: &EngineBias,
    ) -> Result<Vec<Segment>, String> {
        // f32 little-endian PCM as base64 — compact enough for 8 s windows
        // (~500 KB) and unambiguous across the process boundary.
        let mut bytes = Vec::with_capacity(audio_16k_mono.len() * 4);
        for s in audio_16k_mono {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let pcm_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let resp = roundtrip(
            &mut self.stdin,
            &mut self.stdout,
            &serde_json::json!({
                "op": "transcribe",
                "pcm_b64": pcm_b64,
                "offset_ms": offset_ms,
                "speaker": speaker,
                "bias": bias,
            }),
        )?;
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "transcription failed".into()));
        }
        Ok(resp.segments.unwrap_or_default())
    }
}

impl Drop for SidecarEngine {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
