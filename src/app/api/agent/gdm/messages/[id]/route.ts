/* /api/agent/gdm/messages/[id] — 👥 グループ DM（アプリの鍵）。中身は lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { gdmMessageApi } from "@/lib/gdm-api";
import { agentJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, rc: RC) {
  const { id } = await rc.params;
  const out = await withAgent(req, "GET /api/agent/gdm/messages/:id", "read", async (ctx) => gdmMessageApi({ email: ctx.email, userId: ctx.userId }, id));
  return agentJson(out);
}
