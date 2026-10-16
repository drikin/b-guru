#!/usr/bin/env bash
# Put a signed APK on the server so members can download it (/api/download/android).
# Writes the manifest LAST, so the site and the in-app update check switch to the
# new version only once the file is fully in place.
#
#   native/android/scripts/publish.sh <版> "<今回の変更点>"   ← <> は実際の内容に置き換える
set -euo pipefail
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
VERSION="${1:?usage: publish.sh VERSION NOTES}"
NOTES="${2:-}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "版は 0.1.0 の形で" >&2; exit 1; }
# The published app's signing certificate. Updates signed with any other key
# cannot be installed over it, so refuse them here instead of in members' hands.
EXPECTED_CERT="058acf490748dffa401a8383de5435b1e01ed254c7f95aabac782952b67c3506"
case "$NOTES" in
  ""|"更新内容"|"ここに"*|*"更新内容（"*|"TODO"*|"notes"*|*"<"*|*">"*)
    echo "更新メモを書いてください（アプリの更新案内に出ます）: publish.sh $VERSION \"〜を直しました\"" >&2; exit 1 ;;
esac
VPS="ubuntu@neta.backspace.fm"
DIR="/home/ubuntu/bsm-downloads"
cd "$(dirname "$0")/.."
APK="dist/BguruChat-$VERSION.apk"
[ -f "$APK" ] || { echo "missing $APK — run scripts/release.sh $VERSION first" >&2; exit 1; }

SDK="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
APKSIGNER="$(ls -d "$SDK"/build-tools/*/apksigner | sort -V | tail -1)"
AAPT2="$(ls -d "$SDK"/build-tools/*/aapt2 | sort -V | tail -1)"
"$APKSIGNER" verify "$APK" >/dev/null || { echo "$APK is not properly signed" >&2; exit 1; }
CERT=$("$APKSIGNER" verify --print-certs "$APK" 2>/dev/null | grep -m1 "certificate SHA-256 digest" | awk '{print $NF}')
[ "$CERT" = "$EXPECTED_CERT" ] || { echo "APK is signed with an unexpected key ($CERT)" >&2; exit 1; }
BADGING=$("$AAPT2" dump badging "$APK" | sed -n 1p)  # not head: SIGPIPE + pipefail would abort
CODE=$(sed -E "s/.*versionCode='([0-9]+)'.*/\1/" <<<"$BADGING")
NAME=$(sed -E "s/.*versionName='([^']+)'.*/\1/" <<<"$BADGING")
PKG=$(sed -E "s/.*package: name='([^']+)'.*/\1/" <<<"$BADGING")
[ "$NAME" = "$VERSION" ] || { echo "APK is $NAME, not $VERSION" >&2; exit 1; }
[ "$PKG" = "fm.backspace.bguru.chat" ] || { echo "APK package is $PKG (debug build?)" >&2; exit 1; }

SIZE=$(stat -f %z "$APK")
SHA=$(shasum -a 256 "$APK" | awk '{print $1}')
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
MANIFEST=$(python3 -c 'import json,sys; print(json.dumps({"version":sys.argv[1],"versionCode":int(sys.argv[2]),"file":"BguruChat-%s.apk"%sys.argv[1],"size":int(sys.argv[3]),"sha256":sys.argv[4],"certSha256":sys.argv[5],"minSdk":28,"notes":sys.argv[6],"publishedAt":sys.argv[7]}, ensure_ascii=False))' \
  "$VERSION" "$CODE" "$SIZE" "$SHA" "$CERT" "$NOTES" "$NOW")

ssh "$VPS" "mkdir -p $DIR"
scp -q "$APK" "$VPS:$DIR/BguruChat-$VERSION.apk.part"
printf '%s' "$MANIFEST" | ssh "$VPS" "cat > $DIR/android.json.next"
ssh "$VPS" "cd $DIR && echo '$SHA  BguruChat-$VERSION.apk.part' | sha256sum -c --quiet && mv BguruChat-$VERSION.apk.part BguruChat-$VERSION.apk && mv android.json.next android.json && ls -la $DIR"
echo "published $VERSION (versionCode $CODE, $SIZE bytes, sha256 $SHA, cert $CERT)"
