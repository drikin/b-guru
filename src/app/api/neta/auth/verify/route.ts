import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { normalizeEmail } from "@/lib/login";
import { ensureNetaMember, linkGhostMember, paidLoginFromNeta, startNetaSession, verifyNetaLogin } from "@/lib/neta-auth";
import { fail, readBody } from "../../_lib";

export const dynamic = "force-dynamic";

/**
 * ネタ帳のログイン 2: { email, code } か { token }（メールのリンク）。合えばネタ帳のセッションを出す。
 * BSM の有料会員なら B-guru にも入る（B-guru のログインと同じ: セッション・新しい端末の通知メール）。ログインの入口を 1 つに。
 */
export async function POST(req: NextRequest) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  try {
    const ip = clientIp(req);
    const email =
      typeof body.token === "string" && body.token
        ? await verifyNetaLogin({ token: body.token }, ip)
        : await verifyNetaLogin(
            { email: normalizeEmail(body.email), code: typeof body.code === "string" ? body.code.replace(/\s/g, "") : "" },
            ip
          );
    const member = await ensureNetaMember(email);
    await startNetaSession(member.id);
    await linkGhostMember(member);
    const paid = await paidLoginFromNeta(email, ip, req.headers.get("user-agent"));
    return NextResponse.json({ ok: true, paid, member: { id: member.id, displayName: member.displayName } });
  } catch (e) {
    return fail(e, "auth-verify");
  }
}
