//! Recording orchestrator: captures mic audio on a dedicated thread, optionally
//! captures system audio (macOS: Swift Core Audio helper; Windows: WASAPI
//! loopback — see system_tap.rs), and runs a transcription worker
//! that emits live transcript segments (labeled "Me" / "Others") to the frontend.
//!
//! The cpal `Stream` is `!Send`, so it is created and dropped entirely on the
//! audio thread; control happens via an atomic stop flag and a shared buffer.

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::{Duration, Instant};

use cpal::traits::{DeviceTrait, StreamTrait};
use cpal::SampleFormat;
use serde::Serialize;
use tauri::{AppHandle, Emitter};

use crate::asr::{self, EngineBias};
use crate::audio;
// Diarization (sherpa-rs) is desktop-only; iOS is mic-only ("Me") so it's skipped.
#[cfg(desktop)]
use crate::diarize::{self, Diarizer};
use crate::models;
use crate::system_tap::SystemAudio;
use crate::transcribe::Segment;

/// Seconds of audio per transcription window while recording.
const WINDOW_SECS: usize = 8;

/// Windows quieter than this RMS are treated as silence and skipped.
const SILENCE_RMS: f32 = 0.006;

/// Mic input below this RMS is *digital* silence — a dead input path, not a
/// quiet room. Measured on-device: a wedged coreaudiod delivers ~0.00003 RMS
/// zeros, while a silent room's noise floor stays ≥ ~0.002 (which is why this
/// is far below `SILENCE_RMS` — quiet meetings must never trip the watchdog).
const WEDGE_RMS: f32 = 0.0005;

/// How long the mic must be digitally silent (or deliver no samples at all)
/// before the "we can't hear your microphone" warning fires.
const WEDGE_WARN_SECS: usize = 15;

#[derive(Serialize, Clone)]
struct StatusEvent {
    state: &'static str,
    message: Option<String>,
}

#[derive(Serialize, Clone)]
struct ProgressEvent {
    downloaded: u64,
    total: u64,
}

/// Which inputs the recording actually ended up with. `system_requested`
/// exists so the UI can tell the two mic-only cases apart: the user never
/// asked for system audio (normal), versus they DID and the Core Audio tap
/// couldn't start (helper missing, permission denied, wedged helper) — which
/// silently costs them the other half of every call transcript. The fallback
/// to mic-only is deliberate and stays; being quiet about it was the bug.
#[derive(Serialize, Clone)]
struct SourcesEvent {
    mic: bool,
    system: bool,
    #[serde(rename = "systemRequested")]
    system_requested: bool,
}

fn emit_status(app: &AppHandle, state: &'static str, message: Option<String>) {
    let _ = app.emit("recording://status", StatusEvent { state, message });
}

/// One audio source feeding the transcription worker.
struct Source {
    buffer: Arc<Mutex<Vec<f32>>>,
    rate: u32,
    speaker: &'static str,
    processed: usize,
}

/// One diarized voice from a finished recording: its transcript label
/// ("Speaker 1") and its voice embedding, for speaker matching/enrolment.
pub struct ClusterVoice {
    pub label: String,
    pub embedding: Vec<f32>,
}

pub struct Recorder {
    stop: Arc<AtomicBool>,
    paused: Arc<AtomicBool>,
    audio_handle: Option<JoinHandle<()>>,
    worker_handle: Option<JoinHandle<()>>,
    /// Bumped by the transcription worker every time it finishes a window, so
    /// `stop()` can tell a worker that is still draining its backlog (keep
    /// waiting) from one that is wedged (give up).
    worker_progress: Arc<AtomicU64>,
    watchdog_handle: Option<JoinHandle<()>>,
    system: Option<SystemAudio>,
    app: AppHandle,
    mic_buffer: Arc<Mutex<Vec<f32>>>,
    mic_rate: u32,
    /// All emitted transcript segments, accumulated for the final (diarized) result.
    segments: Arc<Mutex<Vec<Segment>>>,
    /// Extract per-cluster voice embeddings after diarization (Slice 1;
    /// user opt-in — embeddings are biometric and stay on-device). Only read on
    /// desktop (diarization is desktop-only); mobile is mic-only "Me", no diarize.
    #[cfg_attr(mobile, allow(dead_code))]
    voiceprints: bool,
    /// Quick voice memo (Wave B1): mic-only capture where every segment is the
    /// user speaking. Suppresses the diarization pass at stop so the transcript
    /// stays labeled "Me" (and stop is instant — no diarization model fetch).
    /// Only read on desktop; mobile is already mic-only "Me" (no diarization).
    #[cfg_attr(mobile, allow(dead_code))]
    mic_only: bool,
}

impl Recorder {
    /// Start capturing. When `capture_system` is true, additionally spawns the
    /// system-audio helper (Core Audio tap). It defaults off in the UI because
    /// the tap can deadlock the HAL on some machines; mic-only is the safe path.
    ///
    /// `local_transcribe: false` (cloud mode) captures audio only — no ASR
    /// worker, no model download, no live segments; the caller exports a WAV
    /// after stop and sends it to the hosted transcription route instead.
    ///
    /// `engine` selects the local speech engine (`"whisper"` default; sidecar
    /// engines fall back to whisper with a surfaced notice when unavailable).
    /// `bias` carries vocabulary hints (workspace card, dictionary) applied to
    /// every transcription window.
    /// `voiceprints` additionally extracts a voice embedding per diarized
    /// cluster at stop time so known speakers can be auto-named (opt-in).
    /// `mic_only` (Wave B1) marks a quick voice memo: it forces the system tap
    /// off regardless of `capture_system`, and suppresses diarization at stop so
    /// every segment stays "Me" (the user dictating).
    pub fn start(
        app: AppHandle,
        capture_system: bool,
        local_transcribe: bool,
        engine: String,
        bias: EngineBias,
        voiceprints: bool,
        mic_only: bool,
    ) -> Result<Recorder, String> {
        // Android (P2): mic capture rides the shared cpal path below. cpal's AAudio
        // backend activates automatically on `target_os = "android"` (needs no
        // AVAudioSession like iOS), so there's no Android-specific setup here —
        // just no system tap (mobile is mic-only, like iOS). RECORD_AUDIO is a
        // runtime permission requested by MainActivity; if it's denied the cpal
        // input stream fails to open and the error surfaces on the recording view's
        // banner (same path as a desktop mic failure) — no crash. See docs/ANDROID.md §P2.

        // A voice memo is mic-only by definition — never spawn the system tap,
        // even if the user has system audio enabled in Settings.
        let capture_system = capture_system && !mic_only;

        // iOS: the session must be in record mode before the stream is built,
        // or cpal captures silence. Also fires the mic-permission prompt.
        #[cfg(target_os = "ios")]
        crate::ios_audio::activate()?;

        // Resolve the input device/config up front so mic errors surface
        // synchronously. The model download happens on the worker thread so
        // recording starts instantly and audio buffers while the model is
        // fetched on first run.
        let (device, supported) = audio::default_input()?;
        let sample_format = supported.sample_format();
        let config: cpal::StreamConfig = supported.config();
        let channels = config.channels as usize;
        let mic_rate = config.sample_rate; // cpal 0.18: SampleRate is a u32 alias

        let mic_buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let paused = Arc::new(AtomicBool::new(false));
        let seg_acc: Arc<Mutex<Vec<Segment>>> = Arc::new(Mutex::new(Vec::new()));

        // The mic-silence watchdog must not judge the microphone while the ASR
        // engine is still being prepared. On first run `create_engine` can block
        // for seconds–minutes downloading a model (whisper's, or — new — Apple
        // Speech's on-device model), during which nothing consumes audio and the
        // user may sit silent waiting; that stretch must never surface as a
        // "we can't hear your microphone" warning. The worker flips this true once
        // the engine is live. Cloud mode has no engine to prepare → starts ready.
        let engine_ready = Arc::new(AtomicBool::new(!local_transcribe));

        // Start the mic stream FIRST, before any system-audio tap exists. On some
        // Macs (especially with virtual audio devices) a Core Audio process-tap
        // deadlocks the mic's `AudioUnit::start`; starting the mic first — and
        // only adding the tap once it's confirmed running — avoids that, so both
        // "Me" (mic) and "Others" (system) get captured together. `ready_tx`
        // signals when the mic is actually capturing (or failed to).
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();

        // Android: start the mic foreground service (+ wake lock) BEFORE the cpal
        // stream opens. Without it, Android revokes mic access the moment the app
        // is backgrounded and OEM power managers (Xiaomi/HyperOS) freeze the
        // process seconds after screen-off — capture dies silently mid-meeting.
        // Every exit path below (the mic-open error return, stop(), stop_audio())
        // tears it back down. Applies to voice memos too — any capture = service.
        #[cfg(target_os = "android")]
        crate::android::start_recording_service();

        // --- Audio thread: builds and owns the !Send mic stream. ---
        let audio_buffer = mic_buffer.clone();
        let audio_stop = stop.clone();
        let audio_paused = paused.clone();
        let app_audio = app.clone();
        let audio_handle = thread::spawn(move || {
            macro_rules! err_cb {
                () => {{
                    let ea = app_audio.clone();
                    // Streams often error while being torn down (and on iOS when
                    // the session deactivates) — only real mid-recording failures
                    // should reach the user.
                    let stopped = audio_stop.clone();
                    move |e| {
                        if !stopped.load(Ordering::Relaxed) {
                            let _ =
                                ea.emit("recording://error", format!("audio stream error: {e}"));
                        }
                    }
                }};
            }

            let stream_result = match sample_format {
                SampleFormat::F32 => {
                    let buf = audio_buffer.clone();
                    let p = audio_paused.clone();
                    device.build_input_stream(
                        config,
                        move |data: &[f32], _: &_| {
                            if p.load(Ordering::Relaxed) {
                                return;
                            }
                            let mono = audio::downmix_mic_to_mono(data, channels);
                            if let Ok(mut b) = buf.lock() {
                                b.extend_from_slice(&mono);
                            }
                        },
                        err_cb!(),
                        None,
                    )
                }
                SampleFormat::I16 => {
                    let buf = audio_buffer.clone();
                    let p = audio_paused.clone();
                    device.build_input_stream(
                        config,
                        move |data: &[i16], _: &_| {
                            if p.load(Ordering::Relaxed) {
                                return;
                            }
                            let f: Vec<f32> =
                                data.iter().map(|s| *s as f32 / i16::MAX as f32).collect();
                            let mono = audio::downmix_mic_to_mono(&f, channels);
                            if let Ok(mut b) = buf.lock() {
                                b.extend_from_slice(&mono);
                            }
                        },
                        err_cb!(),
                        None,
                    )
                }
                SampleFormat::U16 => {
                    let buf = audio_buffer.clone();
                    let p = audio_paused.clone();
                    device.build_input_stream(
                        config,
                        move |data: &[u16], _: &_| {
                            if p.load(Ordering::Relaxed) {
                                return;
                            }
                            let f: Vec<f32> = data
                                .iter()
                                .map(|s| (*s as f32 / u16::MAX as f32) * 2.0 - 1.0)
                                .collect();
                            let mono = audio::downmix_mic_to_mono(&f, channels);
                            if let Ok(mut b) = buf.lock() {
                                b.extend_from_slice(&mono);
                            }
                        },
                        err_cb!(),
                        None,
                    )
                }
                other => {
                    let msg = format!("unsupported sample format: {other:?}");
                    let _ = app_audio.emit("recording://error", msg.clone());
                    let _ = ready_tx.send(Err(msg));
                    return;
                }
            };

            let stream = match stream_result {
                Ok(s) => s,
                Err(e) => {
                    let msg = format!("could not open microphone: {e}");
                    let _ = app_audio.emit("recording://error", msg.clone());
                    let _ = ready_tx.send(Err(msg));
                    return;
                }
            };
            if let Err(e) = stream.play() {
                let msg = format!("could not start mic: {e}");
                let _ = app_audio.emit("recording://error", msg.clone());
                let _ = ready_tx.send(Err(msg));
                return;
            }
            // Mic is now capturing — safe to add the system-audio tap.
            let _ = ready_tx.send(Ok(()));
            while !audio_stop.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(100));
            }
            drop(stream);
        });

        // Wait until the mic is actually capturing (or has failed) before we
        // create the system-audio tap — this ordering is what stops the tap from
        // deadlocking the mic on affected Macs.
        match ready_rx.recv_timeout(Duration::from_secs(3)) {
            Ok(Ok(())) => {}
            Ok(Err(e)) => {
                // Mic couldn't start — abort cleanly rather than record silence.
                stop.store(true, Ordering::Relaxed);
                let _ = audio_handle.join();
                // Android: no capture happened, so tear the service back down.
                #[cfg(target_os = "android")]
                crate::android::stop_recording_service();
                return Err(e);
            }
            Err(_) => {} // timed out waiting for the mic — proceed best-effort.
        }

        // Now that the mic is running, optionally start system-audio capture
        // (best-effort, opt-in — skipped unless enabled in Settings).
        let system = if capture_system {
            SystemAudio::start(paused.clone(), crate::paths::app_data_dir(&app).ok())
        } else {
            None
        };
        let system_info = system.as_ref().map(|s| (s.buffer.clone(), s.sample_rate));
        let _ = app.emit(
            "capture://sources",
            SourcesEvent {
                mic: true,
                system: system.is_some(),
                system_requested: capture_system,
            },
        );

        // --- Silence watchdog: catches a dead mic input path mid-recording. ---
        // A wedged coreaudiod keeps the stream "running" but delivers pure
        // zeros, so every window falls under SILENCE_RMS and the transcript
        // silently ends up empty. Watch the raw mic buffer (works in cloud
        // mode too, which has no transcription worker) and tell the UI when
        // input has been digitally silent — or absent — for too long, and when
        // it recovers. Emits `recording://mic-silence` with true/false.
        let wd_buffer = mic_buffer.clone();
        let wd_stop = stop.clone();
        let wd_paused = paused.clone();
        let wd_engine_ready = engine_ready.clone();
        let app_wd = app.clone();
        let wd_warn_samples = mic_rate as usize * WEDGE_WARN_SECS;
        let watchdog_handle = thread::spawn(move || {
            let mut processed = 0usize;
            let mut silent_samples = 0usize;
            let mut stalled = Duration::ZERO; // wall time with no new samples
            let mut warned = false;
            const TICK: Duration = Duration::from_secs(1);
            while !wd_stop.load(Ordering::Relaxed) {
                thread::sleep(TICK);
                if wd_paused.load(Ordering::Relaxed) {
                    continue;
                }
                // Engine still preparing (e.g. a first-run model download): skip
                // past everything buffered during prep and reset the counters, so
                // the watchdog only ever judges the mic once transcription is live
                // and actually consuming audio.
                if !wd_engine_ready.load(Ordering::Relaxed) {
                    if let Ok(b) = wd_buffer.lock() {
                        processed = b.len();
                    }
                    silent_samples = 0;
                    stalled = Duration::ZERO;
                    continue;
                }
                let chunk: Vec<f32> = match wd_buffer.lock() {
                    Ok(b) if b.len() > processed => b[processed..].to_vec(),
                    Ok(_) => {
                        // Stream delivering nothing at all is as dead as zeros.
                        stalled += TICK;
                        if !warned && stalled.as_secs() as usize >= WEDGE_WARN_SECS {
                            warned = true;
                            let _ = app_wd.emit("recording://mic-silence", true);
                        }
                        continue;
                    }
                    Err(_) => continue,
                };
                processed += chunk.len();
                stalled = Duration::ZERO;
                if audio::rms(&chunk) < WEDGE_RMS {
                    silent_samples += chunk.len();
                    if !warned && silent_samples >= wd_warn_samples {
                        warned = true;
                        let _ = app_wd.emit("recording://mic-silence", true);
                    }
                } else {
                    silent_samples = 0;
                    if warned {
                        warned = false;
                        let _ = app_wd.emit("recording://mic-silence", false);
                    }
                }
            }
        });

        // --- Transcription worker: fixed windows per source, flush tails on stop. ---
        // Cloud mode records without one: audio just accumulates in the buffers.
        if !local_transcribe {
            emit_status(&app, "recording", None);
        }
        let worker_stop = stop.clone();
        let worker_progress = Arc::new(AtomicU64::new(0));
        let worker_progress_w = worker_progress.clone();
        let worker_seg_acc = seg_acc.clone();
        let worker_mic_buffer = mic_buffer.clone();
        let worker_engine_ready = engine_ready.clone();
        let app_worker = app.clone();
        let worker_handle = if !local_transcribe {
            None
        } else {
            Some(thread::spawn(move || {
                // Name what's being prepared. Apple Speech's first run downloads its
                // on-device model inside create_engine (seconds–minutes) — say so, so
                // the wait reads as progress, not a hang or an error.
                let preparing = if engine.as_str() == asr::APPLE_ID && asr::apple_engine_available()
                {
                    "Preparing Apple Speech — downloading the on-device model…"
                } else {
                    "Preparing transcription model…"
                };
                emit_status(&app_worker, "preparing", Some(preparing.into()));
                let app_dl = app_worker.clone();
                let (mut asr_engine, fallback_notice) =
                    match asr::create_engine(&app_worker, &engine, move |downloaded, total| {
                        let _ =
                            app_dl.emit("model://progress", ProgressEvent { downloaded, total });
                    }) {
                        Ok(pair) => pair,
                        Err(e) => {
                            let _ = app_worker.emit("recording://error", e);
                            return;
                        }
                    };
                if let Some(notice) = fallback_notice {
                    let _ = app_worker.emit("asr://fallback", notice);
                }
                emit_status(&app_worker, "recording", None);
                // Engine is live and consuming audio now — release the mic-silence
                // watchdog, which was suppressed through the (possibly long) prep.
                worker_engine_ready.store(true, Ordering::Relaxed);

                let mut sources: Vec<Source> = vec![Source {
                    buffer: worker_mic_buffer,
                    rate: mic_rate,
                    speaker: "Me",
                    processed: 0,
                }];
                if let Some((buf, rate)) = system_info {
                    sources.push(Source {
                        buffer: buf,
                        rate,
                        speaker: "Others",
                        processed: 0,
                    });
                }

                loop {
                    let stopping = worker_stop.load(Ordering::Relaxed);
                    let mut did_work = false;

                    for src in sources.iter_mut() {
                        let available = src.buffer.lock().map(|b| b.len()).unwrap_or(src.processed);
                        let window = src.rate as usize * WINDOW_SECS;
                        let Some(end) = window_end(available, src.processed, window, stopping)
                        else {
                            continue;
                        };

                        let chunk: Vec<f32> = match src.buffer.lock() {
                            // Re-clamp: the lock was released and re-taken, and
                            // `end` came from the earlier read.
                            Ok(b) if end <= b.len() => b[src.processed..end].to_vec(),
                            _ => continue,
                        };
                        let offset_ms = (src.processed as i64 * 1000) / src.rate as i64;
                        let mut resampled = audio::resample_to_16k(&chunk, src.rate);
                        // Skip near-silent windows: Whisper hallucinates filler
                        // ("you", "[Silence]") on silence, which would pollute the
                        // transcript and summaries. The gate also admits QUIET
                        // speech (raw Windows laptop mics, no AGC) that a plain
                        // RMS cut dropped wholesale — Store cert failure 09-24.
                        if !audio::has_speech(&resampled, SILENCE_RMS) {
                            src.processed = end;
                            did_work = true;
                            continue;
                        }
                        audio::normalize_quiet(&mut resampled);
                        match asr_engine.transcribe(&resampled, offset_ms, src.speaker, &bias) {
                            Ok(segments) => {
                                for seg in segments {
                                    if let Ok(mut acc) = worker_seg_acc.lock() {
                                        acc.push(seg.clone());
                                    }
                                    let _ = app_worker.emit("transcript://segment", seg);
                                }
                            }
                            Err(e) => {
                                let _ = app_worker.emit("recording://error", e);
                            }
                        }
                        src.processed = end;
                        did_work = true;
                        worker_progress_w.fetch_add(1, Ordering::Relaxed);
                    }

                    if stopping && !did_work {
                        break;
                    }
                    if !did_work {
                        thread::sleep(Duration::from_millis(300));
                    }
                }

                // Flush segments the engine is still holding — engines with
                // cross-window context (Apple Speech) finalize sentences late, so
                // the meeting's last sentence may only surface here. No-op for the
                // stateless whisper/sidecar engines.
                match asr_engine.finish() {
                    Ok(segments) => {
                        for seg in segments {
                            if let Ok(mut acc) = worker_seg_acc.lock() {
                                acc.push(seg.clone());
                            }
                            let _ = app_worker.emit("transcript://segment", seg);
                        }
                    }
                    Err(e) => {
                        let _ = app_worker.emit("recording://error", e);
                    }
                }

                emit_status(&app_worker, "stopped", None);
            }))
        };

        Ok(Recorder {
            stop,
            paused,
            audio_handle: Some(audio_handle),
            worker_handle,
            worker_progress,
            watchdog_handle: Some(watchdog_handle),
            system,
            app,
            mic_buffer,
            mic_rate,
            segments: seg_acc,
            voiceprints,
            mic_only,
        })
    }

    pub fn set_paused(&self, value: bool) {
        self.paused.store(value, Ordering::Relaxed);
    }

    /// Stop capture, run the diarization pass over the mic audio, and return
    /// the final (relabeled, time-sorted) transcript segments plus — when
    /// voiceprints are enabled — one voice embedding per diarized cluster.
    pub fn stop(mut self) -> (Vec<Segment>, Vec<ClusterVoice>) {
        // When the system tap ran, the two channels are already labeled
        // Me/Others; diarizing the mic channel would only re-split the echo of
        // remote voices leaking from the speakers. Skipping it also makes Stop
        // near-instant for the call-recording case.
        #[cfg(desktop)]
        let had_system = self.system.is_some();
        self.stop.store(true, Ordering::Relaxed);
        // The mic thread can wedge inside CoreAudio's HAL (`AudioUnit::start`) on
        // machines with virtual audio devices; a plain `join()` would then block
        // forever and freeze the caller. Bound the wait and abandon a stuck
        // thread instead — the process still exits cleanly on quit.
        if let Some(h) = self.audio_handle.take() {
            join_timeout(h, Duration::from_secs(3));
        }
        // The worker flushes every window still queued when Stop arrives. On a
        // slow CPU (a Windows laptop decoding on the CPU while other apps run)
        // it can be several windows behind real time; a flat 5 s join used to
        // abandon that backlog, so the END of the meeting was missing from the
        // saved transcript. Wait while it is still finishing windows; give up
        // only if it makes no progress for a while (wedged), or at a hard cap.
        if let Some(h) = self.worker_handle.take() {
            // 90 s without a finished window = wedged. One 8 s window has been
            // seen taking 20+ s on a CPU shared with a running game, so the
            // idle limit must comfortably exceed a single slow decode.
            join_while_progressing(
                h,
                &self.worker_progress,
                Duration::from_secs(90),
                Duration::from_secs(600),
            );
        }
        if let Some(h) = self.watchdog_handle.take() {
            join_timeout(h, Duration::from_secs(2));
        }
        if let Some(sys) = self.system.take() {
            sys.stop();
        }
        // Android: mic stream is closed — release the foreground service + wake lock.
        #[cfg(target_os = "android")]
        crate::android::stop_recording_service();

        let mut segments = self.segments.lock().map(|s| s.clone()).unwrap_or_default();

        // Diarize the mic channel to separate multiple in-person voices (desktop
        // only, and only for mic-only recordings — see note at the top of stop()).
        // A voice memo (`mic_only`) skips this entirely: every segment is the
        // user dictating, so it stays "Me" and stop is instant (no model fetch).
        #[cfg(desktop)]
        let voices = if !had_system && !self.mic_only {
            self.run_diarization(&mut segments)
        } else {
            Vec::new()
        };
        // Mobile (iOS + Android) is mic-only "Me" — no diarization pass.
        #[cfg(mobile)]
        let voices = Vec::new();

        // Hand the audio session back so other apps' audio can resume.
        #[cfg(target_os = "ios")]
        crate::ios_audio::deactivate();

        segments.sort_by_key(|s| s.t0_ms);
        (segments, voices)
    }

    /// Stop capture and return the raw mic audio (mono samples + rate) instead
    /// of transcript segments. Used by cloud mode, where transcription happens
    /// server-side from an exported WAV after the recording ends.
    pub fn stop_audio(mut self) -> (Vec<f32>, u32) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.audio_handle.take() {
            join_timeout(h, Duration::from_secs(3));
        }
        if let Some(h) = self.worker_handle.take() {
            join_timeout(h, Duration::from_secs(5));
        }
        if let Some(h) = self.watchdog_handle.take() {
            join_timeout(h, Duration::from_secs(2));
        }
        if let Some(sys) = self.system.take() {
            sys.stop();
        }
        // Android: mic stream is closed — release the foreground service + wake lock.
        #[cfg(target_os = "android")]
        crate::android::stop_recording_service();
        #[cfg(target_os = "ios")]
        crate::ios_audio::deactivate();
        emit_status(&self.app, "stopped", None);
        let samples = self
            .mic_buffer
            .lock()
            .map(|b| b.clone())
            .unwrap_or_default();
        (samples, self.mic_rate)
    }

    /// Best-effort: if the mic channel has multiple speakers, relabel its
    /// "Me" segments to "Speaker 1/2/3…" and (when voiceprints are enabled)
    /// return one voice embedding per cluster. Silently no-ops on any failure.
    #[cfg(desktop)]
    fn run_diarization(&self, segments: &mut [Segment]) -> Vec<ClusterVoice> {
        let mic_samples = match self.mic_buffer.lock() {
            Ok(b) => b.clone(),
            Err(_) => return Vec::new(),
        };
        // Too short to diarize meaningfully.
        if mic_samples.len() < self.mic_rate as usize {
            return Vec::new();
        }

        emit_status(&self.app, "diarizing", Some("Separating speakers…".into()));
        let app_dl = self.app.clone();
        let models = models::ensure_diarization_models(&self.app, move |d, t| {
            let _ = app_dl.emit(
                "model://progress",
                ProgressEvent {
                    downloaded: d,
                    total: t,
                },
            );
        });
        let (seg_model, emb_model) = match models {
            Ok(m) => m,
            Err(_) => return Vec::new(),
        };

        let mut diarizer =
            match Diarizer::new(&seg_model.to_string_lossy(), &emb_model.to_string_lossy()) {
                Ok(d) => d,
                Err(_) => return Vec::new(),
            };

        let audio_16k = audio::resample_to_16k(&mic_samples, self.mic_rate);
        let turns = match diarizer.compute(audio_16k.clone()) {
            Ok(t) => t,
            Err(_) => return Vec::new(),
        };

        let distinct = {
            let mut ids: Vec<i32> = turns.iter().map(|t| t.speaker).collect();
            ids.sort_unstable();
            ids.dedup();
            ids.len()
        };

        // Only relabel when there's genuinely more than one in-person voice.
        if distinct <= 1 {
            return Vec::new();
        }
        diarize::relabel(segments, &turns, "Speaker ", "Me");

        // Voiceprint extraction (opt-in): one embedding per cluster, labeled
        // exactly like the relabeled segments so the caller can match/enrol.
        if !self.voiceprints {
            return Vec::new();
        }
        let mut embedder = match diarize::SpeakerEmbedder::new(&emb_model.to_string_lossy()) {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        };
        embedder
            .embed_clusters(&audio_16k, &turns)
            .into_iter()
            .map(|(cluster, embedding)| ClusterVoice {
                label: format!("Speaker {}", cluster + 1),
                embedding,
            })
            .collect()
    }
}

/// Where the next transcription window ends for a source, or `None` when there
/// is nothing to do yet.
///
/// Pure, and deliberately saturating: `available` and `processed` are read under
/// two SEPARATE locks (and from two different producer threads at two different
/// sample rates — the mic at its device rate, the system tap at the endpoint's),
/// so a plain `available - processed` is an unsigned subtraction that panics the
/// worker thread the moment those two reads disagree. The window is capped at
/// `available` for the same reason.
fn window_end(available: usize, processed: usize, window: usize, stopping: bool) -> Option<usize> {
    let pending = available.saturating_sub(processed);
    if pending == 0 {
        return None;
    }
    if pending >= window {
        // `window` can be 0 only if the source reported a 0 sample rate, which
        // `SystemAudio::start` already rejects; `max(1)` keeps it progressing
        // rather than looping forever on a zero-length window.
        Some(processed + window.max(1).min(pending))
    } else if stopping {
        Some(available)
    } else {
        None
    }
}

/// Join a thread but give up after `timeout`, leaving the thread detached rather
/// than blocking the caller forever. Used so a mic thread wedged in CoreAudio's
/// HAL can never freeze Stop.
/// Join a worker that reports progress through `progress`: keep waiting as long
/// as the counter keeps moving (at most `idle` between bumps), and never longer
/// than `cap` overall. Returns whether the thread actually finished.
fn join_while_progressing(
    handle: JoinHandle<()>,
    progress: &AtomicU64,
    idle: Duration,
    cap: Duration,
) -> bool {
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = handle.join();
        let _ = tx.send(());
    });
    let start = Instant::now();
    let mut last_seen = progress.load(Ordering::Relaxed);
    let mut last_move = Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(250)) {
            Ok(()) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return true,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
        }
        let now = progress.load(Ordering::Relaxed);
        if now != last_seen {
            last_seen = now;
            last_move = Instant::now();
        }
        if last_move.elapsed() >= idle || start.elapsed() >= cap {
            return false;
        }
    }
}

fn join_timeout(handle: JoinHandle<()>, timeout: Duration) {
    let (tx, rx) = std::sync::mpsc::channel();
    thread::spawn(move || {
        let _ = handle.join();
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(timeout);
}

#[cfg(test)]
mod drain_tests {
    use super::join_while_progressing;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::Arc;
    use std::thread;
    use std::time::{Duration, Instant};

    #[test]
    fn waits_for_a_worker_that_keeps_making_progress() {
        // A backlog of 6 windows at 150 ms each (900 ms in total) must be fully
        // drained: every gap is under `idle`, though the total is well over it.
        let p = Arc::new(AtomicU64::new(0));
        let pw = p.clone();
        let h = thread::spawn(move || {
            for _ in 0..6 {
                thread::sleep(Duration::from_millis(150));
                pw.fetch_add(1, Ordering::Relaxed);
            }
        });
        let done =
            join_while_progressing(h, &p, Duration::from_millis(400), Duration::from_secs(10));
        assert!(done);
        assert_eq!(p.load(Ordering::Relaxed), 6);
    }

    #[test]
    fn gives_up_on_a_wedged_worker() {
        let p = Arc::new(AtomicU64::new(0));
        let h = thread::spawn(|| thread::sleep(Duration::from_secs(5)));
        let t = Instant::now();
        let done =
            join_while_progressing(h, &p, Duration::from_millis(300), Duration::from_secs(10));
        assert!(!done);
        assert!(t.elapsed() < Duration::from_secs(2));
    }
}

#[cfg(test)]
mod tests {
    use super::{window_end, SourcesEvent, WINDOW_SECS};
    use crate::audio;

    /// A 48 kHz system source and a 16 kHz mic source drain in their OWN units:
    /// the window length is per-source, and both land on 8 s at 16 kHz.
    #[test]
    fn windows_are_per_source_rate_and_resample_to_the_same_length() {
        for rate in [16_000u32, 44_100, 48_000] {
            let window = rate as usize * WINDOW_SECS;
            let end = window_end(window * 3, 0, window, false).expect("a full window is ready");
            assert_eq!(end, window);
            let chunk = vec![0.25f32; end];
            let resampled = audio::resample_to_16k(&chunk, rate);
            assert_eq!(resampled.len(), 16_000 * WINDOW_SECS, "rate {rate}");
        }
    }

    /// The worker reads `available` and the chunk under two separate locks, and
    /// its two sources are filled by two different threads at two different
    /// rates. Before the fix this was `available - processed` — an unsigned
    /// subtraction that panicked ("attempt to subtract with overflow") and took
    /// the whole process down as soon as the two reads disagreed.
    #[test]
    fn a_shrunk_or_stale_buffer_never_underflows() {
        assert_eq!(window_end(0, 384_000, 384_000, false), None);
        assert_eq!(window_end(0, 384_000, 384_000, true), None);
        assert_eq!(window_end(100, 384_000, 384_000, true), None);
    }

    /// Odd tails: nothing until stop, then whatever is left, and never past the
    /// end of the buffer.
    #[test]
    fn odd_tails_flush_only_on_stop_and_stay_in_bounds() {
        let window = 48_000 * WINDOW_SECS;
        assert_eq!(window_end(1_234, 0, window, false), None);
        assert_eq!(window_end(1_234, 0, window, true), Some(1_234));
        assert_eq!(window_end(window + 7, 0, window, true), Some(window));
        // Never returns an end past `available`, whatever the window says.
        for stopping in [false, true] {
            for available in [0usize, 1, 999, window - 1, window, window + 1] {
                if let Some(end) = window_end(available, 0, window, stopping) {
                    assert!(end <= available, "{available}/{stopping} -> {end}");
                }
            }
        }
    }

    /// A zero-length window (a source that reported a 0 sample rate) must not
    /// spin the worker forever on an empty chunk.
    #[test]
    fn a_zero_length_window_still_makes_progress() {
        assert_eq!(window_end(10, 0, 0, false), Some(1));
    }

    /// The UI's "system audio unavailable" notice hangs off these three flags,
    /// so the wire names are a contract with `CaptureSources` in lib/lalela.ts.
    #[test]
    fn sources_event_reports_the_degraded_case() {
        let degraded = SourcesEvent {
            mic: true,
            system: false,
            system_requested: true,
        };
        let json = serde_json::to_string(&degraded).unwrap();
        assert_eq!(
            json,
            r#"{"mic":true,"system":false,"systemRequested":true}"#
        );
    }

    /// Mic-only because nobody asked for system audio is NOT a degrade — the
    /// notice must not fire for it.
    #[test]
    fn mic_only_by_choice_is_not_a_degrade() {
        let chosen = SourcesEvent {
            mic: true,
            system: false,
            system_requested: false,
        };
        let json = serde_json::to_string(&chosen).unwrap();
        assert!(json.contains(r#""systemRequested":false"#));
    }
}
