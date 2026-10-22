# Architecture

Lalela is a [Tauri 2](https://tauri.app) desktop app: a Rust backend
(`apps/desktop/src-tauri/`) handles audio, transcription, speaker separation,
storage, AI calls and an MCP server; a React + TypeScript frontend
(`apps/desktop/src/`) renders the UI. Everything is local-first.

```
┌──────────────────────────────────────────────────────────────┐
│ Frontend (React, TypeScript, Tailwind, Amp design system)     │
│ Meetings · Tasks · Chat · Knowledge · Automations · Settings  │
└───────────────▲──────────────────────────────┬───────────────┘
                │ Tauri commands / events       │
┌───────────────┴──────────────────────────────▼───────────────┐
│ Rust backend (src-tauri/src)                                  │
│ audio.rs, system_tap.rs     mic + system-audio capture        │
│ asr/, transcribe.rs         whisper.cpp behind AsrEngine      │
│ diarize.rs, speakers.rs     sherpa-onnx speaker separation    │
│ gateway.rs, local_llm.rs    OpenRouter (BYOK) + local sidecar │
│ store.rs, models.rs         SQLite index, Markdown, downloads │
│ bin/lalela-mcp.rs           read-only MCP server (stdio)      │
└───────────────┬──────────────────────────────────────────────┘
                │
       ┌────────▼─────────┐   ┌───────────────────────────────┐
       │ SQLite index      │   │ Markdown meeting folders      │
       │ (FTS5 search)     │   │ in the save folder you choose │
       └───────────────────┘   └───────────────────────────────┘
```

## Five binaries

| Binary | What it does |
| --- | --- |
| `lalela` | The app (GUI). |
| `lalela-mcp` | Read-only MCP server over stdio; see [MCP.md](MCP.md). |
| `lalela-llm` | Local language-model sidecar (`crates/lalela-llm`). |
| `lalela-systemaudio` | Swift helper for the Core Audio process tap. |
| `lalela-detect` | Swift helper that notices Zoom/Meet/Teams calls. |

**Why a separate LLM process:** `llama-cpp-2` and `whisper-rs` both vendor
ggml and cannot be linked into one binary. llama.cpp therefore runs in the
`lalela-llm` sidecar, which the app talks to with newline-delimited JSON over
stdio (`src/local_llm.rs`). Whisper stays in-process behind the `AsrEngine`
trait (`src/asr/`). Other Swift helpers (`swift/`) are compiled by `build.rs`.

## Audio capture

- **Microphone**: `cpal`, default input device, labelled "Me".
- **System audio**: a Core Audio process tap (macOS 14.2+) in the
  `lalela-systemaudio` helper, labelled "Others". On Windows, WASAPI loopback
  (`system_tap_win.rs`).
- Audio is discarded after transcription.

## Transcription and speakers

- **whisper.cpp** via `whisper-rs`, with Metal on Apple silicon. The model is
  downloaded on first use, not shipped in the binary.
- **Speaker separation**: sherpa-onnx (pyannote segmentation + a TitaNet speaker
  embedding). Voiceprints for named people are stored only on this device.

## AI

All AI goes through one frontend function, `aiGenerate` in
`src/lib/ai.ts`, which picks a route:

- **local** — an on-device model run by the `lalela-llm` sidecar;
- **apple** — Apple's on-device model where available (macOS 26+);
- **byok** — OpenRouter with the user's own key (Rust `gateway.rs` makes the
  request, so the key never touches the web view's network stack);
- **free** — the official app's hosted allowance (not in the Community
  edition).

Context assembly (workspace card, project brief) happens in the frontend.
Cloud routes ask for consent first (`src/lib/aiConsent.ts`).

## Storage

- SQLite (`lalela.db` in the app-data folder) is the index: meetings,
  transcripts, speakers, tags, tasks, automations and run history. Full-text
  search uses FTS5. There is no cloud vector store.
- Each meeting is also written as Markdown:
  `<save folder>/<Project>/<YYYY-MM-DD> <Title>/{summary.md, transcript.md, notes.md}`.
- `LALELA_DATA_DIR` relocates all data for testing (see
  [DEVELOPMENT.md](DEVELOPMENT.md)).

## Editions

The same source builds two editions; `src/lib/edition.ts` (frontend) and
`src-tauri/build.rs` (Rust) agree on which:

- **Community** (this repository): `edition/community.env`. No cloud client is
  created, cloud surfaces are hidden, the self-updater is not registered, and
  the bundle has its own name and identifier (`io.github.ozrazak.lalela-community`).
- **Official** (Auxo Digital's build): adds sign-in, sync, sharing, the free AI
  allowance, cloud transcription, analytics and updates through hosted services.

Code that would reach a hosted service either lives behind a signed-in session
(which never exists in Community) or checks `IS_COMMUNITY` /
`cfg(lalela_community)` at its entry point.
