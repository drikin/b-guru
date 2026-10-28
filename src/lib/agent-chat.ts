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
import { TIME_CONTROLS } from "./shogi-clock";
import { CHARACTERS, ENGINE_VERSION as MINIGAME_ENGINE_VERSION } from "./minigame/sim";

/** 📺 The watch-together player page's contract (public/watch/: receive / postMessage). */
export const WATCH_BRIDGE_VERSION = 1;
/** The game page's postMessage contract (docs/minigame-spec.md「橋渡し」). */
export const MINIGAME_BRIDGE_VERSION = 1;

/** The board page's postMessage contract (docs/shogi-spec.md「盤面の橋渡し」). */
export const SHOGI_BRIDGE_VERSION = 1;

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
  /** "notice": a quiet line from B-guru (room comings and goings), not a message to answer.
   *  "shogi": the ☗ 将棋 game card — `shogi_game_id` is the game (body reads fine as text). */
  kind?: "notice" | "shogi" | "beagle_ai";
  shogi_game_id?: number;
  /** kind "beagle_ai": 🐶 Beagle's answer written by a member's device (lib/beagle-ondevice.ts); the
   *  question it answers. author_name already says whose device (「ビーグル（〇〇さんの端末）」). */
  reply_to_id?: number;
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
    ...(m.kind === "shogi" && m.shogiGameId ? { kind: "shogi", shogi_game_id: m.shogiGameId } : {}),
    ...(m.kind === "beagle_ai" ? { kind: "beagle_ai" as const, ...(m.replyToId ? { reply_to_id: m.replyToId } : {}) } : {}),
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
  // A post or comment was created: ids only (the Mac app re-reads its timeline and
  // notifies new posts itself; older apps ignore unknown events).
  if (ev.type === "post" && ev.action === "create") {
    return { event: "post", data: { action: "create", post_id: ev.postId } };
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
  // ☗ 将棋 (the stream route drops it for members without the feature).
  if (ev.type === "shogi") {
    return { event: "shogi", data: { action: ev.action, game: ev.game } };
  }
  // ☗ ビーグルの実況 (the stream route drops it for members without SHOGI_COMMENTARY_ENABLED).
  // Apps that don't know the event ignore it; a newer app relays it to the board as { type: "commentary", ... }.
  if (ev.type === "shogi_commentary") {
    return { event: "shogi_commentary", data: { game_id: ev.gameId, commentary: ev.commentary } };
  }
  // 🎮 散財ダッシュ: 今日の上位 10 (the stream route drops it for members without the feature).
  if (ev.type === "minigame") {
    return { event: "minigame", data: { action: ev.action, period: ev.period, key: ev.key, top: ev.top } };
  }
  // 📺 共同鑑賞: the whole state after each change (the stream route drops it for members without the feature).
  if (ev.type === "watch") {
    return { event: "watch", data: { state: ev.state } };
  }
  // 🍻 オフ会: 始まり・変化・終わり・写真・聞いている人数（the stream route drops it for members without the feature）。
  // event の can_end は常に false（見る人で変わる）。端末は始めた人・話す人が自分かで決める（管理者は GET の can_end）。
  if (ev.type === "offkai") {
    return {
      event: "offkai",
      data: {
        action: ev.action,
        ...(ev.event ? { event: ev.event } : {}),
        ...(ev.eventId != null ? { event_id: ev.eventId } : {}),
        ...(ev.photo ? { photo: ev.photo } : {}),
        ...(ev.photoId != null ? { photo_id: ev.photoId } : {}),
        ...(ev.listeners != null ? { listeners: ev.listeners } : {}),
      },
    };
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
export function agentCapabilities(
  scopes: AgentScope[],
  opts: { voice?: boolean; voiceAdmin?: boolean; room?: boolean; jukebox?: boolean; shogi?: boolean; shogiCommentary?: boolean; minigame?: boolean; watch?: boolean; offkai?: boolean; chatOverlay?: boolean; appIssued?: boolean; macAssistant?: boolean; beagleOnDevice?: boolean; beagleServer?: boolean } = {}
) {
  const ttlHours = parseInt(CHAT_TTL, 10) || 24;
  const can = (s: AgentScope) => scopes.includes(s);
  const app = !!opts.appIssued && can("post");
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
        // 🐶 @ビーグル への答えを端末内 AI（iOS 26 / macOS 26 の Foundation Models）で作って出す:
        // POST beagle { question_id, body, app? } → 201 { message }（BEAGLE_ONDEVICE_ENABLED、アプリの鍵だけ）。
        beagle_ondevice: !!opts.beagleOnDevice && !!opts.appIssued && can("chat"),
        // 🐶 サーバのビーグル（さくらの AI Engine）も答える: アプリはあいさつ・雑談以外を POST beagle/ask { question_id } で
        // すぐ頼む（頼まなくても 10 秒後にサーバが答える）。BEAGLE_SERVER_ENABLED。
        beagle_server: !!opts.beagleServer && can("chat"),
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
        include: ["reactions", "read", "display"],
        // include=display: each post carries `display` — the web's display decisions
        // (fold at 500, reaction order, link card, mentions…), docs/timeline-spec.md.
        display: true,
        publish: can("post"),
        upload: can("post"),
        reactions: can("post") || can("write"),
        mark_read: can("read_state"),
        max_images: 5,
        // 段階 3「操作」（docs/timeline-spec.md §10.1・§11）。人の投稿への新しい操作はアプリのログインで
        // 発行した鍵（app_issued）＋ post だけ。外部の鍵は今までできたことだけ（write の本文の編集・削除、
        // post の投稿・画像・リアクション・うなる、write/post のブックマーク）。
        edit: app,
        delete: app || can("write"),
        edit_text_only: !app && can("write"),
        whisper: can("post"),
        video: app,
        audio: app,
        max_media_mb: 100,
        poll: app,
        poll_vote: app,
        poll_edit: app,
        pin: app,
        pinned_list: can("read"),
        bookmarks: can("post") || can("write"),
        // POST /api/agent/bookmarks に { post_id, bookmarked: true|false } を送れば冪等（無ければ切り替え）
        bookmarks_set: can("post") || can("write"),
        favorites: app,
        custom_emoji_list: can("read") ? "/api/agent/emojis" : null,
        // 登録（POST multipart: name・image）と削除（DELETE …/<id>）。誰でも（オーナー 2026-10-27）、アプリの鍵だけ。
        custom_emoji_register: app && can("chat") ? "/api/agent/emojis" : null,
        custom_emoji_delete: app && can("chat") ? "/api/agent/emojis/{id}" : null,
        club_select: app,
        club_change: app,
        // 部活の表示・非表示（GET は読むだけ、PUT { club, hidden } はアプリの鍵だけ）。2026-10-28
        club_visibility: app ? "/api/agent/clubs/visibility" : null,
        mentions: can("read") ? "/api/agent/members" : null,
      },
      stream: {
        path: "/api/agent/stream",
        events: [
          "ready",
          "chat",
          "presence",
          "notification",
          "voice",
          ...(opts.shogi ? ["shogi"] : []),
          ...(opts.shogi && opts.shogiCommentary ? ["shogi_commentary"] : []),
          ...(opts.minigame ? ["minigame"] : []),
          ...(opts.watch ? ["watch"] : []),
          ...(opts.offkai ? ["offkai"] : []),
        ],
        affects_presence: false,
      },
      notifications: { read: can("read"), stream: true },
      // APNs (iPhone/iPad) and FCM (Android): register with POST /api/agent/devices/push.
      // shogi_offer / shogi_turn go only to devices registered with notify_shogi: true.
      push: {
        apns: apnsEnabled(),
        fcm: fcmEnabled(),
        register: "/api/agent/devices/push",
        kinds: ["chat_mention", "chat_new", "reply", ...(opts.shogi ? ["shogi_offer", "shogi_turn"] : [])],
      },
      summary: { path: "/api/agent/summary" },
      // Voice room (LiveKit). `enabled` = configured and this member is in the rollout;
      // `join` = this token has the "voice" scope (apps issued before it must sign in again).
      // The club room (8-bit room view + proximity voice), behind a rollout flag.
      room: { enabled: !!opts.room, path: "/api/agent/room" },
      // Send the article a post links to into BS ネタ帳 (neta.backspace.fm) — POST { url, title, description? }.
      neta: { enabled: can("post"), path: "/api/agent/neta", site: "https://neta.backspace.fm" },
      // Past backspace.fm episodes to listen to (Art19), behind a rollout flag.
      jukebox: { enabled: !!opts.jukebox, path: "/api/agent/jukebox" },
      // ☗ 将棋 (docs/shogi-spec.md), behind SHOGI_ENABLED. The board is a web page the app
      // shows in a WebView (bridge_version 1); the app keeps the token and the API to itself.
      shogi: shogiCapability(!!opts.shogi, scopes, !!opts.shogi && !!opts.shogiCommentary),
      // 🎮 散財ダッシュ (docs/minigame-spec.md), behind MINIGAME_ENABLED. The game is a web page the app
      // shows in a WebView (bridge_version 1); the app keeps the token and relays the API.
      minigame: minigameCapability(!!opts.minigame, scopes),
      // 📺 YouTube 共同鑑賞, behind WATCH_ENABLED. The player is a web page the app shows in a WebView
      // (bridge_version 1); the app relays the page's actions to the API and the stream's `watch` to the page.
      watch: watchCapability(!!opts.watch, scopes),
      // 🍻 オフ会（docs/offkai-spec.md）。声は LiveKit（鍵は POST token / speak）、写真は POST photos（multipart）。
      offkai: { enabled: !!opts.offkai, path: "/api/agent/offkai", control: !!opts.offkai && scopes.includes("chat") },
      // チャットの上に機能を重ねる新しい形（docs/chat-overlay-spec.md）。false = 今までの段（テキスト｜ルーム｜☗…）。
      chat_overlay: { enabled: !!opts.chatOverlay },
      // Mac のアシスタント機能（MAC_ASSISTANT_ENABLED・最初はオーナーだけ）。false なら Mac アプリは出さない。
      mac_assistant: !!opts.macAssistant,
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

export function shogiCapability(enabled: boolean, scopes: AgentScope[], commentary = false) {
  return {
    enabled,
    path: "/api/agent/shogi",
    board_url: "/shogi-board/index.html",
    bridge_version: SHOGI_BRIDGE_VERSION,
    play: enabled && scopes.includes("chat"),
    /** ビーグルと対局（練習）できる: POST games { mode, opponent: "beagle" }（アプリがボタンを出す目印）。 */
    beagle: true,
    /** ビーグルの実況が届く（stream の `shogi_commentary`、GET games/{id} の `commentary`）。盤には
     *  { type: "commentary", text, eval_cp, mate, ply, move_label } を渡すと下に帯が出る（docs/shogi-spec.md）。 */
    commentary,
    time_controls: TIME_CONTROLS,
  };
}

export function watchCapability(enabled: boolean, scopes: AgentScope[]) {
  return {
    enabled,
    path: "/api/agent/watch",
    player_url: "/watch/index.html",
    bridge_version: WATCH_BRIDGE_VERSION,
    control: enabled && scopes.includes("chat"),
  };
}

export function minigameCapability(enabled: boolean, scopes: AgentScope[]) {
  return {
    enabled,
    path: "/api/agent/minigame",
    game_url: "/minigame/index.html",
    bridge_version: MINIGAME_BRIDGE_VERSION,
    /** The simulation's rule version: a play issued for another version is refused (「ルール更新のため記録できません」). */
    engine_version: MINIGAME_ENGINE_VERSION,
    play: enabled && scopes.includes("chat"),
    characters: [...CHARACTERS],
    modes: ["daily", "free"],
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
