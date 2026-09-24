#!/usr/bin/env bash
#
# Deploy B-guru to the VPS and verify it with the E2E regression guard.
#
# This is the ONLY supported way to deploy. It exists because the chat scroll
# bug regressed twice: a change that passed unit tests and built cleanly still
# broke the real UI. The guard at the end is what catches that.
#
# Usage:
#   scripts/deploy.sh              # deploy + verify + trigger CI
#   scripts/deploy.sh --no-verify  # deploy only (use when the guard itself is broken)
#   scripts/deploy.sh --no-ci      # deploy + verify, but do NOT trigger the CI job
#
# --no-ci exists for DEGRADE PROOFING. To prove a guard catches a regression you
# must deploy the broken build, and the local guard is expected to FAIL there.
# The CI job tests the same production site, so triggering it would mail drikin a
# failure for a build that was broken on purpose (2026-09-24: exactly that
# happened while proving the reaction guards). Use --no-ci for those runs.
#
# The VPS has another agent's uncommitted work in src/lib/session.ts. It is
# stashed before the pull and restored after, and the md5 is checked both times
# so a botched restore is caught immediately.

set -euo pipefail

VPS="ubuntu@neta.backspace.fm"
APP_DIR="/home/ubuntu/bsm-portal"
SESSION_TS_MD5="a08b3d0b30f74e3d3facded6858ecf4c"
VERIFY=1
TRIGGER_CI=1

for arg in "$@"; do
  case "$arg" in
    --no-verify) VERIFY=0 ;;
    --no-ci) TRIGGER_CI=0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

cd "$(dirname "$0")/.."

echo "=== 1/5 push ==="
git push origin main

echo "=== 2/5 deploy on VPS ==="
ssh "$VPS" "cd $APP_DIR && \
  cp src/lib/session.ts /tmp/session.ts.deploy.bak && \
  git stash push -u -m 'other-agent-session-cookie-work' >/dev/null 2>&1 || true && \
  git fetch origin main -q && \
  git pull origin main && \
  git stash pop >/dev/null 2>&1 || true && \
  echo 'session.ts md5:' && md5sum src/lib/session.ts && \
  npm run build 2>&1 | tail -2 && \
  pm2 restart bsm-portal >/dev/null && \
  sleep 6 && \
  curl -s -o /dev/null -w 'HTTP=%{http_code}\n' https://bsm.backspace.fm/"

echo "=== 3/5 verify session.ts was preserved ==="
ACTUAL=$(ssh "$VPS" "cd $APP_DIR && md5sum src/lib/session.ts | cut -d' ' -f1")
if [ "$ACTUAL" != "$SESSION_TS_MD5" ]; then
  echo "FATAL: session.ts md5 changed! expected $SESSION_TS_MD5 got $ACTUAL" >&2
  echo "The other agent's work may have been clobbered. Restore from /tmp/session.ts.deploy.bak" >&2
  exit 1
fi
echo "SESSION_TS_IDENTICAL"

if [ "$VERIFY" -eq 0 ]; then
  echo "=== 4/5 skipped (--no-verify) ==="
  echo "=== 5/5 done ==="
  exit 0
fi

echo "=== 4/5 mint a throwaway session for the guard ==="
TOKEN="e2e$(date +%s)"
ssh "$VPS" "cd $APP_DIR && DB=\$(grep '^DATABASE_URL' .env.production | cut -d= -f2- | tr -d '\"') && \
  psql \"\$DB\" -c \"INSERT INTO sessions (token, email, expires_at) VALUES ('$TOKEN', 'drikin@gmail.com', now()+interval '1 hour') ON CONFLICT (token) DO UPDATE SET expires_at = now()+interval '1 hour';\" >/dev/null && echo minted"

echo "=== 5/5 E2E regression guard ==="
set +e
BSM_SESSION="$TOKEN" node scripts/e2e-regression.mjs
GUARD=$?
set -e

# Always clean up the throwaway session, pass or fail.
ssh "$VPS" "cd $APP_DIR && DB=\$(grep '^DATABASE_URL' .env.production | cut -d= -f2- | tr -d '\"') && \
  psql \"\$DB\" -c \"DELETE FROM sessions WHERE token = '$TOKEN';\" >/dev/null" || true

if [ "$GUARD" -ne 0 ]; then
  echo "" >&2
  echo "DEPLOYED BUT THE GUARD FAILED." >&2
  echo "The code is live; fix forward or roll back with: git revert HEAD && scripts/deploy.sh" >&2
  exit 1
fi

# Trigger the CI E2E job now that the new build is actually serving. The job is
# manual-only (see .github/workflows/ci.yml) because it tests PRODUCTION: running
# it on push graded the previous deploy against the new expectations and mailed a
# failure for every UI commit. Here, after the deploy, a failure is real.
if [ "$TRIGGER_CI" -eq 0 ]; then
  echo "=== CI E2E job skipped (--no-ci) ==="
  echo ""
  echo "deploy + verify OK (CI not triggered)"
  exit 0
fi

echo "=== CI E2E job (post-deploy) ==="
if command -v gh >/dev/null 2>&1; then
  gh workflow run ci.yml --ref main >/dev/null 2>&1 \
    && echo "triggered — check: gh run list --workflow=ci.yml --limit 1" \
    || echo "could not trigger (gh not authenticated?) — run manually: gh workflow run ci.yml"
else
  echo "gh not installed — run manually: gh workflow run ci.yml"
fi

echo ""
echo "deploy + verify OK"
