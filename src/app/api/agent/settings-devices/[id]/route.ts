/* DELETE /api/agent/settings-devices/:id — トークン失効（UI 用・Cookie セッション認証・自分のトークンのみ）。 */
import { NextRequest, NextResponse } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { revokeAgentToken } from "@/lib/agent-auth";
import { NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function DELETE(_req: NextRequest, { params }: Ctx) {
  const email = await getSessionEmail();
  if (!email) {
    return NextResponse.json({ error: "ログインが必要です", code: "unauthorized" }, { status: 401, headers: NO_CACHE });
  }
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ error: "不正な ID", code: "invalid_request" }, { status: 400, headers: NO_CACHE });
  }
  const ok = await revokeAgentToken(id, email);
  if (!ok) {
    return NextResponse.json({ error: "失効できませんでした", code: "not_found" }, { status: 404, headers: NO_CACHE });
  }
  return NextResponse.json({ ok: true }, { headers: NO_CACHE });
}
