/* POST /api/agent/gdm/messages/:id/reactions — 👥 グループ DM の発言へのリアクションを付ける・外す（スコープ chat）。
 * { emoji } → { added, reactions }。メンバーでなければ（入る前の発言も）404。中身は lib/gdm.ts の reactGroupMessage。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { gdmReactApi } from "@/lib/gdm-api";
import { agentJson, readJson } from "../../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  const { id } = await rc.params;
  const out = await withAgent(req, "POST /api/agent/gdm/messages/:id/reactions", "chat", async (ctx) =>
    gdmReactApi({ email: ctx.email, userId: ctx.userId }, id, await readJson(req))
  );
  return agentJson(out);
}
