import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { createSession, setSessionCookie } from "@/lib/session";
import { ensureUserId } from "@/lib/user";
import { isAdmin } from "@/lib/admin";
import {
  normalizeEmail,
  verifyLoginCode,
  verifyLoginLink,
  notifyNewLogin,
  LoginError,
  type VerifiedLogin,
} from "@/lib/login";
import { sameOrigin } from "../_lib";

export const dynamic = "force-dynamic";

/** Step 2 of sign-in: `{ email, code }` (the 6-digit code from the mail) or
 * `{ token }` (the login link, posted by /login/verify). Issues the session. */
export async function POST(req: NextRequest) {
  if (!sameOrigin(req)) {
    return NextResponse.json({ error: "オリジンが不正です" }, { status: 403 });
  }
  let body: { email?: unknown; code?: unknown; token?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const ip = clientIp(req);

  let login: VerifiedLogin;
  try {
    if (typeof body?.token === "string" && body.token) {
      login = await verifyLoginLink(body.token, ip);
    } else {
      const code = typeof body?.code === "string" ? body.code.replace(/\s/g, "") : "";
      login = await verifyLoginCode(normalizeEmail(body?.email), code, ip);
    }
  } catch (e) {
    if (e instanceof LoginError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[auth:verify]", (e as Error)?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500 });
  }

  const { email } = login;
  const token = await createSession(email);
  await setSessionCookie(token);
  void notifyNewLogin(login, req.headers.get("user-agent"));

  // The client compares `authorId === auth.userId` to decide whether a post is
  // its own (edit/delete controls). Returning userId here keeps that comparison
  // valid from the very first render after login.
  let userId: string | null = null;
  try {
    userId = await ensureUserId(email);
  } catch (e) {
    console.error("auth/verify ensureUserId failed:", (e as Error)?.message);
  }

  return NextResponse.json({ ok: true, email, userId, isAdmin: isAdmin(email) });
}
