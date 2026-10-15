# B-guru Chat for Mac（試作）

B-guru のチャットだけを切り出したメニューバー常駐アプリ。本体（タイムライン等）は PWA のまま。
検討の経緯は `docs/mac-native-app-study.html`。

## 使い方
- メニューバーのビーグルをクリックすると開閉（開くときは常に最前面・入力欄にカーソル）。固定していて後ろに回っているときは前に出す
- **⌃⌥B** もクリックと同じ開閉。開くと入力欄にカーソルが入っているので、そのまま打って Enter で送れる。Esc で閉じる。固定していなければ他をクリックで隠れる
- 📌 で固定（他をクリックしても隠れない・全 Space・配信中に横に置く用途。位置を記憶）
- Enter 送信 / ⇧Enter 改行 / 空欄で ↑ = 自分の直前の発言を編集
- 右クリックでリアクション・編集・コピー、ダブルクリックで ❤️
- メニューバー: 未読があると犬が塗りつぶし＋件数、自分へのメンションがあると「@件数」
- 通知: @メンションは個別に（返信・❤️ 可、吠える音つき）。その他の新着は1つの通知にまとめて更新
  （「…（ほか 3 件の新着）」）。クリックでその位置へ移動してハイライト。チャットを開くと消える
- ⋯ メニューで設定: 通知（新着すべて / メンションだけ）、静かな時間（0:00〜7:00 は新着を通知せず、
  メンションは音なし）、Dock にも表示（未読バッジ）

## 設計の約束
- 依存するのは `/api/agent/*` の契約だけ（`src/lib/agent-chat.ts` が正本）。
  起動時に `/api/agent/capabilities` を読み、無い機能は隠し、知らない項目は無視する。
- 送信は楽観表示。`client_id` で照合（Web の `src/lib/chat-optimistic.ts` と同じ規則）。
- トークンは初回ログイン（埋め込み WebView、非永続）から `read / read_state / chat` で自己発行し、
  Keychain（ThisDeviceOnly）にだけ保存。ログアウトで失効させる。

## ビルド
```bash
cd native/mac && xcodegen generate && xcodebuild -project BguruChat.xcodeproj -scheme BguruChat -configuration Debug -derivedDataPath build/dd build
```
開発時のみ: `BGURU_DEV_TOKEN=bga_… "build/dd/Build/Products/Debug/B-guru Chat.app/Contents/MacOS/B-guru Chat" -showPanel`
UI 自動操作でアプリを見つけさせるとき（開発のみ）: `-regular` で Dock に表示。
開閉ごとのフォーカス確認（開発のみ）: `-showPanel -reopenTest -logFocus` → stderr に `[focus] … editing=1`。
通知のまとめ確認（開発のみ）: `-notifyTest` → stderr に `[notify] …`。ハイライト: `-selftest DIR -reveal`。
画面録画なしの自己診断: `… -selftest <アプリのコンテナ内のディレクトリ> [-selftest-send] [-dark]`（接続時間・送信遅延・画面 PNG）
