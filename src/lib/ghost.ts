/* Ghost Admin API client:
 * - JWT auth (Admin API key)
 * - members lookup to verify paid membership
 * - In-process cache (60s TTL) to avoid hammering Ghost on every publish
 */
import crypto from "crypto";

// ---- In-process member cache (TTL 60s) ----
const MEMBER_CACHE_TTL = 60_000; // 60 seconds
let memberCache: { at: number; members: GhostMember[] } | null = null;
const memberByEmail = new Map<string, GhostMember>();
/** 会員一覧を辿るページの上限（1 ページ 100 人）。暴走よけ。今の会員数（約 900 人）の 10 倍以上。 */
export const MEMBER_LIST_MAX_PAGES = 200;

/** Ghost への 1 回の問い合わせの上限（ミリ秒）。Ghost が「つながるが応答しない」とき、以前は 25 秒以上
 *  止まり、タイムラインの include=display や @ の候補まで待たされた（QA 2026-10-22）。 */
export const GHOST_FETCH_TIMEOUT_MS = 4_000;
let ghostTimeoutMs = GHOST_FETCH_TIMEOUT_MS;
/** Ghost に問い合わせられなかった（応答しない・打ち切り・接続できない・5xx）。「会員でない」という答えとは別。
 *  unreachable=false は 4xx など「届いたが答えが使えない」とき。 */
export class GhostUnavailableError extends Error {
  constructor(message: string, readonly unreachable: boolean, readonly status?: number) {
    super(message);
    this.name = "GhostUnavailableError";
  }
}

/** テスト用: 上限を短くする。 */
export function _setGhostTimeoutForTest(ms: number | null): void {
  ghostTimeoutMs = ms ?? GHOST_FETCH_TIMEOUT_MS;
}

function getCachedMembers(): GhostMember[] | null {
  if (memberCache && Date.now() - memberCache.at < MEMBER_CACHE_TTL) {
    return memberCache.members;
  }
  return null;
}

function setCachedMembers(members: GhostMember[]): void {
  memberCache = { at: Date.now(), members };
  memberByEmail.clear();
  for (const m of members) {
    memberByEmail.set(m.email.toLowerCase(), m);
  }
}

function makeToken(key: string): string {
  const parts = key.split(":", 1);
  const kid = parts[0];
  const secret = key.slice(key.indexOf(":") + 1); // everything after first ':'
  // secret is hex-encoded — convert to bytes before HMAC
  const secretBytes = Buffer.from(secret, "hex");
  const header = { kid, typ: "JWT", alg: "HS256" };
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + 300, aud: "/admin/" };
  const b64 = (obj: object) =>
    Buffer.from(JSON.stringify(obj)).toString("base64url");
  const headerPayload = `${b64(header)}.${b64(payload)}`;
  const sig = crypto
    .createHmac("sha256", secretBytes)
    .update(headerPayload)
    .digest("base64url");
  return `${headerPayload}.${sig}`;
}

export interface GhostMember {
  id: string;
  email: string;
  name?: string;
  avatar_image?: string;
  status: string; // 'free' | 'paid'
  subscriptions?: {
    status: string; // 'active' etc
    tier?: { name?: string };
  }[];
}

/**
 * Look up a member by email.
 * Uses the in-process member cache (60s TTL) when it has the member. If the
 * cache does not have them, ALWAYS asks Ghost directly for that one email
 * (filter=email:'…') before answering "not a member": the cached list can be
 * incomplete (it is capped by pages), and a null here revokes an app token.
 * Unreachable Ghost → GhostUnavailableError (the caller decides; agent-auth
 * applies its 24 h grace).
 */
export async function findMemberByEmail(
  email: string
): Promise<GhostMember | null> {
  // Try cache first (populated by listMembers or a prior findMemberByEmail)
  const cached = getCachedMembers();
  if (cached) {
    const hit = memberByEmail.get(email.toLowerCase());
    if (hit) return hit;
    // 一覧に居ない: 一覧が途中で打ち切られている・一覧の後に入会した、などがありうるので直接確かめる
  }

  const base = process.env.GHOST_ADMIN_API_URL!;
  const key = process.env.GHOST_ADMIN_API_KEY!;
  const token = makeToken(key);

  // その人のメールだけを完全一致で引く（NQL の文字列。' と \ は逃がす）。
  const nql = `email:'${email.toLowerCase().replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
  const url = `${base}/ghost/api/admin/members/?filter=${encodeURIComponent(nql)}&limit=all`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        Authorization: `Ghost ${token}`,
        "Accept-Version": "v6.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(ghostTimeoutMs),
    });
  } catch (e) {
    // 打ち切り（4 秒）・接続できない
    throw new GhostUnavailableError(`Ghost に届きません: ${(e as Error)?.message}`, true);
  }
  if (!res.ok) {
    throw new GhostUnavailableError(
      `Ghost members API error: ${res.status} ${await res.text().catch(() => "")}`,
      res.status >= 500,
      res.status
    );
  }
  const data = await res.json();
  const members: GhostMember[] = data.members ?? [];
  // Index these search hits into the fast email map for repeat lookups, but do
  // NOT overwrite the shared full-member cache (`setCachedMembers`): Ghost's
  // `search=<email>` only matches the queried email, so replacing the whole
  // list with it makes /api/members (the @mention suggestion source) return
  // just that one member instead of everyone. The full list cache is only ever
  // filled by listMembers().
  for (const m of members) {
    memberByEmail.set(m.email.toLowerCase(), m);
  }
  // exact email match
  const found = members.find(
    (m) => m.email.toLowerCase() === email.toLowerCase()
  );
  return found ?? null;
}

/** Returns true if the member has an active paid subscription. */
export function isPaidMember(m: GhostMember): boolean {
  if (m.status === "paid") return true;
  return (
    Array.isArray(m.subscriptions) &&
    m.subscriptions.some(
      (s) => s.status === "active" || s.status === "trialing"
    )
  );
}

/**
 * Fetch all members (paginated) from Ghost. Uses in-process cache (60s TTL).
 * Returns active paid members (used for newsletter emailing).
 */
export async function listMembers(): Promise<GhostMember[]> {
  const cached = getCachedMembers();
  if (cached) return cached;

  const base = process.env.GHOST_ADMIN_API_URL!;
  const key = process.env.GHOST_ADMIN_API_KEY!;
  const token = makeToken(key);

  const members: GhostMember[] = [];
  let page = 1;
  let hasMore = true;
  // 最後のページまで辿る（以前は 20 ページ＝2000 人で打ち切っていた）。暴走よけの上限は
  // MEMBER_LIST_MAX_PAGES ページ（100 人ずつ）。60 秒のキャッシュがあるので Ghost への問い合わせは
  // 1 分に「会員数 ÷ 100」回まで。上限に達したらログを残す（findMemberByEmail は直接確かめるので誤判定しない）。
  while (hasMore) {
    const url = `${base}/ghost/api/admin/members/?limit=100&page=${page}&include=tiers&order=created_at%20asc`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Ghost ${token}`,
        "Accept-Version": "v6.0",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(ghostTimeoutMs),
    });
    if (!res.ok) {
      throw new Error(`Ghost members API error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const batch = data.members ?? [];
    members.push(...batch);
    // Ghost の pagination.next（次のページ番号・最後は null）に従う。無ければ 100 件そろっているかで判断。
    const pg = data.meta?.pagination;
    hasMore = pg && "next" in pg ? Boolean(pg.next) : batch.length === 100;
    page++;
    if (hasMore && page > MEMBER_LIST_MAX_PAGES) {
      console.error(`Ghost listMembers: ${MEMBER_LIST_MAX_PAGES} ページ（${MEMBER_LIST_MAX_PAGES * 100} 人）で打ち切った`);
      break;
    }
  }
  setCachedMembers(members);
  return members;
}
