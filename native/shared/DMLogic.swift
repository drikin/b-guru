import Foundation

// ✉️ 簡易 DM — the data and the pure parts (state: DMStore.swift, screens: DMView.swift). Foundation only,
// so the Mac's unit tests compile this file alone (mac/Tests/DMLogicTests.swift).

struct DMPeer: Codable, Hashable, Sendable, Identifiable {
    var userId: String
    var name: String?
    var avatar: String?
    var id: String { userId }
    var displayName: String { (name?.isEmpty == false ? name : nil) ?? "会員" }
}

struct DMMessage: Codable, Equatable, Sendable, Identifiable {
    var id: Int
    var fromId: String
    var toId: String
    var peerId: String
    var body: String
    /// 📷 Attached photos (/api/media/dm-…, up to 4; body may be "" then). Missing (older servers) = [].
    var images: [String] = []
    var createdAt: String
    var isAuthor: Bool
    var clientId: String?
    /// ✏️ Changed after it was sent (docs/dm-chat-parity-spec.md). Missing (older servers) = false / nil.
    var edited = false
    var editedAt: String? = nil
    /// 😀 The chips (the chat's shape and order). Filled when a conversation is opened; [] in the list and on create.
    var reactions: [Reaction] = []
    /// Local only: on its way (negative id) / could not be sent.
    var pending = false
    var failed = false

    enum CodingKeys: String, CodingKey { case id, fromId, toId, peerId, body, images, createdAt, isAuthor, clientId, edited, editedAt, reactions }

    /// The text for the list and notifications: the body, or 「📷 写真」 for photos alone.
    var shownBody: String { DMPhotoText.shown(body: body, imageCount: images.count) }
}

extension DMMessage {
    /// `images` defaults to [] (older servers and stream events without it).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        fromId = try c.decode(String.self, forKey: .fromId)
        toId = try c.decode(String.self, forKey: .toId)
        peerId = try c.decode(String.self, forKey: .peerId)
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        images = (try? c.decodeIfPresent([String].self, forKey: .images)) ?? []
        createdAt = try c.decode(String.self, forKey: .createdAt)
        isAuthor = try c.decode(Bool.self, forKey: .isAuthor)
        clientId = try c.decodeIfPresent(String.self, forKey: .clientId)
        edited = (try? c.decodeIfPresent(Bool.self, forKey: .edited)) ?? false
        editedAt = try? c.decodeIfPresent(String.self, forKey: .editedAt)
        reactions = (try? c.decodeIfPresent([Reaction].self, forKey: .reactions)) ?? []
    }

    /// Sent and stored (not on its way, not failed): may be reacted to / edited.
    var isStored: Bool { id > 0 && !pending && !failed }
}

struct DMConversation: Codable, Equatable, Sendable, Identifiable {
    var peer: DMPeer
    var lastMessage: DMMessage
    var unreadCount: Int
    var id: String { peer.userId }
}

struct DMListResponse: Decodable, Sendable {
    var conversations: [DMConversation]
    var unreadCount: Int
}

struct DMThreadResponse: Decodable, Sendable {
    var peer: DMPeer
    var messages: [DMMessage]
    var unreadCount: Int?
    var lastReadId: Int?
    var canSend: Bool?
}

/// The pure parts (tested by eye in the demo, and kept apart so the store stays small).
enum DMLogic {
    /// From capabilities' features.dm.ttl_hours (30 days since 2026-10-27; 24 h before).
    nonisolated(unsafe) static var ttl: TimeInterval = 30 * 24 * 60 * 60

    nonisolated(unsafe) private static let isoFrac: ISO8601DateFormatter = { // read-only after setup (thread-safe for parsing)
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let iso = ISO8601DateFormatter()

    static func date(_ s: String) -> Date? { isoFrac.date(from: s) ?? iso.date(from: s) }

    /// Gone after the ttl (messages still being sent stay).
    static func pruned(_ list: [DMMessage], now: Date = Date()) -> [DMMessage] {
        list.filter { m in m.pending || m.failed || (date(m.createdAt).map { now.timeIntervalSince($0) < ttl } ?? true) }
    }

    /// A stored message replaces my pending bubble (same client_id) or the same id; else it is added. Id order, pending last.
    static func reconcile(_ list: [DMMessage], with m: DMMessage) -> [DMMessage] {
        let matches: (DMMessage) -> Bool = { $0.id == m.id || (m.clientId != nil && $0.clientId == m.clientId && $0.id < 0) }
        var next = list.filter { !matches($0) }
        next.append(m)
        return next.sorted { a, b in (a.id < 0 ? Int.max : a.id) < (b.id < 0 ? Int.max : b.id) }
    }

    /// ✏️ An edited message (PATCH's answer or the stream's `edit`): the same id's text, photos and 「編集済み」
    /// change; its chips stay (they have their own event — as the chat does), and so do local flags.
    static func applyingEdit(_ list: [DMMessage], _ m: DMMessage) -> [DMMessage] {
        list.map { x in
            guard x.id == m.id else { return x }
            var next = x
            next.body = m.body
            next.images = m.images
            next.edited = m.edited
            next.editedAt = m.editedAt
            return next
        }
    }

    /// 😀 The stream's `reaction` (or the toggle's answer): that message's chips as the server says.
    static func settingReactions(_ list: [DMMessage], id: Int, _ reactions: [Reaction]) -> [DMMessage] {
        list.map { x in
            guard x.id == id else { return x }
            var next = x
            next.reactions = reactions
            return next
        }
    }

    /// The list's last line follows an edit of that conversation's last message.
    static func conversations(_ list: [DMConversation], edited m: DMMessage) -> [DMConversation] {
        list.map { c in
            guard c.lastMessage.id == m.id else { return c }
            var next = c
            next.lastMessage.body = m.body
            next.lastMessage.images = m.images
            next.lastMessage.edited = m.edited
            next.lastMessage.editedAt = m.editedAt
            return next
        }
    }

    /// ✏️ What may be saved: the text trimmed, not too long, and not empty unless the message has photos
    /// (the server's rule). Nil = nothing to save.
    static func editedBody(_ text: String, hasPhotos: Bool, maxBody: Int) -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard t.count <= maxBody, !t.isEmpty || hasPhotos else { return nil }
        return t
    }

    /// The list after a message: that conversation first, unread +1 when it is theirs and not on screen.
    static func conversations(_ list: [DMConversation], after m: DMMessage, peer: DMPeer, viewing: Bool) -> [DMConversation] {
        let before = list.first { $0.peer.userId == peer.userId }?.unreadCount ?? 0
        let unread = m.isAuthor ? before : (viewing ? 0 : before + 1)
        return [DMConversation(peer: peer, lastMessage: m, unreadCount: unread)] + list.filter { $0.peer.userId != peer.userId }
    }

    /// 「〇〇さんからの DM」 and the text, clipped (the notification; same as the server's dmNotificationText).
    static func notificationText(name: String?, body: String) -> (title: String, body: String) {
        let n = (name ?? "").trimmingCharacters(in: .whitespaces)
        return ("\(n.isEmpty ? "会員" : n)さんからの DM", body.count > 240 ? String(body.prefix(240)) + "…" : body)
    }
}


/// What of ✉️ DM is open. `nil` (in DMStore.route) = nothing; `list` = the list.
/// `group` / `groupMembers` / `newGroup`: 👥 グループ DM (GroupDMStore.swift).
/// A conversation is the same route whoever's name / face it carries (the store fills them in after
/// loading): the iPhone's navigation path must not see a new page then.
enum DMRoute: Hashable, Sendable {
    case list, thread(DMPeer), group(Int), groupMembers(Int), newGroup

    static func == (a: DMRoute, b: DMRoute) -> Bool {
        switch (a, b) {
        case (.list, .list), (.newGroup, .newGroup): return true
        case let (.thread(x), .thread(y)): return x.userId == y.userId
        case let (.group(x), .group(y)), let (.groupMembers(x), .groupMembers(y)): return x == y
        default: return false
        }
    }

    func hash(into h: inout Hasher) {
        switch self {
        case .list: h.combine(0)
        case let .thread(p): h.combine(1); h.combine(p.userId)
        case let .group(id): h.combine(2); h.combine(id)
        case let .groupMembers(id): h.combine(3); h.combine(id)
        case .newGroup: h.combine(4)
        }
    }

    /// ✉️ as a tab (iPhone's page / iPad's left column): the list is the root, and what is pushed over it.
    /// A group's members sit over its conversation (back = the conversation).
    static func path(for route: DMRoute?) -> [DMRoute] {
        switch route {
        case nil, .list?: return []
        case let .groupMembers(id)?: return [.group(id), .groupMembers(id)]
        case let r?: return [r]
        }
    }

    /// The route after the navigation path changed (back, swipe back): its last page, or the list.
    static func route(for path: [DMRoute]) -> DMRoute { path.last ?? .list }
}
