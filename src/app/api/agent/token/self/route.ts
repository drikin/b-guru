/* DELETE /api/agent/token — Bearer トークン自身の失効（CLI logout 相当）。 */
import { NextRequest, NextResponse } from "next/server";
import { verifyAgentToken, AgentAuthError } from "@/lib/agent-auth";
import { pool } from "@/lib/db";
import { NO_CACHE } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function DELETE(req: NextRequest) {
  try {
    const ctx = await verifyAgentToken(req.headers.get("authorization"));
    await pool.query(`UPDATE agent_tokens SET revoked_at = now() WHERE id = $1`, [ctx.tokenId]);
    return NextResponse.json({ ok: true }, { headers: NO_CACHE });
  } catch (e: any) {
    if (e instanceof AgentAuthError) {
      return NextResponse.json(e.body, { status: e.status, headers: NO_CACHE });
    }
    console.error("[agent:token:delete]", e?.message);
    return NextResponse.json(
      { error: "サーバーエラー", code: "unauthorized" },
      { status: 500, headers: NO_CACHE }
    );
  }
}
