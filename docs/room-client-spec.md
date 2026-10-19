# ルーム（部室）クライアント仕様 — Web・iPhone/iPad/Mac・Android 共通

ユーザーと合意した仕様（memory: project-bguru-room-design）を、クライアントの実装に落としたもの。
サーバは実装済み（src/lib/room.ts・room-map.ts・room-api.ts、テスト src/lib/__tests__/room.test.ts）。
見た目と操作の基準は試作: https://claude.ai/artifact/Xq8FHgkfT71HZJCfLvrHKy
（元ファイル: /private/tmp/claude-501/-Users-koh-Dev-b-guru/949a23c8-f455-43bb-92d1-7716b2131311/scratchpad/bguru-room/bguru-room.html — タイル・キャラクター・ビーグルの描画、BFS、吹き出し、リアクションの浮き方はここから移植する）。

## 有効かどうか
- Web: `GET /api/room` が 200 なら有効、404（code: room_disabled）なら無効。
- アプリ: `GET /api/agent/capabilities` の `features.room.enabled`。
- 無効のあいだは今のボイスバーのまま（何も変えない）。有効なら、チャットタブの中に「テキスト｜ルーム」の切り替えを出し、
  テキスト表示ではボイスバーの代わりに「ルームへ」の帯を出す（下記）。今のボイスバーはルーム有効時は出さない。

## データ
`GET /api/room`（Web, セッション）/ `GET /api/agent/room`（アプリ, スコープ read）:
```
{ map: { w: 32, h: 20, tiles: [string × h（各 w 文字）], zones: [{kind:"table"|"stage", name, x, y, w, h}],
         door: {x, y}, seats: [{x, y}], labels: [{name, x, y}], hear_radius: 4 },
  members: [Member], me: "<自分の user_id>", reactions: ["👋","❤️","😂","👏","🎉","🍻"] }
```
Member — Web は camelCase `{ userId, name, avatar, x, y, mode: "room"|"text", listening, mic, away }`、
アプリは snake_case `{ user_id, name, avatar, x, y, mode, listening, mic, away }`。avatar は /api/avatar/… の相対パス。

タイル文字: `#` 壁, `w` 窓（壁）, `D` ドア（壁）, `.` 床, `,` ラグ, `s` スツール（チャット席・歩ける）, `C` カウンター,
`B` 本棚, `T` テーブル, `c` 椅子（歩ける）, `S` ステージの床, `M` マイクスタンド, `F` ソファ, `V` 自販機, `P` 観葉植物,
`b` ビーグルの寝床（歩ける）。歩けないのは `# w D C B T M F V P`。ビーグルは寝床のまわりを歩く飾り（クライアントだけ）。

## 変化の受け取り
- Web: 既存の SSE（/api/posts/stream）に `event: room`、data は `{ type:"room", action:"join"|"update"|"leave", member }`
  または `{ type:"room", action:"react", userId, emoji, to }`。
- アプリ: 既存の /api/agent/stream に `event: room`、data は `{ action, member }`（snake）または `{ action:"react", user_id, emoji, to }`。
- join: 部室に来た（テキストのチャット席に座っている）。update: 位置・状態が変わった。leave: いなくなった。
- 再接続（ready）のたびに GET し直して同期する。

## 操作 — `POST /api/room`（Web）/ `POST /api/agent/room`（アプリ, スコープ chat）
| action | body | 返り |
|---|---|---|
| enter | `{action:"enter", listening: bool}` | `{member, from:{x,y}, to:{x,y}}` — from（ドア）から to（前回の場所）まで歩くアニメーション |
| text | `{action:"text"}` | `{member}` — チャット席へ |
| move | `{action:"move", x, y}` | `{member}` — 1 マスずつ送る（2 マス以内なら受ける）。4xx なら返ってきた/取り直した位置に合わせる |
| voice | `{action:"voice", listening?: bool, mic?: bool}` | `{member}` または 429 `{error}`（話せる人数の上限など、文をそのまま表示） |
| react | `{action:"react", emoji, to?: user_id}` | `{ok:true}` |
1 秒 12 回まで（超えると 429）。歩く速さは 1 マス 170ms 程度なので収まる。

## 画面
- 切り替え「テキスト｜ルーム」はチャットタブの中（上部）。起動時は常にテキスト（音を出すには操作が要るため）。
- テキスト表示の帯（ボイスバーの位置）: 「🎧 部室で N 人がボイスに入っています（M 人が話し中）［ルームへ ▶］」＋入っている人の顔を数人。
  N = mode=="room" && listening の人数、M = LiveKit で話している人数（ボイスにつながっていなければ省略可）。押すとルームへ。
- ルーム表示: 上にマップ（縦長の画面では上半分、広い画面では左）、下（または右）に今のチャットのログと入力欄。
  マップの上に「🎧 聞いている／👀 見るだけ」「🎙 マイク」のボタン、自分のいるエリア名（会議テーブル・ステージ）。
- 描画: 試作と同じドット絵（コードで描く）。タイル 16px を整数倍で拡大（スマホで横 13 マス程度）、自分を中心にカメラが追う。
  キャラクターは user_id から決まる見た目（肌・髪・服の色を user_id のハッシュで選ぶ）。名前札の頭に状態の印:
  ⌨️ mode=="text"、👀 room かつ !listening、🔊 話している（LiveKit の発話中）、🎧 room かつ listening、💤 away（他の印の代わり）。
  自分の名前札はアクセント色。聞こえる範囲の円（自分がエリア外のとき、半径 hear_radius マス）。ゾーンの点線枠と名前、ラベル。
- 吹き出し: 既存のチャットに新しいメッセージが来たら、その author_id の人の頭上に 4.5 秒（写真だけなら「📷」）。テキストの人にも出す。
- リアクション: マップ下のボタン 6 つ（PC は数字キー 1〜6）→ POST react。room の react イベントで、その人の頭上に絵文字が浮かんで 1.8 秒で消える。
  `to` があれば相手の頭上にも小さく 👋。
- 人をタップ: 「👋 手を振る」「そばへ行く」のメニュー。
- 移動: マップをタップ → その場所へ BFS で歩く（家具なら隣へ）。十字キー（タッチ端末だけ、押しっぱなしで歩き続ける）、PC は矢印/WASD。
  自分は手元で即座に動かし、1 歩ごとに POST move（応答待ちで止めない。拒否されたら位置を合わせ直す）。
  他の人は update の位置へ 1 マスずつなめらかに（2 マスより遠い飛びは BFS で歩かせるか瞬間移動）。
  mode が text→room に変わった人はドア（map.door）から to まで歩かせる。room→text はチャット席へ瞬間移動。

## ボイス（LiveKit、部屋は今と同じ）
- ルームに入る（enter, listening=true）→ 今のボイスの参加処理（トークン取得→接続）を呼ぶ。マイクはオフ。
  テキストに戻る／👀 見るだけ → ボイスから抜ける（leave）＋ POST voice/text。
- マイクをオン: 先に `POST voice {mic:true}`。ok なら LiveKit のマイクをオン、429 ならその文を表示してオフのまま。
  オフ: LiveKit をオフにして `POST voice {mic:false}`。サーバから自分の mic=false が届いたら（離席 30 分・上限）LiveKit もオフ。
- 音量: 部室の変化のたびに、LiveKit の各リモート参加者（identity == user_id）について
  `volume = audibility(自分, その人)`（その人が mode=="room" のとき。それ以外 0）を設定。
- 自分の声を届けてよい相手（会議テーブルの秘密を守る要）: 自分のマイクのトラックに LiveKit の
  track subscription permissions を設定する。allParticipantsAllowed=false、許可は
  「mode=="room" && listening && audibility(その人, 自分) > 0 の人」の identity（=user_id）だけ。
  部室の変化のたびに計算し、集合が変わったときだけ送る（300ms 程度まとめる）。マイクをオンにする前（接続直後）にも設定する。
  JS: `room.localParticipant.setTrackSubscriptionPermissions(false, ids.map(id => ({ participantIdentity: id, allowAll: true })))`
  Swift / Android の SDK にも同名の API がある（引数の型は各 SDK のソースで確認）。
- audibility（サーバの room-map.ts と同じ式。各クライアントに移植する）:
  ```
  ls = zoneAt(listener), sp = zoneAt(speaker)
  if sp.kind == stage → 1
  if ls.kind == table || sp.kind == table → (ls == sp ? 1 : 0)
  d = hypot(dx, dy); if d > hear_radius → 0
  else max(0.15, min(1, 1 - (d - 1) / hear_radius))
  ```
- 「聞こえている人」: 聞こえている人と音量のバーを、パネルかポップオーバーで見られるようにする（スマホは省略可）。

## してはいけないこと
- メールアドレスを扱わない（user_id と表示名だけ）。
- ルーム無効の人に何も変えない。今のボイスバーの動き（ルーム無効時）を壊さない。
