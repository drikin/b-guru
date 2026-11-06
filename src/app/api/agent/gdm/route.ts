/* /api/agent/gdm/ — 👥 グループ DM（アプリの鍵）。中身は lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { gdmCreateApi, gdmListApi } from "@/lib/gdm-api";
import { agentJson, readJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";


export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/gdm", "read", async (ctx) => gdmListApi({ email: ctx.email, userId: ctx.userId }));
  return agentJson(out);
}

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/gdm", "chat", async (ctx) => gdmCreateApi({ email: ctx.email, userId: ctx.userId }, await readJson(req)));
  return agentJson(out);
}
