#!/usr/bin/env bash
# Regenerates app/src/main/baseline-prof.txt (the code Android compiles ahead of time).
# Run after big UI changes, with an emulator (API 33+) running:
#
#   native/android/scripts/baseline-profile.sh
#
# The generator scrolls the demo chat and timeline, plays the jukebox and walks in the
# room (BaselineProfileGenerator.kt); the timeline's photos are large test JPEGs served
# from this Mac on :8099, the jukebox's audio a generated test tone on :8098.
set -euo pipefail
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
cd "$(dirname "$0")/.."
PHOTOS="$(mktemp -d)"
AUDIO="$(mktemp -d)"
trap 'kill "$SERVER" "$AUDIO_SERVER" 2>/dev/null; rm -rf "$PHOTOS" "$AUDIO"' EXIT
for i in 0 1 2 3 4 5 6 7; do
  ffmpeg -loglevel error -y -f lavfi -i "testsrc2=size=4032x3024:rate=1" -frames:v 1 -q:v 3 "$PHOTOS/photo$i.jpg"
done
python3 -m http.server 8099 --bind 127.0.0.1 --directory "$PHOTOS" >/dev/null 2>&1 &
SERVER=$!
ffmpeg -loglevel error -y -f lavfi -i "sine=frequency=440:duration=180" -b:a 128k "$AUDIO/test.mp3"
python3 -m http.server 8098 --bind 127.0.0.1 --directory "$AUDIO" >/dev/null 2>&1 &
AUDIO_SERVER=$!
./gradlew -q :baselineprofile:connectedProfileAndroidTest
# includeInStartupProfile = true: the generator writes one file, *-startup-prof.txt, with
# every rule (it is the baseline profile too); older runs wrote *-baseline-prof.txt.
OUT="$(find baselineprofile/build/outputs \( -name '*generate-baseline-prof.txt' -o -name '*generate-startup-prof.txt' \) -path '*/profile/*' -newer "$PHOTOS" | head -1)"
[ -n "$OUT" ] || { echo "profile not generated" >&2; exit 1; }
cp "$OUT" app/src/main/baseline-prof.txt
echo "updated app/src/main/baseline-prof.txt ($(wc -l < app/src/main/baseline-prof.txt) rules)"
