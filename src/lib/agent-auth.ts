/**
 * AI エージェント API の認証・レート制限・監査（フェーズ1 MVP: 読み取りのみ）。
 *
 * 設計: docs/agent-backend-design.md §2-3 / docs/beagle-agent-auth-design.md。
 *
 * - トークンは 32byte 乱数の opaque 文字列（表示は発行時 1 回のみ）。
 *   DB には SHA-256 ハッシュのみ保存（既存 sessions の平文保存を改善）。
 * - 検証: DB 照合（期限/失効）→ 会員資格（Ghost 再判定は
 *   last_membership_check から 6 時間以上経過時のみ。Ghost 判定は既存
 *   isPaidMember を「呼び出しのみ」で再利用し、ここに判定ロジックを複製しない）。
 * - レート制限: PostgreSQL 固定窓（pm2 fork 単一プロセスだが、再起動で
 *   カウンタが消えない DB 実装。beagle-agent-auth-design.md §4 準拠）。
 * - エラーは {error, code, hint} 形式に統一（code でクライアントが分岐する）。
 */
import crypto from "crypto";
import { pool } from "./db";
import { findMemberByEmail, isPaidMember } from "./ghost";
import { ensureUserId } from "./user";
import { clientIp } from "./client-ip";

/** post = ネイティブアプリの人による投稿（タイムラインへの投稿・画像・リアクション）。
 *  write（エージェントの投稿・via=agent）とは別のバケツにして、AI エージェント向けの
 *  厳しい上限（1 時間 10 回）を人のアプリに当てないようにする。 */
export type AgentScope = "read" | "read_state" | "write" | "chat" | "post";

export const AGENT_SCOPES: AgentScope[] = ["read", "read_state", "write", "chat", "post"];

/** トークン TTL（日）。 */
export const AGENT_TOKEN_TTL_DAYS = 30;
/** 1 メールあたりのアクティブトークン上限（デバイスごと）。 */
export const MAX_TOKENS_PER_EMAIL = 10; // 5 → 10（drikin 2026-10-17: Mac・iPhone・iPad・Android・エージェントで足りない）
/** Ghost 会員再判定の最小間隔（時間）。 */
export const MEMBERSHIP_RECHECK_HOURS = 6;

export type AgentErrorCode =
  | "unauthorized"
  | "token_expired"
  | "membership_ended"
  | "rate_limited"
  | "not_found"
  | "forbidden"
  | "invalid_request"
  | "server_error";

export interface AgentErrorBody {
  error: string;
  code: AgentErrorCode;
  hint?: string;
}

/** 統一エラー。ルートはこのステータスと body をそのまま返す。 */
export class AgentAuthError extends Error {
  status: number;
  body: AgentErrorBody;
  constructor(status: number, body: AgentErrorBody) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

function err(status: number, code: AgentErrorCode, error: string, hint?: string) {
  return new AgentAuthError(status, hint ? { error, code, hint } : { error, code });
}

/** トークンの SHA-256 ハッシュ（DB 保存形式）。 */
export function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

export interface IssuedToken {
  /** 平文トークン。発行時のこの 1 回しか表示しない。 */
  token: string;
  tokenId: number;
  expiresAt: string;
  scopes: AgentScope[];
}

/**
 * トークンを発行する。会員判定は呼び出し側（ルート）が既存ロジックで済ませる
 * こと（device flow フェーズ2でも同じゲートを通す）。
 */
export async function issueAgentToken(input: {
  email: string;
  deviceName: string;
  scopes: AgentScope[];
}): Promise<IssuedToken> {
  const email = input.email.trim().toLowerCase();
  const scopes = normalizeScopes(input.scopes);
  const token = `bga_${crypto.randomBytes(32).toString("hex")}`;
  // トークン上限の TOCTOU 対策: 発行 INSERT を条件付きにし、
  //   同時発行でも MAX_TOKENS_PER_EMAIL を超えられない（1 クエリでアトミック）。
  const res = await pool.query(
    `INSERT INTO agent_tokens (token_hash, email, scopes, device_name, expires_at, last_membership_check)
     SELECT $1, $2, $3, $4, now() + make_interval(days => $5), now()
     WHERE (SELECT COUNT(*) FROM agent_tokens
            WHERE email = $2 AND revoked_at IS NULL AND expires_at > now()) < $6
     RETURNING id, expires_at`,
    [hashToken(token), email, scopes, input.deviceName.trim() || "unknown device", AGENT_TOKEN_TTL_DAYS, MAX_TOKENS_PER_EMAIL]
  );
  if (res.rowCount === 0) {
    throw new AgentAuthError(400, {
      error: `発行できるトークンは ${MAX_TOKENS_PER_EMAIL} 本までです`,
      code: "forbidden",
      hint: "不要なデバイスを失効してから再試行してください",
    });
  }
  const r = res.rows[0];
  return {
    token,
    tokenId: r.id,
    expiresAt: new Date(r.expires_at).toISOString(),
    scopes,
  };
}

/** 未知/無効スコープを落とし、既定 read を保証。 */
export function normalizeScopes(scopes: unknown): AgentScope[] {
  const list = Array.isArray(scopes) ? scopes : [];
  const valid = list.filter((s): s is AgentScope =>
    typeof s === "string" && (AGENT_SCOPES as string[]).includes(s)
  );
  return valid.length > 0 ? [...new Set(valid)] : ["read"];
}

/** アクティブ（未失効・未期限）トークン数。 */
export async function countActiveTokens(email: string): Promise<number> {
  const res = await pool.query(
    `SELECT COUNT(*)::int AS c FROM agent_tokens
     WHERE email = $1 AND revoked_at IS NULL AND expires_at > now()`,
    [email.trim().toLowerCase()]
  );
  return Number(res.rows[0]?.c ?? 0);
}

/** 自分のトークン（デバイス）一覧。email/ハッシュは返さない。 */
export async function listAgentTokens(email: string): Promise<
  {
    id: number;
    device_name: string;
    scopes: string[];
    created_at: string;
    expires_at: string;
    last_used_at: string | null;
    last_ip: string | null;
    revoked: boolean;
  }[]
> {
  const res = await pool.query(
    `SELECT id, device_name, scopes, created_at, expires_at, last_used_at, last_ip,
            (revoked_at IS NOT NULL) AS revoked
       FROM agent_tokens
      WHERE email = $1
      ORDER BY created_at DESC`,
    [email.trim().toLowerCase()]
  );
  return res.rows.map((r: any) => ({
    id: r.id,
    device_name: r.device_name,
    scopes: r.scopes ?? [],
    created_at: new Date(r.created_at).toISOString(),
    expires_at: new Date(r.expires_at).toISOString(),
    last_used_at: r.last_used_at ? new Date(r.last_used_at).toISOString() : null,
    last_ip: r.last_ip ?? null,
    revoked: !!r.revoked,
  }));
}

/** トークン失効。tokenId と email の両方で所有確認する（他人のトークンは消せない）。 */
export async function revokeAgentToken(tokenId: number, email: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE agent_tokens SET revoked_at = now()
      WHERE id = $1 AND email = $2 AND revoked_at IS NULL`,
    [tokenId, email.trim().toLowerCase()]
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * 同じデバイス名の有効なトークンを失効させる（ネイティブアプリの再ログイン用）。
 * アプリを入れ直したりログインし直したりすると、手元から消えた古いトークンが
 * 有効なまま上限（MAX_TOKENS_PER_EMAIL）の枠を占め続ける。発行時に `replace_same_device: true` が来たときだけ、
 * 本人の・完全一致の名前のものに限って片付ける。返り値は失効させた本数。
 */
export async function revokeTokensByDeviceName(email: string, deviceName: string): Promise<number> {
  const res = await pool.query(
    `UPDATE agent_tokens SET revoked_at = now()
      WHERE email = $1 AND device_name = $2 AND revoked_at IS NULL AND expires_at > now()`,
    [email.trim().toLowerCase(), deviceName.trim()]
  );
  return res.rowCount ?? 0;
}

/** 検証済みトークンが運べるコンテキスト。レスポンスには email を出さない。 */
export interface AgentContext {
  tokenId: number;
  email: string;
  userId: string;
  deviceName: string;
  scopes: AgentScope[];
  expiresAt: string;
}

/**
 * Authorization: Bearer ヘッダを検証する。
 * - DB 照合（存在/失効/期限）
 * - 会員資格: last_membership_check から 6h 以上経過していれば Ghost 再判定
 *   （非会員 → トークン失効 + membership_ended / Ghost 到達不能 → fail closed）
 * - last_used_at / last_ip を更新
 */
export async function verifyAgentToken(
  authHeader: string | null,
  opts: { ip?: string | null } = {}
): Promise<AgentContext> {
  const raw = (authHeader ?? "").trim();
  const m = /^Bearer\s+(\S+)$/i.exec(raw);
  if (!m) {
    throw err(401, "unauthorized", "認証が必要です", "Authorization: Bearer *** を付けてください");
  }
  // 認証前レート制限: 未知/無効トークンによる総当たり・DB lookup 濫用を抑える。
  //   数えるのは失敗した検証だけ（成功は数えない — 正規エージェントの read 120/分を妨げない）。
  if (opts.ip && !(await checkPreAuthLimit(opts.ip))) {
    throw err(429, "rate_limited", "リクエストが多すぎます", "しばらくしてから再試行してください");
  }
  const res = await pool.query(
    `SELECT id, token_hash, email, scopes, device_name, expires_at, revoked_at, last_membership_check
       FROM agent_tokens WHERE token_hash = $1`,
    [hashToken(m[1])]
  );
  const row = res.rows[0];
  if (!row) {
    await recordPreAuthFailure(opts.ip);
    throw err(401, "unauthorized", "トークンが無効です");
  }
  if (row.revoked_at) {
    await recordPreAuthFailure(opts.ip);
    throw err(401, "unauthorized", "トークンは失効済みです", "設定ページで再発行してください");
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    await recordPreAuthFailure(opts.ip);
    throw err(401, "token_expired", "トークンの有効期限が切れています", "再発行してください");
  }

  // 会員資格の継続確認（6h キャッシュ）。Ghost が権威ソース（UI と同一ロジック）。
  const last = row.last_membership_check ? new Date(row.last_membership_check).getTime() : 0;
  if (Date.now() - last >= MEMBERSHIP_RECHECK_HOURS * 3600_000) {
    let member;
    try {
      member = await findMemberByEmail(row.email);
    } catch (e: any) {
      // Fail closed: Ghost 到達不能では検証を通さない（beagle-agent-auth-design.md）。
      throw err(502, "unauthorized", "会員確認サービスに接続できません", "しばらくしてから再試行してください");
    }
    if (!member || !isPaidMember(member)) {
      await pool.query(
        `UPDATE agent_tokens SET revoked_at = now() WHERE id = $1`,
        [row.id]
      );
      throw err(403, "membership_ended", "BSM 会員資格が確認できません", "backspace.fm で会員状況をご確認ください");
    }
    await pool.query(
      `UPDATE agent_tokens SET last_membership_check = now() WHERE id = $1`,
      [row.id]
    );
  }

  // 使用記録（ベストエフォート — 失敗で検証を落とさない）。
  try {
    await pool.query(
      `UPDATE agent_tokens SET last_used_at = now(), last_ip = COALESCE($2, last_ip) WHERE id = $1`,
      [row.id, opts.ip ?? null]
    );
  } catch {
    /* ignore */
  }

  const userId = await ensureUserId(row.email);
  return {
    tokenId: row.id,
    email: row.email,
    userId,
    deviceName: row.device_name ?? "",
    scopes: (row.scopes ?? []) as AgentScope[],
    expiresAt: new Date(row.expires_at).toISOString(),
  };
}

/** スコープ確認。無ければ forbidden。 */
export function requireScope(ctx: AgentContext, scope: AgentScope): void {
  if (!ctx.scopes.includes(scope)) {
    throw err(403, "forbidden", `このトークンには ${scope} スコープがありません`, "設定ページで再発行してください");
  }
}

// ---- レート制限（DB 固定窓） ----

export interface RateRule {
  limit: number;
  window: string; // PostgreSQL interval 文字列
}

export const RATE_RULES: Record<AgentScope, RateRule> = {
  read: { limit: 120, window: "1 minute" },
  read_state: { limit: 60, window: "1 minute" },
  write: { limit: 10, window: "1 hour" },
  chat: { limit: 120, window: "1 hour" }, // 送信 + リアクション。人のチャット（ネイティブアプリ）が詰まらない水準
  post: { limit: 60, window: "1 hour" }, // アプリからの投稿・画像・リアクション（1 投稿 = upload + publish の 2 回）
};

export interface RateResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number; // 秒（allowed 時は 0）
}

/**
 * 固定窓カウンタを 1 クエリで進める。窓が過ぎていればリセット。
 * （UPSERT の CASE で原子的に処理 — 単一プロセスでも競合安全。）
 */
export async function checkRateLimit(tokenId: number, scope: AgentScope): Promise<RateResult> {
  const rule = RATE_RULES[scope];
  const key = `${tokenId}:${scope}`;
  const res = await pool.query(
    `INSERT INTO rate_limits (key, window_start, count)
     VALUES ($1, now(), 1)
     ON CONFLICT (key) DO UPDATE SET
       window_start = CASE WHEN rate_limits.window_start < now() - ($2::text)::interval
                           THEN now() ELSE rate_limits.window_start END,
       count = CASE WHEN rate_limits.window_start < now() - ($2::text)::interval
                    THEN 1 ELSE rate_limits.count + 1 END
     RETURNING count, window_start`,
    [key, rule.window]
  );
  const r = res.rows[0];
  const count = Number(r.count);
  if (count <= rule.limit) {
    return { allowed: true, remaining: rule.limit - count, retryAfter: 0 };
  }
  const started = new Date(r.window_start).getTime();
  const windowMs = rule.window === "1 hour" ? 3600_000 : 60_000;
  const retryAfter = Math.max(1, Math.ceil((started + windowMs - Date.now()) / 1000));
  return { allowed: false, remaining: 0, retryAfter };
}

/** 監査ログ（ベストエフォート — 記録失敗でリクエストを落とさない）。 */
export async function recordAudit(
  tokenId: number | null,
  endpoint: string,
  status: number,
  ip?: string | null
): Promise<void> {
  try {
    await pool.query(
      `INSERT INTO agent_audit_log (token_id, endpoint, status, ip) VALUES ($1, $2, $3, $4)`,
      [tokenId, endpoint, status, ip ?? null]
    );
  } catch {
    /* ignore */
  }
}

/** 認証前レート制限: IP 単位で失敗した検証を 150 回/1時間まで。 */
const PREAUTH_LIMIT = 150;
const PREAUTH_WINDOW = "1 hour";

/**
 * 認証前レート制限（無効トークンのブルートフォース/DoS 対策）。
 * 窓内の失敗回数が上限に達した IP を拒否する。ここではカウントを進めない
 * （成功した検証は数えない — 失敗時に recordPreAuthFailure で加算）。
 */
export async function checkPreAuthLimit(ip: string | null): Promise<boolean> {
  if (!ip) return true; // IP が取れない場合は制限できない（監査ログで追跡）
  try {
    const res = await pool.query(
      `SELECT count FROM rate_limits
        WHERE key = $1 AND window_start >= now() - ($2::text)::interval`,
      [`preauth:${ip}`, PREAUTH_WINDOW]
    );
    return Number(res.rows[0]?.count ?? 0) < PREAUTH_LIMIT;
  } catch {
    return true; // 制限機構自体の故障でユーザーを締め出さない
  }
}

/** 失敗した検証を IP 単位で数える（checkRateLimit と同じ key 単位の固定窓）。 */
export async function recordPreAuthFailure(ip: string | null | undefined): Promise<void> {
  if (!ip) return;
  try {
    await pool.query(
      `INSERT INTO rate_limits (key, window_start, count)
       VALUES ($1, now(), 1)
       ON CONFLICT (key) DO UPDATE SET
         window_start = CASE WHEN rate_limits.window_start < now() - ($2::text)::interval
                             THEN now() ELSE rate_limits.window_start END,
         count = CASE WHEN rate_limits.window_start < now() - ($2::text)::interval
                      THEN 1 ELSE rate_limits.count + 1 END`,
      [`preauth:${ip}`, PREAUTH_WINDOW]
    );
  } catch {
    /* ignore — 記録失敗でリクエストを落とさない */
  }
}

/**
 * LIKE ワイルドカード（% _）をエスケープし、パターン長も制限する。
 * listPosts の ILIKE に渡す前の資源枯渇（'%%%%%' 等の広範走査）防止。
 */
export function sanitizeLikePattern(input: string | undefined): string | undefined {
  const s = input?.trim();
  if (!s) return undefined;
  const escaped = s.replace(/[\\%_]/g, (ch) => `\\${ch}`).slice(0, 100);
  return escaped;
}

/**
 * ルート共通ハンドラ: 検証 → スコープ → レート制限 → 監査 → handler。
 * エラーは AgentAuthError をそのまま上位（withAgentError で JSON 化）へ投げる。
 */
export async function withAgent(
  req: Request,
  endpoint: string,
  scope: AgentScope | AgentScope[] | null,
  handler: (ctx: AgentContext) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>
): Promise<{ status: number; body: unknown; headers?: Record<string, string> }> {
  let ctx: AgentContext | null = null;
  let ip: string | null = null;
  try {
    ip = clientIp(req);
    ctx = await verifyAgentToken(req.headers.get("authorization"), { ip });
    // Several accepted scopes: the first one the token has decides (and its rate bucket).
    const c = ctx;
    const need = Array.isArray(scope) ? scope.find((s) => c.scopes.includes(s)) ?? scope[0] : scope;
    if (need) requireScope(ctx, need);
    if (need) {
      const rate = await checkRateLimit(ctx.tokenId, need);
      if (!rate.allowed) {
        throw err(429, "rate_limited", "レート制限に達しました", `${rate.retryAfter} 秒後に再試行してください`);
      }
    }
    const out = await handler(ctx);
    await recordAudit(ctx.tokenId, endpoint, out.status, ip);
    return out;
  } catch (e) {
    const status = e instanceof AgentAuthError ? e.status : 500;
    const body =
      e instanceof AgentAuthError
        ? e.body
        : { error: "サーバーエラー", code: "server_error" as AgentErrorCode };
    if (status >= 500 && !(e instanceof AgentAuthError)) {
      console.error(`[agent:${endpoint}]`, (e as Error)?.message);
    }
    if (ctx) await recordAudit(ctx.tokenId, endpoint, status, ip);
    else await recordAudit(null, endpoint, status, ip);
    return { status, body };
  }
}
