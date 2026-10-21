import Foundation
import Observation
import SwiftUI

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
    /// A timeline post to quote, waiting for the chat's composer (「チャットに引用」).
    var pendingQuote: String?
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
    /// The first full list has arrived (until then "empty" means "loading").
    private(set) var hasLoaded = false
    /// For @mention autocomplete (loaded once per launch).
    private(set) var members: [MentionMember] = []

    /// Names of people who spoke recently (newest first) — ranked first in autocomplete.
    var recentAuthors: [String] {
        var seen = Set<String>(), out: [String] = []
        for r in rows.reversed() where !r.message.isAuthor {
            if let n = r.message.authorName, !n.isEmpty, seen.insert(n).inserted { out.append(n) }
        }
        return out
    }
    private(set) var myUserId: String?
    /// Set when the server revoked the token or membership ended.
    private(set) var signedOut = false

    /// True while the panel is on screen; drives read marking and whether a
    /// mention becomes a system notification.
    var isVisible = false {
        didSet {
            if isVisible {
                if !oldValue { beginViewing() }
                markReadSoon()
                if !oldValue { onBecameVisible?() }
            }
        }
    }

    /// The first message the member had not read when the chat came on screen
    /// (drawn as a "ここから未読" line). The list opens there instead of jumping to
    /// the bottom. Nothing new: it stays, and the list stays where they were (drikin 2026-10-19).
    private(set) var unreadMarkerId: Int?
    /// Bumped each time the chat comes on screen with something to open at.
    private(set) var openSeq = 0
    /// Last message read here or on another device (the server's cursor).
    private var readCursor: Int?
    /// Came on screen moments ago and found nothing unread yet: the list that the
    /// reconnect brings (coming back from the background) may still have some.
    private var openPendingSince: Date?

    private func beginViewing() {
        openPendingSince = Date() // the old line stays until something new is unread
        findUnreadMarker()
    }

    private func findUnreadMarker() {
        guard let since = openPendingSince else { return }
        guard Date().timeIntervalSince(since) < 15 else { openPendingSince = nil; return }
        guard hasLoaded, let cursor = readCursor else { return }
        guard let first = rows.first(where: { r in
            r.message.id > cursor && r.message.id > 0 && !r.message.isAuthor && !r.message.isNotice
        }) else { return }
        unreadMarkerId = first.message.id
        openPendingSince = nil
        openSeq += 1
    }

    var onMention: ((ChatMessage) -> Void)?
    /// A message from someone else arrived while the panel was hidden.
    var onNewMessage: ((ChatMessage) -> Void)?
    /// A post or comment was created somewhere (the Mac notifies new timeline posts).
    @ObservationIgnored var onPostCreated: (() -> Void)?
    var onBecameVisible: (() -> Void)?

    private let api: APIClient
    private var streamTask: Task<Void, Never>?
    private var readTask: Task<Void, Never>?
    private var tempSeq = 0
    private var latestId = 0

    /// The voice room. Lives as long as the chat, so a call survives switching
    /// tabs or closing the Mac panel.
    let voice: VoiceStore
    /// The club room (8-bit room view + proximity voice), when the server has it on.
    let room: RoomStore
    /// Past backspace.fm episodes and their player (lives as long as the sign-in, so it
    /// plays on with the panel closed / the phone locked).
    let jukebox: JukeboxStore
    /// ☗ 将棋 (docs/shogi-spec.md), when the server has it on for this member.
    let shogi: ShogiStore
    /// 🎮 散財ダッシュ (docs/minigame-spec.md), when the server has it on for this member.
    let minigame: MinigameStore

    init(api: APIClient) {
        self.api = api
        self.voice = VoiceStore(api: api)
        let room = RoomStore(api: api, voice: voice)
        self.room = room
        let shogi = ShogiStore(api: api)
        self.shogi = shogi
        let minigame = MinigameStore(api: api)
        self.minigame = minigame
        // One thing above the chat (テキスト｜ルーム｜☗｜🎮): opening ☗ or 🎮 leaves the club room
        // and closes the other.
        shogi.willOpen = { [weak room, weak minigame] in
            minigame?.close()
            guard let room, room.mode == .room else { return }
            Task { await room.toText() }
        }
        minigame.willOpen = { [weak room, weak shogi] in
            shogi?.close()
            guard let room, room.mode == .room else { return }
            Task { await room.toText() }
        }
        let jukebox = JukeboxStore(api: api)
        self.jukebox = jukebox
        voice.onWillJoin = { [weak jukebox] in jukebox?.pauseForVoice() }
        jukebox.voiceBusy = { [weak voice] in (voice?.phase ?? .idle) != .idle }
    }

    private static let voiceReloginKey = "voiceReloginAsked"

    var token: String { api.token }

    // MARK: - Lifecycle

    func start() {
        guard streamTask == nil else { return }
        streamTask = Task { [weak self] in
            await self?.loadCapabilities()
            await EmojiCatalog.shared.load()
            await self?.loadMembers()
            await self?.runStream()
        }
    }

    func stop() {
        jukebox.shutdown()
        streamTask?.cancel()
        streamTask = nil
        Task { await voice.leave() }
    }

    private func loadMembers() async {
        if let m = try? await api.members() { members = m }
    }

    private func loadCapabilities() async {
        do {
            capabilities = try await api.capabilities()
            voice.configure(with: capabilities)
            room.configure(enabled: capabilities?.roomEnabled ?? false)
            shogi.configure(capabilities?.features?.shogi, enabled: capabilities?.shogiEnabled ?? false)
            minigame.configure(capabilities?.features?.minigame, enabled: capabilities?.minigameEnabled ?? false)
            // Voice is on for me but this token predates the "voice" scope: send the
            // member back to sign in once (a new sign-in gets the scope). Only once per
            // install, so a server that still withholds it cannot loop us.
            if let c = capabilities, c.voiceEnabled, !c.canJoinVoice,
               !UserDefaults.standard.bool(forKey: Self.voiceReloginKey) {
                UserDefaults.standard.set(true, forKey: Self.voiceReloginKey)
                LoginNotice.message = "ボイスルームに対応しました。お手数ですが、一度ログインし直してください。"
                signedOut = true
                return
            }
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
            if voice.enabled { Task { await voice.loadState() } } // resync after a reconnect
            if room.enabled { Task { await room.load() } }
            if shogi.enabled { Task { await shogi.reload() } } // moves missed while away
            await reload()
        case "chat":
            struct ChatEvent: Decodable { var action: String; var message: ChatMessage?; var id: Int?; var reactions: [Reaction]? }
            guard let e = try? dec.decode(ChatEvent.self, from: ev.data) else { return }
            switch e.action {
            case "create":
                if let m = e.message {
                    received(m)
                    if !m.isNotice { room.chatSaid(m.authorId, m.displayBody, photos: !(m.images ?? []).isEmpty) }
                }
            case "edit":
                if let m = e.message, let i = rows.firstIndex(where: { $0.message.id == m.id }) {
                    var updated = m
                    updated.reactions = rows[i].message.reactions
                    updated.clientId = rows[i].message.clientId
                    rows[i].message = updated
                }
            case "delete":
                if let id = e.id { rows.removeAll { $0.message.id == id } }
            case "reactions":
                // Someone (or you, elsewhere) reacted: update the chips at once.
                if let id = e.id, let i = rows.firstIndex(where: { $0.message.id == id }) {
                    rows[i].message.reactions = e.reactions ?? []
                }
            default:
                break
            }
        case "presence":
            struct P: Decodable { var userIds: [String] }
            if let p = try? dec.decode(P.self, from: ev.data) { onlineCount = p.userIds.count }
        case "room":
            room.apply(ev.data)
        case "minigame":
            minigame.apply(ev.data)
        case "shogi":
            shogi.apply(ev.data)
        case "voice":
            if let v = try? dec.decode(VoiceRoomInfo.self, from: ev.data) { voice.apply(v) }
        case "revoked":
            signedOut = true
        case "post":
            onPostCreated?()
        default:
            break // unknown events are ignored (forward compatible)
        }
    }

    private func received(_ m: ChatMessage) {
        latestId = max(latestId, m.id)
        if m.isAuthor { myUserId = m.authorId }
        let alreadyShown = rows.contains { $0.message.id == m.id }
        rows = Self.reconcile(rows, with: m)
        // A quiet note (room comings and goings): in the list, but never unread or notified.
        guard !m.isAuthor, !alreadyShown, !m.isNotice else { return }
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
            if let c = r.lastReadId { readCursor = max(readCursor ?? 0, c) }
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
            hasLoaded = true
            if isVisible {
                findUnreadMarker()
                openPendingSince = nil
                markReadSoon()
            }
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

    /// Photos of messages still being sent, by clientId (previews for the bubble).
    private(set) var outgoingPhotos: [String: OutgoingPhotos] = [:]

    /// Optimistic send. Returns immediately; the bubble is already visible (with the
    /// photos' previews). Photos are made small (long side 1280 px) and uploaded first.
    func send(_ raw: String, photos: OutgoingPhotos? = nil, restore: @escaping (String) -> Void) {
        let body = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty || photos != nil else { return }
        let clientId = UUID().uuidString
        tempSeq += 1
        let pending = ChatMessage(
            id: -tempSeq, authorId: myUserId, authorName: nil, avatar: nil, body: body,
            createdAt: ISO8601DateFormatter().string(from: Date()), edited: false, editedAt: nil,
            isAuthor: true, mentionsMe: false, clientId: clientId, reactions: []
        )
        if let photos { outgoingPhotos[clientId] = photos }
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
        if let cid = row.message.clientId { outgoingPhotos[cid] = nil }
    }

    private func post(body: String, clientId: String, restore: @escaping (String) -> Void) {
        #if DEBUG
        if debugOffline {
            var m = rows.last(where: { $0.message.clientId == clientId })!.message
            m.id = (rows.map(\.message.id).max() ?? 0) + 1
            rows = Self.reconcile(rows, with: m)
            return
        }
        #endif
        Task {
            let photos = outgoingPhotos[clientId]
            do {
                var urls: [String] = []
                if let photos {
                    if let done = photos.urls {
                        urls = done
                    } else {
                        let side = capabilities?.chatImageMaxSide ?? 1280
                        let originals = photos.originals
                        let jpegs = await Task.detached(priority: .userInitiated) {
                            originals.compactMap { PostDraft.uploadJPEG($0, maxSide: side, quality: 0.8) }
                        }.value
                        urls = try await api.upload(images: jpegs, path: "/api/agent/chat/upload")
                        photos.urls = urls
                    }
                }
                let m = try await api.post(body: body, clientId: clientId, images: urls)
                myUserId = m.authorId ?? myUserId
                latestId = max(latestId, m.id)
                rows = Self.reconcile(rows, with: m)
                outgoingPhotos[clientId] = nil
            } catch let e as APIError where e.isPermanent && photos == nil {
                rows.removeAll { $0.message.id < 0 && $0.message.clientId == clientId }
                restore(body)
                if case .unauthorized = e { signedOut = true }
            } catch {
                // With photos the bubble stays (再送 / 取り消す) so the photos are not lost.
                if let e = error as? APIError, case .unauthorized = e { signedOut = true }
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
    /// Demo mode: sends "succeed" locally, no network.
    var debugOffline = false

    /// Sample data for offline UI checks (no network, no token).
    func debugLoadDemo() {
        func msg(_ id: Int, _ who: String, _ body: String, mine: Bool = false) -> ChatRow {
            ChatRow(ChatMessage(id: id, authorId: mine ? "me" : who, authorName: mine ? "ドリキン" : who, avatar: nil,
                                body: body, createdAt: "2026-10-16T08:0\(id % 10):00Z", edited: false, editedAt: nil,
                                isAuthor: mine, mentionsMe: false, clientId: nil, reactions: nil))
        }
        rows = [msg(1, "NORIO TAKAHASHI", "おはようございます"), msg(2, "mazzo", "iPhone 版いい感じ"),
                msg(3, "ドリキン", "ありがとうございます！", mine: true), msg(4, "takuto", "通知も来ました")]
        // BGURU_DEMO_PHOTOS=http://127.0.0.1:8099 adds photo messages (served from this Mac).
        if let base = ProcessInfo.processInfo.environment["BGURU_DEMO_PHOTOS"] {
            var one = msg(5, "mazzo", "📷 写真")
            one.message.images = ["\(base)/photo1.jpg"]
            var three = msg(6, "ドリキン", "スクショです", mine: true)
            three.message.images = ["\(base)/photo2.jpg", "\(base)/photo3.jpg", "\(base)/photo4.jpg"]
            rows += [one, three]
        }
        // BGURU_DEMO_UNREAD=1: a long backlog, read up to #4 (opens at the "ここから未読" line),
        // and one more message arriving 8 s later (the "↓ 新着" button when scrolled up).
        if ProcessInfo.processInfo.environment["BGURU_DEMO_UNREAD"] != nil {
            let who = ["mazzo", "takuto", "coban", "りとる"]
            rows += (10..<50).map { i in msg(i, who[i % who.count], "未読のメッセージ \(i - 9) 件目。ここまでの話の続きです。") }
            readCursor = 4
            Task {
                try? await Task.sleep(for: .seconds(8))
                received(ChatMessage(id: 60, authorId: "coban", authorName: "coban", avatar: nil, body: "あとから届いた新着です",
                                     createdAt: "2026-10-16T09:00:00Z", edited: false, editedAt: nil,
                                     isAuthor: false, mentionsMe: false, clientId: nil, reactions: nil))
            }
        }
        // ☗ 将棋 (on unless -demoShogiOff / BGURU_DEMO_SHOGI=0; =false sends enabled:false):
        // the games' cards in the chat, and sample games (no network).
        let env = ProcessInfo.processInfo.environment
        let shogiSetting = ProcessInfo.processInfo.arguments.contains("-demoShogiOff") ? "0"
            : (ProcessInfo.processInfo.arguments.contains("-demoShogiFalse") ? "false" : (env["BGURU_DEMO_SHOGI"] ?? "1"))
        if shogiSetting == "1" {
            var card = msg(7, "ビーグル", "☗takuto vs ☖coban（🐢ゆっくり）☗takuto の勝ち（投了）・3 手")
            card.message.kind = "shogi"
            card.message.shogiGameId = 102
            var mine = msg(8, "ビーグル", "☗ドリキン vs ☖mazzo 対局中（⚡速い）→ ☗ 将棋で観戦")
            mine.message.kind = "shogi"
            mine.message.shogiGameId = 101
            rows += [card, mine, msg(9, "mazzo", "よろしくお願いします！")]
            shogi.debugLoadDemo()
        }
        members = ["ビーグル", "mazzo", "NORIO TAKAHASHI", "takuto", "coban", "ポンコツ散財王ドリキン", "りとる"]
            .map { MentionMember(userId: $0, name: $0, avatar: nil) }
        latestId = rows.map(\.message.id).max() ?? 0
        hasLoaded = true
        connection = .live
        onlineCount = 12
        let shogiOn = shogiSetting == "1"
        let shogiCaps = shogiSetting == "0" ? ""
            : #","shogi":{"enabled":\#(shogiOn),"path":"/api/agent/shogi","board_url":"/shogi-board/index.html","bridge_version":1,"play":\#(shogiOn)}"#
        // 🎮 (on unless -demoMinigameOff / BGURU_DEMO_MINIGAME=0): answered here, nothing is sent.
        let minigameOn = !ProcessInfo.processInfo.arguments.contains("-demoMinigameOff") && env["BGURU_DEMO_MINIGAME"] != "0"
        if minigameOn { minigame.debugLoadDemo() }
        let minigameCaps = minigameOn ? #","minigame":{"enabled":true,"path":"/api/agent/minigame","game_url":"/minigame/index.html","bridge_version":1,"engine_version":1,"play":true}"# : ""
        let caps = #"{"api_version":1,"scopes":["read","read_state","chat","post"],"features":{"chat":{"send":true,"edit_own":true,"reactions":true,"images":true,"max_images":4},"posts":{"read":true,"publish":true,"upload":true,"reactions":true,"max_images":5},"jukebox":{"enabled":\#(ProcessInfo.processInfo.arguments.contains("-demoJukebox") || ProcessInfo.processInfo.environment["BGURU_DEMO_JUKEBOX"] != nil),"path":"/api/agent/jukebox"}\#(shogiCaps)\#(minigameCaps)}}"#
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        capabilities = try? dec.decode(Capabilities.self, from: Data(caps.utf8))
    }

    /// A message from someone else, as if it came on the stream.
    func debugReceive(_ body: String, id: Int) {
        received(ChatMessage(id: id, authorId: "coban", authorName: "coban", avatar: nil, body: body,
                             createdAt: ISO8601DateFormatter().string(from: Date()), edited: false, editedAt: nil,
                             isAuthor: false, mentionsMe: false, clientId: nil, reactions: nil))
    }

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
        if readCursor != nil { readCursor = max(readCursor ?? 0, latestId) }
        guard capabilities?.canMarkRead ?? true, latestId > 0 else { return }
        readTask?.cancel()
        let upTo = latestId
        readTask = Task {
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            _ = try? await api.markRead(upTo: upTo)
        }
    }

    // MARK: - Quoting a timeline post (drikin 2026-10-20)

    nonisolated static let siteURL = "https://bsm.backspace.fm"

    /// The closure behind 「チャットに引用」 (nil when this member cannot send to the chat):
    /// the quote waits for the composer, `show` brings the chat up.
    func quoteAction(show: @escaping @MainActor () -> Void) -> (@MainActor (Post) -> Void)? {
        guard capabilities?.canSend == true else { return nil }
        return { [weak self] post in
            self?.pendingQuote = ChatStore.quoteText(authorName: post.authorName, text: post.text,
                                                     hasImages: !(post.images ?? []).isEmpty, postId: post.parentId ?? post.id,
                                                     linkTitle: post.urlPreview?.title)
            show()
        }
    }

    /// Shows the chat (set once by the window / page that owns the tabs).
    @ObservationIgnored var showChat: (@MainActor () -> Void)?
    /// 「チャットに引用」 for the environment (nil when this member cannot send).
    var quoteToChat: PostAction? {
        guard capabilities?.canSend == true else { return nil }
        return PostAction(owner: ObjectIdentifier(self), kind: "quote") { [weak self] post in
            self?.pendingQuote = ChatStore.quoteText(authorName: post.authorName, text: post.text,
                                                     hasImages: !(post.images ?? []).isEmpty, postId: post.parentId ?? post.id,
                                                     linkTitle: post.urlPreview?.title)
            self?.showChat?()
        }
    }
    /// 「ネタ帳に送る」 for the environment (nil when this member cannot).
    var sendToNeta: PostAction? {
        guard capabilities?.netaEnabled == true else { return nil }
        return PostAction(owner: ObjectIdentifier(self), kind: "neta") { [weak self] post in self?.netaPost = post }
    }

    /// 「ネタ帳に送る」 (nil when this member cannot): the post to send waits in `netaPost`.
    var netaPost: Post?
    func netaAction() -> (@MainActor (Post) -> Void)? {
        guard capabilities?.netaEnabled == true else { return nil }
        return { [weak self] post in self?.netaPost = post }
    }

    func sendToNeta(url: String, title: String, description: String) async -> NetaOutcome {
        #if DEBUG
        if debugOffline { try? await Task.sleep(for: .milliseconds(400)); return .sent }
        #endif
        return await api.sendToNeta(path: capabilities?.netaPath ?? "/api/agent/neta", url: url, title: title, description: description)
    }

    /// Opens a B-guru post's link in the timeline instead of the browser.
    static func openPostLinks(in timeline: TimelineStore) -> OpenURLAction {
        OpenURLAction { url in
            if let id = ChatStore.postId(in: url) { timeline.openThread = id; return .handled }
            return .systemAction
        }
    }

    /// What 「チャットに引用」 puts into the composer: who, the first line, the link.
    /// No @mention (quoting must not notify). docs: same text on every platform.
    nonisolated static func quoteText(authorName: String?, text: String, hasImages: Bool, postId: Int,
                                      linkTitle: String? = nil) -> String {
        let name = (authorName?.isEmpty == false ? authorName! : "だれか")
        let link = "\(siteURL)/#/post/\(postId)"
        // The first line with words, once pasted URLs are taken out: the quote is about the
        // post, not the article it links to (drikin 2026-10-20). A link-only post: the
        // article's title from its link card.
        var excerpt = text.split(whereSeparator: \.isNewline).map(cleanQuoteLine).first { !$0.isEmpty }
            ?? linkTitle.map(cleanQuoteLine) ?? ""
        if excerpt.count > 40 { excerpt = String(excerpt.prefix(40)) + "…" } // Characters: never half an emoji
        if excerpt.isEmpty && hasImages { excerpt = "写真" }
        if excerpt.isEmpty && text.range(of: #"https?://\S"#, options: .regularExpression) != nil { excerpt = "リンク" }
        let head = excerpt.isEmpty ? "📝 \(name) さんの投稿" : "📝 \(name) さんの投稿「\(excerpt)」"
        return "\(head)\n\(link)\n"
    }

    /// One line as quoted: URLs out, spaces collapsed, ＠ for @ (a mention in the quote
    /// would notify that member again), Markdown marks dropped ("## 見出し", "> ", "- ",
    /// **太字**, `code`).
    nonisolated private static func cleanQuoteLine<S: StringProtocol>(_ raw: S) -> String {
        var l = String(raw).replacingOccurrences(of: #"https?://\S+"#, with: " ", options: .regularExpression)
        l = l.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        l = l.replacingOccurrences(of: "@", with: "＠")
        l = l.replacingOccurrences(of: #"^(#{1,6}|>|[-*+]|\d{1,3}[.)])\s+"#, with: "", options: .regularExpression)
        for mark in ["**", "__", "~~", "`"] { l = l.replacingOccurrences(of: mark, with: "") }
        return l.trimmingCharacters(in: .whitespaces)
    }

    /// The post a B-guru permalink points to (https://bsm.backspace.fm/#/post/123).
    nonisolated static func postId(in url: URL) -> Int? {
        guard url.host == "bsm.backspace.fm", let frag = url.fragment, frag.hasPrefix("/post/") else { return nil }
        return Int(frag.dropFirst("/post/".count).prefix { $0.isNumber })
    }
}
