# ✉️👥 DM の写真（仕様）

2026-11-08 オーナー「DM もチャットと同様に画像を貼れるようにしてください」。1 対 1 の DM とグループ DM の両方。
同じ日に「クリップボードの画像を貼れるようにして欲しい（iOS、mac、Android）」→ アプリのチャットと DM の入力欄で、貼り付けで画像を添付できること。

## 決まり
- 付け方・枚数・大きさはチャットの写真と同じ: 最大 4 枚、1 枚 4MB まで、端末で長辺 1280px の JPEG に縮めて送る（GIF は小さければそのまま）。サーバでも EXIF を落とす（オフ会の写真と同じ処理）。
- 写真だけ（本文なし）でも送れる。そのとき `body` は `""`。
- 見られるのは、その写真が付いた DM の当事者 2 人と、グループのいまのメンバー、上げた本人だけ。ほかの人が `/api/media/dm-…` を開くと 404。
- 送るときは、自分が上げた写真だけ付けられる（他人の写真の URL は断る）。
- DM と同じ 30 日で消える。上げたのに送らなかった写真は 1 日で消える。
- 一覧のプレビュー・通知で本文が空なら「📷 写真」と出す（クライアント側）。

## API
- 上げる: `POST /api/dm/upload`（Web・同一オリジンのみ）／`POST /api/agent/dm/upload`（アプリ、スコープ chat）
  - multipart `images`（複数可、最大 4）→ `201 { urls: ["/api/media/dm-<時刻>-<乱数>.jpg", …] }`
  - チャットの `/api/agent/chat/upload` と同じ形。エラーは `{ error }`、413（大きすぎ）・400（形式）・404（DM が使えない）。
- 送る: 既存の送信に `images` を足す（省略可・最大 4）。
  - 1 対 1: `POST /api/agent/dm/:userId { body, client_id?, images? }`
  - グループ: `POST /api/agent/gdm/:gid/messages { body, client_id?, images? }`
  - 本文が空でも `images` があれば送れる。不正な写真（形・枚数・自分が上げていない）は 400 invalid_request。
- 読む: DM とグループの発言の DTO に `images: string[]` が付く（無ければ `[]`）。配信（stream の `dm` / `gdm` イベント）の message も同じ。
- 写真の取得: `GET /api/media/dm-…`（チャットの写真と同じく Web はクッキー、アプリは `Authorization: Bearer <鍵>`）。
- capabilities: `features.dm` に `max_images: 4` と `upload_path: "/api/agent/dm/upload"`。

## 古いアプリ
- 写真だけの発言は、古いアプリでは本文が空の吹き出しになる（写真は見えない）。更新で直る。
