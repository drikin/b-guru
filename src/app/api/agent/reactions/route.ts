/* POST /api/agent/reactions — リアクショントグル（スコープ post＝アプリ、または write）。
 * 対象は投稿のみ（chat は chat スコープの将来課題）。lib 正本: agent-write.ts。 */
import { NextRequest } from "next/server";
import { withAgent } from "@/lib/agent-auth";
import { agentToggleReaction } from "@/lib/agent-write";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/reactions", ["post", "write"], async (ctx) => {
    let body: { post_id?: unknown; emoji?: unknown };
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
    const emoji = typeof body.emoji === "string" ? body.emoji : "";
    if (!Number.isInteger(postId) || postId <= 0) {
      return {
        status: 400,
        body: { error: "post_id が必要です", code: "invalid_request" },
        headers: {},
      };
    }
    if (!emoji) {
      return {
        status: 400,
        body: { error: "emoji が必要です", code: "invalid_request" },
        headers: {},
      };
    }
    try {
      const r = await agentToggleReaction(ctx, postId, emoji);
      return { status: 200, body: { apiVersion: 1, ...r }, headers: {} };
    } catch (e) {
      const msg = (e as Error)?.message;
      if (msg === "invalid_emoji") {
        return { status: 400, body: { error: "不正な絵文字です", code: "invalid_request" }, headers: {} };
      }
      if (msg === "unknown_emoji") {
        return { status: 404, body: { error: "その絵文字は登録されていません", code: "not_found" }, headers: {} };
      }
      return { status: 500, body: { error: "リアクションの更新に失敗しました", code: "server_error" }, headers: {} };
    }
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
