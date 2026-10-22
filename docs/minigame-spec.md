# 🎮 散財ダッシュ — 仕様（ルール v2 = ENGINE_VERSION 2, 2026-10-21）

1 人で遊ぶミニゲームとハイスコア競争。設計の経緯: Claude Reports「B-guru ミニゲーム設計」（2026-10-21）。
作りは ☗ 将棋（docs/shogi-spec.md）と同じ型: ゲームは Web 部品（canvas）を 1 つ作り、Web はそのまま、アプリは WebView で表示。
タイトル・ランキング・結果もゲーム側で描くので、アプリは入れ物と API の中継だけ。

## 決めたこと（ドリキン 2026-10-21）

- 横スクロールの 1 タップランナー。タップでジャンプ（長押しで高く）、Mac・PC はスペース（↑・W も）かクリック。
  死んだらすぐ再挑戦（0.6 秒で「もう一回」が押せる。画面のどこかをタップ・スペースでも）。最初の 3 秒は助走（障害物なし）。
- 障害物（v1 から）: 床をうねる XLR ケーブル（低い・軽く跳べば越せる）、マイクスタンド（高い・長押し）、段ボールの山（1 つ／縦に 2 つ＝長押し／横に 2 つ）、
  空から降る請求書（当たるとよろける。床に落ちると平たい障害物）、後ろから迫る「締め切りの壁」（追いつかれたら終わり）。
  ハートは 3 つ。障害物に当たるとハートが 1 つ減り、よろけて（0.5 秒、速さ半分）壁が近づく。ハート 0 か壁に追いつかれたら終わり。
- アイテム: SD カード（得点 5×コンボ、拾うたびにコンボ +1、当たるとコンボは 1 に戻る）、コーヒー（1.5 秒 速さ +30%）、
  録音中ランプ（5 秒 無敵・障害物を蹴散らす）、散財チャンス（8 秒 SD の得点が倍・請求書が倍）。
- 500m ごとにビーグルが 2 つのパワーアップから 1 つを選ばせる（選ぶ間はゲームが止まる。選んだものは操作の記録に入る）:
  二段ジャンプ（最大 2）／請求書が半分（最大 2 = 1/4）／1 回だけ復活（最大 3）／SD カード吸い寄せ（最大 2）。上限に達したものは出ない。
- スコア = 距離（m）＋ SD カードの得点（5 × コンボ、散財中は倍）。
- 区間・急降下・ドローン／ブームマイク・床の穴・型は下の「v2 の変更」。
- プレイキャラ 3 人（差は 1 割程度）: ドリキン＝コンボの上限 6（ほかは 5）・散財が少し長い・請求書が約 1 割多い／
  松尾＝空中でもう一度だけ小さく跳べる／善司＝障害物の手前で一瞬スロー（0.3 秒、10 秒に 1 回）。
- 遊び方: 今日のチャレンジ（全員同じ面＝その日の種。JST 5 時に替わる。何回でも、ベストだけが順位）と自由プレイ（毎回違う面）。
- ランキング: 今日（今日のチャレンジ）・今週（自由プレイ、JST 月曜 0 時区切り）・通算（両方。`mode` で絞れる）。
- 回数の制限なし。今日（JST 5 時区切り）21 回目の記録の結果画面で 1 度だけビーグルが「ちょっと休憩するわん」。
- 音: 効果音（ジャンプ・SD カード・コーヒー・無敵・ぶつかる・パワーアップ・ハイスコアほか。WebAudio で合成、音源ファイルなし）と
  BGM（2026-10-21 追加、オーナー提供の 65.52 秒のループ。`public/minigame/bgm-<hash>.m4a`、AAC 128 kbps 約 1 MB）。
  BGM は走っているあいだ（playing・choosing）だけ鳴らす。一時停止・画面から外れた・アプリが隠したら続きから、
  やられた・タイトル・ランキングではフェードして次は頭から。最初の操作のあとに初めて取りに行き、AudioBuffer のループで継ぎ目なく回す
  （AAC の先頭の詰め物をデコーダが残したときはずらす）。読めなければ BGM なしで遊べる。
  `navigator.audioSession.type = "ambient"`（使えるとき。ジュークボックス・ボイスルームの音を止めない）、音量は控えめ。
  タイトルの 🔈/🔇 で消音（効果音と BGM の両方。WebView の localStorage `bguru-minigame-mute`）。
- 置き場所: チャット上部の切り替えに 🎮（Web は「テキスト｜ルーム｜☗｜🎮」。アイコンだけ、読み上げ・title は「ゲーム」）。
  将棋の切り替えも ☗ のアイコンだけ（読み上げ・title は「将棋」）。上にゲーム・下にチャット（スクロールしない、チャットが見える高さ）。
  🎮 と ☗ は同時に開かない（片方を開くともう片方は閉じる）。
- 機能フラグ `MINIGAME_ENABLED`（読み方は `SHOGI_ENABLED` と同じ。`lib/feature-flag.ts` の `featureEnabledFor` を両方が使う）:
  未設定・`0` = 誰にも出さない（capabilities `enabled:false`、API 404、Web に 🎮 なし、配信もしない）／`1`（`*`・`true`）= 全員（公開）／
  メールのカンマ区切り = その人だけ（公開前の試し）。
- 自動操作のボットは防がない（管理者が記録を消せる）。速度改造は実時間と照合して弾く。

## v2 の変更（2026-10-21 オーナー「いい感じだけどスピードが上がるだけで単調なので簡単すぎる」）

- **急降下**: 空中でもう一度タップ = 急降下（下向き 5.5 px/刻み。1 回の滞空で 1 回）。長押しの高跳びはそのまま。
  空中のタップは「二段ジャンプ（パワーアップ）→ 松尾の小ジャンプ → 急降下」の順に使う（松尾は空中の 1 回目が小ジャンプ、2 回目が急降下）。
- **跳んではいけない障害物**: 頭の高さを横切るドローン（下端 20px = 跳ばずにくぐる／下端 42〜46px = 軽く跳ぶのは良いが長押しは当たる）、
  上から下がるブームマイク（下端 18px。跳ぶと当たる）。
- **床の穴**: 幅は「刻み」で決まり（13〜22 刻み × その時の速さ）、大きな穴は長押しでないと越せない。落ちるとハートが 1 つ減り（壁も 20px 近づく）、
  その場で這い上がる（無敵の 1 秒は穴の上を走れる。録音中も）。ハート 0 なら終わり（死因 `pit`）。
- **型（パターン）**: 障害物は 28 の型（`sim.ts` の `PATTERNS`）の組み合わせで出す。型は「区間（いつから）・重み・長さ・要素（位置は刻み）」。
  その区間の新しい型は 3 倍出やすく、同じ型は続かない。型と型の間は 40 刻み以上（区間が進むほど詰まる）。
  **すべての型を、出てくる区間の速さと最高速で、3 キャラとも完璧な操作なら当たらずに越せることをテストで確かめる**
  （`minigame-sim.test.ts`。先読みの自動操作 `__tests__/minigame-planner.ts`）。全体を通しても、完璧な操作なら締め切りの壁以外では終わらない。
  空から降る請求書は、障害物・穴の前後 0.6 秒ぶんには落ちない。
- **区間（ステージ）**: 500m ごとに区間が替わり、新しい要素が 1 つずつ増える。区間の切り替えでビーグルのパワーアップ選び（選ぶ画面に次の区間の説明）。
  | 区間 | 距離 | 増えるもの | 背景 |
  |---|---|---|---|
  | 1 収録スタジオ | 0〜 | ケーブル・スタンド・段ボール（低い→高いなどの連続） | 吸音材の壁・ON AIR |
  | 2 秋葉原 | 500m〜 | ドローン・ブームマイク、空からの請求書 | 夜の街・ネオン |
  | 3 締め切り前夜 | 1,000m〜 | 床の穴 | 紺の空・月 |
  | 4 散財ナイト | 1,500m〜 | 請求書の雨（型）、請求書が多め | 紫の空・舞うお札 |
  | 5 機材の山 | 2,000m〜 | 速い組み合わせ（低い→高い→穴、穴が 2 つ など） | 茶色の空・段ボールの影 |
  走り出しと区間の切り替えに、画面の真ん中へ 2.5 秒の帯（区間の名前と、新しい要素の避け方）。
- 速さは 2 → 4.3 px/刻みに 98 秒ほどで上がる。締め切りの壁は 100 秒を過ぎると 3 秒ごとに 1/256 ずつ速くなり、完璧でも 2 分半〜3 分で追いつく。
- ドット絵: ドローン・ブームマイクは `src/lib/minigame/sprites.extra.ts`（生成ファイルと同じ形。ドット絵担当の `sprites.generated.ts` に
  同じ名前が入ればそちらが優先）。穴・ネオン・月などの背景の小物は描画で作る。

### 手触り（人に近い自動操作で測った生存時間、v1 と v2、各 40〜60 回）

自動操作の設定: 見えてから（300px 先に入ってから）9〜15 刻み（150〜250ms）たつまで気づかない、押す時刻のぶれ ±3 刻み、押す長さのぶれ ±25%、
8% の確率で判断ミス（押す長さの取り違えか、時刻を大きく外す）。「上手」は 6 刻み（100ms）・ぶれ ±1・長さ ±10%・ミスなし。

| | 10% | 25% | 中央 | 75% | 90% | 最長 | 3 分超え |
|---|---|---|---|---|---|---|---|
| v1 ふつう | 32 秒 | 62 | 97 | 153 | 192 | 210 | 6/40 |
| v2 ふつう | 22 秒 | 41 | 67 | 93 | 132 | 150 | 0/60 |
| v1 上手 | 46 秒 | 76 | 146 | 198 | 209 | 225 | 16/40 |
| v2 上手 | 85 秒 | 102 | 141 | 156 | 160 | 168 | 0/60 |

何もしないと約 10 秒（3 秒の助走のあと、障害物に 3 回当たって終わり）。

### ごく短いタップ（Apple 担当の報告 2026-10-21）

押して離すのが同じ刻みの中に入るタップ（シミュレータの 1ms のタップ）でも必ず跳ぶ。ゲームの部品は、同じ刻みで「押す」のあとに来た
「離す」を次の刻みに回す（押した刻みで「押した」を記録し、最低 1 刻みは押したことにする）。記録には押しと離しが別の刻みで両方残り、
サーバの再生も同じになる（`minigame-browser.test.ts` で chromium・webkit に 1ms のタップを送って確かめる）。

## 作り

| 場所 | 中身 |
|---|---|
| `src/lib/minigame/sim.ts` | ゲームの計算（純関数・import なし・整数だけ・mulberry32・60Hz 固定刻み）。`ENGINE_VERSION`、`replay`、`traceRun` |
| `src/lib/minigame/render.ts` | 描画（canvas。論理解像度 高さ 144・幅 256〜384、端末の画素で整数倍に拡大、`image-rendering: pixelated`、dpr は 2 まで） |
| `src/lib/minigame/game.ts` | ゲームの部品 `DashGame`（画面・入力・繰り返し・効果音・結果・ランキング。文字は canvas の上の DOM） |
| `src/lib/minigame/audio.ts` | 効果音・BGM |
| `src/lib/minigame/host.ts` | ゲームとサーバの間の窓口の形（`GameHost`）。Web は fetch、アプリは橋渡し |
| `src/lib/minigame/bridge.ts` | アプリの WebView 用の橋渡し（下の「橋渡し」） |
| `src/lib/minigame/sprites.ts` | ドット絵の窓口。正本はドット絵担当の `sprites.generated.ts`（`scripts/minigame-sprites.py` が作る）。v2 の物（ドローン・ブームマイク）は `sprites.extra.ts`、それ以外で無い名前・コマは `sprites.placeholder.ts` の仮の絵で埋める |
| `public/minigame/index.html`・`game.js` | WebView 用の画面（`node scripts/build-minigame.mjs` で束ねる。ずれはテストが検出） |
| `src/lib/minigame-sim-worker.generated.ts` | サーバの検算 worker（同じスクリプトが作る文字列。`new Worker(src, { eval: true })`） |
| `src/lib/minigame-verify.ts` | 検算（worker 1 つ・順番待ち・1 件 2 秒まで。上限を超えた worker は捨てる） |
| `src/lib/minigame.ts` | 発行・提出・順位表・配信・チャットの 1 行・週の王者・管理 |
| `src/lib/minigame-api.ts` | HTTP（Web とアプリ共通の道順） |
| `src/lib/minigame-client.ts`・`src/components/minigame/MinigamePanel.tsx` | Web（🎮・パネル。ゲームの部品は開いたときに読み込む） |

ゲームのソース（ドット絵の生成ファイルも含む）を変えたら `node scripts/build-minigame.mjs` で `game.js` と worker を作り直す。
**ルール（sim.ts の計算）を変えたら `ENGINE_VERSION` を上げる**（古い版の WebView・アプリからの記録は「ルール更新のため記録できません」になる。
`minigame-sim.test.ts` の答え合わせも更新する）。

### 決定論

- sim は整数だけ（位置・速度は 1/256 px）。使う組み込みは `Math.imul` だけ（テストがソースを確かめる）。
- 確認: 同じ種・同じ操作で、Node（V8）と、ブラウザ（playwright の chromium と webkit = JavaScriptCore に近い）で `game.js` を回した結果が、
  刻み 60 ごとの状態の要約（digest）まで一致する（`src/lib/__tests__/minigame-browser.test.ts`。ブラウザが無ければ飛ばす）。
- 入力は「刻み t の操作は、刻み t を進める前に当てる」。端末も再生も同じ順。パワーアップを選ぶ間は刻みが進まない。

## DB（`initSchema` が作る）

- `minigame_plays`（`id, user_id, game='dash', mode daily|free, date_jst, seed, character, engine_version, issued_at, finished_at, ticks,
  score, distance, sd, cause, claimed_score, status issued|verified|rejected, reject_reason, inputs JSONB`）。
  `inputs` は自己ベスト（どれかの順位表に載っている回）の分だけ残し、ほかは NULL。発行のまま 1 日たった行は消す。
- `minigame_daily`（`date_jst, game, seed`）: 今日のチャレンジの種（その日の最初の発行・GET me で作る）。
- `minigame_bests`（`game, board, user_id, play_id, score, distance, character, achieved_at`）: 順位表ごとの各人のベスト。
  `board` = `v2:d:YYYY-MM-DD`（今日のチャレンジ）/ `v2:w:YYYY-MM-DD`（自由プレイの週。月曜の日付）/ `v2:all` / `v2:all:daily` / `v2:all:free`。
  順位は点の高い順、同点は先に出した人が上。
  **順位表はルールの版ごとに分ける**（頭の `v2:`。v1 の記録は頭なしの `d:…` などに残るが、今日・今週・通算のどの表にも出さない。
  v1 の時に発行した回・v1 のゲームからの提出は 409 `engine_version`「ルール更新のため記録できません」）。
  v2 を出した日の「今日」「今週」は v2 の記録だけで始まる。版を上げるたびに同じ扱い（`boardPrefix(version)`）。
- `minigame_announces`（チャットの 1 行の数・最後の行）、`minigame_weekly`（週の王者の投稿。週ごとに 1 本）。

## API（Web は `/api/minigame/*`・ログイン、アプリは `/api/agent/minigame/*`・スコープ read＝GET / chat＝POST）

アプリの POST はミニゲーム用のレート枠（`minigame`: 900 回/時。チャットの枠は減らさない）。フラグで出していない人には 404。
成功は `{ apiVersion: 1, ... }`、失敗は `{ error, code }`。

### `GET me` → 200

```json
{ "apiVersion": 1, "engine_version": 2,
  "me": { "user_id": "OPOkqabkfVlv", "name": "ドリキン" },
  "daily": { "date": "2026-10-21", "seed": 822266587, "resets_at": "2026-10-21T20:00:00.000Z" },
  "best": { "today": Best|null, "week": Best|null, "all": Best|null },
  "plays_today": 3,
  "top_today": LeaderEntry|null }
```
`Best` = `{ score, distance, rank, play_id, character, achieved_at }`。`today` は今日のチャレンジ、`week` は今週の自由プレイ、`all` は通算。

### `POST plays` `{ mode: "daily"|"free", character: "drikin"|"matsuo"|"zenji" }` → 201

```json
{ "apiVersion": 1, "play": { "play_id": 257, "seed": 822266587, "mode": "daily", "character": "matsuo",
  "engine_version": 2, "date": "2026-10-21", "expires_at": "2026-10-21T06:30:00.000Z" } }
```
1 回限り・30 分で期限切れ。今日のチャレンジの `seed` は GET me の `daily.seed` と同じ（`date` は発行したときの日付。
5 時をまたいでも発行した日の順位表に載る）。自由プレイの `seed` は毎回違う（`date: null`）。
エラー: 400 `invalid_request`（mode・character）、429 `too_many`（30 分に 40 回以上出したまま）。

### `POST plays/{id}/finish` `{ inputs: number[], engine_version: 1, score?: number, ticks?: number }` → 200

```json
{ "apiVersion": 1, "result": { "play_id": 257, "mode": "daily", "score": 1240, "distance": 1003, "sd": 38, "ticks": 4210,
  "cause": "micstand", "best": 1240, "new_best": true, "rank": 3, "period": "today", "rank_today": 3,
  "plays_today": 4, "rest_hint": false, "mismatch": false } }
```
- サーバが同じ計算で記録を再生してスコアを決める（`score`・`ticks` は申告値。照合だけで、違えば `mismatch: true`、記録はサーバの値）。
- `best`・`rank` はその遊び方の順位表（今日のチャレンジ = 今日、自由 = 今週）での自分のベストと順位。`rank_today` は自由プレイなら null。
- `cause`: `xlr` / `micstand` / `box` / `drone` / `boom` / `pit` / `deadline`。
- `inputs`: 操作の記録（下の「記録の形」）。ゲームが作ったものをそのまま中継する。
- エラー: 404 `not_found`（自分の回でない）、409 `already_finished`（2 回目）、409 `expired`（30 分）、
  409 `engine_version`（「ルール更新のため記録できません」。発行時か提出の版が今のサーバと違う）、
  413 `too_large`（3 万件・64KB を超える。本文 80KB まで）、422 `too_fast`（刻み数/60 ＞ 発行から提出までの実時間＋10 秒）、
  422 `invalid_record`（再生できない・終わらない・2 秒で終わらない）、503 `busy`（検算の worker が使えない。もう一度送ってよい）。
  `expired`・`engine_version`・`too_fast`・`invalid_record` はその回を rejected にする（記録されない）。

### `GET leaderboard?period=today|week|all&mode=daily|free` → 200

```json
{ "apiVersion": 1, "period": "today", "mode": "daily", "key": "2026-10-21",
  "entries": [ { "rank": 1, "user_id": "…", "name": "ぜんじ", "avatar": "https://…", "score": 2980, "distance": 2100,
                 "character": "zenji", "achieved_at": "…" } ],
  "me": { "rank": 7, "score": 1240, "distance": 1003 } | null }
```
上位 50。`mode` は `period=all` のときだけ効く（`today` は今日のチャレンジ、`week` は自由プレイに決まっている）。
`key` は today なら日付、week なら週の始め（月曜）、all なら null。400 `invalid_request`（period・mode）。

### 管理（`isAdmin` の人だけ。ほかは 403 `forbidden`）

- `GET admin/plays?user_id=&limit=` — 最近の記録（発行のままは除く）
- `POST admin/plays/{id}/reject` — その回を消す（rejected）。その人の順位表を残りの記録から作り直す
- `POST admin/users/{user_id}/clear` — その人の記録をすべて消す

### 記録の形（`inputs`）

数の配列。1 つの操作 = `(前の操作からの刻み数) * 4 + code`（最初は刻み 0 から）。
`code`: 0 = 離す、1 = 押す（地面ならジャンプ、空中なら二段ジャンプ・松尾の小ジャンプ・急降下）、2 = パワーアップの左を選ぶ、3 = 右を選ぶ。
刻みは 60Hz（`ticks / 60` 秒）。上限 3 万件・15 分。ごく短いタップは「押す（刻み t）・離す（刻み t+1）」で記録される。

## 配信（SSE）

アプリは `GET /api/agent/stream`、Web は `/api/posts/stream` に `minigame` イベントが加わる（フラグで出していない人には送らない。
capabilities の `stream.events` に `"minigame"` が入る。古いアプリは無視する）:

- 今日の上位 10 が変わった（今日のチャレンジの自己ベスト更新のたび、5 秒まとめて、変わっていれば全員へ）:
  アプリ `{ "action": "leaderboard", "period": "today", "key": "2026-10-21", "top": [LeaderEntry…] }`
  （Web は同じ中身に `"type": "minigame"` が付く）
- 自分のベストが更新された（本人だけ）: アプリ `{ "action": "best", "best": { "mode", "score", "distance", "rank", "period" } }`

メールは載らない（user_id・表示名・アイコンだけ）。

## 公開後にだけ出すもの（`MINIGAME_ENABLED=1` のときだけ。メールの指定の間は出さない）

- チャットへの 1 行（`kind: "notice"` の静かな行。アプリは今までのお知らせと同じに出す。本文の先頭が 🐶）:
  今日のチャレンジの自己ベストで「今日の 1 位交代」（`🐶 ○○さんが「散財ダッシュ」今日の 1 位に！ 2,980 点（2,100m）`）か
  「今日の上位 5 位に入った」（`🐶 ○○さんが「散財ダッシュ」今日の 3 位に入ったわん（自己ベスト 1,240 点）`）のときだけ。
  前の行から 10 分以内なら新しい行を出さずに前の行を書き換える（最後の 1 回にまとめる）。1 日（JST 5 時区切り）最大 10 行。
- 月曜 9 時（JST）を過ぎたら、先週（自由プレイの週間ランキング）の王者と 2・3 位をビーグルがタイムラインに 1 本投稿する
  （`minigame_weekly` で二重投稿しない。記録のない週は出さない）。1 分ごとの見回り（`ensureMinigameSweeper`）。

## capabilities

```json
"minigame": { "enabled": true, "path": "/api/agent/minigame", "game_url": "/minigame/index.html",
              "bridge_version": 1, "engine_version": 2, "play": true,
              "characters": ["drikin", "matsuo", "zenji"], "modes": ["daily", "free"] }
```
`play` = chat スコープがある。`engine_version` がアプリの持つゲームの版と違っても、ゲーム（WebView）はサーバから配られるので
アプリの更新は要らない（WebView を開き直せば新しい版になる）。

## 橋渡し（bridge_version 1）

アプリは `capabilities.features.minigame.game_url`（`/minigame/index.html`）を WebView で開く。この画面はトークンを持たず、
`/minigame/game.js` 以外は読まない（ネットワークに出ない）。`?theme=light|dark`・`?max_height=<px>` を付けられる。
ゲームを開いている間だけ WebView を作り、閉じたら捨てる。アプリが画面を離れる・WebView を隠すときは `pause`（rAF も止まる。
走っている途中なら一時停止の画面になり、タップで続ける）。

**アプリ → ゲーム**: `window.bguruMinigame.receive(msg)`（`evaluateJavaScript` / `evaluateJavascript`。msg はオブジェクトか JSON 文字列）。
`window.postMessage(msg)`（Android の postWebMessage）でもよい。

| type | 中身 |
|---|---|
| `state` | 情報（GET me の本文をそのまま広げてよい: `engine_version`, `me`, `daily`, `best`, `plays_today`, `top_today`）、`theme?`（"light"\|"dark"\|"auto"）、`max_height?`（px: ゲームをこの高さに収める）、そして頼まれたことの返事: `play?`（`{ req, ...POST plays の play }` か `{ req, error, code }`）、`result?`（`{ req, ...finish の result }` か `{ req, error, code }`）、`leaderboard?`（`{ req, ...GET leaderboard の本文 }` か `{ req, error, code }`）。どの項目も省略でき、来た項目だけ更新する |
| `event` | `data`: SSE の `minigame` イベントの data をそのまま（今日の上位 10・自分のベスト） |
| `pause` | 一時停止（rAF を止める） |
| `resume` | 再開（rAF を動かす。走っていた回はタップで続ける） |

**ゲーム → アプリ**: iOS/Mac は `webkit.messageHandlers.minigame.postMessage(obj)`、Android は `MinigameBridge.postMessage(JSON 文字列)`
（`@JavascriptInterface`）、iframe なら `parent.postMessage({ source: "bguru-minigame", ...obj })`。すべて `v: 1` を含む。

| type | 中身 | アプリがすること |
|---|---|---|
| `ready` | `engine_version` | GET me → `state`（情報＋`theme`・`max_height`） |
| `request_play` | `req`, `mode`, `character` | `POST plays { mode, character }` → `state { play: { req, ...play } }`（失敗は `{ req, error, code }`） |
| `finished` | `req`, `play_id`, `inputs`, `engine_version`, `mode`, `character`, `score`, `ticks`, `distance`, `sd` | `POST plays/{play_id}/finish { inputs, engine_version, score, ticks }` → `state { result: { req, ...result } }`（失敗は `{ req, error, code }`。ゲームが `error` を結果画面に出す） |
| `request_leaderboard` | `req`, `period` | `GET leaderboard?period=` → `state { leaderboard: { req, ...本文 } }` |
| `request_info` | — | GET me → `state`（日付が替わった・記録したあと） |
| `haptic` | `kind`: hit / dead / powerup / highscore / select | 振動 |
| `size` | `height`（px） | WebView の高さ合わせ |
| `error` | `message` | ゲームの JS のエラー（記録用） |

- `req` は返事の照合用の番号。返事が 15 秒（finish は 30 秒）来なければゲームは「アプリからの返事がありません」として、その回を記録しない。
- 自由プレイは、死んだ直後に次の回を先に `request_play` で頼む（「もう一回」をすぐ始めるため）。使われずに期限切れになる回があってよい。
- 今日のチャレンジは `daily.seed` が分かっていればすぐ走り出し、発行（`request_play`）の返事は助走の間に受け取る。
  返事の `seed` が違えば（5 時をまたいだ）その回は記録しない。
- 計算だけの窓口（確認用）: `window.bguruMinigameEngine = { engine_version, replay, traceRun }`。

### 寸法

- 論理解像度は高さ 144・幅 256〜384。拡大率 k = 端末の画素で横幅 ÷ 256 の整数（`max_height` に収まるまで下げる）、dpr は 2 まで。
  iPhone（幅 393）≈ 384×216pt、Mac パネル（幅 380）= 380×144px、Web（幅 900 の画面のチャット列）≈ 584×288px。
- Web はチャット欄の高さの約 45%（150〜420px）を上限にする。アプリも同じくらいを `max_height` で渡す（チャットが見える高さ）。

## 運用

- 公開前の試し: `MINIGAME_ENABLED=drikin@gmail.com`（その人だけ。チャットの 1 行・週の王者は出ない）。公開: `MINIGAME_ENABLED=1`。
  戻すときはメールのカンマ区切りか 0 にして pm2 restart。
- 検算は別スレッド（worker 1 つ、順番待ち）。4 分の記録で数 ms。`MINIGAME_VERIFY_INLINE=1` でその場の再生（worker を使わない）。
- DB の結合テスト: 使い捨ての Postgres で `MINIGAME_TEST_DATABASE_URL=postgres://postgres:x@127.0.0.1:55433/postgres npx vitest run minigame-db`
  （`SHOGI_TEST_DATABASE_URL` と同じ方式）。

## v1 に入れないもの

ゴースト（他人の走りの再生）、フレンド対戦・リアルタイム対戦、ボット検出、ルームとの連動、通知（push）、2 本目のゲーム。
