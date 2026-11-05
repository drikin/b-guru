# B-guru Chat for Windows（WinUI 3）— 計画

2026-11-04 ドリキン「ビーグルチャットの Windows ネイティブアプリ版も作りたい」→ 作り方は WinUI 3（C#）、署名はとりあえず不要、
フル機能（Mac 版と同じ範囲）を目指す、まず x64（ARM はあとで同じソースから）。

## 段階

| 段階 | 中身 |
|---|---|
| 1 | 土台・ログイン（WebView2）・チャット（読む・送る・メンション・画像・リアクション・編集）・通知領域のビーグル・トースト通知・未読・設定 |
| 2 | タイムライン（Mac と同じく「Web 版で表示」も）・DM・通知の一覧 |
| 3 | 部室の機能（将棋・ジュークボックス・📺・ボイス・🍻・部室） |
| 4 | Mac だけの機能で Windows でも意味のあるもの（スリープさせない・画面の隅・ビーグルが走る・ティッカー・自動更新） |

## 作り

```
native/windows/
  BguruChat.Windows.sln
  src/BguruChat.Core/        net10.0 — Windows に依存しない（Mac でもビルド・テストできる）
    Models / Json（snake_case）/ ApiClient / LiveStream（SSE）/ ChatStore / Mention / NotifyPolicy / ReadSync
  src/BguruChat.App/         net10.0-windows（WinUI 3、unpackaged・self-contained の Windows App SDK）
    通知領域のアイコン・パネル（タスクバーの上に出る枠なしの窓）・ログイン（WebView2）・トースト・鍵の保存（DPAPI）
  tests/BguruChat.Core.Tests/ xUnit
```

- 決め方（通知するか・未読・送信中の行の置き換え・再接続の待ち時間）はすべて Core に置き、単体テストで守る。App は画面と OS の部品だけ。
- CI: `.github/workflows/windows.yml`（windows-latest）で Core のテストと App の `dotnet publish -r win-x64`、成果物は zip。

## サーバとのやり取り（2026-11-04 に既存のクライアントのコードから調べた要点）

- 基点 `https://bsm.backspace.fm`、アプリは `/api/agent/*`、JSON は snake_case、エラーは `{error, code, hint?}`。
- UA は `BguruChatWindows/<版>`（iOS は共有コードの都合で `BguruChatMac/` を名乗るので、別の接頭辞にする）。
- ログイン: WebView2 で Web にログイン →「このアプリを接続」で `POST /api/agent/token`（Cookie つき、同じホストの Origin）
  `{device_name: "B-guru Chat (Windows) <マシン名>", scopes: ["read","read_state","chat","post","voice"], replace_same_device: true}` → 201 `{token}`。
  400「本まで」は鍵の上限（10）→ `/settings/agent` へ案内。403 `membership_ended`。
- 鍵は `Authorization: Bearer`。401 `unauthorized`/`token_expired`・ストリームの `revoked` でログアウト（取り消しは呼ばない）。
  自分でログアウト = `DELETE /api/agent/token/self`。
- 起動時 `GET /api/agent/capabilities`（無いものは出さない）・`/api/agent/emojis`・`/api/agent/members`。
- チャット: `GET /api/agent/chat?limit=100&include=reactions`（古い順、24 時間）、`POST /api/agent/chat {body, client_id, images?}` → 201、
  `PATCH /api/agent/chat/{id} {body}`（自分の・24 時間）、削除はアプリからはできない。
  画像: 長辺 1280・JPEG 0.8 で `POST /api/agent/chat/upload`（multipart、欄の名前 `images`、120 秒）→ `{urls}`。表示の `/api/media/*` は自分のホストにだけ鍵をつける。
  リアクション: `POST /api/agent/chat/{id}/reactions {emoji}`。既読: `POST /api/agent/chat/read {last_read_id}`（0.4 秒まとめる、後ろには戻らない）。
- 新着: `GET /api/agent/stream`（SSE、1 つの鍵で同時 3 本まで → アプリは 1 本だけ）。25 秒ごとの `: heartbeat`、70 秒無言で切れたとみなす。
  再接続は 1 秒から倍々・最大 30 秒・±20%、10 秒以上つながっていたら 1 秒に戻す。`ready` のたびにチャットを読み直す。
  イベント: `chat`（create/edit/delete/reactions）・`presence`・`sync`（既読、scope chat なら up_to まで）・`revoked`・ほかは知らなければ無視。
- 通知（Mac と同じ）: 自分の・notice・beagle_ai・表示済み・パネルが見えている（→ 既読にする）ときは出さない。
  メンションは必ず（静かな時間は音なし）、それ以外は「すべて」設定かつ静かな時間（0〜7 時）でないときだけ、1 つの通知にまとめて更新（0.4 秒）。
  写真だけの発言は本文「📷 写真」を隠す。

調べた元: `native/shared/*.swift`、`native/mac/BguruChat/Sources/{App,ChatStore?,AppSettings}.swift`、
`native/android/app/src/main/java/fm/backspace/bguru/chat/{Api,ChatStore,Models}.kt`、`src/app/api/agent/**`、`src/lib/agent-*.ts`。
