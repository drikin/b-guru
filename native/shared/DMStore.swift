import Foundation
import Observation

// ✉️ 簡易 DM (server: src/lib/dm.ts, /api/agent/dm/**). 1:1 between members, text and up to 4 photos
// (docs/dm-photos-spec.md), gone after 30 days (ttl_hours in capabilities). Off unless capabilities' features.dm.enabled (DM_ENABLED on the server).

extension APIClient {
    func dmList(path: String) async throws -> DMListResponse {
        try await send(request("GET", path))
    }

    func dmThread(path: String, peerId: String) async throws -> DMThreadResponse {
        try await send(request("GET", "\(path)/\(peerId)"))
    }

    func dmSend(path: String, peerId: String, body: String, clientId: String, images: [String] = []) async throws -> DMMessage {
        struct R: Decodable { var message: DMMessage }
        var json: [String: Any] = ["body": body, "client_id": clientId]
        if !images.isEmpty { json["images"] = images }
        let r: R = try await send(request("POST", "\(path)/\(peerId)", json: json))
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
    /// `group` / `groupMembers` / `newGroup`: 👥 グループ DM (GroupDMStore.swift), only while `groups.enabled`.
    typealias Route = DMRoute

    private(set) var enabled = false
    private(set) var canSend = false
    private(set) var maxBody = 1000
    /// 📷 Photos may be attached (features.dm.max_images > 0; old servers say nothing → off). Groups too.
    private(set) var canSendImages = false
    private(set) var maxImages = 4
    /// Where the photos go first (features.dm.upload_path).
    private(set) var uploadPath = "/api/agent/dm/upload"
    /// Photos of messages still being sent, by clientId (previews for the bubble; kept for a retry).
    private(set) var outgoingPhotos: [String: OutgoingPhotos] = [:]
    private(set) var conversations: [DMConversation] = []
    /// All my unread DMs (the badge).
    private(set) var unreadCount = 0
    /// 👥 グループ DM: the groups in the same list and screens.
    let groups: GroupDMStore
    /// The ✉️ badge: 1:1 and groups together.
    var totalUnread: Int { unreadCount + (groups.enabled ? groups.unreadCount : 0) }
    /// What is open (nil = closed). iPhone: a sheet; Mac: over the chat.
    var route: Route? {
        didSet {
            if case let .thread(p) = route, oldValue != route {
                Task { await load(p) }
                if appVisible { onShowing?(p.userId) }
            }
            if route == .list, oldValue != .list { Task { await reload(); await groups.reload() } }
            if route == nil { thread = [] ; error = nil }
            switch route {
            case let .group(id): groups.show(id, thread: true)
            case let .groupMembers(id): groups.show(id, thread: false)
            default: if groups.openId != nil { groups.hide() }
            }
        }
    }
    /// The open conversation's messages (oldest first).
    private(set) var thread: [DMMessage] = []
    private(set) var peerCanReceive = true
    private(set) var loading = false
    var error: String?
    /// The app is in front (iPhone: active scene; Mac: panel on screen) — read marks only then.
    var appVisible = true {
        didSet {
            groups.appVisible = appVisible
            if appVisible, !oldValue {
                markSeen()
                if let p = openPeer { onShowing?(p.userId) }
            }
        }
    }
    /// That person's conversation came on screen (the iPhone removes its notification).
    @ObservationIgnored var onShowing: ((String) -> Void)?
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
        self.groups = GroupDMStore(api: api)
        groups.dmPeers = { [weak self] in
            (self?.conversations ?? []).map { MentionMember(userId: $0.peer.userId, name: $0.peer.displayName, avatar: $0.peer.avatar) }
        }
        groups.onOpenRemoved = { [weak self] in
            guard let self else { return }
            switch self.route {
            case .group, .groupMembers: self.route = .list
            default: break
            }
        }
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
        maxImages = min(f?.maxImages ?? 0, 4)
        canSendImages = canSend && maxImages > 0
        if let p = f?.uploadPath, p.hasPrefix("/api/") { uploadPath = p }
        if let h = f?.ttlHours, h > 0 { DMLogic.ttl = TimeInterval(h) * 3600 }
        if let p = f?.path, p.hasPrefix("/api/") { path = p }
        groups.configure(caps?.features?.gdm, dmOn: on)
        groups.configurePhotos(on: canSendImages, max: maxImages, uploadPath: uploadPath)
        if !on { route = nil; conversations = []; unreadCount = 0 }
        if on, !wasOn {
            Task { await reload() }
            startPruning()
        }
    }

    /// Bumped by every open from outside the DM screens (a name in the chat, a notification, ✉️):
    /// the app then brings the ✉️ tab forward (iPhone's page, iPad's left column, the Mac's tab).
    private(set) var openRequest = 0

    func openList() { route = .list; openRequest += 1 }
    func open(_ peer: DMPeer) { route = .thread(peer); openRequest += 1 }
    /// A group (from the list or a notification; before capabilities are in, the server says whether it may).
    func openGroup(_ id: Int) { route = .group(id); openRequest += 1 }
    /// Back to the list from inside the DM screens (does not ask for the tab).
    func showList() { route = .list }
    func close() { route = nil }
    /// One step back: a conversation → the list → closed (the Mac's ←, drikin 2026-10-24); a group's members → the group.
    func back() {
        switch route {
        case nil, .list?: route = nil
        case let .groupMembers(id)?: route = .group(id)
        default: route = .list
        }
    }

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

    /// Optimistic: the bubble shows at once (with the photos' previews); photos are made small and uploaded first.
    func send(_ text: String, photos: OutgoingPhotos? = nil) {
        guard canSend, let peer = openPeer else { return }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let photos = canSendImages ? photos : nil
        guard !body.isEmpty || photos != nil, body.count <= maxBody else { return }
        tempSeq += 1
        let temp = DMMessage(id: -tempSeq, fromId: "", toId: peer.userId, peerId: peer.userId, body: body,
                             createdAt: ISO8601DateFormatter().string(from: Date()), isAuthor: true,
                             clientId: UUID().uuidString, pending: true)
        if let photos, let cid = temp.clientId { outgoingPhotos[cid] = photos }
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
        if let cid = m.clientId { outgoingPhotos[cid] = nil }
    }

    private func deliver(_ temp: DMMessage, to peer: DMPeer) {
        Task {
            let photos = temp.clientId.flatMap { outgoingPhotos[$0] }
            if demo {
                try? await Task.sleep(for: .milliseconds(250))
                var stored = temp
                stored.id = 10_000 + tempSeq
                stored.pending = false
                #if DEBUG
                stored.images = photos.map(OutgoingPhotos.debugCachedPaths) ?? []
                #endif
                applyCreate(stored, peer: peer, unread: nil)
                if let cid = temp.clientId { outgoingPhotos[cid] = nil }
                return
            }
            do {
                let urls = try await photos?.uploaded(api: api, path: uploadPath) ?? []
                let m = try await api.dmSend(path: path, peerId: peer.userId, body: temp.body, clientId: temp.clientId ?? "", images: urls)
                applyCreate(m, peer: peer, unread: nil)
                if let cid = temp.clientId { outgoingPhotos[cid] = nil }
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
        groups.applyReady()
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
        canSendImages = true
        maxImages = 4
        groups.configurePhotos(on: true, max: 4, uploadPath: uploadPath)
        func at(_ minutesAgo: Double) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(-minutesAgo * 60)) }
        func m(_ id: Int, _ peer: String, _ body: String, mine: Bool, _ ago: Double) -> DMMessage {
            DMMessage(id: id, fromId: mine ? "me" : peer, toId: mine ? peer : "me", peerId: peer, body: body,
                      createdAt: at(ago), isAuthor: mine, clientId: nil)
        }
        demoThreads = [
            "mazzo": [m(1, "mazzo", "さっきの将棋、いい勝負でしたね", mine: false, 95),
                      m(2, "mazzo", "ありがとうございます！ 次は負けません", mine: true, 90),
                      m(5, "mazzo", "今夜の配信、見に行きます", mine: false, 6),
                      m(6, "mazzo", "1 か月で消えるのはいいですね", mine: false, 5)],
            "takuto": [m(3, "takuto", "レンズの件、あとで写真送りますね", mine: false, 300),
                       m(4, "takuto", "了解です！", mine: true, 290),
                       {
                           var p = m(8, "takuto", "左が古いほう、右が新しいほうです", mine: false, 281)
                           p.images = [TimelineDemoMedia.picture("dm-lens-2", 960, 1280, hue: 0.6), TimelineDemoMedia.picture("dm-lens-3", 1280, 720, hue: 0.85),
                                       TimelineDemoMedia.picture("dm-lens-4", 1280, 1280, hue: 0.15)]
                           return p
                       }(),
                       {
                           // 📷 写真だけ（本文なし）: 一覧は「📷 写真」
                           var p = m(9, "takuto", "", mine: false, 280)
                           p.images = [TimelineDemoMedia.picture("dm-lens-1", 1280, 960, hue: 0.33)]
                           return p
                       }()],
            "coban": [m(7, "coban", "昨日はありがとうございました", mine: true, 600)],
            // more than 30 days ago: hidden
            "りとる": [m(0, "りとる", "これは 31 日前（見えない）", mine: false, 31 * 24 * 60)],
        ]
        conversations = ["mazzo", "takuto", "coban", "りとる"].compactMap { id in
            guard let last = DMLogic.pruned(demoThreads[id] ?? []).last else { return nil }
            return DMConversation(peer: DMPeer(userId: id, name: id, avatar: nil), lastMessage: last,
                                  unreadCount: id == "mazzo" ? 2 : 0)
        }
        unreadCount = 2
        if !ProcessInfo.processInfo.arguments.contains("-demoGDMOff") { groups.debugLoadDemo() }
        // A screen opened by the arguments below: the ✉️ tab comes forward (as DMStore.open does).
        defer { if route != nil { openRequest += 1 } }
        // -demoDMGroup / -demoDMGroupMembers / -demoDMNewGroup: 👥 the first group, its members, a new group (screenshots).
        if ProcessInfo.processInfo.arguments.contains("-demoDMGroup") { route = .group(1); return }
        if ProcessInfo.processInfo.arguments.contains("-demoDMGroupMembers") { route = .groupMembers(1); return }
        if ProcessInfo.processInfo.arguments.contains("-demoDMNewGroup") { route = .newGroup; return }
        // -demoDM: open the list at once; -demoDMThread: mazzo's conversation (screenshots).
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-demoDMThread") { route = .thread(DMPeer(userId: "mazzo", name: "mazzo", avatar: nil)) }
        // -demoDMPhotos: takuto's conversation (📷 photos in bubbles).
        else if args.contains("-demoDMPhotos") { route = .thread(DMPeer(userId: "takuto", name: "takuto", avatar: nil)) }
        else if args.contains("-demoDM") { route = .list }
    }
    #endif
}
