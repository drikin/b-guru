/* PATCH /api/agent/posts/:id/club — 部活ラベルの付け替え（スコープ post）。body: { club: "<key>" | null }。
 * Web と同じ lib/post-actions.ts（club_manual = TRUE・自動分類で上書きされない・club イベント）。
 * アプリは投稿者だけ（Web の admin による付け替えは Web だけ）。 → { apiVersion, ok: true, club } */
import { NextRequest } from "next/server";
import { requireAppIssued, withAgent } from "@/lib/agent-auth";
import { setClubAction } from "@/lib/post-actions";
import { BAD_JSON, agentActionResult, agentJson, parsePositiveId, readJson } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "PATCH /api/agent/posts/:id/club", "post", async (ctx) => {
    requireAppIssued(ctx); // 外部の鍵は人の投稿に新しい操作をしない（docs/timeline-spec.md §10.1）
    const id = parsePositiveId((await params).id);
    if (!id) return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    const body = await readJson(req);
    if (!body) return BAD_JSON;
    return agentActionResult(await setClubAction(ctx.email, id, body.club ?? null, { authorOnly: true }));
  }, { lightPost: true });
  return agentJson(out);
}
