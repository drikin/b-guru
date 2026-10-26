# 🍻 オフ会 — 仕様（v1, 2026-10-25）

突発オフ会に来られない人が、チャットからオンラインで参加している気分になれるようにする。
現地の 1 台が声を流し、みんなで写真を上げ、写真はアルバムとして開催中も終わったあとも振り返れる。
サーバは `src/lib/offkai.ts`。

## 決めたこと（ドリキン 2026-10-25）

- 置き場所: チャットの下のタブ（テキスト・☗・🎮・📺）に「🍻」。開くとチャットの上（Mac・広い画面は横）にオフ会の面、
  チャットはそのまま使える。開催中はタブに点。
- 始める: 誰でも「🍻 オフ会を始める」（場所・ひとこと、どちらも任意で短い）。**同時に 1 つだけ**（ほかが開催中なら 409 `busy`）。
- 終わる: 始めた人・管理者が「終了」（話す人は後勝ちで誰でもなれるので含めない。security-reviewer 2026-10-25）。
  押し忘れても **開始から 6 時間で自動で終わる**。
- 声: 現地の 1 台が流し、ほかの人は聞く。**話せるのは常に 1 人。後から「🎙 話す」を押した人に切り替わる（後勝ち）**。
  同じ部屋の複数のマイクはハウリングと二重音声になるため。オンラインの人は声を出さず、チャットで参加する
  （「話す」は誰でも押せるが、画面の言葉は「現地から話す」）。
- 写真: 現地・オンラインを問わず、🍻 の 📷 から上げる。チャットにも流れ（24 時間で消えるいつものチャット）、
  **同じ写真をアルバム用に別に保存する**（チャットの写真は 24 時間でファイルごと消えるため）。
- アルバム: そのオフ会の写真を時系列で。開催中も終了後も **会員全員が見られる**。終わったオフ会は 🍻 のアーカイブから
  いつでも開ける。自分の写真は自分で消せる（管理者も消せる）。
- 知らせ: **始まったときに 1 回だけ全員へ push**（写真ごと・話す人の交代では知らせない。同じ人が終えて 1 時間以内に
  始め直したのは、やり直しとみなして知らせ直さない）。チャットには始まり・終わりを B-guru の小さな行（notice）で出す。
- 終わったら、タイムラインにビーグルから「🍻 オフ会（題）のアルバム（写真 N 枚）」を 1 本（写真が 1 枚以上あるときだけ。
  先頭 4 枚を添付）。
- 写真は 1 人 1 オフ会 200 枚まで。位置情報などを落とせない写真は断る（ずっと残るため）。
- アプリからの操作（始める・話す・写真・終える）はアプリの鍵だけ。外部の鍵（設定画面で発行）は読むだけ。
- 公開: `OFFKAI_ENABLED`（featureEnabledFor。最初はオーナーだけで試し、全員公開はオーナーに確認してから）。

## サーバ

### 表

```
offkai_events (
  id SERIAL PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',          -- 場所・ひとこと（40 文字まで）
  started_by_email TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at TIMESTAMPTZ NOT NULL,            -- started_at + 6h
  ended_at TIMESTAMPTZ,                    -- null = 開催中
  ended_by_email TEXT,                     -- null = 自動
  speaker_email TEXT,                      -- いま話している人（null = だれも）
  speaker_since TIMESTAMPTZ,
  speaker_left_at TIMESTAMPTZ,             -- 話す人が部屋から出た時刻（60 秒戻らなければ speaker を空に）
  version INT NOT NULL DEFAULT 1,          -- 変わるたびに +1（古い知らせを捨てる。📺 と同じ）
  finalized_at TIMESTAMPTZ,                -- 終了の後処理（部屋を消す・notice・タイムライン投稿）が済んだ
  summary_post_id INT                      -- 終了時のタイムライン投稿
)
-- 開催中は 1 つだけ: CREATE UNIQUE INDEX ... ON offkai_events ((true)) WHERE ended_at IS NULL
offkai_photos (
  id SERIAL PRIMARY KEY,
  event_id INT NOT NULL REFERENCES offkai_events(id) ON DELETE CASCADE,
  path TEXT NOT NULL,                      -- /api/media/offkai-…（チャットの掃除の対象外）
  uploader_email TEXT NOT NULL,
  caption TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
)
```

開催中かどうかは `ended_at IS NULL AND ends_at > now()`。期限を過ぎたものは、読むとき・始めるとき（同じトランザクション）・
1 分ごとの見回り（起動時にも 1 回）で終わらせる（自動終了の ended_at は ends_at）。終わらせるのは
`UPDATE … WHERE id = $1 AND ended_at IS NULL RETURNING` に勝った 1 者だけで、後処理もその 1 者がする。後処理が途中で
落ちても、見回りが `ended_at IS NOT NULL AND finalized_at IS NULL` をやり直す（冪等）。始めるときの 23505 は 409 `busy`。

### 声（LiveKit）

- ボイスルーム（`bguru-lounge`）とは別の部屋 `bguru-offkai-<id>`。
- 参加の鍵（2 分）: 話す人には `canPublish: true, canPublishSources: ["microphone"]`、ほかは聞くだけ（`canPublish: false`）。
- 話す人の交代（後勝ち）: `speak` は DB の speaker を `SELECT … FOR UPDATE` で直列に書き換えるだけ。LiveKit は
  **`reconcileSpeaker(eventId)` 1 本**で DB に合わせる（ListParticipants → speaker 以外で can_publish を持つ人を取り上げ、
  speaker に与える）。走らせるのは speak・end のあと、webhook の participant_joined / left、10 秒ごとの見回り。プロセス内で
  同時に 1 本だけ（pm2 は 1 インスタンス）。`UpdateParticipant` の `permission` は全体の置き換えなので、毎回
  `can_subscribe: true, can_publish_data: false, can_publish_sources` まで全部送る。
- 話す人が部屋から出たら（participant_left）、60 秒戻らなければ speaker を空にする。画面の「◯◯が話しています」は
  その人が部屋にいるときだけ（`speaker.connected`）。
- 終了したら部屋を消す（`DeleteRoom`）。webhook は `bguru-offkai-*` をこちらへ振り分ける。
- 名前は表示名、identity は users.user_id（メールは LiveKit に渡さない。ボイスルームと同じ）。

### API（Web はセッション、アプリは `/api/agent/offkai/*`、スコープ read / chat）

| | Web | アプリ | |
|---|---|---|---|
| 状態 | `GET /api/offkai` | `GET /api/agent/offkai` | `{ enabled, current: Event\|null, archive: EventSummary[] }`（アーカイブは新しい順 20 件、`?before=<id>` で続き） |
| 始める | `POST /api/offkai` `{title}` | 同 | 409 `busy`（`current` 付き） |
| 終える | `POST /api/offkai/end` | 同 | 始めた人・管理者（状態の応答の `is_admin` と started_by で端末が「終了」を出す） |
| 話す／やめる | `POST /api/offkai/speak` `{on}` | 同 | 後勝ち。`{ token, url, room }` も返す |
| 聞く鍵 | `POST /api/offkai/token` | 同 | `{ token, url, room, canSpeak }` |
| アルバム | `GET /api/offkai/<id>/photos` | 同 | 時系列（古い順）、`?after=<photoId>&limit=`（既定 100、最大 200） |
| 1 件 | `GET /api/offkai/<id>` | 同 | アーカイブから直接開く |
| 写真を上げる | `POST /api/offkai/photos`（multipart: `images` 4 枚まで・`caption`） | 同 | サーバが offkai-… として保存し（端末で 1280px・EXIF なしにしてから送る。チャットの写真と同じ）、chat-… に複製してチャットにも 1 件流す。他人のファイルを指定する道はない |
| 写真を消す | `DELETE /api/offkai/photos/<photoId>` | 同 | 上げた本人・管理者 |

Event: `{ id, version, title, started_by: Person, started_at, ends_at, ended_at, speaker: (Person & {connected})|null, photo_count, cover: url|null, can_end }`

状態の応答: `{ enabled, can: { start, speak, upload }, current: Event|null, listeners: number, archive: Event[] }`

Photo: `{ id, url, uploader: Person, caption, created_at, mine }`

### 即時の知らせ（SSE / アプリの stream）

`{ type: "offkai", action: "start"|"update"|"end"|"photo"|"photo_delete"|"listeners", event?: Event, photo?: Photo, photoId?: number, listeners?: number }`

古い `version` の event は捨てる。アプリは再接続のたびに `GET /offkai` で取り直す。聞いている人数は `listeners` だけを流す
（出入りのたびに Event 全体を流さない）。

### 回数の枠

始める 5/時、写真 60/時（1 回 4 枚まで）、話す 60/時。

## 画面（全プラットフォーム共通の決まり）

- 🍻 タブ（開催中でない）: 「🍻 オフ会を始める」（場所・ひとことの入力 1 つ）＋ アーカイブ一覧（日付・題・写真の枚数・表紙）。
- 🍻 タブ（開催中）: 上の段に題・経過時間・いま話している人・聞いている人数。「🔊 聞く／止める」「🎙 現地から話す」
  （話している人は「話すのをやめる」）、「終了」（押せる人だけ）。その下に写真が時系列（新しいものが下）、📷 で撮る・選ぶ。
- 写真をタップで大きく（左右で前後）。自分の写真は長押し／メニューで消す。
- 聞いているあいだは、ボイスルームから抜ける（同時に 2 つの部屋の音は出さない）。

## チャットの読み上げ（2026-10-26 オーナー決定）

「オフ会機能有効時にテキストチャットが来たら、それをテキスト・トゥ・スピーチで読み上げて」。現地の人がリモートの人の発言を聞き逃さないため。

- 鳴らす端末: 🍻 の音声に入っている端末（聞いている・話している）で、その端末の「🔈 チャットを読み上げる」がオンのもの。オンオフは端末ごと（手元に保存）、**既定はオン**。🍻 の画面（広げた面・小さな窓）にトグルを置く。
- 読むもの: 🍻 が開いている間に届いたチャットの新しい発言。自分の発言・お知らせ（notice・☗ カード・入退室）・🐶 ビーグル AI の回答は読まない。入る前の発言・読み込み直しで出てきた古い発言は読まない（届いたものだけ）。
- 読み方: 「〇〇さん、本文」。本文の URL は「リンク」、80 文字を超えたら切って「、以下略」。写真だけなら「〇〇さんが写真を送りました」（写真＋文は文を読む）。名前が取れなければ本文だけ。
- 順番に読む（重ねない）。届いてから 2 分たったものは読まずに捨てる（追いつけないときに古い話を延々読まない）。件数の上限は入れない。
- エンジンは端末内の読み上げ（Web: speechSynthesis、iPhone/Mac: AVSpeechSynthesizer、Android: TextToSpeech）、日本語の声。サーバ・外部へは何も送らない。
- 🍻 の音声から出た・オフにした・オフ会が終わったら、読んでいる途中も止めて待ちも捨てる。
- 現地の人はスマホをポケットに入れるので、🍻 を聞いていて読み上げがオンのあいだは、画面を消してもチャットのつながりを切らない（Android は裏に回って 45 秒で切っていたのを延ばす。iPhone は音声に入っていれば切れない）。
- 話している端末で読むと、その声はマイクにも入りうる（端末のエコー除去で消えることも多い）。消し込みはしない。

### チャット欄の読み上げ（オフ会に関係なく、2026-10-26 オーナー）

「音声読み上げ自体はオフ会の時以外でも便利なので、オフ会に関係なくチャット欄で音声読み上げのオンオフができるように」。

- チャット欄（入力欄の近く・チャットの見出し）に「🔈 読み上げ」のトグル。端末ごと（手元に保存）、**既定はオフ**（いつでも全部読むので、勝手に鳴らない）。
- オンのあいだ、🍻 に関係なく届いた発言を読む。読むもの・読み方・順番・2 分で捨てる・見張りは上と同じ。
- 🍻 のトグル（既定オン、🍻 の音声に入っているあいだだけ）はそのまま。どちらかが当てはまれば読む。同じ発言は 1 回だけ。
- iPhone・Android はアプリが前にあるあいだだけ（裏でストリームを保つのは 🍻 を聞いているあいだだけ。電池のため）。Mac・Web は開いているあいだ。
- チャット欄のトグルをオフにしたら、読んでいる途中も止める（🍻 の分も含めて止め、🍻 のトグルがオンで聞いていれば次の発言からまた読む）。

### 賢い読み方（2026-10-26 オーナー「同じ投稿者だったら毎回名前を言わない・長い名前を短く『さん』付けで」）

- 同じ人が続けたら名前を省く: この端末が直前に読んだ発言と同じ人（authorId）で、60 秒以内なら本文だけ（写真だけなら「写真です」）。
- 呼び名（純粋な決まり。Web・Android・Swift で同じ結果、テストで揃える）:
  1. 括弧の中を落とす: （…）(…)【…】[…]「…」『…』〔…〕
  2. 先頭の @・＠ を落とし、区切り（空白・全角空白・／ / | ｜ ・ : ： @ ＠ ～ 〜）で分けて、最初の空でない部分
  3. 絵文字・記号だけの部分は捨てる（文字・数字が 1 つ以上ある部分を使う）
  4. 8 文字（コードポイント）を超えたら先頭 6 文字
  5. 何も残らなければ元の名前を空白でまとめて先頭 6 文字
  6. 末尾が さん・様・さま・氏・くん・君・ちゃん・先生 なら「さん」を付けない
- iPhone・Mac: 決まりで縮めてもまだ長い（手順 4 で切った）名前は、端末内の Foundation Models に呼び名を頼む（「6 文字以内・敬称なし」）。返ってきた呼び名が 1〜8 文字で改行・記号だけでなければ使い、人ごとに覚える（authorId＋名前。名前が変わったら作り直す）。間に合わない・使えない端末は決まりの呼び名。外へは何も送らない。
- Web・Android は決まりの呼び名だけ（端末内の言語モデルが無い）。

## アルバムをまとめて保存（2026-10-26 オーナー決定）

オーナー「アルバムの写真を一括でダウンロードしたい」。選択: 全端末、**そのオフ会の参加者だけ**（参加の記録を始める）、管理者はどの会でも、全員に出す。

- 参加した人: `offkai_participants (event_id, email lower, first_at, PK(event_id, email))`。記録するのは
  始めた（start）・聞いた／話した（部屋の鍵を出したとき = token / speak）・写真を上げた（addPhotos）とき。記録の失敗で本来の操作は止めない。
  記録を始める前の会は、表を作るときに「始めた人」と「写真を上げた人」で埋める（`ON CONFLICT DO NOTHING`、何度流しても同じ）。
  チャットだけで参加した人は入らない（オフ会と結び付かないため）。
- 保存できるか: アルバムの応答 `GET <id>/photos` に `can_download`（参加した人・管理者）。端末はこれが true で写真が 1 枚以上のときだけ
  「⬇ まとめて保存（N 枚）」を出す。見る（アルバムを開く・1 枚ずつ）は今までどおり会員全員。
- Web: `GET /api/offkai/<id>/photos.zip`（セッション）。無圧縮の zip を 1 枚ずつ流す（lib/zip-store.ts、依存なし・ZIP64 なし）。
  中の名前は古い順に `001_表示名_1930.jpg`（日本時間の時分）、zip の名前は `B-guru オフ会 2026-10-26 題.zip`（ASCII の名前も付ける）。
  参加していなければ 403 `not_participant`、写真が無ければ 404 `no_photos`、1 人 1 時間 10 回まで（429）。
- アプリ（zip は使わない）: アルバムの一覧（`GET /api/agent/offkai/<id>/photos`、`next_after` で全部）を読み、写真を 1 枚ずつ取って保存する。
  - iPhone・iPad: 写真アプリへ（追加だけの許可 `NSPhotoLibraryAddUsageDescription`、`PHPhotoLibrary` の add-only）。
  - Mac: 選んだフォルダ（`NSOpenPanel`、最初は「ダウンロード」）に、Web の zip の中と同じ名前で書く。同じ名前があれば上書きしない（` (2)` を付ける）。
  - Android: `MediaStore` の `Pictures/B-guru/<オフ会の日付と題>/` へ（Android 10 以上は許可なし。9 以下は書き込みの許可を聞く）。
  - 進み具合（`12 / 40`）と中止を出す。終わったら「40 枚を保存しました」（失敗があれば「38 枚を保存、2 枚は失敗」）。
- 何も外へ送らない。写真は今の 1280px・EXIF なしのまま（原本は持っていない）。

## 後始末

- 写真を消すと offkai- のファイルと縮小版（mediaVariant）も消す。チャットに流した複製はそのまま（24 時間で消える）。
- 写真はずっと残る（アーカイブ）。退会した会員の写真は残す（管理者が消せる）。
