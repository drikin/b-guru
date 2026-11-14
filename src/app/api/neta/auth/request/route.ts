import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { isValidEmail, normalizeEmail } from "@/lib/login";
import { requestNetaLogin } from "@/lib/neta-auth";
import { fail, readBody } from "../../_lib";

export const dynamic = "force-dynamic";

/** ネタ帳のログイン 1: { email, next } にコードとリンクを送る（初めての人も同じ。メールを確かめてから登録）。 */
export async function POST(req: NextRequest) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email) || email.length > 254) {
    return NextResponse.json({ error: "メールアドレスを確認してください" }, { status: 400 });
  }
  try {
    await requestNetaLogin(email, clientIp(req), typeof body.next === "string" ? body.next : "/neta");
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e, "auth-request");
  }
}
