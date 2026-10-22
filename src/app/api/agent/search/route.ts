/* GET /api/agent/search?q= — 全文検索（既存 listPosts search ロジック再利用）。 */
import { NextRequest } from "next/server";
import { listPosts } from "@/lib/posts";
import { getHiddenClubs } from "@/lib/club-visibility";
import { withAgent, sanitizeLikePattern } from "@/lib/agent-auth";
import { NO_CACHE } from "../_lib";
import { agentPostDto } from "@/lib/agent-post-dto";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/search", "read", async (ctx) => {
    const q = sanitizeLikePattern(req.nextUrl.searchParams.get("q") ?? undefined);
    if (!q) {
      return {
        status: 400,
        body: { error: "q パラメータが必要です", code: "invalid_request", hint: "?q=<検索語>" },
        headers: {},
      };
    }
    const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 100) : 50;
    const cursor = req.nextUrl.searchParams.get("cursor") ?? undefined;
    const hiddenSet = await getHiddenClubs(ctx.email);
    const posts = await listPosts({
      search: q,
      excludeClubs: Array.from(hiddenSet),
      viewerEmail: ctx.email,
      before: cursor,
      limit,
    });
    const last = posts[posts.length - 1];
    return {
      status: 200,
      body: {
        apiVersion: 1,
        query: q,
        posts: posts.map(agentPostDto),
        next_cursor: posts.length === limit && last ? (last.lastActivityAt ?? last.createdAt) : null,
      },
      headers: {},
    };
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
