/* GET /api/agent/dm — ✉️ 簡易 DM の会話の一覧と未読の合計（スコープ read）。
 * DM_ENABLED の対象でない人には 404。中身は lib/dm-api.ts（Web の /api/dm と共通・メールなし）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { dmListApi } from "@/lib/dm-api";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/dm", "read", (ctx) => dmListApi({ email: ctx.email, userId: ctx.userId }));
  return agentJson(out);
}
