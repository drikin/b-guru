import Foundation

// 👥 グループ DM (docs/group-dm-spec.md; server: src/lib/gdm.ts, /api/agent/gdm/**) — the data and the pure
// parts. Foundation only, so the Mac's unit tests compile this file alone (mac/Tests/GroupDMLogicTests.swift).
// The state is GroupDMStore.swift, the screens GroupDMView.swift.

struct GDMMember: Codable, Hashable, Sendable, Identifiable {
    var userId: String
    var name: String?
    var avatar: String?
    var isCreator: Bool?
    /// This member is me (the one looking): 「あなた」, and whom 「抜ける」 removes.
    var isMe: Bool?
    var id: String { userId }
    var displayName: String { (name?.isEmpty == false ? name : nil) ?? "会員" }
}

struct GDMGroup: Codable, Equatable, Sendable, Identifiable {
    var id: Int
    /// The name someone gave it (nil = none: `title` is the members' names).
    var name: String?
    /// The group's photo (🖼 2026-11-06): `/api/gdm/:gid/photo?v=…` on our own server (read with the member's
    /// Bearer; `?v=` changes with each file, so it may be cached), or nil — then 👥.
    var photo: String? = nil
    var title: String
    /// In the order they joined.
    var members: [GDMMember]
    var memberCount: Int?
    /// I made it (or took over when its maker left): I may remove others.
    var isCreator: Bool?
    /// I turned its notifications off.
    var muted: Bool?
    /// 🐶 Members' @ビーグル gets an answer here (any member turns it on or off; off by default; nil = older server).
    var beagle: Bool? = nil
    var createdAt: String?

    var displayTitle: String { title.isEmpty ? "グループ" : title }
    /// The photo to show (nil = 👥): only a path or URL that looks like one.
    var photoPath: String? { GDMLogic.photoPath(photo) }
    var me: GDMMember? { members.first { $0.isMe == true } }
}

struct GDMMessage: Codable, Equatable, Sendable, Identifiable {
    var id: Int
    var groupId: Int
    /// "text" or "system" (someone joined / left / renamed it: one line made by the server).
    var kind: String
    var fromId: String?
    var fromName: String?
    var fromAvatar: String?
    var body: String
    /// 📷 Attached photos (/api/media/dm-…, up to 4; body may be "" then). Missing (older servers) = [].
    var images: [String] = []
    var createdAt: String
    var isAuthor: Bool
    /// 🐶 Beagle's answer (kind stays "text" so older apps show it as a message from ビーグル).
    var isBeagle: Bool? = nil
    var clientId: String?
    /// Local only: on its way (negative id) / could not be sent.
    var pending = false
    var failed = false

    enum CodingKeys: String, CodingKey { case id, groupId, kind, fromId, fromName, fromAvatar, body, images, createdAt, isAuthor, isBeagle, clientId }

    /// The text for the list and notifications: the body, or 「📷 写真」 for photos alone.
    var shownBody: String { DMPhotoText.shown(body: body, imageCount: images.count) }

    var isSystem: Bool { kind == "system" }
    var senderName: String {
        let n = (fromName ?? "").trimmingCharacters(in: .whitespaces)
        return n.isEmpty ? "会員" : n
    }
}

extension GDMMessage {
    /// `images` defaults to [] (older servers, system lines and stream events without it).
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(Int.self, forKey: .id)
        groupId = try c.decode(Int.self, forKey: .groupId)
        kind = try c.decodeIfPresent(String.self, forKey: .kind) ?? "text"
        fromId = try c.decodeIfPresent(String.self, forKey: .fromId)
        fromName = try c.decodeIfPresent(String.self, forKey: .fromName)
        fromAvatar = try c.decodeIfPresent(String.self, forKey: .fromAvatar)
        body = try c.decodeIfPresent(String.self, forKey: .body) ?? ""
        images = (try? c.decodeIfPresent([String].self, forKey: .images)) ?? []
        createdAt = try c.decode(String.self, forKey: .createdAt)
        isAuthor = try c.decodeIfPresent(Bool.self, forKey: .isAuthor) ?? false
        isBeagle = try c.decodeIfPresent(Bool.self, forKey: .isBeagle)
        clientId = try c.decodeIfPresent(String.self, forKey: .clientId)
    }
}

struct GDMSummary: Codable, Equatable, Sendable, Identifiable {
    var group: GDMGroup
    var lastMessage: GDMMessage?
    var unreadCount: Int
    var id: Int { group.id }
}

struct GDMListResponse: Decodable, Sendable {
    var groups: [GDMSummary]
    var groupUnreadCount: Int?
}

struct GDMThreadResponse: Decodable, Sendable {
    var group: GDMGroup
    var messages: [GDMMessage]
    var unreadCount: Int?
    var lastReadId: Int?
    var canSend: Bool?
}

/// Stream `event: gdm`: create / read / group / removed (docs/group-dm-spec.md §配信).
struct GDMEvent: Decodable, Sendable {
    var action: String
    var groupId: Int?
    var message: GDMMessage?
    var group: GDMGroup?
    var lastReadId: Int?
    var unreadCount: Int?
    var groupUnreadCount: Int?

    static func decode(_ data: Data) -> GDMEvent? {
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        return try? dec.decode(GDMEvent.self, from: data)
    }
}

enum GDMLogic {
    /// From capabilities' features.gdm.ttl_hours (30 days, the same as the 1:1 DM).
    nonisolated(unsafe) static var ttl: TimeInterval = 30 * 24 * 60 * 60

    nonisolated(unsafe) private static let isoFrac: ISO8601DateFormatter = { // read-only after setup (thread-safe for parsing)
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let iso = ISO8601DateFormatter()

    static func date(_ s: String?) -> Date? {
        guard let s else { return nil }
        return isoFrac.date(from: s) ?? iso.date(from: s)
    }

    static func expired(_ m: GDMMessage, now: Date = Date()) -> Bool {
        guard !m.pending, !m.failed, let d = date(m.createdAt) else { return false }
        return now.timeIntervalSince(d) >= ttl
    }

    /// Gone after the ttl (messages still being sent stay).
    static func pruned(_ list: [GDMMessage], now: Date = Date()) -> [GDMMessage] {
        list.filter { !expired($0, now: now) }
    }

    /// Groups stay without messages (the spec): only a last message past the ttl goes.
    static func prunedSummaries(_ list: [GDMSummary], now: Date = Date()) -> [GDMSummary] {
        list.map { s in
            guard let m = s.lastMessage, expired(m, now: now) else { return s }
            return GDMSummary(group: s.group, lastMessage: nil, unreadCount: s.unreadCount)
        }
    }

    /// A stored message replaces my pending bubble (same client_id) or the same id; else it is added. Id order, pending last.
    static func reconcile(_ list: [GDMMessage], with m: GDMMessage) -> [GDMMessage] {
        let matches: (GDMMessage) -> Bool = { $0.id == m.id || (m.clientId != nil && $0.clientId == m.clientId && $0.id < 0) }
        var next = list.filter { !matches($0) }
        next.append(m)
        return next.sorted { a, b in (a.id < 0 ? Int.max : a.id) < (b.id < 0 ? Int.max : b.id) }
    }

    /// When the summary last moved (its last message, else when the group was made) — the list's order.
    static func activity(_ s: GDMSummary) -> String? { s.lastMessage?.createdAt ?? s.group.createdAt }

    /// The list after a new message in a group it has: that group first, unread +1 when it is someone
    /// else's text and not on screen. Nil when the group is not in the list (the caller reads the list again).
    static func summaries(_ list: [GDMSummary], after m: GDMMessage, viewing: Bool) -> [GDMSummary]? {
        guard let old = list.first(where: { $0.group.id == m.groupId }) else { return nil }
        if old.lastMessage?.id == m.id { return list }
        let counts = !m.isAuthor && !m.isSystem && !viewing
        let next = GDMSummary(group: old.group, lastMessage: m, unreadCount: viewing ? 0 : old.unreadCount + (counts ? 1 : 0))
        return [next] + list.filter { $0.group.id != m.groupId }
    }

    /// A group's new name / members / mute: in place, or first when it is new to me (I was just added).
    static func summaries(_ list: [GDMSummary], updating g: GDMGroup) -> [GDMSummary] {
        if let i = list.firstIndex(where: { $0.group.id == g.id }) {
            var next = list
            next[i].group = g
            return next
        }
        return [GDMSummary(group: g, lastMessage: nil, unreadCount: 0)] + list
    }

    /// Newest first, by when each last moved (no date → last). Stable for equal dates.
    static func newestFirst<T>(_ items: [T], at: (T) -> String?) -> [T] {
        let keyed = items.enumerated().map { (i: $0.offset, item: $0.element, d: date(at($0.element))) }
        return keyed.sorted { a, b in
            switch (a.d, b.d) {
            case let (x?, y?): return x != y ? x > y : a.i < b.i
            case (.some, nil): return true
            case (nil, .some): return false
            case (nil, nil): return a.i < b.i
            }
        }.map(\.item)
    }

    /// The list line under a group's title: 「あなた: …」, 「名前: …」 or a system line as it is.
    static func preview(_ m: GDMMessage?) -> String {
        guard let m else { return "まだ発言はありません" }
        if m.isSystem { return m.body }
        return (m.isAuthor ? "あなた" : m.senderName) + ": " + m.shownBody
    }

    /// The notification: the group's title, and 「送り主: 本文」 clipped (iPhone's NSE says the same).
    static func notificationText(title: String, fromName: String?, body: String) -> (title: String, body: String) {
        let t = title.trimmingCharacters(in: .whitespaces)
        let n = (fromName ?? "").trimmingCharacters(in: .whitespaces)
        let text = "\(n.isEmpty ? "会員" : n): \(body)"
        return (t.isEmpty ? "B-guru グループ DM" : t, text.count > 240 ? String(text.prefix(240)) + "…" : text)
    }

    /// The name to send: trimmed, nil when empty (PATCH clears it), never longer than `max`.
    static func cleanName(_ s: String, max: Int) -> String? {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty ? nil : String(t.prefix(max))
    }

    // MARK: The group's photo

    /// A photo path worth loading (nil / empty → 👥). MediaCache sends the token only to our own server.
    static func photoPath(_ raw: String?) -> String? {
        guard let t = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty else { return nil }
        return t
    }

    /// The members screen's button: 「写真を設定」 or 「写真を変える」.
    static func photoButtonTitle(hasPhoto: Bool) -> String { hasPhoto ? "写真を変える" : "写真を設定" }

    /// The longest side the app shrinks a photo to before sending (the server makes it a 512px square).
    static let photoMaxSide = 1024

    /// POST {path}/:gid/photo's body: one multipart field `photo` (a JPEG made on the device).
    static func photoMultipart(_ jpeg: Data, boundary: String) -> Data {
        var body = Data()
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"photo\"; filename=\"photo.jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8))
        body.append(jpeg)
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))
        return body
    }

    /// Too big to send (after shrinking): the server's limit, said the same way as the web.
    static func photoTooBig(_ bytes: Int, max: Int) -> String? {
        guard max > 0, bytes > max else { return nil }
        return "写真が大きすぎます（\(max / (1024 * 1024))MB まで）"
    }

    /// How many people the picker shows at once.
    static let pickerLimit = 10

    /// What the picker shows (ドリキン 2026-11-06: the member total is private, so never the whole list up front).
    /// - nothing typed: only my 1:1 DM partners (`peerIds`) and those already chosen
    /// - typed: those whose name matches, at most `pickerLimit`, plus those already chosen
    static func pickerList<T>(_ list: [T], id: (T) -> String, name: (T) -> String, excluding: Set<String>,
                              peerIds: Set<String>, selected: Set<String>, query: String) -> [T] {
        let chosen = list.filter { selected.contains(id($0)) }
        let pool = candidates(list, id: id, name: name, excluding: excluding.union(selected), query: query)
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        let more = q.isEmpty ? pool.filter { peerIds.contains(id($0)) } : pool
        return chosen + Array(more.prefix(pickerLimit))
    }

    /// 「＋ 新規 DM」: one person to write to — the group picker's rule (nothing typed: only my 1:1 partners;
    /// typed: matching names, at most `pickerLimit`; never ビーグル, never me). オーナー 2026-11-08.
    static func newDMList<T>(_ list: [T], id: (T) -> String, name: (T) -> String, me: String?,
                             peerIds: Set<String>, query: String) -> [T] {
        pickerList(list, id: id, name: name, excluding: Set([me].compactMap { $0 }),
                   peerIds: peerIds, selected: [], query: query)
    }

    /// Who can be picked: not me, not those already in, not Beagle; matched by name (case and spaces ignored).
    static func candidates<T>(_ list: [T], id: (T) -> String, name: (T) -> String, excluding: Set<String>,
                              excludingNames: Set<String> = ["ビーグル"], query: String) -> [T] {
        func norm(_ s: String) -> String { s.lowercased().filter { !$0.isWhitespace && $0 != "\u{3000}" } }
        let q = norm(query)
        return list.filter { m in
            !excluding.contains(id(m)) && !excludingNames.contains(name(m)) && (q.isEmpty || norm(name(m)).contains(q))
        }
    }
}
