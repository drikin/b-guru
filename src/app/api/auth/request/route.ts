import { NextRequest, NextResponse } from "next/server";
import { isPaidMember, findMemberByEmail } from "@/lib/ghost";
import { createSession, setSessionCookie } from "@/lib/session";

export const dynamic = "force-dynamic";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function POST(req: NextRequest) {
  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  const email = (body?.email ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    return NextResponse.json({ error: "メールアドレスが不正です" }, { status: 400 });
  }

  // 1. Verify the email belongs to a *paid* Ghost member (source of truth)
  let member;
  try {
    member = await findMemberByEmail(email);
  } catch (e: any) {
    console.error("Ghost lookup error:", e.message);
    // Fail closed if Ghost is unreachable — don't log anyone in
    return NextResponse.json(
      { error: "認証サービスに接続できません。しばらくしてから再試行してください" },
      { status: 502 }
    );
  }

  if (!member || !isPaidMember(member)) {
    // Do NOT reveal whether the email exists — generic message
    return NextResponse.json(
      {
        error:
          "このメールアドレスはBSM有料会員として登録されていません。backspace.fmでご確認ください",
      },
      { status: 403 }
    );
  }

  // 2. Paid member confirmed — issue a session directly (no OTP)
  const token = await createSession(email);
  await setSessionCookie(token);

  return NextResponse.json({ ok: true, email });
}
