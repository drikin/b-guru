# ✉️👥 DM をチャットと同じ機能に（2026-11-08 オーナー「チャットとDMで機能を同じにして」）

1 対 1 の DM（lib/dm.ts）とグループ DM（lib/gdm.ts）に、チャットにある次の機能を足す。
見た目と操作は、各クライアントの **いまのチャット** と同じにする（新しい作法を作らない）。

| 機能 | チャット | DM に足すもの |
|---|---|---|
| 😀 リアクション | 絵文字・カスタム絵文字、同じ絵文字は 1 つのチップに件数、誰が付けたか | 同じ（1 対 1・グループ。グループの知らせ行には付けない、ビーグルの答えには付けられる） |
| ✏️ 編集 | 自分の発言の本文だけ直せる、「編集済み」 | 同じ（写真はそのまま、写真があれば本文を空にできる。グループでビーグルが答えた質問は直せない） |
| 🔗 リンク | URL は押せる、B-guru の投稿リンクはアプリ・ページの中でスレッドを開く、YouTube は 📺 | 同じ |
| @ メンション | 名前を強調、自分宛ては太字 | 同じ（グループ） |
| ↩️ 返信 | 他人の発言の「返信」で入力欄に `@名前 ` | グループだけ（1 対 1 は相手が決まっているので不要） |

足さないもの（理由）: 管理者の削除（DM は当事者だけのもの）、🔈 読み上げ（チャット欄でも既定は切）、入力欄の @ 補完（グループのメンバー数が少なく、返信ボタンで足りる）。

## API（Web は `/api/dm/…`・`/api/gdm/…`、アプリは `/api/agent/dm/…`・`/api/agent/gdm/…`。中身は同じ lib）

- `PATCH {dm}/messages/:id` `{ body }` → `{ message }`（スコープ chat）。自分の DM だけ（他人は 403、当事者でない・30 日を過ぎたら 404）。
- `POST {dm}/messages/:id/reactions` `{ emoji }` → `{ added, reactions }`（スコープ chat）。
- `PATCH {gdm}/messages/:id` `{ body }` → `{ message }`。自分の text 発言だけ（他人・ビーグル・知らせ行・ビーグルが答えた質問は 403）。
- `POST {gdm}/messages/:id/reactions` `{ emoji }` → `{ added, reactions }`。メンバーで、入ってからの発言だけ（ほかは 404）。知らせ行は 400。
- 回数制限: リアクションは 1 人 1 時間 300 回（429 + Retry-After）。編集は制限なし（チャットと同じ）。
- Web の書き込みは `Content-Type: application/json` でなければ 400。
- `emoji` はチャットと同じ値（Unicode 絵文字か `:name:`）。不正 400、登録されていないカスタム絵文字 404。

## DTO（DmMessageDto / GMessageDto に足した列。古いサーバでは無いので、無ければ false / null / []）

- `edited: boolean`、`edited_at: string | null`
- `reactions: { emoji, count, mine, reactors: string[] }[]` — チャットの reactions と同じ形・同じ並び（件数の多い順、同数は UTF-16 順）。
  会話を開いたとき（GET 1 つの会話・GET 1 件）に入る。一覧の `last_message` と `create` の配信では `[]`。

## 配信（Web: `/api/posts/stream` の `event: dm` / `event: gdm`、アプリ: `/api/agent/stream` の同名イベント）

- dm `{ action: "edit", message }` — 当事者 2 人へ、見る人ごとの DTO（reactions 入り）。同じ id の吹き出しを差し替える。
- dm `{ action: "reaction", peer_id, message_id, reactions }` — 当事者 2 人へ（mine は見る人ごと）。
- gdm `{ action: "edit", group_id, message }`、`{ action: "reaction", group_id, message_id, reactions }` — その発言を見られるいまのメンバーへ。
- 古いアプリは知らない action を無視する（Android・iPhone・Mac とも `when/switch` で create・read だけ見ている）。

## 機能の有無（capabilities）

`features.dm.edit` / `features.dm.reactions`、`features.gdm.edit` / `features.gdm.reactions` が true のときだけ出す（古いサーバでは隠す）。

## 通知

編集・リアクションでは push しない（チャットと同じ）。一覧の未読も変えない。
