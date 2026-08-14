import { NextRequest } from "next/server";
import { getSessionEmail } from "@/lib/session";
import { getLatestChatId, markChatRead } from "@/lib/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
} as const;

// POST /api/chat/read — advance the caller's read cursor to the latest chat
// message (called when the chat panel is open / a new message arrives while
// open). Clears their unread badge. Idempotent (monotonic cursor).
export async function POST(req: NextRequest) {
  const email = await getSessionEmail();
  if (!email) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: NO_STORE,
    });
  }
  const latestId = await getLatestChatId();
  if (latestId > 0) await markChatRead(email, latestId);
  return new Response(
    JSON.stringify({ ok: true, unreadCount: 0, latestId }),
    { status: 200, headers: NO_STORE }
  );
}
