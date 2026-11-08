/* /api/agent/dm/messages/:id — ✉️ DM 1 件。
 *   GET   : 1 件と相手（スコープ read）。通知の本文差し替え（iPhone の Notification Service Extension・Android）が使う。
 *           当事者でなければ・30 日を過ぎたら 404。
 *   PATCH : 自分の DM を直す { body } → { message }（スコープ chat。チャットの「タイポを修正」と同じ）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { dmEditApi, dmMessageApi } from "@/lib/dm-api";
import { agentJson, readJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  const { id } = await rc.params;
  const out = await withAgent(req, "GET /api/agent/dm/messages/:id", "read", (ctx) =>
    dmMessageApi({ email: ctx.email, userId: ctx.userId }, id)
  );
  return agentJson(out);
}

export async function PATCH(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  const { id } = await rc.params;
  const out = await withAgent(req, "PATCH /api/agent/dm/messages/:id", "chat", async (ctx) =>
    dmEditApi({ email: ctx.email, userId: ctx.userId }, id, await readJson(req))
  );
  return agentJson(out);
}
