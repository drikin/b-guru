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
    /// 🌐 Anyone may read and join it, and it is in everyone's list (2026-11-09; nil = older server = private).
    var isPublic: Bool? = nil
    /// I am in it (false: a public one I only read). nil = older server = I am.
    var isMember: Bool? = nil
    /// 🗄 Archived: read only, in the list's 「アーカイブ」 (public groups only; nil = older server = no).
    var archived: Bool? = nil
    var archivedAt: String? = nil

    var displayTitle: String { title.isEmpty ? "グループ" : title }
    var isPublicDM: Bool { isPublic == true }
    var isArchived: Bool { archived == true }
    /// I am in it (older servers say nothing: I am).
    var joined: Bool { isMember != false }
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
    /// ✏️ Changed after it was sent (docs/dm-chat-parity-spec.md). Missing (older servers) = false / nil.
    var edited = false
    var editedAt: String? = nil
    /// 😀 The chips (never on system lines). Filled when a group is opened; [] in the list and on create.
    var reactions: [Reaction] = []
    /// Local only: on its way (negative id) / could not be sent.
    var pending = false
    var failed = false

    enum CodingKeys: String, CodingKey {
        case id, groupId, kind, fromId, fromName, fromAvatar, body, images, createdAt, isAuthor, isBeagle, clientId, edited, editedAt, reactions
    }

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
        edited = (try? c.decodeIfPresent(Bool.self, forKey: .edited)) ?? false
        editedAt = try? c.decodeIfPresent(String.self, forKey: .editedAt)
        reactions = (try? c.decodeIfPresent([Reaction].self, forKey: .reactions)) ?? []
    }

    /// Sent and stored (not on its way, not failed).
    var isStored: Bool { id > 0 && !pending && !failed }
    /// 😀 May carry reactions: a stored message, not a system line (ビーグル's answers may).
    var canBeReacted: Bool { isStored && !isSystem }
    /// ✏️ May be edited by me: my own stored text (not ビーグル's answer; the server also refuses a question ビーグル answered).
    var canBeEdited: Bool { isStored && isAuthor && !isSystem && isBeagle != true }
}

struct GDMSummary: Codable, Equatable, Sendable, Identifiable {
    var group: GDMGroup
    var lastMessage: GDMMessage?
    var unreadCount: Int
    /// 🌐 Made in the last 72 hours (only on `public_groups`): the 「新しい」 badge.
    var isNew: Bool? = nil
    var id: Int { group.id }
}

struct GDMListResponse: Decodable, Sendable {
    /// Mine: joined and not archived (private and public). Older servers send only this.
    var groups: [GDMSummary]
    /// 🌐 Public groups I have not joined (not archived), newest first.
    var publicGroups: [GDMSummary]? = nil
    /// 🗄 Archived public groups (joined or not), newest archive first.
    var archivedGroups: [GDMSummary]? = nil
    var groupUnreadCount: Int?
}

/// The DM list's three parts of groups: mine (with the 1:1 conversations), 🌐 public ones I have not joined,
/// and 🗄 archived ones (folded).
struct GDMListSections: Equatable, Sendable {
    var mine: [GDMSummary] = []
    var publicGroups: [GDMSummary] = []
    var archived: [GDMSummary] = []
}

/// What takes the composer's place in a group's conversation.
enum GDMComposerMode: Equatable, Sendable {
    /// The composer.
    case write
    /// 🌐 A public group I have not joined: 「参加する」.
    case join
    /// 🗄 「アーカイブされています（読むだけ）」.
    case archived
    /// 「このグループにはまだ送れません」.
    case cannotSend
}

struct GDMThreadResponse: Decodable, Sendable {
    var group: GDMGroup
    var messages: [GDMMessage]
    var unreadCount: Int?
    var lastReadId: Int?
    var canSend: Bool?
}

/// Stream `event: gdm`: create / read / group / removed (docs/group-dm-spec.md §配信), edit / reaction
/// (docs/dm-chat-parity-spec.md).
struct GDMEvent: Decodable, Sendable {
    var action: String
    var groupId: Int?
    var message: GDMMessage?
    /// `reaction`: whose chips, and the chips (mine for the one looking).
    var messageId: Int?
    var reactions: [Reaction]?
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
            var next = s
            next.lastMessage = nil
            return next
        }
    }

    /// A stored message replaces my pending bubble (same client_id) or the same id; else it is added. Id order, pending last.
    static func reconcile(_ list: [GDMMessage], with m: GDMMessage) -> [GDMMessage] {
        let matches: (GDMMessage) -> Bool = { $0.id == m.id || (m.clientId != nil && $0.clientId == m.clientId && $0.id < 0) }
        var next = list.filter { !matches($0) }
        next.append(m)
        return next.sorted { a, b in (a.id < 0 ? Int.max : a.id) < (b.id < 0 ? Int.max : b.id) }
    }

    /// ✏️ An edited message (PATCH's answer or the stream's `edit`): the same id's text, photos and 「編集済み」;
    /// its chips and local flags stay (as the chat does).
    static func applyingEdit(_ list: [GDMMessage], _ m: GDMMessage) -> [GDMMessage] {
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
    static func settingReactions(_ list: [GDMMessage], id: Int, _ reactions: [Reaction]) -> [GDMMessage] {
        list.map { x in
            guard x.id == id else { return x }
            var next = x
            next.reactions = reactions
            return next
        }
    }

    /// The list's last line follows an edit of that group's last message.
    static func summaries(_ list: [GDMSummary], edited m: GDMMessage) -> [GDMSummary] {
        list.map { s in
            guard s.lastMessage?.id == m.id, var last = s.lastMessage else { return s }
            last.body = m.body
            last.images = m.images
            last.edited = m.edited
            last.editedAt = m.editedAt
            return GDMSummary(group: s.group, lastMessage: last, unreadCount: s.unreadCount)
        }
    }

    /// @ メンション: the text names me (`@名前` up to a space, or `@[名前]`) — the chat's yellow
    /// bubble. The server's isMentionedIn (src/lib/chat-mention.ts) rule; case and spaces ignored.
    static func mentions(_ body: String, name: String?) -> Bool {
        guard let name, !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        func norm(_ s: String) -> String { s.lowercased().filter { !$0.isWhitespace && $0 != "\u{3000}" } }
        let want = norm(name)
        let ns = body as NSString
        guard let re = try? NSRegularExpression(pattern: "@\\[([^\\]]+)\\]|@([^\\s@\\[\\]]+)") else { return false }
        for m in re.matches(in: body, range: NSRange(location: 0, length: ns.length)) {
            let r = m.range(at: 1).location != NSNotFound ? m.range(at: 1) : m.range(at: 2)
            if norm(ns.substring(with: r)) == want { return true }
        }
        return false
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

    // MARK: 🌐 Public groups and 🗄 archive (docs/group-dm-spec.md「パブリック DM と アーカイブ」)

    /// It belongs in my own list: joined and not archived (older servers say neither: it does). The web's belongsInMyList.
    static func belongsInMyList(_ g: GDMGroup) -> Bool { g.joined && !g.isArchived }

    /// The mark before a title: 🗄 archived, 🌐 public, else nothing.
    static func kindMark(_ g: GDMGroup) -> String { g.isArchived ? "🗄 " : g.isPublicDM ? "🌐 " : "" }

    /// The list's three parts from GET /gdm (each pruned; no group twice, mine first, then archived).
    static func sections(_ r: GDMListResponse, now: Date = Date()) -> GDMListSections {
        let mine = newestFirst(prunedSummaries(r.groups, now: now).filter { belongsInMyList($0.group) }, at: activity)
        let archived = prunedSummaries(r.archivedGroups ?? [], now: now)
            .filter { s in s.group.isArchived && !mine.contains { $0.id == s.id } }
        let taken = Set(mine.map(\.id) + archived.map(\.id))
        let open = prunedSummaries(r.publicGroups ?? [], now: now)
            .filter { s in !taken.contains(s.id) && !s.group.isArchived && !s.group.joined }
            .map { s in var x = s; x.unreadCount = 0; return x }
        return GDMListSections(mine: mine, publicGroups: open, archived: archived)
    }

    /// A group as the server now says (my change, the stream's `group`, a thread read): in the part it belongs to now.
    /// `leftMine`: it was in my list and no longer belongs there (archived, or I am out) — read the list again.
    static func placing(_ g: GDMGroup, in s: GDMListSections) -> (sections: GDMListSections, leftMine: Bool) {
        var next = s
        let old = (s.mine + s.publicGroups + s.archived).first { $0.id == g.id }
        if belongsInMyList(g) {
            next.publicGroups.removeAll { $0.id == g.id }
            next.archived.removeAll { $0.id == g.id }
            if next.mine.contains(where: { $0.id == g.id }) {
                next.mine = summaries(next.mine, updating: g)
            } else {
                // Joined or un-archived: first, with the last line it had (nothing unread: joining reads to the end).
                next.mine = [GDMSummary(group: g, lastMessage: old?.lastMessage, unreadCount: 0)] + next.mine
            }
            return (next, false)
        }
        let wasMine = s.mine.contains { $0.id == g.id }
        next.mine.removeAll { $0.id == g.id }
        func update(_ list: inout [GDMSummary]) -> Bool {
            guard let i = list.firstIndex(where: { $0.id == g.id }) else { return false }
            list[i].group = g
            return true
        }
        if g.isArchived {
            next.publicGroups.removeAll { $0.id == g.id }
            if !update(&next.archived) {
                next.archived.insert(GDMSummary(group: g, lastMessage: old?.lastMessage, unreadCount: 0), at: 0)
            }
        } else if g.isPublicDM {
            next.archived.removeAll { $0.id == g.id }
            if !update(&next.publicGroups) {
                next.publicGroups.insert(GDMSummary(group: g, lastMessage: old?.lastMessage, unreadCount: 0), at: 0)
            }
        }
        return (next, wasMine)
    }

    /// What the conversation shows instead of (or as) its composer.
    static func composerMode(_ g: GDMGroup?, canSend: Bool, groupCanSend: Bool) -> GDMComposerMode {
        if let g, g.isArchived { return .archived }
        if let g, g.isPublicDM, !g.joined { return canSend ? .join : .cannotSend }
        return canSend && groupCanSend ? .write : .cannotSend
    }

    /// Name, photo, 🐶, adding people: only for a group I am in that is not archived.
    static func canChangeSettings(_ g: GDMGroup?) -> Bool { g.map { $0.joined && !$0.isArchived } ?? true }

    /// 「外す」 someone else: its maker, in a private group only (anyone may join a public one again).
    static func canRemoveOthers(_ g: GDMGroup?) -> Bool { g?.isCreator == true && g?.isPublicDM != true && canChangeSettings(g) }

    /// 「🗄 アーカイブする／アーカイブから戻す」: anyone in a public group.
    static func canArchive(_ g: GDMGroup?) -> Bool { g.map { $0.isPublicDM && $0.joined } ?? false }

    /// The leave confirmation's text.
    static func leaveMessage(isPublic: Bool) -> String {
        isPublic ? "抜けると通知が届かなくなります。パブリック DM なので、いつでもまた参加できます。"
                 : "抜けると、このグループの発言は見られなくなります。"
    }

    /// 「作る」 may be pressed: private needs someone picked; public needs a name (members are optional).
    static func canCreate(isPublic: Bool, name: String, memberCount: Int) -> Bool {
        isPublic ? !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty : memberCount > 0
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
