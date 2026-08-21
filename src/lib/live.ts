import type { PostPoll } from "./poll";
import { EventEmitter } from "events";
import type { ChatMessage } from "./chat";

// Chat delete events only carry the message id; create events carry the full
// message. A chat event's `message` always has at least `id`.
type ChatLiveMessage = { id: number } & Partial<ChatMessage>;

/**
 * In-process event bus used to push timeline changes to connected clients via
 * Server-Sent Events (SSE). A module-level singleton survives across route
 * handler invocations because this app runs as a single long-lived Node
 * process (`next start` under pm2, runtime="nodejs").
 *
 * Emitted event shapes:
 *   { type: "post"   , postId, action: "create" }  — new post or reply
 *   { type: "post"   , postId, action: "update" }  — edited text/images
 *   { type: "post"   , postId, action: "delete" }  — deleted post
 *   { type: "pin"    , postId, action: "toggle" }  — pinned/unpinned
 *   { type: "like"   , postId, action: "toggle" }  — optional like toggle
 *
 * Clients only receive a lightweight "something changed" signal and re-fetch
 * the first page themselves — we never push full post payloads, which keeps
 * consistency simple (client always reflects server state).
 */
export const liveBus = new EventEmitter();
// Many concurrent SSE clients each hold a "change" listener; default cap (10)
// would log MaxListenersExceededWarning and hint at a leak. We know listeners
// are removed on disconnect, so raise the cap and leak-harden.
liveBus.setMaxListeners(0);

export type LiveEvent =
  | { type: "post"; postId: number; action: "create" | "update" | "delete"; authorEmail?: string }
  | { type: "pin"; postId: number; action: "toggle" }
  | { type: "presence"; emails: string[] }
  | { type: "chat"; message: ChatLiveMessage; action: "create" | "delete" }
  | { type: "poll"; action: "vote" | "edit"; postId: number; poll: PostPoll };

export function emitLive(event: LiveEvent): void {
  // fire-and-forget; guard against listener errors crashing the API route
  try {
    liveBus.emit("change", event);
  } catch (e) {
    console.error("emitLive error:", (e as any)?.message);
  }
}