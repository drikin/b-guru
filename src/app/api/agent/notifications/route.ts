/* GET /api/agent/notifications — 自身の通知（既存 listNotifications 再利用・email は含まれない）。 */
import { NextRequest } from "next/server";
import { listNotifications } from "@/lib/notifications";
import { withAgent } from "@/lib/agent-auth";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/notifications", "read", async (ctx) => {
    const items = await listNotifications(ctx.email);
    return {
      status: 200,
      body: {
        apiVersion: 1,
        notifications: items.map((n) => ({
          id: n.id,
          type: n.type,
          actor_id: n.actorId,
          actor_name: n.actorName,
          is_actor: n.isActor,
          post_id: n.postId,
          reply_id: n.replyId,
          text: n.text,
          read_at: n.readAt,
          created_at: n.createdAt,
        })),
      },
      headers: {},
    };
  });
  return new Response(JSON.stringify(out.body), {
    status: out.status,
    headers: { "Content-Type": "application/json", ...NO_CACHE },
  });
}
