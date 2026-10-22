#!/usr/bin/env bash
# B-guru Chat for Mac — release build: sign (Developer ID) → DMG → notarize → staple → verify.
#
#   native/mac/scripts/release.sh 0.1.0            # full release (needs the "notary" keychain profile)
#   native/mac/scripts/release.sh 0.1.0 --no-notarize   # signed DMG only (local check)
#
# One-time setup (Account Holder): Developer ID Application certificate in the
# login keychain, and `xcrun notarytool store-credentials notary`.
set -euo pipefail

VERSION="${1:?usage: release.sh VERSION [--no-notarize]}"
NOTARIZE=1
[ "${2:-}" = "--no-notarize" ] && NOTARIZE=0
BUILD="$(date +%Y%m%d%H%M)"
TEAM="F9349EVF2K"

cd "$(dirname "$0")/.."
ROOT="$(pwd)"
OUT="$ROOT/dist"
DD="$ROOT/build/release"
APP="$DD/Build/Products/Release/B-guru Chat.app"
DMG="$OUT/BguruChat-$VERSION.dmg"
mkdir -p "$OUT"

# Upside-down guard (2026-10-19 / 10-21 regressions): draw every screen of the offline demo in a Debug build
# and read it with Vision; a screen that reads better flipped fails the release. SKIP_ORIENTATION=1 skips it.
if [ "${SKIP_ORIENTATION:-0}" != "1" ]; then
  echo "=== 0/6 orientation check (Debug, offline demo) ==="
  xcodegen generate >/dev/null
  xcodebuild -project BguruChat.xcodeproj -scheme BguruChat -configuration Debug -derivedDataPath "$ROOT/build/orient" build -quiet
  ORIENT_OUT="$HOME/Library/Containers/fm.backspace.bguru.chat/Data/tmp/orientation"
  if ! "$ROOT/build/orient/Build/Products/Debug/B-guru Chat.app/Contents/MacOS/B-guru Chat" \
      -selftest "$ORIENT_OUT" -demo -demoJukebox -orientation; then
    echo "ORIENTATION CHECK FAILED: a screen is drawn upside down (see $ORIENT_OUT). Not releasing." >&2
    exit 1
  fi
  # Freeze guard (2026-10-21/22: the panel froze with a thread open): refresh the timeline 10 times with a thread
  # open (list at the top / scrolled down, short / long thread), then open a thread with 300 replies, scroll it to
  # the top and back, close and reopen it; fails if the main thread stops answering for 5 s. Offline demo, nothing sent.
  echo "=== 0/6 long-thread check (Debug, offline demo) ==="
  THREAD_OUT="$HOME/Library/Containers/fm.backspace.bguru.chat/Data/tmp/threadcheck"
  if ! "$ROOT/build/orient/Build/Products/Debug/B-guru Chat.app/Contents/MacOS/B-guru Chat" \
      -selftest "$THREAD_OUT" -demo -threadCheck -demoReplies 300; then
    echo "LONG-THREAD CHECK FAILED: the app stopped responding with a long thread open (see $THREAD_OUT and hangs.log). Not releasing." >&2
    exit 1
  fi
  defaults delete fm.backspace.bguru.chat panelNarrowed20261019 2>/dev/null || true
  for k in jukebox.last jukebox.progress jukebox.finished; do defaults delete fm.backspace.bguru.chat "$k" 2>/dev/null || true; done
fi

echo "=== 1/6 build $VERSION ($BUILD) ==="
xcodegen generate >/dev/null
xcodebuild -project BguruChat.xcodeproj -scheme BguruChat -configuration Release -destination "generic/platform=macOS" \
  -derivedDataPath "$DD" MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  clean build 2>&1 | grep -E " error:|BUILD (SUCCEEDED|FAILED)"

echo "=== 1b/6 re-sign Sparkle (nested code must carry our Developer ID for notarization) ==="
ID="Developer ID Application: Kohichi Aoki ($TEAM)"
FW="$APP/Contents/Frameworks/Sparkle.framework"
if [ -d "$FW" ]; then
  V="$FW/Versions/B"
  codesign -f -s "$ID" -o runtime --timestamp "$V/XPCServices/Installer.xpc"
  codesign -f -s "$ID" -o runtime --timestamp --preserve-metadata=entitlements "$V/XPCServices/Downloader.xpc"
  codesign -f -s "$ID" -o runtime --timestamp "$V/Autoupdate"
  codesign -f -s "$ID" -o runtime --timestamp "$V/Updater.app"
  codesign -f -s "$ID" -o runtime --timestamp "$FW"
  codesign -f -s "$ID" -o runtime --timestamp --entitlements BguruChat/BguruChat.entitlements "$APP"
  echo "Sparkle re-signed"
fi

echo "=== 2/6 verify signature ==="
codesign --verify --deep --strict --verbose=2 "$APP"
INFO="$(codesign -dvv "$APP" 2>&1)"
echo "$INFO" | grep -q "Authority=Developer ID Application: .*($TEAM)" || { echo "not signed with Developer ID ($TEAM)" >&2; exit 1; }
echo "$INFO" | grep -q "flags=.*runtime" || { echo "hardened runtime missing" >&2; exit 1; }
echo "$INFO" | grep -q "Timestamp=" || { echo "secure timestamp missing" >&2; exit 1; }
# Release must not carry dev-only switches.
if strings "$APP/Contents/MacOS/B-guru Chat" | grep -q "BGURU_DEV_"; then echo "dev token hook in release binary" >&2; exit 1; fi
ARCHS_BUILT="$(lipo -archs "$APP/Contents/MacOS/B-guru Chat")"
case "$ARCHS_BUILT" in *arm64*x86_64*|*x86_64*arm64*) ;; *) echo "not universal: $ARCHS_BUILT" >&2; exit 1 ;; esac
echo "signature OK (Developer ID, hardened runtime, timestamp, no dev hooks, universal: $ARCHS_BUILT)"

echo "=== 3/6 DMG ==="
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/bguru-dmg.XXXXXX")"
ditto "$APP" "$STAGE/B-guru Chat.app"
ln -s /Applications "$STAGE/Applications"
rm -f "$DMG"
hdiutil create -volname "B-guru Chat" -srcfolder "$STAGE" -ov -format UDZO "$DMG" >/dev/null
codesign --sign "Developer ID Application: Kohichi Aoki ($TEAM)" --timestamp "$DMG"
echo "$DMG"

if [ "$NOTARIZE" -eq 0 ]; then
  echo "=== 4-6/6 skipped (--no-notarize) ==="
  shasum -a 256 "$DMG"
  exit 0
fi

echo "=== 4/6 notarize (waits for Apple) ==="
xcrun notarytool submit "$DMG" --keychain-profile notary --wait

echo "=== 5/6 staple ==="
xcrun stapler staple "$DMG"

echo "=== 6/6 Gatekeeper check ==="
spctl --assess --type open --context context:primary-signature --verbose=2 "$DMG"
shasum -a 256 "$DMG"
echo "release OK: $DMG"
