# B-guru Chat for Mac（試作）

B-guru のチャットだけを切り出したメニューバー常駐アプリ。本体（タイムライン等）は PWA のまま。
検討の経緯は `docs/mac-native-app-study.html`。

## 使い方
- メニューバーのビーグルをクリックすると開閉（開くときは常に最前面・入力欄にカーソル）。固定していて後ろに回っているときは前に出す
- **⌃⌥B** もクリックと同じ開閉。開くと入力欄にカーソルが入っているので、そのまま打って Enter で送れる。Esc で閉じる。固定していなければ他をクリックで隠れる
- 📌 で固定（他をクリックしても隠れない・全 Space・配信中に横に置く用途。位置を記憶）
- Enter 送信 / ⇧Enter 改行 / 空欄で ↑ = 自分の直前の発言を編集
- メッセージにマウスを乗せると吹き出しの角にボタンが出る: ❤️（1クリック）／😊（リアクションを選ぶ）／✏️（自分の発言を編集）
  - 右クリックメニュー、ダブルクリックで ❤️、空欄で ↑ で編集、も使える。編集中の吹き出しは緑の枠
- メニューバー: 未読があると犬が塗りつぶし＋件数、自分へのメンションがあると「@件数」
- 通知: @メンションは個別に（返信・❤️ 可、吠える音つき）。その他の新着は1つの通知にまとめて更新
  （「…（ほか 3 件の新着）」）。クリックでその位置へ移動してハイライト。チャットを開くと消える
- ⋯ メニューで設定: 通知（新着すべて / メンションだけ）、静かな時間（0:00〜7:00 は新着を通知せず、
  メンションは音なし）、Dock にも表示（未読バッジ）
- **試験的：ほかのステータスバーアイコンを畳む**（⋯ メニュー、またはビーグルの右クリックメニューでオン。既定は切）
  - オンにするとビーグルの左に区切り（‹）が出る。隠したいアイコンを **⌘ を押しながら区切りの左へドラッグ**（初回だけ説明が出る）
  - 畳むと区切りより左のアイコンは macOS の「«」（あふれ）に入り、メニューバーは「« ビーグル」になる（« を押せば中身も開ける）
  - 出し入れ: ビーグルを **⌥（option）＋クリック**、トラックパッドの **3 本指タップ**（システム設定 → トラックパッド →
    「調べる＆データ検出」を 3 本指のタップにしているとき）、または区切りのクリック。ふつうのクリック・右クリックは今までどおり
  - 出したあと 10 秒たつか、メニューバーからマウスを離すとまた畳む（メニューバーの上にマウスがある・ボタンを押している・
    メニューが開いているあいだは待つ）。オフにする／アプリを終了すると区切りを消して元に戻る
  - ⌘＋クリックにしなかったのは、macOS 27 では ⌘ を押してステータスアイコンを押すとシステムが並べ替えに使い、アプリに届かないため
  - **しくみと注意**: macOS 27 は区切りの幅を大きくしても左のアイコンを画面の外へ押し出さない（大きすぎると区切りが外されて
    何も隠れない）。そこで区切りの幅を毎回測って合わせ、区切りごと « に入る幅にしている（前面のアプリ・画面の構成・ビーグルの幅が
    変わったとき、と 20 秒ごとに確認。アプリごとの幅を覚えるので、2 回目からはほぼ 1 回で決まる）。メニューの長いアプリが前に
    あるときは macOS がビーグルごと « にしまうので何もしない。**macOS の仕様外の動きに頼るので、将来の macOS で効かなくなりうる**
    （そのときは何も隠れないだけで、区切りが残る・アイコンが消えることはない）
  - 開発のみ: `-demoPanel -collapseTest` で自分のダミーのアイコン（★ ♥）を区切りの左に置き、分散通知
    `fm.backspace.bguru.chat.debugCollapse`（object に toggle / collapse / expand / settingOn / settingOff / quicklook / frames / quit）で
    操作できる。stderr に `[collapse] …`。後片付け: `defaults delete fm.backspace.bguru.chat collapseOtherStatusItems` と `collapseHintShown`

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
ホバー操作の見た目確認（開発のみ）: `-selftest DIR -forceActions`（全行にボタンを出し、picker.png も書き出す）。
画面録画なしの自己診断: `… -selftest <アプリのコンテナ内のディレクトリ> [-selftest-send] [-dark]`（接続時間・送信遅延・画面 PNG）

## 上下反転のチェック（リリースの前に）
画面が上下逆さまに描かれる不具合が 2 回あった（2026-10-19 文字ごと逆さ＝ImageRenderer、2026-10-21 パネルが逆さ＝
ターンテーブルの回転が AppKit の持つ layer の anchorPoint・transform を直接いじっていた疑い）。どちらも通信しないデモで確かめる。
各画面を Vision で読み、そのままと上下を鏡に映したものを比べて、そのままの方がはっきり読めれば正しい向き（逆さなら鏡の方が読める）。
```bash
# 1) アプリ内で描いて読む（画面収録の許可いらず。AppKit が描く文字の逆さを見る）。失敗すると終了コード 1
"build/dd/Build/Products/Debug/B-guru Chat.app/Contents/MacOS/B-guru Chat" \
  -selftest ~/Library/Containers/fm.backspace.bguru.chat/Data/tmp/orientation -demo -demoJukebox -orientation
# 2) 実際のパネルを撮って読む（WindowServer が合成した絵。将棋盤・ゲームの WebView も）。ターミナルに画面収録の許可が要る
native/mac/scripts/orientation-tour.sh            # Debug をビルドして、チャット・再生中のジュークボックス・止めて大きさを変える・
                                                  # 閉じて開く・画像ビューア・☗・🎮・ダーク/ライトを順に撮る
# 3) iPhone（シミュレータ。起動している iPhone を使う）
native/ios/scripts/orientation-check.sh [UDID]
```
1) は native/mac/scripts/release.sh が、3) は native/ios/scripts/testflight.sh が毎回自動で回し、逆さの画面があれば出さずに止まる
（緊急時だけ `SKIP_ORIENTATION=1`）。2) は画面収録の許可が要るので手で回す（描き方を変えたとき）。撮った画像は表示される出力先に残る。
デモの後片付け（`panelNarrowed20261019`・`jukebox.*` の設定、シミュレータの外観）はスクリプトがする。

## 長いスレッドのチェック（リリースの前に）
スレッドを開いているとパネルが固まる報告（2026-10-21・22）を受けて、まずスレッドを開いたままタイムラインの再読み込みを
10 回（新しい返信で投稿が上に移る・既読やリアクションが変わる・新しい投稿が来る。一覧は上／下へ読み進めた所、短い／長いスレッド、
その間に写真・返信欄・リアクション）、次にデモの 300 件の返信つきスレッドを開き、開いている途中からスクロール・上まで・下へ戻る・
閉じてもう一度開く、を通して、メインスレッドが 5 秒以上応答しなければ失敗にする。
```bash
"build/dd/Build/Products/Debug/B-guru Chat.app/Contents/MacOS/B-guru Chat" \
  -selftest ~/Library/Containers/fm.backspace.bguru.chat/Data/tmp/threadcheck -demo -threadCheck [-demoReplies 300] [-threadSize 300x320]
native/ios/scripts/thread-check.sh [UDID] [返信の数]     # iPhone（シミュレータ）
```
release.sh（0/6）と testflight.sh が上下反転のチェックと一緒に回す。手で開くとき: `-demoPanel -demoPosts 30 -demoOpenThread [ID] [-demoReplies N] [-demoRefreshEvery 秒] [-demoActivateEvery 秒]`
（絵はアプリ内で描く。`BGURU_DEMO_MEDIA=http://127.0.0.1:PORT` で手元のサーバーから遅れて届く絵にもできる）。

## フリーズの記録
- 起動中は見張りのスレッドがメインスレッドを 0.5 秒ごとに確かめ、3 秒応答がないと
  `~/Library/Containers/fm.backspace.bguru.chat/Data/Library/Application Support/Diagnostics/hangs.log`
  に書く（3・8・20 秒の 3 回）。中身: メインスレッドが忙しいのか（CPU ≈ 100 % ならレイアウトのループ）待っているのか、
  そのときのコールスタック（`画像 +オフセット 記号`。dSYM と `atos` で引ける）、直前の操作（タブ・スレッド・再読み込み・窓のサイズ）。
  強制終了しても残る。⋯ メニュー →「フリーズの記録を Finder で表示」で開ける
- MetricKit がシステムのハングレポートを届けたら、同じフォルダに `metrickit-*.json` で保存する
- サンドボックスのため自分で `sample` は使えない。固まっている最中なら、アクティビティモニタ →「プロセスのサンプルを収集」も有効

## リリース（ベータ配布）
```bash
native/mac/scripts/release.sh 0.1.0              # 署名 → DMG → 公証 → staple → Gatekeeper 確認
native/mac/scripts/release.sh 0.1.0 --no-notarize  # 署名付き DMG だけ（手元確認）
```
- 署名: Developer ID Application: Kohichi Aoki (F9349EVF2K)、Hardened Runtime、secure timestamp
- ユニバーサル（Apple シリコン + Intel）。スクリプトが lipo で確認する
- 公証: キーチェーンのプロファイル `notary`（`xcrun notarytool store-credentials notary` で一度だけ登録）
- スクリプトは、Developer ID 署名・Hardened Runtime・timestamp を確認し、開発用の仕組み
  （BGURU_DEV_TOKEN）がリリース版に入っていないことも確認する。成果物は `native/mac/dist/`（git 管理外）

## 会員への配布（B-guru 右サイドバーのダウンロード）と自動アップデート
```bash
native/mac/scripts/release.sh <版> && native/mac/scripts/publish.sh <版> "<今回の変更点>"
```
- 自動アップデートは Sparkle 2.9.6（固定）。0.1.4 以降を入れた Mac は 6 時間ごとに確認し、新しい版があれば
  「アップデートがあります」と出る（右クリックメニュー / ⋯ の「アップデートを確認…」でも）
- appcast: `/api/download/mac/appcast.xml`（会員 or アプリのトークン。Sparkle にトークンをヘッダで持たせる）
- 更新ファイルは EdDSA 署名必須。秘密鍵はこの Mac のログインキーチェーン（Sparkle の generate_keys で作成）。
  **失うと以後アップデートを出せない**ので `generate_keys -x 書き出し先` でバックアップしておくこと
- release.sh は Sparkle の中身（XPC サービス・Autoupdate・Updater.app）を Developer ID で署名し直す
公証済み・staple 済みかを確認してから、本番サーバーの `/home/ubuntu/bsm-downloads/` に DMG を置き、
最後に `mac.json`（版・サイズ・SHA-256）を差し替える。サイトは `/api/download/mac`（会員のみ）で配り、
右サイドバー最上部のカード（Mac のデスクトップでのみ表示）から落とせる。新しい版はデプロイ不要。
