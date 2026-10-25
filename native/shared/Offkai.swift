import Foundation
import Observation
import SwiftUI
import LiveKit

// 🍻 オフ会 (docs/offkai-spec.md, lib/offkai.ts). One event at a time: the phone on site sends its
// microphone into a LiveKit room of its own (bguru-offkai-<id>, not the voice room), everyone else
// listens, and everyone adds photos to the event's album, which stays after it ends (the archive).
// Who may speak is always one person — the last to press 「🎙 現地から話す」 (後勝ち): when the stream
// says someone else took over, this phone stops sending at once (the server takes the permission
// away too). Listening leaves the voice room first: two rooms never sound at once. Main-actor only.

struct OffkaiPerson: Decodable, Equatable, Sendable {
    var userId: String
    var name: String?
    var avatar: String?
    /// The speaker only: in the room now (「◯◯が話しています」 only then).
    var connected: Bool?

    var displayName: String { name.flatMap { $0.isEmpty ? nil : $0 } ?? "だれか" }
}

struct OffkaiEvent: Decodable, Equatable, Identifiable, Sendable {
    var id: Int
    var version: Int
    var title: String
    var startedBy: OffkaiPerson
    var startedAt: String
    var endsAt: String
    var endedAt: String?
    var speaker: OffkaiPerson?
    var photoCount: Int
    var cover: String?
    /// GET only (the stream's copy says false: it does not know who is looking).
    var canEnd: Bool?

    var isOpen: Bool { endedAt == nil }
    var displayTitle: String { title.isEmpty ? "オフ会" : title }
    var started: Date? { OffkaiStore.date(startedAt) }
}

struct OffkaiPhoto: Decodable, Equatable, Identifiable, Sendable {
    var id: Int
    var url: String
    var uploader: OffkaiPerson
    var caption: String?
    var createdAt: String
    /// I uploaded it (GET / my POST; the stream's copy says false — the store decides by user id).
    var mine: Bool?
}

@MainActor
@Observable
final class OffkaiStore {
    enum Audio: Equatable { case off, connecting, listening }

    /// On for this member (capabilities `features.offkai.enabled`).
    private(set) var enabled = false
    /// This token may start / speak / upload (the "chat" scope).
    private(set) var canControl = true
    private(set) var path = "/api/agent/offkai"
    /// The 🍻 tab is showing (above the chat).
    private(set) var open = false
    /// The event going on now (nil = none).
    private(set) var current: OffkaiEvent?
    /// How many are in the event's room (the stream's `listeners`).
    private(set) var listeners = 0
    /// Ended events, newest first (20 a page; `?before=` for more).
    private(set) var archive: [OffkaiEvent] = []
    private(set) var archiveHasMore = false
    private(set) var loadingArchive = false
    /// The current event's album, oldest first.
    private(set) var photos: [OffkaiPhoto] = []
    /// An ended event's album open in the panel (from the archive).
    private(set) var album: OffkaiEvent?
    private(set) var albumPhotos: [OffkaiPhoto] = []
    private(set) var albumLoading = false
    private(set) var audio: Audio = .off
    /// My microphone is going out to the room.
    private(set) var speaking = false
    /// A start / speak / end request is on its way.
    private(set) var busy = false
    private(set) var uploading = false
    /// Shown under the buttons until the next action.
    private(set) var notice: String?
    /// The chat column's height (the panel takes at most about half of it).
    private(set) var areaHeight: CGFloat = 0
    func setAreaHeight(_ h: CGFloat) { if abs(h - areaHeight) > 1 { areaHeight = h } }

    /// Photos waiting to be sent (📷, up to 4), and their one caption.
    let draft = PostDraft(maxImages: 4)
    var caption = ""

    /// Opening the tab: ☗ / 🎮 close, the club room goes back to text (set by ChatStore).
    @ObservationIgnored var willOpen: (@MainActor () -> Void)?
    /// Before joining the event's room: leave the voice room, pause the jukebox (set by ChatStore).
    @ObservationIgnored var willListen: (@MainActor () async -> Void)?
    /// My users.user_id as the chat knows it (the room's identity is the same).
    @ObservationIgnored var myUserId: (@MainActor () -> String?)?

    @ObservationIgnored private var room: Room?
    @ObservationIgnored private var observer: Observer?
    /// Bumped by every join and leave, so a join overtaken by a leave gives up.
    @ObservationIgnored private var attempt = 0
    @ObservationIgnored private var roomIdentity: String?
    @ObservationIgnored private var offline = false
    @ObservationIgnored private var demoSeq = 9000

    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    var running: OffkaiEvent? { current.flatMap { $0.isOpen ? $0 : nil } }

    private var me: String? { roomIdentity ?? myUserId?() }

    /// I am the one speaking (the server's view).
    var iAmSpeaker: Bool { if let me, let s = running?.speaker { return s.userId == me } else { return false } }

    /// 「終了」: the starter or an admin (GET's can_end / is_admin). Not the speaker: anyone can become
    /// the speaker (後勝ち), so 「話す」 then 「終了」 must not end someone else's event (security review).
    var canEnd: Bool {
        guard let e = running, canControl else { return false }
        if e.canEnd == true || isAdmin { return true }
        if let me { return e.startedBy.userId == me }
        return false
    }
    /// GET's `is_admin` (admins may end any event).
    private(set) var isAdmin = false

    func isMine(_ p: OffkaiPhoto) -> Bool {
        if p.mine == true { return true }
        if let me { return p.uploader.userId == me }
        return false
    }

    func configure(_ f: Capabilities.OffkaiFeatures?, enabled on: Bool) {
        if let p = f?.path, p.hasPrefix("/api/") { path = p }
        canControl = f?.control ?? true
        enabled = on
        if on { Task { await reload() } } else { open = false; Task { await stopAudio(release: false) } }
        if pendingShow { pendingShow = false; if on { show() } }
    }

    /// Asked to open before the server said 🍻 is on (a push tapped at launch).
    @ObservationIgnored private var pendingShow = false

    func show() {
        guard enabled else { pendingShow = true; return }
        willOpen?()
        open = true
        Task { await reload() }
    }

    /// The tab goes away; the sound goes on (stopped with 「止める」).
    func close() {
        open = false
        album = nil
    }

    // MARK: State

    /// GET state (opening the tab, the stream's reconnect).
    func reload() async {
        guard enabled, !offline else { return }
        let r = await api.minigameRaw("GET", path: path)
        struct State: Decodable { var current: OffkaiEvent?; var listeners: Int?; var archive: [OffkaiEvent]?; var isAdmin: Bool? }
        guard r.0 == 200, let s = try? Self.decoder.decode(State.self, from: r.1) else { return }
        isAdmin = s.isAdmin ?? false
        listeners = s.listeners ?? 0
        archive = s.archive ?? []
        archiveHasMore = archive.count >= 20
        if let c = s.current {
            take(c, force: true)
            await loadPhotos()
        } else if let c = current {
            var e = c
            e.endedAt = e.endedAt ?? ISO8601DateFormatter().string(from: Date())
            ended(e)
        }
    }

    func loadMoreArchive() async {
        guard enabled, archiveHasMore, !loadingArchive, let last = archive.last else { return }
        if offline { archiveHasMore = false; return }
        loadingArchive = true
        defer { loadingArchive = false }
        let r = await api.minigameRaw("GET", path: path, query: [URLQueryItem(name: "before", value: String(last.id))])
        struct State: Decodable { var archive: [OffkaiEvent]? }
        guard r.0 == 200, let s = try? Self.decoder.decode(State.self, from: r.1) else { return }
        let more = (s.archive ?? []).filter { e in !archive.contains { $0.id == e.id } }
        archive += more
        archiveHasMore = (s.archive ?? []).count >= 20
    }

    /// All of an event's photos (oldest first), page by page.
    private func fetchPhotos(_ eventId: Int) async -> [OffkaiPhoto]? {
        struct Page: Decodable { var photos: [OffkaiPhoto]; var nextAfter: Int? }
        var out: [OffkaiPhoto] = []
        var after: Int?
        for _ in 0..<20 {
            var q = [URLQueryItem(name: "limit", value: "200")]
            if let after { q.append(URLQueryItem(name: "after", value: String(after))) }
            let r = await api.minigameRaw("GET", path: "\(path)/\(eventId)/photos", query: q)
            guard r.0 == 200, let p = try? Self.decoder.decode(Page.self, from: r.1) else { return out.isEmpty ? nil : out }
            out += p.photos
            guard let n = p.nextAfter else { break }
            after = n
        }
        return out
    }

    private func loadPhotos() async {
        guard let e = running, !offline, let list = await fetchPhotos(e.id), running?.id == e.id else { return }
        photos = list
    }

    func openAlbum(_ e: OffkaiEvent) {
        album = e
        albumPhotos = []
        if offline { albumPhotos = demoAlbums[e.id] ?? []; return }
        albumLoading = true
        Task {
            let list = await fetchPhotos(e.id)
            guard album?.id == e.id else { return }
            albumLoading = false
            albumPhotos = list ?? []
            if list == nil { notice = "写真を読み込めませんでした" }
        }
    }

    func closeAlbum() {
        album = nil
        albumPhotos = []
    }

    /// The stream's `event: offkai` ({ action, event?, event_id?, photo?, photo_id?, listeners? }).
    func apply(_ data: Data) {
        struct Live: Decodable {
            var action: String
            var event: OffkaiEvent?
            var eventId: Int?
            var photo: OffkaiPhoto?
            var photoId: Int?
            var listeners: Int?
        }
        guard enabled, let ev = try? Self.decoder.decode(Live.self, from: data) else { return }
        switch ev.action {
        case "start", "update", "end":
            if let e = ev.event { take(e, fromStream: true) }
        case "photo":
            guard let p = ev.photo, let id = ev.eventId else { return }
            if running?.id == id { photos = Self.merged(photos, p) }
            if album?.id == id { albumPhotos = Self.merged(albumPhotos, p) }
        case "photo_delete":
            guard let pid = ev.photoId else { return }
            photos.removeAll { $0.id == pid }
            albumPhotos.removeAll { $0.id == pid }
        case "listeners":
            if let n = ev.listeners { listeners = n }
        default:
            break // a newer server's action
        }
    }

    private static func merged(_ list: [OffkaiPhoto], _ p: OffkaiPhoto) -> [OffkaiPhoto] {
        var out = list
        if let i = out.firstIndex(where: { $0.id == p.id }) {
            var q = p
            q.mine = out[i].mine == true || p.mine == true
            out[i] = q
        } else {
            out.append(p)
            out.sort { $0.id < $1.id }
        }
        return out
    }

    /// An event from GET, an answer or the stream. Older versions of the same event are dropped.
    private func take(_ incoming: OffkaiEvent, force: Bool = false, fromStream: Bool = false) {
        var e = incoming
        if let c = current, c.id == e.id {
            if !force, e.version < c.version { return }
            if fromStream { e.canEnd = c.canEnd } // the stream's copy does not know who looks
        } else if let c = current, c.isOpen, e.id < c.id, !force {
            return // a late word about an older event
        }
        if !e.isOpen { ended(e); return }
        let fresh = current?.id != e.id
        current = e
        if fresh {
            photos = []
            if !offline { Task { await loadPhotos() } }
        }
        followSpeaker()
    }

    /// Last wins: someone else pressed 「話す」 after me — stop sending now.
    private func followSpeaker() {
        guard speaking, !iAmSpeaker else { return }
        speaking = false
        notice = "ほかの人が現地から話し始めたので、マイクを止めました"
        Task { await setMic(false) }
    }

    private func ended(_ e: OffkaiEvent) {
        if current?.id == e.id || current == nil {
            let wasRunning = current?.isOpen == true
            current = nil
            photos = []
            listeners = 0
            if audio != .off { Task { await stopAudio(release: false) } }
            if wasRunning { notice = "オフ会が終わりました" }
        }
        if let i = archive.firstIndex(where: { $0.id == e.id }) { archive[i] = e } else {
            archive.insert(e, at: 0)
            archive.sort { $0.id > $1.id }
        }
    }

    // MARK: Actions

    func start(title raw: String) async {
        guard enabled, canControl, running == nil, !busy else { return }
        let title = String(raw.trimmingCharacters(in: .whitespacesAndNewlines).prefix(40))
        busy = true
        notice = nil
        defer { busy = false }
        if offline { demoStart(title); return }
        let r = await api.minigameRaw("POST", path: path, json: ["title": title])
        struct Answer: Decodable { var event: OffkaiEvent?; var current: OffkaiEvent? }
        let a = try? Self.decoder.decode(Answer.self, from: r.1)
        if (r.0 == 201 || r.0 == 200), let e = a?.event {
            take(e, force: true)
        } else {
            if r.0 == 409, let c = a?.current { take(c, force: true) }
            notice = Self.message(r, fallback: "オフ会を始められませんでした")
        }
    }

    func end() async {
        guard running != nil, canControl, !busy else { return }
        busy = true
        notice = nil
        defer { busy = false }
        if offline { demoEnd(); return }
        let r = await api.minigameRaw("POST", path: "\(path)/end", json: [:])
        struct Answer: Decodable { var event: OffkaiEvent? }
        if r.0 == 200, let e = (try? Self.decoder.decode(Answer.self, from: r.1))?.event {
            take(e, force: true)
        } else {
            notice = Self.message(r, fallback: "終了できませんでした")
        }
    }

    /// 「🔊 聞く」/「止める」.
    func toggleListen() async {
        if audio == .off { await listen() } else { await stopAudio(release: true) }
    }

    func listen() async {
        guard running != nil, audio == .off else { return }
        notice = nil
        if offline { audio = .listening; return }
        await willListen?()
        audio = .connecting
        attempt += 1
        let mine = attempt
        let r = await api.minigameRaw("POST", path: "\(path)/token", json: [:])
        guard mine == attempt, audio == .connecting else { return }
        guard r.0 == 200, let t = try? Self.decoder.decode(Token.self, from: r.1), let url = t.url, let token = t.token else {
            audio = .off
            notice = Self.message(r, fallback: "オフ会の音声につながりませんでした")
            return
        }
        await connect(url: url, token: token, attempt: mine, publish: false)
    }

    /// 「🎙 現地から話す」: I become the speaker (last wins), join with a key that may publish, mic on.
    func startSpeaking() async {
        guard running != nil, canControl, !busy else { return }
        busy = true
        notice = nil
        defer { busy = false }
        if offline { demoSpeak(true); return }
        await willListen?()
        let r = await api.minigameRaw("POST", path: "\(path)/speak", json: ["on": true])
        guard r.0 == 200, let t = try? Self.decoder.decode(Token.self, from: r.1) else {
            notice = Self.message(r, fallback: "話す側になれませんでした")
            return
        }
        if let e = t.event { take(e, force: true) }
        guard let url = t.url, let token = t.token, t.canSpeak != false else {
            notice = "音声は今使えません"
            return
        }
        // The key that may publish: join again with it (listening, if I was, goes on in the new connection).
        attempt += 1
        audio = .connecting
        await connect(url: url, token: token, attempt: attempt, publish: true)
    }

    /// 「話すのをやめる」: mic off at once, then tell the server (I stay listening).
    func stopSpeaking() async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        await setMic(false)
        if offline { demoSpeak(false); return }
        let r = await api.minigameRaw("POST", path: "\(path)/speak", json: ["on": false])
        if r.0 == 200, let e = (try? Self.decoder.decode(Token.self, from: r.1))?.event { take(e, force: true) }
    }

    private struct Token: Decodable {
        var token: String?
        var url: String?
        var room: String?
        var canSpeak: Bool?
        var event: OffkaiEvent?
    }

    // MARK: Photos

    /// 📷 → 送る: the picked photos as small JPEGs (long side 1280, no metadata — the chat's rule), one caption.
    func sendPhotos() async {
        guard running != nil, canControl, !uploading, let out = draft.takePhotos() else { return }
        let text = String(caption.trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
        caption = ""
        uploading = true
        notice = nil
        defer { uploading = false }
        let originals = out.originals
        let jpegs = await Task.detached(priority: .userInitiated) {
            originals.compactMap { PostDraft.uploadJPEG($0, maxSide: 1280, quality: 0.8) }
        }.value
        if offline { demoAddPhotos(jpegs, caption: text); return }
        let r = await api.offkaiUpload(path: "\(path)/photos", images: jpegs, caption: text)
        struct Answer: Decodable { var photos: [OffkaiPhoto] }
        if r.0 == 201 || r.0 == 200, let a = try? Self.decoder.decode(Answer.self, from: r.1) {
            for var p in a.photos {
                p.mine = true
                photos = Self.merged(photos, p)
            }
        } else {
            // Not lost: back into the tray to try again.
            for d in originals { draft.add(imageData: d) }
            caption = text
            notice = Self.message(r, fallback: "写真を送れませんでした")
        }
    }

    func deletePhoto(_ p: OffkaiPhoto) async {
        guard isMine(p) else { return }
        if !offline {
            let r = await api.minigameRaw("DELETE", path: "\(path)/photos/\(p.id)")
            guard r.0 == 200 else { notice = Self.message(r, fallback: "消せませんでした"); return }
        }
        photos.removeAll { $0.id == p.id }
        albumPhotos.removeAll { $0.id == p.id }
    }

    // MARK: The room (LiveKit)

    private func connect(url: String, token: String, attempt mine: Int, publish: Bool) async {
        let old = room
        room = nil
        observer = nil
        speaking = false
        await old?.disconnect()
        guard mine == attempt else { return }
        let obs = Observer(store: self)
        let r = Room(delegate: obs)
        room = r
        observer = obs
        do {
            try await r.connect(url: url, token: token, roomOptions: RoomOptions(defaultAudioCaptureOptions: AudioCaptureOptions(
                echoCancellation: true, autoGainControl: true, noiseSuppression: true
            )))
            guard mine == attempt, room === r else {
                await r.disconnect()
                return
            }
            roomIdentity = r.localParticipant.identity?.stringValue
            audio = .listening
            HangWatch.note("offkai room joined\(publish ? " (speaker)" : "")")
            // Someone else may have pressed 「話す」 while this was connecting.
            if publish, iAmSpeaker { await setMic(true) }
        } catch {
            guard mine == attempt else { return }
            await teardown()
            notice = "オフ会の音声につながりませんでした"
        }
    }

    private func setMic(_ on: Bool) async {
        guard let room else { speaking = false; return }
        do {
            try await room.localParticipant.setMicrophone(
                enabled: on,
                publishOptions: AudioPublishOptions(encoding: .presetSpeech, dtx: true, red: false)
            )
            speaking = on && room.localParticipant.isMicrophoneEnabled()
        } catch {
            speaking = false
            if on {
                notice = "マイクを使えません（設定でマイクを許可してください）"
                // Not left as the speaker on the server: the one before me lost it, and nobody could talk.
                if !offline, iAmSpeaker {
                    let r = await api.minigameRaw("POST", path: "\(path)/speak", json: ["on": false])
                    if r.0 == 200, let e = (try? Self.decoder.decode(Token.self, from: r.1))?.event { take(e, force: true) }
                }
            }
        }
    }

    /// Leave the room. `release`: I was speaking and stop on purpose — the server hears it too.
    func stopAudio(release: Bool) async {
        let wasSpeaker = speaking || iAmSpeaker
        if offline {
            audio = .off
            if wasSpeaker && release { demoSpeak(false) }
            return
        }
        await teardown()
        if release, wasSpeaker, running != nil {
            let r = await api.minigameRaw("POST", path: "\(path)/speak", json: ["on": false])
            if r.0 == 200, let e = (try? Self.decoder.decode(Token.self, from: r.1))?.event { take(e, force: true) }
        }
    }

    private func teardown() async {
        attempt += 1
        let r = room
        room = nil
        observer = nil
        audio = .off
        speaking = false
        await r?.disconnect()
    }

    fileprivate func roomChanged(_ from: Room) {
        guard let room, room === from else { return }
        // The server took the microphone away (someone else is the speaker now).
        if speaking, !room.localParticipant.isMicrophoneEnabled() { speaking = false }
        switch room.connectionState {
        case .connected: if audio != .off { audio = .listening }
        case .reconnecting: audio = .connecting
        default: break
        }
    }

    fileprivate func roomEnded(_ from: Room, _ error: LiveKitError?) {
        guard let room, room === from else { return }
        if error != nil, running != nil { notice = "オフ会の音声が切れました" }
        Task { await teardown() }
    }

    /// RoomDelegate callbacks arrive off the main actor; hop back.
    private final class Observer: NSObject, RoomDelegate, @unchecked Sendable {
        weak var store: OffkaiStore?
        init(store: OffkaiStore) { self.store = store }

        private func changed(_ room: Room) { Task { @MainActor [weak self] in self?.store?.roomChanged(room) } }

        func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) { changed(room) }
        func room(_ room: Room, participant: LocalParticipant, didUnpublishTrack publication: LocalTrackPublication) { changed(room) }
        func room(_ room: Room, participant: Participant, didUpdatePermissions permissions: ParticipantPermissions) { changed(room) }
        func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
            Task { @MainActor [weak self] in self?.store?.roomEnded(room, error) }
        }
    }

    // MARK: Helpers

    static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    nonisolated static func date(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: s) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: s)
    }

    private static func message(_ r: (Int, Data), fallback: String) -> String {
        if r.0 == 0 { return "通信できませんでした" }
        let obj = (try? JSONSerialization.jsonObject(with: r.1)) as? [String: Any]
        if r.0 == 429 { return (obj?["error"] as? String) ?? "少し待ってから試してください" }
        return (obj?["error"] as? String) ?? "\(fallback)（\(r.0)）"
    }

    // MARK: Demo (offline: answered here, nothing is sent)

    @ObservationIgnored private var demoAlbums: [Int: [OffkaiPhoto]] = [:]

    private static let demoMe = OffkaiPerson(userId: "me", name: "ドリキン", avatar: nil)

    private func demoStart(_ title: String) {
        demoSeq += 1
        let now = ISO8601DateFormatter().string(from: Date())
        let e = OffkaiEvent(id: demoSeq, version: 1, title: title, startedBy: Self.demoMe, startedAt: now,
                            endsAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(6 * 3600)), endedAt: nil,
                            speaker: nil, photoCount: 0, cover: nil, canEnd: true)
        take(e, force: true)
        listeners = 1
    }

    private func demoEnd() {
        guard var e = current else { return }
        e.endedAt = ISO8601DateFormatter().string(from: Date())
        e.version += 1
        e.photoCount = photos.count
        e.cover = photos.first?.url
        demoAlbums[e.id] = photos
        take(e, force: true)
    }

    private func demoSpeak(_ on: Bool) {
        guard var e = current else { return }
        e.speaker = on ? OffkaiPerson(userId: "me", name: "ドリキン", avatar: nil, connected: true) : nil
        e.version += 1
        current = e
        speaking = on
        if on { audio = .listening }
    }

    private func demoAddPhotos(_ jpegs: [Data], caption: String) {
        for d in jpegs {
            demoSeq += 1
            let path = "selftest-media/offkai-mine-\(demoSeq).jpg"
            #if DEBUG
            if let cg = MediaCache.decode(d, maxPixel: 1280) { MediaCache.shared.debugInsert(PlatformImage.decoded(cg), for: path) }
            #endif
            photos.append(OffkaiPhoto(id: demoSeq, url: path, uploader: Self.demoMe, caption: caption,
                                      createdAt: ISO8601DateFormatter().string(from: Date()), mine: true))
        }
    }

    #if DEBUG
    /// Sample events (BGURU_DEMO=1): one going on with a few photos (unless `running` is false), two ended.
    func debugLoadDemo(running: Bool = true) {
        offline = true
        enabled = true
        roomIdentity = "me"
        let iso = ISO8601DateFormatter()
        func ago(_ s: Double) -> String { iso.string(from: Date().addingTimeInterval(-s)) }
        func person(_ n: String) -> OffkaiPerson { OffkaiPerson(userId: n, name: n, avatar: nil) }
        func photo(_ id: Int, _ who: String, _ w: Int, _ h: Int, _ hue: CGFloat, _ caption: String, _ secs: Double) -> OffkaiPhoto {
            OffkaiPhoto(id: id, url: TimelineDemoMedia.picture("offkai-\(id)", w, h, hue: hue), uploader: who == "ドリキン" ? Self.demoMe : person(who),
                        caption: caption, createdAt: ago(secs), mine: who == "ドリキン")
        }
        let a1 = [photo(11, "mazzo", 1280, 960, 0.08, "乾杯！", 86_400 * 9), photo(12, "takuto", 960, 1280, 0.6, "", 86_400 * 9 - 600),
                  photo(13, "ドリキン", 1280, 720, 0.3, "二次会", 86_400 * 9 - 3600)]
        let a2 = [photo(21, "coban", 1280, 960, 0.95, "秋葉原", 86_400 * 30)]
        demoAlbums = [7: a1, 6: a2]
        archive = [
            OffkaiEvent(id: 7, version: 9, title: "渋谷・散財ナイト", startedBy: person("mazzo"), startedAt: ago(86_400 * 9 + 1800),
                        endsAt: ago(86_400 * 9 - 6 * 3600), endedAt: ago(86_400 * 9 - 3 * 3600), speaker: nil,
                        photoCount: a1.count, cover: a1.first?.url, canEnd: false),
            OffkaiEvent(id: 6, version: 4, title: "", startedBy: person("coban"), startedAt: ago(86_400 * 30 + 3600),
                        endsAt: ago(86_400 * 30 - 5 * 3600), endedAt: ago(86_400 * 30 - 2 * 3600), speaker: nil,
                        photoCount: a2.count, cover: a2.first?.url, canEnd: false),
        ]
        archiveHasMore = false
        guard running else { return }
        let ps = [photo(101, "mazzo", 1280, 960, 0.1, "かんぱーい 🍻", 3000), photo(102, "takuto", 960, 1280, 0.55, "", 2400),
                  photo(103, "ドリキン", 1280, 720, 0.33, "店の外観", 1500), photo(104, "coban", 1280, 960, 0.75, "2 杯目", 900),
                  photo(105, "NORIO TAKAHASHI", 1280, 1280, 0.0, "", 300)]
        current = OffkaiEvent(id: 8, version: 5, title: "新宿・カメラ談義", startedBy: person("mazzo"), startedAt: ago(3600 + 23 * 60),
                              endsAt: iso.string(from: Date().addingTimeInterval(4.6 * 3600)), endedAt: nil,
                              speaker: OffkaiPerson(userId: "mazzo", name: "mazzo", avatar: nil, connected: true),
                              photoCount: ps.count, cover: ps.first?.url, canEnd: false)
        photos = ps
        listeners = 6
        demoSeq = 200
    }
    #endif
}

extension OffkaiStore {
    /// 「1:23」 since it started (hours:minutes).
    static func elapsed(since start: Date?, now: Date) -> String {
        guard let start else { return "" }
        let m = max(0, Int(now.timeIntervalSince(start) / 60))
        return String(format: "%d:%02d", m / 60, m % 60)
    }

    /// 「10/24（金）」 for the archive.
    static func day(_ s: String) -> String {
        guard let d = date(s) else { return "" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.timeZone = TimeZone(identifier: "Asia/Tokyo")
        f.dateFormat = "M/d（E）"
        return f.string(from: d)
    }

    static func time(_ s: String) -> String {
        guard let d = date(s) else { return "" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.timeZone = TimeZone(identifier: "Asia/Tokyo")
        f.dateFormat = "M/d H:mm"
        return f.string(from: d)
    }
}
