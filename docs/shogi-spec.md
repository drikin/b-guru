# ☗ 将棋 — 仕様（v1, 2026-10-21）

会員どうしで将棋を指し、チャットから観戦する。設計の経緯: Claude Reports「B-guru 将棋設計」（2026-10-21、
設計・遊び方と画面・ライブラリ調査・反対意見役の 4 人の案をまとめたもの）。サーバは `src/lib/shogi*.ts`。

## 決めたこと（ドリキン 2026-10-21）

- 置き場所: チャット上部の「テキスト｜ルーム 🎧」の隣に「☗ 将棋」。上に盤面・下にチャット（観戦しながら話せる）。
  ルーム（一部の人だけ）とは独立に、全員に出す。
- 始め方: チャットで募集／相手を指名、の両方。持ち時間は 2 択だけ:
  - ⚡ 速い: 10 分、使い切ったら 1 手 30 秒の秒読み。
  - 🐢 ゆっくり: 時間制限なし。自分の番になったら通知。72 時間指さなければ放置負け（24 時間で一度通知）。
- 先後はいつも振り駒（ランダム）。再戦は先後を入れ替える。待ったはなし（反則は盤の側で指せないようにする）。
- 終局したらビーグルが結果と棋譜をタイムラインに投稿し、そのスレッドが感想戦。
- レーティング・ランキング・駒落ちは v1 に入れない（初心者が気軽に指せることを優先。ソフト指しの動機も作らない）。
- 成功の基準: 公開から 4 週間で週 10 局以上。届かなければ作りを見直すか下げる。

## 守ること（反対意見役の指摘から）

- 正本はサーバの DB。局面（SFEN）・指し手（USI）・持ち時間はすべて DB にあり、pm2 の再起動・デプロイで対局が止まらない。
  残り時間は「手番が始まった時刻（DB の now()）」からその都度計算する。サーバが止まっていた間は時間切れにしない。
- 速い将棋の対局中はデプロイしない（デプロイ前に進行中の対局を確認する。ボイスの ListRooms と同じ運用）。
- 将棋の話はチャットに 1 手ずつ流さない。流すのは節目（開始・終局）だけ。感想戦はビーグルの投稿のスレッドで。
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
| `POST games/{id}/accept` ・ `decline` ・ `cancel` | 受ける・断る・取り下げる |
| `POST games/{id}/move` `{ usi, expected_ply, client_move_id }` | 指す。手数が合わなければ 409 と最新の状態 |
| `POST games/{id}/resign` | 投了 |
| `POST games/{id}/watch` | 観戦中の合図（30 秒ごと。観戦人数に使う） |
| `GET games/{id}/kif` | 棋譜（KIF） |

capabilities の `features.shogi = { enabled, path, board_url, bridge_version, time_controls: [...] }`。

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

待った申請、駒落ち、持ち時間の細かい設定、入玉宣言、ビーグルの対局中の実況、評価値・AI 検討、
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
| `state` | `sfen`, `my_color`("black"\|"white"\|null), `can_move`(bool: 自分の番で指せる), `last_move`({usi,label}\|null), `orientation?`(下に来る側), `legal_moves?`(USI の配列。なければ盤が計算), `settings?`({confirm_move, move_hints}), `compact?`, `theme?`("light"\|"dark"\|"auto"), `top_label?`, `bottom_label?`, `show_close?` |
| `labels` | `top_label`, `bottom_label`（名前・残り時間。毎秒送ってよい。state と違い、送信中の手の表示を消さない） |
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
