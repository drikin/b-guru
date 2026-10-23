# タイムラインの表示と振る舞い（アプリの正本）

B-guru の Web のタイムラインが「どう見せて、何ができるか」の決まり。Mac/iOS・Android のアプリはこの文書と
API の `display`（下記）に合わせて作る。2026-10-22 時点の Web（`src/app/page.tsx` ほか）から書き起こした。

- 作り方は **案 C**：画面は各アプリのネイティブ。端末に関係ない表示の判断（畳むか・リアクションの並び・
  リンクのカード・メンションの位置など）はサーバが計算し、`GET /api/agent/posts?include=display` で渡す。
  アプリは基本は `display` を描くだけ。
- ただし**アプリにも同じ決まりの自前計算がある**（Mac/iOS `native/shared/PostDisplay.swift`、Android
  `TimelineDisplay.kt`）。`display` が無いとき（古いサーバ・項目の抜け）だけ使う。自前計算も §9 の**例題に合格すること**
  （Android は CI の `android-unit` ジョブで毎回確かめる）。
- 判断の正本は **`src/lib/timeline-display.ts`**。Web の画面も同じ関数を使う（ずれないように）。
- 決まりを変えるときは、この文書・`src/lib/timeline-display.ts`・例題（`src/lib/__tests__/fixtures/timeline/`）を
  **同じ変更で**直す。例題のテストが落ちれば、どこかが置いていかれている。

行番号は 2026-10-22 の作業ツリーのもの（目安。関数名で探すこと）。

---

## 1. アプリが Web と違ってよい点（オーナーの決定 2026-10-22）

| 項目 | Web | アプリ |
|---|---|---|
| 時刻 | `2026/9/28 18:40 JST / Sep 28, 02:40 PDT`（`src/lib/date-format.ts:42` `formatJSTPDT`） | **今のまま**の相対表記「たった今・N分前・N時間前・M/d」。Web に揃えない |
| 返信の見せ方 | 一覧の各投稿の下に返信を挟む（4 件以上は畳む。§6） | **スマホは今のまま**「💬 N」→ 押してスレッドを開く。一覧に挟まない（Mac/iPad で挟むかは段階 2 で決める） |
| 下書き | あり | 入れない（Web だけ） |
| 管理者向けの機能 | 部活の管理・外部リンクメニュー・部長の設定・他人の投稿の部活ラベルの付け替え（admin）など | 入れない（Web だけ） |
| Spotify | 埋め込みのプレーヤー（カードは出さない） | **普通のリンクのカードのまま**（WebView の埋め込みを入れない） |
| `#/user/<id>` | プロフィールへのリンク | **文字のまま**（アプリにプロフィール画面がまだ無いため。段階 4 でリンクにする） |
| 画像のグリッド | 1 マスの高さは画像の形のまま（上限なし） | 1 マスの高さは幅の 2 倍まで（アプリの今の作り。揃えるかは未決） |

それ以外（下の §2〜§9）は Web と同じにする。

---

## 2. API：`include=display`

`GET /api/agent/posts` と `GET /api/agent/posts/:id` に `include=display` を付けると、各投稿（スレッドでは返信も）に
`display` が付く。`include=reactions,read,display` のように他と一緒に頼める。頼まなければ付かない（古いアプリ・MCP の
返事は変わらない）。サーバが対応しているかは `GET /api/agent/capabilities` の `features.posts.display === true`
（`features.posts.include` にも `"display"` が入る）で分かる。

位置（`fold_at`・`mention_ranges[].start/end`・`user_links[].start/end`）は**すべて JavaScript の `String.length`、
つまり UTF-16 のコード単位**で数える。

- Swift：`String.utf16` のオフセット（`String.Index(utf16Offset:in:)`）。`Character` 数で数えないこと。
- Kotlin/Java：`String` の index がそのまま UTF-16。`substring(0, foldAt)` でよい。

```jsonc
"display": {
  "version": 1,
  "fold": true,                 // 本文が 500 を超えるので畳む
  "fold_at": 500,               // 畳んだときは text の先頭からここまでを出す（null = 畳まない）
  "reactions_order": ["😂", "❤️", "👍"],   // リアクションを出す順
  "reactors_more": { "😂": 0, "❤️": 2, "👍": 0 }, // 付けた人の「他N人」の N
  "image_columns": 2,           // 0〜3。1 のときは最大幅 360px
  "link_card_url": "https://www.youtube.com/watch?v=…",   // カードにする URL（無ければ null）
  "link_card": { "kind": "youtube", "url": "…", "video_id": "…", "image_aspect": "16:9", "image_max_width": 480 },
  "mention_ranges": [{ "start": 0, "end": 7, "name": "drikin" }],
  "user_links": [{ "start": 6, "end": 46, "user_id": "u_abc123" }],
  "club_label": "雑談",         // 部活ラベルの表示名（「未設定」を含む）。出さないときは null
  "club_unset": false           // 「未設定」（灰色で出す）
}
```

> 項目名はこれが正式（2026-10-22）。アプリ側で仮に置いていた名前（`collapsed`・`collapsed_length`・`truncate_at`・
> `reaction_order`・`mentions`）は使わない：`fold`・`fold_at`・`reactions_order`・`mention_ranges` に合わせること。
> メンションの位置を `mentions` ではなく `mention_ranges` にしたのは、仮の `mentions`（名前の配列・数の組の配列）と
> 型がぶつかってデコードごと失敗しないようにするため。新しい項目が増えてもアプリは読み飛ばせばよい。

`link_card.kind` は 3 通り：

- `"spotify"`：`{ url, embed_url, embed_height }`。**カードは出さず**、埋め込みのプレーヤーだけ（高さは track 152 / それ以外 352）。
- `"youtube"`：`{ url, video_id, image_aspect: "16:9", image_max_width: 480 }`。サムネを 16:9・最大幅 480px で出し、真ん中に ▶。
- `"link"`：`{ url }`。普通のカード（中身は投稿の `url_preview`）。

計算は `src/lib/agent-timeline.ts`（`timelineExtras`）→ `src/lib/timeline-display.ts`（`computePostDisplay`）。
メンションに使う会員名は Web の `/api/members` と同じ一覧（`src/lib/members.ts` `mentionMembers`）、部活名は `clubs` 表
（削除済みの部活も名前で出す）。

---

## 3. 投稿の形（DTO）

アプリ用 API・MCP が返す投稿の形は **`src/lib/agent-post-dto.ts` の `agentPostDto` ただ 1 つ**
（以前は投稿直後と since_id の取得だけ項目の少ない別の形だった）。一覧・スレッド・投稿直後（`POST /api/agent/posts`・
`POST /api/agent/publish`）・検索・MCP で同じ。

`id, author_id, author_name, author_avatar, is_author, parent_id, reply_count, text, images, video_url, audio_url,
url_preview, like_count, created_at, last_activity_at, pinned_at, club, club_manual, poll, via`
＋ `include` で `reactions`・`unread`・`unread_replies`・`display`。

- 項目は消さない・意味を変えない。足すのは自由（アプリは知らない項目を読み飛ばす：Swift の Codable・Kotlin の
  `ignoreUnknownKeys = true`）。
- メールは出さない。`author_avatar` は同じオリジンの `/api/avatar/<hash>`（gravatar の URL は出さない）。
- `via: "agent"` は AI エージェント経由の投稿。Web は名前の横に小さく 🤖（`page.tsx:1703`）。

---

## 4. カードの中身（上から順）

`PostCard`（`src/app/page.tsx:1526`）。返信も同じ部品で描く（`ReplyBubble` `page.tsx:2737`。返信ボタンと部活ラベルは出さない）。

### 4.1 見出し（名前・アイコン・時刻）

- アイコン＋名前＋（`via === "agent"` なら 🤖）＋時刻（`page.tsx:1676-1720`）。
- **名前とアイコンを押すとその人のプロフィール**（`onOpenProfile(post.authorId)` `page.tsx:1681`）。
- 時刻はアプリは相対表記のまま（§1）。
- 未読は背景が `--bg-unread`（薄い緑）。自分の投稿は未読にしない（`page.tsx:1617-1652`）。
- カードの空いている所を押すとスレッドを開く（ボタン・リンク・画像は除く）（`page.tsx:1655-1661`）。

### 4.2 操作（カード右上に横並び）

`page.tsx:1722-1835`。左から：

| 操作 | 出す条件 | 文言（aria-label / title） |
|---|---|---|
| 🔖 ブックマーク | ログイン中 | 「ブックマークに保存」/「ブックマークから外す」（付いていれば青で塗る） |
| チャットに引用 | ログイン中・本番の id | 「チャットに引用」 |
| ネタ帳に送る | ログイン中・送れる URL がある（`netaCandidates`） | 「ネタ帳に送る」 |
| ☆ お気に入り（人） | 自分の投稿以外 | 「<名前> をお気に入りに追加」/「… から外す」（付いていれば黄色） |
| リアクション（§5） | いつも | ＋ボタン（モノクロの顔に＋） |
| 📌 ピン | 自分のルート投稿だけ | 「ピン」/「ピン解除」（24 時間） |
| ✏️ 編集 | 自分の投稿 | 「編集」 |
| 🗑 削除 | 自分の投稿 | 「削除」（赤） |

カードの下には **「💬 返信 (N)」** ボタン（一覧のルート投稿だけ。N が 0 なら「返信」）（`page.tsx:2269`）。

> **「いいね」は廃止（2026-10-22 オーナー決定）**。Web からもアプリからも外した（L キー・`POST /api/posts/[id]/like`・
> `toggleLike`・いいねの通知の文言）。もう作られない「いいね」「お気に入り」の古い通知は、DB の行は残したまま一覧・未読数・API の応答から除く（`src/lib/notifications.ts` `RETIRED_NOTIFICATION_TYPES`）。気持ちを伝えるのはリアクションの ❤️。DB の `post_likes` 表と既存の行は残し、
> アプリ用 API の `like_count` も既存の項目として返し続ける（古いアプリのため。新しいアプリは使わない）。

### 4.3 部活ラベル

`page.tsx:1623-1950`。ルート投稿の見出しの下。

- 表示名は `display.club_label`。`club_unset`（AI が分類できなかった「未設定」）は**灰色の枠**、それ以外は**緑の枠・緑の字**の丸い札。
- 札の横に**漏斗のアイコン**：押すとその部活のタイムラインへ（title「「<部活名>」のタイムラインで見る」）。
- 自分の投稿なら札を押して付け替え（「部活動を選択」メニュー、最後に赤の「ラベルなし」）。札が無いときは「＋部活」。
  admin が他人の投稿を付け替えるのは Web だけ（§1）。

### 4.4 本文

`page.tsx:1951-2027`。

- 本文は Markdown（GFM・改行はそのまま改行 `src/lib/md.ts:7`）を HTML にしたもの。
- **500 文字（JS の length）を超えたら畳む**。見せるのは先頭 `fold_at` まで（500。ちょうどその手前で絵文字の
  サロゲートペアが割れるときだけ 499）。ちょうど 500 は畳まない。字のまとまり（ZWJ の絵文字・国旗・結合文字）の
  途中では切れることがある（Web と同じ。例題 9031〜9033）。
- 畳んでいるときは本文の下 4em を透明にフェードさせ、真ん中に **「続きを読む」**。開いたら下に **「閉じる」**
  （畳み直し、カードの頭が画面の上に消えていたら本文の頭まで戻す）。
- 画像・動画・音声・リンクのカード・投票は**畳んでいても全部出す**（畳むのは本文だけ）。
- **メンション**：会員名に一致する `@名前` / `@[空白 入りの名前]` だけ。大文字小文字は区別しない。`@名前さん` のように
  続けて書くと一致しない（Web と同じ）。見た目は**緑の太字（600）に薄い緑の背景・角丸 4px**（`globals.css:358`）。
  押しても何も起きない。アプリは `display.mention_ranges` の `[start, end)` を「@name」に置き換えて同じ見た目で描く
  （`@[A B]` の括弧は出さない）。畳んでいるときは `end <= fold_at` のものだけ。`@名前` の終わりは下の
  「空白」か `@` `<` `[` の手前まで。
- **ユーザーへのリンク**：本文の `#/user/<user_id>`（`https://bsm.backspace.fm/#/user/…` も）は、そのまま
  「#/user/<user_id>」と出してプロフィールへのリンクにする。`display.user_links`。古い形の `#/user/<メール>` は
  API では返さない（アプリでは普通の文字）。アプリは §1 のとおり、プロフィール画面ができるまで（段階 4）は文字のまま出す。
- 本文の普通の URL はリンク（Markdown の自動リンク）。

**空白の定義**（メンションの終わり・ユーザーリンクの終わりに使う。JavaScript の正規表現の `\s` と同じ集合）。
Swift の `NSRegularExpression`・Kotlin/Java の `\s` とは集合が違うので、自前計算ではこの表の文字を明示すること。

| 文字 | 名前 | 空白か |
|---|---|---|
| U+0009〜U+000D | タブ・改行・垂直タブ・改ページ・復帰 | 空白 |
| U+0020 | スペース | 空白 |
| U+00A0 | ノーブレークスペース | 空白 |
| U+1680 | オガム文字のスペース | 空白 |
| U+2000〜U+200A | 各種の幅のスペース | 空白 |
| U+2028 / U+2029 | 行区切り・段落区切り | 空白 |
| U+202F / U+205F | 狭いノーブレークスペース・数学用スペース | 空白 |
| U+3000 | 全角スペース | 空白 |
| U+FEFF | BOM（ゼロ幅ノーブレークスペース） | 空白 |
| U+0085 | NEL（次の行） | **空白ではない**（Java の `\s` は含む場合があるので注意。例題 9036） |
| U+200B〜U+200D | ゼロ幅スペース・ZWNJ・ZWJ | **空白ではない** |

### 4.5 画像

`page.tsx:2029-2072`。

- **切り抜かない**（元の比率のまま。高さは自動）。
- 1 枚：幅いっぱい、ただし**最大 360px**、高さは**最大 480px**（`IMAGE_SINGLE_MAX_HEIGHT`）。縦長（スマホのスクリーン
  ショットなど）は高さ 480 で止め、形を保ったまま細くする（Web は 360×480 の枠の中に左寄せで収める）。
  2026-10-22 にアプリの決まりに Web を合わせた。
- 2 枚：**2 列**。3〜5 枚：**3 列**（4・5 枚は 2 段目に続く）。`display.image_columns`。
- 押すと拡大（ライトボックス。同じ投稿の画像を送れる）。
- 画像は `/api/media/…` の縮小版（640w・1280w）を使い、拡大だけ大きいもの。

### 4.6 動画・音声

- 音声（1 投稿 1 つまで）：最大幅 560px のプレーヤーをいつも出す（`page.tsx:2074`）。外部の音声は押すまで読み込まない。
- 動画（1 投稿 1 つまで）：最大幅 560px・最大高さ 420px・黒背景・角丸 12。最初は ▶（直径 52 の黒丸）を重ね、
  **動画のどこを押しても再生**。再生を始めたら普通の操作部品を出す（`page.tsx:2091`）。
- GIF は画像として動かす。

### 4.7 リンクのカード

`page.tsx:2147-2257`。

- **本文の最初の URL 1 件だけ**（`src/lib/posts.ts:100` `firstUrl`。サーバが投稿後に取りに行き、取れたら `url_preview` に入る）。
  取りに行っている間（`url_preview` が null）はカードを出さない。
- 普通のカード：画像（あれば）→ 題名（無ければ URL）→ 説明（2 行まで）→ サイト名（無ければ URL）。押すとリンク先へ。
  画像は幅いっぱい、**高さは画像の縦横比から決め、最大 240px**（`LINK_CARD_IMAGE_MAX_HEIGHT`）。超える縦長は 240 の枠の
  中に収める（**切り抜かない**）。2026-10-22 にアプリの決まりに Web を合わせた。
- YouTube（`videoId` があるとき。空文字は普通のカード）：サムネを 16:9・最大幅 480px で出し、真ん中に ▶（直径 52）。
- Spotify：**カードは出さず**、埋め込みのプレーヤー（最大幅 480px・角丸 12・高さは track 152 / album・playlist など 352。
  高さが 0 や無いときは 152）。アプリはカードのまま（§1）。
- アプリは `display.link_card` の `kind` で出し分ける。

### 4.8 投票

`page.tsx:2259`（`PollCard`）。本文が質問なので、カードでは選択肢と結果だけ出す。作成・投票・回答の編集は段階 3。

---

## 5. リアクション

`src/components/ReactionBar.tsx`、集計は `src/lib/reactions.ts`。

- **並び：件数の多い順、同じ件数は絵文字の文字列の UTF-16 コード単位順**（`timeline-display.ts` `compareReactions`。
  JS の `<`・Kotlin の `String.compareTo` と同じ。Swift は `Array(a.utf16)` を辞書順で比べる）。
  **コードポイント順ではない**（例：👍 U+1F44D と ｗ U+FF57 は、UTF-16 では 👍 が先、コードポイント順では ｗ が先。例題 9034）。
  サーバの返す `reactions` もこの順。
- `display.reactions_order` は**サーバが並べた時点の参考**。リアクションは押すと変わるので、アプリは手元のリアクション
  （押した直後の楽観表示を含む）に**同じ規則を当てて並べる**。Web も押した直後にこの規則で並べ直す（`ReactionBar.tsx:240`）。
- 押した直後の楽観表示：自分が付けていれば外す（数を 1 減らし自分の名前を消す）、まだなら足す（数を 1 増やし、名前が
  12 人未満なら自分の表示名を足す）。他人が付けた絵文字を押したときに「外す」扱いにしない（`src/lib/reaction-optimistic.ts`）。
- チップ：絵文字＋件数。自分が付けたものは強調。カスタム絵文字は `:name:`（画像。消された絵文字は「:name:」の文字）。
- **付けた人**：Web はチップにマウスを載せると「<絵文字> N人」と、名前を「、」区切りで **12 人まで**、残りは
  **「他N人」**（`ReactionBar.tsx:142-180`）。`include=reactions` の各要素の `count` が総数、`reactors` が名前
  （最大 12 人・メールではなく表示名）。N は `display.reactors_more[emoji]`（= `count − reactors.length`）。
  アプリでは長押しやホバーで同じ文言を出す。押した直後（サーバの返事の前）に自分を足すときも表示名を使い、メールは出さない。
- 付ける：ピッカーの上段は「よく使う」12 個 `❤️ 👍 🎉 😂 🙏 🔥 👏 😮 😢 🤔 💯 ✨`、下に全部、続けてカスタム絵文字
  （`ReactionBar.tsx:39-60`）。アプリの今の 6 種からの拡張は段階 3。

---

## 6. 一覧の決まり

- 50 件ずつ読み、下まで来たら続きを読む（アプリは 30 件）。並びは最後の動き（返信が付くと上がる・`last_activity_at`）。
- 日付の区切り：「2026年8月8日 (土)」のバッジ。今日は緑で「（今日）」を付ける（`page.tsx:3723`、`date-format.ts:66`）。
  区切りの日付は最後の動きの日（JST）。
- 返信を一覧に挟む（Web・Mac/iPad の段階 2）：**4 件以上なら畳んで最新 3 件だけ**出し、上に
  **「N件のコメントを表示」**（N = 件数 − 3）、開くと **「閉じる」**（`page.tsx:2563` `CollapsibleReplies`、
  `timeline-display.ts` `replyFold`）。スマホのアプリは挟まない（§1）。
- 検索中は本文の一致箇所を強調（Web）。

---

## 7. 操作の一覧（Web にあるもの）

読む：一覧・無限スクロール・既読（見えたら既読）・スレッド・部活のタイムライン・お気に入りの人のタイムライン・
ブックマーク・検索・プロフィール。
書く：投稿（画像 5 枚まで・動画 1・音声 1・投票・部活の選択）・返信・「うなる」（スレッドを上げない返信）・編集・削除・
ピン（24 時間）・リアクション（カスタム絵文字の登録を含む）・ブックマーク・お気に入り・部活ラベルの付け替え・
チャットに引用・ネタ帳に送る。
キーボード（Web）：J/K で移動、N/P でルート投稿、Enter で開く、R で返信、C で新規、G で末尾（L のいいねは廃止）。

アプリにどれをいつ入れるかは計画（段階 1〜4）を参照。段階 3（操作）のアプリの UI の決まりは §10、
アプリが呼ぶ API の約束は §11。

---

## 8. 文言

| 場所 | 文言 |
|---|---|
| 長文 | 続きを読む / 閉じる |
| 返信ボタン | 返信 / 返信 (N) |
| 返信の折りたたみ | N件のコメントを表示 / 閉じる |
| 付けた人 | N人 / 名前、名前… 他N人 |
| 部活 | 未設定 / ＋部活 / 部活動を選択 / ラベルなし / 「<部活名>」のタイムラインで見る |
| 動画 | 動画を再生（▶） |
| 日付 | 2026年8月8日 (土)（今日） |

---

## 9. 例題データ（サーバ・アプリ共通のテスト）

- **`src/lib/__tests__/fixtures/timeline/posts.json`**：`{ apiVersion: 1, context: { member_names: [...], clubs: { key: 名前 } }, posts: [...] }`。
  `posts` はアプリ用 API の投稿の形（§3）＋ `reactions`（`include=reactions` の形）。38 件：500/501 字、割れる絵文字、
  Markdown の長文、画像 1/2/3/5 枚、YouTube、Spotify、普通のリンク、URL 2 つ、カード取得前、リアクション多数・同数、
  12 人＋他2人、メンション各種、ユーザーリンク（新旧）、部活（あり・未設定・削除済み）、返信、動画＋音声、投票、
  空の本文・画像だけ、名前 0 件で count 3、12 人／13 人ちょうど、ZWJ・国旗・結合文字が 500 をまたぐ本文、
  UTF-16 順とコードポイント順が逆になる同数の組、絵文字の直後のメンション、U+FEFF／U+0085 を含む空白、
  `videoId` が空文字、Spotify の高さ 0。見えない文字は JSON の `\uXXXX` で書いてある。
- **`src/lib/__tests__/fixtures/timeline/expected.json`**：`{ version: 1, notes: { id: 説明 }, displays: { "<id>": display }, reply_fold: [{ replies, hidden, visible }] }`。
  `displays` は手で書いた期待値（関数の出力の写しではない）。
- サーバ：`src/lib/__tests__/timeline-display.test.ts` が `computePostDisplay(post, context) == displays[id]` と、
  `mention_ranges`/`user_links` を当てはめた結果が Web の `highlightMentions(linkifyUserLinks(text))` と同じことを確かめる。
- アプリ（Swift/Kotlin）：`posts.json` の各投稿に `expected.json` の `displays[id]` を `display` として足したものを
  デコードし、「畳んだ本文が `text` の UTF-16 で `fold_at` までになる」「リアクションを `reactions_order` の順に描く」
  「`mention_ranges`/`user_links` の範囲が正しい文字に当たる（例：9017 の `[11,25)` が `@[Taro Yamada]`）」などを確かめる。
  ファイルはリポジトリのこのパスから読む（アプリのテストにコピーするなら、この 2 つを一緒に更新する）。
- 見た目は Web とアプリで同じ例題を撮って並べて見比べる（画素の比較は同じ端末の前回とだけ）。

---

## 10. 操作（段階 3・2026-10-22）

### 10.1 権限（オーナー決定：案 iii）

- `agent_tokens.app_issued`（「アプリが発行した」印）。**人のアプリのログイン**（`POST /api/agent/token` に
  `replace_same_device: true`）で発行した鍵だけ `true`。設定画面（`/settings/agent`）から発行する外部の AI エージェント用の
  鍵は、post スコープを付けても `false`。
- **この印は本人確認ではなく、鍵の使い道の目印**。誰の鍵かの確認はいつもどおりログイン（メールでの本人確認）と会員の確認で
  している。印は「人がアプリの画面から操作するための鍵か、外部の AI エージェントに渡した鍵か」を分けるためのもの。
- 既存の鍵への印付け：`initSchema` が**起動のたびに**
  `UPDATE agent_tokens SET app_issued = TRUE WHERE 'voice' = ANY(scopes) AND NOT app_issued` を流す（冪等）。目印は
  **voice スコープ**。根拠：2026-10-20 の全員再ログイン（`login-email-verify-reset`）でそれより前の鍵はすべて失効し、
  それ以降に発行できる voice 付きの鍵は、アプリのログインからのものだけ（`/api/agent/token` は 2026-10-17 から voice を
  `replace_same_device` のときにしか付けない。設定画面に voice の選択肢は無い。Android は 2026-10-18 から voice を頼む）。
  外部の鍵に voice は付かないので、毎回流しても外部の鍵には印が付かない。期限の自動延長（90 日）も同じ目印。
- **線引き（オーナー方針：外部の鍵は人の投稿に新しい操作をしない）**。段階 3 で足した操作は**アプリの鍵（app_issued ＋ post）だけ**：
  編集（画像・音声の差し替え）・削除（post で）・投票の作成（publish の `poll`）・投票・お題の編集・ピン・部活の付け替えと
  投稿時の部活の選択（publish の `club`）・お気に入りの付け外し・動画と音声（アップロードと publish の `video_url`/`audio_url`）。
  外部の鍵ではどれも 403（`code: forbidden`）。
- 外部の鍵ができるのは今までできたことだけ：write で本文だけの編集と削除（`agent-write.ts`・MCP も同じ）、post で投稿・返信・
  画像・リアクション・うなる・ネタ帳、write か post でブックマーク。**post スコープだけの外部の鍵では編集も削除もできない**（403）。
- 中身はすべて Web と同じ lib（`src/lib/post-actions.ts`・`src/lib/publish.ts`・`src/lib/upload.ts`）。Web のルート
  （`/api/posts/[id]`・`/pin`・`/club`・`/api/poll/*`・`/api/favorites`）も同じ関数を呼ぶ。ピンと部活の付け替えは
  ルート投稿だけ（返信は 400。Web も同じ）。

### 10.2 アプリの UI の決まり（文言の正本）

- **メニュー**：投稿の長押し（iOS・Android）／右クリック（Mac）。Mac はカード右上のボタンにも並べてよい。項目と順番：
  1. 「ブックマーク」/「ブックマークを外す」
  2. 「チャットに引用」
  3. 「ネタ帳に送る」（送れる URL があるとき）
  4. 「お気に入りに追加」/「お気に入りから外す」（他人の投稿）
  5. 「リアクション」
  6. 「ピン（24時間）」/「ピンを外す」（自分のルート投稿）
  7. 「部活動を選択」（自分のルート投稿）
  8. 「編集」（自分の投稿）
  9. 「削除」（自分の投稿・赤）

  出すかどうかは `capabilities.features.posts` の各項目で決める（項目が無い＝古いサーバ＝出さない）。アプリの鍵で post は
  あるのに `edit` が false のとき（印の付く前の鍵など）、自分の投稿のメニューには「編集」「削除」の代わりに
  **「編集するには一度ログインし直してください」**（押せない説明行）を出す。
- **数字と単位の間に空白を入れない**（「5人」「24時間」「3票」）。
- **削除**：確認を出す。題「投稿を削除」、本文「この投稿を削除しますか？この操作は取り消せません。」、ボタン「キャンセル」
  「削除する」（赤）。失敗したら確認の中にサーバの `error` を赤で出す。
- **編集**：題「投稿を編集」、ボタン「キャンセル」「保存する」。画像は差し替え（並べ直し・外す・足す、5枚まで。その投稿に
  もう付いている画像は Web から付けたものでも残せる）、音声は付ける・外す。動画は付け替えられない（Web と同じ）。返信も同じ。
- **うなる**：返信の入力欄で「吠える」（青）の左に「うなる」（薄い青）。うなるとスレッドを上げず、**全員へのプッシュは出ないが、
  親の投稿者への返信の通知（とメンションの通知）は出る**（Web と同じ）。ルート投稿には無い。
- **投稿の添付**：画像（5枚まで）・動画1本・音声1本・投票。動画と音声は同時に付けられない。**投票と画像は同時に付けられる**
  （Web と同じ）。動画・音声は 100MB まで。部活は投稿時に選べる（選ばなければ AI が自動で分類）。
- **投票**：カードは Web のとおり。見出し「📊 投票（N票）」、選択肢の状態は「投票する」「投票済み」「投票が終了しました」
  （「投票済み：…」のような補足は付けない）。選択肢を押すと投票（もう一度別の選択肢を押すと変更）。投稿者は投稿後1時間だけ
  「回答を編集」（題「アンケートの回答を編集」）。票の付いた選択肢は消せない。回答は3〜10個。
- **ピン**：自分のルート投稿だけ。24時間で外れる。1人1件（新しくピンすると前のは外れる）。ピンの一覧が空のとき
  「ピンはありません。自分の投稿の右上にあるピンアイコンから、その投稿を24時間ピン留めできます。」
- **ブックマーク・お気に入りのトースト**：押したらすぐ塗る（楽観表示）。トーストは「ブックマークに保存しました（タップで取り消し）」
  「ブックマークから外しました（タップで取り消し）」「<名前> をお気に入りに追加しました（タップで取り消し）」
  「<名前> をお気に入りから外しました（タップで取り消し）」。**Mac は「…（クリックで取り消し）」**。ブックマークは
  `{ post_id, bookmarked: true|false }` で送る（冪等。取り消しもこれで戻す）。状態は投稿の `bookmarked_by_me`・`favorite_by_me`。
- **部活動を選択**（既存の投稿の札）：部活の一覧（今の部活に ✓）→ 最後に「ラベルなし」（赤）。札の読み上げは
  「部活：<部活名>（変更）」、札が無いときは「＋部活」（読み上げ「部活を付ける」）。Web とアプリで同じ。
- **投稿時の部活**（新しい投稿だけ・返信には出さない）：「部活：自動で分類（AI）」が既定。押すと一覧の先頭に
  「自動で分類（AI）」、続けて「部活動を選択」の見出しの下に部活（今の部活カタログの active なもの・既存の札のメニューと同じ）。
  選ぶと「部活：<部活名>」になり、投稿は `club_manual` で AI の自動分類をしない。Web にも 2026-10-22 に入れた。

**投票の作成と回答の編集：2026-10-22 時点の差の記録**（「揃えた先」が「同じ」以外の行は、この日に揃えた差。
今は Web とアプリで同じ。違いが残るのは「そのまま」の行だけ）

| 項目 | Web（揃える前） | アプリ | 揃えた先（今の決まり） |
|---|---|---|---|
| 回答の文字数 | 入力は無制限（サーバで 400） | 100字で止める | アプリ（Web も入力欄で100字まで） |
| 回答が3つ未満で Enter | 投票を黙って外して投稿していた | 送れない | アプリ（Web も送らない） |
| 回答の編集で空の行 | 空のまま送って 400 | 空を除いて送る | アプリ（Web も空を除き、前後の空白を落とす） |
| 本文の案内（投票を付けたとき） | 「今なにしてる？」のまま | 「投票の質問」 | アプリ |
| アンケートをやめる | 下の「投票を外す」だけ | 見出しに ✕ | 両方（Web も見出しに ✕ を足し、「投票を外す」も残す） |
| 投票を付けるボタン | 「投票を追加」/「投票を外す」 | 「投票」（トグル） | そのまま（画面の作りの違い。意味は同じ） |
| 回答の並べ替え・途中への追加 | 無し（末尾に追加） | 無し（末尾に追加） | 同じ（サーバは並べ替え・途中への追加もできる） |
| 締切 1/6/12/24時間・回答3〜10個・質問は本文・回答の編集は投稿後1時間・票の付いた回答は消せない | 同じ | 同じ | 同じ |
| 部活の選択 | 無し | あり | アプリ（Web に足した） |
| 質問（本文）の 200字 | 送ってからサーバで 400 | — | Web は送る前に止める（ボタンを押せなくし、赤で「投票の質問（本文）は200字までです（いまN字）」）。アプリも同じにする |
| 回答が3つ未満で送る | ボタンが押せない（案内なし） | 送れない | 押すと「回答を3つ以上入れてください」（Enter でも同じ） |
| 部活で絞った一覧から投稿 | — | — | その部活を初めから選んでおく（「自動で分類（AI）」に戻せる） |
| 投稿に失敗したとき | 入力が消えていた | — | 本文・画像・動画・音声・投票・部活を元に戻す |
- **カスタム絵文字**：リアクションのピッカーの最後に `GET /api/agent/emojis` の絵文字（画像）。送るのは `":name:"`。登録は Web だけ。
- **メンションの補完**：`@` を打ったら `GET /api/agent/members` の名前で候補を出す。空白を含む名前は `@[名前]` で入れる。
  候補が空でも入力は止めない（サーバは Ghost に届かないとき空の一覧を返す）。
- **エラーの文言**：サーバが返す `error`（日本語・Web と同じ文言）をそのまま出す。`code` は出し分けに使う
  （`rate_limited` は「少し時間をおいてから試してください」、`token_expired`・`unauthorized` はログインし直し、
  アップロードの 503 は「混み合っています」なので少し待って送り直す）。

- 印を外したいとき：voice を持つ鍵には起動のたびに印が付き直すので、手で `app_issued` を false にしても戻る。外すには鍵を失効させる。

### 10.3 古いアプリ・外部エージェントへの影響

| 相手 | 変わること | 変わらないこと |
|---|---|---|
| 今のアプリ（段階 2 まで） | 投稿の形に `bookmarked_by_me`・`favorite_by_me` が増える（読み飛ばせばよい） | 一覧・スレッド・投稿・画像のアップロード（`{ urls }`）・リアクション・既読。鍵の作り直しは不要（voice の鍵には起動のたびに印が付く） |
| 段階 2 以前にログインした古いアプリ（voice の無い鍵） | なし（2026-10-20 に全部失効済み。ログインし直した鍵には voice がある） | — |
| 外部の AI エージェント（write） | なし。段階 3 の新しい操作は使えない（403） | `PATCH`/`DELETE /api/agent/posts/:id`（本文だけ・write の枠 1 時間 10 回）、ブックマーク（write の枠）、MCP のツール |
| 外部の AI エージェント（post を持つ） | リアクションの枠が post（1 時間 60）から post_light（1 時間 300）に変わった。段階 3 の新しい操作（投票・ピン・部活・お気に入り・動画・音声・編集・削除）は 403。publish に `club`・`poll`・`video_url`・`audio_url` を付けると、以前は読み捨てて投稿できたが今は 403（付けなければ今まで通り）。お気に入りの付け外しは 403 だが一覧 `GET /api/agent/favorites` は read で読める | 投稿・返信・画像・リアクション・うなる・ネタ帳・ブックマーク |
| Web | 編集・削除・ピン・部活・投票・お題の編集・お気に入りの中身を lib に移した（返事の形・文言は同じ）。画像の差し替えで文字列でない値は 400。ピン・部活の付け替えは返信だと 400（画面には元から出ない）。お題の編集で他の投票の選択肢・重複・空の回答は 400。大きなアップロード（10MB 超）が同時に 4 本目なら 503。@の候補は Ghost に届かなくても 200（空か古い一覧）。投稿画面に部活の選択（`/api/publish` に `club`）を足し、投票の作成・回答の編集をアプリに揃えた（§10.2 の表） | 札のメニュー |

---

## 11. アプリが使う API の約束（段階 0〜3）

アプリ（Mac/iOS・Android）が呼ぶ `/api/agent/*` の約束をここにまとめる。形を変えるときは、項目を消さない・意味を変えない・
足すだけ。足したら `capabilities` で知らせる。正本：`src/app/api/agent/**/route.ts`、OpenAPI は `GET /api/agent/openapi.json`。

**共通**
- 認証：`Authorization: Bearer <token>`。鍵はアプリのログインで発行（`POST /api/agent/token`、`replace_same_device: true`、
  スコープ `read, read_state, chat, post, voice`）。アプリの鍵は `app_issued`（§10.1）で、使うたびに 90 日延びる。
- 成功は `{ apiVersion: 1, … }`（アップロードだけ `{ urls }` / `{ video_url }` / `{ audio_url }`）。失敗は `{ error, code, hint? }`。
  `code`：`unauthorized`・`token_expired`・`membership_ended`・`membership_unavailable`・`rate_limited`・`not_found`・`forbidden`・
  `invalid_request`・`server_error`。`error` は日本語でそのまま見せてよい。
  - `unauthorized`・`token_expired` だけが「ログインし直し」。`membership_ended`（403）は会員でなくなった（鍵も失効）。
  - `membership_unavailable`（503）は会員情報を一時的に確認できないだけ。ログアウトさせず「会員情報を確認できません。
    少し時間をおいて試してください」を出し、少し待って読み直す。
- 会員の確認（オーナー決定 2026-10-22）：鍵ごとに 6 時間に 1 回、Ghost に会員かを問い合わせる（4 秒で打ち切り）。
  Ghost に届かない（打ち切り・接続失敗・5xx）ときは、前回の確認の成功から **24 時間以内なら通す**（確認の時刻は更新しない）。
  24 時間を超えていたら 503 `membership_unavailable`。届かなかったことは 30 秒覚え、その間は問い合わせずにこの判定だけをする
  （毎回 4 秒待たせない）。Ghost が「会員でない」と答えたときは今までどおりすぐ 403 `membership_ended`。Ghost が 4xx を返す・
  設定の誤りのときは猶予なしで 503 `membership_unavailable`。Web のセッションには定期の会員確認が無い（ログインのときだけ）。
- 回数の上限（鍵ごと・オーナー決定 2026-10-22）。超えると 429（`code: rate_limited`、`hint` に何秒後か）。

  | 枠 | 上限 | 数える操作 |
  |---|---|---|
  | read | 120回/分 | 一覧・スレッド・capabilities・絵文字・お気に入りの一覧・メンションの候補・部活の一覧 |
  | read_state | 60回/分 | 既読 |
  | post | **60回/時** | 投稿・返信（publish）・アップロード・編集・削除・お題の編集・ネタ帳 |
  | post_light | **300回/時** | 軽い操作：リアクション・投票・ブックマーク・お気に入りの付け外し・ピン・部活の付け替え（post スコープで通ったとき） |
  | write | 10回/時 | 外部の AI エージェント（変えない）。write を持つ鍵のブックマーク・編集・削除はこの枠のまま |

  post と post_light は別々に数える（リアクションを続けても投稿の枠は減らない）。**リアクションの枠の変化**：以前は post の枠
  （1時間60）で数えていたが、post_light（1時間300）に移した。post と write の両方を持つ外部の鍵のリアクションも post_light になる。
- アップロードのうち 10MB を超えるものは、サーバ全体で同時に 3 本まで解析する。超えたら 503（`Retry-After: 10`、`code: busy`）。
  `Retry-After` の秒数だけ待って送り直す。アップロードの失敗の `code`：`busy`（混み合い）・`too_large`（大きすぎる）・
  `unsupported`（形式が非対応・外部の鍵で動画や音声）・`invalid_request`。
- @の候補（`/api/agent/members`）とタイムラインの `display` のメンションは Ghost（会員の一覧）を使う。Ghost への問い合わせは
  4 秒で打ち切り、古い一覧があれば待たずにそれを返して裏で取り直す（同時に 1 本だけ）。失敗したら 30 秒は取り直さない。
  `include=display` は Ghost を待たない（一覧がまだ無ければメンション無し＝`mention_ranges: []` で返す。次の読み込みで付く）。
- 配信するファイル（`/api/media/…`・`/api/img`・`/api/avatar/…`）は `X-Content-Type-Options: nosniff`。
- 起動時に `GET /api/agent/capabilities` を読み、`features.posts` に無い操作は出さない。知らない項目は読み飛ばす。
- `features.mac_assistant`（boolean）：Mac のアシスタント機能を出すか。サーバの `MAC_ASSISTANT_ENABLED`（未設定＝誰にも出さない・
  メールのカンマ区切り＝その人だけ・`1`＝全員。`src/lib/feature-flag.ts`）を、鍵の持ち主のメールで判定する。最初はオーナーだけ。
  false か項目が無ければ Mac アプリは出さない。
- 投稿の形・`include`・`display` は §2・§3。位置はすべて UTF-16。

「アプリの鍵」= `app_issued` ＋ post（§10.1）。外部の鍵では 403。

| 何を | メソッドと道 | スコープ（枠） | 送るもの | 返るもの・決まり |
|---|---|---|---|---|
| 一覧 | `GET /api/agent/posts` | read | `limit`（≤100）・`cursor`・`since_id`・`club`・`search`・`author_user_id`・`fav=1`・`bm=1`・`pinned=1`・`include=reactions,read,display` | `{ posts, next_cursor }`。`pinned=1` は今ピン中だけ・ピンした古い順・`next_cursor` は null |
| スレッド | `GET /api/agent/posts/:id` | read | `include` | `{ post, replies }` |
| 投稿・返信 | `POST /api/agent/publish` | post（post） | `{ text, images?, parent_id?, whisper?, video_url?, audio_url?, poll?: { question, options[], duration_hours? }, club? }`（`video_url`・`audio_url`・`poll`・`club` はアプリの鍵だけ） | 201 `{ post }`。画像5枚まで・動画と音声はどちらか1つ・投票と画像は一緒に付けられる・どれもアップロードしたものだけ。`whisper` は返信だけ。`club` はルート投稿だけ（付けたら自動分類しない）。投票は回答3〜10個・締切 1/6/12/24時間。同じ本文の30秒以内の二重投稿は前の投稿を返す |
| アップロード | `POST /api/agent/upload`（multipart） | post（post） | `images[]`（5枚・合計50MB・jpeg/png/webp/gif）、アプリの鍵だけ `video`（mp4/webm/mov・100MB）か `audio`（mp3/m4a/aac/wav/ogg/opus/webm/flac・100MB） | 201 `{ urls }` / `{ video_url }` / `{ audio_url }`。1回に1種類。外部の鍵の動画・音声は 400「画像だけ送れます」 |
| 編集 | `PATCH /api/agent/posts/:id` | アプリの鍵: post（post）／外部: write（write） | アプリ：`{ text, images?, audio_url? }`（`images` は差し替え、`audio_url: null` で外す） | `{ updated: true }`。自分の投稿だけ（Web と同じく自分の投稿すべて）・エピソード投稿は不可・動画付きに音声は付けられない・新しく足す画像はアップロードしたものだけ（もう付いている画像は残せる） |
| 削除 | `DELETE /api/agent/posts/:id` | アプリの鍵: post（post）／外部: write（write） | — | `{ deleted: true }`。自分の投稿だけ・エピソード投稿は不可 |
| ピン | `POST /api/agent/posts/:id/pin` | アプリの鍵（post_light） | — | `{ ok, pinned }`。付け外しの切り替え・自分のルート投稿・24時間・1人1件 |
| 部活の付け替え | `PATCH /api/agent/posts/:id/club` | アプリの鍵（post_light） | `{ club: "<key>" \| null }` | `{ ok, club }`。投稿者のルート投稿だけ。キーは `GET /api/agent/clubs` |
| 投票 | `POST /api/agent/posts/:id/poll/vote` | アプリの鍵（post_light） | `{ option_id }` | `{ ok, poll }`。締切後は 403「投票は終了しました」 |
| お題の編集 | `PUT /api/agent/posts/:id/poll` | アプリの鍵（post） | `{ question?, options: [{ id\|null, label }] }` | `{ ok, poll }`。投稿者だけ・投稿後1時間・票の付いた選択肢は消せない・id はこの投票の選択肢だけで重複不可・空の回答は不可・回答3〜10個。並びは送った順（並べ替え・途中への追加もできる） |
| リアクション | `POST /api/agent/reactions` | post（post_light）か write（write） | `{ post_id, emoji }`（カスタムは `":name:"`） | `{ added, reactions }`（切り替え） |
| カスタム絵文字 | `GET /api/agent/emojis` | read | — | `{ emojis: [{ id, name, image_url }] }` |
| ブックマーク | `POST /api/agent/bookmarks` | write（write）か post（post_light） | `{ post_id, bookmarked?: true\|false }` | `{ bookmarked }`。`bookmarked` を送ればその状態に（冪等・`capabilities` の `bookmarks_set`）、無ければ切り替え。一覧は `posts?bm=1` |
| お気に入り（人） | `GET` / `POST` / `DELETE /api/agent/favorites` | read ／ アプリの鍵（post_light） | `{ user_id }` | `{ user_ids }` / `{ favorited }`（冪等）。自分自身は 400。お気に入りの人の投稿は `posts?fav=1` |
| メンションの候補 | `GET /api/agent/members` | read | — | `{ members: [{ user_id, name, avatar }] }`。Ghost に届かないときは古い一覧か空（200） |
| 部活の一覧 | `GET /api/agent/clubs` | read | — | 部活のキーと名前 |
| 既読 | `POST /api/agent/read` | read_state | `{ post_ids: [...] }`（500まで） | `{ marked }` |
| ネタ帳 | `POST /api/agent/neta` | post（post） | `{ url, title, description? }` | — |
| 機能の可否 | `GET /api/agent/capabilities` | （鍵があれば） | — | `features.posts`：`edit`・`delete`・`edit_text_only`・`whisper`・`video`・`audio`・`max_media_mb`・`poll`・`poll_vote`・`poll_edit`・`pin`・`pinned_list`・`bookmarks`・`bookmarks_set`・`favorites`・`custom_emoji_list`・`club_select`・`club_change`・`mentions`・`display`・`include`。アプリの鍵だけの操作は外部の鍵では false |
