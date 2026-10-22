# Telemetry and network use

**Lalela Community sends no telemetry.** It has no analytics, no crash
reporting, no usage pings, no update checks and no account. Nothing is sent to
Auxo Digital or to any server we run.

This is enforced at build time, not by a setting: the Community edition
(`apps/desktop/edition/community.env`, read through
`apps/desktop/src/lib/edition.ts` and `apps/desktop/src-tauri/build.rs`) is
compiled without the hosted-service configuration, never creates a cloud
client, does not register the self-updater, and hides every cloud feature.

## Network requests the app can make

Every request below happens only because you started it or turned the feature
on. Your audio and voiceprints are never part of any of them.

| When | Where it goes | What is sent |
| --- | --- | --- |
| You download a speech or language model (first recording, first speaker separation, or Settings → AI models) | Hugging Face (`huggingface.co`) and GitHub release downloads (`github.com`) | A normal file download request. No meeting data. |
| You add your own OpenRouter key, pick a cloud model and allow cloud AI | OpenRouter (`openrouter.ai`), then the model provider you chose | The text of the prompt: the transcript or notes you asked about, and your question. Lalela asks before the first cloud request. |
| Optional, only if you build with your own `VITE_MS_CLIENT_ID` and connect a Microsoft account | Microsoft sign-in and Microsoft Graph (`login.microsoftonline.com`, `graph.microsoft.com`) | Your sign-in, then requests for your calendar events and Teams meeting transcripts. |
| You click a link (for example "Get a key at openrouter.ai") | Your web browser opens the page | Whatever your browser normally sends. |

Apple's on-device features (Apple Intelligence models, Apple Speech) run on
your Mac; macOS may download their language assets from Apple on its own.

Building from source fetches dependencies from crates.io, the npm registry and
GitHub (including the ONNX Runtime and sherpa-onnx libraries); that is your
build machine talking to package registries, not the app.

## What the official app does differently

The official Lalela app collects anonymous, allowlisted usage events (on by
default, can be turned off) and opt-in crash reports, as described in its
privacy policy at <https://lalela.auxodigital.africa/privacy>. None of that
code runs in the Community edition.

If you find a network request that is not listed here, please report it as a
bug.
