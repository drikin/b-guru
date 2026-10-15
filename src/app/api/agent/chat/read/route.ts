/* POST /api/agent/chat/read — チャットの既読カーソルを進める（スコープ read_state）。
 * { last_read_id? }: 省略時は最新まで。カーソルは単調増加（戻らない）なので、
 * 古い ID を送っても既読が巻き戻ることはない。Web と同じ chat_read_state を使うので
 * Mac アプリで読めば Web / iPhone の未読バッジも消える。 */
import { NextRequest } from "next/server";
import { getLatestChatId, getUnreadCount, markChatRead } from "@/lib/chat";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION } from "@/lib/agent-chat";
import { agentJson, parsePositiveId } from "../../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/chat/read", "read_state", async (ctx) => {
    let input: { last_read_id?: unknown } = {};
    try {
      input = await req.json();
    } catch {
      /* 空ボディ = 最新まで */
    }
    const latestId = await getLatestChatId();
    const requested = input?.last_read_id == null ? latestId : parsePositiveId(input.last_read_id);
    if (requested == null) {
      return { status: 400, body: { error: "last_read_id が不正です", code: "invalid_request" }, headers: {} };
    }
    const target = Math.min(requested, latestId);
    if (target > 0) await markChatRead(ctx.email, target);
    const unreadCount = await getUnreadCount(ctx.email);
    return {
      status: 200,
      body: { apiVersion: AGENT_API_VERSION, unread_count: unreadCount, latest_id: latestId },
      headers: {},
    };
  });
  return agentJson(out);
}
