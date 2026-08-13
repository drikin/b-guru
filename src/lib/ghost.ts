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
 * Uses the in-process member cache (60s TTL) — falls back to a direct
 * Ghost API search on cache miss.
 */
export async function findMemberByEmail(
  email: string
): Promise<GhostMember | null> {
  // Try cache first (populated by listMembers or a prior findMemberByEmail)
  const cached = getCachedMembers();
  if (cached) {
    return memberByEmail.get(email.toLowerCase()) ?? null;
  }

  const base = process.env.GHOST_ADMIN_API_URL!;
  const key = process.env.GHOST_ADMIN_API_KEY!;
  const token = makeToken(key);

  const url = `${base}/ghost/api/admin/members/?search=${encodeURIComponent(
    email
  )}&limit=all`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Ghost ${token}`,
      "Accept-Version": "v6.0",
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`Ghost members API error: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const members: GhostMember[] = data.members ?? [];
  // Cache the results so subsequent lookups (including listMembers) are fast.
  if (members.length > 0) setCachedMembers(members);
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
  while (hasMore) {
    const url = `${base}/ghost/api/admin/members/?limit=100&page=${page}&include=tiers&order=created_at%20asc`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Ghost ${token}`,
        "Accept-Version": "v6.0",
      },
      cache: "no-store",
    });
    if (!res.ok) {
      throw new Error(`Ghost members API error: ${res.status} ${await res.text()}`);
    }
    const data = await res.json();
    const batch = data.members ?? [];
    members.push(...batch);
    hasMore = batch.length === 100;
    page++;
    if (page > 20) break; // safety
  }
  setCachedMembers(members);
  return members;
}
