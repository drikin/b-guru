# 👥 グループ DM（仕様）

2026-11-06 ドリキン「ビーグルにグループ DM の機能を追加したい」。1 対 1 の ✉️ 簡易 DM（`docs` なし・`src/lib/dm.ts`）の横に、3 人以上で話せる DM を足す。

## オーナーの決定（2026-11-06）
- 人数の上限: 「特に制約する必要はない」。仕様としての上限は設けない。ただし通知を一度に配る負荷を抑える安全弁として、1 グループ **100 人**（`GDM_MAX_MEMBERS`）までとする。
- メンバーの追加は **メンバーなら誰でも**できる。外すのは **作った人だけ**。自分で抜けるのは誰でもできる。
- 通知: 発言は**全部 push**する。グループごとに**自分で通知を切れる**（mute）。
- 公開: **Web と iPhone・Mac・Android を一度に**出す。
- 1 対 1 と同じ決まり（前提として提示し、了承済み）:
  - 30 日で消える。文字だけ（写真なし）。
  - グループ名は任意。無ければメンバーの名前を並べて出す。
  - ブロック・通報は作らない（1 対 1 と同じ）。

## 決まり（実装で決めたこと）
- **見られるのはメンバーだけ**。送り主は、サーバの認証（セッションかアプリの鍵）から決める。
- **途中から入った人は、入る前の発言を見られない**（`joined_from_id` より後だけ見える。LINE と同じ）。
- **抜けた人・外された人は、そのグループを見られなくなる**（一覧から消え、API は 404）。
- **作った人が抜けたら**、残った中でいちばん早く入った人が、新しく「作った人」（外す権限を持つ人）になる。
- **メンバーが 0 人になったら、グループごと消す**。
- **発言がなくてもグループは残る**。発言は 30 日で消える。
- **入った・抜けた・外れた・名前が変わったを、グループの中に 1 行で残す**（`kind: "system"`）。たとえば「A さんが B さんを追加しました」。これも 30 日で消える。
- **追加できる人**:
  - グループ DM を使える人（`GROUP_DM_ENABLED` の対象）で、今も会員であること。1 対 1 の `peerCanReceive` と同じ判定。
  - ビーグル（システム）と自分は追加できない。
- **作るとき**: 自分のほかに 1 人以上選ぶ。2 人だけのグループも作れる（1 対 1 とは別のものとして扱う）。
- **送信の回数制限**は 1 対 1 と同じカウンタ（`dm:<email>`、1 時間 60 件）を使う。作る・追加する・名前を変えるは、それとは別に 1 時間 30 回まで（`gdm-admin:<email>`）。
- **自分で抜けた人は、そのグループに 24 時間入れ直せない**（`gdm_leaves`）。承諾なしの追加をくり返す嫌がらせを止めるため（security-reviewer 2026-11-06）。外された人はすぐ入れ直せる。
- **Web の POST** は `Content-Type: application/json` だけを受け付ける。別サイトからのフォーム送信を断るため。
- **本文の上限**はチャットと同じ。グループ名は 40 文字まで。
- **既読**はメンバーごとに `last_read_id` で持つ（単調）。送ったらそこまで既読にする。
- **未読の合計**はグループの分を別に返す（`group_unread_count`）。今の `unread_count`（1 対 1）の意味は変えない。古いアプリでバッジが合わなくなるのを避けるため。

## 表（`db.ts`）
```
gdm_groups          id SERIAL, name TEXT NULL, creator_email TEXT, created_at, updated_at（最後の動き）
gdm_members         group_id, email, joined_at, joined_from_id INT（入った時点の最新の発言 id）, added_by TEXT NULL,
                    muted BOOL DEFAULT false, last_read_id INT DEFAULT 0   PK (group_id, email)
gdm_messages        id SERIAL, group_id, sender_email TEXT NULL（system は NULL）, kind TEXT 'text'|'system',
                    body TEXT, created_at
```
`gdm_messages` は 30 日で消す（1 対 1 の掃除と同じタイマー）。メールは表の中だけに置き、応答・配信では `users.user_id` を使う。

## API（Web は `/api/gdm/**`、アプリは `/api/agent/gdm/**`。中身は共通で `lib/gdm-api.ts`）
`/api/agent/dm/[userId]` とぶつからないように、別の根元にした。応答はすべて `{ apiVersion: 1, ... }`。
`GROUP_DM_ENABLED`（かつ `DM_ENABLED`）の対象でない人には 404 を返す。アプリのスコープは、読むのが `read`、それ以外は `chat`。

| メソッド・パス | 入力 | 返り値 |
|---|---|---|
| `GET /gdm` | — | `{ groups: GroupSummary[], group_unread_count }` |
| `POST /gdm` | `{ name?, member_ids: string[] }` | 201 `{ group: Group }` |
| `GET /gdm/:gid` | `?before=&limit=` | `{ group: Group, messages: GMessage[], unread_count, last_read_id, can_send }` |
| `PATCH /gdm/:gid` | `{ name? , muted? }` | `{ group: Group }`（name はメンバー誰でも・null/"" で消す。muted は自分の分） |
| `POST /gdm/:gid/messages` | `{ body, client_id? }` | 201 `{ message: GMessage }` |
| `POST /gdm/:gid/read` | `{ last_read_id }` | `{ unread_count, group_unread_count }` |
| `POST /gdm/:gid/members` | `{ user_ids: string[] }` | `{ group: Group }` |
| `DELETE /gdm/:gid/members/:userId` | — | `{ ok: true }`（自分なら抜ける、他人なら作った人だけ） |
| `GET /gdm/messages/:id` | — | `{ message: GMessage, group: Group }`（通知の本文用。メンバーでなければ 404） |

```ts
type GMember = { user_id: string; name: string | null; avatar: string | null; is_creator: boolean; is_me: boolean };
type Group = {
  id: number;
  name: string | null;          // 付けた名前（無ければ null）
  photo: string | null;         // グループの写真（メンバーだけが読める URL）。無ければ null
  title: string;                // 表示名: name か、自分以外のメンバーの名前を「、」で並べたもの（3 人まで＋「ほか N 人」）
  members: GMember[];           // 入った順
  member_count: number;
  is_creator: boolean;          // 見る人が作った人か（外すボタンを出す）
  muted: boolean;               // 見る人がこのグループの通知を切っているか
  created_at: string;
};
type GMessage = {
  id: number; group_id: number;
  kind: "text" | "system";
  from_id: string | null;       // system は null
  from_name: string | null; from_avatar: string | null;
  body: string;                 // system はサーバが作った日本語の 1 行
  created_at: string;
  is_author: boolean;
  client_id?: string;           // 送った本人の端末にだけ返す
};
type GroupSummary = { group: Group; last_message: GMessage | null; unread_count: number };
```

エラーは 1 対 1 と同じ `{ error, code }` で、code は `invalid_request`・`not_found`・`forbidden`・`rate_limited` のどれか（429 には `Retry-After` を付ける）。

## グループの写真（2026-11-06 追加。ドリキン「グループのプロフィールに写真を設定できるようにしたい」、仕様はおすすめのとおり）
- 変えられるのは**メンバーなら誰でも**（名前と同じ）。設定・取り替え・外すができる。変えると「〇〇がグループの写真を変えました／外しました」の system 行を残す。回数制限は名前の変更と同じ（`gdm-admin`、30 回/時）。
- サーバで**正方形 512px の WebP**にする（中央寄りで切り抜く・位置情報などのメタデータは落とす）。受け付けるのは JPEG・PNG・WebP・HEIC で、15MB まで。
- 置き場所は `data/gdm-photos`（public の外。`/api/media` からは読めない）。**読めるのはメンバーだけ**: `GET /api/gdm/:gid/photo`（Web はクッキー、アプリは鍵の Bearer）。
- 発言と違って 30 日では消さない。取り替えたら前のファイルを、グループが消えたらファイルを消す。
- `Group.photo` は `"/api/gdm/:gid/photo?v=…"` か null。`?v=` はファイルごとに変わるので、端末は長くキャッシュしてよい。
- 設定: Web は `POST /api/gdm/:gid/photo`（multipart の `photo`。オリジンを確かめる）、アプリは `POST /api/agent/gdm/:gid/photo`（スコープ chat）。外すのはどちらも `DELETE`。返り値は `{ group }`。
- capabilities の `features.gdm.photo: true`（`photo_max_bytes`）。無ければアプリは写真の操作を出さない。

## 配信（`/api/agent/stream` と Web の `/api/posts/stream`）
新しいイベントとして **`event: gdm`** を足す。古いアプリは知らないイベント名を無視するので、`dm` とは分けた。

- `{ action: "create", message: GMessage, group_id, group_unread_count? }` — 新しい発言（system 行も含む）。
- `{ action: "read", group_id, last_read_id, unread_count, group_unread_count }` — 自分のほかの端末で既読になった。
- `{ action: "group", group: Group }` — 名前・メンバー・mute が変わった。新しく入った人にはこのイベントで初めて届く。
- `{ action: "removed", group_id }` — 自分が抜けた・外された・グループが消えた（端末から消す）。

## push
- kind は **`"gdm"`**。`{ gdm_id, group_id }` を付ける。
- `aps.thread-id` と collapse は `gdm-<group_id>`、category は `"gdm"`。
- 表示は「B-guru グループ DM」「グループ DM が届きました」。本文は入れず、端末が `GET /gdm/messages/:id` を自分の鍵で読む（1 対 1 と同じ）。
- 送った人と、mute にしているメンバーには送らない。system 行（入った・抜けたなど）では push しない。
- 古いアプリは `dm_id` も `message_id` も無いので、本文を読みに行かずに決まり文句だけを出す。
- **read_sync** の範囲として `{ scope: "gdm", group_id, up_to }` を足す。

## capabilities
`features.gdm = { enabled, path: "/api/agent/gdm", send, max_body, max_name, max_members, ttl_hours, rate_limit_per_hour, stream_event: "gdm" }`。
stream の events と push の kinds に `"gdm"` を足す。

## 画面（各クライアント共通の考え方）
- **一覧**: DM の一覧に、1 対 1 とグループを新しい順に混ぜて並べる。グループは 👥 と表示名で出す。
- **作る**: 一覧の「＋ グループ」から作る。チャットのメンバーから複数を選び、名前は任意で付ける。
- **グループの画面**:
  - 発言は吹き出しで出し、送り主の名前とアイコンを付ける。system 行は中央に小さく出す。
  - 「メンバー」から次のことができる。
    - メンバーを見る
    - 追加する
    - 外す（作った人だけ）
    - 抜ける
    - 名前を変える
    - 🔕 通知を切る
- **未読**: 1 対 1 とグループの未読を足して DM のバッジに出す。
