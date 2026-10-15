# B-guru Chat for iPhone / iPad — 設計と残作業（2026-10-15）

試作は `native/ios`（画面）＋ `native/shared`（Mac 版と共通の中身）。シミュレーター（iOS 27、iPhone 18 Pro /
iPad Pro 13"）で、ログイン済みトークンでの一覧・リアルタイム受信・長押しメニュー・iPad の中央カラムを確認済み。
**配布（TestFlight）の前に必要なもの**を以下にまとめる。根拠は App Store Review Guidelines と Apple のドキュメント
（2026-10 時点の調査。審査の運用は「未確認」を含む）。

## 1. 通知（APNs）— iOS で一番大きな追加

iOS はアプリが裏に回ると SSE が止まる。メンション通知はサーバーから APNs で送る必要がある。

### サーバー
- **端末登録 API**: `POST /api/agent/devices/push`（スコープ read）
  `{ token, environment: "sandbox"|"production", platform: "ios" }` を agent token に紐付けて保存。
  トークン失効・ログアウト・APNs の 410 `Unregistered` で削除。
  - 環境は端末トークンと一緒に保存する（TestFlight / App Store は production、Xcode 直入れは sandbox）。
- **送信**: Node 標準の `http2` + `crypto`（ES256 は `dsaEncoding: 'ieee-p1363'`）で自前実装。依存を増やさない。
  - JWT（`kid`=Key ID、`iss`=Team ID F9349EVF2K、`iat`）は約 50 分キャッシュ（20〜60 分の間で更新）。
  - 接続は使い回す（本番 `api.push.apple.com`、開発 `api.sandbox.push.apple.com`）。
  - ヘッダー: `apns-topic: fm.backspace.bguru.chat`、`apns-push-type: alert`、`apns-collapse-id`（同じ会話をまとめる）。
- **送る契機**: 今ある `personal-live`（通知作成時）と、チャットのメンション判定（`chat-mention.ts`）を流用。
  端末がアプリを前面で開いている間は送らない（stream 接続中の端末は除外）。
- **鍵**: APNs の .p8 キー（Team-scoped を本番用・開発用で分ける）。**本番サーバーへの鍵の配置はユーザーの判断。**
  鍵は `.env.production` 相当の秘密情報として扱い、リポジトリに入れない。

### ペイロード（プライバシー優先）
- 本文は載せず `{"aps":{"alert":{"title":"B-guru チャット","body":"新着メッセージ"},"mutable-content":1,
  "category":"mention","thread-id":"chat"},"message_id":123}`。
- **Notification Service Extension** が API から本文を取って差し替える（失敗・30 秒超過時は汎用文のまま＝安全側）。
  NSE には App Group / キーチェーン共有で agent token を渡す。
- カテゴリ `mention`: 返信（`UNTextInputNotificationAction`）と ❤️。Mac 版と同じ。

### 工数の目安
サーバー 2〜3 日（登録 API・送信・失効処理・テスト）＋ アプリ 2 日（登録・NSE・アクション）。

## 2. App Store / TestFlight 審査で要るもの

| 項目 | 根拠 | B-guru での対応 |
|---|---|---|
| 通報 | 1.2 | メッセージ（と投稿）ごとの「通報」。Web 側に通報 API と管理画面が必要 |
| ブロック | 1.2 | 相手のメッセージを自分の画面から消す。サーバー側でブロック一覧を持つ |
| 不快なコンテンツのフィルタ | 1.2 | サーバー側の禁止語フィルタ（最低限） |
| 連絡先 | 1.2 | アプリ内とサポート URL に掲載 |
| 利用規約への同意 | 審査の慣行（未確認） | 初回起動時に「不快なコンテンツ・迷惑行為を許容しない」規約に同意 |
| 通報への 24 時間以内の対応 | 審査の慣行（未確認） | 運用体制を審査メモに書く |
| 課金の扱い | 3.1.1 / 3.1.3(b)(f) | アプリ内に価格・購入・会員登録への導線を一切置かない。審査メモに「既存の有料会員がログインして使うコンパニオンアプリ」と明記。**3.1.1 で却下される事例がフォーラムにあり、最大のリスク** |
| アカウント削除 | 5.1.1(v) | アプリでアカウントを作らないので条文の対象外（の見込み）。保険として設定に「Web で退会」へのリンク |
| 最低限の機能 | 4.2 | ネイティブ UI・通知・iPad 対応があるので満たす見込み |
| デモアカウント | 2.1 | **審査官がログインできる期限なしのアカウントが必要。** 今のログインはメールアドレスだけ（OTP 導入後はメールのコード）なので、審査用の入り方を用意する |

TestFlight の外部テスト: 公開リンクで最大 10,000 人。そのバージョンの最初のビルドはベータ版審査（数時間〜数日、
長いと 1〜2 週間の報告あり）。ビルドは 90 日で期限切れ。内部テスター（App Store Connect のチームメンバー、
最大 100 人）は審査なしで配れる。

## 3. iPad
- 全方向対応・`UIRequiresFullScreen` なし・Launch Screen あり → Split View / Slide Over / Stage Manager に対応（設定済み）。
- 本文は最大 760pt の中央カラム。外付けキーボードは Return 送信 / Shift+Return 改行 / ↑ で直前の発言を編集。

## 4. 順番の提案
1. **メール OTP ログイン**（Mac 版の会員配布にも必要。審査用のデモ入口もここで設計）
2. 通報・ブロック・規約同意（Web とアプリ両方）
3. APNs（サーバー → アプリ → NSE）
4. TestFlight 内部テスト（ドリキン・運営メンバー）→ 外部テスト（会員）

ユーザーの作業: App Store Connect でアプリを作成、APNs キーの作成、TestFlight の説明文・連絡先、審査用アカウントの用意。

## 5. 実装状況（2026-10-15）
- APNs のサーバー送信・端末登録・NSE・通知アクションを実装済み（commit c64c47b 以降）。鍵が無い間は送信しない。
- セキュリティレビューを反映: ロック中の返信・❤️ は認証必須、端末は agent token あたり 1 台・1 人 10 台まで、
  付け替えは同じ人か元の持ち主のトークンが無効なときだけ、同じ人への通知は 20 秒に 1 回、送信の並列は 20。
- 既知（低）: 会員資格切れでもトークンが使われるまで汎用通知は届く（本文は NSE 側で失効して取れない）／
  iOS のキーチェーンはアクセスグループ付きに変更（未配布なので移行不要）／NSE で本文を差し替えるため、
  ロック画面に本文が出るかは iOS の「プレビューを表示」設定に従う。

### 本番で動かすのに必要なこと（ユーザーの作業）
1. developer.apple.com → Certificates, Identifiers & Profiles → Keys → ＋ → Apple Push Notifications service (APNs)。
   環境は Sandbox と Production で 1 本ずつ（Team-scoped）。.p8 は一度しかダウンロードできない。
2. 本番サーバーの .env.production に、本番用 `APNS_KEY_PATH` / `APNS_KEY_ID`、開発用 `APNS_SANDBOX_KEY_PATH` /
   `APNS_SANDBOX_KEY_ID` を設定（.p8 はリポジトリ外、権限 600）し、pm2 を再起動。
   Debug ビルド・シミュレーターは開発用（sandbox）、TestFlight / App Store は本番用（production）の鍵で届く。
3. Identifiers で fm.backspace.bguru.chat の Push Notifications を有効化（Xcode の自動署名でも可）。

### 本番での確認（2026-10-16）
- 鍵を配置（~/bsm-secrets、権限 600。開発用 549NKBTAPG / 本番用 5H74A43YFH）し、.env.production に設定してデプロイ。
  capabilities で `push.apns: true` を確認。
- シミュレーター（Debug = sandbox）が端末登録 → サーバーから開発用 APNs 経由で本物のプッシュ → NSE が本文を取得して
  「送信者（B-guru チャット）／本文」に差し替えて表示、まで確認。
- 本番用の鍵（production）は TestFlight / App Store のビルドで使われる（実機での確認は TestFlight 配布時）。
