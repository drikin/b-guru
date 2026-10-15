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
    struct Features: Decodable, Sendable {
        var chat: ChatFeatures?
    }
    var apiVersion: Int
    var scopes: [String]?
    var features: Features?

    var canSend: Bool { features?.chat?.send ?? false }
    var canEdit: Bool { features?.chat?.editOwn ?? false }
    var canReact: Bool { features?.chat?.reactions ?? false }
    var canMarkRead: Bool { features?.chat?.markRead ?? false }
    var maxBody: Int { features?.chat?.maxBody ?? 1000 }
}

struct TokenIssueResponse: Decodable, Sendable {
    var token: String
    var expiresAt: String?
}

struct APIErrorBody: Decodable, Sendable {
    var error: String?
    var code: String?
}
