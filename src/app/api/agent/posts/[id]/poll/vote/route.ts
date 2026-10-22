/* POST /api/agent/posts/:id/poll/vote — 投票（スコープ post）。body: { option_id }。
 * Web と同じ lib/post-actions.ts: 1 人 1 票・締切前なら何度でも変えられる・締切後は 403。
 *   → { apiVersion, ok: true, poll } */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { votePoll } from "@/lib/post-actions";
import { BAD_JSON, agentActionResult, agentJson, parsePositiveId, readJson } from "../../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "POST /api/agent/posts/:id/poll/vote", "post", async (ctx) => {
    requireAppIssued(ctx); // 外部の鍵は人の投稿に新しい操作をしない（docs/timeline-spec.md §10.1）
    const id = parsePositiveId((await params).id);
    if (!id) return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    const body = await readJson(req);
    if (!body) return BAD_JSON;
    const optionId = parsePositiveId(body.option_id) ?? 0;
    return agentActionResult(await votePoll(ctx.email, id, optionId));
  }, { lightPost: true });
  return agentJson(out);
}
