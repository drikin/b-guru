import Foundation
import Network
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
    /// The stream's `event: sync`: something was read on one of my devices (this one included) — the app
    /// removes the notifications it covers.
    @ObservationIgnored var onReadSync: ((ReadSync) -> Void)?
    /// A note from B-guru (kind "notice" — ☗ highlights, game results, 散財ダッシュ — or a ☗ game card) arrived or
    /// was rewritten while the panel was hidden. Room comings and goings included; the receiver filters. (Mac: menu bar ticker)
    @ObservationIgnored var onAnnouncement: ((ChatMessage) -> Void)?

    private let api: APIClient
    private var streamTask: Task<Void, Never>?
    /// The reconnect wait (cancelled to reconnect at once when the network comes back).
    @ObservationIgnored private var backoffWait: Task<Void, Never>?
    @ObservationIgnored private var pathMonitor: NWPathMonitor?
    /// iOS: the stream is closed a little after the app goes to the background.
    @ObservationIgnored private var backgroundClose: Task<Void, Never>?
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
    /// ✉️ 簡易 DM (DMStore.swift), when the server has it on for this member.
    let dm: DMStore
    /// 📺 YouTube 共同鑑賞 (Watch.swift), when the server has it on for this member.
    let watch: WatchStore
    /// 🍻 オフ会 (Offkai.swift, docs/offkai-spec.md), when the server has it on for this member.
    let offkai: OffkaiStore

    /// 「🔈 読み上げ」 in the chat (docs/offkai-spec.md「チャット欄の読み上げ」): read every new message aloud,
    /// 🍻 or not. This device only, kept here, **off by default**. Off stops the reader at once (🍻's part too;
    /// 🍻 reads again from the next message if it still applies).
    var readAloud: Bool = ChatStore.savedReadAloud {
        didSet {
            UserDefaults.standard.set(readAloud, forKey: Self.readAloudKey)
            if !readAloud { speaker.stop() }
        }
    }
    static let readAloudKey = "chatReadAloud"
    private static var savedReadAloud: Bool { UserDefaults.standard.object(forKey: readAloudKey) as? Bool ?? false }
    /// One reader for the chat's switch and 🍻's (ChatSpeech.swift).
    @ObservationIgnored private let speaker = ChatSpeaker()
    /// iPhone: in the background (the chat's switch reads only while the app is in front; 🍻's goes on).
    @ObservationIgnored private var inBackground = false
    private var chatReadActive: Bool { readAloud && !inBackground }
    /// チャットの上に機能を重ねる形 (ChatOverlay.swift): which features sit over the chat. Only used when
    /// the server has `chat_overlay` on for this member.
    let overlay: OverlayModel
    /// 「スマホで続ける」 (VoiceHandoff.swift; the Mac shows the button).
    let handoff: VoiceHandoff

    init(api: APIClient) {
        self.api = api
        self.dm = DMStore(api: api)
        let watch = WatchStore(api: api)
        self.watch = watch
        self.voice = VoiceStore(api: api)
        let room = RoomStore(api: api, voice: voice)
        self.room = room
        let shogi = ShogiStore(api: api)
        self.shogi = shogi
        let minigame = MinigameStore(api: api)
        self.minigame = minigame
        let offkai = OffkaiStore(api: api)
        self.offkai = offkai
        let overlay = OverlayModel(room: room, shogi: shogi, minigame: minigame, watch: watch, offkai: offkai)
        self.overlay = overlay
        let handoff = VoiceHandoff(api: api)
        self.handoff = handoff
        voice.handoff = handoff
        offkai.handoff = handoff
        // The overlay: several over the chat at once, nobody leaves the room; an open from outside the switch
        // row (a push, a chat card, a link) switches it on and expands it.
        watch.willShow = { [weak overlay] floating in overlay?.watchWillShow(floating: floating) }
        watch.popoutOverride = { [weak overlay] in
            guard let overlay, overlay.enabled else { return false }
            // After the page's tap has finished: moving the web view while it is still handling its own touch
            // left the player black (seen on the iPhone).
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { _ = overlay.watchPopout() }
            return true
        }
        // One thing above the chat (テキスト｜ルーム｜☗｜🎮｜🍻): opening one leaves the club room
        // and closes the others.
        shogi.willOpen = { [weak room, weak minigame, weak offkai, weak overlay] in
            if let overlay, overlay.enabled { overlay.storeWillOpen(.shogi); return }
            minigame?.close()
            offkai?.close()
            guard let room, room.mode == .room else { return }
            Task { await room.toText() }
        }
        minigame.willOpen = { [weak room, weak shogi, weak offkai, weak overlay] in
            if let overlay, overlay.enabled { overlay.storeWillOpen(.game); return }
            shogi?.close()
            offkai?.close()
            guard let room, room.mode == .room else { return }
            Task { await room.toText() }
        }
        offkai.willOpen = { [weak room, weak shogi, weak minigame, weak overlay] in
            if let overlay, overlay.enabled { overlay.storeWillOpen(.offkai); return }
            shogi?.close()
            minigame?.close()
            guard let room, room.mode == .room else { return }
            Task { await room.toText() }
        }
        let jukebox = JukeboxStore(api: api)
        self.jukebox = jukebox
        // Two rooms never sound at once: listening to 🍻 leaves the voice room (and the club room's
        // voice), joining the voice room stops 🍻. The jukebox pauses for either.
        voice.onWillJoin = { [weak jukebox, weak offkai] in
            jukebox?.pauseForVoice()
            if let offkai, offkai.audio != .off { Task { await offkai.stopAudio(release: true) } }
        }
        offkai.willListen = { [weak jukebox, weak voice, weak room] in
            jukebox?.pauseForVoice()
            if let room, room.mode == .room { await room.toText() }
            if let voice, voice.inRoom { await voice.leave() }
        }
        jukebox.voiceBusy = { [weak voice, weak offkai] in (voice?.phase ?? .idle) != .idle || (offkai?.audio ?? .off) != .off }
        offkai.myUserId = { [weak self] in self?.myUserId ?? self?.voice.myUserId }
        speaker.nicknamer = { name in await ChatNickname.ask(name) } // 賢い読み方: long names, on this device only
        offkai.readingEnded = { [weak self] in
            guard let self, !self.chatReadActive else { return }
            self.speaker.stop()
        }
    }

    private static let voiceReloginKey = "voiceReloginAsked"

    var token: String { api.token }

    // MARK: - Lifecycle

    func start() {
        guard streamTask == nil else { return }
        watchNetwork()
        // A return from the background only reconnects: these are loaded once (again only
        // when the first try failed).
        let first = capabilities == nil, noMembers = members.isEmpty
        streamTask = Task { [weak self] in
            if first { await self?.loadCapabilities() }
            await EmojiCatalog.shared.load()
            if noMembers { await self?.loadMembers() }
            await self?.runStream()
        }
    }

    func stop() {
        jukebox.shutdown()
        backgroundClose?.cancel()
        streamTask?.cancel()
        streamTask = nil
        pathMonitor?.cancel()
        pathMonitor = nil
        Task { await voice.leave() }
        Task { await offkai.stopAudio(release: false) }
        speaker.stop()
    }

    #if os(iOS)
    /// iOS scene phase. In the background the app lives on only while audio plays (the
    /// jukebox, a voice room); an open stream then wakes the cellular radio every 25 s
    /// for events nobody sees, and pushes already cover notifications. So it closes
    /// after a short grace (a glance at another app comes back to a live stream), except
    /// in a voice room — the room's proximity volumes come over the stream. Back in
    /// front it reconnects at once; the rows stay on screen and `ready` resyncs them.
    func scenePhaseChanged(background: Bool) {
        backgroundClose?.cancel()
        backgroundClose = nil
        inBackground = background
        if background, !offkai.readsChat { speaker.stop() } // the chat's switch reads only in front
        if background {
            backgroundClose = Task { [weak self] in
                try? await Task.sleep(for: .seconds(30))
                guard let self, !Task.isCancelled, self.voice.phase == .idle, self.offkai.audio == .off else { return }
                self.streamTask?.cancel()
                self.streamTask = nil
                self.connection = .connecting
            }
        } else if !signedOut {
            start()
        }
    }
    #endif

    /// A returning network skips the reconnect wait.
    private func watchNetwork() {
        guard pathMonitor == nil else { return }
        let m = NWPathMonitor()
        m.pathUpdateHandler = { [weak self] path in
            guard path.status == .satisfied else { return }
            Task { @MainActor in self?.backoffWait?.cancel() }
        }
        m.start(queue: .global(qos: .utility))
        pathMonitor = m
    }

    private func loadMembers() async {
        if let m = try? await api.members() { members = m; MemberDirectory.shared.set(m) }
    }

    private func loadCapabilities() async {
        do {
            capabilities = try await api.capabilities()
            // Before the features: an open they make while configuring (a push tapped at launch) is then
            // already an overlay open (switched on and expanded).
            overlay.enabled = capabilities?.chatOverlayEnabled ?? false
            voice.configure(with: capabilities)
            room.configure(enabled: capabilities?.roomEnabled ?? false)
            shogi.configure(capabilities?.features?.shogi, enabled: capabilities?.shogiEnabled ?? false)
            minigame.configure(capabilities?.features?.minigame, enabled: capabilities?.minigameEnabled ?? false)
            watch.configure(capabilities?.features?.watch, enabled: capabilities?.watchEnabled ?? false)
            offkai.configure(capabilities?.features?.offkai, enabled: capabilities?.offkaiEnabled ?? false)
            dm.configure(capabilities)
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
    /// we were disconnected is missed. The backoff starts over only after a connection
    /// that held 10 s (a server that accepts and drops at once would otherwise be redialled —
    /// and resynced — every second), and a returning network skips the wait.
    private func runStream() async {
        var delay: Double = 1
        while !Task.isCancelled && !signedOut {
            connection = .connecting
            let openedAt = Date()
            do {
                for try await ev in LiveStream.connect(token: api.token) {
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
            if Date().timeIntervalSince(openedAt) > 10 { delay = 1 }
            let wait = Task { _ = try? await Task.sleep(for: .seconds(delay * Double.random(in: 0.8...1.2))) }
            backoffWait = wait
            await withTaskCancellationHandler { await wait.value } onCancel: { wait.cancel() }
            backoffWait = nil
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
            if watch.enabled { Task { await watch.reload() } } // where the shared video is now
            if offkai.enabled { Task { await offkai.reload() } } // who speaks now, photos missed while away
            dm.applyReady(ev.data)
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
                    if (m.isNotice || m.kind == "shogi"), !isVisible, rows[i].message.body != m.body { onAnnouncement?(m) }
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
        case "watch":
            watch.apply(ev.data)
        case "offkai":
            offkai.apply(ev.data)
        case "shogi":
            shogi.apply(ev.data)
        case "shogi_commentary":
            shogi.applyCommentary(ev.data)
        case "dm":
            dm.apply(ev.data)
        case "sync":
            // 既読で知らせを消す: read on some device of mine (ReadSync.swift).
            if let sync = ReadSync(json: ev.data) {
                if sync.scope == .chat { readElsewhere(upTo: sync.upTo) }
                onReadSync?(sync)
            }
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
        if m.isBeagleAI, let q = beagleWaitingFor, m.replyToId == q { beagleWaitingFor = nil; beagleThinking = false }
        rows = Self.reconcile(rows, with: m)
        if (m.isNotice || m.kind == "shogi"), !isVisible, !alreadyShown { onAnnouncement?(m) }
        // A quiet note (room comings and goings): in the list, but never unread or notified.
        // 🐶 Beagle's on-device answers are not unread (the server does not count them either).
        guard !m.isAuthor, !alreadyShown, !m.isNotice, !m.isBeagleAI else { return }
        // チャットの読み上げ (🍻 or the chat's own switch; once either way): members' own words only (no cards).
        if m.kind == nil || m.kind == "", chatReadActive || offkai.readsChat {
            speaker.enqueue(.init(authorId: m.authorId, name: m.authorName, body: m.body, hasPhotos: !(m.images ?? []).isEmpty))
        }
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
            // Read on another device: the mentions counted here are read too (the "@" stayed on the beagle).
            mentionCount = isVisible ? 0 : min(mentionCount, unreadCount)
            if let mine = r.messages.first(where: { $0.isAuthor }) { myUserId = mine.authorId }
            // Keep rows still sending / failed; reconcile cleans up any that
            // the server list already contains.
            let local = rows.filter { $0.message.id < 0 }
            let keys = Dictionary(rows.map { ($0.message.id, $0.key) }, uniquingKeysWith: { a, _ in a })
            var next = r.messages.map { m -> ChatRow in
                // Preserve the stable key of messages we sent this session.
                if let key = keys[m.id] {
                    var row = ChatRow(m)
                    row.key = key
                    return row
                }
                return ChatRow(m)
            }
            next.append(contentsOf: local)
            if next != rows { rows = next } // a resync that changed nothing re-renders nothing
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
            askBeagleIfCalled(m)
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
                askBeagleIfCalled(m)
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

    /// The timeline's posts as loaded on this device (set by the app: the timeline is another store),
    /// Beagle's knowledge with the chat.
    @ObservationIgnored var beagleTimeline: (@MainActor () -> [BeagleOnDevice.Note])?

    /// 🐶 Beagle is writing an answer on this device (shown under the chat).
    private(set) var beagleThinking = false

    /// The chat's 🐶 button and answers: the server takes them and this device has Apple Intelligence.
    var canAskBeagle: Bool { onDeviceBeagle || serverBeagle }
    /// This device writes Beagle's answer itself (Apple Intelligence, and the server takes them).
    private var onDeviceBeagle: Bool { (capabilities?.beagleOnDevice ?? false) && BeagleOnDevice.isAvailable }
    /// The server's Beagle (さくらの AI Engine) answers when asked (POST beagle/ask).
    private var serverBeagle: Bool { capabilities?.beagleServer ?? false }
    /// The question waiting for the server's answer (the 考え中 line stays until it comes).
    @ObservationIgnored private var beagleWaitingFor: Int?

    /// My message just went out and calls @ビーグル: write the answer here and post it for everyone.
    private func askBeagleIfCalled(_ m: ChatMessage) {
        guard m.id > 0, canAskBeagle, BeagleOnDevice.asksBeagle(m.body) else { return }
        // Small talk on this device (instant, private); everything else to the server's Beagle — much
        // smarter (drikin 2026-10-24「流石にバカすぎるのでさくらの AI engine も使う」, 併用).
        if serverBeagle, !(onDeviceBeagle && BeagleOnDevice.isSmallTalk(m.body)) {
            beagleThinking = true
            beagleWaitingFor = m.id
            Task {
                #if DEBUG
                if debugOffline { beagleThinking = false; return }
                #endif
                do {
                    try await api.askBeagle(questionId: m.id)
                } catch {
                    beagleThinking = false
                    return
                }
                // The answer comes on the stream; stop waiting after a while either way.
                try? await Task.sleep(for: .seconds(45))
                if beagleWaitingFor == m.id { beagleWaitingFor = nil; beagleThinking = false }
            }
            return
        }
        guard onDeviceBeagle else { return }
        // Not Beagle's own earlier answers (it read them back and repeated them in every answer —
        // 「18Pro を使っているみたい」), not notices, not other @ビーグル questions.
        let chat = rows.filter { !$0.message.isNotice && !$0.message.isShogiCard && !$0.message.isBeagleAI && $0.message.id != m.id
            && !$0.message.body.isEmpty && !BeagleOnDevice.asksBeagle($0.message.body) }
            .map { BeagleOnDevice.Note(name: $0.message.authorName ?? "?", text: $0.message.body) }
        let posts = beagleTimeline?() ?? []
        let asker = rows.last(where: { $0.message.id == m.id })?.message.authorName ?? "会員"
        beagleThinking = true
        Task {
            defer { beagleThinking = false }
            guard let answer = await BeagleOnDevice.answer(question: m.body, asker: asker, chat: chat, posts: posts) else { return }
            #if DEBUG
            if debugOffline {
                received(ChatMessage(id: m.id + 1, authorId: "beagle", authorName: "ビーグル（\(asker)さんの端末）", avatar: nil, body: answer,
                                     createdAt: ISO8601DateFormatter().string(from: Date()), edited: false, editedAt: nil,
                                     isAuthor: false, mentionsMe: false, clientId: nil, reactions: nil, kind: "beagle_ai"))
                return
            }
            #endif
            if let posted = try? await api.postBeagleAnswer(questionId: m.id, body: answer, app: Self.appVersion) {
                received(posted)
            }
        }
    }

    private static var appVersion: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
        #if os(macOS)
        return "Mac \(v)"
        #else
        return "iOS \(v)"
        #endif
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
        // BGURU_DEMO_CHAT_STRESS=1: a long backlog of mixed lengths, then for two minutes a message
        // every 2 s (some long), a reaction on the last one every 5 s — the iPhone's chat went blank now
        // and then and came back on scrolling (drikin 2026-10-24); this is what reproduces it.
        if ProcessInfo.processInfo.environment["BGURU_DEMO_CHAT_STRESS"] != nil {
            let who = ["mazzo", "takuto", "coban", "りとる", "NORIO TAKAHASHI"]
            let bodies = ["了解です", "それな", "今日の配信おもしろかった！ あのカメラの話、もう少し詳しく聞きたいです。",
                          "長めの話: レンズを替えてから撮るものが変わってきて、週末はずっと外にいます。重さは気になるけど、それ以上に楽しい。",
                          "👍", "そういえば昨日のあれ、どうなりました？"]
            // With BGURU_DEMO_PHOTOS (a slow local server): every fifth message has a photo that arrives late.
            let photoBase = ProcessInfo.processInfo.environment["BGURU_DEMO_PHOTOS"]
            func photo(_ i: Int) -> [String]? { photoBase.flatMap { i % 5 == 0 ? ["\($0)/photo\(i % 4 + 1).jpg?\(i)"] : nil } }
            rows += (100..<220).map { i in
                var r = msg(i, who[i % who.count], bodies[i % bodies.count] + (i % 7 == 0 ? "\n2 行目\n3 行目" : ""))
                r.message.images = photo(i)
                return r
            }
            Task {
                for k in 0..<60 {
                    try? await Task.sleep(for: .seconds(2))
                    debugReceive(bodies[(k * 5) % bodies.count] + " (\(k))", id: 1000 + k, author: who[k % who.count], images: photo(k))
                    if k % 3 == 2 { debugAddReactionToLast() }
                }
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
        MemberDirectory.shared.set(members)
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
        // ✉️ 簡易 DM (on unless -demoDMOff): sample conversations, nothing is sent.
        if !ProcessInfo.processInfo.arguments.contains("-demoDMOff") { dm.debugLoadDemo() }
        // 🍻 オフ会 (on unless -demoOffkaiOff / BGURU_DEMO_OFFKAI=0; =idle: none going on, only the archive).
        let offkaiSetting = ProcessInfo.processInfo.arguments.contains("-demoOffkaiOff") ? "0"
            : (ProcessInfo.processInfo.arguments.contains("-demoOffkaiIdle") ? "idle" : (env["BGURU_DEMO_OFFKAI"] ?? "1"))
        if offkaiSetting != "0" { offkai.debugLoadDemo(running: offkaiSetting != "idle") }
        let offkaiCaps = offkaiSetting != "0" ? #","offkai":{"enabled":true,"path":"/api/agent/offkai","control":true}"# : ""
        let minigameCaps = minigameOn ? #","minigame":{"enabled":true,"path":"/api/agent/minigame","game_url":"/minigame/index.html","bridge_version":1,"engine_version":1,"play":true}"# : ""
        // 段階 3 (the operations): on unless -demoOldServer / BGURU_DEMO_OLD_SERVER=1 (a server from
        // before them says nothing); -demoTextOnly: an external agent's write key (text-only edits).
        let oldServer = ProcessInfo.processInfo.arguments.contains("-demoOldServer") || env["BGURU_DEMO_OLD_SERVER"] == "1"
        let textOnly = ProcessInfo.processInfo.arguments.contains("-demoTextOnly") || env["BGURU_DEMO_TEXT_ONLY"] == "1"
        // -demoNoEdit: a key from before the operations' mark (post, but edit false): 「編集するには一度ログインし直してください」.
        let noEdit = ProcessInfo.processInfo.arguments.contains("-demoNoEdit") || env["BGURU_DEMO_NO_EDIT"] == "1"
        let postOps = oldServer ? "" : #","edit":\#(!textOnly && !noEdit),"delete":\#(!noEdit),"edit_text_only":\#(textOnly && !noEdit),"whisper":true,"video":true,"audio":true,"max_media_mb":100,"poll":true,"poll_vote":true,"poll_edit":true,"pin":true,"pinned_list":true,"bookmarks":true,"bookmarks_set":true,"favorites":true,"custom_emoji_list":"/api/agent/emojis","club_select":true,"club_change":true,"mentions":"/api/agent/members","display":true,"include":["reactions","read","display"]"#
        // チャットの上に重ねる形 (on with BGURU_DEMO_OVERLAY=1 / -demoOverlay): 📺 too (BGURU_WATCH_FAKE_VIDEO=ID plays
        // one on this device only); BGURU_DEMO_OVERLAY_SHOW / _EXPAND set the windows (OverlayModel.debugApplyDemoEnv).
        let overlayOn = env["BGURU_DEMO_OVERLAY"] == "1" || ProcessInfo.processInfo.arguments.contains("-demoOverlay")
        let overlayCaps = overlayOn ? #","chat_overlay":{"enabled":true},"watch":{"enabled":true,"path":"/api/agent/watch","player_url":"/watch/index.html","bridge_version":1,"control":false}"# : ""
        let caps = #"{"api_version":1,"scopes":["read","read_state","chat","post"],"features":{"chat":{"send":true,"edit_own":true,"reactions":true,"images":true,"max_images":4,"beagle_ondevice":true},"posts":{"read":true,"publish":true,"upload":true,"reactions":true,"max_images":5\#(postOps)},"jukebox":{"enabled":\#(ProcessInfo.processInfo.arguments.contains("-demoJukebox") || ProcessInfo.processInfo.environment["BGURU_DEMO_JUKEBOX"] != nil),"path":"/api/agent/jukebox"}\#(shogiCaps)\#(minigameCaps)\#(offkaiCaps)\#(overlayCaps),"mac_assistant":true}}"#
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        capabilities = try? dec.decode(Capabilities.self, from: Data(caps.utf8))
        if overlayOn {
            overlay.enabled = true
            watch.debugLoadDemo()
            // After the app's own demo opens (BGURU_DEMO_ROOM etc.) have run.
            DispatchQueue.main.async { [overlay] in overlay.debugApplyDemoEnv() }
        }
    }

    /// A message from someone else, as if it came on the stream.
    func debugReceive(_ body: String, id: Int, author: String = "coban", mention: Bool = false,
                      kind: String? = nil, images: [String]? = nil) {
        received(ChatMessage(id: id, authorId: author, authorName: author, avatar: nil, body: body,
                             createdAt: ISO8601DateFormatter().string(from: Date()), edited: false, editedAt: nil,
                             isAuthor: false, mentionsMe: mention, clientId: nil, reactions: nil, images: images, kind: kind))
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

    /// The chat was read on another device of mine (`event: sync`): the unread count and the "@" follow.
    private func readElsewhere(upTo: Int?) {
        if let c = upTo { readCursor = max(readCursor ?? 0, c) }
        if upTo == nil || (upTo ?? 0) >= latestId {
            unreadCount = 0
            mentionCount = 0
        } else {
            Task { await reload() } // read part of it: the server knows how many are left
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
