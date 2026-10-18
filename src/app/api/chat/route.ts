import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import {
  CHAT_PAGE_SIZE,
  ChatMessage,
  getLatestChatId,
  getUnreadCount,
  listChatMessages,
  normalizeChatInput,
  normalizeClientId,
  sendChatMessage,
} from "@/lib/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
} as const;

// GET /api/chat?before=<id>&limit=<n>
// Returns recent history (oldest→newest), plus the caller's unread count and
// latest overall message id (for marking read). Requires login.
export async function GET(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: NO_STORE,
    });
  }
  const url = new URL(req.url);
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");
  const before = beforeRaw ? Number(beforeRaw) : undefined;
  // Non-integers (limit=abc → NaN) used to reach SQL as `LIMIT NaN` → 500.
  const limitNum = limitRaw ? Number(limitRaw) : CHAT_PAGE_SIZE;
  const limit = Number.isInteger(limitNum) && limitNum > 0 ? limitNum : CHAT_PAGE_SIZE;
  const [messages, unreadCount, latestId] = await Promise.all([
    listChatMessages({ before, limit, viewerEmail: email }),
    getUnreadCount(email),
    getLatestChatId(),
  ]);
  return new Response(
    JSON.stringify({ messages, unreadCount, latestId }),
    { status: 200, headers: NO_STORE }
  );
}

// POST /api/chat — send a message to the global chat room.
// Body: { body: string, clientId?: string, images?: string[] } — images are
// /api/media/chat-… paths from POST /api/chat/upload (at most 4; body may then be empty). Broadcasts the new message over
// SSE (with clientId so the sender's optimistic bubble is reconciled). The
// send path is one DB round-trip — see sendChatMessage in lib/chat.ts.
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: NO_STORE,
    });
  }

  let raw: unknown = "";
  let rawImages: unknown = undefined;
  let clientId: string | null = null;
  try {
    const body = await req.json();
    raw = body?.body ?? "";
    rawImages = body?.images;
    clientId = normalizeClientId(body?.clientId);
  } catch {
    /* ignore */
  }
  const checked = normalizeChatInput(raw, rawImages);
  if (!checked.ok) {
    return new Response(JSON.stringify({ error: checked.error }), {
      status: 400,
      headers: NO_STORE,
    });
  }

  let message: ChatMessage;
  try {
    message = await sendChatMessage(email, checked.body, clientId, checked.images);
  } catch (e) {
    console.error("chat create error:", (e as any)?.message);
    return new Response(JSON.stringify({ error: "db error" }), {
      status: 500,
      headers: NO_STORE,
    });
  }

  // The sender's read cursor is advanced inside sendChatMessage, so the
  // unread count after one's own message is 0 by definition.
  return new Response(
    JSON.stringify({ ok: true, message, unreadCount: 0 }),
    { status: 200, headers: NO_STORE }
  );
}
