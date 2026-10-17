/* LiveKit (voice rooms) — access tokens, webhook verification and the server
 * API (Twirp over HTTPS). No dependencies, just node:crypto + fetch, like apns.ts.
 *
 * Config (production .env; the secret never goes in the repo):
 *   LIVEKIT_URL         wss://<project>.livekit.cloud  (what clients connect to)
 *   LIVEKIT_API_KEY     API key  (JWT `iss`)
 *   LIVEKIT_API_SECRET  API secret (HS256 signing key)
 * Without all three, voice is disabled and every call is a no-op — so this code
 * can ship before the LiveKit project exists without changing production. */
import crypto from "crypto";

export interface LiveKitConfig {
  url: string;
  apiKey: string;
  apiSecret: string;
}

export function livekitConfig(): LiveKitConfig | null {
  const url = process.env.LIVEKIT_URL?.trim();
  const apiKey = process.env.LIVEKIT_API_KEY?.trim();
  const apiSecret = process.env.LIVEKIT_API_SECRET?.trim();
  if (!url || !apiKey || !apiSecret) return null;
  return { url, apiKey, apiSecret };
}

/** The room-service base URL: the client URL with ws(s) → http(s). */
export function livekitHttpUrl(url: string): string {
  return url.replace(/^ws(s?):\/\//, "http$1://").replace(/\/+$/, "");
}

const b64url = (buf: Buffer | string) =>
  Buffer.from(buf).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

/** LiveKit's VideoGrant (only the fields we use). */
export interface VideoGrant {
  room?: string;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  roomCreate?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: string[];
  canUpdateOwnMetadata?: boolean;
}

export interface TokenInput {
  identity?: string;
  name?: string;
  ttlSec: number;
  video: VideoGrant;
  nowSec?: number; // injectable for tests
}

/** Sign a LiveKit access token (HS256 JWT). */
export function signAccessToken(cfg: LiveKitConfig, input: TokenInput): string {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const header = { alg: "HS256", typ: "JWT" };
  const claims: Record<string, unknown> = {
    iss: cfg.apiKey,
    nbf: now - 10, // small clock-skew allowance
    exp: now + input.ttlSec,
    video: input.video,
  };
  if (input.identity) {
    claims.sub = input.identity;
    claims.jti = input.identity;
  }
  if (input.name) claims.name = input.name;
  const unsigned = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const sig = crypto.createHmac("sha256", cfg.apiSecret).update(unsigned).digest();
  return `${unsigned}.${b64url(sig)}`;
}

/** Verify an HS256 JWT signed with our secret; returns its claims or null. */
export function verifyJwt(cfg: LiveKitConfig, token: string, nowSec = Math.floor(Date.now() / 1000)): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  let header: unknown;
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(Buffer.from(h, "base64url").toString("utf8"));
    claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!header || typeof header !== "object" || (header as { alg?: unknown }).alg !== "HS256") return null;
  if (!claims || typeof claims !== "object") return null;
  const expected = crypto.createHmac("sha256", cfg.apiSecret).update(`${h}.${p}`).digest();
  const given = Buffer.from(s, "base64url");
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  if (claims.iss !== cfg.apiKey) return null;
  if (typeof claims.exp !== "number" || claims.exp < nowSec) return null; // exp is required
  if (typeof claims.nbf === "number" && claims.nbf > nowSec + 60) return null;
  return claims;
}

/** Verify a LiveKit webhook: the Authorization header is a JWT signed with our
 *  secret whose `sha256` claim is the base64 SHA-256 of the raw body. */
export function verifyWebhook(cfg: LiveKitConfig, rawBody: string, authHeader: string | null, nowSec?: number): boolean {
  if (!authHeader) return false;
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  const claims = verifyJwt(cfg, token, nowSec);
  if (!claims || typeof claims.sha256 !== "string") return false;
  const digest = crypto.createHash("sha256").update(rawBody, "utf8").digest("base64");
  const a = Buffer.from(digest);
  const b = Buffer.from(claims.sha256);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Call a RoomService method (Twirp JSON). Throws on transport/HTTP errors,
 *  except a Twirp `not_found`, which returns null (room does not exist). */
export async function roomService<T>(cfg: LiveKitConfig, method: string, body: Record<string, unknown>, room?: string): Promise<T | null> {
  const token = signAccessToken(cfg, {
    ttlSec: 60,
    video: { roomAdmin: true, roomCreate: true, ...(room ? { room } : {}) },
  });
  const res = await fetch(`${livekitHttpUrl(cfg.url)}/twirp/livekit.RoomService/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(5000),
  });
  if (res.status === 404) return null;
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (/not_found/.test(text)) return null;
    throw new Error(`livekit ${method} ${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}
