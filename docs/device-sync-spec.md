# 端末をまたぐ連携（既読で知らせを消す・音声をスマホで続ける）

2026-10-25 オーナー決定「既読と知らせを端末間でそろえる件と、🍻・🏠 の音声を iPhone で続けるときの見せ方の手直しから作って」。

## 1. 既読で知らせを消す（read_sync）

ある端末で読んだら、ほかの端末に残っている同じ知らせを消す。

### サーバ
- push を送ったとき、相手ごと・範囲ごとに「送った最大 id」を覚える（メモリ、3 日で忘れる。再起動で消えるのは許す＝ベストエフォート）。
- 既読が進んで、覚えている id 以上になったら、その人の **notify_sync 端末だけ** に消す合図を 1 回送り、覚えを消す。
  - 古いアプリ（特に Android は知らない種類を普通の知らせとして出す）には送らない。新しいアプリが登録時に `notify_sync: true` を送る（`push_devices.notify_sync`、既定 false）。
- 既読が進んだら、push とは別に、本人のストリーム（`/api/agent/stream`）へ `event: sync` を流す（Mac はこれでアプリ内の知らせを消す）。覚えの有無に関係なく流す。

| scope | いつ | 送る値 | 消すもの |
|---|---|---|---|
| `chat` | チャットの既読カーソル（chat_read_state）が進んだ | `up_to` | チャットのメンション（message_id ≤ up_to）と「新着メッセージ」 |
| `dm` | DM の既読（dm_read_state）が進んだ | `peer_id`, `up_to` | その相手の DM の知らせ |
| `reply` | 返信の通知を既読にした | `post_id` | その投稿への返信の知らせ |
| `reply_all` | 通知を全部既読／全部消した | なし | 返信の知らせ全部 |
| `shogi` | 自分が指した・申し込みを受けた／断った・対局が終わった | `game_id` | その対局の知らせ |
| `offkai` | 🍻 が終わった | `event_id` | 「オフ会が始まりました」 |

### 合図の形
- APNs: background push（`apns-push-type: background`、priority 5、`aps: { "content-available": 1 }`）。iOS は届かない・遅れることがある（アプリを上にスワイプで終了した等）ので、**アプリが前に出たときにも自分で掃除する**（チャットを見たらチャットの知らせ、その DM を開いたらその DM の知らせ）。
- 本体: `{ kind: "read_sync", scope, up_to?, peer_id?, post_id?, game_id?, event_id? }`。FCM は data の文字列。
- ストリーム: `event: sync`、data は同じ本体から `kind` を除いたもの（`{ scope, ... }`）。

## 2. 音声をスマホで続ける（voice_handoff）

### 切り替わったときの見せ方（全アプリ・Web）
LiveKit の identity は userId なので、同じ人が別の端末で入ると前の端末は `DUPLICATE_IDENTITY` で切られる。話す役（🍻 の speaker_email）はサーバにあるのでそのまま。
- 切られた理由が DUPLICATE_IDENTITY のときは、失敗の文（「接続が切れました」「オフ会の音声が切れました」）でなく **「別の端末で続けています」** を出す。入り直しはしない。

### 「スマホで続ける」ボタン（Mac・Web）
- 🍻・ボイスルーム・部室の音声に入っている間だけ出す。押すと `POST /api/agent/voice/handoff`（アプリ発行の鍵だけ）／`POST /api/voice/handoff`（Web）`{ target: "offkai" | "voice" | "room", mic: boolean }`。
- サーバは本人の notify_sync 端末へ知らせを 1 件送る（静かな時間でも送る＝本人の操作。20 秒に 1 回まで。5 分で期限切れ）。返り値 `{ sent }`。0 なら「続けられるスマホが見つかりません（アプリを最新にしてください）」。
- 送ったあと、押した側は音声を続けたまま「スマホの知らせをタップすると、そちらに切り替わります」を出す。スマホが入った時点で上の「別の端末で続けています」になる。
- 知らせ: `{ kind: "voice_handoff", target, mic, event_id? }`、題「🎧 音声をこの端末で続ける」、本文は target ごと。category `voicehandoff`、thread `voice-handoff`、collapse `voice-handoff`。
- タップしたスマホ: チャットを開き、その機能（🍻／ボイスルーム／🏠）を出して音声に入る。🍻 は、サーバで自分が話す人なら話す側で、そうでなければ聞く側で入る。ボイスルーム・部室は `mic` のとおりにマイクを入れる（iOS は前に出た後なのでマイクを始められる）。
- iOS は裏からマイクを始められないので、Mac のロックで自動で切り替えることはしない。
