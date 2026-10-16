/* Who may download the Mac app — and view uploaded media: a signed-in member
 * (browser, cookie) OR the native app itself (its agent token as a Bearer header,
 * since the app has no browser session). Returns the member's email or null. */
import { getSessionEmail } from "./session";
import { verifyAgentToken } from "./agent-auth";
import { clientIp } from "./client-ip";
import { createHash } from "crypto";

export async function downloadAuthEmail(req: Request): Promise<string | null> {
  const email = await getSessionEmail();
  if (email) return email;
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  try {
    const ctx = await verifyAgentToken(auth, { ip: clientIp(req) });
    return ctx.scopes.includes("read") ? ctx.email : null;
  } catch {
    return null;
  }
}

/** Uploaded images for the native apps' timeline: one screen asks for dozens, so a
 *  verified token is remembered for a minute (a revoked token stops working within
 *  60 s) instead of hitting the token table for every image. */
const MEDIA_AUTH_TTL_MS = 60_000;
const mediaAuth = new Map<string, { email: string; until: number }>();

export async function mediaAuthEmail(req: Request): Promise<string | null> {
  const email = await getSessionEmail();
  if (email) return email;
  const auth = req.headers.get("authorization");
  if (!auth) return null;
  const now = Date.now();
  const key = createHash("sha256").update(auth).digest("hex"); // never keep the raw token around
  const hit = mediaAuth.get(key);
  if (hit && hit.until > now) return hit.email;
  const verified = await downloadAuthEmail(req);
  if (verified) {
    if (mediaAuth.size > 1000) mediaAuth.clear();
    mediaAuth.set(key, { email: verified, until: now + MEDIA_AUTH_TTL_MS });
  } else {
    mediaAuth.delete(key);
  }
  return verified;
}

/** Tests only. */
export function __resetMediaAuthForTests() {
  mediaAuth.clear();
}
