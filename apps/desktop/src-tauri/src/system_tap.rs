//! System-audio capture by spawning the bundled Swift helper (Core Audio tap)
//! and reading its PCM stream. Best-effort: returns `None` if unavailable
//! (non-macOS, helper missing, or permission denied) so mic-only still works.

#[cfg(not(target_os = "windows"))]
use std::io::{BufRead, BufReader, Read};
#[cfg(not(target_os = "windows"))]
use std::path::PathBuf;
use std::process::Child;
#[cfg(not(target_os = "windows"))]
use std::process::{Command, Stdio};
#[cfg(not(target_os = "windows"))]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(not(target_os = "windows"))]
use std::sync::{Arc, Mutex};
#[cfg(not(target_os = "windows"))]
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

#[cfg(not(target_os = "windows"))]
use crate::audio;

// Windows has no sidecar helper: system audio is tapped directly with a polled
// WASAPI loopback client on the default render device. Same public shape as the
// macOS `SystemAudio` (`start(paused)` / `buffer` / `sample_rate` / `stop`).
#[cfg(target_os = "windows")]
#[path = "system_tap_win.rs"]
mod win;
#[cfg(target_os = "windows")]
pub use win::SystemAudio;

/// How long to wait for the helper's startup header before giving up (mic-only).
/// Bounds the worst case so a wedged helper can never freeze `start_recording`.
#[cfg(not(target_os = "windows"))]
const HEADER_TIMEOUT: Duration = Duration::from_secs(3);

/// After SIGTERM, how long to let the helper tear down its Core Audio tap before
/// force-killing it.
const TERM_TIMEOUT: Duration = Duration::from_millis(1500);

#[cfg(not(target_os = "windows"))]
pub struct SystemAudio {
    pub buffer: Arc<Mutex<Vec<f32>>>,
    pub sample_rate: u32,
    stop: Arc<AtomicBool>,
    child: Child,
    reader: Option<JoinHandle<()>>,
}

#[cfg(not(target_os = "windows"))]
impl SystemAudio {
    /// Spawn the helper and begin buffering mono system audio. `None` if the
    /// helper can't run or the user hasn't granted audio-capture permission.
    /// While `paused` is set, incoming audio is dropped.
    ///
    /// `_log_dir` is the app data dir, used by the Windows tap for its
    /// `sysaudio.log` diagnostics; the macOS helper logs through the sidecar.
    pub fn start(paused: Arc<AtomicBool>, _log_dir: Option<PathBuf>) -> Option<SystemAudio> {
        let bin = crate::sidecar::resolve(
            "lalela-systemaudio",
            option_env!("LALELA_SYSAUDIO_BIN").unwrap_or(""),
        )?;
        sweep_orphans();

        let mut child = Command::new(&bin)
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .ok()?;

        let stdout = child.stdout.take()?;

        // Read the startup header on a helper thread so a helper that hangs
        // before printing it can't block `start_recording` forever. We move the
        // reader through the channel and get it back for the streaming loop.
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut header = String::new();
            let ok = reader.read_line(&mut header).is_ok();
            let _ = tx.send((ok, header, reader));
        });
        let (ok, header, mut reader) = match rx.recv_timeout(HEADER_TIMEOUT) {
            Ok(v) => v,
            Err(_) => {
                // Helper never produced a header in time — abandon it (mic-only).
                terminate_child(&mut child);
                return None;
            }
        };
        if !ok {
            terminate_child(&mut child);
            return None;
        }
        let parts: Vec<&str> = header.split_whitespace().collect();
        if parts.len() < 3 || parts[0] != "LALELA_AUDIO" {
            terminate_child(&mut child);
            return None;
        }
        let rate: u32 = match parts[1].parse() {
            Ok(r) => r,
            Err(_) => {
                terminate_child(&mut child);
                return None;
            }
        };
        let channels: usize = match parts[2].parse() {
            Ok(c) => c,
            Err(_) => {
                terminate_child(&mut child);
                return None;
            }
        };
        if rate == 0 || channels == 0 {
            terminate_child(&mut child);
            return None;
        }

        let buffer = Arc::new(Mutex::new(Vec::<f32>::new()));
        let stop = Arc::new(AtomicBool::new(false));

        let rbuf = buffer.clone();
        let rstop = stop.clone();
        let reader_handle = std::thread::spawn(move || {
            let mut raw = [0u8; 1 << 14];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                if rstop.load(Ordering::Relaxed) {
                    break;
                }
                let n = match reader.read(&mut raw) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                carry.extend_from_slice(&raw[..n]);
                let usable = carry.len() - (carry.len() % 4);
                if usable == 0 {
                    continue;
                }
                let mut samples: Vec<f32> = Vec::with_capacity(usable / 4);
                for c in carry[..usable].chunks_exact(4) {
                    samples.push(f32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                }
                carry.drain(..usable);
                if paused.load(Ordering::Relaxed) {
                    continue;
                }
                let mono = audio::downmix_to_mono(&samples, channels);
                if let Ok(mut b) = rbuf.lock() {
                    b.extend_from_slice(&mono);
                }
            }
        });

        Some(SystemAudio {
            buffer,
            sample_rate: rate,
            stop,
            child,
            reader: Some(reader_handle),
        })
    }

    pub fn stop(mut self) {
        self.stop.store(true, Ordering::Relaxed);
        terminate_child(&mut self.child);
        if let Some(h) = self.reader.take() {
            let _ = h.join();
        }
    }
}

/// Stop a helper child, preferring a graceful SIGTERM so its native teardown
/// runs (the system-audio helper destroys its Core Audio tap and aggregate
/// device; the window helper stops its SCStream). A hard `Child::kill()`
/// (SIGKILL) would skip that teardown — for the tap helper that leaves an
/// orphaned tap that can wedge `coreaudiod`. Falls back to SIGKILL only if
/// the helper doesn't exit within `TERM_TIMEOUT`.
pub(crate) fn terminate_child(child: &mut Child) {
    #[cfg(unix)]
    // SAFETY: `kill(2)` with a valid pid + signal; no memory is touched.
    unsafe {
        libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
    }

    let deadline = Instant::now() + TERM_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => return,
            Ok(None) => {
                if Instant::now() >= deadline {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
            Err(_) => break,
        }
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(not(target_os = "windows"))]
/// Best-effort: SIGTERM any `lalela-systemaudio` orphaned by a previous crash
/// (reparented to launchd, ppid 1). An orphaned helper holds a live Core Audio
/// tap, and orphaned taps are exactly what wedges `coreaudiod` system-wide —
/// clear them out before creating a new one. Helpers owned by a running app
/// instance (ours or another's) are left alone.
fn sweep_orphans() {
    if !cfg!(target_os = "macos") {
        return;
    }
    let Ok(out) = Command::new("pgrep")
        .args(["-x", "lalela-systemaudio"])
        .output()
    else {
        return;
    };
    for pid in String::from_utf8_lossy(&out.stdout).split_whitespace() {
        let Ok(pid_num) = pid.parse::<i32>() else {
            continue;
        };
        let Ok(pp) = Command::new("ps").args(["-o", "ppid=", "-p", pid]).output() else {
            continue;
        };
        if String::from_utf8_lossy(&pp.stdout).trim() == "1" {
            // SAFETY: `kill(2)` with a valid pid + signal; no memory is touched.
            #[cfg(unix)]
            unsafe {
                libc::kill(pid_num, libc::SIGTERM);
            }
        }
    }
}
