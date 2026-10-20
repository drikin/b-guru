import { NextRequest, NextResponse } from "next/server";
import { clientIp } from "@/lib/client-ip";
import { verifyRevokeLink, destroyAllSessionsFor, LoginError } from "@/lib/login";
import { sameOrigin } from "../_lib";

export const dynamic = "force-dynamic";

/** "Not me" link in the new-login mail (posted by /login/revoke): signs the
 * member out of every browser and app. */
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
  const token = typeof body?.token === "string" ? body.token : "";
  try {
    const email = await verifyRevokeLink(token, clientIp(req));
    await destroyAllSessionsFor(email);
  } catch (e) {
    if (e instanceof LoginError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("[auth:revoke-all]", (e as Error)?.message);
    return NextResponse.json({ error: "サーバーエラー" }, { status: 500 });
  }
  return NextResponse.json({ ok: true });
}
