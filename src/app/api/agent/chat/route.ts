/* GET /api/agent/chat — チャット履歴（自ユーザー可視分・既存 listChatMessages 再利用）。
 * スコープ read（chat 読み取り）。将来の chat 書き込みは別スコープ。 */
import { NextRequest } from "next/server";
import { listChatMessages } from "@/lib/chat";
import { withAgent } from "@/lib/agent-auth";
import { NO_CACHE } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/chat", "read", async (ctx) => {
    const rawLimit = Number(req.nextUrl.searchParams.get("limit") ?? "50");
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const beforeRaw = Number(req.nextUrl.searchParams.get("before") ?? "");
    const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined;
    const messages = await listChatMessages({ limit, before, viewerEmail: ctx.email });
    return {
      status: 200,
      body: {
        apiVersion: 1,
        messages: messages.map((m) => ({
          id: m.id,
          author_id: m.authorId,
          author_name: m.authorName,
          body: m.body,
          created_at: m.createdAt,
          edited: m.edited,
          edited_at: m.editedAt,
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
