import Foundation

/// Mirrors `AgentChatMessageDto` in src/lib/agent-chat.ts (the server is the
/// source of truth). Unknown fields are ignored; missing optional ones default,
/// so the web can add fields without breaking this app.
struct ChatMessage: Codable, Equatable, Sendable {
    var id: Int
    var authorId: String?
    var authorName: String?
    var avatar: String?
    var body: String
    var createdAt: String
    var edited: Bool
    var editedAt: String?
    var isAuthor: Bool
    var mentionsMe: Bool
    var clientId: String?
    var reactions: [Reaction]?
    /// Attached photos (/api/media/chat-…).
    var images: [String]? = nil
    /// "notice": a quiet one-line note from B-guru (who came into / left the room).
    var kind: String? = nil

    var isNotice: Bool { kind == "notice" }

    /// The server gives a photo-only message the body "📷 写真" (for apps that predate
    /// photos and for notifications); this app shows the photos instead.
    var displayBody: String {
        (images?.isEmpty == false && body == "📷 写真") ? "" : body
    }
}

struct Reaction: Codable, Equatable, Sendable, Hashable {
    var emoji: String
    var count: Int
    var mine: Bool
    var reactors: [String]
}

enum SendState: Equatable, Sendable {
    case sent, pending, failed
}

/// A row in the chat list. `key` is stable across the pending → stored swap
/// (clientId when we sent it, otherwise the server id) so SwiftUI never
/// remounts the bubble — no flicker when a send is confirmed.
struct ChatRow: Identifiable, Equatable, Sendable {
    var message: ChatMessage
    var state: SendState = .sent
    var key: String

    var id: String { key }

    init(_ message: ChatMessage, state: SendState = .sent) {
        self.message = message
        self.state = state
        self.key = message.clientId ?? "id-\(message.id)"
    }
}

struct ChatListResponse: Decodable, Sendable {
    var unreadCount: Int
    var latestId: Int
    /// The member's read cursor (servers before 2026-10-19 omit it).
    var lastReadId: Int?
    var messages: [ChatMessage]
}

struct ChatSendResponse: Decodable, Sendable {
    var message: ChatMessage
}

struct ReactionToggleResponse: Decodable, Sendable {
    var added: Bool
    var reactions: [Reaction]
}

struct ReadResponse: Decodable, Sendable {
    var unreadCount: Int
    var latestId: Int
}

struct SummaryResponse: Decodable, Sendable {
    struct Chat: Decodable, Sendable { var unreadCount: Int; var latestId: Int }
    var chat: Chat
    var onlineCount: Int
}

/// GET /api/agent/capabilities. Every field optional: a feature the server does
/// not report is treated as absent and its UI is hidden.
struct Capabilities: Decodable, Sendable {
    struct ChatFeatures: Decodable, Sendable {
        var read: Bool?
        var send: Bool?
        var editOwn: Bool?
        var reactions: Bool?
        var markRead: Bool?
        var maxBody: Int?
        var ttlHours: Int?
        var images: Bool?
        var imageUpload: String?
        var maxImages: Int?
        var imageMaxSide: Int?
    }
    struct PostFeatures: Decodable, Sendable {
        var read: Bool?
        var publish: Bool?
        var upload: Bool?
        var reactions: Bool?
        var markRead: Bool?
        var maxImages: Int?
    }
    struct RoomFeatures: Decodable, Sendable {
        var enabled: Bool?
        var path: String?
    }
    struct VoiceFeatures: Decodable, Sendable {
        var enabled: Bool?
        var join: Bool?
        var admin: Bool?
        var maxParticipants: Int?
        var maxSpeakers: Int?
    }
    struct Features: Decodable, Sendable {
        var chat: ChatFeatures?
        var posts: PostFeatures?
        var voice: VoiceFeatures?
        var room: RoomFeatures?
    }
    var apiVersion: Int
    var scopes: [String]?
    var features: Features?

    var canSend: Bool { features?.chat?.send ?? false }
    /// Photos in the chat (servers from before them say nothing → off).
    var canSendChatImages: Bool { features?.chat?.images ?? false }
    var maxChatImages: Int { features?.chat?.maxImages ?? 4 }
    var chatImageMaxSide: Int { features?.chat?.imageMaxSide ?? 1280 }
    var canEdit: Bool { features?.chat?.editOwn ?? false }
    var canReact: Bool { features?.chat?.reactions ?? false }
    var canMarkRead: Bool { features?.chat?.markRead ?? false }
    var maxBody: Int { features?.chat?.maxBody ?? 1000 }
    /// Timeline is available on this server.
    var hasTimeline: Bool { features?.posts?.read ?? false }
    /// Posting needs the "write" scope — tokens from before the timeline must reconnect once.
    var canPublish: Bool { features?.posts?.publish ?? false }
    var canReactPosts: Bool { features?.posts?.reactions ?? false }
    var maxImages: Int { features?.posts?.maxImages ?? 5 }
    /// Voice room is on for this member (server configured + in the rollout).
    var voiceEnabled: Bool { features?.voice?.enabled ?? false }
    /// The club room (8-bit room view + proximity voice) is on for this member.
    var roomEnabled: Bool { features?.room?.enabled ?? false }
    /// This token may join (has the "voice" scope — older tokens must sign in again).
    var canJoinVoice: Bool { features?.voice?.join ?? false }
    var isVoiceAdmin: Bool { features?.voice?.admin ?? false }
    var voiceMaxSpeakers: Int { features?.voice?.maxSpeakers ?? 10 }
}

// MARK: - Voice room

/// Who is in the voice room, as the server sees it (GET /api/agent/voice and
/// the stream's `voice` event). Shown to people who have not joined.
struct VoiceRoomInfo: Codable, Equatable, Sendable {
    struct Member: Codable, Equatable, Sendable, Identifiable {
        var userId: String
        var name: String?
        var avatar: String?
        var id: String { userId }
    }
    var active: Bool
    var openedBy: String?
    var startedAt: String?
    var participants: [Member]
}

struct VoiceStateResponse: Decodable, Sendable {
    var enabled: Bool
    var room: VoiceRoomInfo?
}

struct VoiceTokenResponse: Decodable, Sendable {
    var url: String
    var token: String
    var room: String
    var identity: String
}

struct TokenIssueResponse: Decodable, Sendable {
    var token: String
    var expiresAt: String?
}

struct APIErrorBody: Decodable, Sendable {
    var error: String?
    var code: String?
}

// MARK: - Timeline (posts)

/// Mirrors `agentPostDto` in src/app/api/agent/posts/route.ts (+ include=reactions,read).
struct Post: Codable, Identifiable, Equatable, Sendable {
    var id: Int
    var authorId: String?
    var authorName: String?
    var authorAvatar: String?
    var isAuthor: Bool?
    var parentId: Int?
    var replyCount: Int?
    var text: String
    var images: [String]?
    var videoUrl: String?
    var audioUrl: String?
    var createdAt: String
    var lastActivityAt: String?
    var club: String?
    var reactions: [Reaction]?
    var unread: Bool?
    /// Root posts: replies by others this member has not read yet.
    var unreadReplies: Int?
    /// The page a link in the post points to (title / image), filled in by the server.
    var urlPreview: UrlPreview?

    /// The post is just one link that has a preview: show the card, not the bare URL.
    var isBareLink: Bool {
        guard urlPreview != nil else { return false }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && !t.contains(where: \.isWhitespace) && (t.hasPrefix("http://") || t.hasPrefix("https://"))
    }

    var mine: Bool { isAuthor ?? false }
}

struct PostListResponse: Decodable, Sendable {
    var posts: [Post]
    var nextCursor: String?
}

struct ThreadResponse: Decodable, Sendable {
    var post: Post
    var replies: [Post]
}

struct PublishResponse: Decodable, Sendable {
    var post: Post
}

struct UploadResponse: Decodable, Sendable {
    var urls: [String]
}

/// POST /api/agent/reactions answers without `mine`; the app fills it in.
struct PostReactionToggleResponse: Decodable, Sendable {
    struct R: Decodable, Sendable { var emoji: String; var count: Int }
    var added: Bool
    var reactions: [R]
}

struct ClubInfo: Decodable, Sendable, Hashable {
    var key: String
    var name: String
}


// MARK: - Club room (ルーム)

/// GET /api/agent/room — see docs/room-client-spec.md.
struct RoomMapInfo: Codable, Equatable, Sendable {
    struct Zone: Codable, Equatable, Sendable {
        var kind: String
        var name: String
        var x: Int, y: Int, w: Int, h: Int
        func contains(_ px: Int, _ py: Int) -> Bool { px >= x && px < x + w && py >= y && py < y + h }
    }
    struct Spot: Codable, Equatable, Sendable { var x: Int; var y: Int }
    struct Label: Codable, Equatable, Sendable { var name: String; var x: Int; var y: Int }
    var w: Int
    var h: Int
    var tiles: [String]
    var zones: [Zone]
    var door: Spot
    var seats: [Spot]
    var labels: [Label]
    var hearRadius: Int
}

struct RoomMember: Codable, Equatable, Sendable, Identifiable {
    var userId: String
    var name: String
    var avatar: String?
    var x: Int
    var y: Int
    var mode: String   // "room" | "text"
    var listening: Bool
    var mic: Bool
    var away: Bool
    var id: String { userId }
    var inRoom: Bool { mode == "room" }
}

struct RoomResponse: Decodable, Sendable {
    var map: RoomMapInfo
    var members: [RoomMember]
    var me: String
    var reactions: [String]?
}

struct RoomActionResponse: Decodable, Sendable {
    var ok: Bool?
    var member: RoomMember?
    var from: RoomMapInfo.Spot?
    var to: RoomMapInfo.Spot?
    var error: String?
}


/// Link preview (posts.url_preview — same object the web uses).
struct UrlPreview: Codable, Equatable, Sendable {
    var url: String
    var title: String?
    var description: String?
    var image: String?
    var siteName: String?
    /// YouTube video id (a play mark goes over the image).
    var videoId: String?

    /// The preview image through our server (/api/img) — the third-party site never
    /// sees the member, and the server caches it.
    var proxiedImage: String? {
        guard let image, image.hasPrefix("http") else { return image }
        var c = URLComponents(url: APIClient.baseURL.appendingPathComponent("/api/img"), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "u", value: image)]
        return c?.url?.absoluteString
    }
}
