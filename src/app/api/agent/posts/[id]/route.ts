/* GET /api/agent/posts/:id — スレッド1本（ルート + 返信）。スコープ read。 */
import { NextRequest } from "next/server";
import { getPostThread } from "@/lib/posts";
import { withAgent } from "@/lib/agent-auth";
import { NO_CACHE } from "../../_lib";
import { agentPostDto } from "../route";
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
    return {
      status: 200,
      body: { apiVersion: 1, post: agentPostDto(post), replies: replies.map(agentPostDto) },
      headers: {},
    };
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
