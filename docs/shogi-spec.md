# ☗ 将棋 — 仕様（v1, 2026-10-21）

会員どうしで将棋を指し、チャットから観戦する。設計の経緯: Claude Reports「B-guru 将棋設計」（2026-10-21、
設計・遊び方と画面・ライブラリ調査・反対意見役の 4 人の案をまとめたもの）。サーバは `src/lib/shogi*.ts`。

## 決めたこと（ドリキン 2026-10-21）

- **公開**: 2026-10-21 に全員へ（VPS の `.env.production` で `SHOGI_ENABLED=1`。戻すときはメールのカンマ区切りか 0 にして pm2 restart）。
  テスト用の自分との対局は `SHOGI_SELF_PLAY=drikin@gmail.com` のまま。

- 置き場所: チャット上部の「テキスト｜ルーム 🎧」の隣に「☗」（ドリキン 2026-10-21: 「☗ 将棋」の文字をやめてアイコンだけ。
  読み上げ・title は「将棋」のまま。隣に 🎮 散財ダッシュ、docs/minigame-spec.md）。上に盤面・下にチャット（観戦しながら話せる）。
  ルーム（一部の人だけ）とは独立に、全員に出す。
- 始め方: チャットで募集／相手を指名、の両方。持ち時間は 2 択だけ:
  - ⚡ 速い: 10 分、使い切ったら 1 手 30 秒の秒読み。
  - 🐢 ゆっくり: 時間制限なし。自分の番になったら通知。72 時間指さなければ放置負け（24 時間で一度通知）。
- **対局はサイト全体で 1 つだけ・早い者勝ち**（ドリキン 2026-10-21「セッションは常に 1 個だけで早い者勝ち」）。
  募集・指名・対局中のどれかがあるあいだは新しく出せない（`POST games` は 409 `busy`。見えている対局なら `game` に入る。
  他人どうしの指名の中身は返さない）。募集は最初に受けた 1 人と対局（同時に受けても 1 人だけ）。アプリのロビーも、
  対局があるあいだは「対局を申し込む」を出さず、受ける・観戦するへ案内する。
- 先後はいつも振り駒（ランダム）。再戦は先後を入れ替える。待ったはなし（反則は盤の側で指せないようにする）。
- 終局したらビーグルが結果と棋譜をタイムラインに投稿し、そのスレッドが感想戦。
- レーティング・ランキング・駒落ちは v1 に入れない（初心者が気軽に指せることを優先。ソフト指しの動機も作らない）。
- 成功の基準: 公開から 4 週間で週 10 局以上。届かなければ作りを見直すか下げる。

## ビーグル戦（練習、ドリキン 2026-10-21「ビーグルと対戦したい」）

- 始め方: ロビーの「🐶 ビーグルと対局（練習）」→ ⚡速い／🐢ゆっくりを選ぶとすぐ始まる（申し込み・受諾なし）。先後は振り駒、
  ビーグル戦の「もう一局」（再戦）は先後を入れ替える。将棋が有効な人なら誰でも。自分との対局（SHOGI_SELF_PLAY）とは別。
- 「対局はサイト全体で 1 つだけ・早い者勝ち」はビーグル戦にも効く（ほかの対局があれば 409 `busy`、ビーグル戦の間はほかの人が出せない）。
  ほかの人は観戦できる。
- ビーグルは既存の system アカウント（`SYSTEM_EMAIL`、表示名「ビーグル」、user_id は `ensureUserId`）。`black`/`white` の片方がビーグル。
  カード・終局投稿は今までの決まり（公開前は出さない）。終局投稿は「対局ありがとうだわん」（勝っても負けても相手を褒める）。
- 強さ: 初心者の練習相手。駒の価値（歩1・香3・桂4・銀5・金6・角8・飛10、成駒は加点、持ち駒は少し高め）＋玉の周りの金銀・
  玉の位置・相手玉の近くの駒（少し）。反復深化のアルファベータで 3 手まで、取り合いは静止探索で延長（王手されていれば全部の逃げ方）、
  並べ替えは取る手・成る手・王手を先に。1 手詰めは必ず指し、3 手読みで自分が 1 手で詰まされる手も避ける。根の手に小さな乱数（歩の 0.18 枚まで）
  を足すので毎回同じにはならない。千日手・入玉は考えない。探索そのものは 1 手 数 ms〜数十 ms（持ち駒が多い局面で数百 ms。上限は下）。
- 時計: 人と同じく減る（遅延の補正 1 秒も同じ）。考える時間の上限: 速い将棋は 1・2 手目 1.5 秒、持ち時間 2 分以上 2.5 秒、
  それより少なければ 残り/30（0.3 秒以上）、秒読みは 残りの 1/4（5 秒以内）。ゆっくりは 3 秒。そのうえで「考えている」間（0.8〜2 秒、上限以内）
  をおいてから指す。
- 投了: 30 手目より後で、詰みを読まれて駒も 8 点以上損している、または駒の損が 30 点以上で評価も大差のとき。
- 指すタイミング: 人が指した直後、ビーグルが先手で始まったとき、起動時（`shogiReady`）と 1 分ごとの見回りで手番がビーグルのまま
  止まっている対局。同じ対局は同時に 1 つしか考えず、`expected_ply` と `client_move_id`（`beagle-{id}-{ply}`）で二重に指さない。

### 実装（ビーグル戦）

- `src/lib/shogi-engine.ts`: 探索（純関数・import なし）。探索の間だけ使う独自の合法手生成（盤の配列。成れる歩・角・飛の不成は省く）。
  合法手は tsshogi と突き合わせるテストあり（ランダムな局面 1000 以上）。
- `src/lib/shogi-beagle-worker.ts` → `node scripts/build-shogi-beagle-worker.mjs` で `shogi-beagle-worker.generated.ts`（束ねた JS の文字列）。
  サーバは `new Worker(src, { eval: true })` で別スレッドに 1 つだけ作る（Next の束ね方に左右されない）。探索のソースを変えたら作り直す
  （テストがずれを検出する）。
- `src/lib/shogi-beagle-think.ts`: 考える時間の上限・worker への依頼。worker が落ちた・返事が上限＋1.5 秒来ないときは worker を捨て、
  その場で「1 手読み＋取り合い」（100ms まで、取る手優先）を選ぶ。選んだ手は必ず tsshogi の合法手か確かめ、だめなら tsshogi の合法手から
  取る手 → どれか。テスト（vitest）と `SHOGI_BEAGLE_INLINE=1` は worker を使わずその場で探索する。
- `src/lib/shogi-beagle.ts`: ビーグルの手番（読み直し → 考える → 投了か `playMove`）。`shogi.ts` の `kickBeagle` から呼ぶ。

### API（ビーグル戦。Web `/api/shogi/*`・アプリ `/api/agent/shogi/*` 共通）

- `POST games` `{ mode: "blitz"|"slow", opponent: "beagle" }` → 201 `{ apiVersion, game }`。`game.status` は最初から `"active"`
  （`creator` = 自分、`invitee` = ビーグル、`black`/`white` の片方がビーグル `{ user_id, name: "ビーグル", avatar: "/icon-192.png" }`）。
  ビーグルが先手なら 1〜3 秒後に 1 手目が `shogi` の配信（`state`）で届く。
- `{ mode, opponent: "beagle", rematch_of }`（または `rematch_of` だけ）: 終局した自分のビーグル戦の先後を入れ替えてもう一局。
- エラー: `opponent` が `"beagle"` 以外 400 `invalid_request`、ほかの対局がある 409 `busy`（見えていれば `game`）、
  ビーグルのアカウントが用意できない 409 `unavailable`。`invitee_user_id` にビーグルは指定できない（400）。
- 指す・投了・取り消し（2 手目まで）・観戦・KIF は人どうしと同じ。ビーグルが考えている間は `turn` がビーグルの色のまま。
- capabilities: `features.shogi.beagle = true`（アプリが「🐶 ビーグルと対局」を出す目印）。

## 守ること（反対意見役の指摘から）

- 正本はサーバの DB。局面（SFEN）・指し手（USI）・持ち時間はすべて DB にあり、pm2 の再起動・デプロイで対局が止まらない。
  残り時間は「手番が始まった時刻（DB の now()）」からその都度計算する。サーバが止まっていた間は時間切れにしない。
- 速い将棋の対局中はデプロイしない（デプロイ前に進行中の対局を確認する。ボイスの ListRooms と同じ運用）。
- 将棋の話はチャットに 1 手ずつ流さない。流すのは節目（開始・終局）と、実況の見どころ（公開後、1 局 2 件まで。下の「ビーグルの実況」）だけ。感想戦はビーグルの投稿のスレッドで。
- 盤面の WebView は将棋画面を開いている間だけ作り、閉じたら捨てる（Mac のフリーズ・iPhone のクラッシュの切り分けを難しくしない）。

## ルール判定と素材（ライブラリ調査 2026-10-21）

- ルール判定は **tsshogi 2.3.4**（MIT、依存なし、Node とブラウザの両方。二歩・打ち歩詰め・王手放置・行き所なし・
  千日手・連続王手の千日手・SFEN/KIF/CSA を scratchpad の試験で確認、npm audit 0、install スクリプトなし）。
  合法手の一覧と詰みの判定は小さな補助関数を自作する。サーバは任意の SFEN を受け付けない（平手の初期局面だけ）。
  GPL/AGPL のもの（shogiops、shogiground、shogi-player）は使わない（公開リポジトリのため）。
- 駒は文字で描く（CSS の五角形＋明朝体の漢字、後手は 180 度回転）。字は Noto Serif JP（OFL）の駒に使う字だけの
  サブセットを同梱して、OS ごとの見え方の差をなくす。

## 状態

```
open（募集・15 分で自動取り下げ） ─┐
offered（指名・24 時間で期限切れ）─┴─ accept → active ─→ ended
                     decline / cancel / expire → 終わり（対局なし）
```

終わり方（`end_reason`）: `resign` 投了 / `checkmate` 詰み / `timeout` 時間切れ / `sennichite` 千日手（引き分け）/
`perpetual_check` 連続王手の千日手（王手をかけ続けた側の負け）/ `abandon` 放置（ゆっくり）/
`aborted` 中断（速い将棋で双方が 1 手目を指す前に 60 秒たった、または 2 手目までに一方が取り消した。勝敗なし）。

## 配信

アプリは既存の `GET /api/agent/stream`、Web は `/api/posts/stream` に `shogi` イベントが加わる（古いアプリは無視する）:

```json
{ "action": "state" | "end" | "offer",
  "game": { "id": 12, "status": "active", "mode": "blitz", "black": {...}, "white": {...},
            "sfen": "…", "ply": 42, "last_move": { "usi": "3c3d", "label": "△3四歩" },
            "clocks": { "black_ms": 412000, "white_ms": 581000, "byoyomi_ms": 30000 },
            "turn_started_at": "…", "server_now": "…", "spectators": 12, "result": null } }
```

- 指し手は全員に配る（数百バイト）。申し込み（`offer`）は相手にだけ（個人宛ての配信）。
- 再接続したら `GET …/games/{id}` で全体を取り直す。時計の表示は `server_now` との差で補正する。

## API（Web は `/api/shogi/*`・ログイン、アプリは `/api/agent/shogi/*`・スコープ read＝読む / chat＝操作）

| | |
|---|---|
| `GET games?status=open,offered,active,ended` | 一覧（終局は最近 20 局） |
| `GET games/{id}` | 全体（指し手の一覧・KIF の URL を含む） |
| `POST games` `{ mode, invitee_user_id? }` | 募集（invitee なし）／指名 |
| `POST games` `{ mode, opponent: "beagle" }` | ビーグルと対局（すぐ active。下の「ビーグル戦」） |
| `POST games/{id}/accept` ・ `decline` ・ `cancel` | 受ける・断る・取り下げる |
| `POST games/{id}/move` `{ usi, expected_ply, client_move_id }` | 指す。手数が合わなければ 409 と最新の状態 |
| `POST games/{id}/resign` | 投了 |
| `POST games/{id}/watch` | 観戦中の合図（30 秒ごと。観戦人数に使う） |
| `GET games/{id}/kif` | 棋譜（KIF） |

capabilities の `features.shogi = { enabled, path, board_url, bridge_version, play, beagle, time_controls: [...] }`。

Web のロビーは「相手を指名」と「最近の結果」を一旦出さない（ドリキン 2026-10-21。`ShogiPanel.tsx` の `SHOW_INVITE` /
`SHOW_RECENT_RESULTS` を true にすれば戻る。サーバの指名 API はそのまま）。

## 盤面（Web 部品を各アプリで共用）

- サーバの `/shogi-board/` から配る静的な HTML/JS。Web はそのまま読み込み、アプリは WebView で表示する。
- WebView は描くだけ: 局面はアプリが `postMessage` で渡し、指した手（`move`）・閉じる・振動の合図を受け取る。
  API と配信はアプリ側が今のトークンで受け持つので、WebView にトークンを渡さない。
- 操作: タップ → 行き先、ドラッグでも可。動ける升に点、取れる升は四隅に印。成れるときは行き先の上に「成｜不成」。
  行き所のない駒は自動で成る。持ち駒は自分が下・相手が上、「歩×3」。最後の手は升を薄い黄色＋上の帯に「▲7六歩」。
  後手は盤を反転、観戦者は ⇅ で反転。成駒は赤字。反則（二歩・打ち歩詰め・王手放置・行き所なし）は点を出さない。
  設定「指す前に確認」「駒の動きヒント」。
- 寸法: iPhone で指すとき 1 升 約 41×45pt（チャットは 1 行に畳む）、観戦は約 35×38pt、Mac パネル（幅 380px）は約 39×42px。

## チャットの対局中カード

- 対局が始まると、チャットに `kind: "shogi"` のメッセージを 1 件流す。本文には文字だけでも通じる文（「☗A vs ☖B 対局中 → 将棋で観戦」）。
  対応したアプリは盤の小さな絵（96pt 角・色の点だけ）と「観戦する」を出し、`shogi` イベントで描き直す（メッセージ自体は 1 手ごとに書き換えない）。
- 終局でメッセージの本文を結果に書き換える。チャットは 24 時間で消えるので、ゆっくり対局は将棋画面を正とする。

## 通知

- `shogi_offer`（指名された）と `shogi_turn`（ゆっくり対局で自分の番。対局ごとに 1 件にまとめる）。静かな時間（0〜7 時）は送らない。

## v1 に入れないもの

待った申請、駒落ち、持ち時間の細かい設定、入玉宣言、評価値の数字の表示・AI 検討（ビーグルの実況は下の「ビーグルの実況」で入れた）、ビーグルの強さの段階、
レーティング・ランキング・大会、KIF の読み込み、チャットから局面へのリンク、ルームのボイスとの連動。

## 実装メモ（2026-10-21、v1 のサーバ・盤面・Web）

- 置き場所: `src/lib/shogi.ts`（状態・DB・配信・期限）、`shogi-rules.ts`（tsshogi の上の合法手・詰み・千日手・表記・KIF）、
  `shogi-clock.ts`（時計・期限の純関数）、`shogi-api.ts`（Web とアプリ共通の道順）、`shogi-text.ts`（カードとビーグルの文面）、
  `shogi-types.ts`（DTO）。盤は `src/lib/shogi-board/board.ts`（素の DOM）、Web は `src/components/shogi/*`。
- 機能フラグ `SHOGI_ENABLED`: 未設定・`0` = 誰にも出さない（capabilities `enabled:false`、API 404、Web に「☗ 将棋」なし、
  配信もしない）。`1`（`*`）= 全員。メールのカンマ区切り = その人だけ。
- DB: `shogi_games`・`shogi_moves`（`initSchema` が作る）、`chat_messages.shogi_game_id`、`push_devices.notify_shogi` を追加。
- 時計: 速い将棋は双方が 1 手目を指すまで時計を進めない（60 秒で中断）。遅延の補正は 1 手 1 秒。
  再起動時は「起動時刻＋10 秒」より前の期限を延ばす（`shogiReady`）。タイマーはプロセス内＋1 分ごとの見回り。
- 上限: 一人が同時に出せる募集・指名 3 件、同時に指せる対局 5 局。アプリの操作は将棋用のレート枠（900 回/時）。

### API の応答（Web `/api/shogi/*`・アプリ `/api/agent/shogi/*` で同じ）

- 成功: `{ apiVersion, game }`（一覧は `{ apiVersion, me: { user_id }, games: [...] }`、指す は `duplicate` も、観戦は `{ spectators }`）。
- 失敗: `{ error, code, game? }`。`code`: `not_found` 404 / `invalid_request` 400 / `illegal_move` 400 / `forbidden` 403 /
  `conflict`（手数違い）・`not_your_turn`・`not_active`・`game_over`（時間切れ。game は終局後）・`expired`・`not_open`・
  `too_many`・`too_late` 409。409 の `game` は最新の状態。
- `game`（`ShogiGameDto`）: `id, status(open|offered|active|ended|closed), mode(blitz|slow), creator, invitee, black, white`
  （各 `{user_id, name, avatar}`、受けるまで black/white は null）`, sfen, ply, turn, last_move{usi,label}, clocks{black_ms,
  white_ms,byoyomi_ms,initial_ms}|null, turn_started_at, deadline_at, server_now, spectators, result(black|white|draw|null),
  end_reason(resign|checkmate|timeout|sennichite|perpetual_check|abandon|aborted|cancelled|declined|expired|null),
  created_at, started_at, ended_at, rematch_of, card_message_id, result_post_id`。
  `clocks` は手番が始まったときの残り。手番側の今の残り = 残り −（今 − turn_started_at − 1 秒）、`ply < 2` の間は減らない。
  0 を切ったら秒読み（byoyomi_ms から減る）。
- `GET games/{id}` は上に `moves[{ply, usi, label, sfen, spent_ms, at}]`, `kif_url`, `my_color` を足したもの。
- `POST games` は `{ mode, invitee_user_id?, rematch_of? }`（rematch_of = 終局した自分の対局。相手を指名し、受けると先後が入れ替わる）。
- 配信 `event: shogi` の data: Web は `{ type:"shogi", action, game }`、アプリは `{ action, game }`。
  `offer`（自分への指名）と、指名の取り下げ・断り・期限切れ（`state`）は二人にだけ。
- 通知: `shogi_offer` / `shogi_turn` はアプリが `POST /api/agent/devices/push` に `notify_shogi: true` を付けた端末だけ
  （ペイロードは `kind`, `game_id`、collapse は `shogi-{id}`）。古いアプリには送らない。
- チャットのカード: `kind:"shogi"`, `shogi_game_id`（アプリの DTO）。本文は文字だけで通じる文。終局で本文が結果に変わる（edit）。

## 盤面の橋渡し（bridge_version 1）

アプリは `capabilities.features.shogi.board_url`（`/shogi-board/index.html`）を WebView で開く。この画面はトークンを持たず、
盤の JS（`/shogi-board/board.js`）と駒の字（`/shogi-board/fonts/shogi-piece.ttf`）以外は読まない。
`?theme=light|dark`・`?compact=1`（観戦の寸法）を付けられる。

**アプリ → 盤**: `window.shogiBoard.receive(msg)`（`evaluateJavaScript` / `evaluateJavascript`。msg はオブジェクトか JSON 文字列）。
`window.postMessage(msg)`（Android の postWebMessage）でもよい。

| type | 中身 |
|---|---|
| `state` | `sfen`, `my_color`("black"\|"white"\|null), `can_move`(bool: 自分の番で指せる), `last_move`({usi,label}\|null), `orientation?`(下に来る側), `legal_moves?`(USI の配列。なければ盤が計算), `settings?`({confirm_move, move_hints}), `compact?`, `theme?`("light"\|"dark"\|"auto"), `top_label?`, `bottom_label?`, `show_close?`, `max_height?`（px: 盤全体をこの高さに収める）, `hide_band?`（上の帯＝直前の手・⇅ を出さない。アプリが自分の 1 行に出すとき） |
| `labels` | `top_label`, `bottom_label`（名前・残り時間。毎秒送ってよい。state と違い、送信中の手の表示を消さない） |
| `commentary` | ビーグルの実況（盤の下の帯）: `text`, `eval_cp`, `mate`, `ply`, `move_label`（サーバの `ShogiCommentaryDto` をそのまま渡してよい）。`text: null` で帯を消す。送信中の手の表示を消さない。`state` に `commentary`（オブジェクトか null）を入れてもよい（入れなければ前の実況のまま）。盤が分かるかは `window.shogiBoard.features` に `"commentary"` があるかで判断する |
| `settings` | `confirm_move?`, `move_hints?` |
| `theme` | `theme` |
| `flip` | （⇅ と同じ） |

`state` を受けると盤は描き直し、指したあとの仮の局面（送信中）を捨てる。サーバの返事・配信のたびに `state` を送る。
409 のときも最新の `state` を送れば元に戻る。

**盤 → アプリ**: iOS/Mac は `webkit.messageHandlers.shogi.postMessage(obj)`、Android は `ShogiBridge.postMessage(JSON 文字列)`
（`@JavascriptInterface`）、iframe なら `parent.postMessage({source:"bguru-shogi-board", ...})`。すべて `v: 1` を含む。

| type | 中身 |
|---|---|
| `ready` | 読み込み完了。アプリはここで最初の `state` を送る |
| `move` | `usi`, `label`（例 "▲7六歩"）。アプリが `POST …/move { usi, expected_ply, client_move_id }` を送る |
| `haptic` | `kind`: select / move / error（振動の合図） |
| `flip` | `orientation`（⇅ を押した） |
| `size` | `height`（盤全体の高さ px。WebView の高さ合わせ） |
| `close` | ✕（`show_close: true` のときだけ出る） |
| `error` | `message`（盤の JS のエラー） |

盤のソース（`board.ts`・`bridge.ts`・`shogi-rules.ts`）を変えたら `node scripts/build-shogi-board.mjs` で `board.js` を作り直す
（テストがずれを検出する）。駒の字は Noto Serif JP（OFL）のサブセット（`scripts/shogi-font-subset.sh`、`fonts/OFL.txt`）。

## ビーグルの実況（2026-10-21、オーナーの決定）

- **盤の下（盤の部品の中）に 1〜2 行の帯**＋形勢の細い棒（左 = ☗先手の割合、真ん中に目印、評価値から。詰み筋は端）。
  1 手ごとに更新、対局者にも観戦者にも出す。帯の高さは 2 行ぶんで固定（手ごとに盤が伸び縮みしない）。実況が届くまで・
  機能が無効の間は帯を出さない（高さも取らない）。`max_height` は帯を含めて収める。`hide_band`（上の帯）とは別（上を隠しても出る）。
  ダークは盤と同じ色の組み（`--sb-eval-b/w`）。
- **チャットに流すのは見どころだけ**: 形勢逆転（片方に歩 4 枚以上 → もう片方に 4 枚以上）と詰み筋が新しく見えたとき。途中の見どころは
  1 局 2 件まで・4 分あける（`shogi_games.commentary_chat_count / commentary_chat_at` を 1 文の UPDATE で取る。再起動をまたいで守る）。
  終局は既存の終局カード・ビーグルの終局投稿にまとめる（→ 1 局 3 件まで）。終局投稿に「ビーグルが見た分かれ目」（評価が歩 5 枚以上動いた
  続きの手を 3 手まで）。1 手ずつは絶対にチャットに流さない。チャットは kind `notice`（「🐶 ビーグルの実況（☗A vs ☖B・N 手目）…」）。
- **文は毎手 AI**（さくらの AI Engine。ビーグルの自動投稿と同じ `sakuraChat`・`SAKURA_MODEL`＝本番は gpt-oss-120b。新しい鍵・URL は作らない）。
  gpt-oss は推論型なので、実況だけ `reasoning_effort: "low"` を送り（さくらが 400 で受け付けなければ以後は送らない）、`max_tokens` は 2000。
  本文は `message.content` だけを使う（思考は `reasoning` に分かれる。`<think>…</think>`・`…assistantfinal` が混じっても外す）。
  ビーグルの口調（〜だわん）、1〜2 文、全角 60 字程度（64 文字）まで。AI に渡すのはエンジンの事実だけ: 指し手の表記、ひとつ前の手、駒取り、王手、
  形勢の言葉（評価値の数字は渡さない）、詰み筋、ビーグルの最善手（その手の前）、次の予想手、手数、残り時間（分）。
  **対局者の表示名は AI に渡さない**（名前に仕込まれた指示を読ませない）。AI には「☗先手」「☖後手」（ビーグル戦はどちらがビーグルか）だけを渡し、
  返ってきた文の「先手」「後手」を表示名の呼び方（「☗ドリキンさん」、8 字まで。ひな形と同じ切り方。ビーグルは「☖ビーグル」）に差し替える
  （「先手を取る」などの言い回しはそのまま）。差し替え後は 76 文字まで。「次の予想手」は対局者にも見せる（オーナー承知）。
- **ひな形を先に**: 評価が出たらすぐ事実からのひな形の文を保存・配信し（帯が毎手必ず更新される）、AI の文が検査を通ったら同じ手の実況を
  置き換えて配り直す（`source` が template → ai）。
- **AI の文の検査**（`checkAiText`）: 空（`<think>` だけも）・長すぎ・3 文以上・禁止語（URL・悪口や脅し〈ひらがな・カタカナも〉・差別語・
  「評価値」・英単語など）・口調（「わん」なし）・事実にない升目や手（「5五角」「同歩」など）・事実にない数字（手数・残り分以外）・
  王手/詰み/駒取りの言い違い・形勢の言い違い（文ごとに「どちらの側が」良い〈有利・優勢・勝勢・必勝・リード…〉／悪い〈不利・劣勢・苦しい・
  負け・ピンチ…〉と言っているかを見て、評価と逆なら落とす。大差で「互角」も落とす）→ どれかならひな形のまま。
  終局の手（詰み・千日手）と投了・時間切れ・放置はいつもひな形（勝ち負けを言い違えない）。
- **費用の上限**: 1 日（日本時間）の AI 呼び出しは `SHOGI_COMMENTARY_DAILY_AI`（既定 600、0 で AI を使わない）まで。連続 5 回失敗
  （空・429・タイムアウトなど。新しい手で打ち切ったものは数えない）したら 10 分 AI を止めてひな形だけ。公開前（フラグがメール）は、
  そのメールの人が対局者か観戦中（盤を開いている＝観戦の合図が 45 秒以内）の対局だけ AI を呼ぶ（ほかはひな形だけ）。
- **指し手を遅らせない**: 実況は指し手の確定（コミット・配信）のあとに非同期で依頼する（`kickCommentary`、待たない）。**最新だけ**:
  対局ごとに同時に 1 つ。前の手の実況ができる前に次の手が来たら、古い方の AI は打ち切って捨て（ひな形は出ていれば残る）、待っている依頼も捨てる。
  早指しでも AI の呼び出しは詰まらない（同時 1・タイムアウト 12 秒・打ち切り）。手が早いと実況が抜ける手がある。
- **評価**: ビーグルの探索（worker。乱数なし・深さ 3・1 局面 400ms まで）。worker は対局と同じ 1 つ。**ビーグルの手が最優先**: ビーグルが
  どこかの対局で考えている間は終わるまで待ってから頼む（探索をぶつけない。待つ間に次の手が来ると古い方は捨てる → ビーグル戦ではおもに
  ビーグルの手に実況が付き、文の中で人の手〈ひとつ前の手〉にも触れる）。実況の評価は時間切れでも worker を捨てない（その結果を捨てるだけ。
  同じ worker に並んだビーグルの手番を壊さない）。評価は先手から見た値（歩 = 100、詰み筋 ±9999）。
- **見どころとチャットの順番**: 見どころは、投稿する同じトランザクションで対局の行をロックし「対局中か・枠があるか」を確かめて入れる
  （終局の書き換えは同じ行をロックするので、終局カード・終局投稿のあとに見どころが割り込まない）。
- **保存**: `shogi_commentary`（game_id, ply, move_label, text, eval_cp, best_usi/best_label = 次の予想手, source = ai|template,
  highlight = reversal|mate）。同じ手は上書き（投了などのまとめで最後の手の行を書き換える）。
- **配る**: Web `/api/posts/stream` の `event: shogi_commentary`（`{ type, gameId, commentary }`）、アプリ `/api/agent/stream` の
  `event: shogi_commentary`（`{ game_id, commentary }`）。`GET games/{id}` に `commentary`（最新。途中から開いた・読み直した人用）と、
  終局した対局は `commentaries`（手ごと。棋譜の再生と一緒に。その手の実況がなければ帯は「—」）。どれも実況が有効な人にだけ。
  capabilities: `features.shogi.commentary`（bool）、stream.events に `shogi_commentary`。
- **機能フラグ `SHOGI_COMMENTARY_ENABLED`**（`featureEnabledFor` / `featurePublic` の流儀、SHOGI_ENABLED も要る）: 未設定・0 = 作らない・
  出さない（AI も呼ばない）。メールのカンマ区切り = その人にだけ見せる（作るのは全部の対局。見る人がいなくても途中から開けるように）。
  1 = 全員。**公開前（1 以外）はチャットの見どころ・終局投稿の分かれ目を出さない**。プッシュには出さない。まずオーナーだけ。
- **アプリ（2026-10-21 時点の版）には届かない**: Mac/iOS（`native/shared/ShogiStore.swift`）・Android（`ShogiStore.kt`・`Models.kt`）は
  `shogi` の game を構造体にデコードして（知らない項目は落とす）、盤への `state` を自分の項目から組み立てる。知らないイベント
  （`shogi_commentary`）は無視する（壊れない）。既存の項目に載せる道はない（`last_move.label` はアプリの 1 行と盤の帯に使うので転用しない）。
  → 次のアプリ版で: stream の `shogi_commentary`（と `GET games/{id}` の `commentary`）を受け、`{ type: "commentary", ... }` を盤に送るだけ
  （盤は本番から読むので盤の側の対応は済み）。
- 実装: `src/lib/shogi-commentary-core.ts`（純関数: 事実・ひな形・検査・見どころ・最新だけ・分かれ目）、`shogi-commentary.ts`（依頼・評価・AI・
  保存・配信・チャット）、`shogi-commentary-store.ts`（フラグ・DB。shogi.ts から読む）、盤 `shogi-board/board.ts`（`.sb-cmt`）・`bridge.ts`、
  Web `shogi-client.ts`（`applyShogiCommentaryEvent`・`commentaryFor`）・`ShogiPanel.tsx`。テスト: `shogi-commentary.test.ts`（DB なし）、
  `shogi-commentary-db.test.ts`（`SHOGI_TEST_DATABASE_URL`。別のデータベースを作って使う）、`scripts/e2e-regression.mjs` の S2（本番に投稿・
  対局しない: 盤の静的ページに実況を渡す・チャットは読むだけ）。
