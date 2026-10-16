#!/usr/bin/env bash
# B-guru Chat for Android: signed release APK → native/android/dist/BguruChat-<版>.apk
#
#   native/android/scripts/release.sh <版>
#
# Signing key: ~/.bguru-android/release.jks (made once with scripts/make-key.sh),
# referenced from native/android/keystore.properties (both outside git). Every
# update MUST be signed with the same key, or Android refuses to install it over
# the old one — keep a backup of the key and its password.
set -euo pipefail
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
VERSION="${1:?usage: release.sh <版>  (例: 0.1.0)}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版は 0.1.0 の形で" >&2; exit 1; }
cd "$(dirname "$0")/.."
[ -f keystore.properties ] || { echo "keystore.properties がありません（scripts/make-key.sh を先に）" >&2; exit 1; }
[ -f firebase.properties ] || echo "注意: firebase.properties が無いので通知なしのビルドになります" >&2

# Monotonic build number: minutes since the epoch (fits an Int for centuries).
CODE=$(( $(date +%s) / 60 ))
./gradlew -q :app:assembleRelease -PversionName="$VERSION" -PversionCode="$CODE"

APK=app/build/outputs/apk/release/app-release.apk
SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
APKSIGNER="$(ls -d "$SDK"/build-tools/*/apksigner | sort -V | tail -1)"
"$APKSIGNER" verify --min-sdk-version 28 "$APK"
mkdir -p dist
cp "$APK" "dist/BguruChat-$VERSION.apk"
echo "release OK: dist/BguruChat-$VERSION.apk (versionCode $CODE)"
"$APKSIGNER" verify --print-certs "dist/BguruChat-$VERSION.apk" | grep -i "SHA-256"
