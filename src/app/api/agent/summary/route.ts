/* GET /api/agent/summary — メニューバー／Dock バッジ用の軽量サマリ（スコープ read）。
 * 1 回の呼び出しでバッジとポップオーバーの最初の描画に足りるものだけ返す。
 * 在席人数は数だけ（誰がいるかは stream の presence で）。 */
import { NextRequest } from "next/server";
import { getUnreadCount, getLatestChatId } from "@/lib/chat";
import { countUnreadNotifications, listNotifications } from "@/lib/notifications";
import { getOnlineUserIds } from "@/lib/presence";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION, toAgentNotificationDto } from "@/lib/agent-chat";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/summary", "read", async (ctx) => {
    const [chatUnread, chatLatest, notifUnread, notifs, online] = await Promise.all([
      getUnreadCount(ctx.email),
      getLatestChatId(),
      countUnreadNotifications(ctx.email),
      listNotifications(ctx.email),
      getOnlineUserIds(),
    ]);
    return {
      status: 200,
      body: {
        apiVersion: AGENT_API_VERSION,
        chat: { unread_count: chatUnread, latest_id: chatLatest },
        notifications: {
          unread_count: notifUnread,
          latest: notifs.slice(0, 5).map(toAgentNotificationDto),
        },
        online_count: online.length,
      },
      headers: {},
    };
  });
  return agentJson(out);
}
