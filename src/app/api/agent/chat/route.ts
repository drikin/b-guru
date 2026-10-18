/* /api/agent/chat — チャット（全員で1部屋・24時間で消える）。
 *   GET  : 履歴（スコープ read）。?include=reactions でリアクションも同梱。
 *   POST : 送信（スコープ chat）。{ body, client_id?, images? }（images は /api/agent/chat/upload の結果、4 枚まで。あれば body は空でよい）。Web の POST /api/chat と
 *          同じ lib（sendChatMessage）を通るので、検証・配信・既読の挙動が一致する。
 * DTO は lib/agent-chat.ts が正本（email を含めない）。 */
import { NextRequest } from "next/server";
import {
  getLatestChatId,
  getUnreadCount,
  listChatMessages,
  normalizeChatInput,
  normalizeClientId,
  sendChatMessage,
} from "@/lib/chat";
import { getReactions } from "@/lib/reactions";
import { withAgent } from "@/lib/agent-auth";
import { AGENT_API_VERSION, chatViewerFor, toAgentChatDto } from "@/lib/agent-chat";
import { agentJson } from "../_lib";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/chat", "read", async (ctx) => {
    const sp = req.nextUrl.searchParams;
    const rawLimit = Number(sp.get("limit") ?? "50");
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const beforeRaw = Number(sp.get("before") ?? "");
    const before = Number.isInteger(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined;
    const withReactions = (sp.get("include") ?? "").split(",").includes("reactions");

    const [messages, unreadCount, latestId, viewer] = await Promise.all([
      listChatMessages({ limit, before, viewerEmail: ctx.email }),
      getUnreadCount(ctx.email),
      getLatestChatId(),
      chatViewerFor(ctx.email, ctx.userId),
    ]);
    const reactions = withReactions
      ? await getReactions("chat", messages.map((m) => m.id), ctx.email)
      : null;
    return {
      status: 200,
      body: {
        apiVersion: AGENT_API_VERSION,
        unread_count: unreadCount,
        latest_id: latestId,
        messages: messages.map((m) =>
          toAgentChatDto(m, viewer, reactions ? reactions.get(m.id) ?? [] : undefined)
        ),
      },
      headers: {},
    };
  });
  return agentJson(out);
}

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/chat", "chat", async (ctx) => {
    let input: { body?: unknown; client_id?: unknown; images?: unknown };
    try {
      input = await req.json();
    } catch {
      return { status: 400, body: { error: "JSON ボディが必要です", code: "invalid_request" }, headers: {} };
    }
    const checked = normalizeChatInput(input?.body, input?.images);
    if (!checked.ok) {
      const error =
        checked.error === "empty" ? "body が空です" : checked.error === "bad images" ? "写真が不正です（チャット用にアップロードしたものを 4 枚まで）" : "本文が長すぎます";
      return { status: 400, body: { error, code: "invalid_request" }, headers: {} };
    }
    const message = await sendChatMessage(ctx.email, checked.body, normalizeClientId(input?.client_id), checked.images);
    // 送信者の DTO は is_author=true が確定しているので名前解決は不要（往復を増やさない）。
    const dto = toAgentChatDto(message, { userId: ctx.userId, mentionNames: new Set() });
    return { status: 201, body: { apiVersion: AGENT_API_VERSION, message: dto }, headers: {} };
  });
  return agentJson(out);
}
