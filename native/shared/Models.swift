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
    }
    struct PostFeatures: Decodable, Sendable {
        var read: Bool?
        var publish: Bool?
        var upload: Bool?
        var reactions: Bool?
        var markRead: Bool?
        var maxImages: Int?
    }
    struct VoiceFeatures: Decodable, Sendable {
        var enabled: Bool?
        var join: Bool?
        var admin: Bool?
        var maxParticipants: Int?
    }
    struct Features: Decodable, Sendable {
        var chat: ChatFeatures?
        var posts: PostFeatures?
        var voice: VoiceFeatures?
    }
    var apiVersion: Int
    var scopes: [String]?
    var features: Features?

    var canSend: Bool { features?.chat?.send ?? false }
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
    /// This token may join (has the "voice" scope — older tokens must sign in again).
    var canJoinVoice: Bool { features?.voice?.join ?? false }
    var isVoiceAdmin: Bool { features?.voice?.admin ?? false }
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
