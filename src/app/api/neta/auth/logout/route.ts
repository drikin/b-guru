import { NextRequest, NextResponse } from "next/server";
import { endNetaSession } from "@/lib/neta-auth";
import { fail, readBody } from "../../_lib";

export const dynamic = "force-dynamic";

/** ネタ帳からログアウト（ネタ帳のセッションだけ。B-guru のログインはそのまま）。 */
export async function POST(req: NextRequest) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  try {
    await endNetaSession();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return fail(e, "auth-logout");
  }
}
