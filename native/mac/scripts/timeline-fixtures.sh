#!/usr/bin/env bash
# The timeline's display rules in the Mac/iOS app against the shared examples (docs/timeline-spec.md §9).
#
#   native/mac/scripts/timeline-fixtures.sh [APP_BINARY]
#
# Copies src/lib/__tests__/fixtures/timeline/{posts,expected}.json into the app's container (the app is
# sandboxed: it cannot read the repository) and runs `-timelineFixtures`: the app's own rules
# (TimelineRules.computed, used when a server sends no `display`) must give exactly each expected `display`,
# and the folded text / reaction order / mention ranges drawn from it must be right. Exit 0 = all match.
# Builds the Debug app into build/fixtures unless APP_BINARY is given. Offline, nothing is sent.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"
APP="${1:-}"
if [ -z "$APP" ]; then
  [ -d BguruChat.xcodeproj ] || xcodegen generate >/dev/null
  xcodebuild -project BguruChat.xcodeproj -scheme BguruChat -configuration Debug -derivedDataPath "$ROOT/build/fixtures" build -quiet
  APP="$ROOT/build/fixtures/Build/Products/Debug/B-guru Chat.app/Contents/MacOS/B-guru Chat"
fi
DIR="$HOME/Library/Containers/fm.backspace.bguru.chat/Data/tmp/timeline-fixtures"
mkdir -p "$DIR"
cp "$ROOT/../../src/lib/__tests__/fixtures/timeline/posts.json" "$ROOT/../../src/lib/__tests__/fixtures/timeline/expected.json" "$DIR/"
"$APP" -timelineFixtures "$DIR"
