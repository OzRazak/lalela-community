//! Apple's on-device SpeechAnalyzer / SpeechTranscriber offered as an optional
//! ASR engine. The **engine logic is identical on both Apple platforms** —
//! begin the "Me" stream eagerly, feed base64 f32le PCM windows, map replies to
//! canonical `Segment`s, flush the tail at `finish()` — only the transport that
//! reaches the Swift code differs (mirrors `src/apple_llm.rs`):
//!
//! * **macOS 26+** — a resident `lalela-apple-asr` Swift helper CHILD PROCESS
//!   speaking newline-delimited JSON over stdio (base64 f32le PCM). A framework
//!   trap kills the helper, not the app.
//! * **iOS 26+** — the in-process Rust↔Swift bridge (`src/apple_bridge.rs`),
//!   because App Store apps can't spawn child processes. Same request/reply JSON,
//!   carried over the C ABI instead of stdio; the Swift side holds the resident
//!   per-recording analyzer(s) that the macOS helper process would.
//!
//! Both hold a PERSISTENT analyzer per audio source, so segments span the 8 s
//! window boundaries (cross-window context). Timestamps: the `AsrEngine` contract
//! is meeting-relative (`offset_ms` pre-added, like whisper); we pass each
//! window's `offset_ms`, the Swift side seeds the analyzer timeline with it
//! (AnalyzerInput.bufferStartTime), so returned times are already meeting-relative
//! and used as-is — no per-window math, and skipped silent windows (a gap in
//! `offset_ms`) place nothing wrongly.
//!
//! The bridge (iOS) MUST be called off the main thread — the recording worker
//! thread that drives `transcribe`/`finish` is off-main, so that holds.

#![cfg(any(target_os = "macos", target_os = "ios"))]

use std::collections::HashSet;
use std::sync::OnceLock;

use base64::Engine as _;
use serde::Deserialize;

use super::{AsrEngine, EngineBias};
use crate::transcribe::Segment;

/// One transcript segment as the Swift side reports it (both transports speak
/// the exact same JSON, so one struct decodes both).
#[derive(Deserialize)]
struct HelperSeg {
    t0_ms: i64,
    t1_ms: i64,
    text: String,
    /// Stream name, present only on `finish` replies (several streams drain in
    /// one reply there; `feed` replies infer the speaker from the request).
    #[serde(default)]
    speaker: Option<String>,
}

/// The reply shape both transports return. Unknown fields (e.g. `downloaded`,
/// `code`) are ignored by serde, so this decodes every op's reply.
#[derive(Deserialize)]
struct Reply {
    ok: bool,
    #[serde(default)]
    available: Option<bool>,
    #[serde(default)]
    segments: Option<Vec<HelperSeg>>,
    #[serde(default)]
    error: Option<String>,
}

/// Whether Apple Speech can serve as an ASR engine on this device — the platform
/// transport is present AND `SpeechTranscriber` reports available AND a usable
/// locale resolves. Cached: probing does real work (spawns a helper on macOS,
/// crosses the bridge on iOS) and the picker asks on every Settings open.
pub fn available_cached() -> bool {
    static CACHE: OnceLock<bool> = OnceLock::new();
    *CACHE.get_or_init(transport::probe)
}

/// A running Apple Speech engine: one resident session (helper process on macOS,
/// the bridge's global analyzer on iOS), one persistent analyzer stream per
/// speaker. The recording worker calls `finish()` at stop to flush
/// late-finalizing tail segments; dropping the engine ends the session.
pub struct AppleAsrEngine {
    transport: transport::Transport,
    /// Speakers whose stream has been `begin`-ed ("Me" eagerly, "Others" lazily
    /// when system capture is on — iOS is mic-only, so only "Me" in practice).
    begun: HashSet<String>,
    /// Set by `finish()`: the analyzer streams are ended, so further feeds are
    /// invalid and Drop must not send a second finish.
    finished: bool,
}

impl AppleAsrEngine {
    /// Start the session and begin the primary "Me" stream eagerly, so asset
    /// install or pipeline errors surface HERE (→ `create_engine` falls back to
    /// whisper before recording) rather than mid-recording.
    pub fn start() -> Result<Self, String> {
        let mut transport = transport::Transport::start()?;
        let resp = transport.request(&serde_json::json!({ "op": "begin", "stream": "Me" }))?;
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "Apple Speech begin failed".into()));
        }
        let mut begun = HashSet::new();
        begun.insert("Me".to_string());
        Ok(Self { transport, begun, finished: false })
    }
}

/// Map a reply's segments to canonical `Segment`s, clamping times to keep
/// ordering. `default_speaker` is used when the Swift side didn't tag one
/// (the `feed` case, where the speaker is known from the request).
fn map_segments(segs: Option<Vec<HelperSeg>>, default_speaker: &str) -> Vec<Segment> {
    segs.unwrap_or_default()
        .into_iter()
        .map(|s| {
            let t0 = s.t0_ms.max(0);
            let t1 = s.t1_ms.max(t0);
            Segment {
                t0_ms: t0,
                t1_ms: t1,
                text: s.text,
                speaker: s.speaker.unwrap_or_else(|| default_speaker.to_string()),
            }
        })
        .collect()
}

impl AsrEngine for AppleAsrEngine {
    fn id(&self) -> &str {
        super::APPLE_ID
    }

    fn transcribe(
        &mut self,
        audio_16k_mono: &[f32],
        offset_ms: i64,
        speaker: &str,
        _bias: &EngineBias,
    ) -> Result<Vec<Segment>, String> {
        if self.finished {
            return Err("Apple Speech engine already finished".into());
        }
        // Lazily begin a stream for any new speaker (e.g. "Others" when system
        // capture is on), so each source keeps its own persistent analyzer and
        // the two sources never contaminate each other.
        if !self.begun.contains(speaker) {
            let resp = self
                .transport
                .request(&serde_json::json!({ "op": "begin", "stream": speaker }))?;
            if !resp.ok {
                return Err(resp.error.unwrap_or_else(|| "Apple Speech begin failed".into()));
            }
            self.begun.insert(speaker.to_string());
        }

        let mut bytes = Vec::with_capacity(audio_16k_mono.len() * 4);
        for s in audio_16k_mono {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        let pcm_b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
        let resp = self.transport.request(&serde_json::json!({
            "op": "feed",
            "stream": speaker,
            "offset_ms": offset_ms,
            "pcm": pcm_b64,
        }))?;
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "Apple Speech feed failed".into()));
        }

        // Segment times are already meeting-relative (the Swift side placed this
        // window at `offset_ms`); use as-is.
        Ok(map_segments(resp.segments, speaker))
    }

    /// End all analyzer streams and collect late-finalizing tail segments —
    /// typically the last sentence of the meeting, which no following audio
    /// forced out during `feed`. Speakers come from the Swift side (all streams
    /// drain in one reply here).
    fn finish(&mut self) -> Result<Vec<Segment>, String> {
        if self.finished {
            return Ok(Vec::new());
        }
        self.finished = true;
        let resp = self.transport.request(&serde_json::json!({ "op": "finish" }))?;
        if !resp.ok {
            return Err(resp.error.unwrap_or_else(|| "Apple Speech finish failed".into()));
        }
        Ok(map_segments(resp.segments, "Me"))
    }
}

impl Drop for AppleAsrEngine {
    fn drop(&mut self) {
        // If the worker never called finish() (e.g. it errored out), still end
        // the streams best-effort. After an explicit finish() the streams are
        // already ended, so a second op would be pointless.
        if !self.finished {
            self.transport.finish_best_effort();
        }
    }
}

// ===========================================================================
// Transport A — macOS: resident `lalela-apple-asr` Swift helper over stdio.
// A framework trap kills the helper (not the app); an empty read means it died.
// ===========================================================================
#[cfg(target_os = "macos")]
mod transport {
    use super::Reply;
    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

    const HELPER_NAME: &str = "lalela-apple-asr";

    /// Locate the helper: bundled next to the executable (Contents/MacOS/), else
    /// the absolute path build.rs baked in. `None` when it was never compiled
    /// (older toolchain / missing Speech 26 API) — the feature is then absent.
    fn helper_path() -> Option<PathBuf> {
        let build_path = option_env!("LALELA_APPLE_ASR_BIN").unwrap_or("");
        crate::sidecar::resolve(HELPER_NAME, build_path)
    }

    /// The resident helper process and its stdio pipes. Dropping it kills the child.
    struct Proc {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    }

    impl Drop for Proc {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    fn spawn() -> Result<Proc, String> {
        let bin = helper_path().ok_or_else(|| format!("{HELPER_NAME} helper not found"))?;
        let mut child = Command::new(&bin)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start {HELPER_NAME}: {e}"))?;
        let stdin = child.stdin.take().ok_or(format!("{HELPER_NAME} stdin unavailable"))?;
        let stdout =
            BufReader::new(child.stdout.take().ok_or(format!("{HELPER_NAME} stdout unavailable"))?);
        Ok(Proc { child, stdin, stdout })
    }

    /// One NDJSON round-trip. An empty read means the helper died (a Speech trap
    /// kills the helper, not the app) — surfaced as Err so the recording worker
    /// treats the window as failed rather than crashing.
    fn request(proc: &mut Proc, body: &serde_json::Value) -> Result<Reply, String> {
        writeln!(proc.stdin, "{body}").map_err(|e| format!("{HELPER_NAME} write failed: {e}"))?;
        proc.stdin.flush().map_err(|e| e.to_string())?;
        let mut line = String::new();
        proc.stdout
            .read_line(&mut line)
            .map_err(|e| format!("{HELPER_NAME} read failed: {e}"))?;
        if line.is_empty() {
            return Err(format!("{HELPER_NAME} exited unexpectedly"));
        }
        serde_json::from_str::<Reply>(&line).map_err(|e| format!("{HELPER_NAME} bad response: {e}"))
    }

    /// The macOS transport owns the resident helper process for a recording.
    pub struct Transport {
        proc: Proc,
    }

    impl Transport {
        pub fn start() -> Result<Self, String> {
            Ok(Self { proc: spawn()? })
        }

        pub fn request(&mut self, body: &serde_json::Value) -> Result<Reply, String> {
            request(&mut self.proc, body)
        }

        /// Best-effort finish on drop: write it, don't block on a reply; the
        /// child dies when `proc` drops.
        pub fn finish_best_effort(&mut self) {
            let _ = writeln!(self.proc.stdin, "{}", serde_json::json!({ "op": "finish" }));
            let _ = self.proc.stdin.flush();
        }
    }

    /// Probe by spawning a throwaway helper and asking `status`. The helper is
    /// killed when `proc` drops at the end of scope.
    pub fn probe() -> bool {
        if helper_path().is_none() {
            return false;
        }
        let Ok(mut proc) = spawn() else { return false };
        matches!(
            request(&mut proc, &serde_json::json!({ "op": "status" })),
            Ok(r) if r.ok && r.available.unwrap_or(false)
        )
    }
}

// ===========================================================================
// Transport B — iOS: the in-process Rust↔Swift bridge (`src/apple_bridge.rs`).
// No child process — the resident analyzer state lives in the Swift bridge's
// global session; each request is a self-contained C-ABI round-trip carrying
// the same JSON the macOS helper speaks. Called from the recording worker
// thread (off-main), which the bridge requires.
// ===========================================================================
#[cfg(target_os = "ios")]
mod transport {
    use super::Reply;

    fn roundtrip(body: &serde_json::Value) -> Result<Reply, String> {
        let value = crate::apple_bridge::request(body)?;
        serde_json::from_value(value).map_err(|e| format!("apple bridge bad asr reply: {e}"))
    }

    /// Zero-sized: the session state is the Swift bridge's global analyzer, so
    /// there is nothing to own here. `start()` clears any streams a previous
    /// recording left in that global session (Drop's best-effort finish normally
    /// does this — belt-and-braces, since the singleton outlives one recording).
    pub struct Transport;

    impl Transport {
        pub fn start() -> Result<Self, String> {
            let mut t = Transport;
            t.finish_best_effort();
            Ok(t)
        }

        pub fn request(&mut self, body: &serde_json::Value) -> Result<Reply, String> {
            roundtrip(body)
        }

        pub fn finish_best_effort(&mut self) {
            let _ = crate::apple_bridge::request(&serde_json::json!({ "op": "finish" }));
        }
    }

    /// Probe via the bridge's `status.asr` capability (SpeechTranscriber
    /// availability + a usable locale). Any bridge failure → unavailable.
    pub fn probe() -> bool {
        matches!(
            roundtrip(&serde_json::json!({ "op": "status", "cap": "asr" })),
            Ok(r) if r.ok && r.available.unwrap_or(false)
        )
    }
}
