#!/usr/bin/env bash
# 📝 ネタ帳の切り替え（neta.backspace.fm → bsm.backspace.fm/neta）を一度に流す（docs/neta-cutover.md）。
# Mac の端末から:  scripts/neta-cutover.sh
# 段階ごとに y/N を聞く。DB の接続先は VPS の上で読み、画面やログには出さない。
#
#   1. スイッチを入れる（.env.production に NETA_WRITE_ENABLED=1 → scripts/deploy.sh）
#   2. 最後の移行（neta.backspace.fm の DB → B-guru。まず --dry-run で件数を見る）
#   3. neta.backspace.fm の nginx を転送に（控えを取り、nginx -t が通ったときだけ reload）
#   4. 今週を ep681 に（2026-11-15〜11-22）
#   5. 確かめる
# 2 と 3 は続けて（2 のあと neta.backspace.fm に入った投稿は移らない）。
set -euo pipefail
cd "$(dirname "$0")/.."

VPS="ubuntu@neta.backspace.fm"
APP_DIR="/home/ubuntu/bsm-portal"
NGINX_FILE="/etc/nginx/sites-available/neta.backspace.fm"
NGINX_BEFORE_MD5="c69ca095e6f73b5d6af473aa8b2904ec" # docs/neta-cutover/nginx-neta-before.conf
NEW_WEEK_TITLE="ep681"
NEW_WEEK_START="2026-11-15"
NEW_WEEK_END="2026-11-22"

ask() {
  local a
  read -r -p "$1 [y/N] " a
  [[ "$a" == "y" || "$a" == "Y" ]]
}

# VPS の上で、移行元（pm2 の neta-app）と移行先（bsm-portal）の DB を変数に入れてから $1 を流す。値は出さない。
remote_with_dbs() {
  ssh "$VPS" "cd $APP_DIR && \
    DST=\$(grep '^DATABASE_URL' .env.production | cut -d= -f2- | tr -d '\"') && \
    SRC=\$(pm2 jlist 2>/dev/null | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const p=JSON.parse(s).find(x=>x.name===\"neta-app\");const e=p&&p.pm2_env||{};process.stdout.write((e.env&&e.env.DATABASE_URL)||e.DATABASE_URL||\"\")})') && \
    [ -n \"\$SRC\" ] && [ -n \"\$DST\" ] || { echo '接続先が読めませんでした（pm2 の neta-app か .env.production）' >&2; exit 1; } ; \
    $1"
}

echo "=== 0. 前の確認 ==="
echo "deploy でアプリが再起動します。ボイスルームとオフ会が空いているか確かめてください。"
ask "空いていますか？ 続けますか？" || exit 1

echo "=== 1. スイッチを入れる（NETA_WRITE_ENABLED=1 → deploy） ==="
if ask "入れますか？"; then
  ssh "$VPS" "cd $APP_DIR && cp .env.production /home/ubuntu/env.production.bak-neta-\$(date +%Y%m%d%H%M) && \
    { grep -q '^NETA_WRITE_ENABLED=1\$' .env.production && echo 'もう入っています'; } || { echo 'NETA_WRITE_ENABLED=1' >> .env.production && echo '足しました'; }"
  scripts/deploy.sh
fi

echo "=== 2. 最後の移行 ==="
remote_with_dbs 'NETA_SRC_DATABASE_URL="$SRC" DATABASE_URL="$DST" node scripts/neta-migrate.mjs --dry-run'
if ask "この件数で移行しますか？（このあとすぐ 3 の転送をします）"; then
  remote_with_dbs 'NETA_SRC_DATABASE_URL="$SRC" DATABASE_URL="$DST" node scripts/neta-migrate.mjs'
fi

echo "=== 3. neta.backspace.fm を転送に ==="
CUR=$(ssh "$VPS" "md5sum $NGINX_FILE | cut -d' ' -f1")
if [[ "$CUR" != "$NGINX_BEFORE_MD5" ]]; then
  echo "nginx の設定が用意したときから変わっています（$CUR）。止めます。" >&2
  exit 1
fi
if ask "nginx を書き換えますか？（/livekit/・/bsrec-api/・/app/・/docs/・/health はそのまま）"; then
  scp -q docs/neta-cutover/nginx-neta-after.conf "$VPS:/tmp/nginx-neta-after.conf"
  ssh -t "$VPS" "BAK=/home/ubuntu/nginx-neta-before-\$(date +%Y%m%d%H%M).conf && sudo cp $NGINX_FILE \$BAK && echo \"控え: \$BAK\" && \
    sudo cp /tmp/nginx-neta-after.conf $NGINX_FILE && \
    if sudo nginx -t; then sudo systemctl reload nginx && echo 'reload しました'; \
    else echo 'nginx -t が通らないので戻します' >&2; sudo cp \$BAK $NGINX_FILE; exit 1; fi"
fi

echo "=== 4. 今週を $NEW_WEEK_TITLE に ==="
if ask "$NEW_WEEK_TITLE（$NEW_WEEK_START〜$NEW_WEEK_END）を作って今週にしますか？"; then
  ssh "$VPS" "cd $APP_DIR && DB=\$(grep '^DATABASE_URL' .env.production | cut -d= -f2- | tr -d '\"') && psql \"\$DB\" -v ON_ERROR_STOP=1 -q <<'SQL'
BEGIN;
INSERT INTO neta_weeks (title, start_date, end_date)
  SELECT '$NEW_WEEK_TITLE', '$NEW_WEEK_START', '$NEW_WEEK_END'
  WHERE NOT EXISTS (SELECT 1 FROM neta_weeks WHERE title = '$NEW_WEEK_TITLE');
UPDATE neta_weeks SET is_active = false WHERE is_active AND title <> '$NEW_WEEK_TITLE';
UPDATE neta_weeks SET is_active = true WHERE title = '$NEW_WEEK_TITLE';
COMMIT;
SELECT id, title, start_date, end_date, is_active FROM neta_weeks WHERE is_active;
SQL"
fi

echo "=== 5. 確かめる ==="
code() { curl -s -o /dev/null -w "%{http_code} %{redirect_url}" "$1"; }
echo "neta.backspace.fm/            → $(code https://neta.backspace.fm/)"
echo "neta.backspace.fm/?week=679   → $(code 'https://neta.backspace.fm/?week=679')"
echo "neta.backspace.fm/submit?url= → $(code 'https://neta.backspace.fm/submit?url=https%3A%2F%2Fexample.com&title=t')"
echo "neta.backspace.fm/health      → $(code https://neta.backspace.fm/health)"
echo "neta.backspace.fm/app/        → $(code https://neta.backspace.fm/app/)"
echo "GET /api/topics（拡張の受け口・GET は断る）→ $(code https://neta.backspace.fm/api/topics)"
echo "bsm の今週: $(curl -s https://bsm.backspace.fm/api/neta/board | head -c 120)"
echo ""
echo "戻すとき: docs/neta-cutover.md の「戻し方」（nginx は上の控え、.env.production は ~/env.production.bak-neta-*）"
