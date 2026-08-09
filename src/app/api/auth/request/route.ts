import { NextRequest, NextResponse } from "next/server";
import { isPaidMember, findMemberByEmail } from "@/lib/ghost";
import { createOtp } from "@/lib/otp";
import { sendEmail } from "@/lib/mailgun";

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
    // Fail closed if Ghost is unreachable — don't send codes
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

  // 2. Generate + store OTP
  const code = await createOtp(email);
  const appUrl = process.env.APP_URL || "https://bsm.backspace.fm";

  // 3. Send via Mailgun
  try {
    await sendEmail({
      to: email,
      subject: "【BSM Portal】ログイン認証コード",
      text: `BSM Portal へのログイン認証コードはこちらです:\n\n${code}\n\nこのコードは10分間有効です。心当たりのない場合はこのメールを無視してください。\n\n${appUrl}`,
      html: `<p>BSM Portal へのログイン認証コードはこちらです:</p>
<p style="font-size:28px;font-weight:bold;letter-spacing:4px;margin:16px 0">${code}</p>
<p>このコードは<strong>10分間</strong>有効です。心当たりのない場合はこのメールを無視してください。</p>`,
    });
  } catch (e: any) {
    console.error("Mailgun send error:", e.message);
    return NextResponse.json(
      { error: "認証コードの送信に失敗しました" },
      { status: 502 }
    );
  }

  return NextResponse.json({
    ok: true,
    message: "認証コードを送信しました。メールをご確認ください。",
  });
}
