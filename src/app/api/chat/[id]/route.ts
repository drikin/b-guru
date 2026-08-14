import { NextRequest } from "next/server";
import { emitLive } from "@/lib/live";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { deleteChatMessage } from "@/lib/chat";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const NO_STORE = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store, no-cache, must-revalidate",
} as const;

// DELETE /api/chat/[id] — admin moderation: remove a message from the global
// chat room. Broadcasts the removal over SSE so open panels remove it live.
export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const email = await getSessionEmail();
  if (!email) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: NO_STORE,
    });
  }
  if (!isAdmin(email)) {
    return new Response(JSON.stringify({ error: "forbidden" }), {
      status: 403,
      headers: NO_STORE,
    });
  }
  const { id } = await ctx.params;
  const msgId = Number(id);
  if (!Number.isInteger(msgId) || msgId <= 0) {
    return new Response(JSON.stringify({ error: "invalid id" }), {
      status: 400,
      headers: NO_STORE,
    });
  }
  await deleteChatMessage(msgId);
  emitLive({ type: "chat", action: "delete", message: { id: msgId } });
  return new Response(
    JSON.stringify({ ok: true }),
    { status: 200, headers: NO_STORE }
  );
}
