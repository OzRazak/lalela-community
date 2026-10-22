//! Cloud transcription (Phase 3): upload the recorded WAV to Supabase Storage
//! (private `audio` bucket), hand a short-lived signed URL to the hosted
//! `/api/transcribe` route (AssemblyAI runs server-side; the key never ships in
//! the app), poll until the job completes, then delete the uploaded audio.
//!
//! Runs from Rust (reqwest) rather than the webview to sidestep CORS. Requires
//! a signed-in user: the caller passes the Supabase access token, and Storage
//! RLS only lets authenticated users touch their own uploads.

use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::transcribe::Segment;

// Same project + publishable key as the frontend (`src/lib/supabase.ts`);
// safe to embed — RLS enforces access. Compiled in by build.rs from the
// official edition env (`edition/official.env`); absent in the Community
// edition, where cloud transcription does not exist (docs/OPEN-SOURCE.md).
const SUPABASE_URL: Option<&str> = option_env!("LALELA_SUPABASE_URL");
const SUPABASE_KEY: Option<&str> = option_env!("LALELA_SUPABASE_KEY");

/// Error every Auxo-cloud command returns in the Community edition.
pub const COMMUNITY_UNAVAILABLE: &str =
    "Cloud transcription is not available in the Lalela Community edition.";

/// The compiled-in Supabase project, or the Community-edition error.
fn supabase() -> Result<(&'static str, &'static str), String> {
    match (SUPABASE_URL, SUPABASE_KEY) {
        (Some(url), Some(key)) if !url.is_empty() && !key.is_empty() => Ok((url, key)),
        _ => Err(COMMUNITY_UNAVAILABLE.to_string()),
    }
}

const POLL_EVERY: Duration = Duration::from_secs(3);
const POLL_TIMEOUT: Duration = Duration::from_secs(15 * 60);

#[derive(serde::Serialize, Clone)]
struct CloudStatus {
    stage: &'static str,
}

fn emit_stage(app: &AppHandle, stage: &'static str) {
    let _ = app.emit("cloud://status", CloudStatus { stage });
}

/// Upload → sign → transcribe → poll → clean up. Returns Lalela segments
/// (AssemblyAI speaker labels come back as "Speaker A/B/…").
pub fn transcribe(
    app: &AppHandle,
    wav_path: &str,
    access_token: &str,
    endpoint: &str,
) -> Result<Vec<Segment>, String> {
    let (supabase_url, supabase_key) = supabase()?;
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())?;

    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let object = format!("rec-{millis}.wav");

    let result = run_job(app, &client, wav_path, access_token, endpoint, &object);

    // Always delete the uploaded object (privacy: audio is never retained in
    // the cloud after transcription). The local temp WAV is only removed on
    // success so a failed job can be retried without re-recording.
    let _ = client
        .delete(format!("{supabase_url}/storage/v1/object/audio/{object}"))
        .bearer_auth(access_token)
        .header("apikey", supabase_key)
        .send();
    if result.is_ok() {
        let _ = std::fs::remove_file(wav_path);
    }

    result
}

fn run_job(
    app: &AppHandle,
    client: &reqwest::blocking::Client,
    wav_path: &str,
    access_token: &str,
    endpoint: &str,
    object: &str,
) -> Result<Vec<Segment>, String> {
    let (supabase_url, supabase_key) = supabase()?;
    // 1. Upload the WAV to the private bucket.
    emit_stage(app, "uploading");
    let bytes = std::fs::read(wav_path).map_err(|e| format!("could not read audio: {e}"))?;
    let res = client
        .post(format!("{supabase_url}/storage/v1/object/audio/{object}"))
        .bearer_auth(access_token)
        .header("apikey", supabase_key)
        .header("content-type", "audio/wav")
        .body(bytes)
        .send()
        .map_err(|e| format!("audio upload failed: {e}"))?;
    if !res.status().is_success() {
        let status = res.status();
        let body = res.text().unwrap_or_default();
        return Err(format!("audio upload failed ({status}): {body}"));
    }

    // 2. Short-lived signed URL for the transcription service to fetch it.
    #[derive(Deserialize)]
    struct SignResp {
        #[serde(rename = "signedURL")]
        signed_url: String,
    }
    let res = client
        .post(format!("{supabase_url}/storage/v1/object/sign/audio/{object}"))
        .bearer_auth(access_token)
        .header("apikey", supabase_key)
        .json(&serde_json::json!({ "expiresIn": 3600 }))
        .send()
        .map_err(|e| format!("signing failed: {e}"))?;
    if !res.status().is_success() {
        return Err(format!("signing failed ({})", res.status()));
    }
    let signed: SignResp = res.json().map_err(|e| format!("signing failed: {e}"))?;
    let audio_url = format!("{supabase_url}/storage/v1{}", signed.signed_url);

    // 3. Start the job on the hosted route.
    emit_stage(app, "transcribing");
    #[derive(Deserialize)]
    struct StartResp {
        id: Option<String>,
        error: Option<String>,
    }
    let res = client
        .post(format!("{endpoint}/api/transcribe"))
        .bearer_auth(access_token)
        .json(&serde_json::json!({ "audioUrl": audio_url }))
        .send()
        .map_err(|e| format!("transcription request failed: {e}"))?;
    let start: StartResp = res
        .json()
        .map_err(|e| format!("transcription request failed: {e}"))?;
    let id = start
        .id
        .ok_or_else(|| start.error.unwrap_or_else(|| "transcription rejected".into()))?;

    // 4. Poll until completed.
    #[derive(Deserialize)]
    struct PollResp {
        status: Option<String>,
        error: Option<String>,
        segments: Option<Vec<Segment>>,
    }
    let deadline = Instant::now() + POLL_TIMEOUT;
    loop {
        std::thread::sleep(POLL_EVERY);
        if Instant::now() > deadline {
            return Err("transcription timed out".into());
        }
        let res = client
            .get(format!("{endpoint}/api/transcribe?id={id}"))
            .bearer_auth(access_token)
            .send()
            .map_err(|e| format!("transcription poll failed: {e}"))?;
        let poll: PollResp = res.json().map_err(|e| format!("transcription poll failed: {e}"))?;
        match poll.status.as_deref() {
            Some("completed") => return Ok(poll.segments.unwrap_or_default()),
            Some("error") => {
                return Err(poll.error.unwrap_or_else(|| "transcription failed".into()))
            }
            _ => {} // queued | processing
        }
    }
}
