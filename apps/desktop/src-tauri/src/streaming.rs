//! Streaming AI lane (CP0). One Tauri command, `stream_generate`, mirrors the
//! blocking `summarize` command's routing (apple → local sidecar → BYOK
//! OpenRouter) but forwards tokens to the frontend as `llm://delta` events
//! tagged with a per-request `id`, so concurrent callers never interleave. The
//! free-tier proxy lane is NOT here — that streams over SSE straight from the
//! web `/api/ai` route (see `apps/web`), consumed by the frontend directly.
//!
//! Cancellation: each in-flight request registers an `AtomicBool` cancel flag in
//! `StreamRegistry`; `cancel_generate(id)` flips it, and each lane polls it
//! between forwarded tokens (see `local_llm::generate_stream` /
//! `gateway::summarize_stream`). The blocking `summarize` command is untouched.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{AppHandle, Emitter, State};
// `Manager` (for `app.state::<…>()`) is only reached by the desktop-only local
// sidecar branch; importing it on iOS would be an unused-import warning.
#[cfg(desktop)]
use tauri::Manager;

/// Per-request cancel flags, keyed by the frontend-supplied request id. Managed
/// as Tauri state on every platform so `stream_generate` / `cancel_generate` can
/// reach it uniformly.
#[derive(Default)]
pub struct StreamRegistry(pub Mutex<HashMap<String, Arc<AtomicBool>>>);

impl StreamRegistry {
    /// Register a fresh (un-cancelled) flag for `id` and hand back a clone the
    /// running generation polls.
    fn register(&self, id: &str) -> Arc<AtomicBool> {
        let flag = Arc::new(AtomicBool::new(false));
        if let Ok(mut m) = self.0.lock() {
            m.insert(id.to_string(), flag.clone());
        }
        flag
    }

    /// Flip the cancel flag for `id` (no-op if unknown / already finished).
    fn cancel(&self, id: &str) {
        if let Ok(m) = self.0.lock() {
            if let Some(f) = m.get(id) {
                f.store(true, Ordering::SeqCst);
            }
        }
    }

    /// Drop the flag once a generation has finished.
    fn done(&self, id: &str) {
        if let Ok(mut m) = self.0.lock() {
            m.remove(id);
        }
    }
}

/// Blocking router shared by every streaming lane. Emits `llm://delta`
/// (`{ id, delta }`) per token and returns the full text + token count.
#[allow(clippy::too_many_arguments)]
fn run_stream(
    app: &AppHandle,
    id: &str,
    model: &str,
    prompt: &str,
    transcript: &str,
    api_key: &str,
    max_tokens: Option<u32>,
    // Optional base64 `data:` URL (CP4 screen awareness). Only the BYOK/
    // OpenRouter lane carries it — local + Apple models can't see images, so it
    // is ignored there (the caller only attaches one for vision-capable cloud
    // models anyway).
    image: Option<&str>,
    cancel: &AtomicBool,
) -> Result<crate::gateway::SummarizeOutput, String> {
    // Apple's on-device Foundation Models: map-reduce, not token-streamable, so
    // fire one delta with the whole result (CP0-acceptable). Cancel is only
    // honoured before it starts — the map-reduce can't be interrupted cleanly.
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    if model.strip_prefix("apple:").is_some() {
        if cancel.load(Ordering::SeqCst) {
            return Ok(crate::gateway::SummarizeOutput { content: String::new(), tokens: None });
        }
        let content = crate::apple_llm::generate(prompt, transcript)?;
        if !content.is_empty() {
            let _ = app.emit("llm://delta", serde_json::json!({ "id": id, "delta": content }));
        }
        return Ok(crate::gateway::SummarizeOutput { content, tokens: None });
    }

    // Local GGUF sidecar: true per-token streaming (desktop only).
    #[cfg(desktop)]
    if let Some(file) = model.strip_prefix("local:") {
        let llm = app.state::<crate::local_llm::LlmState>();
        let content = crate::local_llm::generate_stream(
            app,
            &llm,
            file,
            prompt,
            transcript,
            max_tokens,
            cancel,
            |delta| {
                let _ = app.emit("llm://delta", serde_json::json!({ "id": id, "delta": delta }));
            },
        )?;
        return Ok(crate::gateway::SummarizeOutput { content, tokens: None });
    }

    // BYOK / OpenRouter: true SSE token streaming (the one lane that can carry a
    // vision frame).
    let _ = &app;
    crate::gateway::summarize_stream(
        transcript,
        prompt,
        model,
        api_key,
        max_tokens,
        image,
        cancel,
        |delta| {
            let _ = app.emit("llm://delta", serde_json::json!({ "id": id, "delta": delta }));
        },
    )
}

/// Stream a generation. Routes exactly like the blocking `summarize` command
/// (apple / local / BYOK), forwarding tokens as `llm://delta` events tagged with
/// `id`, and resolving with the full text + token count when done. The free lane
/// (signed-in proxy) is not routed here — the frontend streams it over SSE from
/// `/api/ai` directly.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub async fn stream_generate(
    app: AppHandle,
    id: String,
    transcript: String,
    prompt: String,
    model: String,
    api_key: String,
    max_tokens: Option<u32>,
    // Optional base64 `data:` URL for CP4 screen awareness. Carried only on the
    // BYOK/OpenRouter vision lane; ignored by local + Apple models.
    image: Option<String>,
    streams: State<'_, StreamRegistry>,
) -> Result<crate::gateway::SummarizeOutput, String> {
    let cancel = streams.register(&id);
    let app2 = app.clone();
    let id2 = id.clone();
    let out = tauri::async_runtime::spawn_blocking(move || {
        run_stream(
            &app2,
            &id2,
            &model,
            &prompt,
            &transcript,
            &api_key,
            max_tokens,
            image.as_deref(),
            &cancel,
        )
    })
    .await
    .map_err(|e| format!("stream task failed: {e}"));
    streams.done(&id);
    out?
}

/// Cancel an in-flight `stream_generate` (idempotent; unknown ids are ignored).
#[tauri::command]
pub fn cancel_generate(id: String, streams: State<'_, StreamRegistry>) {
    streams.cancel(&id);
}
