/* POST /api/agent/dm/:userId/read — ✉️ 簡易 DM の既読を進める { last_read_id }（単調・戻らない）。
 * スコープ read_state（無い鍵は chat）。自分のほかの端末にも stream の dm { action: "read" } で知らせる。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { dmReadApi } from "@/lib/dm-api";
import { agentJson, readJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, rc: { params: Promise<{ userId: string }> }) {
  const { userId } = await rc.params;
  const out = await withAgent(req, "POST /api/agent/dm/:userId/read", ["read_state", "chat"], async (ctx) =>
    dmReadApi({ email: ctx.email, userId: ctx.userId }, userId, await readJson(req))
  );
  return agentJson(out);
}
