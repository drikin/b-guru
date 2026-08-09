# B-guru（ビーグル先 → B-guru）

backspace.fm 有料会員（BSM）向けのクローズド SNS ポータル。

- ログイン: メール OTP（本人確認）
- フィード: テキスト/画像投稿、エピソード自動配信、記事・ギャラリー・ドリニュース
- 返信: カード間に挟むインライン返信、アクティビティ順タイムライン、ピン機能（24hトップ固定）
- ロゴ: 跳ねるビーグルの単色SVGアイコン

## 技術スタック
- Next.js 16（App Router）+ React 19 + Mantine 9
- PostgreSQL（`pg`）+ Tailwind CSS
- Ghost Admin API（エピソード同期）、Mailgun（認証コード送信）

## 開発

```bash
npm install
npm run dev        # http://localhost:3000
npm run build      # 本番ビルド
npm run start      # 本番起動
```

## 環境変数（`.env.local` / `.env.production`）
`DATABASE_URL` / `GHOST_ADMIN_API_URL` / `GHOST_ADMIN_API_KEY` / `MAILGUN_API_KEY` / `MAILGUN_DOMAIN` / `MAILGUN_BASE_URL` / `MAIL_FROM_EMAIL` / `MAIL_FROM_NAME` / `APP_URL` / `BSM_SESSION_SECRET` / `SYNC_SECRET`

> 認証情報を漏らさないため、`.env*` は Git では**追跡しない**（`.gitignore` で一律除外）。