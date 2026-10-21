#!/usr/bin/env bash
# Upside-down check of the Mac app as WindowServer draws it (run before release.sh).
#
#   native/mac/scripts/orientation-tour.sh [APP_BINARY] [OUT_DIR]
#
# Builds the Debug app unless APP_BINARY is given, starts it with offline demo data
# (-demoPanel -demoJukebox -orientationTour: chat, jukebox playing, timeline, picture viewer,
# ☗, 🎮, panel closed and reopened, resized, dark and light), captures the panel at every
# step and reads each picture with orientation-check.swift. Exit 0 = every screen upright.
# Needs Screen Recording permission for the terminal. Nothing is sent anywhere: the demo
# has no token and its sound and picture come from a server on 127.0.0.1 started here.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="${1:-}"
OUT="${2:-$(mktemp -d -t bguru-orientation)}"
mkdir -p "$OUT"
if [ -z "$APP" ]; then
  xcodegen generate >/dev/null
  xcodebuild -project BguruChat.xcodeproj -scheme BguruChat -configuration Debug -derivedDataPath build/dd build 2>&1 \
    | grep -E " error:|BUILD (SUCCEEDED|FAILED)"
  APP="$ROOT/build/dd/Build/Products/Debug/B-guru Chat.app/Contents/MacOS/B-guru Chat"
fi
TOOLS="$(mktemp -d -t bguru-tools)"
swiftc -O scripts/window-shot.swift -o "$TOOLS/window-shot" 2>/dev/null

# Demo sound and picture, served locally.
MEDIA="$TOOLS/media"; mkdir -p "$MEDIA"
if command -v ffmpeg >/dev/null; then
  ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=60" -ac 1 -b:a 64k "$MEDIA/tone.mp3" || true
fi
swift scripts/orientation-check.swift --make-photo "$MEDIA/photo1.jpg"
PORT=8097
( cd "$MEDIA" && exec python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 ) &
SERVER=$!
LOG="$OUT/tour.log"
cleanup() {
  kill "$SERVER" 2>/dev/null || true
  [ -n "${PID:-}" ] && kill "$PID" 2>/dev/null || true
  # What the demo left in the app's settings.
  defaults delete fm.backspace.bguru.chat panelNarrowed20261019 2>/dev/null || true
  for k in $(defaults read fm.backspace.bguru.chat 2>/dev/null | grep -oE '"?jukebox\.[A-Za-z]+"?' | tr -d '"' | sort -u); do
    defaults delete fm.backspace.bguru.chat "$k" 2>/dev/null || true
  done
}
trap cleanup EXIT
sleep 0.5

BGURU_DEMO_AUDIO="http://127.0.0.1:$PORT" BGURU_DEMO_PHOTOS="http://127.0.0.1:$PORT" \
  "$APP" -demoPanel -demoJukebox -orientationTour >"$LOG" 2>&1 &
PID=$!
SHOTS=()
SEEN=0
for _ in $(seq 1 600); do
  sleep 0.25
  kill -0 "$PID" 2>/dev/null || break
  N=$(grep -c '^\[tour\] [0-9]' "$LOG" || true)
  while [ "$SEEN" -lt "$N" ]; do
    SEEN=$((SEEN + 1))
    NAME=$(grep '^\[tour\] [0-9]' "$LOG" | sed -n "${SEEN}p" | awk '{print $2"-"$3}')
    "$TOOLS/window-shot" "$PID" "$OUT/$NAME.png" >/dev/null && SHOTS+=("$OUT/$NAME.png")
  done
  grep -q '^\[tour\] done' "$LOG" && break
done
wait "$PID" 2>/dev/null || true
[ "${#SHOTS[@]}" -gt 0 ] || { echo "no screenshots (Screen Recording permission?) — log: $LOG" >&2; exit 2; }
echo "=== ${#SHOTS[@]} screens in $OUT ==="
swift scripts/orientation-check.swift "${SHOTS[@]}"
