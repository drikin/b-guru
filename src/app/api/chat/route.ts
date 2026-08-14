import { NextRequest } from "next/server";
import { emitLive } from "@/lib/live";
import { getSessionEmail } from "@/lib/session";
import { pool } from "@/lib/db";
import {
  CHAT_MAX_BODY,
  CHAT_PAGE_SIZE,
  ChatMessage,
  createChatMessage,
  getLatestChatId,
  getUnreadCount,
  listChatMessages,
} from "@/lib/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
} as const;

/** Resolve a member's display name (most recent known from the timeline). */
async function resolveName(email: string): Promise<string | null> {
  try {
    const res = await pool.query(
      `SELECT author_name AS name FROM posts
       WHERE author_email = $1 ORDER BY created_at DESC LIMIT 1`,
      [email]
    );
    return res.rows[0]?.name ?? null;
  } catch {
    return null;
  }
}

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
  const limit = limitRaw ? Number(limitRaw) : CHAT_PAGE_SIZE;
  const [messages, unreadCount, latestId] = await Promise.all([
    listChatMessages({ before, limit }),
    getUnreadCount(email),
    getLatestChatId(),
  ]);
  return new Response(
    JSON.stringify({ messages, unreadCount, latestId }),
    { status: 200, headers: NO_STORE }
  );
}

// POST /api/chat — send a message to the global chat room.
// Body: { body: string }. Broadcasts the new message over SSE.
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: NO_STORE,
    });
  }

  let bodyText = "";
  try {
    const body = await req.json();
    bodyText = (body?.body ?? "").toString();
  } catch {
    /* ignore */
  }
  bodyText = bodyText.replace(/\r\n/g, "\n").trim();
  if (!bodyText) {
    return new Response(JSON.stringify({ error: "empty" }), {
      status: 400,
      headers: NO_STORE,
    });
  }
  if (bodyText.length > CHAT_MAX_BODY) {
    return new Response(JSON.stringify({ error: "too long" }), {
      status: 400,
      headers: NO_STORE,
    });
  }

  const name = await resolveName(email);
  let message: ChatMessage;
  try {
    message = await createChatMessage(email, name, bodyText);
  } catch (e) {
    console.error("chat create error:", (e as any)?.message);
    return new Response(JSON.stringify({ error: "db error" }), {
      status: 500,
      headers: NO_STORE,
    });
  }

  // Realtime broadcast over the existing SSE channel.
  emitLive({ type: "chat", message, action: "create" });

  const unreadCount = await getUnreadCount(email);
  return new Response(
    JSON.stringify({ ok: true, message, unreadCount }),
    { status: 200, headers: NO_STORE }
  );
}
