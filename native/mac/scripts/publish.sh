#!/usr/bin/env bash
# Put a notarized DMG on the server so members can download it from the
# B-guru right sidebar (/api/download/mac). Writes the manifest LAST, so the
# site switches to the new version only once the file is fully in place.
#
#   native/mac/scripts/publish.sh <版> "<今回の変更点>"   ← 更新メモは必須（アップデート画面に出る）。<> は実際の内容に置き換える
#
# Also signs the DMG for Sparkle (EdDSA key in the login keychain, created once
# with Sparkle's generate_keys) and records the build number, so installed apps
# update themselves from /api/download/mac/appcast.xml.
set -euo pipefail

VERSION="${1:?usage: publish.sh VERSION NOTES}"
NOTES="${2:-}"
# The notes appear in every member's update dialog: refuse empty/placeholder text.
case "$NOTES" in
  ""|"更新内容"|"ここに"*|*"更新内容（"*|"TODO"*|"notes"*|*"<"*|*">"*|"リアクションの表示を直しました")
    echo "更新メモを書いてください（アップデート画面に出ます）: publish.sh $VERSION \"〜を直しました\"" >&2; exit 1 ;;
esac
VPS="ubuntu@neta.backspace.fm"
DIR="/home/ubuntu/bsm-downloads"
cd "$(dirname "$0")/.."
DMG="dist/BguruChat-$VERSION.dmg"
[ -f "$DMG" ] || { echo "missing $DMG — run scripts/release.sh $VERSION first" >&2; exit 1; }

# Refuse anything that is not notarized + stapled (members must be able to open it).
xcrun stapler validate "$DMG" >/dev/null || { echo "$DMG is not stapled/notarized" >&2; exit 1; }
spctl --assess --type open --context context:primary-signature "$DMG"

SIZE=$(stat -f %z "$DMG")
SHA=$(shasum -a 256 "$DMG" | awk '{print $1}')
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Build number (CFBundleVersion) of the app inside — what Sparkle compares.
MNT="$(mktemp -d "${TMPDIR:-/tmp}/bguru-pub.XXXXXX")"
hdiutil attach -nobrowse -readonly -mountpoint "$MNT" "$DMG" >/dev/null 2>&1
BUILD=$(defaults read "$MNT/B-guru Chat.app/Contents/Info.plist" CFBundleVersion)
SHORT=$(defaults read "$MNT/B-guru Chat.app/Contents/Info.plist" CFBundleShortVersionString)
hdiutil detach "$MNT" -quiet
[ "$SHORT" = "$VERSION" ] || { echo "DMG contains $SHORT, not $VERSION" >&2; exit 1; }

# Sparkle EdDSA signature.
SIGN_UPDATE="$(ls -d build/dd/SourcePackages/artifacts/sparkle/Sparkle/bin/sign_update build/release/SourcePackages/artifacts/sparkle/Sparkle/bin/sign_update 2>/dev/null | head -1)"
[ -n "$SIGN_UPDATE" ] || { echo "sign_update not found (build once so SwiftPM fetches Sparkle)" >&2; exit 1; }
EDSIG=$("$SIGN_UPDATE" "$DMG" | sed -E 's/.*sparkle:edSignature="([^"]+)".*/\1/')
[ -n "$EDSIG" ] || { echo "Sparkle signing failed" >&2; exit 1; }

MANIFEST=$(python3 -c 'import json,sys; print(json.dumps({"version":sys.argv[1],"build":sys.argv[2],"file":"BguruChat-%s.dmg"%sys.argv[1],"size":int(sys.argv[3]),"sha256":sys.argv[4],"edSignature":sys.argv[5],"notes":sys.argv[6],"minimumSystemVersion":"14.0","publishedAt":sys.argv[7]}, ensure_ascii=False))' \
  "$VERSION" "$BUILD" "$SIZE" "$SHA" "$EDSIG" "$NOTES" "$NOW")

ssh "$VPS" "mkdir -p $DIR"
scp -q "$DMG" "$VPS:$DIR/BguruChat-$VERSION.dmg.part"
printf '%s' "$MANIFEST" | ssh "$VPS" "cat > $DIR/mac.json.next"
ssh "$VPS" "cd $DIR && echo '$SHA  BguruChat-$VERSION.dmg.part' | sha256sum -c --quiet && mv BguruChat-$VERSION.dmg.part BguruChat-$VERSION.dmg && mv mac.json.next mac.json && ls -la $DIR"
echo "published $VERSION (build $BUILD, $SIZE bytes, sha256 $SHA, Sparkle-signed)"
