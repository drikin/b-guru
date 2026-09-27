# 未読管理のサーバー永続化 — 設計（確定版）

tochi 2026-09-27 21:52 JST「PCとスマホの両方でみた場合に、未読管理を共通管理にしたいですね。
今はブラウザベースのローカル管理になっていると思うので、DB管理になってしまうので大変なのは
分かっているんですが・・・」

どりきん（オーナー）の制約:
- **パフォーマンスは必ず低下しない、もしくは良くなる方向**
- **既存のユーザーから見た振る舞いは変えない**
- 一時的に全部未読になっても、そこまで心配しなくてよい

## 実測した事実（すべて本番で確認済み）

| 項目 | 実測値 |
|------|--------|
| アクティブユーザー | 151人 |
| **複数端末（複数セッション）利用者** | **82人 = 54%** |
| posts | 5,647行（ルート1,667 / 返信3,980） |
| 1ユーザー最大の投稿数 | 1,576 |
| 描画カード数（1440px） | 112枚（うち未読95枚） |
| `forum_read_state` | 84行、最終更新 2026-08-30（**デッド**） |
| `chat_read_state` | 175行、2026-09-28 更新（稼働中） |
| `notifications` | 1,270行 / 未読508（per-row `read_at` の先行例） |
| DB プール | `max: 10` |
| pm2 | `fork_mode`（単一プロセス） |
| nginx `client_max_body_size` | 85m |

## なぜカーソル方式（forum_read_state）を使わないか

**実測で構造的欠陥を証明:**

1. **返信IDは常に親より大きい** — `SELECT count(*) FROM posts c JOIN posts p ON c.parent_id=p.id WHERE c.id < p.id` → **0件**。カーソルだと「返信5987を読んだ」→ 親5902も既読扱いになる
2. **`COLLAPSE_THRESHOLD = 4`** — 返信4件以上のスレッドは折りたたまれ、親カードだけが見えて返信は非表示。「親は見えたが返信は見えていない」が通常のUIで頻繁に発生する。カーソルだと折りたたみを開いたときに未読ハイライトが出ない
3. **実際に2日で撤回された** — `c3b3b11`（部活バッジを未読数に）→ `df70d9f`（直近7日アクティビティ数に置換）。コミットメッセージに「forum_read_state はデッドスキーマとして残置」と明記

## 設計

### 方針

**既読の粒度（post.id 単位・返信独立・自分の投稿除外）は一切変えない。保存先だけを DB に移す。**

localStorage は**削除せず、同期ファーストペイントのキャッシュ**として残す。
- PostgreSQL = 権威（複数端末で共有）
- localStorage = 同期キャッシュ（初回ペイントを現行と同一に保つ）

これは「重複実装」ではなく**キャッシュ層**。役割を明確に分ける。

### テーブル

```sql
CREATE TABLE IF NOT EXISTS post_read_state (
  email   TEXT    NOT NULL,
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  PRIMARY KEY (email, post_id)
);
CREATE INDEX IF NOT EXISTS idx_post_read_state_email ON post_read_state(email);
```

- **`read_at` は持たない** — GET は `readIds` しか返さないので write-only の列になる。`forum_read_state` をデッドスキーマにしたのと同じ過ちを避ける
- **剪定（N=2000）はしない** — `jump-to-post` は最大80ページ×50 = **4,000ルートまで遡ってマウントする**（`while (guard < 80)`）。剪定すると古い投稿が未読として復活する。5,647行 × 151人 = 最大85万行は PostgreSQL では無視できる規模

### API

**新規 GET エンドポイントは作らない。** 既存の `/api/posts` と `/api/posts/[id]` のレスポンスに `readIds` を同梱する。

- `listPosts` は既に `viewerEmail` を受け取っている（`src/lib/posts.ts:307`）ので、`post_read_state` を JOIN するだけ
- **往復ゼロ増** — フィードは既に毎回 `/api/posts?limit=50` を叩いている

**書き込みのみ新規:**

```
POST /api/posts/read
ボディ: { ids: number[] }
```

```sql
INSERT INTO post_read_state (email, post_id)
SELECT $1, u FROM unnest($2::int[]) u
WHERE EXISTS (SELECT 1 FROM posts p WHERE p.id = u)
ON CONFLICT DO NOTHING
```

**★ `WHERE EXISTS` は必須。** 実測で証明:
```
ON CONFLICT DO NOTHING だけ → ERROR: violates foreign key constraint（文全体がアボート）
WHERE EXISTS を挟む        → INSERT 0 1（生きているIDだけ入る）
```
クライアントが楽観更新した後に他ユーザーが投稿を削除すると、そのバッチの**生きているIDも全部失われる**。クライアントは成功と誤認して再送しないので、既読がサイレントに欠落する。

**サーバー側バリデーション（必須）:**
- `ids.length` の上限（500）— 85MB ボディ + プール10 + fork_mode なので、数リクエストでサイト全体が無応答になる
- `Number.isInteger` で非整数・負数・0 を除外（`$2::int[]` は `1.5` を丸めるので、サーバー側で弾かないと意図しないIDが入る）
- 既存の `rateLimit` パターン（`src/app/api/posts/proofread/route.ts:13`）を流用

### クライアント

**購読の粒度を直す（これがパフォーマンス改善の本命）:**

現行は `PostCard` が1枚ごとに `useSyncExternalStore` を購読している（`page.tsx:1252`）。実測で **112個の購読**があり、`markReadId` 1回で **112枚が全部再レンダリング**される。しかも `PostCard` は `memo` されていない（`page.tsx:1188`）。

→ **カード単位の購読に変える**（`isReadId(id)` を id ごとに購読）。既読1件につき1枚しか再レンダーしない。

**書き込みを減らす:**
- デバウンスを長め（5〜10秒）に
- `visibilitychange` / `pagehide` で `navigator.sendBeacon` により最終バッチを確実に送る
- 可能なら**ページ離脱時に1回**に集約（スクロール中の POST をゼロにする）

**localStorage の同期コストも消える:**
現行は `markReadId` ごとに `new Set(readStore.read)` の全コピー + `JSON.stringify` + **同期ブロッキングな `localStorage.setItem`** を実行（`page.tsx:892-897, 868-873`）。dirty-set + rAF/アイドル時のフラッシュに変えれば現行より速くなる。

**ログアウト時に localStorage をクリア（必須）:**
現行の `logout()` は `setAuth(null)` と `setFeedPosts([])` のみ（`page.tsx:6508-6512`）。共用端末でAがログアウト→Bがログインすると、**Aの既読SetがBのアカウントに恒久保存される**。サーバー化で新たに生じるデグレ。

**401 の扱い:**
クライアントに 401 検知が皆無（`grep '401' src/app/page.tsx` は SVG パスにヒットするのみ）。セッションは30日TTL。期限切れ後は POST が静かに401を返し続け、**既読が一切保存されないことに誰も気づかない**。401 で localStorage に降格する処理を入れる。

**`enabled` はサーバーに送らない:**
`BGURU_UNREAD_ON_KEY`（自動既読 ON/OFF）は**端末ローカル設定**。テーブルに `enabled` 列は無く、サーバーが返す出所も存在しない。GET のレスポンスに含めない（含めると端末Aの設定が端末Bに伝播する振る舞い変更になる）。

### 移行

**順序厳守: GET → localStorage Set と和集合 → サーバーに無い分を POST**

逆順にすると既読が消える。初回1回だけ、フラグで二重実行防止。localStorage はキャッシュとして残す。

移行ロジックは `mergeReadState(localIds, serverIds)` として**純関数に切り出す**（page.tsx に埋めない）。テスト可能にするため。

## パフォーマンスの収支

| 項目 | 現行 | 設計後 |
|------|------|--------|
| 初回ペイント | localStorage 同期読み | **同一**（キャッシュを同期読み） |
| 既読の取得 | 0往復 | **0往復**（`/api/posts` に同梱） |
| 既読1件の再レンダリング | **112枚** | **1枚**（カード単位購読） |
| localStorage 書き込み | 既読1件ごとに全コピー+同期setItem | dirty-set + アイドル時フラッシュ |
| サーバー書き込み | 0 | 離脱時1回のバッチ |

**結論: 体感は現行より良くなる。** 往復は増えず、再レンダリングは 112分の1 になる。

## テスト（実装前に書く）

**P0 — 移行の既読消失を防ぐ**
1. `mergeReadState` の純関数テスト（逆順実装で落ちること）
2. 和集合の不変条件（`merged ⊇ local` かつ `merged ⊇ server`）
3. 二重実行防止フラグ
4. 移行失敗時に localStorage が消えないこと

**P0 — 書き込み量の暴走を防ぐ**
5. デバウンス（50回呼んで POST 1回、ids 50件）
6. 重複排除
7. 既読済みIDの再送禁止
8. 楽観更新（API 応答を待たずにハイライトが消える）
9. 送信失敗時の再キュー

**P1 — 境界値・異常系**
10. 未ログイン / セッション切れ（401）
11. 空配列・不正入力（`["a", null, -1, 1.5]`）
12. **存在しない post_id で FK 違反しないこと**（`WHERE EXISTS` の検証）
13. 投稿削除 → CASCADE
14. 複数タブ同時（`ON CONFLICT DO NOTHING`）
15. **返信独立の粒度**（返信5987を既読にしても親5902が既読にならない）
16. 単調性（取り消しAPIが存在しない）

**P1 — E2E ガード追加**
17. 既読の永続化（1.5秒表示 → リロード → ハイライトが消えている）
18. 移行の実地検証（localStorage に既知のID集合を仕込み、リロード後も既読）
19. 書き込み量（3秒スクロールして POST 回数が閾値以下）
20. **複数端末シナリオ**（セッションAで既読化 → 別contextでリロード → 反映される）← 54%のユーザーへの核心的検証
21. 既存ガードの非破壊確認

**P2 — デグレ証明**
22. 移行順序を逆にした壊れたビルドを `deploy.sh --no-ci` でデプロイし、テスト18が FAIL することを実証

## やらないこと（明示）

- `forum_read_state` の再利用・復活（カーソル方式は構造的に使えない）
- 部活バッジを未読数に戻す（`df70d9f` で意図的に撤回済み。tochi の提案は「タイムラインの未読」であり別物）
- 「タイムラインを見たら全既読」の一括クリア（撤回の直接原因）
- 保持件数の剪定（`jump-to-post` の4,000ルート遡行と衝突する）
- `read_at` 列（write-only になる）
- GET レスポンスの `enabled`（端末ローカル設定であり、サーバーの出所が無い）
