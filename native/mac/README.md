# B-guru Chat for Mac（試作）

B-guru のチャットだけを切り出したメニューバー常駐アプリ。本体（タイムライン等）は PWA のまま。
検討の経緯は `docs/mac-native-app-study.html`。

## 使い方
- メニューバーのビーグルをクリック、または **⌃⌥B** でチャットが開く。Esc / 他をクリックで隠れる
- 📌 で最前面に固定（全 Space・配信中に横に置く用途。位置を記憶）
- Enter 送信 / ⇧Enter 改行 / 空欄で ↑ = 自分の直前の発言を編集
- 右クリックでリアクション・編集・コピー、ダブルクリックで ❤️
- @メンションは通知（通知から返信・❤️ 可、吠える音つき）。メニューバーの犬が塗りつぶし = 未読あり

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
画面録画なしの自己診断: `… -selftest <アプリのコンテナ内のディレクトリ> [-selftest-send] [-dark]`（接続時間・送信遅延・画面 PNG）
