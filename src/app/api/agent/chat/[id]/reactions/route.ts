/* POST /api/agent/chat/:id/reactions — チャットへのリアクショントグル（スコープ chat）。
 * { emoji }（Unicode 絵文字 or ":name:" のカスタム絵文字）。Web の POST /api/reactions
 * と同じ lib（toggleReaction）。存在しない／期限切れのメッセージには付けない。 */
import { NextRequest } from "next/server";
import { pool } from "@/lib/db";
import { CHAT_TTL } from "@/lib/chat";
import { toggleReaction } from "@/lib/reactions";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { agentJson, parsePositiveId } from "../../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest, rc: { params: Promise<{ id: string }> }) {
  const out = await withAgent(req, "POST /api/agent/chat/:id/reactions", "chat", async (ctx) => {
    const id = parsePositiveId((await rc.params).id);
    if (!id) return { status: 400, body: { error: "不正な ID です", code: "invalid_request" }, headers: {} };
    let input: { emoji?: unknown };
    try {
      input = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
    }
    const emoji = typeof input?.emoji === "string" ? input.emoji : "";
    if (!emoji) return { status: 400, body: { error: "emoji が必要です", code: "invalid_request" }, headers: {} };

    const exists = await pool.query(
      `SELECT 1 FROM chat_messages WHERE id = $1 AND created_at >= now() - ($2::text)::interval`,
      [id, CHAT_TTL]
    );
    if (exists.rowCount === 0) {
      return { status: 404, body: { error: "メッセージが見つかりません", code: "not_found" }, headers: {} };
    }
    try {
      const r = await toggleReaction("chat", id, ctx.email, emoji);
      return { status: 200, body: { apiVersion: AGENT_API_VERSION, ...r }, headers: {} };
    } catch (e) {
      const msg = (e as Error)?.message;
      if (msg === "invalid_emoji") {
        return { status: 400, body: { error: "不正な絵文字です", code: "invalid_request" }, headers: {} };
      }
      if (msg === "unknown_emoji") {
        return { status: 404, body: { error: "その絵文字は登録されていません", code: "not_found" }, headers: {} };
      }
      throw e;
    }
  });
  return agentJson(out);
}
