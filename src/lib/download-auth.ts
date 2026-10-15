/* Who may download the Mac app: a signed-in member (browser, cookie) OR the
 * app itself (its agent token — Sparkle sends it as a Bearer header, since the
 * app has no browser session). Returns the member's email or null. */
import { getSessionEmail } from "./session";
import { verifyAgentToken } from "./agent-auth";
import { clientIp } from "./client-ip";

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
