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

echo "=== 1/6 build $VERSION ($BUILD) ==="
xcodegen generate >/dev/null
xcodebuild -project BguruChat.xcodeproj -scheme BguruChat -configuration Release -destination "generic/platform=macOS" \
  -derivedDataPath "$DD" MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  clean build 2>&1 | grep -E " error:|BUILD (SUCCEEDED|FAILED)"

echo "=== 2/6 verify signature ==="
codesign --verify --deep --strict --verbose=2 "$APP"
INFO="$(codesign -dvv "$APP" 2>&1)"
echo "$INFO" | grep -q "Authority=Developer ID Application: .*($TEAM)" || { echo "not signed with Developer ID ($TEAM)" >&2; exit 1; }
echo "$INFO" | grep -q "flags=.*runtime" || { echo "hardened runtime missing" >&2; exit 1; }
echo "$INFO" | grep -q "Timestamp=" || { echo "secure timestamp missing" >&2; exit 1; }
# Release must not carry dev-only switches.
if strings "$APP/Contents/MacOS/B-guru Chat" | grep -q "BGURU_DEV_TOKEN"; then echo "dev token hook in release binary" >&2; exit 1; fi
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
