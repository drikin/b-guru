/* POST /api/agent/dm/messages/:id/reactions — ✉️ DM へのリアクションを付ける・外す（スコープ chat）。
 * { emoji }（Unicode 絵文字か ":name:" のカスタム絵文字）→ { added, reactions }。当事者でなければ 404。中身は lib/dm.ts の reactDm。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { dmReactApi } from "@/lib/dm-api";
import { agentJson, readJson } from "../../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  const { id } = await rc.params;
  const out = await withAgent(req, "POST /api/agent/dm/messages/:id/reactions", "chat", async (ctx) =>
    dmReactApi({ email: ctx.email, userId: ctx.userId }, id, await readJson(req))
  );
  return agentJson(out);
}
