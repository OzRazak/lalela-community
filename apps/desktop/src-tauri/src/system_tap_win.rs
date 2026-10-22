//! Windows system-audio capture (WASAPI loopback).
//!
//! On Windows there is no sidecar helper and no OS permission prompt: WASAPI
//! lets us open a *capture* client on the default **render** (output) device,
//! which records the render mix — everything the machine is playing.
//!
//! Why not `cpal` (which the microphone uses)? cpal always initialises its
//! WASAPI clients with `AUDCLNT_STREAMFLAGS_EVENTCALLBACK`
//! (`host/wasapi/device.rs:66`), and Windows never signals that event for a
//! loopback stream. The stream opens and "runs" but not one frame is ever
//! delivered — proven on the test PC 2026-09-21: the app showed
//! "Mic + system audio" and transcribed nothing while audio was demonstrably
//! playing (endpoint peak meter 0.54). Loopback must be **polled**, which is
//! what the `wasapi` crate's `StreamMode::PollingShared` does.
//!
//! Best-effort, exactly like the macOS tap: any failure (no default render
//! device, unsupported format, client init error) returns `None` and the
//! recording continues mic-only instead of failing. Every one of those
//! failures — and the running stream's throughput — is written to
//! `sysaudio.log` in the app data dir, because a silent `None` is exactly what
//! made the 8-channel bug below undebuggable from the user's machine.

use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

use wasapi::{
    initialize_mta, AudioCaptureClient, AudioClient, DeviceEnumerator, Direction, SampleType,
    StreamMode, WaveFormat,
};

use crate::audio;

/// Rolling diagnostics file (`sysaudio.log` in the app data dir).
///
/// Deliberately tiny and dependency-free: a line-buffered append handle, rolled
/// over once it passes `MAX_LOG_BYTES` so it can never grow without bound. Every
/// write is one `writeln!` — the capture loop never logs per packet.
struct TapLog {
    file: Option<std::fs::File>,
    started: Instant,
}

/// Roll the log over past this size (one long meeting is a few KB).
const MAX_LOG_BYTES: u64 = 256 * 1024;

impl TapLog {
    /// Open (or roll) `<dir>/sysaudio.log`. A `None` dir, or any IO failure,
    /// degrades to a no-op logger — diagnostics must never break capture.
    fn open(dir: Option<PathBuf>) -> TapLog {
        let file = dir.and_then(|dir| {
            let path = dir.join("sysaudio.log");
            if std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0) > MAX_LOG_BYTES {
                let _ = std::fs::rename(&path, dir.join("sysaudio.log.1"));
            }
            let _ = std::fs::create_dir_all(&dir);
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&path)
                .ok()
        });
        let mut log = TapLog {
            file,
            started: Instant::now(),
        };
        let epoch = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        log.line(&format!("--- session (unix time {epoch}) ---"));
        log
    }

    /// Append one timestamped line, stamped with seconds since this session
    /// opened so a throughput gap is readable without a date parser.
    fn line(&mut self, msg: &str) {
        use std::io::Write;
        if let Some(f) = self.file.as_mut() {
            let _ = writeln!(f, "[{:8.3}] {msg}", self.started.elapsed().as_secs_f64());
        }
    }
}

/// How long to wait for the loopback client to come up before giving up
/// (mic-only). Bounds `start_recording` the same way the macOS header timeout
/// does.
const START_TIMEOUT: Duration = Duration::from_secs(3);

/// Floor for the polling interval, so a device reporting a tiny period can't
/// spin the thread. The capture buffer is sized well above this.
const MIN_POLL: Duration = Duration::from_millis(5);

/// Ceiling for the polling interval (and the fallback when the device period
/// looks implausible).
const MAX_POLL: Duration = Duration::from_millis(20);

/// How often the running stream writes a throughput line. Cheap by design —
/// one line per interval, never per packet.
const STATS_EVERY: Duration = Duration::from_secs(5);

/// Hard ceiling on frames pulled in a single drain pass, so a device that keeps
/// reporting a ready packet can't starve the `stop` check.
const MAX_DRAIN_PASSES: u32 = 64;

pub struct SystemAudio {
    pub buffer: Arc<Mutex<Vec<f32>>>,
    pub sample_rate: u32,
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl SystemAudio {
    /// Start buffering the machine's output mix as mono f32. `None` if there is
    /// no usable default render device. While `paused` is set, audio is dropped
    /// (but the device is still drained, so the stream can't overrun).
    ///
    /// `log_dir` is the app data dir; diagnostics land in `sysaudio.log` there.
    pub fn start(paused: Arc<AtomicBool>, log_dir: Option<PathBuf>) -> Option<SystemAudio> {
        let buffer: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));

        // WASAPI objects are COM interfaces bound to the thread that created
        // them, so everything lives on this one thread for the life of the
        // capture; only the sample rate travels back.
        let (tx, rx) = mpsc::channel::<Option<u32>>();
        let tbuf = buffer.clone();
        let tstop = stop.clone();
        let thread = std::thread::spawn(move || {
            let mut log = TapLog::open(log_dir);
            capture_thread(tbuf, paused, tstop, tx, &mut log);
        });

        match rx.recv_timeout(START_TIMEOUT) {
            Ok(Some(rate)) if rate > 0 => Some(SystemAudio {
                buffer,
                sample_rate: rate,
                stop,
                thread: Some(thread),
            }),
            _ => {
                // Failed or timed out: unwind the thread and fall back to
                // mic-only rather than leaving a half-open client behind.
                stop.store(true, Ordering::Relaxed);
                let _ = thread.join();
                None
            }
        }
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(h) = self.thread.take() {
            let _ = h.join();
        }
    }
}

/// Owns the WASAPI client for the whole capture: opens it, reports the sample
/// rate (or `None` on failure), then polls until `stop`.
fn capture_thread(
    buffer: Arc<Mutex<Vec<f32>>>,
    paused: Arc<AtomicBool>,
    stop: Arc<AtomicBool>,
    tx: mpsc::Sender<Option<u32>>,
    log: &mut TapLog,
) {
    log.line("start: opening default render endpoint for loopback capture");
    // MTA: this thread never pumps a message loop.
    if let Err(e) = initialize_mta().ok() {
        // Already initialised (STA/MTA) is normal and harmless; record it and
        // carry on — the Activate call below is what actually decides.
        log.line(&format!("initialize_mta: {e}"));
    }

    let (client, capture, format, poll) = match open_loopback(log) {
        Some(v) => v,
        None => {
            let _ = tx.send(None);
            return;
        }
    };
    let channels = format.get_nchannels() as usize;
    let rate = format.get_samplespersec();
    let bytes_per_sample = (format.get_bitspersample() / 8) as usize;
    let mask = format.get_dwchannelmask();
    let subformat = format.get_subformat();
    let float_samples = matches!(&subformat, Ok(SampleType::Float));
    log.line(&format!(
        "mixformat: {channels} ch, {rate} Hz, {} bit, blockalign {}, mask {mask:#x}, subformat {}",
        format.get_bitspersample(),
        format.get_blockalign(),
        match &subformat {
            Ok(SampleType::Float) => "IEEE_FLOAT".to_string(),
            Ok(SampleType::Int) => "PCM".to_string(),
            Err(e) => format!("unsupported ({e})"),
        }
    ));

    // Only 32-bit float and 16-bit int mixes are handled; anything else would
    // be misread as noise, so decline and stay mic-only.
    let usable = bytes_per_sample == 4 && float_samples || bytes_per_sample == 2 && !float_samples;
    if channels == 0 || rate == 0 || !usable {
        log.line(&format!(
            "SOFT-FAIL: unusable mix format (channels {channels}, rate {rate}, \
             {bytes_per_sample} bytes/sample, float {float_samples}) — staying mic-only"
        ));
        let _ = tx.send(None);
        return;
    }

    // Fold N channels to mono by speaker POSITION, not by averaging. See
    // `audio::downmix_weights`: a 7.1 endpoint playing stereo has six silent
    // channels, and averaging them costs 12 dB — enough to drop every window
    // under the recording worker's silence gate.
    let weights = audio::downmix_weights(channels, mask);
    log.line(&format!("downmix weights: {weights:?}"));

    if let Err(e) = client.start_stream() {
        log.line(&format!("SOFT-FAIL: IAudioClient::Start failed: {e}"));
        let _ = tx.send(None);
        return;
    }
    log.line(&format!(
        "running: polling every {} ms, reporting {rate} Hz mono upstream",
        poll.as_millis()
    ));
    let _ = tx.send(Some(rate));

    let frame_bytes = bytes_per_sample * channels;
    let mut raw: VecDeque<u8> = VecDeque::new();
    let mut frame = vec![0u8; frame_bytes];
    let mut interleaved: Vec<f32> = Vec::new();

    // Rolling window counters, flushed to the log every STATS_EVERY.
    let mut packets = 0u64;
    let mut frames_out = 0u64;
    let mut silent_packets = 0u64;
    let mut discontinuities = 0u64;
    let mut window_peak = 0.0f32;
    let mut window_start = Instant::now();
    let mut total_frames = 0u64;
    let mut read_error: Option<String> = None;

    while !stop.load(Ordering::Relaxed) {
        // Drain every packet the endpoint has ready, not just one: a single
        // read per poll can only ever keep up with the device if the poll
        // interval stays under one period, which is not guaranteed under load.
        for _ in 0..MAX_DRAIN_PASSES {
            match capture.get_next_packet_size() {
                Ok(Some(0)) => break,
                Ok(_) => {}
                Err(e) => {
                    read_error = Some(format!("GetNextPacketSize: {e}"));
                    break;
                }
            }
            let before = raw.len();
            let info = match capture.read_from_device_to_deque(&mut raw) {
                Ok(info) => info,
                Err(e) => {
                    read_error = Some(format!("GetBuffer: {e}"));
                    break;
                }
            };
            let added = raw.len() - before;
            if added == 0 {
                break;
            }
            packets += 1;
            if info.flags.data_discontinuity {
                // Tolerated: the mixer dropped frames upstream of us. Nothing to
                // do but note it — the audio that did arrive is still good.
                discontinuities += 1;
            }
            if info.flags.silent {
                // AUDCLNT_BUFFERFLAGS_SILENT: the buffer's contents are
                // undefined and MUST be treated as zeros. Zeroing rather than
                // dropping keeps the system timeline aligned with the mic's.
                silent_packets += 1;
                for b in raw.range_mut(before..) {
                    *b = 0;
                }
            }
        }
        if read_error.is_some() {
            break;
        }

        let frames = raw.len() / frame_bytes;
        if frames > 0 {
            interleaved.clear();
            interleaved.reserve(frames * channels);
            for _ in 0..frames {
                for b in frame.iter_mut() {
                    *b = raw.pop_front().unwrap_or(0);
                }
                for s in frame.chunks_exact(bytes_per_sample) {
                    interleaved.push(if float_samples {
                        f32::from_le_bytes([s[0], s[1], s[2], s[3]])
                    } else {
                        i16::from_le_bytes([s[0], s[1]]) as f32 / i16::MAX as f32
                    });
                }
            }
            if !paused.load(Ordering::Relaxed) {
                let mono = audio::downmix_to_mono_weighted(&interleaved, &weights);
                window_peak = window_peak.max(audio::peak(&mono));
                frames_out += mono.len() as u64;
                total_frames += mono.len() as u64;
                if let Ok(mut b) = buffer.lock() {
                    b.extend_from_slice(&mono);
                }
            }
        }

        if window_start.elapsed() >= STATS_EVERY {
            log.line(&format!(
                "stats: packets {packets}, frames {frames_out}, silent {silent_packets}, \
                 discont {discontinuities}, peak {window_peak:.4}, backlog {} B",
                raw.len()
            ));
            packets = 0;
            frames_out = 0;
            silent_packets = 0;
            discontinuities = 0;
            window_peak = 0.0;
            window_start = Instant::now();
        }

        std::thread::sleep(poll);
    }

    if let Some(e) = read_error {
        log.line(&format!("read error, capture ended early: {e}"));
    }
    let _ = client.stop_stream();
    log.line(&format!(
        "stopped: {total_frames} mono frames delivered in total"
    ));
}

/// Open a polled shared-mode loopback capture client on the default render
/// device. Returns the client, its capture interface, the negotiated format and
/// the polling interval.
fn open_loopback(
    log: &mut TapLog,
) -> Option<(AudioClient, AudioCaptureClient, WaveFormat, Duration)> {
    let enumerator = match DeviceEnumerator::new() {
        Ok(e) => e,
        Err(e) => {
            log.line(&format!("SOFT-FAIL: MMDeviceEnumerator: {e}"));
            return None;
        }
    };
    // No speakers/headphones (or the default endpoint disappeared) → mic-only.
    let device = match enumerator.get_default_device(&Direction::Render) {
        Ok(d) => d,
        Err(e) => {
            log.line(&format!("SOFT-FAIL: no default render device: {e}"));
            return None;
        }
    };
    log.line(&format!(
        "endpoint: {}",
        device
            .get_friendlyname()
            .unwrap_or_else(|e| format!("<name unavailable: {e}>"))
    ));

    let mut client = match device.get_iaudioclient() {
        Ok(c) => c,
        Err(e) => {
            log.line(&format!("SOFT-FAIL: Activate(IAudioClient): {e}"));
            return None;
        }
    };
    let format = match client.get_mixformat() {
        Ok(f) => f,
        Err(e) => {
            log.line(&format!("SOFT-FAIL: GetMixFormat: {e}"));
            return None;
        }
    };
    let (default_period, _min_period) = match client.get_device_period() {
        Ok(p) => p,
        Err(e) => {
            log.line(&format!("SOFT-FAIL: GetDevicePeriod: {e}"));
            return None;
        }
    };

    // Polling, NOT events: Windows does not signal the buffer event for a
    // loopback stream (see the module comment). Ask for a buffer of ~4 device
    // periods so a late poll can't drop audio.
    //
    // `autoconvert: false` is deliberate. The format we pass IS the endpoint's
    // mix format, which shared mode always accepts verbatim, so there is
    // nothing to convert; and AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM combined with
    // AUDCLNT_STREAMFLAGS_LOOPBACK is rejected outright by some drivers
    // (AUDCLNT_E_UNSUPPORTED_FORMAT). Asking for the conversion we don't need
    // can only lose.
    let mode = StreamMode::PollingShared {
        autoconvert: false,
        buffer_duration_hns: default_period.max(100_000) * 4,
    };
    if let Err(e) = client.initialize_client(&format, &Direction::Capture, &mode) {
        log.line(&format!(
            "SOFT-FAIL: IAudioClient::Initialize (shared loopback, buffer {} hns): {e}",
            default_period.max(100_000) * 4
        ));
        return None;
    }
    let capture = match client.get_audiocaptureclient() {
        Ok(c) => c,
        Err(e) => {
            log.line(&format!("SOFT-FAIL: GetService(IAudioCaptureClient): {e}"));
            return None;
        }
    };

    // `default_period` is in 100 ns units; poll at half a period, clamped.
    let poll =
        Duration::from_nanos((default_period.max(0) as u64) * 100 / 2).clamp(MIN_POLL, MAX_POLL);
    Some((client, capture, format, poll))
}
