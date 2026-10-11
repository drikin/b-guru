/* GET /api/agent/me — 自身の識別子・スコープ・トークン有効期限（email/member 情報は含めない）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/me", null, async (ctx) => ({
    status: 200,
    body: {
      apiVersion: 1,
      user_id: ctx.userId,
      scopes: ctx.scopes,
      device_name: ctx.deviceName,
      expires_at: ctx.expiresAt,
    },
    headers: {},
  }));
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
