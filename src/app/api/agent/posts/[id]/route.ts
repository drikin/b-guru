/* GET /api/agent/posts/:id — スレッド1本（ルート + 返信）。スコープ read。 */
import { NextRequest } from "next/server";
import { getPostThread } from "@/lib/posts";
import { withAgent } from "@/lib/agent-auth";
import { agentUpdatePost, agentDeletePost } from "@/lib/agent-write";
import { NO_CACHE } from "../../_lib";
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

/* PATCH /api/agent/posts/:id — 自分の投稿の本文編集（スコープ write）。
 * text のみ・画像/動画/音声の付け替えは不可。ロジックは agent-write.ts。 */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "PATCH /api/agent/posts/:id", "write", async (ctx) => {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) {
      return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
    }
    let body: { text?: unknown };
    try {
      body = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
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

/* DELETE /api/agent/posts/:id — 自分の投稿の削除（スコープ write）。 */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const out = await withAgent(req, "DELETE /api/agent/posts/:id", "write", async (ctx) => {
    const id = Number((await params).id);
    if (!Number.isInteger(id) || id <= 0) {
      return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
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
