#!/usr/bin/env bash
# Upside-down check of the iPhone app in the simulator (run before testflight.sh).
#
#   native/ios/scripts/orientation-check.sh [SIMULATOR_UDID] [OUT_DIR]
#
# Builds the Debug app for the simulator, opens it with offline demo data (BGURU_DEMO=1: no
# token, nothing sent) on each screen — chat, timeline, jukebox playing, ☗, 🎮, light and
# dark — takes a screenshot of each and reads them with native/mac/scripts/orientation-check.swift.
# Exit 0 = every screen upright. Default simulator: the first booted iPhone.
set -euo pipefail
cd "$(dirname "$0")/../../mac"
ROOT="$(pwd)"
UDID="${1:-$(xcrun simctl list devices booted | grep -m1 -oE '[0-9A-F-]{36}')}"
OUT="${2:-$(mktemp -d -t bguru-ios-orientation)}"
mkdir -p "$OUT"
[ -n "$UDID" ] || { echo "no booted simulator" >&2; exit 2; }
xcodegen generate >/dev/null
xcodebuild -project BguruChat.xcodeproj -scheme BguruChatiOS -configuration Debug -destination "id=$UDID" \
  -derivedDataPath build/ddios build 2>&1 | grep -E " error:|BUILD (SUCCEEDED|FAILED)"
xcrun simctl install "$UDID" "build/ddios/Build/Products/Debug-iphonesimulator/B-guru Chat.app"

MEDIA="$(mktemp -d -t bguru-media)"
command -v ffmpeg >/dev/null && ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=60" -ac 1 -b:a 64k "$MEDIA/tone.mp3" || true
( cd "$MEDIA" && exec python3 -m http.server 8098 --bind 127.0.0.1 >/dev/null 2>&1 ) &
SERVER=$!
APPEARANCE="$(xcrun simctl ui "$UDID" appearance)"
cleanup() {
  kill "$SERVER" 2>/dev/null || true
  xcrun simctl terminate "$UDID" fm.backspace.bguru.chat 2>/dev/null || true
  xcrun simctl ui "$UDID" appearance "$APPEARANCE" 2>/dev/null || true
  # What the demo left in the app's settings.
  local prefs; prefs="$(xcrun simctl get_app_container "$UDID" fm.backspace.bguru.chat data 2>/dev/null)/Library/Preferences/fm.backspace.bguru.chat"
  for k in $(plutil -p "$prefs.plist" 2>/dev/null | grep -oE '^  "(jukebox|shogi|minigame)[^"]*"' | tr -d ' "'); do
    xcrun simctl spawn "$UDID" defaults delete "$prefs" "$k" 2>/dev/null || true
  done
}
trap cleanup EXIT

shot() { # NAME ENV…
  local name="$1"; shift
  env SIMCTL_CHILD_BGURU_DEMO=1 "$@" xcrun simctl launch --terminate-running-process "$UDID" fm.backspace.bguru.chat >/dev/null
  sleep 7
  xcrun simctl io "$UDID" screenshot "$OUT/$name.png" >/dev/null 2>&1
  SHOTS+=("$OUT/$name.png")
}
SHOTS=()
for look in light dark; do
  xcrun simctl ui "$UDID" appearance "$look"
  shot "$look-chat"
  shot "$look-timeline" SIMCTL_CHILD_BGURU_DEMO_TAB=timeline
  shot "$look-jukebox" SIMCTL_CHILD_BGURU_DEMO_TAB=jukebox SIMCTL_CHILD_BGURU_DEMO_JUKEBOX=1 SIMCTL_CHILD_BGURU_DEMO_JUKEBOX_PLAY=1
  shot "$look-shogi" SIMCTL_CHILD_BGURU_DEMO_SHOGI_OPEN=101
  shot "$look-minigame" SIMCTL_CHILD_BGURU_DEMO_MINIGAME_OPEN=1
done
echo "=== ${#SHOTS[@]} screens in $OUT ==="
swift scripts/orientation-check.swift "${SHOTS[@]}"
