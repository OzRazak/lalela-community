# Development guide

## Toolchain

- macOS 14.2 or later on Apple silicon (the supported platform).
- **Xcode** (the full app, not only the command line tools) for the Metal
  shader compiler used by whisper.cpp. If a build stops with
  `cannot execute tool 'metal' … missing Metal Toolchain`, run
  `xcodebuild -downloadComponent MetalToolchain` once.
- **Rust** stable via rustup, plus `rustup component add llvm-tools` (swift-rs
  needs `llvm-objcopy`) and, for the iOS check, `rustup target add aarch64-apple-ios`.
- **Node.js** 22+ and **pnpm** 11.
- **CMake** (`brew install cmake`). CMake 4 rejects whisper.cpp's old minimum
  version, so export `CMAKE_POLICY_VERSION_MINIMUM=3.5`.

A convenient shell setup:

```sh
export CMAKE_POLICY_VERSION_MINIMUM=3.5
# Optional: keep Rust build output outside the checkout (useful if the
# checkout lives in a cloud-synced folder, which can corrupt build artifacts).
export CARGO_TARGET_DIR="$HOME/lalela-target"
```

## Layout

```
apps/desktop/
  src/                 React + TypeScript frontend
    lib/edition.ts     the Community / official edition switch
  amp/                 Amp design system (vendored)
  edition/             build configuration (community.env)
  src-tauri/
    src/               Rust backend (see docs/ARCHITECTURE.md)
    crates/            lalela-llm (local LLM sidecar), lalela-asr
    swift/             macOS helpers, compiled by build.rs
    vendor/            patched tao and swift-rs (see their READMEs)
    tests/             gold-set and audio-import tests
    gen/apple, gen/android   mobile projects (see "Mobile" below)
```

## Run

```sh
pnpm install                    # once, at the repository root
cd apps/desktop
pnpm tauri dev                  # hot reload
```

The first recording downloads the Whisper model (about 142 MB); the first
speaker separation downloads two small ONNX models. They go to the app-data
folder (`~/Library/Application Support/io.github.ozrazak.lalela-community/models`).

## Checks (what CI runs)

```sh
pnpm typecheck                  # frontend tsc
pnpm test                       # frontend unit tests (node --test)
cd apps/desktop/src-tauri
cargo test --workspace          # Rust unit + gold-set tests
cargo check --target aarch64-apple-ios
```

The gold-set targets are `gold_speakers`, `gold_imports` and `audio_import`.

## Release build

```sh
cd apps/desktop
pnpm tauri build                # its DMG step may fail; that is cosmetic
(cd src-tauri && cargo build --release --bin lalela-mcp)
LALELA_PRODUCT_NAME="Lalela Community" bash scripts/bundle-mac.sh
```

`bundle-mac.sh` stages the app in `/tmp`, copies the sherpa-onnx and ONNX
Runtime dylibs into `Contents/Frameworks` (without them the app crashes at
launch), adds `lalela-mcp`, signs ad hoc and writes a DMG. Set
`LALELA_SIGN_IDENTITY` to sign with your own Developer ID.

An ad-hoc signed app is not notarized: allow it once under System Settings →
Privacy & Security. Screen Recording and microphone permissions may need to be
granted again after each rebuild, because the ad-hoc signature changes.

## Isolated test data (`LALELA_DATA_DIR`)

Set `LALELA_DATA_DIR` to run with a throwaway data folder (database, models,
logs and the Markdown save folder all move there):

```sh
LALELA_DATA_DIR=$HOME/lalela-demo-data pnpm tauri dev
```

Seed it with six fictional meetings, tags, automations and tasks:

```sh
cd apps/desktop/src-tauri
LALELA_DATA_DIR=$HOME/lalela-demo-data cargo run --example seed_demo
```

## Editions

`vite.config.ts` and `src-tauri/build.rs` read `edition/community.env`. Values
in your environment override the file. `LALELA_EDITION=official` exists for
the official build and needs hosted-service configuration that is not part of
this repository; leave it unset.

Optional: set `VITE_MS_CLIENT_ID` (in `edition/community.env` or your
environment) to the client ID of your own Microsoft Entra app registration — a
public client with redirect URI `http://localhost` and the delegated
permissions `User.Read`, `Calendars.Read`, `OnlineMeetings.Read` and
`OnlineMeetingTranscript.Read.All` — to enable Outlook calendar and Teams
transcript import.

## Mobile

`gen/apple` and `gen/android` are the Tauri mobile projects of the official
app, included so the Rust code that targets iOS and Android stays checkable
(`cargo check --target aarch64-apple-ios`). They still carry the official
bundle identifier and no signing team. Building the iOS or Android app from
this repository is not supported; if you try, set your own identifier and team
first (`pnpm tauri ios init` regenerates the Xcode project).

## Gotchas

1. Native file dialogs must run on the macOS main thread (`run_on_main_thread`
   in `commands.rs`).
2. Simulator builds do not prove that a release device build launches; tao is
   vendored with a patch for exactly that (see `vendor/README.md`).
3. If `cargo add` does not update `Cargo.toml`, edit it by hand.
4. If you share one `CARGO_TARGET_DIR` between checkouts and a build cannot find
   `swift/*.swift`, run `touch src-tauri/build.rs` and rebuild.
