/* PUT /api/agent/posts/:id/poll — 投票のお題（回答）の編集（スコープ post）。
 *   body: { question?, options: [{ id: number|null, label }] }（id=null は新しい選択肢。並びはこの順）
 * Web と同じ lib/post-actions.ts: 投稿者だけ・投稿後 1 時間以内・票の付いた選択肢は消せない・lib/poll.ts の検査。
 *   → { apiVersion, ok: true, poll } */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { editPoll } from "@/lib/post-actions";
import { BAD_JSON, agentActionResult, agentJson, parsePositiveId, readJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PUT(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "PUT /api/agent/posts/:id/poll", "post", async (ctx) => {
    requireAppIssued(ctx); // 外部の鍵は人の投稿に新しい操作をしない（docs/timeline-spec.md §10.1）
    const id = parsePositiveId((await params).id);
    if (!id) return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    const body = await readJson(req);
    if (!body) return BAD_JSON;
    return agentActionResult(await editPoll(ctx.email, id, { question: body.question, options: body.options }));
  });
  return agentJson(out);
}
