/* GET /api/agent/dm/messages/:id — ✉️ DM 1 件と相手（スコープ read）。通知の本文差し替え
 * （iPhone の Notification Service Extension・Android）が使う。当事者でなければ・24 時間を過ぎたら 404。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { dmMessageApi } from "@/lib/dm-api";
import { agentJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  const { id } = await rc.params;
  const out = await withAgent(req, "GET /api/agent/dm/messages/:id", "read", (ctx) =>
    dmMessageApi({ email: ctx.email, userId: ctx.userId }, id)
  );
  return agentJson(out);
}
