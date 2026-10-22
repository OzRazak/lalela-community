//! Whisper model management: locate, and download on first run.

use std::fs;
use std::io::{Read, Write};
use std::path::PathBuf;
use tauri::AppHandle;

/// Default local transcription model. `base.en` is a good speed/accuracy balance
/// and runs comfortably even on 8GB Macs. ~142 MB.
pub const MODEL_FILE: &str = "ggml-base.en.bin";
pub const MODEL_URL: &str =
    "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";

pub fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = crate::paths::app_data_dir(app)?.join("models");
    // Create the legacy per-app dir first (unchanged): a brand-new install with
    // no dirs must still be able to download models (Jade's bug). The shared
    // cache below adopts from — and falls back to — this same dir.
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    // macOS: delegate to the estate-shared, download-once cache, adopting
    // anything already in this legacy per-app dir. Fall back to the legacy dir
    // on any error so behaviour is unchanged when the shared store is empty or
    // unavailable. iOS keeps its per-app dir (no shared Application Support), so
    // this whole block is compiled out there (crate absent) — never named on iOS.
    // Never in the Community edition: it must not read or write the official
    // apps' shared cache (digital.auxo.shared), even when built here.
    #[cfg(all(target_os = "macos", not(lalela_community)))]
    if let Ok(shared) = auxo_model_cache::shared_dir_adopting(std::slice::from_ref(&dir)) {
        return Ok(shared);
    }
    Ok(dir)
}

pub fn model_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(models_dir(app)?.join(MODEL_FILE))
}

/// Ensure the model is present locally, downloading it if needed.
/// `progress(downloaded, total)` is invoked periodically during download.
pub fn ensure_model<F: Fn(u64, u64)>(app: &AppHandle, progress: F) -> Result<PathBuf, String> {
    let path = model_path(app)?;
    download_if_missing(MODEL_URL, &path, progress)?;
    Ok(path)
}

// --- Diarization models (Phase 2b) ---

pub const SEG_MODEL_FILE: &str = "pyannote-segmentation-3.0.onnx";
pub const SEG_MODEL_URL: &str =
    "https://huggingface.co/csukuangfj/sherpa-onnx-pyannote-segmentation-3-0/resolve/main/model.onnx";
pub const EMB_MODEL_FILE: &str = "speaker-embedding-titanet-en.onnx";
pub const EMB_MODEL_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/nemo_en_titanet_small.onnx";

/// Ensure both diarization models exist locally; returns (segmentation, embedding).
pub fn ensure_diarization_models<F: Fn(u64, u64)>(
    app: &AppHandle,
    progress: F,
) -> Result<(PathBuf, PathBuf), String> {
    let dir = models_dir(app)?;
    let seg = dir.join(SEG_MODEL_FILE);
    let emb = dir.join(EMB_MODEL_FILE);
    download_if_missing(SEG_MODEL_URL, &seg, &progress)?;
    download_if_missing(EMB_MODEL_URL, &emb, &progress)?;
    Ok((seg, emb))
}

/// Stream `url` to `dest` if it doesn't already exist, reporting progress.
pub(crate) fn download_if_missing<F: Fn(u64, u64)>(url: &str, dest: &PathBuf, progress: F) -> Result<(), String> {
    if dest.exists() {
        return Ok(());
    }
    let tmp = dest.with_extension("part");
    let resp = download_client()?
        .get(url)
        .timeout(STALL_TIMEOUT)
        .send()
        .map_err(|e| format!("download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("download failed: HTTP {}", resp.status()));
    }
    let total = resp.content_length().unwrap_or(0);
    let mut reader = resp;
    let mut file = fs::File::create(&tmp).map_err(|e| e.to_string())?;
    let mut buf = [0u8; 1 << 16];
    let mut downloaded: u64 = 0;
    let mut last_report: u64 = 0;
    loop {
        let n = reader.read(&mut buf).map_err(|e| e.to_string())?;
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(|e| e.to_string())?;
        downloaded += n as u64;
        if downloaded - last_report >= 2 << 20 {
            progress(downloaded, total);
            last_report = downloaded;
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&tmp, dest).map_err(|e| e.to_string())?;
    progress(downloaded, total.max(downloaded));
    Ok(())
}

/// Connect timeout for model downloads. Only the TCP/TLS handshake is bounded
/// this tightly — nothing bounds the transfer as a whole.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);
/// Stall detector. In reqwest's blocking client a per-request timeout applies to
/// the wait for headers and to EACH body read — i.e. "no bytes for this long",
/// never "the whole download took this long", so a slow link is never cut off.
/// The client-wide default (30 s) was short enough that one Wi-Fi hiccup killed
/// a multi-GB GGUF download with the opaque "error decoding response body".
const STALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(120);

fn download_client() -> Result<reqwest::blocking::Client, String> {
    reqwest::blocking::Client::builder()
        .timeout(None::<std::time::Duration>)
        .connect_timeout(CONNECT_TIMEOUT)
        .tcp_keepalive(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("could not start download: {e}"))
}

/// Resumable variant used for the (large) local-LLM GGUF files (desktop only).
///
/// If a `<dest>.part` already exists it resumes with an HTTP `Range` request and
/// appends; if the server ignores the range (200) or the partial is unusable
/// (416) it restarts cleanly from byte 0. On completion it verifies the total
/// size and, when `expected_sha256` is set, the file's SHA-256 before promoting
/// `.part` → final. A checksum/size failure leaves nothing half-installed.
///
/// Transient failures (connection drops, stalls, 5xx, a short body) are
/// retried in-process a few times with backoff, each retry resuming from the
/// `.part`. If they persist, the user gets a plain "retry to resume" message;
/// the full error chain goes to the log.
#[cfg(desktop)]
pub(crate) fn download_resumable<F: Fn(u64, u64)>(
    url: &str,
    dest: &PathBuf,
    expected_sha256: Option<&str>,
    progress: F,
) -> Result<(), String> {
    const MAX_ATTEMPTS: u32 = 5;

    if dest.exists() {
        return Ok(());
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let client = download_client()?;
    let mut attempt: u32 = 1;
    loop {
        match download_attempt(&client, url, dest, expected_sha256, &progress) {
            Ok(()) => return Ok(()),
            Err(DownloadError::Fatal(msg)) => {
                eprintln!("[models] model download failed permanently ({url}): {msg}");
                return Err(msg);
            }
            Err(DownloadError::Transient(detail)) => {
                eprintln!(
                    "[models] model download interrupted ({url}), attempt {attempt}/{MAX_ATTEMPTS}: {detail}"
                );
                if attempt >= MAX_ATTEMPTS {
                    return Err(INTERRUPTED_MSG.into());
                }
                // 2 s, 4 s, 8 s, 16 s.
                std::thread::sleep(std::time::Duration::from_secs(1u64 << attempt));
                attempt += 1;
            }
        }
    }
}

/// What the user sees when a download keeps dropping. The `.part` file is kept,
/// so pressing Download again resumes where it stopped.
#[cfg(desktop)]
pub(crate) const INTERRUPTED_MSG: &str =
    "Download interrupted — check your connection and retry to resume where it stopped.";

#[cfg(desktop)]
#[derive(Debug)]
enum DownloadError {
    /// Worth retrying from the `.part` (network drop, stall, 5xx, short body).
    /// Carries the full error chain for the log — never shown to the user.
    Transient(String),
    /// Retrying won't help (4xx, disk error, checksum mismatch). User-facing.
    Fatal(String),
}

#[cfg(desktop)]
fn http_status_error(status: reqwest::StatusCode) -> DownloadError {
    if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        DownloadError::Transient(format!("HTTP {status}"))
    } else {
        DownloadError::Fatal(format!("download failed: HTTP {status}"))
    }
}

#[cfg(desktop)]
fn download_attempt<F: Fn(u64, u64)>(
    client: &reqwest::blocking::Client,
    url: &str,
    dest: &PathBuf,
    expected_sha256: Option<&str>,
    progress: &F,
) -> Result<(), DownloadError> {
    use sha2::{Digest, Sha256};
    use std::fs::OpenOptions;
    let fatal = |e: std::io::Error| DownloadError::Fatal(e.to_string());

    let tmp = dest.with_extension("part");
    let mut existing = fs::metadata(&tmp).map(|m| m.len()).unwrap_or(0);

    let get = |from: u64| {
        let mut req = client.get(url).timeout(STALL_TIMEOUT);
        if from > 0 {
            req = req.header("Range", format!("bytes={from}-"));
        }
        req.send()
            .map_err(|e| DownloadError::Transient(format!("request failed: {e:?}")))
    };

    let mut resp = get(existing)?;
    // Decide how to treat the response:
    //   206 to a ranged request  → resume (append to the .part)
    //   200 to a ranged request  → server sent the whole file from 0 → restart
    //   5xx / 429                → server trouble, not a bad .part → keep it,
    //                               retry later
    //   416 / other non-success  → the .part is unusable; drop it and re-request
    //                               from scratch (no Range) so we never stream an
    //                               error body into the file
    let resuming = if existing > 0 {
        let status = resp.status();
        if status == reqwest::StatusCode::PARTIAL_CONTENT {
            true
        } else if status.is_success() {
            existing = 0;
            false
        } else if status.is_server_error() || status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(http_status_error(status));
        } else {
            let _ = fs::remove_file(&tmp);
            existing = 0;
            resp = get(0)?;
            if !resp.status().is_success() {
                return Err(http_status_error(resp.status()));
            }
            false
        }
    } else {
        if !resp.status().is_success() {
            return Err(http_status_error(resp.status()));
        }
        false
    };

    let remaining = resp.content_length().unwrap_or(0);
    let total = if resuming { existing + remaining } else { remaining };

    let mut hasher = expected_sha256.map(|_| Sha256::new());

    let mut file = if resuming {
        // Fold the bytes already on disk into the hash before appending, so the
        // final digest covers the whole file even across resumes.
        if let Some(h) = hasher.as_mut() {
            let mut ef = fs::File::open(&tmp).map_err(fatal)?;
            let mut b = [0u8; 1 << 16];
            loop {
                let n = ef.read(&mut b).map_err(fatal)?;
                if n == 0 {
                    break;
                }
                h.update(&b[..n]);
            }
        }
        OpenOptions::new().append(true).open(&tmp).map_err(fatal)?
    } else {
        fs::File::create(&tmp).map_err(fatal)?
    };

    let mut reader = resp;
    let mut buf = [0u8; 1 << 16];
    let mut downloaded = existing;
    let mut last_report = downloaded;
    progress(downloaded, total.max(downloaded));
    loop {
        // A body read error is a dropped or stalled connection. Everything
        // written so far is already in the .part, so the retry resumes.
        let n = match reader.read(&mut buf) {
            Ok(n) => n,
            Err(e) => {
                let _ = file.flush();
                return Err(DownloadError::Transient(format!(
                    "body read failed at {downloaded}/{total} bytes: {e:?}"
                )));
            }
        };
        if n == 0 {
            break;
        }
        file.write_all(&buf[..n]).map_err(fatal)?;
        if let Some(h) = hasher.as_mut() {
            h.update(&buf[..n]);
        }
        downloaded += n as u64;
        if downloaded - last_report >= 2 << 20 {
            progress(downloaded, total.max(downloaded));
            last_report = downloaded;
        }
    }
    file.flush().map_err(fatal)?;
    drop(file);

    // Size gate (skipped when the server never sent a content length). Short
    // means the connection closed early; the retry resumes from the .part.
    if total > 0 && downloaded != total {
        return Err(DownloadError::Transient(format!(
            "download incomplete: {downloaded}/{total} bytes"
        )));
    }
    // Checksum gate. A mismatch means a corrupt/tampered file: drop the partial
    // so the next attempt starts fresh rather than resuming bad bytes.
    if let (Some(h), Some(expected)) = (hasher, expected_sha256) {
        let got = hex::encode(h.finalize());
        if !got.eq_ignore_ascii_case(expected) {
            let _ = fs::remove_file(&tmp);
            return Err(DownloadError::Fatal(format!(
                "checksum mismatch (expected {expected}, got {got}) — download discarded"
            )));
        }
    }
    fs::rename(&tmp, dest).map_err(fatal)?;
    progress(downloaded, total.max(downloaded));
    Ok(())
}
