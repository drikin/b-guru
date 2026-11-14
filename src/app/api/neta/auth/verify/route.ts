import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { normalizeEmail } from "@/lib/login";
import { ensureNetaMember, linkGhostMember, startNetaSession, verifyNetaLogin } from "@/lib/neta-auth";
import { fail, readBody } from "../../_lib";

export const dynamic = "force-dynamic";

/** ネタ帳のログイン 2: { email, code } か { token }（メールのリンク）。合えばネタ帳のセッションを出す。 */
export async function POST(req: NextRequest) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  try {
    const email =
      typeof body.token === "string" && body.token
        ? await verifyNetaLogin({ token: body.token }, clientIp(req))
        : await verifyNetaLogin(
            { email: normalizeEmail(body.email), code: typeof body.code === "string" ? body.code.replace(/\s/g, "") : "" },
            clientIp(req)
          );
    const member = await ensureNetaMember(email);
    await startNetaSession(member.id);
    await linkGhostMember(member);
    return NextResponse.json({ ok: true, member: { id: member.id, displayName: member.displayName } });
  } catch (e) {
    return fail(e, "auth-verify");
  }
}
