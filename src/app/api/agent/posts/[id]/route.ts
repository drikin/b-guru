/* GET /api/agent/posts/:id — スレッド1本（ルート + 返信）。スコープ read。 */
import { NextRequest } from "next/server";
import { getPostThread } from "@/lib/posts";
import { withAgent, type AgentContext } from "@/lib/agent-auth";
import { deleteOwnPost, editOwnPost } from "@/lib/post-actions";
import { agentUpdatePost, agentDeletePost, editScope } from "@/lib/agent-write";
import { NO_CACHE, BAD_JSON, agentActionResult, readJson } from "../../_lib";
import { agentPostDto } from "@/lib/agent-post-dto";
import { parseInclude, timelineExtras } from "@/lib/agent-timeline";
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "GET /api/agent/posts/:id", "read", async (ctx) => {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) {
      return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    }
    const { post, replies } = await getPostThread(id, ctx.email);
    if (!post) {
      return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    }
    const extras = await timelineExtras([post, ...replies], ctx.email, parseInclude(req.nextUrl.searchParams.get("include")));
    const dto = (p: typeof post) => ({ ...agentPostDto(p), ...extras.get(p.id) });
    return {
      status: 200,
      body: { apiVersion: 1, post: dto(post), replies: replies.map(dto) },
      headers: {},
    };
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}

const isAppEdit = (c: AgentContext) => editScope(c) === "post";

/* PATCH /api/agent/posts/:id — 自分の投稿の編集。
 *   アプリの鍵: { text, images?: ["/api/media/…"]（差し替え・最大 5 枚）, audio_url?: string|null（null で外す） }
 *   外部の鍵（write）: { text } だけ（画像・動画・音声は触らない）。 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "PATCH /api/agent/posts/:id", editScope, async (ctx) => {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) {
      return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    }
    const body = await readJson(req);
    if (!body) return BAD_JSON;
    if (isAppEdit(ctx)) {
      const r = await editOwnPost(
        ctx.email,
        id,
        { text: body.text, images: body.images, audioUrl: body.audio_url },
        { localImagesOnly: true }
      );
      return r.status === 200 ? { status: 200, body: { apiVersion: 1, updated: true }, headers: {} } : agentActionResult(r);
    }
    try {
      await agentUpdatePost(ctx, id, { text: typeof body.text === "string" ? body.text : "" });
      return { status: 200, body: { apiVersion: 1, updated: true }, headers: {} };
    } catch (e) {
      const err = e as { code?: string; status?: number; message?: string };
      const status = Number(err?.status) > 0 ? Number(err.status) : 400;
      return {
        status,
        body: { error: String(err?.message ?? "編集に失敗しました"), code: err?.code ?? "invalid_request" },
        headers: {},
      };
    }
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}

/* DELETE /api/agent/posts/:id — 自分の投稿の削除（権限は PATCH と同じ）。 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "DELETE /api/agent/posts/:id", editScope, async (ctx) => {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) {
      return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    }
    if (isAppEdit(ctx)) {
      const r = await deleteOwnPost(ctx.email, id);
      return r.status === 200 ? { status: 200, body: { apiVersion: 1, deleted: true }, headers: {} } : agentActionResult(r);
    }
    try {
      await agentDeletePost(ctx, id);
      return { status: 200, body: { apiVersion: 1, deleted: true }, headers: {} };
    } catch (e) {
      const err = e as { code?: string; status?: number; message?: string };
      const status = Number(err?.status) > 0 ? Number(err.status) : 400;
      return {
        status,
        body: { error: String(err?.message ?? "削除に失敗しました"), code: err?.code ?? "invalid_request" },
        headers: {},
      };
    }
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
