/* /api/agent/gdm/messages/[id] — 👥 グループ DM（アプリの鍵）。中身は lib/gdm-api.ts（docs/group-dm-spec.md）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { gdmEditApi, gdmMessageApi } from "@/lib/gdm-api";
import { agentJson, readJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type RC = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, rc: RC) {
  const { id } = await rc.params;
  const out = await withAgent(req, "GET /api/agent/gdm/messages/:id", "read", async (ctx) => gdmMessageApi({ email: ctx.email, userId: ctx.userId }, id));
  return agentJson(out);
}

/** PATCH: 自分の発言を直す { body } → { message }（スコープ chat）。 */
export async function PATCH(req: NextRequest, rc: RC) {
  const { id } = await rc.params;
  const out = await withAgent(req, "PATCH /api/agent/gdm/messages/:id", "chat", async (ctx) =>
    gdmEditApi({ email: ctx.email, userId: ctx.userId }, id, await readJson(req))
  );
  return agentJson(out);
}
