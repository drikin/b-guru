import { NextRequest } from "next/server";
import { emitLive } from "@/lib/live";
import { getSessionEmail } from "@/lib/session";
import { isAdmin } from "@/lib/admin";
import { CHAT_MAX_BODY, deleteChatMessage, editChatMessage } from "@/lib/chat";

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

// PATCH /api/chat/[id] — author self-edit (typo fix): update the body of your
// own message. Broadcasts the correction over SSE so everyone sees it live.
// Editing is allowed only for the original author and within the message TTL.
export async function PATCH(
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
  const { id } = await ctx.params;
  const msgId = Number(id);
  if (!Number.isInteger(msgId) || msgId <= 0) {
    return new Response(JSON.stringify({ error: "invalid id" }), {
      status: 400,
      headers: NO_STORE,
    });
  }
  let body: string;
  try {
    const j = await req.json();
    body = typeof j?.body === "string" ? j.body.trim() : "";
  } catch {
    body = "";
  }
  if (!body || body.length > CHAT_MAX_BODY) {
    return new Response(JSON.stringify({ error: "invalid body" }), {
      status: 400,
      headers: NO_STORE,
    });
  }
  const updated = await editChatMessage(msgId, email, body);
  if (!updated) {
    return new Response(JSON.stringify({ error: "not editable" }), {
      status: 403,
      headers: NO_STORE,
    });
  }
  emitLive({ type: "chat", action: "edit", message: updated });
  return new Response(
    JSON.stringify({ ok: true, message: updated }),
    { status: 200, headers: NO_STORE }
  );
}
