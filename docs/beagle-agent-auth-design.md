# Beagle AI エージェント API — 認証・トークン設計（セキュリティ設計書）

対象: b-guru (bsm.backspace.fm) / VPS neta.backspace.fm (nginx + pm2 fork / Next.js / PostgreSQL pool max:10 / Ghost 会員が権威ソース)

## 0. 現状の実測（コード確認済み）

- `src/lib/session.ts`: 32バイト乱数の opaque token を `sessions` テーブル（token PK, email, expires_at 30日）に保存、httpOnly Cookie で運用。
- `src/app/api/auth/request/route.ts`: メールアドレス → Ghost `findMemberByEmail` + `isPaidMember` で有料会員確認 → **OTP なしで即セッション発行**。Ghost 到達不能時は fail closed (502)。
- `src/lib/db.ts`: `otp_codes` テーブル（email, code, expires_at, used）は定義済みだが未使用。
- `src/lib/housekeeping.ts`: 期限切れ sessions/otp の定期 purge 済み。
- 制約: DB プール max:10、pm2 fork 単一プロセス（インメモリ状態は不適）。

## 1. トークン設計: refresh token rotation（DB 保存・opaque 方式）

**結論: 署名付き JWT ではなく、既存 `sessions` と同型の opaque token を DB 保存する。** 単一 pm2 プロセス・小規模会員（151人）・既に DB 検証方式が実績ありという条件下で、JWT がもたらすステートレス性の利益（分散検証）はゼロで、失効困難性・鍵管理コスト・`exp` 前失効の複雑さだけを負担する。DB ルックアップ 1 回/リクエストは既存 UI と同コスト。

### 1.1 スキーマ

```sql
CREATE TABLE api_devices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  device_name TEXT NOT NULL,            -- ユーザー命名 or User-Agent
  refresh_hash TEXT NOT NULL UNIQUE,    -- SHA-256(refresh_token) のみ保存
  scopes TEXT[] NOT NULL DEFAULT '{read}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at TIMESTAMPTZ NOT NULL,
  last_ip INET,
  revoked_at TIMESTAMPTZ,               -- 手動失効・盗難検知失効
  rotated_from UUID REFERENCES api_devices(id)
);
CREATE INDEX idx_api_devices_email ON api_devices(email);

CREATE TABLE api_access_tokens (       -- 短寿命 access token も opaque + DB
  token_hash TEXT PRIMARY KEY,
  device_id UUID NOT NULL REFERENCES api_devices(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL       -- 15分
);
```

- refresh token: `crypto.randomBytes(32)` → `bgx_<32hex>` 形式。**DB には SHA-256 ハッシュのみ保存**（DB 漏洩時に即使用不可。現行 `sessions` は平文保存で、ここを改善）。
- access token: 同様に opaque、TTL 15 分、別テーブルで CASCADE 削除。
- 1 エージェント（デバイス）= 1 `api_devices` 行。エージェントごとに個別失効が可能。

### 1.2 Refresh token rotation

1. `POST /api/auth/token` に refresh token を提示。
2. ハッシュ照合 → `revoked_at IS NULL` かつ会員有効を確認。
3. **新 refresh token を発行し、旧行の `refresh_hash` を新ハッシュで上書き + `rotated_from` 連鎖を記録**（または新行挿入・旧行 revoke のどちらかでもよいが、上書き方式は行数が増えない）。
4. 新 access token も同時発行。
5. **再利用検知（reuse detection）**: すでに rotate 済み（前回 rotate から利用）の refresh token が再提示されたら **盗難とみなし、`rotated_from` 連鎖の root から同一デバイス行を全失効**。これが rotation 方式の盗難検知の中核。
6. rotation 有効期限: refresh token 自体は 90 日スライディング（`last_used_at + 90日 < now()` で失効。使用するたび延長）。使われないエージェントは自動的に死ぬ。

### 1.3 エージェント側の実運用

- トークン保存先: `~/.config/beagle/credentials.json`（chmod 600）。Claude Code / Hermes いずれもホーム配下に書けるため統一。**環境変数への常駐は非推奨**（子プロセスへ漏洩しやすい）が、CI 的用途には `BEAGLE_REFRESH_TOKEN` を許容。
- 形式:
  ```json
  {"device_id":"...","refresh_token":"bgx_...","updated_at":"..."}
  ```
- スキル内ロジック: リクエスト前に access token をメモリキャッシュ（有効期限 -60 秒で再取得）、401 なら refresh を 1 回試行、refresh 失敗（410/403）なら認証フローへ再誘導するメッセージを出して終了。**自動再試行ループ禁止**（盗難失効時の無限ループ回避）。
- 同一マシンで複数エージェントが同時に refresh しても競合しないよう、credentials ファイルは lock 付きで read-modify-write。

## 2. 初回認証フロー: OTP + Device Authorization Flow

現行の「メールアドレスだけで即ログイン」はエージェント用トークン発行には弱すぎるため、**OTP を必須化**する。`otp_codes` テーブル・`mailgun.ts` が既存のため実装コストは低い。

### 2.1 CLI device flow（GitHub CLI 方式、採用）

スキルの初回セットアップでエージェントが実行する:

1. エージェント: `POST /api/auth/device` → `{"device_code": "...", "user_code": "ABCD-1234", "verification_uri": "https://bsm.backspace.fm/device", "interval": 5, "expires_in": 900}` を受け取る。`user_code` をターミナルに表示して待機。
2. ユーザー: **通常ブラウザで** `bsm.backspace.fm/device` を開く（既存 Cookie セッションで自動ログイン済み、またはメールアドレス+OTP でログイン）。`user_code` を入力 → デバイス名を確認 → 承認。
3. 承認時に `device_grants` テーブルへ `approved=true, email` を記録。付与スコープはこの画面で選択（デフォルト read）。
4. エージェント: `POST /api/auth/token` を `interval` ごとにポーリング（`slow_down` 準拠）→ `authorization_pending` → 承認後 refresh + access token を受領し credentials に保存。

この方式の利点: **ブラウザの既存認証（Cookie セッション）を信頼の起点にできる**。エージェント側にパスワード/OTP を一切扱わせない、フィッシング耐性（user_code はブラウザ側で確認）、UX が GitHub CLI と同じで既知。

### 2.2 ブラウザ側 OTP（device flow の入口）

- `POST /api/auth/request`（email）→ Ghost 有料会員確認（現行のまま fail closed）→ **6桁 OTP を Mailgun 送信**（`otp_codes` に bcrypt または SHA-256+pepper でハッシュ保存、TTL 10 分、1 使用限り、同一 email への発行は 60 秒に 1 回）。
- `POST /api/auth/verify`（email, code）→ 検証成功で通常セッション発行。連続 5 回失敗で 15 分ロック。
- 既存マジックリンク流用は不採用: リンクをメールからエージェント側に渡す誤用が起きやすく、OTP + ブラウザ承認の方が境界が明確。

## 3. スコープ設計

`api_devices.scopes TEXT[]` で管理。発行は device flow の承認画面でユーザーが選択。

| スコープ | 内容 | 備考 |
|---|---|---|
| `read` | posts / feed / notifications / reactions の取得 | デフォルト。未読更新 API は含めない（後述） |
| `read_state` | 既読マーク・未読同期の書き込み | `read` を包含しない独立スコープ（GET に読み取り影響を与えないため分離） |
| `write` | 投稿・返信・リアクション・お気に入り | 既定 OFF。明示的に選択した場合のみ |
| `chat` | chat チャンネルの読み書き | `write` と独立。chat は誤爆が他者に見えるため別枠 |
| `admin` | 管理操作 | **エージェントには発行禁止**。UI ログイン（OTP セッション）専用 |

危険操作の追加制限:

- 削除・pin・クラブ可視性変更などの破壊的操作はスコープに関わらずエージェントトークンでは不可（API 実装レベルで blocklist）。
- `write` 付きトークンでも投稿頻度上限（後述）と 1 投稿文字数上限を適用。
- whisper / DM 的機能は最終的に要否を確認してから（初期リリースは除外）。
- スコープの追加は再承認必須（既存 refresh token で勝手に昇格しない）。

## 4. レート制限・異常検知

pm2 fork 単一プロセスなので **PostgreSQL をカウンタ格納に使う**（メモリ実装は再起動で消えるため）。

### 4.1 レート制限（トークン種別ごと）

- `rate_limits` テーブル（key=device_id, window_start, count）で固定窓。エージェントトークン:
  - read: 120 req/分、20,000 req/日（大量取得は 5,000 件/リクエストのページング + 429 に `Retry-After`）
  - read_state: 60 req/分
  - write: **10 req/時、50 req/日**（人間が普通に投稿する量の上限。連投事故防止）
  - chat: 30 req/時
- 通常ブラウザセッションには緩めの上限（200 req/分）で誤規制を避ける。429 は `X-RateLimit-*` ヘッダ付き。
- nginx 側でも IP 単位 `limit_req` を併設（認証前のブルートフォース対策: `/api/auth/*` は IP あたり 10 req/分）。

### 4.2 異常検知（housekeeping に集約、既存の定期 purge に追加）

- **refresh token 再利用** → 即時全デバイス失効 + email へ警告メール（最重要シグナル、1.2 参照）。
- 同一 device の `last_ip` が急に大陸を跨ぐような変化 → ログ記録のみ（エージェントは VPS/複数拠点から動くため自動失効はしない。ユーザー通知）。
- 401 連続 20 回/時 → デバイス自動失効（古い credentials での無限リトライの兆候）。
- `write` スコープで深夜の大量投稿・同一内容連投 → デバイス一時停止 + 通知。
- 管理用に `/api/admin/devices`（自分のデバイス一覧・最終使用・失効ボタン）を UI に追加。ユーザー自身が怪しいデバイスを切れることが最重要の検知・対処手段。

## 5. 会員資格連動（失効の確実性）

Ghost が権威ソース（現行 `isPaidMember` と同一原則）。

1. **毎リクエスト検証はしない**（Ghost API を毎回叩くとレイテンシ・quota 問題）。代わりに access token 発行時（15 分ごと）と refresh 時（rotation 時）に Ghost 会員確認を行う。**access token は最長 15 分しか生きないため、退会から最大 15 分で全 API が死ぬ**。
2. refresh 時に `!isPaidMember` なら: その email の全 `api_devices` を `revoked_at=now()`、credentials 無効化。再入会時は device flow をやり直し（再承認 UI で自然に復帰）。
3. Ghost webhook（member.updated / deleted）があれば即失効を追加（ベストエフォート、1–2 が本筋）。
4. ユーザーによる手動失効: デバイス管理 UI、`DELETE /api/auth/device/:id`。
5. 全デバイス緊急失効: パスワード変更に相当する操作として「全セッション+全デバイス失効」ボタンを用意（`sessions` も `api_devices` も email で一括 DELETE/UPDATE 可能）。
6. 90 日未使用の refresh token、期限切れ access token は housekeeping で purge（既存 purgeExpiredAuthRows に追記）。

## 6. 秘密情報を公開リポジトリに置かない原則

- スキル（GitHub 公開）には**シークレットを 1 つも含めない**: refresh token はユーザー端末の `~/.config/beagle/credentials.json` のみ。サーバー側秘密（DB 接続文字列、Mailgun key、pepper）は VPS の `.env` / pm2 ecosystem env。
- スキル内に書くのは: API エンドポイント URL、device flow の手順、トークン自動 refresh ロジック、エラー時の再認証誘導のみ。
- peeper/pepper 等のサーバー秘密が万一スキルに混入しないよう、CI で `gitleaks` 相当のチェックを推奨（任意）。
- credentials ファイルは gitignore 対象外のホーム外に置かれるため誤 commit リスク自体が低いが、スキル側で「credentials を読み出して出力・ログに含めない」規約を明記。

## 7. 移行メモ

- 既存ブラウザ `sessions` は現状維持（Cookie 用途とは別系統）。エージェント用は `api_devices` に完全分離し、混在させない。
- 第 1 段階: `otp_codes` 有効化 + device flow + read/read_state スコープのみ。write/chat は運用実績後に開放。
- DB プール max:10 のため、トークン検証・レート制限チェックは既存リクエストと同じ pool を共有。1 リクエストあたり +1 query（token hash lookup と rate_limit を 1 クエリに統合可）。
