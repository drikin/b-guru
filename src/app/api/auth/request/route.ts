import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { isValidEmail, normalizeEmail, requestLogin, LoginError } from "@/lib/login";

export const dynamic = "force-dynamic";

/** Step 1 of sign-in: mail a one-time code + login link (lib/login.ts).
 * The answer is the same whether or not the address is a paid member, so the
 * login form cannot be used to find out who is a member. */
export async function POST(req: NextRequest) {
  let body: { email?: unknown; code?: unknown; token?: unknown } | null;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = normalizeEmail(body?.email);
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "メールアドレスが不正です" }, { status: 400 });
  }

  try {
    await requestLogin(email, clientIp(req));
  } catch (e) {
    if (e instanceof LoginError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[auth:request]", (e as Error)?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500 });
  }
  return NextResponse.json({ ok: true, sent: true });
}
