/* POST /api/agent/bookmarks — ブックマーク（スコープ write か post）。
 *   body: { post_id, bookmarked?: true|false } → { bookmarked }。bookmarked を送ればその状態にする（冪等）、
 *   無ければ今までどおり切り替え。
 * write を持つ鍵（外部の AI エージェント）は今までどおり write の枠。アプリの鍵（write なし）は post の枠。
 * 一覧は GET /api/agent/posts?bm=1、各投稿の状態は bookmarked_by_me。
 * lib 正本: agent-write.ts（bookmarks lib を透過呼び出し）。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { agentSetBookmark, agentToggleBookmark } from "@/lib/agent-write";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/bookmarks", ["write", "post"], async (ctx) => {
    let body: { post_id?: unknown; bookmarked?: unknown };
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
      // bookmarked: true|false を送れば冪等にその状態へ（capabilities の bookmarks_set）。無ければ今までどおり切り替え。
      if (body.bookmarked !== undefined && typeof body.bookmarked !== "boolean") {
        return { status: 400, body: { error: "bookmarked は true か false", code: "invalid_request" }, headers: {} };
      }
      const r =
        typeof body.bookmarked === "boolean"
          ? await agentSetBookmark(ctx, postId, body.bookmarked)
          : await agentToggleBookmark(ctx, postId);
      return { status: 200, body: { apiVersion: 1, ...r }, headers: {} };
    } catch (e) {
      if ((e as { code?: string })?.code === "not_found") {
        return { status: 404, body: { error: "投稿が見つかりません", code: "not_found" }, headers: {} };
      }
      return { status: 500, body: { error: "処理に失敗しました", code: "server_error" }, headers: {} };
    }
  }, { lightPost: true });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
