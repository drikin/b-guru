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
import { CHAT_MAX_BODY, CHAT_MAX_IMAGES, CHAT_TTL } from "./chat";
import type { LiveEvent } from "./live";
import type { Notification } from "./notifications";
import type { ReactionSummary } from "./reactions";
import type { AgentScope } from "./agent-auth";
import type { VoiceState } from "./voice";
import type { RoomMember } from "./room";
import { isMentionedIn, mentionNamesFor } from "./chat-mention";
import { apnsEnabled } from "./apns";
import { fcmEnabled } from "./fcm";
import { VOICE_MAX_PARTICIPANTS, VOICE_MAX_SPEAKERS } from "./voice";
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
  /** Attached photos (/api/media/chat-…); always present (empty when none). */
  images: string[];
  /** "notice": a quiet line from B-guru (room comings and goings), not a message to answer. */
  kind?: "notice";
};

/** The body apps get for a message that is photos only. */
export const CHAT_PHOTO_ONLY_BODY = "📷 写真";

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
  const images = m.images ?? [];
  // A photo-only message has an empty body: apps from before photos show this instead
  // of an empty bubble (and notifications get a text). New apps hide it when images exist.
  const body = m.body || (images.length > 0 ? CHAT_PHOTO_ONLY_BODY : "");
  const dto: AgentChatMessageDto = {
    id: m.id,
    author_id: m.authorId || null,
    author_name: m.authorName ?? null,
    avatar: m.avatar ?? null,
    body,
    images,
    ...(m.kind === "notice" ? { kind: "notice" } : {}),
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
  if (ev.type === "chat_reaction") {
    // Same shape as the chat list's reactions, with `mine` for this viewer.
    return {
      event: "chat",
      data: {
        action: "reactions",
        id: ev.messageId,
        reactions: ev.reactions.map((r) => ({
          emoji: r.emoji,
          count: r.count,
          mine: !!viewer.userId && r.userIds.includes(viewer.userId),
          reactors: r.reactors,
        })),
      },
    };
  }
  if (ev.type === "room") {
    if (ev.action === "react") return { event: "room", data: { action: "react", user_id: ev.userId, emoji: ev.emoji, to: ev.to } };
    return { event: "room", data: { action: ev.action, member: toAgentRoomMemberDto(ev.member) } };
  }
  if (ev.type === "voice") {
    return { event: "voice", data: toAgentVoiceDto(ev.state) };
  }
  return null;
}

/** A member of the club room for the apps (snake_case like the rest of /api/agent). */
export function toAgentRoomMemberDto(m: RoomMember) {
  return { user_id: m.userId, name: m.name, avatar: m.avatar, x: m.x, y: m.y, mode: m.mode, listening: m.listening, mic: m.mic, away: m.away };
}

/** Voice room state for the native apps (snake_case like the rest of /api/agent). */
export function toAgentVoiceDto(s: VoiceState) {
  return {
    active: s.active,
    opened_by: s.openedBy,
    started_at: s.startedAt,
    participants: s.participants.map((p) => ({ user_id: p.userId, name: p.name, avatar: p.avatar })),
  };
}

/** The capabilities document for GET /api/agent/capabilities. `scopes` are the
 *  calling token's, so a client knows up front which actions will be refused. */
export function agentCapabilities(scopes: AgentScope[], opts: { voice?: boolean; voiceAdmin?: boolean; room?: boolean } = {}) {
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
        reaction_events: true, // stream: event "chat", action "reactions" { id, reactions }
        // Photos: POST upload (multipart images[]) → urls, then send them as `images`.
        // Resize on the device to a long side of image_max_side px first.
        images: can("chat"),
        image_upload: "/api/agent/chat/upload",
        max_images: CHAT_MAX_IMAGES,
        image_max_side: 1280,
      },
      // Timeline for the native apps. publish/upload need the "post" scope (people
      // posting from the app); tokens issued before it existed must reconnect once.
      posts: {
        read: can("read"),
        include: ["reactions", "read"],
        publish: can("post"),
        upload: can("post"),
        reactions: can("post") || can("write"),
        mark_read: can("read_state"),
        max_images: 5,
      },
      stream: {
        path: "/api/agent/stream",
        events: ["ready", "chat", "presence", "notification", "voice"],
        affects_presence: false,
      },
      notifications: { read: can("read"), stream: true },
      // APNs (iPhone/iPad) and FCM (Android): register with POST /api/agent/devices/push.
      push: { apns: apnsEnabled(), fcm: fcmEnabled(), register: "/api/agent/devices/push", kinds: ["chat_mention", "chat_new", "reply"] },
      summary: { path: "/api/agent/summary" },
      // Voice room (LiveKit). `enabled` = configured and this member is in the rollout;
      // `join` = this token has the "voice" scope (apps issued before it must sign in again).
      // The club room (8-bit room view + proximity voice), behind a rollout flag.
      room: { enabled: !!opts.room, path: "/api/agent/room" },
      voice: {
        enabled: !!opts.voice,
        join: !!opts.voice && can("voice"),
        path: "/api/agent/voice",
        max_participants: VOICE_MAX_PARTICIPANTS,
        max_speakers: VOICE_MAX_SPEAKERS,
        // Admins may remove anyone and ban; the session's opener may remove (server enforces both).
        admin: !!opts.voice && !!opts.voiceAdmin,
      },
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
