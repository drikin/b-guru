# B-guru を AI エージェントのバックエンドにする全体設計（「俺々ビーグル」構想）

対象: bsm.backspace.fm (B-guru, Next.js 16 / Mantine / PostgreSQL / pm2 / nginx, リポジトリ github.com/drikin/b-guru)
本ドキュメントは設計提案のみ（実装を含まない）。

---

## 1. スキル配布形態の比較と推奨

| 形態 | メリット | デメリット | 評価 |
|---|---|---|---|
| **生 REST 直叩き** | サーバー側工数ゼロ | エージェントごとに認証・リトライ・ページングを自作、破綻しやすい | × |
| **MCP サーバー** | 標準ツールとして Claude / 各種クライアントに透過接続可。ツール名・スキーマが機械可読 | 配布・実行環境（node/npx, 長時間接続, トークン管理）がユーザー負担。Hermes の場合でも常駐プロセス設定が必要。個人ポータルのスケールには過剰 | △（将来オプション） |
| **CLI ツール (`bsg`) + Hermes/Anthropic スキル (SKILL.md)** | スキルの「配ってプロンプトに投げ込む」モデルに最適。`npx bsg …` で状態不要、トークンはローカル設定ファイルに置くだけ。JSON 出力・終了コードでエージェントが自前判断できる。サーバーは HTTP API を用意するだけでよい | Claude Desktop 等の「MCP 前提」クライアントには非対応 | ◎（推奨） |

**推奨: CLI（`bsg`）+ スキル文書が主、MCP はフェーズ3の薄いラッパーとして追加。**
CLI は HTTP API の薄いクライアント（エラー・ページング・レート制限を機械可読 JSON で表現する層）に徹し、賢さはすべてエージェント側に置く。MCP が必要になったら同じ API を包むだけでよい（API が正本、CLI/MCP はどちらも薄いビュー）。

### スキルリポジトリ構成（GitHub 公開、例: drikin/b-guru-skill）

```
b-guru-skill/
  SKILL.md               # 概要・セットアップ（bsg login）・コマンド一覧・ユースケース例
  references/
    api.md               # 全エンドポイントの機械可読仕様（スキーマ+例）— bsg api-docs でも出せる
    use-cases.md         # 「俺々ビーグル」レシピ集（後述 §5）
  scripts/bsg            # または npx @drikin/bsg で配布
```

- SKILL.md 冒頭にセットアップ手順を1本化: `npx bsg login` → ブラウザ/プロンプトでメール入力 → 会員判定 → トークン発行 → `~/.config/bsg/token.json` に保存。以降はスキル/エージェントが `bsg` を呼ぶだけで動く。
- トークン更新は CLI が自動（後述 §3）。会員でなくなったら `bsg` は明確なエラーを出し、スキルはその旨をユーザーに伝えるだけ。
- スキルは「配布物」であって認証情報を含まない。公開リポジトリに置いても安全（b-guru 本体と同じ原則: .env に相当するものはリポジトリに入れない）。

---

## 2. API 設計（エージェント向け /api/agent/*）

### 基本方針

- **既存 /api/* を再利用しない**。理由: ①UI 向けレスポンス形状（FeedPost 複合 DTO、display name 解決済み等）はエージェント用途に過剰/非自明 ② UI 変更が API 変更に直結して破壊的 ③ email 漏洩修正（2026-09-28 の 9 系統問題）と同じ境界をもう一度作らない。
- 専用名前空間 `https://bsm.backspace.fm/api/agent/*` を新設。共通ミドルウェア層（`src/lib/agent-auth.ts`）でトークン検証→会員確認→レート制限→監査ログを一括処理。内部実装は既存 lib（posts.ts / chat.ts / notifications.ts 等）を直接呼ぶ（UI ルートを経由しない）。
- **識別子は不透明 user_id のみ**。email・Ghost member 情報は一切レスポンスに含めない（既存の privacy 原則を踏襲）。

### 認証

- `POST /api/agent/token` — body `{email}`。Ghost 有料判定（isPaidMember: status paid または comped+active subscription）を通したら `agent_tokens` にランダム 32byte トークンを発行（TTL 30日）。戻り `{token, expiresAt, userId}`。UI ログインと同一の判定ロジックを再利用。
- 以降 `Authorization: Bearer <token>`。
- リフレッシュ: `POST /api/agent/token/refresh`（有効トークンで新しいトークン発行・旧トークン失効）。CLI が expires 前 7 日以内の呼び出しで自動更新。会員資格が切れたら新トークンは発行されない → 実質「会員である限り自動更新で使い続けられる」。
- トークン1人 N 本まで（例: 5 本・デバイスごと）、監査ログに token_id を記録。

### 開くデータ（読み取り）

| エンドポイント | 内容 | 備考 |
|---|---|---|
| `GET /api/agent/me` | 自身の userId / 表示名 / トークン有効期限 | |
| `GET /api/agent/posts` | タイムライン（フィルタ: club, search, since_id/until_id, fav, bookmark, author_user_id） | カーソルページング `?limit=50&cursor=...`。生 JSON + `next_cursor` |
| `GET /api/agent/posts/:id` | スレッド1本（ルート+返信ツール） | |
| `GET /api/agent/search?q=` | 全文検索（既存 search ロジック） | |
| `GET /api/agent/users/:user_id` | 公開プロフィール+投稿一覧 | |
| `GET /api/agent/clubs` | 部活一覧・カタログ | |
| `GET /api/agent/chat` | チャット履歴（自ユーザー可視分） | |
| `GET /api/agent/notifications` | 自身の通知 | |
| `GET /api/agent/episodes` | エピソード/同期データ（/api/sync 相当の公開範囲） | |
| `GET /api/agent/stats` | 統計: 日別投稿数、トップ投稿、活動ユーザー数等の集計クエリ | 要約・レポート用。素の SQL を生やさず定義済み集計のみ |
| `GET /api/agent/bulk/export` | 個人向け一括取得（自分の投稿/既読/いいね/ブックマークの JSON ダンプ、分割チャンク） | 要約・引っ越し用途。レート制限を別枠にする |

### 書き込み（段階的に開放）

- フェーズ MVP: `POST /api/agent/posts`（新規投稿）、`POST /api/agent/reactions`（リアクション）、`POST /api/agent/read`（既読）、`POST /api/agent/bookmarks`。
- フェーズ拡張: 返信・チャット送信・通知既読・ポスト投票。
- 常に**自身の ID でのみ**書ける（server-side で token→userId 解決し body を信用しない）。ささやき（whisper）は UI の非公開性質上 MVP では開放しない。
- 投稿には `via: "agent"` を自動付与し、UI 上にエージェント由来マークを出せるようにする（透過性）。

### 運用品質（スキルが自己記述的に使える形）

- **レート制限**: per-token で読み 120 req/min / 書き 30 req/min / bulk 3 req/hour。`429` に `Retry-After` と `{error, code:"rate_limited", retryAfter}` を返す。in-process Map で既存パターン（ai/chat と同型）を流用。
- **ページネーション**: 全一覧系はカーソル（`cursor` + `next_cursor`）。limit 上限 100。
- **機械可読エラー**: 全エラーを `{error: string, code: string, hint?: string}` 形式に統一。`code` は `unauthorized / token_expired / membership_ended / rate_limited / not_found / forbidden` 等。スキルは `code` で分岐（token_expired→自動再ログイン、membership_ended→ユーザーに案内）。
- **自己記述**: `GET /api/agent/openapi.json`（OpenAPI 3.1）を用意。`bsg api-docs` でこれをそのまま出力し、スキルの references/api.md と同一内容を保つ（ドキュメント二重管理をなくす）。
- **SSE 相当**は MVP 外。エージェントはポーリング（`since_id`）で十分。将来 `/api/agent/stream`（トークン認証 SSE）を追加可能。

---

## 3. 会員資格の継続確認とトークン失効

現状の管理構造:
- 会員の正本は **Ghost Admin API**（`isPaidMember`: status=paid、または comped でも subscriptions[].status=active）。B-guru 側は `users` / `user_profiles` / `sessions`（DB opaque トークン・30日 TTL・Cookie）で保持。
- UI セッションは「発行時に有料確認・以降30日間無条件」が実質（Ghost 退会が即反映されない）。

エージェントトークンでの設計:

1. **発行時**: Ghost 有料判定必須（UI と同一ロジック）。非会員は 403。
2. **継続確認**: トークン検証ミドルウェアで (a) DB トークン有効性（期限・失効フラグ）、(b) `agent_tokens.last_membership_check` から **6 時間以上経過していたら Ghost 再判定**。非会員化を検知したらトークンを失効させ、以後 `401 {code:"membership_ended"}`。
   - Ghost を毎リクエスト叩かない（レイテンシ・Admin API 負荷）。6時間バッチ + 退会は最長6時間の許容ラグ。厳密にやるなら Ghost webhook / 1日1回の全会員再判定 cron。
3. **失効挙動**: CLI は `membership_ended` を受けて動作停止し「BSM 会員資格が確認できません。backspace.fm でご確認ください」と表示。トークン自動更新も会員でない限り失敗する（二重のゲート）。監査ログに記録。
4. **UI セッションとの関係**: UI セッションはそのまま（エージェント用トークンは別テーブル・別失効）。共通化するなら将来的に UI セッションにも同様の定期再判定を導入可能だが本設計ではスコープ外。
5. **失効手段**: `DELETE /api/agent/token`（自分のトークン失効・CLI logout）+ 管理者用の一括失効は admin lib 経由。

---

## 4. 「俺々ビーグル」ユースケースと API が満たすべきデータ形

| ユースケース | 必要なデータ形 |
|---|---|
| 「今週のタイムライン要約レポートを私のスタイルで書いて」 | `GET /posts?since=...` の生 JSON（id, userId, display_name, text, createdAt, club, replyCount, reactionCount）+ 一括取得 |
| 「俺の投稿だけ一覧して振り返り記事に」 | `?author_user_id=me` + `bulk/export` |
| 「この部活の盛り上がりをグラフに」 | `stats`（日別投稿数・リアクション数・アクティブ人数） |
| 「〜についての過去スレッド全部拾って議論を整理」 | `search` + thread 取得（返信ツリー） |
| 「毎朝トレンド5件を Discord に投げる」 | `trends` 相当の読み取り + 投稿書き込み（報告投稿） |
| 「既読の進み具合を分析」 | `read` 状態のエクスポート |
| 「気に入った投稿を Klip に集めて娘に見せる」 | `bookmarks`/`fav` 読み取り → 外部出力 |

満たすべき性質:
- **生 JSON**（UI 用 DTO ではなくフラットで安定したスキーマ）+ バージョンフィールド（`apiVersion: 1`）。
- **検索**（全文+部活/ユーザー/期間フィルタ）。
- **統計**（定義済み集計エンドポイント。エージェントに SQL を生で通さない）。
- **要約用一括取得**（bulk export、チャンク化、時間帯フィルタ）。
- **書き込みは自分名義のみ**、`via:"agent"` 透過性。
- スキーマは OpenAPI で固定し、破壊的変更は `apiVersion` を上げて旧版を並走させる（スキル側の壊れを防ぐ）。

---

## 5. 実装フェーズ分割と工数概算

### フェーズ 0: 設計固め（0.5 日）
- OpenAPI スキーマ初版・`agent_tokens` テーブル定義・レート制限/エラーコード一覧の確定。

### フェーズ 1: MVP「読み取り＋ログイン」（3〜5 日）
- `src/lib/agent-auth.ts`（トークン CRUD・Ghost 再判定 6h キャッシュ・監査ログ）
- `/api/agent/token`, `/me`, `/posts`, `/posts/:id`, `/search`, `/clubs`, `/notifications`
- レート制限・カーソルページング・統一エラー形状・OpenAPI 出力
- **工数根拠**: 既存 lib（posts.ts 等）再利用でエンドポイント1本あたり半日程度、認証ミドルウェアが本体。

### フェーズ 2: CLI `bsg` + スキル公開（2〜3 日）
- Node CLI（login/refresh/api-docs/各コマンド、トークンを `~/.config/bsg/` に保存・自動更新）
- SKILL.md + references/api.md + use-cases.md、公開リポジトリ作成
- **検証**: 実際に Claude Code / Hermes からスキルをインストールして動くことを E2E 確認。

### フェーズ 3: 書き込み系（2〜3 日）
- `POST /api/agent/posts` / `reactions` / `read` / `bookmarks`、`via:"agent"` 表示、レート制限の書き込み枠、誤操作ガード（同一テキスト連投検知=既存 duplicates 流用）。

### フェーズ 4: 拡張（各自判断）
- `stats` / `bulk/export`（2〜3 日）
- MCP サーバーラッパー（1〜2 日・CLI のロジック再利用）
- SSE stream、drinews/episode データの開放範囲拡大

**合計目安**: MVP〜スキル公開で約 1 週間、書き込み込みで約 2 週間（エージェント開発前提の概算・既存 lib 再利用込み）。

### 主要リスクと対策
- **email/個人情報漏洩の再発**: 全レスポンスを DTO レビュー（既存 leak-scan.mjs を agent API 向けに拡張する）。
- **Ghost Admin API 負荷**: 6h キャッシュ + 失敗時 fail-closed。
- **スキルの破壊的変更**: OpenAPI バージョニングと `bsg api-docs` の単一正本化。
- **VPS リソース**: レート制限と pm2 メモリ上限（400M）内で収まる設計。DB 追加テーブルは `agent_tokens` と `agent_audit_log`（履歴は 90 日で掃除、既存 housekeeping.ts に統合）のみで最小限。
