#!/usr/bin/env bash
# B-guru Chat for iPhone/iPad → TestFlight.
#   native/ios/scripts/testflight.sh <版>            archive + upload to App Store Connect
#   native/ios/scripts/testflight.sh <版> --no-upload  archive only (check signing)
# Signing is automatic with the Apple ID signed in to Xcode (team F9349EVF2K).
# The app record must exist in App Store Connect (bundle id fm.backspace.bguru.chat).
set -euo pipefail
# Xcode's IPA step shells out to `rsync` and expects the system one; a Homebrew
# rsync earlier in PATH breaks it ("rsync error: syntax or usage error").
export PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH"
VERSION="${1:?usage: testflight.sh <版> [--no-upload]}"
UPLOAD=1
[ "${2:-}" = "--no-upload" ] && UPLOAD=0
BUILD="$(date +%Y%m%d%H%M)"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/../../mac"   # the shared project.yml lives in native/mac
OUT="$PWD/build/ios-archive"
ARCHIVE="$OUT/BguruChat-$VERSION-$BUILD.xcarchive"
mkdir -p "$OUT"

echo "=== 1/3 archive $VERSION ($BUILD) ==="
xcodegen generate >/dev/null
xcodebuild -project BguruChat.xcodeproj -scheme BguruChatiOS -configuration Release \
  -destination "generic/platform=iOS" -archivePath "$ARCHIVE" \
  MARKETING_VERSION="$VERSION" CURRENT_PROJECT_VERSION="$BUILD" \
  -allowProvisioningUpdates archive 2>&1 | grep -E " error:|ARCHIVE (SUCCEEDED|FAILED)|requires a provisioning|No profiles"

echo "=== 2/3 check ==="
APP="$ARCHIVE/Products/Applications/B-guru Chat.app"
[ -d "$APP/PlugIns/BguruChatNSE.appex" ] || { echo "NSE missing" >&2; exit 1; }
codesign -d --entitlements :- "$APP" 2>/dev/null | grep -A1 "aps-environment" | tail -1
if strings "$APP/B-guru Chat" | grep -q "BGURU_DEV_TOKEN"; then echo "dev token hook in release binary" >&2; exit 1; fi
echo "archive OK: $ARCHIVE"

if [ "$UPLOAD" -eq 0 ]; then echo "=== 3/3 skipped (--no-upload) ==="; exit 0; fi
echo "=== 3/3 upload to App Store Connect ==="
xcodebuild -exportArchive -archivePath "$ARCHIVE" -exportOptionsPlist "$SCRIPT_DIR/ExportOptions.plist" \
  -exportPath "$OUT/export-$BUILD" -allowProvisioningUpdates 2>&1 | grep -E "error|Upload|EXPORT|succeeded|failed" | tail -8
echo "uploaded $VERSION ($BUILD). TestFlight で処理が終わるまで数分〜30分ほどかかります。"
