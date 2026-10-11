/* POST /api/agent/bookmarks — ブックマークトグル（スコープ write）。冪等。
 * lib 正本: agent-write.ts（bookmarks lib を透過呼び出し）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { agentToggleBookmark } from "@/lib/agent-write";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/bookmarks", "write", async (ctx) => {
    let body: { post_id?: unknown };
    try {
      body = await req.json();
    } catch {
      return {
        status: 400,
        body: { error: "JSON ボディが必要です", code: "invalid_request" },
        headers: {},
      };
    }
    const postId = Number(body.post_id);
    if (!Number.isInteger(postId) || postId <= 0) {
      return {
        status: 400,
        body: { error: "post_id が必要です", code: "invalid_request" },
        headers: {},
      };
    }
    try {
      const r = await agentToggleBookmark(ctx, postId);
      return { status: 200, body: { apiVersion: 1, ...r }, headers: {} };
    } catch (e) {
      if ((e as { code?: string })?.code === "not_found") {
        return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
      }
      return { status: 500, body: { error: "処理に失敗しました", code: "server_error" }, headers: {} };
    }
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
