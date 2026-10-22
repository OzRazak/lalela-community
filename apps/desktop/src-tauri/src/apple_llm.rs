//! Apple's on-device Foundation Models LLM, offered as an optional `apple:`
//! synthesis provider on Apple-Intelligence hardware. The **map-reduce logic is
//! identical on both Apple platforms** (same ~4k-token window, same chunking);
//! only the transport that reaches the model differs:
//!
//! * **macOS 26+** — a resident `lalela-apple-llm` Swift helper child process
//!   speaking newline-delimited JSON over stdio (same shape as the `lalela-llm`
//!   sidecar, `src/local_llm.rs`); one process serves every request.
//! * **iOS 26+** — the in-process Rust↔Swift bridge (`src/apple_bridge.rs`),
//!   because App Store apps can't spawn child processes. Same request/reply JSON
//!   (`{"op":"generate","system","user"}` → `{"ok",…}`), just carried over the
//!   C ABI instead of stdio.
//!
//! Foundation Models has a small context window (spike-measured ≈4k tokens:
//! ~2,500 words prefills fine, ~3,500 throws `exceededContextWindowSize`), far
//! below the ggml sidecar's 32k. Long transcripts are therefore handled here
//! with **map-reduce chunking** rather than middle-truncation.

#![cfg(any(target_os = "macos", target_os = "ios"))]

use std::sync::{Mutex, OnceLock};

use serde::Deserialize;

use crate::commands::AppleLlmStatus;

/// Feed a single call at most this many words. Kept well under the measured
/// ceiling (~2,500 words) so the model still has room to answer.
const SINGLE_CALL_WORDS: usize = 2_000;
/// Target words per map chunk when splitting a long transcript.
const CHUNK_WORDS: usize = 1_800;
/// Defensive floor: if an input this small still overflows the context, stop
/// splitting and report the error rather than recursing forever.
const MIN_CHUNK_WORDS: usize = 200;

/// System prompt for the map step — condense one portion, losing nothing.
const MAP_SYSTEM: &str = "You are condensing one portion of a longer meeting transcript. Keep every concrete fact, name, decision, and action item. Output terse notes.";

/// The reply shape both transports (macOS stdio helper + iOS bridge) return —
/// they speak the exact same JSON, so one struct decodes both.
#[derive(Deserialize)]
struct HelperReply {
    ok: bool,
    available: Option<bool>,
    reason: Option<String>,
    content: Option<String>,
    error: Option<String>,
    code: Option<String>,
}

/// Serialises whole generations so two concurrent `generate` calls never
/// interleave their multi-step map-reduce sequences on the shared model.
/// (On macOS this also protects the single resident helper's stdio; on iOS the
/// bridge makes a fresh session per call, but serialising keeps behaviour — and
/// resource use — identical across platforms.)
fn gen_gate() -> &'static Mutex<()> {
    static GATE: OnceLock<Mutex<()>> = OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
}

/// Interpret a transport reply as a generation outcome. Shared by both
/// transports so the ok / context_exceeded / other mapping is byte-identical.
fn interpret(resp: HelperReply) -> Result<String, GenError> {
    if resp.ok {
        Ok(resp.content.unwrap_or_default())
    } else if resp.code.as_deref() == Some("context_exceeded") {
        Err(GenError::ContextExceeded)
    } else {
        Err(GenError::Other(
            resp.error.unwrap_or_else(|| "apple generation failed".into()),
        ))
    }
}

/// Generate `system_prompt` over `transcript` with map-reduce chunking for long
/// inputs. Blocking — the caller runs it inside spawn_blocking (which also keeps
/// the iOS bridge off the main thread, a hard requirement of `apple_bridge`).
pub fn generate(system_prompt: &str, transcript: &str) -> Result<String, String> {
    let _gate = gen_gate().lock().map_err(|_| "apple llm gate poisoned".to_string())?;

    // Short enough → one call.
    if word_count(transcript) <= SINGLE_CALL_WORDS {
        return generate_one(system_prompt, transcript);
    }
    // Long → map each chunk to terse notes, reducing repeatedly until the notes
    // fit a single call, then run the caller's real prompt over them.
    let condensed = condense(transcript)?;
    generate_one(system_prompt, &condensed)
}

/// Map-reduce `text` down to ≤ `SINGLE_CALL_WORDS` of notes.
fn condense(text: &str) -> Result<String, String> {
    let mut current = text.to_string();
    loop {
        let chunks = split_words(&current, CHUNK_WORDS);
        let mut notes = Vec::with_capacity(chunks.len());
        for chunk in &chunks {
            notes.push(generate_one(MAP_SYSTEM, chunk)?);
        }
        let joined = notes.join("\n\n");
        // Fits now, or a pass that didn't shrink (rare) — either way stop and
        // let the final reduce call (with its own context_exceeded fallback)
        // be the backstop.
        if word_count(&joined) <= SINGLE_CALL_WORDS || word_count(&joined) >= word_count(&current) {
            return Ok(joined);
        }
        current = joined;
    }
}

/// One generation with a defensive fallback: if the model reports the context
/// window was exceeded despite our word estimate, halve the input, condense
/// each half to notes, and retry the real prompt over those.
fn generate_one(system: &str, user: &str) -> Result<String, String> {
    match generate_call(system, user) {
        Ok(content) => Ok(content),
        Err(GenError::Other(e)) => Err(e),
        Err(GenError::ContextExceeded) => {
            if word_count(user) <= MIN_CHUNK_WORDS {
                return Err(
                    "Apple's on-device model ran out of context and the text couldn't be reduced further".into(),
                );
            }
            let half = (word_count(user) / 2).max(1);
            let parts = split_words(user, half);
            if parts.len() <= 1 {
                return Err("Apple's on-device model ran out of context".into());
            }
            let mut notes = Vec::with_capacity(parts.len());
            for part in &parts {
                notes.push(generate_one(MAP_SYSTEM, part)?);
            }
            generate_one(system, &notes.join("\n\n"))
        }
    }
}

/// Distinguishes a context overflow (recoverable by chunking) from any other
/// failure. Populated by each platform's `generate_call` via `interpret`.
enum GenError {
    ContextExceeded,
    Other(String),
}

fn word_count(s: &str) -> usize {
    s.split_whitespace().count()
}

/// Split `text` into chunks of about `target` words, breaking at line
/// boundaries so a chunk doesn't cut mid-sentence. A single line longer than
/// `target` is hard-split on words.
fn split_words(text: &str, target: usize) -> Vec<String> {
    let target = target.max(1);
    let mut chunks: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut cur_words = 0usize;
    for line in text.split_inclusive('\n') {
        let n = line.split_whitespace().count();
        if cur_words > 0 && cur_words + n > target {
            chunks.push(std::mem::take(&mut cur));
            cur_words = 0;
        }
        if n > target {
            if !cur.is_empty() {
                chunks.push(std::mem::take(&mut cur));
                cur_words = 0;
            }
            let words: Vec<&str> = line.split_whitespace().collect();
            for piece in words.chunks(target) {
                chunks.push(piece.join(" "));
            }
            continue;
        }
        cur.push_str(line);
        cur_words += n;
    }
    if !cur.trim().is_empty() {
        chunks.push(cur);
    }
    chunks.retain(|c| !c.trim().is_empty());
    if chunks.is_empty() {
        chunks.push(text.to_string());
    }
    chunks
}

// ===========================================================================
// Transport A — macOS: resident `lalela-apple-llm` Swift helper over stdio.
// ===========================================================================
#[cfg(target_os = "macos")]
mod transport {
    use super::{interpret, AppleLlmStatus, GenError, HelperReply};
    use std::io::{BufRead, BufReader, Write};
    use std::path::PathBuf;
    use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
    use std::sync::{Mutex, OnceLock};

    /// The resident Swift helper process and its stdio pipes.
    struct AppleProc {
        child: Child,
        stdin: ChildStdin,
        stdout: BufReader<ChildStdout>,
    }

    impl Drop for AppleProc {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    /// The single resident helper (spawned lazily, kept alive for the session).
    fn helper() -> &'static Mutex<Option<AppleProc>> {
        static PROC: OnceLock<Mutex<Option<AppleProc>>> = OnceLock::new();
        PROC.get_or_init(|| Mutex::new(None))
    }

    /// Locate the helper: bundled next to the executable (Contents/MacOS/), else
    /// the absolute path build.rs baked in. `None` when it was never compiled
    /// (older toolchain / missing FoundationModels) — the feature is then simply
    /// absent.
    fn helper_path() -> Option<PathBuf> {
        let build_path = option_env!("LALELA_APPLE_LLM_BIN").unwrap_or("");
        crate::sidecar::resolve("lalela-apple-llm", build_path)
    }

    fn spawn() -> Result<AppleProc, String> {
        let path = helper_path().ok_or("Apple Intelligence helper not available")?;
        let mut child = Command::new(&path)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| format!("could not start lalela-apple-llm: {e}"))?;
        let stdin = child.stdin.take().ok_or("apple helper stdin unavailable")?;
        let stdout = BufReader::new(child.stdout.take().ok_or("apple helper stdout unavailable")?);
        Ok(AppleProc { child, stdin, stdout })
    }

    /// One NDJSON round-trip. No read timeout on purpose: a generation can take
    /// minutes and must not be cut short (mirrors the local_llm sidecar).
    fn request(proc: &mut AppleProc, body: &serde_json::Value) -> Result<HelperReply, String> {
        writeln!(proc.stdin, "{body}").map_err(|e| format!("apple helper write failed: {e}"))?;
        proc.stdin
            .flush()
            .map_err(|e| format!("apple helper write failed: {e}"))?;
        let mut line = String::new();
        proc.stdout
            .read_line(&mut line)
            .map_err(|e| format!("apple helper read failed: {e}"))?;
        if line.is_empty() {
            return Err("apple helper exited unexpectedly".into());
        }
        serde_json::from_str(&line).map_err(|e| format!("apple helper bad response: {e}"))
    }

    /// One availability probe against the resident helper. `None` means "could
    /// not probe right now" (the helper's stdio is mid round-trip) — the shared
    /// `status()` wrapper then falls back to the last known status. A
    /// missing/old/crashed helper is reported as unavailable with no reason
    /// (the card then hides), so the UI looks exactly as today on ineligible
    /// machines.
    pub fn status_probe() -> Option<AppleLlmStatus> {
        if helper_path().is_none() {
            return Some(AppleLlmStatus::default());
        }
        // try_lock, never lock: the wrapper already holds the gen gate, but a
        // belt-and-braces non-blocking guarantee costs nothing.
        let mut guard = helper().try_lock().ok()?;
        if guard.is_none() {
            match spawn() {
                Ok(p) => *guard = Some(p),
                Err(_) => return Some(AppleLlmStatus::default()),
            }
        }
        let proc = guard.as_mut().expect("just spawned");
        match request(proc, &serde_json::json!({ "op": "status" })) {
            Ok(resp) => Some(AppleLlmStatus {
                available: resp.available.unwrap_or(false),
                reason: resp.reason,
            }),
            Err(_) => {
                // Broken pipe / crashed helper: drop it and hide the card rather
                // than surfacing a raw error string as the "reason".
                drop(guard.take());
                Some(AppleLlmStatus::default())
            }
        }
    }

    /// Low-level single round-trip to the resident helper, with one respawn on a
    /// broken pipe (helper crashed / was killed), then give up.
    pub fn generate_call(system: &str, user: &str) -> Result<String, GenError> {
        let mut guard = helper()
            .lock()
            .map_err(|_| GenError::Other("apple llm state poisoned".into()))?;
        if guard.is_none() {
            *guard = Some(spawn().map_err(GenError::Other)?);
        }
        let body = serde_json::json!({ "op": "generate", "system": system, "user": user });
        let proc = guard.as_mut().expect("just spawned");
        let resp = match request(proc, &body) {
            Ok(r) => r,
            Err(_) => {
                drop(guard.take());
                *guard = Some(spawn().map_err(GenError::Other)?);
                request(guard.as_mut().expect("just spawned"), &body).map_err(GenError::Other)?
            }
        };
        interpret(resp)
    }
}

// ===========================================================================
// Transport B — iOS: the in-process Rust↔Swift bridge (`src/apple_bridge.rs`).
// No child process to spawn/respawn; each request is a self-contained C-ABI
// round-trip carrying the same JSON the macOS helper speaks.
// ===========================================================================
#[cfg(target_os = "ios")]
mod transport {
    use super::{interpret, AppleLlmStatus, GenError, HelperReply};

    /// One request/reply through the bridge, decoded into the shared reply shape.
    fn roundtrip(body: &serde_json::Value) -> Result<HelperReply, String> {
        let value = crate::apple_bridge::request(body)?;
        serde_json::from_value(value).map_err(|e| format!("apple bridge bad reply: {e}"))
    }

    /// One availability probe through the bridge (a self-contained round-trip;
    /// nothing to contend with, so this never returns `None`). An old OS /
    /// ineligible device / any bridge failure resolves to unavailable (the card
    /// hides or greys), so the UI looks exactly as today on machines that can't
    /// run it.
    pub fn status_probe() -> Option<AppleLlmStatus> {
        match roundtrip(&serde_json::json!({ "op": "status" })) {
            Ok(resp) => Some(AppleLlmStatus {
                available: resp.available.unwrap_or(false),
                reason: resp.reason,
            }),
            Err(_) => Some(AppleLlmStatus::default()),
        }
    }

    /// Single round-trip through the bridge; a transport-level failure (bad
    /// reply, NUL in payload) maps to `GenError::Other`, everything else to the
    /// shared `interpret` (which distinguishes context_exceeded).
    pub fn generate_call(system: &str, user: &str) -> Result<String, GenError> {
        let body = serde_json::json!({ "op": "generate", "system": system, "user": user });
        match roundtrip(&body) {
            Ok(resp) => interpret(resp),
            Err(e) => Err(GenError::Other(e)),
        }
    }
}

use transport::generate_call;

/// Last resolved availability, so a `status()` probe that can't run right now
/// (a generation is holding the gate) answers from cache instead of blocking on
/// it — every model picker re-probes on mount, and a probe can be stuck behind
/// a ~minute-long map-reduce chunk, which made the Apple option disappear and
/// reappear mid-generation. Availability only ever gains during a session (a
/// downloading model finishing), never loses, so once we've seen
/// `available:true` we keep it and never re-probe.
fn last_status() -> &'static Mutex<Option<AppleLlmStatus>> {
    static LAST: OnceLock<Mutex<Option<AppleLlmStatus>>> = OnceLock::new();
    LAST.get_or_init(|| Mutex::new(None))
}

/// A clone of the last resolved status, if we've ever resolved one.
fn cached_status() -> Option<AppleLlmStatus> {
    last_status().lock().ok().and_then(|g| g.clone())
}

/// Remember (and echo back) a freshly resolved status.
fn store_status(s: AppleLlmStatus) -> AppleLlmStatus {
    if let Ok(mut g) = last_status().lock() {
        *g = Some(s.clone());
    }
    s
}

/// Availability of Apple's on-device model, for the Settings card + picker
/// gating. Never errors on mere absence, and **never blocks behind a
/// generation**: once availability is known it's cached for the session and
/// answered instantly; while still unknown/unavailable it may re-probe, but
/// only when the generation gate is uncontended — otherwise it returns the
/// last known status, so a picker mounting mid-generation keeps the option it
/// last showed instead of blanking it.
pub fn status() -> Result<AppleLlmStatus, String> {
    // Known available → answer from cache; availability never regresses within
    // a session, so we must not re-probe (and risk waiting on a generation)
    // just to re-confirm something static.
    if let Some(cached) = cached_status() {
        if cached.available {
            return Ok(cached);
        }
    }
    let _gen = match gen_gate().try_lock() {
        Ok(g) => g,
        Err(_) => return Ok(cached_status().unwrap_or_default()),
    };
    match transport::status_probe() {
        Some(s) => Ok(store_status(s)),
        None => Ok(cached_status().unwrap_or_default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};

    #[test]
    fn status_cache_roundtrips() {
        store_status(AppleLlmStatus {
            available: false,
            reason: Some("model still downloading".into()),
        });
        let a = cached_status().expect("stored");
        assert!(!a.available);
        assert_eq!(a.reason.as_deref(), Some("model still downloading"));

        store_status(AppleLlmStatus { available: true, reason: None });
        assert!(cached_status().expect("stored").available);
    }

    /// The regression: a probe must never block behind an in-flight generation.
    /// With the gen gate held, `status()` returns promptly (from cache, or
    /// unavailable) instead of waiting on a transport round-trip.
    #[test]
    fn status_never_blocks_behind_a_generation() {
        let _gen = gen_gate().lock().expect("gate");
        let start = Instant::now();
        let out = status();
        assert!(out.is_ok());
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "status() blocked behind the generation gate",
        );
    }
}
