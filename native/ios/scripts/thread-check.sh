#!/usr/bin/env bash
# Long-thread check of the iPhone app in the simulator (run before testflight.sh, which runs it too).
#
#   native/ios/scripts/thread-check.sh [SIMULATOR_UDID] [REPLIES]
#
# Builds the Debug app for the simulator and opens it with offline demo data (BGURU_DEMO=1: no token,
# nothing sent, pictures drawn in the app): opens a thread with REPLIES (default 300) replies, scrolls
# it while it opens, to the top and back, goes back and opens it again. Fails if the main thread stops
# answering for 5 s (the Mac froze opening a thread with many replies, 2026-10-21; same shared screen).
# Exit 0 = passed. Default simulator: the first booted iPhone. BUILD_DIR=… builds elsewhere (default build/ddios).
set -euo pipefail
cd "$(dirname "$0")/../../mac"
UDID="${1:-$(xcrun simctl list devices booted | grep -m1 -oE '[0-9A-F-]{36}')}"
REPLIES="${2:-300}"
DD="${BUILD_DIR:-build/ddios}"
[ -n "$UDID" ] || { echo "no booted simulator" >&2; exit 2; }
xcodegen generate >/dev/null
xcodebuild -project BguruChat.xcodeproj -scheme BguruChatiOS -configuration Debug -destination "id=$UDID" \
  -derivedDataPath "$DD" build 2>&1 | grep -E " error:|BUILD (SUCCEEDED|FAILED)"
xcrun simctl install "$UDID" "$DD/Build/Products/Debug-iphonesimulator/B-guru Chat.app"
trap 'xcrun simctl terminate "$UDID" fm.backspace.bguru.chat 2>/dev/null || true' EXIT

LOG="$(mktemp -t bguru-thread-check)"
# --console-pty waits for the app to exit; the app ends the check itself (exit 0 / 1). A watchdog in case it cannot.
( sleep 180; xcrun simctl terminate "$UDID" fm.backspace.bguru.chat 2>/dev/null ) & WATCHDOG=$!
env SIMCTL_CHILD_BGURU_DEMO=1 SIMCTL_CHILD_BGURU_DEMO_TAB=timeline SIMCTL_CHILD_BGURU_DEMO_THREAD_CHECK=1 \
  SIMCTL_CHILD_BGURU_DEMO_REPLIES="$REPLIES" \
  xcrun simctl launch --console-pty --terminate-running-process "$UDID" fm.backspace.bguru.chat > "$LOG" 2>&1 || true
kill "$WATCHDOG" 2>/dev/null || true
wait "$WATCHDOG" 2>/dev/null || true
grep "\[thread-check\]" "$LOG" || true
grep -q "\[thread-check\] ok" "$LOG" || { echo "THREAD CHECK FAILED (log: $LOG)" >&2; exit 1; }
