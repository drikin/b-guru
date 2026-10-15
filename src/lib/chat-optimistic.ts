/* Optimistic chat send — pure helpers shared by the web client (and mirrored by
 * the native app). A message is shown the instant it is sent as a "pending" row
 * with a negative temporary id and a client-generated clientId; the stored
 * message (from the POST response or the SSE create event, whichever arrives
 * first) replaces it in place, matched by clientId. Negative ids never reach the
 * server (reactions / edit are hidden for pending rows). */
import type { ChatMessage } from "./chat";

export type ChatRow = ChatMessage & { pending?: boolean; failed?: boolean };

/** Max chat body length. Lives here (client-safe module) so the composer and
 *  the server validate against the same number; lib/chat.ts re-exports it. */
export const CHAT_BODY_LIMIT = 1000;

/** A fresh client id: URL-safe, matches the server's CLIENT_ID_RE. */
export function newChatClientId(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (c?.randomUUID) return c.randomUUID();
  return `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

let tempSeq = 0;
/** Negative, unique within this page — cannot collide with a stored id. */
export function newChatTempId(): number {
  tempSeq += 1;
  return -tempSeq;
}

/** Merge a stored message into the list.
 *  - already present by id → drop any leftover pending twin (same clientId + author)
 *  - a pending row with the same clientId → replace it in place (keeps order)
 *  - otherwise → append. */
export function reconcileChat(prev: ChatRow[], real: ChatMessage): ChatRow[] {
  const cid = real.clientId;
  // A pending row is only ever replaced by the SAME author's stored message —
  // clientIds travel on the broadcast, so never trust the id alone.
  const twin = (m: ChatRow) => m.id < 0 && !!cid && m.clientId === cid && m.authorId === real.authorId;
  if (prev.some((m) => m.id === real.id)) {
    return cid && prev.some(twin) ? prev.filter((m) => !twin(m)) : prev;
  }
  if (cid) {
    const i = prev.findIndex(twin);
    if (i >= 0) {
      const next = prev.slice();
      next[i] = { ...real };
      return next;
    }
  }
  return [...prev, { ...real }];
}

/** Mark a pending row as failed (kept on screen with a retry affordance). */
export function markChatFailed(prev: ChatRow[], clientId: string): ChatRow[] {
  return prev.map((m) =>
    m.id < 0 && m.clientId === clientId ? { ...m, pending: false, failed: true } : m
  );
}

/** Put a failed row back to pending for a retry. */
export function markChatRetrying(prev: ChatRow[], clientId: string): ChatRow[] {
  return prev.map((m) =>
    m.id < 0 && m.clientId === clientId ? { ...m, pending: true, failed: false } : m
  );
}
