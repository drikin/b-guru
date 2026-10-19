import type { PostPoll } from "./poll";
import { EventEmitter } from "events";
import type { ChatMessage } from "./chat";
import type { UrlPreview } from "./urlpreview";
import type { VoiceState } from "./voice";
import type { RoomMember } from "./room";

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
 *   { type: "club"   , postId, club }              — 部活動ラベル付与/変更
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
  | { type: "post"; postId: number; action: "create" | "update" | "delete"; authorId?: string; urlPreview?: UrlPreview | null }
  | { type: "pin"; postId: number; action: "toggle" }
  | { type: "presence"; userIds: string[] }
  | { type: "chat"; message: ChatLiveMessage; action: "create" | "delete" | "edit" }
  | { type: "poll"; action: "vote" | "edit"; postId: number; poll: PostPoll }
  | { type: "club"; postId: number; club: string | null }
  /** A chat message's reactions changed. `userIds` are opaque users.user_id (never
   *  emails) so each receiver can mark its own chips; `reactors` are display names. */
  | { type: "chat_reaction"; messageId: number; reactions: ChatReactionLive[] }
  /** Who is in the voice room (user_id / display name / avatar only — no email). */
  | { type: "voice"; state: VoiceState }
  // The club room (lib/room.ts): someone came in / changed / left, or a reaction.
  | { type: "room"; action: "join" | "update" | "leave"; member: RoomMember }
  | { type: "room"; action: "react"; userId: string; emoji: string; to: string | null };

export type ChatReactionLive = { emoji: string; count: number; reactors: string[]; userIds: string[] };

/**
 * ⚠️ Every event on this bus is broadcast VERBATIM to every connected SSE
 * client, so a payload must never contain a member's email address.
 *
 *   - `post.authorId` / `presence.userIds` are opaque `users.user_id` values.
 *   - `chat.message` carries `authorId` only. It deliberately does NOT carry
 *     `isAuthor`: that flag is per-RECEIVER (it is true only for the author's
 *     own client), and one shared payload cannot express it. Each client
 *     derives it locally by comparing `authorId` with its own user id.
 */
export function emitLive(event: LiveEvent): void {
  // fire-and-forget; guard against listener errors crashing the API route
  try {
    liveBus.emit("change", event);
  } catch (e) {
    console.error("emitLive error:", (e as any)?.message);
  }
}