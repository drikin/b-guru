# 「ネタ帳に送る」— 仕様（2026-10-20）

タイムラインの投稿に貼られた**記事の URL**を、BS ネタ帳（https://neta.backspace.fm、公開サイト）に送る。
B-guru の投稿の URL（bsm.backspace.fm/#/post/…）は送らない（ドリキン 2026-10-20）。

## サーバ

- アプリ: `POST /api/agent/neta`（スコープ post）、Web: `POST /api/neta`（ログイン必須、1 人 1 時間 20 件まで）
- 本文: `{ "url": "https://…", "title": "…", "description": "…"(任意) }`
  - url: http(s) の外部の記事だけ（bsm.backspace.fm は不可）。title: 必須・200 文字まで。description: 1000 文字まで。
- 投稿者名は会員の B-guru の表示名（サーバが決める）。
- 返事:
  - 201 `{ ok: true, topicId, site: "https://neta.backspace.fm" }`
  - 409 `{ ok: false, code: "duplicate", error, existing: { title, submitter } }` … 今週のネタ帳に同じ URL がある
  - 400 / 429 / 502 `{ ok: false, code, error }`（error は会員向けの日本語）
- アプリが使えるか: capabilities の `features.neta = { enabled, path: "/api/agent/neta", site }`（enabled = post スコープあり）

## 画面

1. **メニュー**: 投稿の長押し・右クリック（Web は投稿のアイコン列）に「ネタ帳に送る」。
   送れる URL がある投稿だけに出す。送れる URL =
   - `urlPreview.url`（リンクのカード）と、本文中の `http(s)://…`（末尾の `。、)」』】,.!?` は外す）
   - bsm.backspace.fm（B-guru 自身）は除く。重複は 1 つに。
2. **確認の画面**（ネタ帳は公開サイトなので、送る前に必ず出す）:
   - URL: 1 つならそのまま表示、2 つ以上なら選ぶ。
   - 題名: その URL がリンクのカードの URL ならカードの題名を最初から入れておく（直せる）。なければ空。必須。
   - 説明（任意）: **空から始める**。投稿の本文は入れない（会員限定の B-guru の文を勝手に公開しないため）。
   - 注意書き: 「ネタ帳は公開サイトです。B-guru の表示名で投稿されます。」
   - ボタン: キャンセル / 送る（題名が空なら押せない、送っている間は二重に押せない）。
3. **結果**:
   - 成功: 「ネタ帳に送りました」＋「ネタ帳を開く」（https://neta.backspace.fm）。
   - 409: 「今週のネタ帳には {submitter} さんが「{title}」として投稿済みです」。
   - それ以外: サーバの error をそのまま。
