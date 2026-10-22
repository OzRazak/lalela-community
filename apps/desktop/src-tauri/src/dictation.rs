//! System-wide, on-device dictation (Wave B2) — macOS and Windows desktop.
//!
//! Press a global hotkey in ANY app → a small always-on-top overlay appears →
//! you speak → local Whisper transcribes → the text is pasted into whatever app
//! you were in. Fully on-device: the audio and text never touch a network path
//! (no `aiGenerate`, no cloud transcription — ASR only), which is Lalela's whole
//! privacy story extended to dictation.
//!
//! Platforms: the module is compiled on macOS and Windows only (see lib.rs).
//! The session/Whisper/hotkey/overlay core is shared; the OS layer differs:
//!   * macOS — paste via a ⌘V CGEvent on the HID tap, the frontmost app via
//!     `NSWorkspace` (a pid), Accessibility (`AXIsProcessTrusted`) and the
//!     secure-input probe (`IsSecureEventInputEnabled`); AppKit calls run on the
//!     main thread inside an Objective-C exception barrier.
//!   * Windows — the paste target is the foreground HWND (`GetForegroundWindow`),
//!     re-activated with `SetForegroundWindow`, and Ctrl+V is synthesised with
//!     `keybd_event` (raw user32 FFI, no extra crate). Windows needs no
//!     Accessibility-style grant, and has no secure-input probe (password fields
//!     accept the paste or ignore it — the text is left on the clipboard either
//!     way only when the paste itself fails). Elevated (admin) target windows
//!     drop synthesised input from a normal-integrity process (UIPI) — there the
//!     text simply stays on the clipboard.
//!   * iOS/Android/Linux never compile it, keeping those builds clean.
//!
//! Contention with meeting recording: dictation and a live recording both own
//! the microphone (and a Whisper engine), so they are mutually exclusive. The
//! hotkey refuses to start dictation while `AppState.recording` is set, and
//! `start_recording` calls `cancel()` here first so the reverse can never race.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::SampleFormat;
#[cfg(target_os = "macos")]
use objc2::rc::autoreleasepool;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};
use tauri_plugin_global_shortcut::GlobalShortcutExt;
use whisper_rs::{
    FullParams, SamplingStrategy, WhisperContext, WhisperContextParameters, WhisperState,
};

use crate::audio;
use crate::commands::AppState;
use crate::store;
use crate::{models, transcribe};

/// Windows has no autorelease pools — run the closure directly. (Same call
/// shape as `objc2::rc::autoreleasepool`, so the shared worker code is identical.)
#[cfg(not(target_os = "macos"))]
fn autoreleasepool<T, F: FnOnce(()) -> T>(f: F) -> T {
    f(())
}

/// The paste chord as the user's keyboard labels it, for the fallback notices
/// ("your dictation is on the clipboard — press ⌘V / Ctrl+V").
#[cfg(target_os = "macos")]
const PASTE_KEYS: &str = "⌘V";
#[cfg(not(target_os = "macos"))]
const PASTE_KEYS: &str = "Ctrl+V";

/// Default global hotkey. Chosen for low collision: ⌘Space (Spotlight),
/// ⌃Space (input-source switch) and ⌃⌘Space (emoji) are all taken; ⌥Space types
/// a non-breaking space inside text fields (fatal for a tool that types into
/// text fields); ⌘⇧D has no macOS *system* default. Finder's ⌘⇧D ("open
/// Desktop") only fires while Finder is frontmost, and dictation is for typing
/// into other apps — so the overlap is minor. Fully re-bindable in Settings.
pub const DEFAULT_SHORTCUT: &str = "CmdOrCtrl+Shift+D";

/// The overlay window's Tauri label. Governed by the `default` + `dictation`
/// capabilities (see `capabilities/`).
const OVERLAY_LABEL: &str = "dictation";

/// SQLite `settings` keys (source of truth; mirrors the backend registration).
const KEY_ENABLED: &str = "dictation.enabled";
const KEY_SHORTCUT: &str = "dictation.shortcut";
/// Where the user last left the overlay: `"x,y,w,h"` in logical points
/// (global desktop coordinates). Saved on hide, restored before every show.
const KEY_OVERLAY_RECT: &str = "dictation.overlay.rect";

/// Overlay geometry (logical points). The box is user-movable + resizable; the
/// min keeps the status row + buttons usable, the max stops it eating a screen.
const OVERLAY_DEFAULT: (f64, f64) = (400.0, 150.0);
const OVERLAY_MIN: (f64, f64) = (320.0, 130.0);
const OVERLAY_MAX: (f64, f64) = (1200.0, 900.0);
/// A saved spot only counts as on-screen if at least this much of the box
/// (w × h, logical) overlaps a connected display — enough to see and grab it.
const ON_SCREEN_MIN: (f64, f64) = (80.0, 40.0);

/// Windows quieter than this RMS are treated as silence — Whisper hallucinates
/// filler ("you", "[BLANK_AUDIO]") on pure silence, which we must never paste.
const SILENCE_RMS: f32 = 0.006;

/// Managed state for the dictation feature (one per app).
#[derive(Default)]
pub struct DictationState {
    /// The live session, if any. `Some` == currently listening/transcribing.
    session: Mutex<Option<DictationSession>>,
    /// The accelerator currently registered with the global-shortcut plugin, so
    /// we can unregister it before binding a new one.
    current_shortcut: Mutex<Option<String>>,
    /// The **warm** Whisper decode state, kept alive for the whole app lifetime
    /// and reused across sessions AND across every partial/final pass within a
    /// session. Created lazily on first dictation.
    ///
    /// Why a persistent *state* (not just a persistent context): each transcribe
    /// pass used to `WhisperContext::create_state()` and drop it, and dropping a
    /// Metal-backed `WhisperState` frees its compute buffers via `ggml_metal_free`
    /// — a teardown that throws a foreign exception Rust can't catch (~1-in-25),
    /// aborting the app. That's the dictation crash Oz hit: ~8 passes/session ⇒
    /// ~8 frees ⇒ fast death. Reusing one state means `full()` is called
    /// repeatedly (it resets its own results each call) and the state's Metal
    /// buffers are freed exactly ONCE, at app exit. `WhisperState` owns an `Arc`
    /// to its context, so it keeps the model loaded with no separate handle; it's
    /// `Send + Sync`, and the `Mutex` serialises the one-session-at-a-time use.
    engine: Arc<Mutex<Option<WhisperState>>>,
}

/// One short-lived dictation capture: a mic stream feeding a shared buffer, plus
/// a worker that keeps a warm Whisper engine, streams live partials to the
/// overlay, and produces the final text on stop.
struct DictationSession {
    stop: Arc<AtomicBool>,
    audio_handle: Option<JoinHandle<()>>,
    worker_handle: Option<JoinHandle<()>>,
    /// Final transcript, written by the worker after `stop` flips.
    result: Arc<Mutex<Option<String>>>,
    /// The app that was frontmost when dictation started — the paste target
    /// (macOS: its pid; Windows: its top-level HWND). ≤ 0 = unknown.
    target_pid: i64,
}

impl DictationSession {
    fn start(
        app: &AppHandle,
        target_pid: i64,
        engine: Arc<Mutex<Option<WhisperState>>>,
    ) -> Result<Self, String> {
        let (device, supported) = audio::default_input()?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.config();
        let channels = config.channels as usize;
        let rate = config.sample_rate; // cpal 0.18: SampleRate is a u32 alias

        let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let result: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

        // --- Audio thread: owns the !Send cpal input stream. ---
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
        let a_buf = buffer.clone();
        let a_stop = stop.clone();
        let audio_handle = thread::spawn(move || {
            // cpal 0.18's build_input_stream takes the config by value; the match
            // arms are mutually exclusive so moving `config`/`device` per arm is
            // fine (same pattern as recording.rs).
            let stream_result = match sample_format {
                SampleFormat::F32 => {
                    let buf = a_buf.clone();
                    device.build_input_stream(
                        config,
                        move |data: &[f32], _: &_| {
                            let mono = audio::downmix_mic_to_mono(data, channels);
                            if let Ok(mut b) = buf.lock() {
                                b.extend_from_slice(&mono);
                            }
                        },
                        |_e| {},
                        None,
                    )
                }
                SampleFormat::I16 => {
                    let buf = a_buf.clone();
                    device.build_input_stream(
                        config,
                        move |data: &[i16], _: &_| {
                            let f: Vec<f32> =
                                data.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
                            let mono = audio::downmix_mic_to_mono(&f, channels);
                            if let Ok(mut b) = buf.lock() {
                                b.extend_from_slice(&mono);
                            }
                        },
                        |_e| {},
                        None,
                    )
                }
                SampleFormat::U16 => {
                    let buf = a_buf.clone();
                    device.build_input_stream(
                        config,
                        move |data: &[u16], _: &_| {
                            let f: Vec<f32> = data
                                .iter()
                                .map(|s| (*s as f32 / u16::MAX as f32) * 2.0 - 1.0)
                                .collect();
                            let mono = audio::downmix_mic_to_mono(&f, channels);
                            if let Ok(mut b) = buf.lock() {
                                b.extend_from_slice(&mono);
                            }
                        },
                        |_e| {},
                        None,
                    )
                }
                other => {
                    let _ = ready_tx.send(Err(format!("unsupported sample format: {other:?}")));
                    return;
                }
            };
            let stream = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(format!("could not open microphone: {e}")));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(format!("could not start mic: {e}")));
                return;
            }
            let _ = ready_tx.send(Ok(()));
            while !a_stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(100));
            }
            drop(stream);
        });

        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                stop.store(true, Ordering::Relaxed);
                let _ = audio_handle.join();
                return Err(e);
            }
            Err(_) => {} // proceed best-effort if the mic is slow to report
        }

        // --- Worker: warm Whisper engine, live partials + level, final text. ---
        let w_buf = buffer.clone();
        let w_stop = stop.clone();
        let w_result = result.clone();
        let w_app = app.clone();
        let w_engine = engine;
        let worker_handle = thread::spawn(move || {
            // Reuse the app-lifetime warm Whisper state (never dropped mid-use —
            // see DictationState::engine). Recover a poisoned lock rather than
            // wedging dictation forever if a past worker panicked.
            let mut guard = match w_engine.lock() {
                Ok(g) => g,
                Err(poisoned) => poisoned.into_inner(),
            };
            if guard.is_none() {
                emit_state(&w_app, "preparing");
                // First run may download the model. Build inside an autorelease
                // pool so any Metal/ObjC temporaries from init drain immediately.
                match autoreleasepool(|_| build_whisper_state(&w_app)) {
                    Ok(state) => *guard = Some(state),
                    Err(e) => {
                        let _ = w_app.emit_to(OVERLAY_LABEL, "dictation://error", e);
                        return;
                    }
                }
            }
            let state = guard.as_mut().expect("state present after lazy init");
            emit_state(&w_app, "listening");

            let mut last_partial = Instant::now();
            let mut last_level = Instant::now();
            let mut partial_len = 0usize;
            // How long the previous partial pass took. The next partial waits
            // at least twice that (never less than 1.2 s): on a slow or busy CPU
            // (a Windows laptop decoding on the CPU, no Metal) back-to-back
            // whole-buffer passes would otherwise hog every core and push the
            // FINAL pass — the one the user is waiting on — seconds later.
            let mut last_pass = Duration::ZERO;
            while !w_stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(100));

                // Level meter: RMS of the last ~0.2 s, ~7×/s.
                if last_level.elapsed() >= Duration::from_millis(140) {
                    last_level = Instant::now();
                    let level = {
                        let b = w_buf.lock().map(|b| tail_rms(&b, rate)).unwrap_or(0.0);
                        (b * 12.0).min(1.0) // scale quiet speech into a visible bar
                    };
                    let _ = w_app.emit_to(OVERLAY_LABEL, "dictation://level", level);
                }

                // Live partial: re-transcribe the buffer-so-far every ~1.2 s once
                // at least 0.5 s of new audio has arrived. Cheap for the short
                // bursts dictation is for; long dictations just refresh less
                // usefully (final pass always transcribes the whole buffer). All
                // passes REUSE `state` — no per-pass state create/drop, so no
                // per-pass ggml_metal_free. The autorelease pool drains the
                // per-call Metal temporaries.
                if last_partial.elapsed() >= partial_interval(last_pass) {
                    let snapshot = w_buf.lock().map(|b| b.clone()).unwrap_or_default();
                    if snapshot.len() >= partial_len + (rate as usize / 2) {
                        partial_len = snapshot.len();
                        let started = Instant::now();
                        let text =
                            autoreleasepool(|_| transcribe_reusing(state, &snapshot, rate));
                        last_pass = started.elapsed();
                        last_partial = Instant::now();
                        let _ = w_app.emit_to(OVERLAY_LABEL, "dictation://partial", text);
                    }
                }
            }

            // Final pass: transcribe the whole buffer once, deterministically,
            // on the same reused state (runs AFTER the loop — no partial can be
            // in flight concurrently; it's all one worker thread).
            let full = w_buf.lock().map(|b| b.clone()).unwrap_or_default();
            let text = autoreleasepool(|_| transcribe_reusing(state, &full, rate));
            if let Ok(mut r) = w_result.lock() {
                *r = Some(text);
            }
            // `guard` (and thus the warm state) is released back to
            // DictationState here — the state is NOT dropped.
        });

        Ok(DictationSession {
            stop,
            audio_handle: Some(audio_handle),
            worker_handle: Some(worker_handle),
            result,
            target_pid,
        })
    }

    /// Stop, wait for the final transcription, and return `(text, target_pid)`.
    fn finish(mut self) -> (String, i64) {
        self.stop.store(true, Ordering::Relaxed);
        // The mic thread can wedge inside CoreAudio's HAL — bound its join so a
        // stuck thread can never freeze the finish. The worker is pure CPU (no
        // CoreAudio), so join it fully: it must complete the final transcription.
        if let Some(h) = self.audio_handle.take() {
            join_timeout(h, Duration::from_secs(3));
        }
        if let Some(h) = self.worker_handle.take() {
            let _ = h.join();
        }
        let text = self
            .result
            .lock()
            .map(|r| r.clone().unwrap_or_default())
            .unwrap_or_default();
        (text, self.target_pid)
    }

    /// Stop and discard (Esc, or a recording taking over the mic).
    fn cancel(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.audio_handle.take() {
            join_timeout(h, Duration::from_secs(3));
        }
        if let Some(h) = self.worker_handle.take() {
            join_timeout(h, Duration::from_secs(3));
        }
    }
}

/// Minimum gap between live-partial passes: 1.2 s, or twice the previous
/// pass's duration when decoding is slower than that (adaptive back-off, so
/// partials never take more than ~a third of the CPU time).
fn partial_interval(last_pass: Duration) -> Duration {
    Duration::from_millis(1200).max(last_pass * 2)
}

/// RMS of the last ~0.2 s of the buffer (for the level meter).
fn tail_rms(buf: &[f32], rate: u32) -> f32 {
    let window = (rate as usize / 5).max(1);
    let start = buf.len().saturating_sub(window);
    audio::rms(&buf[start..])
}

/// Load the whisper model and create ONE decode state to reuse for the app's
/// lifetime. The returned `WhisperState` owns an `Arc` to its context, so the
/// model stays loaded without a separate handle. First run may download the
/// model (same file the recording path uses).
fn build_whisper_state(app: &AppHandle) -> Result<WhisperState, String> {
    let model = models::ensure_model(app, |_, _| {})?;
    let ctx = WhisperContext::new_with_params(&model, WhisperContextParameters::default())
        .map_err(|e| format!("failed to load whisper model: {e}"))?;
    ctx.create_state().map_err(|e| e.to_string())
}

/// Resample to 16 kHz mono and transcribe the whole slice into one line,
/// REUSING the passed-in warm state (no per-pass `create_state`/drop → no
/// per-pass `ggml_metal_free`). Near-silent input returns "" (never let Whisper
/// hallucinate filler). Mirrors the recording path's decode params + filter.
fn transcribe_reusing(state: &mut WhisperState, samples: &[f32], rate: u32) -> String {
    if samples.is_empty() {
        return String::new();
    }
    let mut pcm = audio::resample_to_16k(samples, rate);
    if !audio::has_speech(&pcm, SILENCE_RMS) {
        return String::new();
    }
    audio::normalize_quiet(&mut pcm);

    let mut params = FullParams::new(SamplingStrategy::Greedy { best_of: 1 });
    params.set_n_threads(num_threads());
    params.set_translate(false);
    params.set_language(Some("en"));
    params.set_print_special(false);
    params.set_print_progress(false);
    params.set_print_realtime(false);
    params.set_print_timestamps(false);
    params.set_suppress_blank(true);

    // full() resets the state's own results each call, so reusing one state
    // across passes is correct — each decode is independent of the last.
    if state.full(params, &pcm).is_err() {
        return String::new();
    }

    let n = state.full_n_segments();
    let mut out = String::new();
    for i in 0..n {
        let Some(seg) = state.get_segment(i) else {
            continue;
        };
        let Ok(text) = seg.to_str_lossy() else {
            continue;
        };
        let t = text.trim();
        if t.is_empty() || transcribe::is_hallucination(t) {
            continue;
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(t);
    }
    out.trim().to_string()
}

/// Whisper decode threads, leaving headroom for the UI/audio threads (mirrors
/// the recording path's choice).
fn num_threads() -> std::os::raw::c_int {
    transcribe::whisper_threads()
}

// ─────────────────────────── public entry points ───────────────────────────

/// The hotkey action: start if idle, finish if already dictating.
pub fn toggle(app: AppHandle) {
    let already = {
        let state = app.state::<DictationState>();
        let guard = state.session.lock().map(|g| g.is_some()).unwrap_or(false);
        guard
    };
    if already {
        finish(&app);
        return;
    }

    // Gate: never contend with a live meeting recording for the mic.
    if app.state::<AppState>().recording.load(Ordering::Relaxed) {
        let _ = app.emit(
            "dictation://unavailable",
            "A meeting recording is in progress — dictation is paused until it ends.",
        );
        return;
    }

    // Capture the paste target BEFORE the overlay steals focus (right now the
    // user's target app is frontmost, Lalela is in the background).
    let pid = frontmost_pid(&app).unwrap_or(-1);
    show_overlay(&app);
    let engine = app.state::<DictationState>().engine.clone();
    match DictationSession::start(&app, pid, engine) {
        Ok(session) => {
            if let Ok(mut g) = app.state::<DictationState>().session.lock() {
                *g = Some(session);
            }
        }
        Err(e) => {
            hide_overlay(&app);
            let _ = app.emit("dictation://unavailable", format!("Couldn't start dictation: {e}"));
        }
    }
}

/// Finish the active session: transcribe and paste into the captured target.
pub fn finish(app: &AppHandle) {
    let session = app
        .state::<DictationState>()
        .session
        .lock()
        .ok()
        .and_then(|mut g| g.take());
    let Some(session) = session else { return };

    let _ = app.emit_to(OVERLAY_LABEL, "dictation://state", "transcribing");
    let (text, pid) = session.finish();
    let text = text.trim().to_string();
    if text.is_empty() {
        hide_overlay(app);
        return;
    }
    // insert_text owns the overlay from here: it hides on the success path and
    // shows an auto-hiding notice on any failure path (AX missing, secure field,
    // clipboard/paste failure) so the user sees why nothing was typed.
    insert_text(app, pid, &text);
}

/// Cancel + discard the active session (Esc, or a recording taking the mic).
pub fn cancel(app: &AppHandle) {
    let session = app
        .state::<DictationState>()
        .session
        .lock()
        .ok()
        .and_then(|mut g| g.take());
    if let Some(session) = session {
        session.cancel();
    }
    hide_overlay(app);
}

/// Drop the warm Whisper state BEFORE the process calls `exit()`. The warm
/// state (v1/v2) stays resident for the app's lifetime; if it's still resident
/// when ⌘Q → `-[NSApplication terminate:]` → `exit()` runs the C++/atexit
/// finalizers, ggml's Metal residency-set teardown asserts
/// (`GGML_ASSERT([rsets->data count] == 0)`) and ABORTS what should be a clean
/// quit (macOS then shows a bogus "quit unexpectedly" dialog). Dropping here —
/// on the main thread, during `ExitRequested`/`Exit`, *before* `exit()` — runs
/// `whisper_free` at a safe time.
///
/// Idempotent + panic-free (runs on every exit path; no unwraps). Only a CLEAN
/// DROP avoids the assert — leaking via `mem::forget` would skip `whisper_free`
/// and STILL leave residency sets for the atexit teardown to trip on. So:
/// bounded `try_lock`, then drop. If a live dictation session is holding the
/// engine mutex (it holds it for the whole session), give up rather than block
/// the quit — that rare case keeps today's assert risk, but a deadlocked quit is
/// worse, and a session being active exactly as the user quits is very unlikely.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<DictationState>() else {
        return;
    };
    for _ in 0..20 {
        if let Ok(mut guard) = state.engine.try_lock() {
            drop(guard.take()); // whisper_free runs NOW, not inside atexit
            return;
        }
        thread::sleep(Duration::from_millis(10));
    }
    // Lock stayed busy (a session is mid-flight): leave the state resident
    // rather than deadlock the quit — see the note above.
}

// ─────────────────────────── shortcut registration ─────────────────────────

/// Register the hotkey iff dictation is enabled in settings. Called at startup.
pub fn init_from_settings(app: &AppHandle) {
    let (enabled, shortcut) = read_settings(app);
    if enabled {
        if let Err(e) = register_shortcut(app, &shortcut) {
            eprintln!("dictation: could not register hotkey {shortcut:?}: {e}");
        }
    }
}

fn read_settings(app: &AppHandle) -> (bool, String) {
    let state = app.state::<AppState>();
    let Ok(conn) = state.db.lock() else {
        return (false, DEFAULT_SHORTCUT.to_string());
    };
    let enabled = store::get_setting(&conn, KEY_ENABLED).as_deref() == Some("true");
    let shortcut = store::get_setting(&conn, KEY_SHORTCUT)
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_string());
    (enabled, shortcut)
}

/// Persist enabled, then (re-)register or unregister the hotkey to match.
pub fn set_enabled(app: &AppHandle, enabled: bool) -> Result<(), String> {
    {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(|_| "state poisoned")?;
        store::set_setting(&conn, KEY_ENABLED, if enabled { "true" } else { "false" })?;
    }
    if enabled {
        let (_, shortcut) = read_settings(app);
        register_shortcut(app, &shortcut)
    } else {
        unregister_current(app);
        cancel(app);
        Ok(())
    }
}

/// Persist a new accelerator, and rebind live if dictation is enabled.
pub fn set_shortcut(app: &AppHandle, accel: &str) -> Result<(), String> {
    // Validate before persisting so we never store an unparseable accelerator.
    parse_shortcut(accel)?;
    let enabled = {
        let state = app.state::<AppState>();
        let conn = state.db.lock().map_err(|_| "state poisoned")?;
        store::set_setting(&conn, KEY_SHORTCUT, accel)?;
        store::get_setting(&conn, KEY_ENABLED).as_deref() == Some("true")
    };
    if enabled {
        register_shortcut(app, accel)?;
    }
    Ok(())
}

fn parse_shortcut(accel: &str) -> Result<tauri_plugin_global_shortcut::Shortcut, String> {
    use std::str::FromStr;
    tauri_plugin_global_shortcut::Shortcut::from_str(accel)
        .map_err(|e| format!("invalid shortcut {accel:?}: {e}"))
}

fn register_shortcut(app: &AppHandle, accel: &str) -> Result<(), String> {
    let shortcut = parse_shortcut(accel)?;
    unregister_current(app);
    app.global_shortcut()
        .register(shortcut)
        .map_err(|e| e.to_string())?;
    if let Ok(mut cur) = app.state::<DictationState>().current_shortcut.lock() {
        *cur = Some(accel.to_string());
    }
    Ok(())
}

fn unregister_current(app: &AppHandle) {
    let prev = app
        .state::<DictationState>()
        .current_shortcut
        .lock()
        .ok()
        .and_then(|mut c| c.take());
    if let Some(accel) = prev {
        if let Ok(shortcut) = parse_shortcut(&accel) {
            let _ = app.global_shortcut().unregister(shortcut);
        }
    }
}

// ─────────────────────────── overlay window ─────────────────────────────────

fn show_overlay(app: &AppHandle) {
    // Read the remembered spot here (off the main thread — never take the DB
    // lock inside the main-thread hop below).
    let saved = saved_overlay_rect(app);
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        // Re-validate the spot while still hidden (a display may have been
        // unplugged since last time) — no visible jump.
        place_overlay(app, &w, saved);
        let _ = w.show();
        let _ = w.set_focus();
        // Reset the reused window to a clean listening state.
        let _ = app.emit_to(OVERLAY_LABEL, "dictation://partial", "");
        let _ = app.emit_to(OVERLAY_LABEL, "dictation://state", "listening");
        return;
    }
    // First open: build on the main thread (macOS window creation belongs there;
    // we're on a worker thread here — see the hotkey handler in lib.rs).
    let app2 = app.clone();
    let _ = crate::commands::run_on_main(app, move || {
        let built = WebviewWindowBuilder::new(
            &app2,
            OVERLAY_LABEL,
            WebviewUrl::App("dictation.html".into()),
        )
        .title("Dictation")
        .inner_size(OVERLAY_DEFAULT.0, OVERLAY_DEFAULT.1)
        // User-resizable (the overlay's SE grip; tao 0.35 has no native drag-
        // resize on macOS, so the grip is pointer-tracked JS) and movable
        // (drag the card); the geometry is remembered — see place_overlay.
        .resizable(true)
        .min_inner_size(OVERLAY_MIN.0, OVERLAY_MIN.1)
        .max_inner_size(OVERLAY_MAX.0, OVERLAY_MAX.1)
        .decorations(false)
        // Transparent so the rounded dark card floats cleanly (matches the
        // Meeting Copilot overlay — the two overlays are visual siblings).
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        // Built hidden, placed at the remembered spot, THEN shown — no jump.
        .visible(false)
        .focused(true)
        .build();
        if let Ok(w) = built {
            place_overlay(&app2, &w, saved);
            let _ = w.show();
            let _ = w.set_focus();
        }
    });
}

fn hide_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        // Remember where the user left it (moved and/or resized) for next time.
        if w.is_visible().unwrap_or(false) {
            save_overlay_rect(app, &w);
        }
        let _ = w.hide();
    }
}

/// The remembered overlay rect from SQLite settings, if any (and parseable).
fn saved_overlay_rect(app: &AppHandle) -> Option<Rect> {
    let state = app.state::<AppState>();
    let conn = state.db.lock().ok()?;
    let saved = store::get_setting(&conn, KEY_OVERLAY_RECT).and_then(|v| parse_rect(&v));
    saved
}

/// Put the overlay at its remembered spot + size, or centred at the default
/// size if there's nothing saved / the saved spot is no longer on any display
/// (monitor unplugged, resolution changed). Called while the window is hidden.
fn place_overlay(app: &AppHandle, w: &WebviewWindow, saved: Option<Rect>) {
    let monitors: Vec<Rect> = app
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            let sf = m.scale_factor();
            let p: LogicalPosition<f64> = m.position().to_logical(sf);
            let s: LogicalSize<f64> = m.size().to_logical(sf);
            (p.x, p.y, s.width, s.height)
        })
        .collect();
    match saved.map(clamp_size) {
        Some(r) if on_screen(r, &monitors) => {
            let _ = w.set_size(LogicalSize::new(r.2, r.3));
            let _ = w.set_position(LogicalPosition::new(r.0, r.1));
        }
        // Off-screen (or nothing saved): keep the remembered size if any, but
        // fall back to the default centred position.
        other => {
            let (cw, ch) = other.map(|r| (r.2, r.3)).unwrap_or(OVERLAY_DEFAULT);
            let _ = w.set_size(LogicalSize::new(cw, ch));
            let _ = w.center();
        }
    }
}

/// Persist the overlay's current position + size (logical points).
fn save_overlay_rect(app: &AppHandle, w: &WebviewWindow) {
    let (Ok(pos), Ok(size), Ok(sf)) = (w.outer_position(), w.inner_size(), w.scale_factor())
    else {
        return;
    };
    let p: LogicalPosition<f64> = pos.to_logical(sf);
    let s: LogicalSize<f64> = size.to_logical(sf);
    let value = format!("{:.0},{:.0},{:.0},{:.0}", p.x, p.y, s.width, s.height);
    let state = app.state::<AppState>();
    if let Ok(conn) = state.db.lock() {
        let _ = store::set_setting(&conn, KEY_OVERLAY_RECT, &value);
    };
}

/// `(x, y, w, h)` in logical points (global desktop coordinates).
type Rect = (f64, f64, f64, f64);

fn parse_rect(v: &str) -> Option<Rect> {
    let n: Vec<f64> = v
        .split(',')
        .map(|p| p.trim().parse::<f64>())
        .collect::<Result<_, _>>()
        .ok()?;
    match n[..] {
        [x, y, w, h] if n.iter().all(|f| f.is_finite()) && w > 0.0 && h > 0.0 => {
            Some((x, y, w, h))
        }
        _ => None,
    }
}

fn clamp_size(r: Rect) -> Rect {
    (
        r.0,
        r.1,
        r.2.clamp(OVERLAY_MIN.0, OVERLAY_MAX.0),
        r.3.clamp(OVERLAY_MIN.1, OVERLAY_MAX.1),
    )
}

/// True if enough of `r` overlaps at least one display to see and grab it.
fn on_screen(r: Rect, monitors: &[Rect]) -> bool {
    monitors.iter().any(|m| {
        let ow = (r.0 + r.2).min(m.0 + m.2) - r.0.max(m.0);
        let oh = (r.1 + r.3).min(m.1 + m.3) - r.1.max(m.1);
        ow >= ON_SCREEN_MIN.0 && oh >= ON_SCREEN_MIN.1
    })
}

fn emit_state(app: &AppHandle, state: &str) {
    let _ = app.emit_to(OVERLAY_LABEL, "dictation://state", state.to_string());
}

// ─────────────────────────── permission probes ─────────────────────────────

// `Boolean` in these C APIs is an unsigned char (guaranteed 0/1), so read it as
// u8 and compare — never as a Rust `bool` (whose only valid bit patterns are
// 0/1, which would be UB if the API ever returned otherwise).
#[cfg(target_os = "macos")]
#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn AXIsProcessTrusted() -> u8;
    fn AXIsProcessTrustedWithOptions(options: core_foundation::dictionary::CFDictionaryRef) -> u8;
    static kAXTrustedCheckOptionPrompt: core_foundation::string::CFStringRef;
}
#[cfg(target_os = "macos")]
#[link(name = "Carbon", kind = "framework")]
extern "C" {
    fn IsSecureEventInputEnabled() -> u8;
}

/// Whether this process is trusted for Accessibility (required to synthesise the
/// ⌘V keystroke). Checked without prompting; the UI deep-links to the settings
/// pane when this is false.
#[cfg(target_os = "macos")]
pub fn accessibility_trusted() -> bool {
    unsafe { AXIsProcessTrusted() != 0 }
}

/// Windows has no Accessibility-style gate on synthesised input for a normal
/// (non-elevated) target, so dictation is always allowed to type.
#[cfg(not(target_os = "macos"))]
pub fn accessibility_trusted() -> bool {
    true
}

/// Fire the system Accessibility prompt AND register this app in the
/// Accessibility list so the user can toggle it. Returns the trust state (still
/// false until they grant + we're relaunched, but the dialog + list entry are
/// what we're after). Runs on the main thread inside the exception barrier.
#[cfg(target_os = "macos")]
fn prompt_accessibility() -> bool {
    use core_foundation::base::TCFType;
    use core_foundation::boolean::CFBoolean;
    use core_foundation::dictionary::CFDictionary;
    use core_foundation::string::CFString;
    unsafe {
        // kAXTrustedCheckOptionPrompt: kCFBooleanTrue → show the system dialog.
        let key = CFString::wrap_under_get_rule(kAXTrustedCheckOptionPrompt);
        let value = CFBoolean::true_value();
        let options = CFDictionary::from_CFType_pairs(&[(key.as_CFType(), value.as_CFType())]);
        AXIsProcessTrustedWithOptions(options.as_concrete_TypeRef()) != 0
    }
}

/// Whether a secure input field (a password field) is focused right now. macOS
/// blocks synthesised keystrokes into secure fields, so we detect it and keep
/// the text on the clipboard instead of silently failing.
#[cfg(target_os = "macos")]
pub fn secure_input_active() -> bool {
    unsafe { IsSecureEventInputEnabled() != 0 }
}

/// Windows exposes no system-wide "secure input" probe; report false.
#[cfg(not(target_os = "macos"))]
pub fn secure_input_active() -> bool {
    false
}

// ─────────────────────── ObjC exception barrier ────────────────────────────

/// Run an Objective-C-adjacent closure ON THE MAIN THREAD, inside an exception
/// barrier. NSPasteboard / NSWorkspace / NSRunningApplication are main-thread
/// APIs that can raise an `NSException`; such a foreign exception unwinding into
/// Rust aborts the WHOLE host app ("Rust cannot catch foreign exceptions") —
/// which is exactly the crash Oz hit at finish. This is the permanent guarantee
/// that **dictation can never abort the host app**: any throw becomes a logged
/// `Err`. `step` names the operation so a future repro names the thrower in one
/// log line. `objc2::exception::catch` must sit ON the throwing thread, so it
/// runs inside the main-thread hop.
#[cfg(target_os = "macos")]
fn on_main_guarded<T, F>(app: &AppHandle, step: &'static str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + std::panic::UnwindSafe + 'static,
{
    crate::commands::run_on_main(app, move || {
        objc2::exception::catch(f).map_err(|exc| {
            let detail = exc
                .map(|e| format!("{e:?}"))
                .unwrap_or_else(|| "nil NSException".to_string());
            eprintln!("dictation: step={step} threw an Objective-C exception: {detail}");
            format!("{step} raised an Objective-C exception")
        })
    })
    .map_err(|e| {
        eprintln!("dictation: step={step} could not reach the main thread: {e}");
        format!("{step} could not run on the main thread: {e}")
    })?
}

/// Windows twin of the barrier: the clipboard / foreground / keybd_event calls
/// are thread-agnostic, so run them right here and turn any Rust panic into a
/// logged `Err` (dictation must never take the host app down).
#[cfg(not(target_os = "macos"))]
fn on_main_guarded<T, F>(_app: &AppHandle, step: &'static str, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + std::panic::UnwindSafe + 'static,
{
    std::panic::catch_unwind(f).map_err(|_| {
        eprintln!("dictation: step={step} panicked");
        format!("{step} failed")
    })
}

// ─────────────────────────── text insertion ────────────────────────────────
//
// Finish-path decision tree (`text` = the dictation; `pid` = the captured
// target, ≤ 0 if unknown):
//
//   AX not trusted → set clipboard · fire the AX prompt · show "grant + ⌘V"
//                    notice · NO restore (dictation stays on the clipboard).
//   Secure field   → set clipboard · show "password field + ⌘V" notice · NO
//                    restore.
//   AX granted, normal field:
//       set clipboard fails → notice · NO restore.
//       else → hide overlay · activate target · WAIT until it's frontmost ·
//              post ⌘V to the HID tap:
//                  paste threw  → "on your clipboard, ⌘V" notice · NO restore.
//                  paste posted → SUCCESS: restore prior clipboard after the
//                                 paste lands (only if it's still ours).
//
// Restore happens ONLY on the confirmed-success path — a failed paste must
// never have its dictation clobbered off the clipboard. Every AppKit /
// NSPasteboard / AX call runs on the main thread inside the exception barrier,
// so a throw is logged, never fatal.

fn insert_text(app: &AppHandle, pid: i64, text: &str) {
    // (A) Accessibility gate. Without trust, macOS silently REFUSES synthetic
    // key events (the "can't do that" beep Oz heard) — so don't even try. Fire
    // the system prompt (also lists the app under Accessibility) and leave the
    // text on the clipboard for a manual ⌘V. In `tauri dev` the debug binary is
    // usually untrusted, which is exactly this path.
    if !accessibility_trusted() {
        set_clipboard_best_effort(app, text);
        #[cfg(target_os = "macos")]
        let _ = on_main_guarded(app, "ax_prompt", prompt_accessibility);
        notify_and_autohide(
            app,
            "Turn on Accessibility for Lalela (System Settings ▸ Privacy & Security) to let it type for you. Your dictation is on the clipboard — press ⌘V to paste.",
        );
        return; // NO restore
    }

    // (B) Secure input field (password): macOS blocks synthetic paste. Leave it
    // on the clipboard.
    if secure_input_active() {
        set_clipboard_best_effort(app, text);
        notify_and_autohide(
            app,
            "A password field is focused — macOS blocks typing here. Your dictation is on the clipboard — press ⌘V to paste.",
        );
        return; // NO restore
    }

    // (C) Normal field, AX granted. Save the prior clipboard, then set ours.
    let prior = on_main_guarded(app, "clipboard_get", clipboard_get_text).unwrap_or(None);
    let owned = text.to_string();
    let set_ok =
        on_main_guarded(app, "clipboard_set", move || clipboard_set_text(&owned)).unwrap_or(false);
    if !set_ok {
        notify_and_autohide(app, "Couldn't reach the clipboard to insert the dictation.");
        return; // NO restore
    }

    // (D) Bring the captured target to the front and WAIT until it's actually
    // frontmost (poll, up to ~600 ms) — posting ⌘V before the app is active is
    // what gets it dropped. If it never comes frontmost (activation refused, app
    // quit, …) the ⌘V would go nowhere, so surface a clipboard notice instead of
    // silently doing nothing. Unknown pid: a brief settle, then post to the tap.
    if pid > 0 {
        let _ = on_main_guarded(app, "activate_target", move || activate_pid(pid));
        if !wait_until_frontmost(app, pid, Duration::from_millis(600)) {
            notify_and_autohide(
                app,
                &format!(
                    "Couldn't switch to the app to type — your dictation is on the clipboard, press {PASTE_KEYS} to paste."
                ),
            );
            return; // NO restore
        }
    } else {
        thread::sleep(Duration::from_millis(120));
    }

    // Target is frontmost now: the overlay's job is done — get it out of the way
    // right before the paste.
    hide_overlay(app);

    // (E) Post ⌘V to the HID tap (a real key-equivalent, unlike post_to_pid).
    if let Err(e) = on_main_guarded(app, "synthesize_paste", synthesize_paste) {
        // AX was granted yet the synth threw (rare, and caught): the text is on
        // the clipboard, so tell the user (re-showing the overlay) to paste it.
        notify_and_autohide(
            app,
            &format!("Couldn't type the text ({e}) — it's on your clipboard, press {PASTE_KEYS} to paste."),
        );
        return; // NO restore
    }

    // (F) Confirmed-success path ONLY: restore the previous clipboard after the
    // paste has had time to land — but only if it's still OUR text (a clipboard
    // manager may have taken over). A non-text prior clipboard we couldn't read
    // just leaves our dictation there (documented v1 limit).
    let app2 = app.clone();
    let mine = text.to_string();
    thread::spawn(move || {
        thread::sleep(Duration::from_millis(600));
        let current =
            on_main_guarded(&app2, "clipboard_get_restore", clipboard_get_text).unwrap_or(None);
        if current.as_deref() == Some(mine.as_str()) {
            if let Some(p) = prior {
                let _ = on_main_guarded(&app2, "clipboard_restore", move || clipboard_set_text(&p));
            }
        }
    });
}

/// Put `text` on the clipboard (main thread + guarded), ignoring failure — used
/// on the paths where the dictation must be left for a manual ⌘V.
fn set_clipboard_best_effort(app: &AppHandle, text: &str) {
    let owned = text.to_string();
    let _ = on_main_guarded(app, "clipboard_set_fallback", move || clipboard_set_text(&owned));
}

/// Show a message in the overlay (where the user is looking), also emit it to
/// the main window as a fallback, then auto-hide the overlay after a few seconds.
/// Crucially it RE-SHOWS the overlay first: the success path hides it before the
/// paste, so a late failure notice would otherwise render into a hidden window.
fn notify_and_autohide(app: &AppHandle, message: &str) {
    reveal_overlay(app);
    let _ = app.emit_to(OVERLAY_LABEL, "dictation://notice", message.to_string());
    let _ = app.emit("dictation://unavailable", message.to_string());
    let app2 = app.clone();
    thread::spawn(move || {
        thread::sleep(Duration::from_secs(7));
        hide_overlay(&app2);
    });
}

/// Make the overlay visible again WITHOUT resetting it to the listening state or
/// stealing focus (show, don't focus) — so a failure notice is actually seen.
/// No-op if the window doesn't exist.
fn reveal_overlay(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(OVERLAY_LABEL) {
        let _ = w.show();
    }
}

/// Poll NSWorkspace until the app with `pid` is frontmost. Returns true if it
/// became frontmost, false on timeout. The polls hop to the main thread
/// (frontmost_pid); the waits are off-main so the UI never freezes.
fn wait_until_frontmost(app: &AppHandle, pid: i64, timeout: Duration) -> bool {
    let start = Instant::now();
    loop {
        if frontmost_pid(app) == Some(pid) {
            return true;
        }
        if start.elapsed() >= timeout {
            return false;
        }
        thread::sleep(Duration::from_millis(40));
    }
}

/// Read the clipboard's text. Runs on the main thread + guarded by the caller
/// (NSPasteboard is main-thread-picky and can raise).
fn clipboard_get_text() -> Option<String> {
    arboard::Clipboard::new().ok().and_then(|mut c| c.get_text().ok())
}

/// Write text to the clipboard. Runs on the main thread + guarded by the caller.
/// Returns whether it succeeded.
fn clipboard_set_text(text: &str) -> bool {
    arboard::Clipboard::new()
        .and_then(|mut c| c.set_text(text.to_string()))
        .is_ok()
}

/// Synthesise a full ⌘V — Command down, V down (⌘ held), V up, Command up —
/// posted to the HID event tap. Posting real key events to the tap (rather than
/// `CGEventPostToPid`) is what routes ⌘V as a menu key-equivalent, so apps like
/// Notes actually paste instead of beeping. The caller has already brought the
/// target frontmost. kVK_ANSI_V = 9, kVK_Command = 55.
#[cfg(target_os = "macos")]
fn synthesize_paste() {
    use core_graphics::event::{CGEvent, CGEventFlags, CGEventTapLocation, CGKeyCode};
    use core_graphics::event_source::{CGEventSource, CGEventSourceStateID};

    const KEY_V: CGKeyCode = 9;
    const KEY_CMD: CGKeyCode = 55;
    const TAP: CGEventTapLocation = CGEventTapLocation::HID;

    let Ok(source) = CGEventSource::new(CGEventSourceStateID::CombinedSessionState) else {
        return;
    };
    let post = |keycode: CGKeyCode, down: bool, flags: CGEventFlags| {
        if let Ok(ev) = CGEvent::new_keyboard_event(source.clone(), keycode, down) {
            ev.set_flags(flags);
            ev.post(TAP);
        }
    };
    post(KEY_CMD, true, CGEventFlags::CGEventFlagCommand);
    post(KEY_V, true, CGEventFlags::CGEventFlagCommand);
    post(KEY_V, false, CGEventFlags::CGEventFlagCommand);
    post(KEY_CMD, false, CGEventFlags::empty());
}

/// The PID of the frontmost application (the paste target), via NSWorkspace.
/// Runs on the main thread inside the exception barrier.
fn frontmost_pid(app: &AppHandle) -> Option<i64> {
    on_main_guarded(app, "frontmost_pid", frontmost_pid_raw).ok().flatten()
}

#[cfg(target_os = "macos")]
fn frontmost_pid_raw() -> Option<i64> {
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send};
    unsafe {
        let workspace: *mut AnyObject = msg_send![class!(NSWorkspace), sharedWorkspace];
        if workspace.is_null() {
            return None;
        }
        let running: *mut AnyObject = msg_send![workspace, frontmostApplication];
        if running.is_null() {
            return None;
        }
        let pid: i32 = msg_send![running, processIdentifier];
        Some(pid as i64)
    }
}

/// Bring the app with `pid` to the front so it receives the paste. Best-effort;
/// called on the main thread inside the exception barrier.
#[cfg(target_os = "macos")]
fn activate_pid(pid: i64) {
    if pid <= 0 {
        return;
    }
    let pid = pid as i32;
    use objc2::runtime::AnyObject;
    use objc2::{class, msg_send, sel};
    unsafe {
        let running: *mut AnyObject =
            msg_send![class!(NSRunningApplication), runningApplicationWithProcessIdentifier: pid];
        if running.is_null() {
            return;
        }
        // Use `activateWithOptions:` (available since 10.6, works on every
        // runtime) — NOT the no-arg `activate` (macOS 14+): that selector is
        // absent on Oz's runtime and threw `unrecognized selector` — the
        // NSException that was the ORIGINAL crash before v3's barrier. Guard with
        // respondsToSelector: as belt-and-suspenders.
        let responds: bool = msg_send![running, respondsToSelector: sel!(activateWithOptions:)];
        if !responds {
            eprintln!("dictation: NSRunningApplication lacks activateWithOptions: — can't activate");
            return;
        }
        // NSApplicationActivateAllWindows (1<<0) | NSApplicationActivateIgnoringOtherApps (1<<1).
        let opts: usize = (1 << 0) | (1 << 1);
        let _: bool = msg_send![running, activateWithOptions: opts];
    }
}

// ─────────────────────────── Windows OS layer ───────────────────────────────
//
// A handful of user32 calls, declared by hand (user32 is always linked on
// Windows; this avoids a new windows-sys dependency and a lockfile change).
// The "pid" handed around the shared code is the target's top-level HWND as an
// integer — Windows guarantees HWNDs fit in 32 bits for WOW64 interop, and they
// are never 0 for a real window.

#[cfg(target_os = "windows")]
mod win32 {
    pub type Hwnd = isize;
    #[link(name = "user32")]
    extern "system" {
        pub fn GetForegroundWindow() -> Hwnd;
        pub fn SetForegroundWindow(hwnd: Hwnd) -> i32;
        pub fn IsWindow(hwnd: Hwnd) -> i32;
        pub fn IsIconic(hwnd: Hwnd) -> i32;
        pub fn ShowWindow(hwnd: Hwnd, cmd: i32) -> i32;
        pub fn GetAncestor(hwnd: Hwnd, flags: u32) -> Hwnd;
        pub fn GetAsyncKeyState(vk: i32) -> i16;
        pub fn keybd_event(vk: u8, scan: u8, flags: u32, extra: usize);
    }
    pub const GA_ROOT: u32 = 2;
    pub const SW_RESTORE: i32 = 9;
    pub const KEYEVENTF_KEYUP: u32 = 0x0002;
    pub const VK_SHIFT: u8 = 0x10;
    pub const VK_CONTROL: u8 = 0x11;
    pub const VK_MENU: u8 = 0x12; // Alt
    pub const VK_LWIN: u8 = 0x5B;
    pub const VK_RWIN: u8 = 0x5C;
    pub const VK_V: u8 = 0x56;
}

/// The foreground top-level window (the paste target), as an integer id.
#[cfg(target_os = "windows")]
fn frontmost_pid_raw() -> Option<i64> {
    let h = unsafe { win32::GetForegroundWindow() };
    if h == 0 {
        return None;
    }
    let root = unsafe { win32::GetAncestor(h, win32::GA_ROOT) };
    Some(if root != 0 { root } else { h } as i64)
}

/// Bring the captured window back to the foreground. Allowed because Lalela is
/// the foreground process at this moment (the hotkey / overlay gave it focus);
/// a minimised target is restored first.
#[cfg(target_os = "windows")]
fn activate_pid(pid: i64) {
    if pid <= 0 {
        return;
    }
    let h = pid as win32::Hwnd;
    unsafe {
        if win32::IsWindow(h) == 0 {
            return;
        }
        if win32::IsIconic(h) != 0 {
            win32::ShowWindow(h, win32::SW_RESTORE);
        }
        win32::SetForegroundWindow(h);
    }
}

/// Synthesise Ctrl+V into the foreground window. Any modifier the user is still
/// physically holding from the hotkey chord (Shift / Alt / Win) is released
/// first, otherwise the target would see Ctrl+Shift+V (paste-as-plain-text, or
/// nothing) or an Alt menu activation instead of a paste.
#[cfg(target_os = "windows")]
fn synthesize_paste() {
    use win32::*;
    unsafe {
        for vk in [VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN] {
            if (GetAsyncKeyState(vk as i32) as u16 & 0x8000) != 0 {
                keybd_event(vk, 0, KEYEVENTF_KEYUP, 0);
            }
        }
        keybd_event(VK_CONTROL, 0, 0, 0);
        keybd_event(VK_V, 0, 0, 0);
        keybd_event(VK_V, 0, KEYEVENTF_KEYUP, 0);
        keybd_event(VK_CONTROL, 0, KEYEVENTF_KEYUP, 0);
    }
}

// ─────────────────────────── shared helpers ────────────────────────────────

/// Join a thread but give up after `timeout`, leaving a stuck thread detached
/// rather than freezing the caller (a mic thread can wedge in CoreAudio's HAL).
fn join_timeout(handle: JoinHandle<()>, timeout: Duration) {
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = handle.join();
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(timeout);
}

#[cfg(test)]
mod overlay_geometry_tests {
    use super::*;

    const MAIN: Rect = (0.0, 0.0, 1512.0, 982.0);
    const LEFT: Rect = (-1920.0, 0.0, 1920.0, 1080.0);

    #[test]
    fn parses_saved_rect() {
        assert_eq!(parse_rect("10,20,400,150"), Some((10.0, 20.0, 400.0, 150.0)));
        assert_eq!(parse_rect("-1800, 40, 500, 300"), Some((-1800.0, 40.0, 500.0, 300.0)));
        assert_eq!(parse_rect(""), None);
        assert_eq!(parse_rect("1,2,3"), None);
        assert_eq!(parse_rect("1,2,0,150"), None);
        assert_eq!(parse_rect("a,b,c,d"), None);
        assert_eq!(parse_rect("NaN,0,400,150"), None);
    }

    #[test]
    fn clamps_size_to_bounds() {
        assert_eq!(clamp_size((5.0, 6.0, 10.0, 5000.0)), (5.0, 6.0, 320.0, 900.0));
    }

    #[test]
    fn corner_spot_is_on_screen() {
        assert!(on_screen((1100.0, 820.0, 400.0, 150.0), &[MAIN]));
        // Partly hanging off an edge is fine as long as it can still be grabbed.
        assert!(on_screen((1400.0, 0.0, 400.0, 150.0), &[MAIN]));
    }

    #[test]
    fn spot_on_unplugged_display_falls_back() {
        let r = (-1500.0, 200.0, 400.0, 150.0);
        assert!(on_screen(r, &[MAIN, LEFT]));
        assert!(!on_screen(r, &[MAIN]));
        assert!(!on_screen(r, &[]));
        // Only a sliver still visible → treat as off-screen.
        assert!(!on_screen((1490.0, 100.0, 400.0, 150.0), &[MAIN]));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn partial_interval_floor_and_backoff() {
        // Fast decode (Metal / a quick CPU): the 1.2 s floor applies.
        assert_eq!(partial_interval(Duration::ZERO), Duration::from_millis(1200));
        assert_eq!(partial_interval(Duration::from_millis(400)), Duration::from_millis(1200));
        // Slow decode: wait twice the last pass so partials can't starve the final.
        assert_eq!(partial_interval(Duration::from_secs(3)), Duration::from_secs(6));
    }

    #[test]
    fn paste_keys_match_the_platform() {
        if cfg!(target_os = "macos") {
            assert_eq!(PASTE_KEYS, "⌘V");
        } else {
            assert_eq!(PASTE_KEYS, "Ctrl+V");
        }
    }
}
