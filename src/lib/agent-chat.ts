/* Agent / native-client chat contract (the B-guru Mac chat app talks to this).
 *
 * Keeps three things in one place so the native client and the server evolve
 * together without breaking each other:
 *   - the chat message DTO (snake_case, no email — same rule as agent-write.ts)
 *   - the translation of broadcast/personal events into per-viewer stream events
 *   - the capabilities document: what this server supports right now. A client
 *     hides what is absent and ignores what it does not know, so the web can
 *     ship features first and the app picks them up when it is ready.
 * Compatibility policy: adding fields/capabilities is free; removing or
 * changing the meaning of one requires bumping AGENT_API_VERSION. */
import type { ChatMessage } from "./chat";
import { CHAT_MAX_BODY, CHAT_TTL } from "./chat";
import type { LiveEvent } from "./live";
import type { Notification } from "./notifications";
import type { ReactionSummary } from "./reactions";
import type { AgentScope } from "./agent-auth";
import { isMentionedIn, mentionNamesFor } from "./chat-mention";
import { resolveDisplayName } from "./display-name";

export const AGENT_API_VERSION = 1;

export type AgentChatMessageDto = {
  id: number;
  author_id: string | null;
  author_name: string | null;
  avatar: string | null;
  body: string;
  created_at: string;
  edited: boolean;
  edited_at: string | null;
  is_author: boolean;
  mentions_me: boolean;
  client_id?: string;
  reactions?: ReactionSummary[];
};

export type ChatViewer = { userId: string | null; mentionNames: Set<string> };

/** Message → DTO for one viewer. `is_author` is derived from the opaque
 *  author id (the broadcast payload deliberately has no isAuthor). The sender's
 *  own client_id is only echoed back to the sender. */
export function toAgentChatDto(
  m: { id: number } & Partial<ChatMessage>,
  viewer: ChatViewer,
  reactions?: ReactionSummary[]
): AgentChatMessageDto {
  const isAuthor =
    typeof m.isAuthor === "boolean"
      ? m.isAuthor
      : !!viewer.userId && !!m.authorId && m.authorId === viewer.userId;
  const body = m.body ?? "";
  const dto: AgentChatMessageDto = {
    id: m.id,
    author_id: m.authorId || null,
    author_name: m.authorName ?? null,
    avatar: m.avatar ?? null,
    body,
    created_at: m.createdAt ?? "",
    edited: !!m.edited,
    edited_at: m.editedAt ?? null,
    is_author: isAuthor,
    mentions_me: !isAuthor && isMentionedIn(body, viewer.mentionNames),
  };
  if (isAuthor && m.clientId) dto.client_id = m.clientId;
  if (reactions) dto.reactions = reactions;
  return dto;
}

export function toAgentNotificationDto(n: Notification) {
  return {
    id: n.id,
    type: n.type,
    actor_id: n.actorId,
    actor_name: n.actorName,
    is_actor: n.isActor,
    post_id: n.postId,
    reply_id: n.replyId,
    text: n.text,
    read_at: n.readAt,
    created_at: n.createdAt,
  };
}

export type StreamEvent = { event: string; data: Record<string, unknown> };

/** Broadcast bus event → the event this viewer's personal stream sends, or
 *  null when the stream does not carry that kind (timeline traffic stays on
 *  /api/posts/stream; the chat app does not need it). */
export function liveToStreamEvent(ev: LiveEvent, viewer: ChatViewer): StreamEvent | null {
  if (ev.type === "chat") {
    if (ev.action === "delete") {
      return { event: "chat", data: { action: "delete", id: ev.message.id } };
    }
    return {
      event: "chat",
      data: { action: ev.action, message: toAgentChatDto(ev.message, viewer) },
    };
  }
  if (ev.type === "presence") {
    return { event: "presence", data: { user_ids: ev.userIds } };
  }
  return null;
}

/** The capabilities document for GET /api/agent/capabilities. `scopes` are the
 *  calling token's, so a client knows up front which actions will be refused. */
export function agentCapabilities(scopes: AgentScope[]) {
  const ttlHours = parseInt(CHAT_TTL, 10) || 24;
  const can = (s: AgentScope) => scopes.includes(s);
  return {
    apiVersion: AGENT_API_VERSION,
    scopes,
    features: {
      chat: {
        read: can("read"),
        send: can("chat"),
        edit_own: can("chat"),
        delete: false, // moderation is web-only (admin)
        reactions: can("chat"),
        custom_emoji: true,
        mark_read: can("read_state"),
        client_id: true,
        max_body: CHAT_MAX_BODY,
        ttl_hours: ttlHours,
        reaction_events: false, // reactions are fetched, not streamed (yet)
      },
      stream: {
        path: "/api/agent/stream",
        events: ["ready", "chat", "presence", "notification"],
        affects_presence: false,
      },
      notifications: { read: can("read"), stream: true },
      summary: { path: "/api/agent/summary" },
    },
  };
}

/** Build the mention-matching viewer for a token's owner (same names the web
 *  client uses: current display name + email local part). Server-only. */
export async function chatViewerFor(email: string, userId: string | null): Promise<ChatViewer> {
  let name: string | null = null;
  try {
    name = await resolveDisplayName(email);
  } catch {
    /* names only widen matching; fall back to the local part */
  }
  return { userId, mentionNames: mentionNamesFor([name], email) };
}
