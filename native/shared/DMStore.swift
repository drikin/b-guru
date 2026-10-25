import Foundation
import Observation

// ✉️ 簡易 DM (server: src/lib/dm.ts, /api/agent/dm/**). 1:1 between members, text only,
// gone after 24 h. Off unless capabilities' features.dm.enabled (DM_ENABLED on the server).

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
    var createdAt: String
    var isAuthor: Bool
    var clientId: String?
    /// Local only: on its way (negative id) / could not be sent.
    var pending = false
    var failed = false

    enum CodingKeys: String, CodingKey { case id, fromId, toId, peerId, body, createdAt, isAuthor, clientId }
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
    static let ttl: TimeInterval = 24 * 60 * 60

    nonisolated(unsafe) private static let isoFrac: ISO8601DateFormatter = { // read-only after setup (thread-safe for parsing)
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let iso = ISO8601DateFormatter()

    static func date(_ s: String) -> Date? { isoFrac.date(from: s) ?? iso.date(from: s) }

    /// Gone after 24 h (messages still being sent stay).
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

extension APIClient {
    func dmList(path: String) async throws -> DMListResponse {
        try await send(request("GET", path))
    }

    func dmThread(path: String, peerId: String) async throws -> DMThreadResponse {
        try await send(request("GET", "\(path)/\(peerId)"))
    }

    func dmSend(path: String, peerId: String, body: String, clientId: String) async throws -> DMMessage {
        struct R: Decodable { var message: DMMessage }
        let r: R = try await send(request("POST", "\(path)/\(peerId)", json: ["body": body, "client_id": clientId]))
        return r.message
    }

    func dmRead(path: String, peerId: String, upTo id: Int) async throws -> Int {
        struct R: Decodable { var unreadCount: Int }
        let r: R = try await send(request("POST", "\(path)/\(peerId)/read", json: ["last_read_id": id]))
        return r.unreadCount
    }
}

@MainActor
@Observable
final class DMStore {
    enum Route: Equatable { case list, thread(DMPeer) }

    private(set) var enabled = false
    private(set) var canSend = false
    private(set) var maxBody = 1000
    private(set) var conversations: [DMConversation] = []
    /// All my unread DMs (the badge).
    private(set) var unreadCount = 0
    /// What is open (nil = closed). iPhone: a sheet; Mac: over the chat.
    var route: Route? {
        didSet {
            if case let .thread(p) = route, oldValue != route { Task { await load(p) } }
            if route == .list, oldValue != .list { Task { await reload() } }
            if route == nil { thread = [] ; error = nil }
        }
    }
    /// The open conversation's messages (oldest first).
    private(set) var thread: [DMMessage] = []
    private(set) var peerCanReceive = true
    private(set) var loading = false
    var error: String?
    /// The app is in front (iPhone: active scene; Mac: panel on screen) — read marks only then.
    var appVisible = true {
        didSet { if appVisible, !oldValue { markSeen() } }
    }
    /// A DM from someone arrived and is not on screen (the Mac posts a notification).
    @ObservationIgnored var onIncoming: ((DMMessage, DMPeer) -> Void)?

    private let api: APIClient
    private var path = "/api/agent/dm"
    private var demo = false
    private var tempSeq = 0
    private var readTask: Task<Void, Never>?
    private var pruneTask: Task<Void, Never>?

    init(api: APIClient) {
        self.api = api
    }

    var openPeer: DMPeer? {
        if case let .thread(p) = route { return p }
        return nil
    }

    /// That person's conversation is on screen now (its notification would only repeat it).
    func isShowing(peerId: String) -> Bool { appVisible && openPeer?.userId == peerId }

    func configure(_ caps: Capabilities?) {
        let f = caps?.features?.dm
        let on = f?.enabled ?? false
        let wasOn = enabled
        enabled = on
        canSend = on && (f?.send ?? false)
        maxBody = f?.maxBody ?? 1000
        if let p = f?.path, p.hasPrefix("/api/") { path = p }
        if !on { route = nil; conversations = []; unreadCount = 0 }
        if on, !wasOn {
            Task { await reload() }
            startPruning()
        }
    }

    func openList() { route = .list }
    func open(_ peer: DMPeer) { route = .thread(peer) }
    func close() { route = nil }
    /// One step back: a conversation → the list → closed (the Mac's ←, drikin 2026-10-24).
    func back() { route = route == .list ? nil : (route == nil ? nil : .list) }

    func reload() async {
        guard enabled, !demo else { return }
        if let r = try? await api.dmList(path: path) {
            conversations = r.conversations.filter { DMLogic.date($0.lastMessage.createdAt).map { Date().timeIntervalSince($0) < DMLogic.ttl } ?? true }
            unreadCount = r.unreadCount
        }
    }

    private func load(_ peer: DMPeer) async {
        error = nil
        if demo {
            thread = DMLogic.pruned(demoThreads[peer.userId] ?? [])
            peerCanReceive = true
            markSeen()
            return
        }
        loading = true
        thread = []
        defer { loading = false }
        do {
            let r = try await api.dmThread(path: path, peerId: peer.userId)
            guard openPeer?.userId == peer.userId else { return }
            thread = DMLogic.pruned(r.messages)
            peerCanReceive = r.canSend ?? true
            if peer.name == nil || peer.avatar == nil { route = .thread(r.peer) }
            markSeen()
        } catch let APIError.http(_, _, message) {
            error = message ?? "読み込めませんでした"
        } catch {
            self.error = "読み込めませんでした"
        }
    }

    /// The open conversation is read to its end (the badge at once, the server a moment later).
    private func markSeen() {
        guard appVisible, let peer = openPeer else { return }
        if let c = conversations.first(where: { $0.peer.userId == peer.userId }), c.unreadCount > 0 {
            unreadCount = max(0, unreadCount - c.unreadCount)
            conversations = conversations.map { $0.peer.userId == peer.userId ? DMConversation(peer: $0.peer, lastMessage: $0.lastMessage, unreadCount: 0) : $0 }
        }
        guard !demo, let last = thread.last(where: { $0.id > 0 && !$0.isAuthor }) else { return }
        readTask?.cancel()
        readTask = Task { [api, path] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            if let n = try? await api.dmRead(path: path, peerId: peer.userId, upTo: last.id) { self.unreadCount = n }
        }
    }

    // MARK: Sending

    func send(_ text: String) {
        guard canSend, let peer = openPeer else { return }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty, body.count <= maxBody else { return }
        tempSeq += 1
        let temp = DMMessage(id: -tempSeq, fromId: "", toId: peer.userId, peerId: peer.userId, body: body,
                             createdAt: ISO8601DateFormatter().string(from: Date()), isAuthor: true,
                             clientId: UUID().uuidString, pending: true)
        thread.append(temp)
        error = nil
        deliver(temp, to: peer)
    }

    func retry(_ m: DMMessage) {
        guard let peer = openPeer, let i = thread.firstIndex(where: { $0.clientId == m.clientId && $0.id < 0 }) else { return }
        thread[i].failed = false
        thread[i].pending = true
        deliver(thread[i], to: peer)
    }

    func discard(_ m: DMMessage) {
        thread.removeAll { $0.id < 0 && $0.clientId == m.clientId }
    }

    private func deliver(_ temp: DMMessage, to peer: DMPeer) {
        Task {
            if demo {
                try? await Task.sleep(for: .milliseconds(250))
                var stored = temp
                stored.id = 10_000 + tempSeq
                stored.pending = false
                applyCreate(stored, peer: peer, unread: nil)
                return
            }
            do {
                let m = try await api.dmSend(path: path, peerId: peer.userId, body: temp.body, clientId: temp.clientId ?? "")
                applyCreate(m, peer: peer, unread: nil)
            } catch {
                if let i = thread.firstIndex(where: { $0.clientId == temp.clientId && $0.id < 0 }) {
                    thread[i].pending = false
                    thread[i].failed = true
                }
                if case let APIError.http(_, _, message) = error { self.error = message ?? "送れませんでした" }
                else { self.error = "送れませんでした" }
            }
        }
    }

    // MARK: Stream

    /// `ready`: the server's count after a (re)connect, and anything missed.
    func applyReady(_ data: Data) {
        guard enabled, !demo else { return }
        struct Ready: Decodable { struct D: Decodable { var unreadCount: Int? }; var dm: D? }
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        if let n = (try? dec.decode(Ready.self, from: data))?.dm?.unreadCount { unreadCount = n }
        Task {
            await reload()
            if let p = openPeer { await load(p) }
        }
    }

    /// Stream event "dm": { action: "create", message, peer, unread_count? } / { action: "read", peer_id, last_read_id, unread_count }.
    func apply(_ data: Data) {
        guard enabled else { return }
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        struct Event: Decodable { var action: String; var message: DMMessage?; var peer: DMPeer?; var unreadCount: Int?; var peerId: String? }
        guard let e = try? dec.decode(Event.self, from: data) else { return }
        switch e.action {
        case "create":
            if let m = e.message, let p = e.peer { applyCreate(m, peer: p, unread: e.unreadCount) }
        case "read":
            if let id = e.peerId {
                conversations = conversations.map { $0.peer.userId == id ? DMConversation(peer: $0.peer, lastMessage: $0.lastMessage, unreadCount: 0) : $0 }
            }
            if let n = e.unreadCount { unreadCount = n }
        default:
            break
        }
    }

    private func applyCreate(_ m: DMMessage, peer: DMPeer, unread: Int?) {
        let viewing = isShowing(peerId: peer.userId)
        if openPeer?.userId == peer.userId { thread = DMLogic.reconcile(thread, with: m) }
        let known = conversations.first { $0.peer.userId == peer.userId }?.lastMessage.id == m.id
        conversations = DMLogic.conversations(conversations, after: m, peer: peer, viewing: viewing || known)
        if !m.isAuthor, !known {
            if viewing { markSeen() }
            else {
                unreadCount = unread ?? (unreadCount + 1)
                onIncoming?(m, peer)
            }
        }
    }

    private func startPruning() {
        pruneTask?.cancel()
        pruneTask = Task { [weak self] in
            while !Task.isCancelled {
                // Loose: a message leaving a minute or so late is fine, and lets the
                // system fold this wakeup in with others.
                try? await Task.sleep(for: .seconds(60), tolerance: .seconds(30))
                guard let self else { return }
                let t = DMLogic.pruned(self.thread)
                if t.count != self.thread.count { self.thread = t }
                let now = Date()
                let c = self.conversations.filter { DMLogic.date($0.lastMessage.createdAt).map { now.timeIntervalSince($0) < DMLogic.ttl } ?? true }
                if c.count != self.conversations.count { self.conversations = c }
            }
        }
    }

    // MARK: Demo

    private var demoThreads: [String: [DMMessage]] = [:]

    #if DEBUG
    /// Offline demo: three conversations (one unread), nothing is sent.
    func debugLoadDemo() {
        demo = true
        enabled = true
        canSend = true
        func at(_ minutesAgo: Double) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(-minutesAgo * 60)) }
        func m(_ id: Int, _ peer: String, _ body: String, mine: Bool, _ ago: Double) -> DMMessage {
            DMMessage(id: id, fromId: mine ? "me" : peer, toId: mine ? peer : "me", peerId: peer, body: body,
                      createdAt: at(ago), isAuthor: mine, clientId: nil)
        }
        demoThreads = [
            "mazzo": [m(1, "mazzo", "さっきの将棋、いい勝負でしたね", mine: false, 95),
                      m(2, "mazzo", "ありがとうございます！ 次は負けません", mine: true, 90),
                      m(5, "mazzo", "今夜の配信、見に行きます", mine: false, 6),
                      m(6, "mazzo", "24 時間で消えるのはいいですね", mine: false, 5)],
            "takuto": [m(3, "takuto", "レンズの件、あとで写真送りますね（DM は文字だけでした）", mine: false, 300),
                       m(4, "takuto", "了解です！", mine: true, 290)],
            "coban": [m(7, "coban", "昨日はありがとうございました", mine: true, 600)],
            // more than 24 h ago: hidden
            "りとる": [m(0, "りとる", "これは 25 時間前（見えない）", mine: false, 25 * 60)],
        ]
        conversations = ["mazzo", "takuto", "coban", "りとる"].compactMap { id in
            guard let last = DMLogic.pruned(demoThreads[id] ?? []).last else { return nil }
            return DMConversation(peer: DMPeer(userId: id, name: id, avatar: nil), lastMessage: last,
                                  unreadCount: id == "mazzo" ? 2 : 0)
        }
        unreadCount = 2
        // -demoDM: open the list at once; -demoDMThread: mazzo's conversation (screenshots).
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-demoDMThread") { route = .thread(DMPeer(userId: "mazzo", name: "mazzo", avatar: nil)) }
        else if args.contains("-demoDM") { route = .list }
    }
    #endif
}
