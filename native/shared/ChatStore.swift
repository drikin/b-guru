import Foundation
import Observation

/// All chat state for the app. Main-actor only; network work hops off and
/// results come back here. Sending is optimistic: the bubble is on screen
/// before the request leaves, and the stored message (POST response or the
/// stream's create event, whichever lands first) replaces it in place by
/// clientId — the same rule as the web (src/lib/chat-optimistic.ts).
@MainActor
@Observable
final class ChatStore {
    enum Connection: Equatable { case connecting, live, offline }

    private(set) var rows: [ChatRow] = []
    private(set) var unreadCount = 0
    /// Unread messages that @mention me (subset of unreadCount).
    private(set) var mentionCount = 0
    /// Set by a notification click: the list scrolls to this message and
    /// briefly highlights it.
    var scrollTarget: Int?
    private(set) var highlightId: Int?
    private(set) var onlineCount = 0
    private(set) var connection: Connection = .connecting
    private(set) var capabilities: Capabilities?
    private(set) var myUserId: String?
    /// Set when the server revoked the token or membership ended.
    private(set) var signedOut = false

    /// True while the panel is on screen; drives read marking and whether a
    /// mention becomes a system notification.
    var isVisible = false {
        didSet {
            if isVisible {
                markReadSoon()
                if !oldValue { onBecameVisible?() }
            }
        }
    }

    var onMention: ((ChatMessage) -> Void)?
    /// A message from someone else arrived while the panel was hidden.
    var onNewMessage: ((ChatMessage) -> Void)?
    var onBecameVisible: (() -> Void)?

    private let api: APIClient
    private var streamTask: Task<Void, Never>?
    private var readTask: Task<Void, Never>?
    private var tempSeq = 0
    private var latestId = 0

    init(api: APIClient) {
        self.api = api
    }

    var token: String { api.token }

    // MARK: - Lifecycle

    func start() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in
            await self?.loadCapabilities()
            await EmojiCatalog.shared.load()
            await self?.runStream()
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
    }

    private func loadCapabilities() async {
        do {
            capabilities = try await api.capabilities()
        } catch APIError.unauthorized {
            signedOut = true
        } catch {
            // Offline at launch: keep going, the stream loop retries.
        }
    }

    /// Reconnect forever with capped backoff. Every (re)connect resyncs the
    /// list from GET /api/agent/chat on the `ready` event, so nothing sent while
    /// we were disconnected is missed.
    private func runStream() async {
        var delay: Double = 1
        while !Task.isCancelled && !signedOut {
            connection = .connecting
            do {
                for try await ev in LiveStream.connect(token: api.token) {
                    delay = 1
                    await handle(ev)
                }
            } catch APIError.unauthorized {
                signedOut = true
                break
            } catch {
                // fall through to backoff
            }
            if Task.isCancelled || signedOut { break }
            connection = .offline
            try? await Task.sleep(for: .seconds(delay))
            delay = min(delay * 2, 30)
        }
    }

    // MARK: - Server events

    private func handle(_ ev: ServerEvent) async {
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        switch ev.event {
        case "ready":
            connection = .live
            await reload()
        case "chat":
            struct ChatEvent: Decodable { var action: String; var message: ChatMessage?; var id: Int? }
            guard let e = try? dec.decode(ChatEvent.self, from: ev.data) else { return }
            switch e.action {
            case "create":
                if let m = e.message { received(m) }
            case "edit":
                if let m = e.message, let i = rows.firstIndex(where: { $0.message.id == m.id }) {
                    var updated = m
                    updated.reactions = rows[i].message.reactions
                    updated.clientId = rows[i].message.clientId
                    rows[i].message = updated
                }
            case "delete":
                if let id = e.id { rows.removeAll { $0.message.id == id } }
            default:
                break
            }
        case "presence":
            struct P: Decodable { var userIds: [String] }
            if let p = try? dec.decode(P.self, from: ev.data) { onlineCount = p.userIds.count }
        case "revoked":
            signedOut = true
        default:
            break // unknown events are ignored (forward compatible)
        }
    }

    private func received(_ m: ChatMessage) {
        latestId = max(latestId, m.id)
        if m.isAuthor { myUserId = m.authorId }
        let alreadyShown = rows.contains { $0.message.id == m.id }
        rows = Self.reconcile(rows, with: m)
        guard !m.isAuthor, !alreadyShown else { return }
        if isVisible {
            markReadSoon()
        } else {
            unreadCount += 1
            if m.mentionsMe {
                mentionCount += 1
                onMention?(m)
            } else {
                onNewMessage?(m)
            }
        }
    }

    func reload() async {
        do {
            let r = try await api.chat()
            latestId = max(latestId, r.latestId)
            unreadCount = isVisible ? 0 : r.unreadCount
            if isVisible { mentionCount = 0 }
            if let mine = r.messages.first(where: { $0.isAuthor }) { myUserId = mine.authorId }
            // Keep rows still sending / failed; reconcile cleans up any that
            // the server list already contains.
            let local = rows.filter { $0.message.id < 0 }
            var next = r.messages.map { m -> ChatRow in
                // Preserve the stable key of messages we sent this session.
                if let existing = rows.first(where: { $0.message.id == m.id }) {
                    var row = ChatRow(m)
                    row.key = existing.key
                    return row
                }
                return ChatRow(m)
            }
            next.append(contentsOf: local)
            rows = next
            if isVisible { markReadSoon() }
            if let s = try? await api.summary() { onlineCount = s.onlineCount }
        } catch APIError.unauthorized {
            signedOut = true
        } catch {
            connection = .offline
        }
    }

    /// Same rule as reconcileChat in src/lib/chat-optimistic.ts: a pending row
    /// is replaced only by the same author's stored message with its clientId.
    static func reconcile(_ rows: [ChatRow], with m: ChatMessage) -> [ChatRow] {
        let isTwin: (ChatRow) -> Bool = { r in
            r.message.id < 0 && m.clientId != nil && r.message.clientId == m.clientId && m.isAuthor
        }
        if rows.contains(where: { $0.message.id == m.id }) {
            var next = rows.filter { !isTwin($0) }
            if let j = next.firstIndex(where: { $0.message.id == m.id }) {
                let reactions = next[j].message.reactions
                next[j].message = m
                next[j].message.reactions = m.reactions ?? reactions
                next[j].state = .sent
            }
            return next
        }
        if let i = rows.firstIndex(where: isTwin) {
            var next = rows
            next[i].message = m
            next[i].state = .sent
            return next
        }
        return rows + [ChatRow(m)]
    }

    // MARK: - Actions

    /// Optimistic send. Returns immediately; the bubble is already visible.
    func send(_ raw: String, restore: @escaping (String) -> Void) {
        let body = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        let clientId = UUID().uuidString
        tempSeq += 1
        let pending = ChatMessage(
            id: -tempSeq, authorId: myUserId, authorName: nil, avatar: nil, body: body,
            createdAt: ISO8601DateFormatter().string(from: Date()), edited: false, editedAt: nil,
            isAuthor: true, mentionsMe: false, clientId: clientId, reactions: []
        )
        rows.append(ChatRow(pending, state: .pending))
        unreadCount = 0
        mentionCount = 0
        post(body: body, clientId: clientId, restore: restore)
    }

    func retry(_ row: ChatRow) {
        guard let cid = row.message.clientId else { return }
        setState(.pending, clientId: cid)
        post(body: row.message.body, clientId: cid, restore: { _ in })
    }

    func discard(_ row: ChatRow) {
        rows.removeAll { $0.message.id < 0 && $0.message.clientId == row.message.clientId }
    }

    private func post(body: String, clientId: String, restore: @escaping (String) -> Void) {
        Task {
            do {
                let m = try await api.post(body: body, clientId: clientId)
                myUserId = m.authorId ?? myUserId
                latestId = max(latestId, m.id)
                rows = Self.reconcile(rows, with: m)
            } catch let e as APIError where e.isPermanent {
                rows.removeAll { $0.message.id < 0 && $0.message.clientId == clientId }
                restore(body)
                if case .unauthorized = e { signedOut = true }
            } catch {
                setState(.failed, clientId: clientId)
            }
        }
    }

    private func setState(_ s: SendState, clientId: String) {
        if let i = rows.firstIndex(where: { $0.message.id < 0 && $0.message.clientId == clientId }) {
            rows[i].state = s
        }
    }

    func edit(_ id: Int, body: String) async -> Bool {
        let text = body.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, let i = rows.firstIndex(where: { $0.message.id == id }) else { return false }
        let old = rows[i].message
        rows[i].message.body = text // optimistic
        rows[i].message.edited = true
        do {
            let m = try await api.edit(id: id, body: text)
            if let j = rows.firstIndex(where: { $0.message.id == id }) {
                rows[j].message.body = m.body
                rows[j].message.edited = m.edited
                rows[j].message.editedAt = m.editedAt
            }
            return true
        } catch {
            if let j = rows.firstIndex(where: { $0.message.id == id }) { rows[j].message = old }
            return false
        }
    }

    /// Optimistic reaction toggle; the server's summary replaces the guess.
    func toggleReaction(_ id: Int, emoji: String) {
        guard id > 0, let i = rows.firstIndex(where: { $0.message.id == id }) else { return }
        let old = rows[i].message.reactions ?? []
        rows[i].message.reactions = Self.toggled(old, emoji: emoji)
        Task {
            do {
                let r = try await api.toggleReaction(id: id, emoji: emoji)
                if let j = rows.firstIndex(where: { $0.message.id == id }) { rows[j].message.reactions = r.reactions }
            } catch {
                if let j = rows.firstIndex(where: { $0.message.id == id }) { rows[j].message.reactions = old }
            }
        }
    }

    #if DEBUG
    func debugAddReactionToLast() {
        guard let i = rows.indices.last else { return }
        rows[i].message.reactions = [Reaction(emoji: "❤️", count: 2, mine: true, reactors: []),
                                     Reaction(emoji: "😂", count: 1, mine: false, reactors: [])]
    }
    #endif

    static func toggled(_ list: [Reaction], emoji: String) -> [Reaction] {
        var next = list
        if let i = next.firstIndex(where: { $0.emoji == emoji }) {
            if next[i].mine {
                next[i].count -= 1
                next[i].mine = false
                if next[i].count <= 0 { next.remove(at: i) }
            } else {
                next[i].count += 1
                next[i].mine = true
            }
        } else {
            next.append(Reaction(emoji: emoji, count: 1, mine: true, reactors: []))
        }
        return next
    }

    var lastOwnMessage: ChatMessage? {
        rows.last(where: { $0.message.isAuthor && $0.message.id > 0 })?.message
    }

    // MARK: - Read state

    /// Jump to a message (from a notification click) and highlight it briefly.
    func reveal(_ id: Int) {
        highlightId = id
        scrollTarget = id
        Task {
            try? await Task.sleep(for: .seconds(1.6))
            if highlightId == id { highlightId = nil }
        }
    }

    private func markReadSoon() {
        unreadCount = 0
        mentionCount = 0
        guard capabilities?.canMarkRead ?? true, latestId > 0 else { return }
        readTask?.cancel()
        let upTo = latestId
        readTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            _ = try? await api.markRead(upTo: upTo)
        }
    }
}
