/* /api/agent/chat — チャット（全員で1部屋・24時間で消える）。
 *   GET  : 履歴（スコープ read）。?include=reactions でリアクションも同梱。
 *   POST : 送信（スコープ chat）。{ body, client_id?, images?, reply_to_id? }（reply_to_id: ↩️ 返信先のメッセージ。消えていれば無視）（images は /api/agent/chat/upload の結果、4 枚まで。あれば body は空でよい）。Web の POST /api/chat と
 *          同じ lib（sendChatMessage）を通るので、検証・配信・既読の挙動が一致する。
 * DTO は lib/agent-chat.ts が正本（email を含めない）。 */
import { createHash } from "crypto";
import { NextRequest } from "next/server";
import { scheduleBeagleAnswer } from "@/lib/beagle-server";
import {
  getLatestChatId,
  getUnreadCount,
  getChatLastReadId,
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

/* GET options for the apps' cache (all optional; without them it is the old full page):
 *   after=<id>          only messages newer than <id> (default limit 200). "more": true when there
 *                       were more than the limit — the app then reads the whole page again.
 *   after=<id>&from=<f> also "window": [[id, sig], …] for the messages it has, f ≤ id ≤ after,
 *                       that still exist. A sig that changed (an edit, a reaction, a notice
 *                       rewritten, a renamed author) → re-read those ids; an id not in the window
 *                       was deleted or expired.
 *   ids=1,2,3           only these messages (at most 200).
 * Every message carries "sig": a short hash of what the viewer sees of it. */
export async function GET(req: NextRequest) {
  const out = await withAgent(req, "GET /api/agent/chat", "read", async (ctx) => {
    const sp = req.nextUrl.searchParams;
    const posInt = (k: string) => {
      const n = Number(sp.get(k) ?? "");
      return Number.isInteger(n) && n > 0 && n <= 2147483647 ? n : undefined;
    };
    const after = posInt("after");
    const from = after !== undefined ? posInt("from") : undefined;
    const ids = (sp.get("ids") ?? "")
      .split(",")
      .map((x) => Number(x))
      .filter((n) => Number.isInteger(n) && n > 0 && n <= 2147483647)
      .slice(0, 200);
    const rawLimit = Number(sp.get("limit") ?? (after !== undefined ? "200" : "50"));
    const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    const before = posInt("before");
    const withReactions = (sp.get("include") ?? "").split(",").includes("reactions");

    const list =
      ids.length > 0
        ? listChatMessages({ ids, limit: 200, viewerEmail: ctx.email })
        : after !== undefined
          ? listChatMessages({ after, limit: limit + 1, viewerEmail: ctx.email })
          : listChatMessages({ limit, before, viewerEmail: ctx.email });
    const windowList =
      from !== undefined && after !== undefined && from <= after
        ? listChatMessages({ from, to: after, limit: 200, viewerEmail: ctx.email })
        : Promise.resolve(null);
    const [fetched, windowMsgs, unreadCount, latestId, viewer, lastReadId] = await Promise.all([
      list,
      windowList,
      getUnreadCount(ctx.email),
      getLatestChatId(),
      chatViewerFor(ctx.email, ctx.userId),
      getChatLastReadId(ctx.email),
    ]);
    // after: read one more than the limit to know whether there were more (the newest are kept).
    const more = ids.length === 0 && after !== undefined && fetched.length > limit;
    const messages = more ? fetched.slice(fetched.length - limit) : fetched;
    const allIds = [...messages.map((m) => m.id), ...(windowMsgs ?? []).map((m) => m.id)];
    const reactions = withReactions ? await getReactions("chat", allIds, ctx.email) : null;
    const dto = (m: (typeof messages)[number]) =>
      withSig(toAgentChatDto(m, viewer, reactions ? reactions.get(m.id) ?? [] : undefined));
    return {
      status: 200,
      body: {
        apiVersion: AGENT_API_VERSION,
        unread_count: unreadCount,
        latest_id: latestId,
        last_read_id: lastReadId,
        messages: messages.map(dto),
        ...(after !== undefined && ids.length === 0 ? { more } : {}),
        ...(windowMsgs ? { window: windowMsgs.map((m) => [m.id, dto(m).sig]) } : {}),
      },
      headers: {},
    };
  });
  return agentJson(out);
}

/** A short hash of the message as this viewer sees it (body, names, reactions, …). */
function withSig<T extends object>(dto: T): T & { sig: string } {
  return { ...dto, sig: createHash("sha1").update(JSON.stringify(dto)).digest("hex").slice(0, 12) };
}

export async function POST(req: NextRequest) {
  const out = await withAgent(req, "POST /api/agent/chat", "chat", async (ctx) => {
    let input: { body?: unknown; client_id?: unknown; images?: unknown; reply_to_id?: unknown };
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
    const replyTo = Number.isSafeInteger(input?.reply_to_id) && (input.reply_to_id as number) > 0 ? (input.reply_to_id as number) : null;
    const message = await sendChatMessage(ctx.email, checked.body, normalizeClientId(input?.client_id), checked.images, replyTo);
    // 🐶 @ビーグル: アプリは端末内 AI が答えるかもしれないので、10 秒待ってまだ答えがなければサーバのビーグル
    // （新しい iPhone・Mac は雑談以外をすぐ POST beagle/ask で頼む）。lib/beagle-server.ts
    scheduleBeagleAnswer(message, ctx.email, ctx.appIssued ? "app" : "agent");
    // 送信者の DTO は is_author=true が確定しているので名前解決は不要（往復を増やさない）。
    const dto = toAgentChatDto(message, { userId: ctx.userId, mentionNames: new Set() });
    return { status: 201, body: { apiVersion: AGENT_API_VERSION, message: dto }, headers: {} };
  });
  return agentJson(out);
}
