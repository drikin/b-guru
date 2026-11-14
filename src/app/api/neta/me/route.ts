import { NextRequest, NextResponse } from "next/server";
import { getNetaViewer, requireNetaMember } from "@/lib/neta-auth";
import { netaWritable, setDisplayName } from "@/lib/neta-write";
import { fail, NEED_LOGIN, readBody } from "../_lib";

export const dynamic = "force-dynamic";

/** 見ている人（ログインしていなければ viewer: null）。メールアドレスは返さない。 */
export async function GET() {
  try {
    const v = await getNetaViewer();
    return NextResponse.json({
      viewer: v ? { displayName: v.member?.displayName ?? null, tier: v.tier } : null,
      writable: netaWritable(v),
    });
  } catch (e) {
    return fail(e, "me");
  }
}

/** { displayName } — ネタ帳で表示する名前を決める・変える。 */
export async function PATCH(req: NextRequest) {
  const body = await readBody(req);
  if (body instanceof NextResponse) return body;
  try {
    const got = await requireNetaMember();
    if (!got) return NEED_LOGIN();
    const displayName = await setDisplayName(got.member, body.displayName);
    return NextResponse.json({ ok: true, displayName });
  } catch (e) {
    return fail(e, "me-patch");
  }
}
