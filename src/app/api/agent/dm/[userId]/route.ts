/* /api/agent/dm/:userId — ✉️ 簡易 DM の 1 つの会話（相手は users.user_id）。
 *   GET  : 24 時間以内のやりとり（古い→新しい）・未読・相手（スコープ read）。?before=&limit=
 *   POST : 送る { body, client_id? }（スコープ chat）。送り主は鍵の持ち主（クライアントの申告は使わない）。
 * 読めるのは当事者 2 人だけ。中身は lib/dm-api.ts。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { dmSendApi, dmThreadApi } from "@/lib/dm-api";
import { agentJson, readJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ userId: string }> };

export async function GET(req: NextRequest, rc: RC) {
  const { userId } = await rc.params;
  const out = await withAgent(req, "GET /api/agent/dm/:userId", "read", (ctx) =>
    dmThreadApi({ email: ctx.email, userId: ctx.userId }, userId, req.nextUrl.searchParams)
  );
  return agentJson(out);
}

export async function POST(req: NextRequest, rc: RC) {
  const { userId } = await rc.params;
  const out = await withAgent(req, "POST /api/agent/dm/:userId", "chat", async (ctx) =>
    dmSendApi({ email: ctx.email, userId: ctx.userId }, userId, await readJson(req))
  );
  return agentJson(out);
}
