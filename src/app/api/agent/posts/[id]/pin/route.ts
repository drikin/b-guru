/* POST /api/agent/posts/:id/pin — ピンの付け外し（スコープ post）。Web と同じ lib/post-actions.ts:
 * 自分の投稿だけ・24 時間・1 人 1 件（新しくピンすると前のピンは外れる）・エピソード投稿は不可。
 *   → { apiVersion, ok: true, pinned: boolean }。ピン一覧は GET /api/agent/posts?pinned=1。 */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { togglePinAction } from "@/lib/post-actions";
import { agentActionResult, agentJson, parsePositiveId } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "POST /api/agent/posts/:id/pin", "post", async (ctx) => {
    requireAppIssued(ctx); // 外部の鍵は人の投稿に新しい操作をしない（docs/timeline-spec.md §10.1）
    const id = parsePositiveId((await params).id);
    if (!id) return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    return agentActionResult(await togglePinAction(ctx.email, id));
  }, { lightPost: true });
  return agentJson(out);
}
