/* /api/agent/gdm/[gid] — 👥 グループ DM（アプリの鍵）。中身は lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { gdmThreadApi, gdmUpdateApi } from "@/lib/gdm-api";
import { agentJson, readJson } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ gid: string }> };

export async function GET(req: NextRequest, rc: RC) {
  const { gid } = await rc.params;
  const out = await withAgent(req, "GET /api/agent/gdm/:gid", "read", async (ctx) => gdmThreadApi({ email: ctx.email, userId: ctx.userId }, gid, req.nextUrl.searchParams));
  return agentJson(out);
}

export async function PATCH(req: NextRequest, rc: RC) {
  const { gid } = await rc.params;
  const out = await withAgent(req, "PATCH /api/agent/gdm/:gid", "chat", async (ctx) => gdmUpdateApi({ email: ctx.email, userId: ctx.userId }, gid, await readJson(req)));
  return agentJson(out);
}
