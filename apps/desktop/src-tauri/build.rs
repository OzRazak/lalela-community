use std::env;
use std::path::PathBuf;
use std::process::Command;

/// Absolute path of `src-tauri/swift/`.
///
/// Resolved from `CARGO_MANIFEST_DIR` at **run** time. It used to be `env!` —
/// baked in when the build-script binary was *compiled* — and that silently
/// broke releases: the build-script binary is cached in `CARGO_TARGET_DIR`,
/// which may be shared across checkouts, so a binary
/// compiled from one checkout kept looking for the Swift sources under that
/// checkout's path. When the path was gone, all six `swiftc` calls failed with
/// "error opening input file", each was downgraded to a `cargo:warning`, and
/// the build cheerfully produced an app with NO system-audio capture, meeting
/// auto-detect, screenshare capture, video slide extraction, or Apple AI.
/// Caught 2026-08-18 while cutting 1.3.3; see `assert_swift_helpers_built`.
fn swift_dir() -> PathBuf {
    PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR")).join("swift")
}

/// The Swift helpers degrade gracefully by design — an old toolchain without
/// `FoundationModels` should still build a working app, just without Apple AI.
/// A *missing source file* is a different animal: it can only mean the build
/// system is confused about where the repo is, and it disables features
/// silently. Fail loudly instead.
fn assert_swift_source_present(src: &PathBuf) {
    assert!(
        src.exists(),
        "Swift helper source missing: {}\n\
         This is a build-system fault, not a toolchain one — the repo path is wrong.\n\
         If CARGO_TARGET_DIR is shared across checkouts, run `touch build.rs` and rebuild.",
        src.display()
    );
}

fn main() {
    // So the bundled app can find the sherpa-onnx / onnxruntime dylibs that
    // scripts/bundle-mac.sh copies into Lalela.app/Contents/Frameworks.
    if cfg!(target_os = "macos") {
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
        // Also search next to the binary (covers `cargo run` / examples in target dir).
        println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path");
    }

    // iOS in-process Apple-Intelligence bridge (src/apple_bridge.rs): the Rust
    // STATICLIB the Xcode app links references the Swift `@_cdecl`
    // `lalela_apple_ai_request` / `_free` symbols, which AppleAIBridge.swift
    // provides at final APP-link time — a staticlib leaves them undefined until
    // then (fine). But `cargo build --lib` also links the *cdylib* byproduct,
    // and a dylib link demands every symbol resolve now, so it fails on these
    // two. Tell ld they're resolved later (allowed-undefined). `rustc-link-arg`
    // touches only linked artifacts (cdylib/bin), never the staticlib the app
    // actually uses; the cdylib itself is unused on iOS. Gate on the TARGET os
    // (`CARGO_CFG_TARGET_OS`) not `cfg!` (which reflects the macOS host), so
    // desktop/macOS builds are entirely unaffected.
    if env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("ios") {
        println!("cargo:rustc-link-arg=-Wl,-U,_lalela_apple_ai_request");
        println!("cargo:rustc-link-arg=-Wl,-U,_lalela_apple_ai_free");
    }

    configure_edition();
    build_system_audio_helper();
    build_detect_helper();
    build_window_helper();
    build_frames_helper();
    build_apple_llm_helper();
    build_apple_asr_helper();
    tauri_build::build()
}

/// Build edition (docs/OPEN-SOURCE.md) — the Rust half of the switch whose
/// frontend half is `vite.config.ts` + `src/lib/edition.ts`, using the SAME
/// rule so both always agree:
///   * `LALELA_EDITION=official|community` in the environment wins;
///   * else `../edition/official.env` existing ⇒ official (the private repo),
///     absent ⇒ community (the public export never ships that file).
///
/// Official: compiles the Supabase URL + publishable key in as
/// `LALELA_SUPABASE_URL` / `LALELA_SUPABASE_KEY` (read with `option_env!` in
/// cloud.rs) and FAILS the build when either is missing — never an official
/// binary that silently lacks cloud transcription.
/// Community: emits neither, plus `cfg(lalela_community)`, which keeps the
/// self-updater plugin unregistered (lib.rs). Real env vars beat the file.
fn configure_edition() {
    let edition_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"))
        .join("..")
        .join("edition");
    // Watch the directory (exists in both repos) rather than official.env,
    // which is absent in the public export — a missing rerun-if-changed path
    // would rerun this script (and every swiftc) on each build.
    println!("cargo:rerun-if-changed={}", edition_dir.display());
    println!("cargo:rerun-if-env-changed=LALELA_EDITION");
    println!("cargo:rerun-if-env-changed=VITE_SUPABASE_URL");
    println!("cargo:rerun-if-env-changed=VITE_SUPABASE_PUBLISHABLE_KEY");
    println!("cargo:rustc-check-cfg=cfg(lalela_community)");

    let official_file = edition_dir.join("official.env");
    let edition = match env::var("LALELA_EDITION").ok().as_deref().map(str::trim) {
        Some("official") => "official",
        Some("community") => "community",
        _ if official_file.exists() => "official",
        _ => "community",
    };
    check_identifier_matches_edition(edition);
    if edition == "community" {
        println!("cargo:rustc-cfg=lalela_community");
        return;
    }

    println!("cargo:rerun-if-changed={}", official_file.display());
    let file = std::fs::read_to_string(&official_file).unwrap_or_default();
    let lookup = |key: &str| -> Option<String> {
        if let Ok(v) = env::var(key) {
            if !v.trim().is_empty() {
                return Some(v.trim().to_string());
            }
        }
        file.lines()
            .filter_map(|l| l.split_once('='))
            .find(|(k, _)| k.trim() == key)
            .map(|(_, v)| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let url = lookup("VITE_SUPABASE_URL");
    let key = lookup("VITE_SUPABASE_PUBLISHABLE_KEY");
    match (url, key) {
        (Some(url), Some(key)) => {
            println!("cargo:rustc-env=LALELA_SUPABASE_URL={url}");
            println!("cargo:rustc-env=LALELA_SUPABASE_KEY={key}");
        }
        _ => panic!(
            "Official Lalela build is missing VITE_SUPABASE_URL / VITE_SUPABASE_PUBLISHABLE_KEY \
             (apps/desktop/edition/official.env). Set LALELA_EDITION=community to build the \
             local-only Community edition."
        ),
    }
}

/// The official app's bundle identifier (tauri.conf.json in the private repo).
const OFFICIAL_IDENTIFIER: &str = "digital.auxo.lalela";

/// Refuse edition/config mixes that would ship a broken or confusable app:
/// a Community binary under the official identifier (it would share the
/// official app's data folder), or an official binary built with the
/// Community config (no updater config while the updater plugin is
/// registered, which panics at launch).
///
/// The effective identifier is tauri.conf.json's, overridden by the
/// `--config` patch the tauri CLI passes to cargo in `TAURI_CONFIG` (inline
/// JSON). A mismatch is fatal when the tauri CLI drives the build (that is
/// what produces bundles). Plain `cargo check/test/run` never bundles, so it
/// only warns — which keeps `LALELA_EDITION=community cargo check` usable in
/// the private repo for compile checks.
fn check_identifier_matches_edition(edition: &str) {
    println!("cargo:rerun-if-env-changed=TAURI_CONFIG");
    let manifest = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("cargo sets CARGO_MANIFEST_DIR"));
    let base_path = manifest.join("tauri.conf.json");
    println!("cargo:rerun-if-changed={}", base_path.display());
    let identifier_of = |json: &str| -> Option<String> {
        serde_json::from_str::<serde_json::Value>(json)
            .ok()?
            .get("identifier")?
            .as_str()
            .map(str::to_string)
    };
    let base = std::fs::read_to_string(&base_path).ok().and_then(|s| identifier_of(&s));
    let cli_patch = env::var("TAURI_CONFIG").ok();
    let patched = cli_patch.as_deref().and_then(identifier_of);
    let Some(identifier) = patched.or(base) else { return };

    let official_id = identifier == OFFICIAL_IDENTIFIER;
    let mismatch = match edition {
        "community" if official_id => Some(format!(
            "Community edition with the official identifier {OFFICIAL_IDENTIFIER}: pass \
             --config src-tauri/tauri.community.conf.json (or build the official edition)."
        )),
        "official" if !official_id => Some(format!(
            "Official edition with identifier {identifier}: the official app must keep \
             {OFFICIAL_IDENTIFIER} and its updater config (drop the community --config, or set \
             LALELA_EDITION=community)."
        )),
        _ => None,
    };
    if let Some(msg) = mismatch {
        if cli_patch.is_some() || env::var_os("TAURI_ENV_PLATFORM").is_some() {
            panic!("Lalela edition/config mismatch. {msg}");
        }
        println!("cargo:warning=Lalela edition/config mismatch (fatal under the tauri CLI). {msg}");
    }
}

/// Compile the Swift Apple-Intelligence synthesis helper (macOS only); path
/// exposed via `LALELA_APPLE_LLM_BIN`. Empty if unavailable → the optional
/// `apple:` synthesis provider is simply absent (older toolchains lacking
/// FoundationModels fail to compile here, which is the graceful path). Needs
/// `-parse-as-library` because the helper uses `@main`.
fn build_apple_llm_helper() {
    let src = swift_dir().join("lalela-apple-llm.swift");
    assert_swift_source_present(&src);
    println!("cargo:rerun-if-changed={}", src.display());

    if !cfg!(target_os = "macos") {
        println!("cargo:rustc-env=LALELA_APPLE_LLM_BIN=");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let bin = out_dir.join("lalela-apple-llm");

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-O",
            "-parse-as-library",
            "-framework",
            "FoundationModels",
            "-framework",
            "Foundation",
        ])
        .arg(&src)
        .arg("-o")
        .arg(&bin)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:rustc-env=LALELA_APPLE_LLM_BIN={}", bin.display());
        }
        _ => {
            println!("cargo:warning=Could not compile lalela-apple-llm.swift; Apple Intelligence synthesis disabled.");
            println!("cargo:rustc-env=LALELA_APPLE_LLM_BIN=");
        }
    }
}

/// Compile the Swift Apple-Speech transcription helper (macOS only); path
/// exposed via `LALELA_APPLE_ASR_BIN`. Empty if unavailable → the optional
/// "Apple Speech (on-device)" ASR engine is simply absent (older toolchains
/// lacking the Speech 26 API fail to compile here, which is the graceful path).
/// Needs `-parse-as-library` because the helper uses `@main`.
fn build_apple_asr_helper() {
    let src = swift_dir().join("lalela-apple-asr.swift");
    assert_swift_source_present(&src);
    println!("cargo:rerun-if-changed={}", src.display());

    if !cfg!(target_os = "macos") {
        println!("cargo:rustc-env=LALELA_APPLE_ASR_BIN=");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let bin = out_dir.join("lalela-apple-asr");

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-O",
            "-parse-as-library",
            "-framework",
            "Speech",
            "-framework",
            "AVFoundation",
            "-framework",
            "CoreMedia",
            "-framework",
            "Foundation",
        ])
        .arg(&src)
        .arg("-o")
        .arg(&bin)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:rustc-env=LALELA_APPLE_ASR_BIN={}", bin.display());
        }
        _ => {
            println!("cargo:warning=Could not compile lalela-apple-asr.swift; Apple Speech transcription disabled.");
            println!("cargo:rustc-env=LALELA_APPLE_ASR_BIN=");
        }
    }
}

/// Compile the Swift video-frame helper (macOS only); path exposed via
/// `LALELA_FRAMES_BIN`. Empty if unavailable → video imports are audio-only.
fn build_frames_helper() {
    let src = swift_dir().join("lalela-frames.swift");
    assert_swift_source_present(&src);
    println!("cargo:rerun-if-changed={}", src.display());

    if !cfg!(target_os = "macos") {
        println!("cargo:rustc-env=LALELA_FRAMES_BIN=");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let bin = out_dir.join("lalela-frames");

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-O",
            "-framework",
            "AVFoundation",
            "-framework",
            "Vision",
            "-framework",
            "ImageIO",
            "-framework",
            "CoreGraphics",
            "-framework",
            "Foundation",
        ])
        .arg(&src)
        .arg("-o")
        .arg(&bin)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:rustc-env=LALELA_FRAMES_BIN={}", bin.display());
        }
        _ => {
            println!("cargo:warning=Could not compile lalela-frames.swift; video slide extraction disabled.");
            println!("cargo:rustc-env=LALELA_FRAMES_BIN=");
        }
    }
}

/// Compile the Swift meeting-window resolver (macOS only); path exposed via
/// `LALELA_WINDOW_BIN`. Empty if unavailable → screenshare auto-capture is
/// simply disabled (manual capture still works).
fn build_window_helper() {
    let src = swift_dir().join("lalela-window.swift");
    assert_swift_source_present(&src);
    println!("cargo:rerun-if-changed={}", src.display());

    if !cfg!(target_os = "macos") {
        println!("cargo:rustc-env=LALELA_WINDOW_BIN=");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let bin = out_dir.join("lalela-window");

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-O",
            "-framework",
            "CoreGraphics",
            "-framework",
            "AppKit",
            "-framework",
            "Foundation",
            "-framework",
            "ScreenCaptureKit",
        ])
        .arg(&src)
        .arg("-o")
        .arg(&bin)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:rustc-env=LALELA_WINDOW_BIN={}", bin.display());
        }
        _ => {
            println!("cargo:warning=Could not compile lalela-window.swift; screenshare auto-capture disabled.");
            println!("cargo:rustc-env=LALELA_WINDOW_BIN=");
        }
    }
}

/// Compile the Swift meeting-detector helper (macOS only); path exposed via
/// `LALELA_DETECT_BIN`. Empty if unavailable → auto-detect is simply disabled.
fn build_detect_helper() {
    let src = swift_dir().join("lalela-detect.swift");
    assert_swift_source_present(&src);
    println!("cargo:rerun-if-changed={}", src.display());

    if !cfg!(target_os = "macos") {
        println!("cargo:rustc-env=LALELA_DETECT_BIN=");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let bin = out_dir.join("lalela-detect");

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-O",
            "-framework",
            "CoreAudio",
            "-framework",
            "AppKit",
            "-framework",
            "Foundation",
        ])
        .arg(&src)
        .arg("-o")
        .arg(&bin)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:rustc-env=LALELA_DETECT_BIN={}", bin.display());
        }
        _ => {
            println!("cargo:warning=Could not compile lalela-detect.swift; meeting auto-detect disabled.");
            println!("cargo:rustc-env=LALELA_DETECT_BIN=");
        }
    }
}

/// Compile the Swift system-audio helper (macOS only) and expose its path to the
/// crate via the `LALELA_SYSAUDIO_BIN` env var. On non-macOS, or if swiftc is
/// unavailable, the var is left empty and system-audio capture is disabled at
/// runtime (mic-only still works).
fn build_system_audio_helper() {
    let src = swift_dir().join("lalela-systemaudio.swift");
    assert_swift_source_present(&src);
    println!("cargo:rerun-if-changed={}", src.display());

    if !cfg!(target_os = "macos") {
        println!("cargo:rustc-env=LALELA_SYSAUDIO_BIN=");
        return;
    }

    let out_dir = PathBuf::from(env::var("OUT_DIR").unwrap());
    let bin = out_dir.join("lalela-systemaudio");

    let status = Command::new("xcrun")
        .args([
            "swiftc",
            "-O",
            "-framework",
            "CoreAudio",
            "-framework",
            "AudioToolbox",
            "-framework",
            "Foundation",
        ])
        .arg(&src)
        .arg("-o")
        .arg(&bin)
        .status();

    match status {
        Ok(s) if s.success() => {
            println!("cargo:rustc-env=LALELA_SYSAUDIO_BIN={}", bin.display());
        }
        _ => {
            println!("cargo:warning=Could not compile lalela-systemaudio.swift; system-audio capture disabled.");
            println!("cargo:rustc-env=LALELA_SYSAUDIO_BIN=");
        }
    }
}
