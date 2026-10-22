# vendor/

## swift-rs (1.0.8 + one patch)

Upstream swift-rs 1.0.8 builds tauri's Swift packages on Xcode 27 and promotes
each package's own `@_cdecl` exports back to global (Xcode 27's SwiftPM makes
them local). It does not promote swift-rs's **own** runtime exports
(`retain_object`, `release_object`, `string_from_bytes`, …) in the `SwiftRs.o`
member every package archive embeds. A release iOS link then fails with those
as undefined symbols.

The patch (`src-rs/build.rs`, marked `LALELA PATCH`) also promotes the `SwiftRs.o`
exports, but only in the core `Tauri` package archive. Every Tauri app links it
exactly once, so there is a single global definition and the plugin copies stay
local (promoting them everywhere makes Xcode 27's ld fail on duplicates).

Needs rustup's `llvm-tools` component (`rustup component add llvm-tools`) for
`llvm-objcopy`; without it swift-rs only prints a cargo warning.

Drop this vendor copy and the `[patch.crates-io]` entry in `Cargo.toml` once an
upstream swift-rs release handles it.

## tao (0.35.3 + one patch)

tao 0.35.3's `application:configurationForConnectingSceneSession:options:`
(`src/platform_impl/ios/view.rs`, marked `LALELA PATCH`) returned
`Retained::as_ptr(&config)` and then dropped `config`, so UIKit received a freed
`UISceneConfiguration`. Debug and simulator builds survived by luck (the object
sat in an autorelease pool); the release build crashed on every device launch
(`EXC_BAD_ACCESS` in `objc_retain` under `-[UIApplication
_connectUISceneFromFBSScene:transitionContext:]`, TestFlight 1.3.10,
2026-10-08). The patch returns `Retained::autorelease_ptr(config)`, which is
exactly upstream tao 0.37's fix.

The method is only installed when Info.plist enables a scene manifest, which
Xcode 27 / iOS 27 requires (see `docs/DEVELOPMENT.md` "iOS on Xcode 27").

Drop this vendor copy and its `[patch.crates-io]` entry when wry/tauri move to
tao ≥ 0.37.
