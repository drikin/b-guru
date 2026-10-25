/* GET /api/agent/posts/:id/poll/voters — 投票した人（選択肢ごと、スコープ read）。
 * Web と同じ lib/post-actions.ts の pollVoters: 投稿者だけ（ほかは 403）。名前の一覧なのでアプリの鍵だけ。
 *   → { apiVersion, ok: true, options: [{ id, label, voters: [{ user_id, name, avatar }] }] } */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { pollVoters } from "@/lib/post-actions";
import { agentActionResult, agentJson, parsePositiveId } from "../../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "GET /api/agent/posts/:id/poll/voters", "read", async (ctx) => {
    requireAppIssued(ctx);
    const id = parsePositiveId((await params).id);
    if (!id) return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    return agentActionResult(await pollVoters(ctx.email, id));
  });
  return agentJson(out);
}
