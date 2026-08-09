import { NextRequest, NextResponse } from "next/server";
import { verifyOtp } from "@/lib/otp";
import { createSession, setSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = (body?.email ?? "").trim().toLowerCase();
  const code = (body?.code ?? "").trim();

  if (!email || !code) {
    return NextResponse.json({ error: "入力が不足しています" }, { status: 400 });
  }

  const ok = await verifyOtp(email, code);
  if (!ok) {
    return NextResponse.json(
      { error: "認証コードが不正または期限切れです" },
      { status: 401 }
    );
  }

  const token = await createSession(email);
  await setSessionCookie(token);

  return NextResponse.json({ ok: true, email });
}
