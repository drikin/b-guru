/* /api/agent/gdm/[gid]/members/[userId] — 👥 グループ DM（アプリの鍵）。中身は lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { gdmRemoveMemberApi } from "@/lib/gdm-api";
import { agentJson } from "../../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ gid: string; userId: string }> };

export async function DELETE(req: NextRequest, rc: RC) {
  const { gid, userId } = await rc.params;
  const out = await withAgent(req, "DELETE /api/agent/gdm/:gid/members/:userId", "chat", async (ctx) => gdmRemoveMemberApi({ email: ctx.email, userId: ctx.userId }, gid, userId));
  return agentJson(out);
}
