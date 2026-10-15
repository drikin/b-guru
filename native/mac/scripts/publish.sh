#!/usr/bin/env bash
# Put a notarized DMG on the server so members can download it from the
# B-guru right sidebar (/api/download/mac). Writes the manifest LAST, so the
# site switches to the new version only once the file is fully in place.
#
#   native/mac/scripts/publish.sh 0.1.2
set -euo pipefail

VERSION="${1:?usage: publish.sh VERSION}"
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
MANIFEST=$(printf '{"version":"%s","file":"BguruChat-%s.dmg","size":%s,"sha256":"%s","minimumSystemVersion":"14.0","publishedAt":"%s"}' \
  "$VERSION" "$VERSION" "$SIZE" "$SHA" "$NOW")

ssh "$VPS" "mkdir -p $DIR"
scp -q "$DMG" "$VPS:$DIR/BguruChat-$VERSION.dmg.part"
ssh "$VPS" "cd $DIR && echo '$SHA  BguruChat-$VERSION.dmg.part' | sha256sum -c --quiet && mv BguruChat-$VERSION.dmg.part BguruChat-$VERSION.dmg && printf '%s' '$MANIFEST' > mac.json.tmp && mv mac.json.tmp mac.json && ls -la $DIR"
echo "published $VERSION ($SIZE bytes, sha256 $SHA)"
