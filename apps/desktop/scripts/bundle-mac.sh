#!/bin/bash
# Assemble a working, signed Lalela.app + DMG.
#
# Why this exists:
#  - sherpa-rs links libonnxruntime / libsherpa-onnx-* by @rpath; Tauri doesn't
#    copy them into the bundle, so the app crashes on launch without this.
#  - A checkout inside a cloud-synced folder can have files dehydrated/removed
#    mid-build (it has eaten the app binary and broken Tauri's bundle_dmg
#    step). So we stage the bundle in /tmp (outside the synced folder),
#    assemble + sign + DMG there, then copy the finished DMG back.
#
# LALELA_PRODUCT_NAME: the bundle's productName (default "Lalela"; the
# Community edition's tauri.community.conf.json builds "Lalela Community").
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PRODUCT="${LALELA_PRODUCT_NAME:-Lalela}"
# Honor CARGO_TARGET_DIR (we point it outside synced folders — see
# DEVELOPMENT.md); fall back to the in-tree target dir.
REL="${CARGO_TARGET_DIR:-$ROOT/src-tauri/target}/release"
SRCAPP="$REL/bundle/macos/$PRODUCT.app"
STAGE="/tmp/lalela-stage"
APP="$STAGE/$PRODUCT.app"
BIN="$APP/Contents/MacOS/lalela"
FW="$APP/Contents/Frameworks"
DMG_OUT="$REL/bundle/dmg/Lalela_0.1.0_aarch64.dmg"

echo "→ staging app in $STAGE (outside any synced folder)"
rm -rf "$STAGE"; mkdir -p "$STAGE"
cp -R "$SRCAPP" "$APP"

echo "→ ensuring main + MCP + local-LLM binaries"
cp -f "$REL/lalela" "$BIN"
[ -f "$REL/lalela-mcp" ] && cp -f "$REL/lalela-mcp" "$APP/Contents/MacOS/lalela-mcp"
# Local-LLM sidecar (separate workspace crate: llama.cpp can't link into the
# main app — ggml symbols collide with whisper-rs).
if [ ! -f "$REL/lalela-llm" ]; then
  echo "  building lalela-llm sidecar…"
  (cd "$ROOT/src-tauri" && cargo build --release -p lalela-llm)
fi
[ -f "$REL/lalela-llm" ] && cp -f "$REL/lalela-llm" "$APP/Contents/MacOS/lalela-llm"

# Tauri's bundler sometimes sets CFBundleExecutable to the wrong binary (lalela-mcp)
# when multiple bins exist, so the .app launches the headless MCP server and quits
# instantly. Force it to the GUI binary before signing (signature covers Info.plist).
PLIST="$APP/Contents/Info.plist"
if [ "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleExecutable' "$PLIST" 2>/dev/null)" != "lalela" ]; then
  echo "  ! correcting CFBundleExecutable → lalela"
  /usr/libexec/PlistBuddy -c "Set :CFBundleExecutable lalela" "$PLIST"
fi

echo "→ bundling Swift sidecar helpers (system audio + meeting detect)"
# build.rs compiles these into OUT_DIR (target/release/build/lalela-*/out). They
# must ship next to the main binary so system-audio capture (Phase 2) and
# meeting auto-detect (Phase 8) work in the distributed app, not just here.
for helper in lalela-systemaudio lalela-detect lalela-window lalela-frames lalela-apple-llm lalela-apple-asr; do
  src="$(ls -t "$REL"/build/*/out/"$helper" 2>/dev/null | head -1 || true)"
  if [ -n "${src:-}" ] && [ -f "$src" ]; then
    cp -f "$src" "$APP/Contents/MacOS/$helper"
  else
    echo "  ! warning: $helper not found in OUT_DIR; that feature won't work in the bundle"
  fi
done

echo "→ copying dylibs into Frameworks"
mkdir -p "$FW"
for lib in libsherpa-onnx-c-api.dylib libsherpa-onnx-cxx-api.dylib \
           libonnxruntime.1.17.1.dylib; do
  cp -f "$REL/$lib" "$FW/"
done
# onnxruntime ships under two names: the versioned real file
# (libonnxruntime.1.17.1.dylib) and an unversioned name (libonnxruntime.dylib)
# that sherpa resolves by @rpath. Ship the unversioned name as a RELATIVE SYMLINK
# to the versioned file instead of a second full copy: dyld follows the symlink,
# so both @rpath names resolve to the one real lib, and we save ~22 MB (after
# arm64 thinning) in the bundle and the OTA. The symlink MUST be created BEFORE
# thin_frameworks_to_arm64 (below) — that function skips symlinks and thins only
# the real versioned file the link points at. Guard: only symlink if the
# versioned file made it into Frameworks; otherwise fall back to a real copy so
# the app can still find the lib.
if [ -f "$FW/libonnxruntime.1.17.1.dylib" ]; then
  ln -sf libonnxruntime.1.17.1.dylib "$FW/libonnxruntime.dylib"
else
  cp -f "$REL/libonnxruntime.dylib" "$FW/"
fi

# Strip the dead x86_64 slice from every FAT dylib in Frameworks, leaving arm64.
#
# Why: every executable Lalela ships is arm64-only (all our own binaries are
# built for Apple Silicon), but sherpa/onnxruntime vendor FAT dylibs
# (x86_64 + arm64). On an Apple-Silicon-only app the x86_64 slices are pure dead
# weight — they roughly double the ~105 MB Frameworks/ dir and bloat the ~42 MB
# OTA updater download. Thinning them here shrinks both the install and the OTA
# (measured: Frameworks dylibs 105 MiB → 50 MiB, ~55 MiB saved on install).
#
# MUST run BEFORE code-signing (below): lipo rewrites the Mach-O, which
# invalidates any existing signature — so the signing step must see the thinned
# files. Defensive: only acts on files that exist and are actually fat, logs the
# before/after archs of each file it touches, and NEVER fails the build over a
# missing/odd file (log + continue).
#
# Symlink safety: the onnxruntime unversioned name is a symlink we create above
# (libonnxruntime.dylib -> libonnxruntime.1.17.1.dylib) to avoid a duplicate
# copy. We SKIP symlinks and thin only real files, so the versioned real file is
# thinned exactly once and the symlink keeps pointing at the (now-thinned)
# target. (If the guard above ever falls back to a real copy, that copy is a
# plain fat file and gets thinned here like any other.)
thin_frameworks_to_arm64() {
  local dir="$1" f archs mode
  echo "→ thinning fat dylibs in Frameworks to arm64 (Apple-Silicon-only app)"
  for f in "$dir"/*.dylib; do
    [ -e "$f" ] || continue                       # no glob matches / vanished → skip
    if [ -L "$f" ]; then
      echo "  · $(basename "$f") is a symlink → skip (its target is thinned directly)"
      continue
    fi
    archs="$(lipo -archs "$f" 2>/dev/null || true)"
    case " $archs " in
      *" x86_64 "*) ;;                            # fat, has an x86_64 slice → thin it
      *) continue ;;                              # already thin / not a fat Mach-O → leave alone
    esac
    echo "  · $(basename "$f"): before archs=[$archs] size=$(stat -f%z "$f" 2>/dev/null || echo '?')B"
    mode="$(stat -f '%Lp' "$f" 2>/dev/null || true)"   # capture original perms to restore
    if lipo "$f" -thin arm64 -output "$f.thin.tmp" 2>/dev/null; then
      [ -n "$mode" ] && chmod "$mode" "$f.thin.tmp" 2>/dev/null || true
      mv -f "$f.thin.tmp" "$f"
      echo "    → after  archs=[$(lipo -archs "$f" 2>/dev/null || echo '?')] size=$(stat -f%z "$f" 2>/dev/null || echo '?')B"
    else
      rm -f "$f.thin.tmp"
      echo "    ! lipo thin failed for $(basename "$f") — left fat, build continues"
    fi
  done
}
thin_frameworks_to_arm64 "$FW"

echo "→ ensuring rpath @executable_path/../Frameworks"
if ! otool -l "$BIN" | grep -q "@executable_path/../Frameworks"; then
  install_name_tool -add_rpath "@executable_path/../Frameworks" "$BIN"
fi

# Signing identity:
#  - default "-" = ad-hoc (runs locally; Gatekeeper warns).
#  - set LALELA_SIGN_IDENTITY="Developer ID Application: NAME (TEAMID)" for a
#    distributable, hardened-runtime, notarizable signature. See docs/NOTARIZATION.md.
IDENTITY="${LALELA_SIGN_IDENTITY:--}"
ENTITLEMENTS="$ROOT/src-tauri/entitlements.plist"

if [ "$IDENTITY" = "-" ]; then
  echo "→ re-signing (ad-hoc — set LALELA_SIGN_IDENTITY for a notarizable build)"
  RT_OPTS=()
else
  echo "→ signing with Developer ID + hardened runtime: $IDENTITY"
  RT_OPTS=(--options runtime --timestamp --entitlements "$ENTITLEMENTS")
fi

# Sign inner code first (dylibs + helper binaries), then the app last.
# Note the `${RT_OPTS[@]+...}` idiom: macOS ships bash 3.2, where expanding an
# empty array under `set -u` errors out.
codesign --force ${RT_OPTS[@]+"${RT_OPTS[@]}"} -s "$IDENTITY" "$FW"/*.dylib
for h in lalela-mcp lalela-llm lalela-systemaudio lalela-detect lalela-window lalela-frames lalela-apple-llm lalela-apple-asr; do
  [ -f "$APP/Contents/MacOS/$h" ] && codesign --force ${RT_OPTS[@]+"${RT_OPTS[@]}"} -s "$IDENTITY" "$APP/Contents/MacOS/$h"
done
codesign --force --deep ${RT_OPTS[@]+"${RT_OPTS[@]}"} -s "$IDENTITY" "$APP"

# Notarize in the Apple-recommended order: notarize the APP first and staple the
# ticket *into the app*, THEN build the DMG from that stapled app and notarize +
# staple the DMG. This way the .app the user actually runs is stapled (validates
# even offline once copied to /Applications) AND the .dmg carries its own ticket.
# Two auth methods (direct-key preferred — a keychain profile is unreadable if
# the Mac locks mid-build):
#  - Direct App Store Connect API key (robust, headless):
#      LALELA_NOTARY_KEY=/path/AuthKey_XXXX.p8 LALELA_NOTARY_KEY_ID=XXXX LALELA_NOTARY_ISSUER=uuid
#  - Keychain profile (once: xcrun notarytool store-credentials LALELA_NOTARY --key … --key-id … --issuer …):
#      LALELA_NOTARY_PROFILE=LALELA_NOTARY
NOTARY_AUTH=()
if [ -n "${LALELA_NOTARY_KEY:-}" ]; then
  NOTARY_AUTH=(--key "$LALELA_NOTARY_KEY" --key-id "${LALELA_NOTARY_KEY_ID:?set LALELA_NOTARY_KEY_ID}" --issuer "${LALELA_NOTARY_ISSUER:?set LALELA_NOTARY_ISSUER}")
elif [ -n "${LALELA_NOTARY_PROFILE:-}" ]; then
  NOTARY_AUTH=(--keychain-profile "$LALELA_NOTARY_PROFILE")
fi
NOTARIZE=0
if [ "$IDENTITY" != "-" ] && [ ${#NOTARY_AUTH[@]} -gt 0 ]; then NOTARIZE=1; fi

if [ "$NOTARIZE" = "1" ]; then
  echo "→ notarizing app (waits for Apple)…"
  APPZIP="$STAGE/Lalela.app.zip"
  ditto -c -k --keepParent "$APP" "$APPZIP"
  xcrun notarytool submit "$APPZIP" "${NOTARY_AUTH[@]}" --wait
  echo "→ stapling ticket into the app"
  xcrun stapler staple "$APP"
  xcrun stapler validate "$APP"
fi

echo "→ creating DMG (drag-to-Applications layout)"
DMGSRC="$STAGE/dmg"
rm -rf "$DMGSRC"; mkdir -p "$DMGSRC"
cp -R "$APP" "$DMGSRC/$PRODUCT.app"   # stapled app when notarizing
ln -s /Applications "$DMGSRC/Applications"
rm -f /tmp/Lalela.dmg
hdiutil create -volname "$PRODUCT" -srcfolder "$DMGSRC" -ov -format UDZO /tmp/Lalela.dmg >/dev/null

if [ "$NOTARIZE" = "1" ]; then
  echo "→ notarizing DMG (waits for Apple)…"
  xcrun notarytool submit /tmp/Lalela.dmg "${NOTARY_AUTH[@]}" --wait
  echo "→ stapling ticket into the DMG"
  xcrun stapler staple /tmp/Lalela.dmg
elif [ "$IDENTITY" != "-" ]; then
  echo "  (skipping notarization — set LALELA_NOTARY_PROFILE to enable)"
fi

mkdir -p "$(dirname "$DMG_OUT")"
cp -f /tmp/Lalela.dmg "$DMG_OUT"
cp -f /tmp/Lalela.dmg "$HOME/Desktop/Lalela.dmg" 2>/dev/null || true

echo "✓ done"
echo "  identity: $IDENTITY"
echo "  DMG: $DMG_OUT"
echo "  also: ~/Desktop/Lalela.dmg"
echo "  staged app (verified, outside synced folders): $APP"
