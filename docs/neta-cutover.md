# ネタ帳の切り替え手順（neta.backspace.fm → bsm.backspace.fm/neta）

第 4 段階（2026-11-13 用意）。**本番の DB・nginx・環境変数を変えるので、実行はオーナーの OK と日時が決まってから。**
決まっていること（オーナー 2026-11-13）: 昔の Chrome 拡張からの投稿は今までどおり受ける（ログインなし・名前つき）、Bluesky ログインは切り替えでやめる。

## スイッチ 1 つで変わるもの（`NETA_WRITE_ENABLED=1`）
- 聞きたい・投稿・コメントが全員に開く（ログインはメールだけ。初めての人は backspace.fm の無料会員になる）。
- 試験公開の注意書きが消え、検索に載る（`/neta/admin`・`/neta/login`・`/neta/submit` は載せない）。
- 昔の拡張の受け口 `POST /api/neta/compat/topics` が開く（切るまでは 503）。
- B-guru の「ネタ帳に送る」（Web・アプリ・AI エージェント）が、neta.backspace.fm ではなく B-guru の中に入る。アプリが開くネタ帳の場所（capabilities の `features.neta.site`）も `https://bsm.backspace.fm/neta` に（アプリの配信は要らない）。
- 🐶 ビーグルが読むネタ帳も B-guru の中（neta_ 表）に。

## 手順（目安 20 分。人の少ない時間に）
1. **最後の移行**（本番 DB に書く: オーナーに聞いてから）。VPS で、移行元は neta-app の pm2 env の `DATABASE_URL`、移行先は bsm-portal の `.env.production`（値は出さない）。
   - `--dry-run` で件数を見る → 本番。B-guru で作った週があると止まる（それなら管理画面で作ったものを確かめてから）。
   - この時点から neta.backspace.fm に入った投稿・票は移らないので、2〜4 は続けてやる。
2. **スイッチを入れる**: bsm-portal の `.env.production` に `NETA_WRITE_ENABLED=1` を足し、`scripts/deploy.sh`（ビルドと再起動。ボイスルーム・オフ会が空いているのを確かめてから）。
3. **neta.backspace.fm の nginx を変える**（下の差分）。`sudo cp` で控えを取り → 書き換え → `sudo nginx -t` → `sudo systemctl reload nginx`。
   - **`/livekit/`・`/bsrec-api/`・`/app/`・`/docs/`・`/health` は触らない**（LiveKit と録音が同じドメインにいる）。
4. **確かめる**
   - `https://neta.backspace.fm/` → `/neta`、`/?week=679` → `/neta/w/679`、`/submit?url=…&title=…` → `/neta/submit?…`（301）。
   - 昔の拡張と同じ形で送る（テスト用の URL。送ったネタは管理画面で消す）: 201 と、同じ URL で 409（`DUPLICATE_URL`）。
   - `/neta` で未ログインからメールでログイン → 聞きたい → 投稿 → コメント。管理画面で採用・台本・タイトル案。
   - LiveKit（ボイスルームに入れる）と録音（rec.backspace.fm）がいつもどおり。
5. **メニューのリンク**: B-guru のメニューの「🗒️ ネタ帳」（`menu_links`、今は `https://neta.backspace.fm/`）を `/neta` に（管理者が画面から直すか、DB を直すならオーナーに聞いてから）。301 で届くので急ぎではない。
6. **neta.backspace.fm（Netaspace）の後始末**（急がない）: 画面は転送されるので誰も使わない。`/api/*` は互換のため Netaspace に残す（拡張の自動更新の `/api/extension/*` など）。認証なしの `POST /api/debug/clear-stars` は、もうデータを使わないので害はないが、止めるときに一緒に止める。Bluesky の OAuth も止める。

## nginx の差分（neta.backspace.fm の 443 の server の中）
今の `location /` と `location /api/` の前に足し、`location /` を置き換える（`/livekit/` などはそのまま）。

```nginx
    # ネタ帳は bsm.backspace.fm/neta に引っ越し（2026-11-xx）
    location = / {
        if ($arg_week ~ "^[0-9]{1,9}$") { return 301 https://bsm.backspace.fm/neta/w/$arg_week; }
        return 301 https://bsm.backspace.fm/neta;
    }
    location = /submit { return 301 https://bsm.backspace.fm/neta/submit$is_args$args; }
    location = /extension { return 301 https://bsm.backspace.fm/neta; }

    # 昔の Chrome 拡張（POST /api/topics）は B-guru の互換の受け口へ（ログインなし・名前つき・IP ごとに 10 件/時）
    location = /api/topics {
        limit_except POST { deny all; }
        limit_req zone=api_limit burst=5 nodelay;
        proxy_pass http://127.0.0.1:3000/api/neta/compat/topics;
        proxy_set_header Host bsm.backspace.fm;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # それ以外の画面はネタ帳のトップへ（/api/ と /livekit/ などは上の location が先に当たる）
    location / {
        return 301 https://bsm.backspace.fm/neta;
    }
```

## 戻し方
1. nginx を控えに戻して `sudo nginx -t && sudo systemctl reload nginx`。
2. `.env.production` の `NETA_WRITE_ENABLED=1` を消して `scripts/deploy.sh`。
3. 切り替えのあいだに B-guru に入った投稿・票は neta_ 表に残る（Netaspace には戻らない）。戻したままにするなら、あとで手で移すか捨てるかをオーナーと決める。

## 切り替えの後にやること（第 4 段階の残り）
- 新しい Chrome 拡張（B-guru のネタ帳へ・ログインつき）。
- 開ける前の宿題（docs/neta-integration-plan.md「開ける前にやること」）: Ghost の会員一覧を有料だけに絞る、出演者の名前の予約。
