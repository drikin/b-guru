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

アプリにどれをいつ入れるかは計画（段階 1〜4）を参照。

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
