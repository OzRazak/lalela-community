//! Lalela's local-LLM sidecar. Runs as a child process of the main app (which
//! cannot link llama.cpp itself: whisper-rs and llama-cpp-2 both vendor ggml
//! and collide at link time). Protocol: newline-delimited JSON on stdin/stdout.
//!
//!   {"op":"load","model_path":"…"}                      -> {"ok":true}
//!   {"op":"generate","system":"…","user":"…",
//!    "temperature":0.3,"max_tokens":2048}               -> {"ok":true,"content":"…"}
//!   {"op":"generate_stream", … same fields … }          -> {"delta":"…"}   (0..n)
//!                                                           {"ok":true,"done":true}
//!
//! `generate_stream` emits one `{"delta":"…"}` line per decoded piece as the
//! model produces it, then a single `{"ok":true,"done":true}` terminator (or a
//! `{"ok":false,"error":"…"}` line if it fails mid-generation). The blocking
//! `generate` op is byte-for-byte unchanged (summaries still use it) — both ops
//! share the same decode loop via `generate`'s `on_token` callback.
//!
//! Any failure yields {"ok":false,"error":"…"}. stderr is logs only. The
//! model stays loaded for the life of the process; the parent kills us to
//! unload (~4 GB RSS reclaimed).

use std::io::{BufRead, Write};
use std::num::NonZeroU32;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use serde::{Deserialize, Serialize};

/// Hard ceiling on the context we ask llama.cpp for; long transcripts are
/// middle-truncated to fit instead (see build_prompt).
const MAX_CTX: u32 = 32_768;
const DEFAULT_MAX_TOKENS: i32 = 2_048;
/// A single llama_decode call may not exceed n_batch tokens — llama.cpp
/// GGML_ASSERTs (aborting the process) rather than erroring. Prompts are fed
/// in chunks of this size.
const N_BATCH: usize = 2_048;

#[derive(Deserialize)]
struct Request {
    op: String,
    model_path: Option<String>,
    system: Option<String>,
    user: Option<String>,
    temperature: Option<f32>,
    max_tokens: Option<i32>,
}

#[derive(Serialize)]
struct Response {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    content: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

fn reply(out: &mut impl Write, resp: &Response) {
    let line = serde_json::to_string(resp).unwrap_or_else(|_| {
        r#"{"ok":false,"error":"response serialization failed"}"#.to_string()
    });
    let _ = writeln!(out, "{line}");
    let _ = out.flush();
}

fn ok(out: &mut impl Write, content: Option<String>) {
    reply(out, &Response { ok: true, content, error: None });
}

fn err(out: &mut impl Write, msg: impl Into<String>) {
    reply(out, &Response { ok: false, content: None, error: Some(msg.into()) });
}

/// Render the chat prompt. Prefers the chat template embedded in the GGUF
/// (works for any instruct model the catalog may add later); falls back to
/// the Gemma format, which matches the v1 catalog model.
fn build_prompt(model: &LlamaModel, system: &str, user: &str) -> String {
    // Gemma has no system role: prepend the system text to the user turn.
    // Doing this for every model keeps us template-agnostic.
    let merged = if system.is_empty() {
        user.to_string()
    } else {
        format!("{system}\n\n{user}")
    };
    if let Ok(tmpl) = model.chat_template(None) {
        if let Ok(msg) = LlamaChatMessage::new("user".into(), merged.clone()) {
            if let Ok(p) = model.apply_chat_template(&tmpl, &[msg], true) {
                let template_has_think = tmpl.to_string().map(|t| t.contains("<think>")).unwrap_or(false);
                return skip_thinking(p, template_has_think);
            }
        }
    }
    format!("<start_of_turn>user\n{merged}<end_of_turn>\n<start_of_turn>model\n")
}

/// Reasoning models whose chat template knows a `<think>` block (Qwen 3) spend
/// hundreds of tokens "thinking out loud" before answering, and that text would
/// land verbatim in summaries, notes and the model Test reply. Pre-fill an
/// EMPTY think block — exactly what Qwen's own template emits for
/// `enable_thinking=false` — so the model answers directly. No-op for every
/// other template, and when the prompt already ends inside a think block.
fn skip_thinking(prompt: String, template_has_think: bool) -> String {
    if !template_has_think || prompt.trim_end().ends_with("</think>") {
        return prompt;
    }
    format!("{prompt}<think>\n\n</think>\n\n")
}

#[cfg(test)]
mod tests {
    use super::skip_thinking;

    #[test]
    fn prefills_an_empty_think_block_only_for_thinking_templates() {
        let p = "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n".to_string();
        assert_eq!(skip_thinking(p.clone(), false), p);
        assert_eq!(
            skip_thinking(p.clone(), true),
            format!("{p}<think>\n\n</think>\n\n")
        );
        let done = format!("{p}<think>\n\n</think>");
        assert_eq!(skip_thinking(done.clone(), true), done);
    }
}

/// Decode a completion, invoking `on_token` with each freshly decoded piece as
/// it is produced (the blocking `generate` op passes a no-op; the streaming op
/// writes each piece out as a `{"delta":…}` line). Returns the full trimmed
/// string regardless — so the two ops share exactly one decode loop.
fn generate(
    backend: &LlamaBackend,
    model: &LlamaModel,
    system: &str,
    user: &str,
    temperature: f32,
    max_tokens: i32,
    mut on_token: impl FnMut(&str),
) -> Result<String, String> {
    let prompt = build_prompt(model, system, user);
    let mut tokens = model
        .str_to_token(&prompt, AddBos::Always)
        .map_err(|e| format!("tokenize failed: {e}"))?;

    // Middle-truncate transcripts that would overflow the context: keep the
    // head (instructions + opening) and the tail (most recent discussion).
    let budget = (MAX_CTX as usize).saturating_sub(max_tokens as usize + 16);
    if tokens.len() > budget {
        let keep_head = budget / 2;
        let keep_tail = budget - keep_head;
        let tail_start = tokens.len() - keep_tail;
        let mut truncated = tokens[..keep_head].to_vec();
        truncated.extend_from_slice(&tokens[tail_start..]);
        tokens = truncated;
        eprintln!("lalela-llm: prompt truncated to {} tokens", tokens.len());
    }

    let n_ctx = (tokens.len() as u32 + max_tokens as u32 + 16).min(MAX_CTX);
    let ctx_params = LlamaContextParams::default()
        .with_n_ctx(Some(NonZeroU32::new(n_ctx).ok_or("bad n_ctx")?))
        .with_n_batch(N_BATCH as u32);
    let mut ctx = model
        .new_context(backend, ctx_params)
        .map_err(|e| format!("context creation failed: {e}"))?;

    let mut batch = LlamaBatch::new(tokens.len().min(N_BATCH).max(512), 1);
    let last = tokens.len() - 1;
    for (chunk_idx, chunk) in tokens.chunks(N_BATCH).enumerate() {
        batch.clear();
        for (j, tok) in chunk.iter().enumerate() {
            let pos = chunk_idx * N_BATCH + j;
            batch
                .add(*tok, pos as i32, &[0], pos == last)
                .map_err(|e| format!("batch add failed: {e}"))?;
        }
        ctx.decode(&mut batch).map_err(|e| format!("decode failed: {e}"))?;
    }

    let mut sampler = LlamaSampler::chain_simple([
        LlamaSampler::temp(temperature),
        LlamaSampler::dist(42),
    ]);

    let mut out = String::new();
    // Streaming UTF-8 decoder: a multi-byte character can span two tokens.
    let mut decoder = encoding_rs::UTF_8.new_decoder();
    let mut n_cur = tokens.len() as i32;
    for _ in 0..max_tokens {
        let token = sampler.sample(&ctx, batch.n_tokens() - 1);
        if model.is_eog_token(token) {
            break;
        }
        let piece = model
            .token_to_piece(token, &mut decoder, false, None)
            .unwrap_or_default();
        if !piece.is_empty() {
            out.push_str(&piece);
            on_token(&piece);
        }
        batch.clear();
        batch
            .add(token, n_cur, &[0], true)
            .map_err(|e| format!("batch add failed: {e}"))?;
        n_cur += 1;
        ctx.decode(&mut batch).map_err(|e| format!("decode failed: {e}"))?;
    }
    Ok(out.trim().to_string())
}

fn main() {
    let stdin = std::io::stdin();
    let mut stdout = std::io::stdout();

    let backend = match LlamaBackend::init() {
        Ok(b) => b,
        Err(e) => {
            err(&mut stdout, format!("backend init failed: {e}"));
            return;
        }
    };
    let mut model: Option<LlamaModel> = None;

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(r) => r,
            Err(e) => {
                err(&mut stdout, format!("bad request: {e}"));
                continue;
            }
        };
        match req.op.as_str() {
            "load" => {
                let Some(path) = req.model_path else {
                    err(&mut stdout, "load: model_path required");
                    continue;
                };
                // Offload every layer to the GPU (Metal on macOS).
                let params = LlamaModelParams::default().with_n_gpu_layers(999);
                match LlamaModel::load_from_file(&backend, &path, &params) {
                    Ok(m) => {
                        model = Some(m);
                        ok(&mut stdout, None);
                    }
                    Err(e) => err(&mut stdout, format!("model load failed: {e}")),
                }
            }
            "generate" => {
                let Some(m) = model.as_ref() else {
                    err(&mut stdout, "generate before load");
                    continue;
                };
                let result = generate(
                    &backend,
                    m,
                    req.system.as_deref().unwrap_or(""),
                    req.user.as_deref().unwrap_or(""),
                    req.temperature.unwrap_or(0.3),
                    req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
                    |_| {},
                );
                match result {
                    Ok(content) => ok(&mut stdout, Some(content)),
                    Err(e) => err(&mut stdout, e),
                }
            }
            "generate_stream" => {
                let Some(m) = model.as_ref() else {
                    err(&mut stdout, "generate before load");
                    continue;
                };
                // Emit each decoded piece as its own {"delta":…} line, flushed
                // immediately so the parent forwards tokens the instant they land.
                // A fresh stdout handle inside the callback shares the same fd as
                // the main handle (single-threaded sidecar), so lines never split.
                let result = generate(
                    &backend,
                    m,
                    req.system.as_deref().unwrap_or(""),
                    req.user.as_deref().unwrap_or(""),
                    req.temperature.unwrap_or(0.3),
                    req.max_tokens.unwrap_or(DEFAULT_MAX_TOKENS),
                    |piece| {
                        let mut so = std::io::stdout();
                        let line = serde_json::to_string(&serde_json::json!({ "delta": piece }))
                            .unwrap_or_default();
                        let _ = writeln!(so, "{line}");
                        let _ = so.flush();
                    },
                );
                match result {
                    // Deltas already carried the text; the terminator just signals
                    // completion (the parent accumulates the deltas it forwarded).
                    Ok(_) => {
                        let _ = writeln!(stdout, r#"{{"ok":true,"done":true}}"#);
                        let _ = stdout.flush();
                    }
                    Err(e) => err(&mut stdout, e),
                }
            }
            other => err(&mut stdout, format!("unknown op: {other}")),
        }
    }
}
