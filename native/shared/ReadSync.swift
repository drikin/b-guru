import Foundation

/// 既読で知らせを消す (docs/device-sync-spec.md §1): read on one device → the same notification
/// goes away on the others. One word from the server says what was read:
///
///   APNs (background push): `{ kind: "read_sync", scope, up_to?, peer_id?, post_id?, game_id?, event_id? }`
///   stream (`event: sync`):  the same without `kind`
///
/// This file only decides which notifications that word covers (pure, no UserNotifications, so the
/// unit tests compile it alone); the iPhone (Push.swift) and the Mac (App.swift) remove them.
struct ReadSync: Equatable, Sendable {
    enum Scope: String, Sendable {
        case chat, dm, reply, shogi, offkai
        case replyAll = "reply_all"
    }

    var scope: Scope
    /// chat: messages up to this id were read (nil = all).
    var upTo: Int?
    var peerId: String?
    var postId: Int?
    var gameId: Int?
    var eventId: Int?

    init(scope: Scope, upTo: Int? = nil, peerId: String? = nil, postId: Int? = nil, gameId: Int? = nil, eventId: Int? = nil) {
        self.scope = scope
        self.upTo = upTo
        self.peerId = peerId
        self.postId = postId
        self.gameId = gameId
        self.eventId = eventId
    }

    /// A push's userInfo (`kind` must be read_sync) or the stream's data (no `kind`). Numbers may come as
    /// numbers or as strings (FCM data is all strings). Nil for anything else, or a scope this app does not know.
    init?(payload: [AnyHashable: Any]) {
        if let kind = payload["kind"] as? String, kind != "read_sync" { return nil }
        guard let raw = payload["scope"] as? String, let scope = Scope(rawValue: raw) else { return nil }
        self.scope = scope
        upTo = Self.int(payload["up_to"])
        peerId = Self.string(payload["peer_id"])
        postId = Self.int(payload["post_id"])
        gameId = Self.int(payload["game_id"])
        eventId = Self.int(payload["event_id"])
        // A word that names nothing would clear more than was read.
        switch scope {
        case .dm: if peerId == nil { return nil }
        case .reply: if postId == nil { return nil }
        case .shogi: if gameId == nil { return nil }
        case .chat, .replyAll, .offkai: break
        }
    }

    /// The stream's `event: sync` data.
    init?(json: Data) {
        guard let obj = (try? JSONSerialization.jsonObject(with: json)) as? [String: Any] else { return nil }
        self.init(payload: obj)
    }

    // MARK: iPhone / iPad: a delivered push

    /// This delivered push is covered. Decided on what the push carries (its userInfo); the request
    /// identifier (= the APNs collapse id: chat-<id>, chat-new, dm-<peer>, reply-<id>, shogi-<id>, offkai-<id>)
    /// only when the push has no `kind`.
    func matchesPush(identifier: String, userInfo: [AnyHashable: Any]) -> Bool {
        guard let kind = userInfo["kind"] as? String else { return matchesCollapseId(identifier) }
        switch scope {
        case .chat:
            guard kind == "chat_mention" || kind == "chat_new" else { return false }
            guard let id = Self.int(userInfo["message_id"]) else { return kind == "chat_new" }
            return covers(id)
        case .dm:
            return kind == "dm" && Self.string(userInfo["peer_id"]) == peerId
        case .reply:
            return kind == "reply" && Self.int(userInfo["post_id"]) == postId
        case .replyAll:
            return kind == "reply"
        case .shogi:
            return kind.hasPrefix("shogi_") && Self.int(userInfo["game_id"]) == gameId
        case .offkai:
            guard kind == "offkai_start" else { return false }
            return eventId == nil || Self.int(userInfo["event_id"]) == eventId
        }
    }

    private func matchesCollapseId(_ identifier: String) -> Bool {
        switch scope {
        case .chat:
            if identifier == "chat-new" { return true }
            return Self.number(after: "chat-", in: identifier).map(covers) ?? false
        case .dm: return peerId.map { identifier == "dm-\($0)" } ?? false
        case .reply: return postId.map { identifier == "reply-\($0)" } ?? false
        case .replyAll: return identifier.hasPrefix("reply-")
        case .shogi: return gameId.map { identifier == "shogi-\($0)" } ?? false
        case .offkai:
            guard let id = Self.number(after: "offkai-", in: identifier) else { return false }
            return eventId == nil || id == eventId
        }
    }

    // MARK: Mac: the app's own notifications

    /// One of the Mac's own notifications (App.swift: chat-<id> mentions, dm-<peer>, post-<id>, shogi-<id>).
    /// The bundled 「新着」 (chat-new) is decided by `clearsChatBundle`, which also resets the bundle.
    func matchesLocal(identifier: String) -> Bool {
        switch scope {
        case .chat: return Self.number(after: "chat-", in: identifier).map(covers) ?? false
        case .dm: return peerId.map { identifier == "dm-\($0)" } ?? false
        // The Mac has no reply notifications; a post's own one (タイムラインの新しい投稿) goes with its replies.
        case .reply: return postId.map { identifier == "post-\($0)" } ?? false
        case .shogi: return gameId.map { identifier == "shogi-\($0)" } ?? false
        case .replyAll, .offkai: return false
        }
    }

    /// The Mac's bundled 「新着」 notification goes: everything in it (up to `newestId`) was read.
    func clearsChatBundle(newestId: Int?) -> Bool {
        guard scope == .chat else { return false }
        guard let newestId else { return true }
        return covers(newestId)
    }

    // MARK: Helpers

    private func covers(_ messageId: Int) -> Bool { upTo.map { messageId <= $0 } ?? true }

    private static func number(after prefix: String, in identifier: String) -> Int? {
        guard identifier.hasPrefix(prefix) else { return nil }
        return Int(identifier.dropFirst(prefix.count))
    }

    static func int(_ v: Any?) -> Int? {
        if let n = v as? NSNumber { return n.intValue }
        if let s = v as? String { return Int(s) }
        return nil
    }

    static func string(_ v: Any?) -> String? {
        if let s = v as? String { return s.isEmpty ? nil : s }
        if let n = v as? NSNumber { return n.stringValue }
        return nil
    }

    static func bool(_ v: Any?) -> Bool {
        if let n = v as? NSNumber { return n.boolValue }
        if let s = v as? String { return s == "true" || s == "1" }
        return false
    }
}
