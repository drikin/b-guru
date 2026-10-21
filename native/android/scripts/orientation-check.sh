#!/usr/bin/env bash
# Upside-down check of the Android app in the emulator (run by release.sh before it builds).
#
#   native/android/scripts/orientation-check.sh [OUT_DIR]
#   AVD=Medium_Phone_API_37.0 GPU=auto|host|swiftshader_indirect|angle_indirect  (when it starts the emulator)
#
# Builds the debug APK, opens it with the offline demo (`--ez demo true`: no token, nothing sent)
# on each screen — chat, timeline, jukebox playing (and after background → foreground), ☗ board,
# 🎮, the picture viewer, landscape — in light and dark, takes a screenshot of each
# (adb exec-out screencap) and reads them with native/mac/scripts/orientation-check.swift
# (Vision: upright must read clearly better than mirrored top to bottom). Exit 0 = every screen
# upright, 1 = something upside down (or unreadable), 2 = could not run.
# Starts the emulator when none is running and closes it again; puts back dark mode and
# rotation; stops only the processes it started itself.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
ADB="$SDK/platform-tools/adb"
EMU="$SDK/emulator/emulator"
AVD="${AVD:-Medium_Phone_API_37.0}"
GPU="${GPU:-auto}"
PKG=fm.backspace.bguru.chat.debug
ACT="$PKG/fm.backspace.bguru.chat.MainActivity"
CHECK="$ROOT/../mac/scripts/orientation-check.swift"
OUT="${1:-$(mktemp -d -t bguru-android-orientation)}"
mkdir -p "$OUT"
[ -x "$ADB" ] && [ -f "$CHECK" ] || { echo "adb or orientation-check.swift missing" >&2; exit 2; }

echo "=== build (debug) ==="
./gradlew -q :app:assembleDebug
APK="$ROOT/app/build/outputs/apk/debug/app-debug.apk"

STARTED_EMU=""
SERVER=""
NIGHT=""
ROT_AUTO=""
ROT_USER=""
cleanup() {
  [ -n "$SERVER" ] && kill "$SERVER" 2>/dev/null || true
  if "$ADB" get-state >/dev/null 2>&1; then
    "$ADB" shell am force-stop "$PKG" >/dev/null 2>&1 || true
    [ -n "$NIGHT" ] && "$ADB" shell cmd uimode night "$NIGHT" >/dev/null 2>&1 || true
    [ -n "$ROT_USER" ] && "$ADB" shell settings put system user_rotation "$ROT_USER" >/dev/null 2>&1 || true
    [ -n "$ROT_AUTO" ] && "$ADB" shell settings put system accelerometer_rotation "$ROT_AUTO" >/dev/null 2>&1 || true
    if [ -n "$STARTED_EMU" ]; then
      "$ADB" emu kill >/dev/null 2>&1 || true
      for _ in $(seq 30); do "$ADB" get-state >/dev/null 2>&1 || break; sleep 1; done # gone before we return
    fi
  fi
}
trap cleanup EXIT

if ! "$ADB" get-state >/dev/null 2>&1; then
  echo "=== start emulator $AVD (gpu $GPU) ==="
  "$EMU" -avd "$AVD" -no-window -no-audio -no-snapshot-save -no-boot-anim -gpu "$GPU" >"$OUT/emulator.log" 2>&1 &
  STARTED_EMU=1
  "$ADB" wait-for-device
fi
"$ADB" shell 'while [ "$(getprop sys.boot_completed)" != 1 ]; do sleep 1; done'
"$ADB" install -r "$APK" >/dev/null

# The demo's photos and jukebox audio, served from this Mac (the emulator sees it as 10.0.2.2).
MEDIA="$OUT/media"
mkdir -p "$MEDIA"
swift "$CHECK" --make-photo "$MEDIA/photo1.jpg"
for i in 2 3 4; do cp "$MEDIA/photo1.jpg" "$MEDIA/photo$i.jpg"; done
command -v ffmpeg >/dev/null && ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=120" -ac 1 -b:a 64k "$MEDIA/test.mp3" || true
PORT=""
for p in 8790 8791 8792 8793 8794 8795 8796 8797; do # never 8765 (the VLOG dashboard)
  lsof -iTCP:$p -sTCP:LISTEN >/dev/null 2>&1 || { PORT=$p; break; }
done
[ -n "$PORT" ] || { echo "no free port for the demo media" >&2; exit 2; }
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$MEDIA" >/dev/null 2>&1 &
SERVER=$!
BASE="http://10.0.2.2:$PORT"

NIGHT="$("$ADB" shell cmd uimode night | sed -E 's/.*: *//' | tr -d '\r')"
ROT_AUTO="$("$ADB" shell settings get system accelerometer_rotation | tr -d '\r')"
ROT_USER="$("$ADB" shell settings get system user_rotation | tr -d '\r')"
"$ADB" shell settings put system accelerometer_rotation 0
"$ADB" shell settings put system user_rotation 0

launch() { # EXTRAS… (the first start after an install can open the sign-in page: start twice)
  for _ in 1 2; do
    "$ADB" shell am force-stop "$PKG"
    sleep 1
    "$ADB" shell am start -W -n "$ACT" --ez demo true --es demo_jukebox "$BASE" "$@" >/dev/null
    sleep 2
  done
}
SHOTS=()
grab() { # NAME
  sleep 4
  "$ADB" exec-out screencap -p >"$OUT/$1.png"
  SHOTS+=("$OUT/$1.png")
}
shot() { local name="$1"; shift; launch "$@"; grab "$name"; }

for look in no yes; do
  name="$([ "$look" = yes ] && echo dark || echo light)"
  "$ADB" shell cmd uimode night "$look" >/dev/null
  shot "$name-chat"
  shot "$name-timeline" --es demo_tab timeline
  shot "$name-jukebox" --es demo_tab jukebox --ez demo_jukebox_play true
  # Background → foreground while it plays.
  "$ADB" shell input keyevent HOME; sleep 2
  "$ADB" shell am start -n "$ACT" >/dev/null; grab "$name-jukebox-resumed"
  shot "$name-shogi" --es demo_open shogi
  shot "$name-minigame" --es demo_open minigame
  shot "$name-viewer" --es demo_images "$BASE" --es demo_open viewer
done
"$ADB" shell cmd uimode night "$NIGHT" >/dev/null
# Turned to landscape and back.
launch
"$ADB" shell settings put system user_rotation 1; grab "landscape-chat"
"$ADB" shell settings put system user_rotation 0; grab "portrait-again"

echo "=== ${#SHOTS[@]} screens in $OUT ==="
# The check itself must catch a flipped screen: a copy of the first one, mirrored top to bottom.
FLIP="$OUT/selftest-flipped.png"
sips -f vertical "${SHOTS[0]}" --out "$FLIP" >/dev/null
if swift "$CHECK" "$FLIP" >/dev/null; then
  echo "selftest: a flipped screenshot passed — the check is not working" >&2
  exit 2
fi
echo "selftest ok: the flipped copy of ${SHOTS[0]##*/} is caught"
swift "$CHECK" "${SHOTS[@]}"
