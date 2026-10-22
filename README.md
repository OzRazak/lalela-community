# Lalela Community

Lalela is a privacy-first meeting notetaker for macOS. It records your meetings
from your own device (microphone plus system audio, no bot joins the call),
transcribes them on your machine, tells speakers apart, and turns the
transcript into notes, action items and answers.

This repository is **Lalela Community**: the open-source, local-only edition of
the Lalela desktop app, released under the [Apache License 2.0](LICENSE).

## The privacy promise

- **Audio, transcripts and voiceprints never leave your device.** Recording,
  transcription (whisper.cpp) and speaker separation (sherpa-onnx) all run
  locally. Voiceprints are biometric data and stay on this machine.
- **No account, no cloud, no telemetry.** The Community edition has no sign-in
  and no sync, and it sends nothing to Auxo Digital or anyone else. See
  [TELEMETRY.md](TELEMETRY.md) for the complete list of network requests the
  app can make (all of them started by you).
- **Your notes are plain files.** Every meeting is saved as Markdown in a folder
  you choose, with a local SQLite index for search.

AI summaries and chat run on an on-device model you download from Settings, or
on a cloud model through **your own** OpenRouter key. Lalela asks before
anything goes to a cloud model.

## Community edition vs the official app

Lalela Community is the same desktop codebase as the official app, built with
the hosted services switched off. The official app, from
[lalela.auxodigital.africa](https://lalela.auxodigital.africa), adds:

| Feature | Community | Official app |
| --- | --- | --- |
| Recording, on-device transcription, speaker separation | Yes | Yes |
| On-device AI models, bring-your-own OpenRouter key | Yes | Yes |
| Markdown export, DOCX export, local search, MCP server | Yes | Yes |
| Automations, workflows, folder rules (local actions) | Yes | Yes |
| Account, cloud sync across devices, web app | No | Yes |
| Team sharing, share links, teammates | No | Yes |
| Free monthly AI allowance | No | Yes |
| Cloud transcription | No | Yes |
| Sends to connected tools (CRM, delivery, product hub) | No | Yes |
| Outlook calendar and Teams transcripts | Only with your own Microsoft app registration | Yes |
| Automatic updates | No (pull and rebuild) | Yes |
| iPhone and iPad apps | No | Yes |

The [user guide](https://docs.auxodigital.africa/lalela) documents the official
app; everything in it about recording, transcription, notes, chat, workflows
and automations applies here too.

## Build from source

You need macOS 14.2 or later on Apple silicon, plus:

- Xcode (full Xcode, for the Metal shader compiler) and its command line tools
- [Rust](https://rustup.rs) (stable) and `rustup component add llvm-tools`
- Node.js 22 or later and [pnpm](https://pnpm.io) 11
- CMake (`brew install cmake`)

```sh
git clone https://github.com/OzRazak/lalela-community.git
cd lalela-community
pnpm install

# CMake 4 needs this for whisper.cpp's older CMake files
export CMAKE_POLICY_VERSION_MINIMUM=3.5

# Run in development (hot reload)
cd apps/desktop
pnpm tauri dev
```

To build a release app:

```sh
cd apps/desktop
pnpm tauri build
(cd src-tauri && cargo build --release --bin lalela-mcp)
LALELA_PRODUCT_NAME="Lalela Community" bash scripts/bundle-mac.sh
```

`bundle-mac.sh` copies the speech libraries into the app bundle (the app will
not launch without them), adds the MCP server and makes an ad-hoc signed DMG.
A locally built app is not notarized, so macOS asks you to allow it under
**System Settings → Privacy & Security** the first time.

The build reads `apps/desktop/edition/community.env`. You can set
`VITE_MS_CLIENT_ID` there to the client ID of your own Microsoft Entra app
registration to enable Outlook calendar and Teams transcript import.

More detail: [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) ·
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) · [docs/MCP.md](docs/MCP.md).

## Contributing

Bug fixes are welcome. New features need an issue that a maintainer has
approved first. Every commit must be signed off under the
[Developer Certificate of Origin](https://developercertificate.org). Read
[CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

Report security problems privately, as described in [SECURITY.md](SECURITY.md).

## Licence and trademarks

The code is licensed under the [Apache License 2.0](LICENSE); see
[NOTICE](NOTICE) and [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md) for
third-party components.

The licence does **not** cover the Lalela name, logo or app icons, or the Auxo
and Amp marks. You may build and use an unmodified copy for yourself, but if
you distribute a modified version you must give it a different name and icon.
See [TRADEMARKS.md](TRADEMARKS.md).

Copyright 2026 Auxo Digital Pty Ltd.
