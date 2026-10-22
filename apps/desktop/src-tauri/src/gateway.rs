//! LLM gateway. Routes summary/chat requests through a single interface.
//! Phase 3 ships the OpenRouter (BYOK) backend; local llama.cpp/Ollama plug in
//! behind the same `summarize` surface later.

use std::io::{BufRead, BufReader};
use std::time::Duration;

use serde::{Deserialize, Serialize};

#[derive(Serialize)]
struct ChatMessage {
    role: &'static str,
    /// A plain string for text-only messages, or an OpenAI-style multimodal
    /// content array (`[{type:"text"…},{type:"image_url"…}]`) when a vision
    /// frame is attached. A `Value::String` serializes to exactly the same wire
    /// bytes as the old `String` field, so text-only requests are unchanged.
    content: serde_json::Value,
}

/// The user message's `content`: a plain string, or — when the copilot attaches
/// a screenshot (CP4) — an OpenAI-style multimodal array carrying the text plus
/// an `image_url` (a base64 `data:` URL). Only vision-capable models are ever
/// sent an image (the caller gates on `isVisionModel`).
fn user_content(text: &str, image: Option<&str>) -> serde_json::Value {
    match image {
        Some(url) if !url.is_empty() => serde_json::json!([
            { "type": "text", "text": text },
            { "type": "image_url", "image_url": { "url": url } },
        ]),
        _ => serde_json::Value::String(text.to_string()),
    }
}

/// Claude 5.x rejects/drops `temperature`; omit it for those models only.
fn is_claude5(model: &str) -> bool {
    ["haiku", "sonnet", "opus"]
        .iter()
        .any(|f| model.starts_with(&format!("anthropic/claude-{f}-5")))
}

fn is_haiku5(model: &str) -> bool {
    model.starts_with("anthropic/claude-haiku-5")
}

fn is_adaptive5(model: &str) -> bool {
    is_haiku5(model) || model.starts_with("anthropic/claude-sonnet-5")
}

/// Haiku/Sonnet 5.x think adaptively and thinking tokens count toward `max_tokens`:
/// floor a supplied cap at 1024 (None stays None, the provider default).
fn effective_max_tokens(model: &str, max_tokens: Option<u32>) -> Option<u32> {
    match max_tokens {
        Some(n) if is_adaptive5(model) => Some(n.max(1024)),
        other => other,
    }
}

/// Short-answer calls (cap < 1024: Copilot overlay, Settings speed test) run
/// Haiku/Sonnet 5.x at low effort so thinking doesn't eat the visible answer.
fn reasoning_for(model: &str, max_tokens: Option<u32>) -> Option<serde_json::Value> {
    match max_tokens {
        Some(n) if is_adaptive5(model) && n < 1024 => Some(serde_json::json!({ "effort": "low" })),
        _ => None,
    }
}

fn temperature_for(model: &str) -> Option<f32> {
    if is_claude5(model) { None } else { Some(0.3) }
}

fn is_refusal_reason(r: &Option<String>) -> bool {
    matches!(r.as_deref().map(|s| s.to_ascii_lowercase()).as_deref(), Some("refusal") | Some("content_filter"))
}

/// Appended to a streamed answer that ended with a refusal (never a silent cut-off).
const REFUSAL_NOTE: &str =
    "\n\n— The model stopped early, so this answer may be cut short. Try again or pick another model.";

#[derive(Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    temperature: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    reasoning: Option<serde_json::Value>,
    /// Response cap (Wave A1). Omitted from the payload when None, so the
    /// legacy uncapped behaviour is byte-for-byte preserved.
    #[serde(skip_serializing_if = "Option::is_none")]
    max_tokens: Option<u32>,
}

#[derive(Deserialize)]
struct ChoiceMessage {
    content: String,
}

#[derive(Deserialize)]
struct Choice {
    message: ChoiceMessage,
}

#[derive(Deserialize)]
struct Usage {
    total_tokens: Option<u64>,
}

#[derive(Deserialize)]
struct ChatResponse {
    choices: Vec<Choice>,
    usage: Option<Usage>,
}

/// A generation plus the provider-reported token count (None for providers
/// or paths that don't report one, e.g. the local sidecar).
#[derive(Serialize)]
pub struct SummarizeOutput {
    pub content: String,
    pub tokens: Option<u64>,
}

const OPENROUTER_URL: &str = "https://openrouter.ai/api/v1/chat/completions";

/// App attribution headers OpenRouter shows on the key owner's dashboard. The
/// Community edition (`cfg(lalela_community)`, see build.rs) names its own
/// repository rather than the official app.
#[cfg(not(lalela_community))]
const APP_REFERER: &str = "https://auxo.digital";
#[cfg(not(lalela_community))]
const APP_TITLE: &str = "Lalela";
#[cfg(lalela_community)]
const APP_REFERER: &str = "https://github.com/OzRazak/lalela-community";
#[cfg(lalela_community)]
const APP_TITLE: &str = "Lalela Community";

/// Summarize a transcript with the given system prompt via OpenRouter.
/// `max_tokens` caps the response (Wave A1); None ⇒ the provider default.
/// `image` (CP4) is an optional base64 `data:` URL attached as a multimodal
/// `image_url` — None keeps the request byte-for-byte identical to the legacy
/// text-only path.
pub fn summarize(
    transcript: &str,
    prompt: &str,
    model: &str,
    api_key: &str,
    max_tokens: Option<u32>,
    image: Option<&str>,
) -> Result<SummarizeOutput, String> {
    if api_key.trim().is_empty() {
        return Err("No API key set. Add your OpenRouter key in Settings.".into());
    }
    if transcript.trim().is_empty() {
        return Err("Nothing to summarize — the transcript is empty.".into());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let body = ChatRequest {
        model: model.to_string(),
        messages: vec![
            ChatMessage {
                role: "system",
                content: serde_json::Value::String(prompt.to_string()),
            },
            ChatMessage {
                role: "user",
                content: user_content(transcript, image),
            },
        ],
        temperature: temperature_for(model),
        reasoning: reasoning_for(model, max_tokens),
        max_tokens: effective_max_tokens(model, max_tokens),
    };

    let resp = client
        .post(OPENROUTER_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("HTTP-Referer", APP_REFERER)
        .header("X-Title", APP_TITLE)
        .json(&body)
        .send()
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    let text = resp.text().map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("model provider error ({status}): {text}"));
    }

    let parsed: ChatResponse =
        serde_json::from_str(&text).map_err(|e| format!("could not parse response: {e}"))?;
    let tokens = parsed.usage.and_then(|u| u.total_tokens);
    parsed
        .choices
        .into_iter()
        .next()
        .map(|c| SummarizeOutput {
            content: c.message.content,
            tokens,
        })
        .ok_or_else(|| "the model returned no content".into())
}

// ---------------------------------------------------------------------------
// Streaming (CP0) — SSE variant of `summarize` for the BYOK/OpenRouter lane.
// ---------------------------------------------------------------------------

/// One SSE chunk from OpenRouter's `stream:true` response.
#[derive(Deserialize)]
struct StreamChunk {
    #[serde(default)]
    choices: Vec<StreamChoice>,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct StreamChoice {
    #[serde(default)]
    delta: StreamDelta,
    #[serde(default)]
    finish_reason: Option<String>,
    #[serde(default)]
    native_finish_reason: Option<String>,
}

#[derive(Deserialize, Default)]
struct StreamDelta {
    #[serde(default)]
    content: Option<String>,
}

/// Streaming `summarize`: opens an SSE (`stream:true`) request to OpenRouter and
/// forwards each `delta.content` piece to `on_delta` as it arrives, returning
/// the full text plus the provider-reported token count (from the final usage
/// chunk — requested via `stream_options.include_usage`; `None` if the provider
/// omits it). Uses the blocking client's response as a `Read` and parses the
/// SSE line-protocol by hand (no async/stream reqwest feature needed).
///
/// Cancellation: `cancel` is polled between forwarded lines; on cancel the
/// response (and its socket) is dropped and the partial text returned.
pub fn summarize_stream(
    transcript: &str,
    prompt: &str,
    model: &str,
    api_key: &str,
    max_tokens: Option<u32>,
    image: Option<&str>,
    cancel: &std::sync::atomic::AtomicBool,
    mut on_delta: impl FnMut(&str),
) -> Result<SummarizeOutput, String> {
    use std::sync::atomic::Ordering;

    if api_key.trim().is_empty() {
        return Err("No API key set. Add your OpenRouter key in Settings.".into());
    }
    if transcript.trim().is_empty() {
        return Err("Nothing to summarize — the transcript is empty.".into());
    }

    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    let mut body = serde_json::json!({
        "model": model,
        "stream": true,
        "stream_options": { "include_usage": true },
        "messages": [
            { "role": "system", "content": prompt },
            { "role": "user", "content": user_content(transcript, image) },
        ],
    });
    if let Some(t) = temperature_for(model) {
        body["temperature"] = serde_json::json!(t);
    }
    if let Some(r) = reasoning_for(model, max_tokens) {
        body["reasoning"] = r;
    }
    if let Some(m) = effective_max_tokens(model, max_tokens) {
        body["max_tokens"] = serde_json::json!(m);
    }

    let resp = client
        .post(OPENROUTER_URL)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("HTTP-Referer", APP_REFERER)
        .header("X-Title", APP_TITLE)
        .header("Accept", "text/event-stream")
        .json(&body)
        .send()
        .map_err(|e| format!("request failed: {e}"))?;

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().unwrap_or_default();
        return Err(format!("model provider error ({status}): {text}"));
    }

    let mut reader = BufReader::new(resp);
    let mut full = String::new();
    let mut tokens: Option<u64> = None;
    let mut refused = false;
    let mut line = String::new();
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Ok(SummarizeOutput { content: full, tokens });
        }
        line.clear();
        let n = reader
            .read_line(&mut line)
            .map_err(|e| format!("stream read failed: {e}"))?;
        if n == 0 {
            break; // upstream closed the connection
        }
        let l = line.trim();
        if l.is_empty() || !l.starts_with("data:") {
            continue;
        }
        let data = l["data:".len()..].trim();
        if data == "[DONE]" {
            break;
        }
        // Tolerate the odd unparseable keep-alive / comment line.
        if let Ok(chunk) = serde_json::from_str::<StreamChunk>(data) {
            if let Some(choice) = chunk.choices.into_iter().next() {
                if is_refusal_reason(&choice.finish_reason) || is_refusal_reason(&choice.native_finish_reason) {
                    refused = true;
                }
                if let Some(c) = choice.delta.content {
                    if !c.is_empty() {
                        full.push_str(&c);
                        on_delta(&c);
                    }
                }
            }
            if let Some(u) = chunk.usage.and_then(|u| u.total_tokens) {
                tokens = Some(u);
            }
        }
    }
    if refused {
        full.push_str(REFUSAL_NOTE);
        on_delta(REFUSAL_NOTE);
    }
    Ok(SummarizeOutput { content: full, tokens })
}

#[cfg(test)]
mod tests {
    use super::*;

    const H5: &str = "anthropic/claude-haiku-5.5";
    const H45: &str = "anthropic/claude-haiku-4.5";

    #[test]
    fn temperature_only_for_non_claude5() {
        assert_eq!(temperature_for(H5), None);
        assert_eq!(temperature_for("anthropic/claude-sonnet-5.5"), None);
        assert_eq!(temperature_for(H45), Some(0.3));
        assert_eq!(temperature_for("openai/gpt-4o-mini"), Some(0.3));
    }

    #[test]
    fn max_tokens_floor_for_adaptive5() {
        assert_eq!(effective_max_tokens(H5, Some(160)), Some(1024));
        assert_eq!(effective_max_tokens(H5, Some(48)), Some(1024));
        assert_eq!(effective_max_tokens(H5, Some(4096)), Some(4096));
        assert_eq!(effective_max_tokens(H5, None), None);
        assert_eq!(effective_max_tokens(H45, Some(160)), Some(160));
        assert_eq!(effective_max_tokens("anthropic/claude-sonnet-5.5", Some(160)), Some(1024));
    }

    #[test]
    fn low_effort_for_short_adaptive5_calls() {
        assert_eq!(reasoning_for(H5, Some(160)), Some(serde_json::json!({ "effort": "low" })));
        assert_eq!(reasoning_for(H5, Some(2048)), None);
        assert_eq!(reasoning_for(H5, None), None);
        assert_eq!(reasoning_for(H45, Some(160)), None);
        assert_eq!(reasoning_for("anthropic/claude-sonnet-5.5", Some(160)), Some(serde_json::json!({ "effort": "low" })));
    }

    #[test]
    fn refusal_reasons() {
        assert!(is_refusal_reason(&Some("refusal".into())));
        assert!(is_refusal_reason(&Some("Content_Filter".into())));
        assert!(!is_refusal_reason(&Some("stop".into())));
        assert!(!is_refusal_reason(&None));
    }

    #[test]
    fn request_omits_temperature_for_claude5() {
        let body = ChatRequest {
            model: H5.into(),
            messages: vec![],
            temperature: temperature_for(H5),
            reasoning: reasoning_for(H5, Some(160)),
            max_tokens: effective_max_tokens(H5, Some(160)),
        };
        let v = serde_json::to_value(&body).unwrap();
        assert!(v.get("temperature").is_none());
        assert_eq!(v["max_tokens"], 1024);
        assert_eq!(v["reasoning"]["effort"], "low");
    }
}
