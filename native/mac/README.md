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
  - 出し入れ: ビーグルに**カーソルを乗せて 0.4 秒止める**と出す（通り過ぎただけ・ボタンを押している・⌘ を押している・メニューが
    開いているときは出さない。⋯ メニュー／右クリックメニューの「カーソルを乗せたら出す」で切れる、既定はオン）。ほかに、ビーグルを
    **⌥（option）＋クリック**、または区切り（‹）のクリック。ふつうのクリック・右クリックは今までどおり
    - 乗せて出したあとはメニューバーの上にいるあいだ出したまま（カーソルがビーグルから外れても畳まない）。畳んだあとは、カーソルが
      一度ビーグルから外れるまで乗せても出さない（出す→外れる→畳む→また乗る、の繰り返しを防ぐ）
  - 3 本指タップは非対応: macOS はステータスアイテムに 3 本指タップを届けない（quickLook もタッチも来ない。26.7.1 で確認）
  - 出したあと 10 秒たつか、メニューバーからマウスを離すとまた畳む（メニューバーの上にマウスがある・ボタンを押している・
    メニューが開いているあいだは待つ）。オフにする／アプリを終了すると区切りを消して元に戻る
  - ⌘＋クリックにしなかったのは、macOS 27 では ⌘ を押してステータスアイコンを押すとシステムが並べ替えに使い、アプリに届かないため
  - **しくみと注意**: macOS 27 は区切りの幅を大きくしても左のアイコンを画面の外へ押し出さない（大きすぎると区切りが外されて
    何も隠れない）。そこで区切りの幅を毎回測って合わせ、区切りごと « に入る幅にしている（前面のアプリ・画面の構成・ビーグルの幅が
    変わったとき、と 20 秒ごとに確認。アプリごとの幅を覚えるので、2 回目からはほぼ 1 回で決まる）。メニューの長いアプリが前に
    あるときは macOS がビーグルごと « にしまうので何もしない。**macOS の仕様外の動きに頼るので、将来の macOS で効かなくなりうる**
    （そのときは何も隠れないだけで、区切りが残る・アイコンが消えることはない）
  - 開発のみ: `-demoPanel -collapseTest` で自分のダミーのアイコン（★ ♥）を区切りの左に置き、分散通知
    `fm.backspace.bguru.chat.debugCollapse`（object に toggle / collapse / expand / settingOn / settingOff / hoverOn / hoverOff / unread / frames / quit）で
    操作できる。stderr に `[collapse] …` `[statusbar] …`。後片付け: `defaults delete fm.backspace.bguru.chat collapseOtherStatusItems`・`collapseHintShown`・`collapseRevealOnHover`、
    `…/Diagnostics/statusbar.log`
  - **診断の記録**: この機能がオンのあいだ、設定のオン・オフ、どの合図で切り替えたか（ホバー・⌥クリック・区切りのクリック）、
    畳む／出す／測り直しの結果を `statusbar.log` に 1 行ずつ残す（最大 200 行、個人情報なし。hangs.log と同じフォルダ）。
    うまく畳めないときは次で送ってもらう:
    ```bash
    tail -n 40 ~/Library/Containers/fm.backspace.bguru.chat/Data/Library/Application\ Support/Diagnostics/statusbar.log | pbcopy
    ```
- **メニューバーのビーグルは左向き**（2026-10-22。ティッカーの文字が左へ流れるので、左を向いて吠えて送り出す絵に）。SF Symbols の
  dog / dog.fill（22×17pt）を左右反転し、顔の前（左）に 8pt の余白を足した 30×17pt のキャンバスに描く（`BeagleIcon`）。余白は通常の
  ときもあるので、吠えても幅は変わらない。未読の数は数字の幅をそろえた字（1→2 で幅が変わってビーグルが横にずれない）。
  変えたのは Mac のメニューバーだけ（アプリのアイコン・iOS・Android・Web はそのまま）
- **新着でビーグルが吠える**（⋯ メニュー／右クリックメニュー「新着でビーグルが吠える」、既定はオン）
  - 1 回の吠えは約 1.2 秒（0.15 秒ごとに 8 コマ）：首から前を上へ 1pt 引き伸ばして頭を上げ、口を大きく開け、余白に太い「ワン」の線を
    放射状に 3 本（伸びる）、最後に「!」。新着・お知らせは 2 回、メンションは 3 回。足元・後ろ足・しっぽは全コマ同じ（画面の差分で確認、
    ボタンの frame も変わらない）
  - 刻みはタイマー（Core Animation は macOS 26 のメニューバーで動かなかった前例）。終わったら必ず最新の状態（未読・接続）の絵に戻す
  - 吠えないとき: チャットを見ているとき、静かな時間、「視差効果を減らす」がオンのとき、前に吠えてから 10 秒以内。
    ティッカーがオンなら流れ始めと同時に吠える。statusbar.log に「吠えた（種別）／吠えない（理由）」
- **メニューバーのティッカー**（⋯ メニュー、またはビーグルの右クリックメニューで「メニューバーにティッカーを流す」。既定は切）
  - チャットの新着（「名前：本文」1 行。改行・長文は詰める。写真は「📷 写真」。自分の発言は流さない）、自分へのメンション（太字、
    「@ 名前：本文」）、ビーグルのお知らせ（☗ の見どころ・対局カード、散財ダッシュなど。部室の出入りは流さない）を、ビーグルの
    アイコンの左に 1 件ずつ流す。1 件 6〜8 秒（右から左へ 1 回、短いものはその場に 6 秒）。続けて来たら順に（待ちは最大 5 件、古いものは捨てる）
  - 「名前だけ（本文を出さない）」: 「コバン さんの新着」「@ ゆう さんからメンション」だけ（お知らせは会員の発言ではないので本文を出す）
  - ティッカーの部分をクリックするとチャットを開いてその発言へ。アイコンの部分のクリック・右クリック・⌥クリック・ホバーは今までどおり
    （ホバーはアイコンの部分だけで見る）
  - 流さないとき: チャットを開いて見ているとき（開いたら流れているものも止める）、静かな時間（0:00〜7:00、設定がオンのとき）。
    macOS の集中モード（おやすみ）は、読むのに専用の権限（Focus Status）と許可のダイアログが要るので見ていない
  - しくみ: ビーグルの NSStatusItem 自体を左へ広げる（タイトルの先頭に幅だけの透明な添付、画像をタイトルの右へ）。広げた所に重ねた
    ビュー（クリックは素通し）の Core Animation のレイヤーで文字を動かすので、メインスレッドを使わない。流していないときはタイマーも
    アニメーションもない（試した値: アプリの CPU は流していないとき 0.1 %、流しているとき 0.1〜0.3 %）
  - 畳む機能で畳めているときは、区切りの幅を同じだけ縮めてからビーグルを広げる（合計の幅が変わらないので « の中のアイコンは出てこない。
    最大 300pt、区切りが収まった幅から余裕を引いた分まで）。戻すときも同じ処理の中で区切りを戻す。畳む機能がオフ・出しているときは
    最大 200pt で、広げたあとビーグルが押し出されていないか確かめ、だめなら戻す（「空きなし」。未読の数だけ）
  - VoiceOver には 1 件ずつ 1 回読み上げる（アナウンス）。statusbar.log に「ティッカー: 表示（種別・幅）／空きなし／クリック」
    （本文は書かない）
  - 開発のみ: `-demoPanel -tickerTest`（パネルは開かない、静かな時間も無視）＋分散通知（上と同じ名前）の
    msg / mention / notice / photo / long / room / burst / tickerOn / tickerOff / namesOnly / namesFull /
    forceLight / forceDark / forceNone（文字色の外観を固定して見本を撮る）。`-collapseTest` と一緒にも使える。
    後片付け: `defaults delete fm.backspace.bguru.chat menuBarTicker`・`menuBarTickerNamesOnly`・`menuBarBark`（barkOn / barkOff でも操作できる）

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
