/* /api/agent/gdm/[gid]/join — 🌐 パブリック DM に参加（アプリの鍵）。中身は lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { gdmJoinApi } from "@/lib/gdm-api";
import { agentJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ gid: string }> };

export async function POST(req: NextRequest, rc: RC) {
  const { gid } = await rc.params;
  const out = await withAgent(req, "POST /api/agent/gdm/:gid/join", "chat", async (ctx) => gdmJoinApi({ email: ctx.email, userId: ctx.userId }, gid));
  return agentJson(out);
}
