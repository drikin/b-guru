#!/usr/bin/env bash
# One time only: create the Android release signing key outside the repo.
#   ~/.bguru-android/release.jks  +  native/android/keystore.properties (git-ignored, mode 600)
# Back up BOTH (the .jks and the password in keystore.properties) somewhere safe:
# without them no update can be installed over the published app.
set -euo pipefail
export JAVA_HOME="${JAVA_HOME:-/Applications/Android Studio.app/Contents/jbr/Contents/Home}"
cd "$(dirname "$0")/.."
KEYDIR="$HOME/.bguru-android"
JKS="$KEYDIR/release.jks"
[ -e "$JKS" ] && { echo "already exists: $JKS" >&2; exit 1; }
mkdir -p "$KEYDIR" && chmod 700 "$KEYDIR"
PASS="$(openssl rand -base64 32 | tr -d '/+=' | cut -c1-32)"
# Password via the environment, never on the command line (visible in ps).
export BGURU_KS_PASS="$PASS"
"$JAVA_HOME/bin/keytool" -genkeypair -keystore "$JKS" -storetype PKCS12 -alias bguru -keyalg RSA -keysize 4096 \
  -validity 36500 -storepass:env BGURU_KS_PASS -keypass:env BGURU_KS_PASS -dname "CN=B-guru Chat, O=backspace.fm, C=JP" >/dev/null 2>&1
chmod 600 "$JKS"
umask 077
cat > keystore.properties <<PROPS
storeFile=$JKS
storePassword=$PASS
keyAlias=bguru
keyPassword=$PASS
PROPS
echo "created $JKS and keystore.properties — back up both now."
"$JAVA_HOME/bin/keytool" -list -keystore "$JKS" -storepass:env BGURU_KS_PASS -v 2>/dev/null | grep -E "SHA256:" | head -1
