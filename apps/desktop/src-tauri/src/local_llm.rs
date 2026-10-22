//! Bridge to the `lalela-llm` sidecar (local GGUF inference via llama.cpp).
//!
//! The main app cannot link llama.cpp — whisper-rs and llama-cpp-2 both vendor
//! ggml and collide at link time — so inference runs in a child process that
//! ships inside Lalela.app next to the other helpers. Protocol: NDJSON over
//! stdin/stdout (see crates/lalela-llm). The child keeps the model resident
//! (~4 GB for the default 4B model, ~2.5 GB RSS mmap'd); unload = kill the
//! child. CP5-L3: a background idle monitor auto-unloads after a configurable
//! idle period (default 5 min) so an idle model doesn't hold RAM — the next
//! request lazily respawns via the existing respawn-on-demand path.
//!
//! Model files live in `<app_data>/models/` and are downloaded/deleted from a
//! catalog defined in the frontend (`settings.ts`) — no model names are
//! hardcoded here, so new models are a catalog entry away.

#![cfg(desktop)]

use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::Deserialize;
use tauri::{AppHandle, Manager};

/// Idle-unload default (CP5-L3): after this many seconds with no local-LLM
/// activity the resident model (~2.5 GB mmap'd GGUF) is killed to reclaim RAM;
/// the next request lazily respawns it. Overridable per-install via the
/// `llm_idle_unload_secs` setting (`0` disables). See `idle_unload_secs`.
pub const DEFAULT_IDLE_UNLOAD_SECS: u64 = 300;
/// How often the idle monitor wakes to re-check (seconds).
const IDLE_POLL_SECS: u64 = 30;

/// A running sidecar bound to one loaded model file.
struct LlmProc {
    model_file: String,
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
}

impl Drop for LlmProc {
    /// Dropping kills the child, so the model's memory is always reclaimed —
    /// on unload, on model switch, and on app exit.
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Default)]
pub struct LlmState {
    proc: Mutex<Option<LlmProc>>,
    /// Mirrors the model file currently loaded in `proc`, kept in a SEPARATE
    /// lightweight lock that is only ever held for the instant it takes to
    /// read/write this string. `running_model` reads it instead of locking
    /// `proc` — otherwise a status check (the synchronous `local_llm_status`
    /// command, which runs on the main thread) would block on the `proc`
    /// mutex that `generate` holds for the whole inference, freezing the UI
    /// when the user re-enters a meeting mid-generation (T4).
    loaded: Mutex<Option<String>>,
    /// Idle-unload bookkeeping (CP5-L3). `last_activity` is a process-monotonic
    /// millisecond stamp refreshed at the START and END of every generate/stream
    /// call (via `ActivityGuard`); `0` = never used. `in_flight` counts active
    /// generations. The idle monitor unloads only when the clock is stale AND
    /// `in_flight == 0` AND it can take the `proc` lock — which a generation
    /// holds for its whole run — so it can never kill a child in active use.
    last_activity: AtomicU64,
    in_flight: AtomicUsize,
}

impl LlmState {
    /// Refresh the idle clock to "now". `.max(1)` keeps `0` reserved as the
    /// "never used" sentinel even for the first call in the first millisecond.
    fn touch(&self) {
        self.last_activity.store(now_ms().max(1), Ordering::SeqCst);
    }
}

/// Milliseconds on a process-monotonic clock (shared epoch, lock-free). Backs
/// the idle timestamp — an `Instant` doesn't fit in an atomic, so we store the
/// elapsed millis instead.
fn now_ms() -> u64 {
    use std::sync::OnceLock;
    static EPOCH: OnceLock<Instant> = OnceLock::new();
    EPOCH.get_or_init(Instant::now).elapsed().as_millis() as u64
}

/// RAII activity marker for one generate/stream call. Bumps `in_flight` and
/// refreshes the idle clock on construction, and refreshes it again + drops
/// `in_flight` on `Drop` (panic-safe). Held for the whole call, so an in-flight
/// generation always reads `in_flight > 0` and, on completion, restarts the
/// idle countdown from the moment it finished.
struct ActivityGuard<'a> {
    state: &'a LlmState,
}

impl<'a> ActivityGuard<'a> {
    fn new(state: &'a LlmState) -> Self {
        state.in_flight.fetch_add(1, Ordering::SeqCst);
        state.touch();
        ActivityGuard { state }
    }
}

impl Drop for ActivityGuard<'_> {
    fn drop(&mut self) {
        self.state.touch();
        self.state.in_flight.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Deserialize)]
struct SidecarResponse {
    ok: bool,
    content: Option<String>,
    error: Option<String>,
}

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    // Create it like models.rs does — a fresh install that goes straight to
    // Settings → download a local model has no models/ dir yet, and the
    // downloader's File::create fails with "No such file or directory".
    let dir = crate::paths::app_data_dir(app)?.join("models");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // macOS: same estate-shared cache as models.rs (both seams converge on one
    // dir). Adopt from the legacy per-app dir; fall back to it on any error so
    // behaviour is unchanged when the shared store is empty or unavailable.
    // (This file is cfg(not(ios)); on non-macOS desktop the block compiles out.)
    // Never in the Community edition: it must not read or write the official
    // apps' shared cache (digital.auxo.shared), even when built here.
    #[cfg(all(target_os = "macos", not(lalela_community)))]
    if let Ok(shared) = auxo_model_cache::shared_dir_adopting(std::slice::from_ref(&dir)) {
        return Ok(shared);
    }
    Ok(dir)
}

/// Reject anything that isn't a plain file name (catalog values are trusted,
/// but the command arguments cross the IPC boundary).
pub fn safe_model_file(file: &str) -> Result<(), String> {
    if file.is_empty() || file.contains('/') || file.contains("..") || file.contains('\\') {
        return Err("invalid model file name".into());
    }
    Ok(())
}

fn sidecar_path() -> Result<PathBuf, String> {
    // Bundled: next to the executable (Contents/MacOS/). Dev: the sidecar is
    // built --release while the app may run from debug, so also look in the
    // sibling profile dirs of the shared target directory.
    if let Some(p) = crate::sidecar::resolve("lalela-llm", "") {
        return Ok(p);
    }
    let file = crate::sidecar::exe_name("lalela-llm");
    let mut looked: Vec<PathBuf> = crate::sidecar::bundled_path("lalela-llm").into_iter().collect();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(target) = exe.parent().and_then(|d| d.parent()) {
            for profile in ["release", "debug"] {
                let candidate = target.join(profile).join(&file);
                if candidate.exists() {
                    return Ok(candidate);
                }
                looked.push(candidate);
            }
        }
    }
    let looked = looked
        .iter()
        .map(|p| p.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    Err(format!(
        "lalela-llm helper not found (looked in: {looked}). Reinstall Lalela; in a dev build run: cargo build --release -p lalela-llm"
    ))
}

fn spawn_and_load(app: &AppHandle, model_file: &str) -> Result<LlmProc, String> {
    let model_path = models_dir(app)?.join(model_file);
    if !model_path.exists() {
        return Err("local model is not downloaded (Settings → Local AI models)".into());
    }
    let path = sidecar_path()?;
    // llama.cpp reports fatal errors (e.g. GGML_ASSERT aborts) only on stderr;
    // keep the latest run's log on disk so crashes are diagnosable.
    let stderr = crate::paths::app_data_dir(app)
        .ok()
        .map(|d| d.join("logs"))
        .filter(|d| std::fs::create_dir_all(d).is_ok())
        .and_then(|d| std::fs::File::create(d.join("lalela-llm.log")).ok())
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);
    let mut cmd = Command::new(&path);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(stderr);
    // lalela-llm.exe is a console-subsystem binary; spawned from the GUI app
    // without this flag Windows pops an empty console window for its lifetime.
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("could not start lalela-llm: {e}"))?;
    let stdin = child.stdin.take().ok_or("lalela-llm stdin unavailable")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("lalela-llm stdout unavailable")?);
    let mut proc = LlmProc {
        model_file: model_file.to_string(),
        child,
        stdin,
        stdout,
    };
    let resp = request(
        &mut proc,
        &serde_json::json!({ "op": "load", "model_path": model_path.to_string_lossy() }),
    )?;
    if !resp.ok {
        return Err(resp.error.unwrap_or_else(|| "model load failed".into()));
    }
    Ok(proc)
}

fn request(proc: &mut LlmProc, body: &serde_json::Value) -> Result<SidecarResponse, String> {
    writeln!(proc.stdin, "{body}").map_err(|e| format!("lalela-llm write failed: {e}"))?;
    proc.stdin
        .flush()
        .map_err(|e| format!("lalela-llm write failed: {e}"))?;
    let mut line = String::new();
    proc.stdout
        .read_line(&mut line)
        .map_err(|e| format!("lalela-llm read failed: {e}"))?;
    if line.is_empty() {
        return Err("lalela-llm exited unexpectedly".into());
    }
    serde_json::from_str(&line).map_err(|e| format!("lalela-llm bad response: {e}"))
}

/// Publish (or clear) the currently-loaded model file for status reads.
/// Best-effort: status metadata must never fail a generation, so a poisoned
/// `loaded` lock is simply ignored. Held only for the write itself.
fn set_loaded(state: &LlmState, model_file: Option<String>) {
    if let Ok(mut g) = state.loaded.lock() {
        *g = model_file;
    }
}

/// Generate with the given model file, (re)starting the sidecar as needed.
/// Blocking — callers run it inside spawn_blocking.
pub fn generate(
    app: &AppHandle,
    state: &LlmState,
    model_file: &str,
    system: &str,
    user: &str,
    // Response cap (Wave A1). None keeps the historical 2048-token default.
    max_tokens: Option<u32>,
) -> Result<String, String> {
    safe_model_file(model_file)?;
    // Mark activity for the whole call BEFORE contending for the proc lock, so
    // the idle monitor sees `in_flight > 0` even while we're waiting on it.
    let _activity = ActivityGuard::new(state);
    let mut guard = state.proc.lock().map_err(|_| "llm state poisoned")?;

    // Respawn when idle or when a different model is requested.
    let needs_spawn = guard.as_ref().map(|p| p.model_file != model_file).unwrap_or(true);
    if needs_spawn {
        drop(guard.take()); // Drop kills the old child
        set_loaded(state, None); // nothing loaded until the spawn succeeds
        *guard = Some(spawn_and_load(app, model_file)?);
    }
    // A live proc for `model_file` is now loaded — publish it so a concurrent
    // status check reads it WITHOUT contending on the `proc` lock we hold for
    // the whole inference below.
    set_loaded(state, Some(model_file.to_string()));

    let body = serde_json::json!({
        "op": "generate", "system": system, "user": user,
        "temperature": 0.3, "max_tokens": max_tokens.unwrap_or(2048),
    });
    let proc = guard.as_mut().expect("just spawned");
    let resp = match request(proc, &body) {
        Ok(r) => r,
        Err(_) => {
            // One respawn on a broken pipe (e.g. the child crashed or was
            // killed externally), then give up.
            drop(guard.take());
            *guard = Some(spawn_and_load(app, model_file)?);
            request(guard.as_mut().expect("just spawned"), &body)?
        }
    };
    if resp.ok {
        Ok(resp.content.unwrap_or_default())
    } else {
        Err(resp.error.unwrap_or_else(|| "generation failed".into()))
    }
}

/// One line from the sidecar's `generate_stream` op: a `{"delta":…}` chunk, the
/// `{"ok":true,"done":true}` terminator, or a `{"ok":false,"error":…}` failure.
#[derive(Deserialize)]
struct StreamLine {
    #[serde(default)]
    delta: Option<String>,
    #[serde(default)]
    done: Option<bool>,
    #[serde(default)]
    error: Option<String>,
}

/// Streaming variant of `generate` (CP0). Sends the sidecar's `generate_stream`
/// op and forwards each `{"delta":…}` line to `on_delta` as it arrives,
/// accumulating the full text to return. Blocking — the caller runs it inside
/// spawn_blocking (it holds the `proc` lock for the whole generation, exactly
/// like `generate`).
///
/// Cancellation: `cancel` is polled between forwarded tokens (the sidecar
/// streams one line per decoded piece, so that's ~1-token latency). llama-cpp-2
/// can't interrupt an in-flight `decode` cleanly, so cancel = **terminate the
/// child** (its `Drop` kills + reaps it); the next generation respawns it. The
/// partial text decoded so far is returned.
#[allow(clippy::too_many_arguments)]
pub fn generate_stream(
    app: &AppHandle,
    state: &LlmState,
    model_file: &str,
    system: &str,
    user: &str,
    max_tokens: Option<u32>,
    cancel: &std::sync::atomic::AtomicBool,
    mut on_delta: impl FnMut(&str),
) -> Result<String, String> {
    safe_model_file(model_file)?;
    // Activity marker for the whole stream (held until this fn returns) — an
    // in-flight stream keeps `in_flight > 0`, so the idle monitor never unloads
    // mid-stream however long it runs, and the idle clock restarts when it ends.
    let _activity = ActivityGuard::new(state);
    let mut guard = state.proc.lock().map_err(|_| "llm state poisoned")?;

    // Respawn when idle or when a different model is requested (as `generate`).
    let needs_spawn = guard.as_ref().map(|p| p.model_file != model_file).unwrap_or(true);
    if needs_spawn {
        drop(guard.take());
        set_loaded(state, None);
        *guard = Some(spawn_and_load(app, model_file)?);
    }
    set_loaded(state, Some(model_file.to_string()));

    let body = serde_json::json!({
        "op": "generate_stream", "system": system, "user": user,
        "temperature": 0.3, "max_tokens": max_tokens.unwrap_or(2048),
    });

    // Write the request; one respawn on a broken pipe (child crashed / was
    // killed externally), mirroring `generate`.
    {
        let proc = guard.as_mut().expect("just spawned");
        let wrote = writeln!(proc.stdin, "{body}").and_then(|_| proc.stdin.flush());
        if wrote.is_err() {
            drop(guard.take());
            *guard = Some(spawn_and_load(app, model_file)?);
            let proc = guard.as_mut().expect("just spawned");
            writeln!(proc.stdin, "{body}")
                .and_then(|_| proc.stdin.flush())
                .map_err(|e| format!("lalela-llm write failed: {e}"))?;
        }
    }

    let mut full = String::new();
    loop {
        // Poll cancellation between lines — the sidecar emits one line per
        // decoded piece, so this catches a cancel within ~one token.
        if cancel.load(Ordering::SeqCst) {
            drop(guard.take()); // Drop kills the child, stopping the decode.
            set_loaded(state, None);
            return Ok(full);
        }
        let proc = guard.as_mut().ok_or("lalela-llm not running")?;
        let mut line = String::new();
        let n = proc
            .stdout
            .read_line(&mut line)
            .map_err(|e| format!("lalela-llm read failed: {e}"))?;
        if n == 0 {
            return Err("lalela-llm exited during stream".into());
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let parsed: StreamLine = serde_json::from_str(trimmed)
            .map_err(|e| format!("lalela-llm bad stream line: {e}"))?;
        if let Some(err) = parsed.error {
            return Err(err);
        }
        if let Some(delta) = parsed.delta {
            full.push_str(&delta);
            on_delta(&delta);
        }
        if parsed.done.unwrap_or(false) {
            return Ok(full);
        }
    }
}

/// Kill the sidecar, reclaiming its memory. No-op when idle.
pub fn unload(state: &LlmState) {
    if let Ok(mut guard) = state.proc.lock() {
        drop(guard.take());
    }
    set_loaded(state, None);
}

/// The model file currently loaded in the sidecar, if any. Reads the
/// lightweight `loaded` mirror — never the `proc` mutex — so it stays
/// responsive (and won't freeze the UI) even while a generation is in flight.
pub fn running_model(state: &LlmState) -> Option<String> {
    state.loaded.lock().ok().and_then(|g| g.clone())
}

// ---------- Idle-unload (CP5-L3) ----------

/// Pure idle-unload decision, factored out for unit testing. Returns true only
/// when a model is loaded, no generation is in flight, the feature is enabled
/// (`timeout_ms > 0`), the clock has actually been touched (`last_ms != 0`), and
/// the idle span has exceeded the timeout. `saturating_sub` keeps a clock skew
/// (`now < last`) from ever reading as "past timeout".
fn should_unload(now_ms: u64, last_ms: u64, timeout_ms: u64, loaded: bool, in_flight: usize) -> bool {
    if timeout_ms == 0 || !loaded || in_flight != 0 || last_ms == 0 {
        return false;
    }
    now_ms.saturating_sub(last_ms) > timeout_ms
}

/// One idle check. A cheap lock-free pre-check screens the common (busy/recent)
/// case; only if that says "unload" do we take the `proc` lock and RE-decide
/// under it. `try_lock` failing means a generation currently holds it → active
/// → skip. Under the lock every input is re-read, so a generation that started
/// or finished between the two checks is respected (its `ActivityGuard` bumped
/// `in_flight` and/or refreshed the clock). Killing only ever happens while we
/// hold `proc` with `in_flight == 0`, which is mutually exclusive with any live
/// generation — so an in-flight child is never killed.
fn maybe_unload(state: &LlmState, timeout_ms: u64) {
    if !should_unload(
        now_ms(),
        state.last_activity.load(Ordering::SeqCst),
        timeout_ms,
        running_model(state).is_some(),
        state.in_flight.load(Ordering::SeqCst),
    ) {
        return;
    }
    if let Ok(mut guard) = state.proc.try_lock() {
        if should_unload(
            now_ms(),
            state.last_activity.load(Ordering::SeqCst),
            timeout_ms,
            guard.is_some(),
            state.in_flight.load(Ordering::SeqCst),
        ) {
            drop(guard.take()); // Drop kills the child → ~2.5 GB reclaimed.
            set_loaded(state, None);
        }
    }
}

/// Read the idle-unload timeout (seconds) from the SQLite settings, defaulting
/// to `DEFAULT_IDLE_UNLOAD_SECS`. `0` disables idle-unload. Best-effort: any
/// lock/parse error falls back to the default. Call once at setup.
pub fn idle_unload_secs(app: &AppHandle) -> u64 {
    let state = app.state::<crate::commands::AppState>();
    let Ok(conn) = state.db.lock() else {
        return DEFAULT_IDLE_UNLOAD_SECS;
    };
    match crate::store::get_setting(&conn, "llm_idle_unload_secs") {
        Some(v) => v.trim().parse().unwrap_or(DEFAULT_IDLE_UNLOAD_SECS),
        None => DEFAULT_IDLE_UNLOAD_SECS,
    }
}

/// Spawn the idle-unload monitor (desktop only; call once at setup). Every
/// `IDLE_POLL_SECS` it checks whether the sidecar has sat idle past `idle_secs`
/// and, if so, unloads the model to reclaim RAM. `idle_secs == 0` disables the
/// feature (no thread spawned). The next generation lazily respawns the sidecar
/// via the existing respawn-on-demand path in `generate`/`generate_stream`.
pub fn spawn_idle_monitor(app: AppHandle, idle_secs: u64) {
    if idle_secs == 0 {
        return;
    }
    let timeout_ms = idle_secs.saturating_mul(1000);
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(IDLE_POLL_SECS));
        let state = app.state::<LlmState>();
        maybe_unload(state.inner(), timeout_ms);
    });
}

#[cfg(test)]
mod tests {
    use super::should_unload;

    const T: u64 = 300_000; // 5-minute timeout in ms

    #[test]
    fn unloads_when_idle_past_timeout() {
        // ~5.7 min idle (> 5 min timeout), model loaded, nothing in flight → unload.
        assert!(should_unload(400_000, 60_000, T, true, 0));
    }

    #[test]
    fn boundary_equal_to_timeout_keeps_model() {
        // Idle span exactly equals the timeout — strictly-greater, so keep.
        assert!(!should_unload(360_000, 60_000, T, true, 0));
    }

    #[test]
    fn keeps_model_within_timeout() {
        // Only ~2.3 min idle → keep.
        assert!(!should_unload(200_000, 60_000, T, true, 0));
    }

    #[test]
    fn never_unloads_during_active_generation() {
        // Long-idle clock but a generation is in flight → keep (the key guard).
        assert!(!should_unload(999_999, 1, T, true, 1));
    }

    #[test]
    fn noop_when_no_model_loaded() {
        assert!(!should_unload(999_999, 1, T, false, 0));
    }

    #[test]
    fn zero_timeout_disables_feature() {
        assert!(!should_unload(999_999, 1, 0, true, 0));
    }

    #[test]
    fn never_used_clock_is_noop() {
        // last_ms == 0 sentinel: the model was never driven → nothing to reclaim.
        assert!(!should_unload(999_999, 0, T, true, 0));
    }

    #[test]
    fn clock_skew_does_not_unload() {
        // now < last (monotonic skew shouldn't happen, but be safe) → keep.
        assert!(!should_unload(10, 500_000, T, true, 0));
    }
}
