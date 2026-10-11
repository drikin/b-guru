/* POST /api/agent/read — 既読マーク（スコープ read_state）。単調・冪等。
 * lib 正本: agent-write.ts（markPostsRead を透過呼び出し）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { agentMarkRead } from "@/lib/agent-write";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/read", "read_state", async (ctx) => {
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
      const r = await agentMarkRead(ctx, postId);
      return { status: 200, body: { apiVersion: 1, ...r }, headers: {} };
    } catch {
      return { status: 500, body: { error: "既読の記録に失敗しました", code: "server_error" }, headers: {} };
    }
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
