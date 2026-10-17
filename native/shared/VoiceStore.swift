import AVFoundation
import Foundation
import Observation
import LiveKit

/// The voice room (ボイスルーム): one room for the whole community, open while
/// someone is in it. LiveKit carries the audio; our server only hands out a
/// short-lived join token (POST /api/agent/voice/token) and tells everyone who
/// is in the room (the stream's `voice` event). Main-actor only.
///
/// You always enter muted — the mic turns on only when you unmute, and the
/// system asks for microphone permission the first time. Nothing is recorded.
@MainActor
@Observable
final class VoiceStore {
    enum Phase: Equatable { case idle, connecting, connected, reconnecting }

    struct Member: Identifiable, Equatable {
        var userId: String
        var name: String
        var avatar: String?
        var speaking: Bool
        var muted: Bool
        var isMe: Bool
        var id: String { userId }
    }

    /// Server's view of the room (for people who have not joined).
    private(set) var roomInfo: VoiceRoomInfo?
    private(set) var phase: Phase = .idle
    /// People in the room while I am in it (me first), from LiveKit itself.
    private(set) var members: [Member] = []
    private(set) var micOn = false
    /// Turning the mic on/off is in progress.
    private(set) var micBusy = false
    /// What the mic is sending right now, 0…1 (after echo cancellation / noise
    /// suppression), measured on this device so it reacts instantly.
    private(set) var micLevel: Float = 0
    /// My voice is going out (mic on and above the noise floor).
    var micActive: Bool { micOn && micLevel > 0.12 }
    /// Shown under the bar until the next action.
    private(set) var notice: String?
    private(set) var enabled = false
    private(set) var canJoin = false
    private(set) var isAdmin = false
    var myUserId: String?

    var inRoom: Bool { phase != .idle }
    /// I opened this session (or am an admin): may remove people.
    var canModerate: Bool { isAdmin || (myUserId != nil && roomInfo?.openedBy == myUserId) }

    private let api: APIClient
    private var room: Room?
    private var observer: Observer?
    private var meter: MicMeter?

    // MARK: Audio devices (Mac only — iOS routes audio itself, e.g. to AirPods)

    struct AudioChoice: Identifiable, Equatable {
        var id: String   // "" = follow the system default
        var name: String
    }
    private(set) var inputs: [AudioChoice] = []
    private(set) var outputs: [AudioChoice] = []
    private(set) var inputId: String = UserDefaults.standard.string(forKey: "voiceInputDevice") ?? ""
    private(set) var outputId: String = UserDefaults.standard.string(forKey: "voiceOutputDevice") ?? ""
    /// Bumped by every join and leave, so an in-flight join that was overtaken
    /// by a leave (or a newer join) gives up instead of connecting.
    private var attempt = 0

    init(api: APIClient) {
        self.api = api
        #if DEBUG
        // Dev only: BGURU_DEV_VOICE_URL=ws://… BGURU_DEV_VOICE_TOKEN=<jwt> joins a LiveKit
        // server directly (works in demo mode, no B-guru API); …_AUTOJOIN=1 joins at launch.
        let env = ProcessInfo.processInfo.environment
        if let u = env["BGURU_DEV_VOICE_URL"], let t = env["BGURU_DEV_VOICE_TOKEN"], !u.isEmpty, !t.isEmpty {
            devDirect = (u, t)
            enabled = true
            canJoin = true
            if env["BGURU_DEV_VOICE_AUTOJOIN"] == "1" {
                Task { await self.join(); if env["BGURU_DEV_VOICE_MIC"] == "1" { await self.setMic(true) } }
            }
        }
        #endif
    }
    private var devDirect: (url: String, token: String)?

    func configure(with caps: Capabilities?) {
        if devDirect != nil { return }
        enabled = caps?.voiceEnabled ?? false
        canJoin = caps?.canJoinVoice ?? false
        isAdmin = caps?.isVoiceAdmin ?? false
        if enabled { Task { await loadState() } }
    }

    func loadState() async {
        guard let s = try? await api.voiceState() else { return }
        enabled = s.enabled
        roomInfo = s.room
    }

    /// Stream `voice` event.
    func apply(_ info: VoiceRoomInfo) {
        roomInfo = info
        if inRoom { refreshMembers() }
    }

    // MARK: Join / leave

    func join() async {
        if let d = devDirect { await joinDirect(url: d.url, token: d.token); return }
        guard phase == .idle, canJoin else { return }
        notice = nil
        phase = .connecting
        attempt += 1
        let mine = attempt
        do {
            let t = try await api.voiceToken()
            // Left (or left and rejoined) while the token was on its way.
            guard mine == attempt, phase == .connecting else { return }
            myUserId = t.identity
            try await connectRetrying(url: t.url, token: t.token, attempt: mine)
        } catch let e as APIError {
            guard mine == attempt else { return }
            phase = .idle
            notice = Self.message(for: e)
        } catch {
            guard mine == attempt else { return }
            await teardown()
            notice = "ボイスルームにつながりませんでした"
        }
    }

    /// Dev only: connect straight to a LiveKit server with a token (no B-guru API).
    func joinDirect(url: String, token: String) async {
        guard phase == .idle else { return }
        phase = .connecting
        attempt += 1
        do { try await connectRetrying(url: url, token: token, attempt: attempt) } catch {
            #if DEBUG
            FileHandle.standardError.write(Data("[voice] connect error: \(error)\n".utf8))
            #endif
            await teardown()
            notice = "接続失敗: \(error.localizedDescription)"
        }
    }

    /// One retry on a connect timeout: right after the app was killed, the server
    /// may still hold our previous connection (same identity) for a few seconds,
    /// and the first attempt can time out while it replaces it.
    private func connectRetrying(url: String, token: String, attempt mine: Int) async throws {
        do {
            try await connect(url: url, token: token, attempt: mine)
        } catch let e as LiveKitError where e.type == .timedOut {
            guard mine == attempt else { return }
            let stale = room
            room = nil
            observer = nil
            await stale?.disconnect()
            try await connect(url: url, token: token, attempt: mine)
        }
    }

    private func connect(url: String, token: String, attempt mine: Int) async throws {
        let obs = Observer(store: self)
        let room = Room(delegate: obs)
        self.room = room
        self.observer = obs
        try await room.connect(url: url, token: token, roomOptions: RoomOptions(defaultAudioCaptureOptions: AudioCaptureOptions(
            echoCancellation: true, autoGainControl: true, noiseSuppression: true
        )))
        // Left while connecting: this room is no longer ours.
        guard mine == attempt, self.room === room else {
            await room.disconnect()
            return
        }
        if myUserId == nil { myUserId = room.localParticipant.identity?.stringValue }
        micOn = false
        phase = .connected
        #if os(macOS)
        AudioManager.shared.onDeviceUpdate = { [weak self] _ in
            Task { @MainActor in self?.refreshDevices() }
        }
        refreshDevices()
        applyDevices()
        #endif
        refreshMembers()
    }

    func leave() async {
        await teardown()
    }

    /// The first unmute starts the mic and publishes the track, which takes a
    /// second or two. The button flips at once (optimistic) and ignores taps
    /// until that finishes — otherwise a second tap queued a "mute" and the
    /// first unmute seemed not to work.
    func setMic(_ on: Bool) async {
        guard let room, phase == .connected || phase == .reconnecting, !micBusy else { return }
        micBusy = true
        micOn = on
        notice = nil
        defer { micBusy = false }
        do {
            try await room.localParticipant.setMicrophone(enabled: on)
            setMeter(on)
        } catch {
            micOn = room.localParticipant.isMicrophoneEnabled()
            notice = on ? "マイクを使えません（設定でマイクを許可してください）" : nil
        }
        refreshMembers()
    }

    func kick(_ userId: String, ban: Bool = false) async {
        do {
            try await api.voiceKick(userId: userId, ban: ban)
            notice = ban ? "退出させ、入室禁止にしました" : "退出させました"
        } catch let e as APIError {
            notice = Self.message(for: e)
        } catch {
            notice = "操作できませんでした"
        }
    }

    private func teardown() async {
        attempt += 1
        let r = room
        room = nil
        observer = nil
        phase = .idle
        micOn = false
        micBusy = false
        setMeter(false)
        members = []
        await r?.disconnect()
    }

    #if os(macOS)
    func selectInput(_ id: String) {
        inputId = id
        UserDefaults.standard.set(id, forKey: "voiceInputDevice")
        applyDevices()
    }

    func selectOutput(_ id: String) {
        outputId = id
        UserDefaults.standard.set(id, forKey: "voiceOutputDevice")
        applyDevices()
    }

    private func refreshDevices() {
        let am = AudioManager.shared
        let def = AudioChoice(id: "", name: "システムの設定に従う")
        inputs = [def] + am.inputDevices.filter { !$0.isDefault }.map { AudioChoice(id: $0.deviceId, name: $0.name) }
        outputs = [def] + am.outputDevices.filter { !$0.isDefault }.map { AudioChoice(id: $0.deviceId, name: $0.name) }
    }

    /// Use the saved devices; one that is unplugged falls back to the system default.
    private func applyDevices() {
        let am = AudioManager.shared
        am.inputDevice = am.inputDevices.first { $0.deviceId == inputId && !inputId.isEmpty } ?? am.defaultInputDevice
        am.outputDevice = am.outputDevices.first { $0.deviceId == outputId && !outputId.isEmpty } ?? am.defaultOutputDevice
    }
    #endif

    private func setMeter(_ on: Bool) {
        if on, meter == nil {
            let m = MicMeter { [weak self] level in
                Task { @MainActor in
                    guard let self, self.meter != nil else { return }
                    // Rise fast, fall slowly, so the indicator does not flicker between words.
                    self.micLevel = level > self.micLevel ? level : max(level, self.micLevel * 0.7)
                }
            }
            AudioManager.shared.add(localAudioRenderer: m)
            meter = m
        } else if !on, let m = meter {
            AudioManager.shared.remove(localAudioRenderer: m)
            meter = nil
            micLevel = 0
        }
    }

    // MARK: LiveKit events (via Observer)

    fileprivate func roomChanged(_ from: Room) {
        guard let room, room === from else { return } // late event from an earlier room
        switch room.connectionState {
        case .connected: if phase != .idle { phase = .connected }
        case .reconnecting: phase = .reconnecting
        default: break
        }
        refreshMembers()
    }

    fileprivate func roomEnded(_ from: Room, _ error: LiveKitError?) {
        #if DEBUG
        FileHandle.standardError.write(Data("[voice] disconnected: \(String(describing: error))\n".utf8))
        #endif
        guard let room, room === from else { return } // late event from an earlier room
        if error?.type == .participantRemoved {
            notice = "ボイスルームから退出させられました"
        } else if error != nil {
            notice = "ボイスルームの接続が切れました"
        }
        Task { await teardown() }
    }

    private func refreshMembers() {
        guard let room else { members = []; return }
        let known = Dictionary((roomInfo?.participants ?? []).map { ($0.userId, $0) }, uniquingKeysWith: { a, _ in a })
        func member(_ p: Participant, isMe: Bool) -> Member? {
            guard let id = p.identity?.stringValue else { return nil }
            let info = known[id]
            return Member(
                userId: id,
                name: p.name.flatMap { $0.isEmpty ? nil : $0 } ?? info?.name ?? "?",
                avatar: info?.avatar,
                // My own talking shows on the mic button, not as a ring on my face.
                speaking: !isMe && p.isSpeaking,
                muted: !p.isMicrophoneEnabled(),
                isMe: isMe
            )
        }
        var out: [Member] = []
        if let me = member(room.localParticipant, isMe: true) { out.append(me) }
        out += room.remoteParticipants.values
            .compactMap { member($0, isMe: false) }
            .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        members = out
        #if DEBUG
        let line = out.map { "\($0.name)\($0.isMe ? "*" : "")[\($0.muted ? "muted" : "mic")\($0.speaking ? ",speaking" : "")]" }.joined(separator: " ")
        FileHandle.standardError.write(Data("[voice] \(phase) \(line)\n".utf8))
        #endif
    }

    private static func message(for e: APIError) -> String {
        switch e {
        case .unauthorized: return "ログインし直してください"
        case let .http(status, code, message):
            if code == "membership_ended" { return "BSM 会員資格が確認できません" }
            if status == 429 { return "少し待ってから試してください" }
            return message ?? "ボイスルームに入れません"
        case .transport: return "ネットワークにつながりません"
        }
    }

    /// RoomDelegate callbacks arrive off the main actor; hop back and re-read
    /// the room (its properties are thread-safe).
    private final class Observer: NSObject, RoomDelegate, @unchecked Sendable {
        weak var store: VoiceStore?
        init(store: VoiceStore) { self.store = store }

        private func changed(_ room: Room) { Task { @MainActor [weak self] in self?.store?.roomChanged(room) } }

        func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) { changed(room) }
        func room(_ room: Room, participantDidConnect participant: RemoteParticipant) { changed(room) }
        func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) { changed(room) }
        func room(_ room: Room, didUpdateSpeakingParticipants participants: [Participant]) { changed(room) }
        func room(_ room: Room, participant: RemoteParticipant, didPublishTrack publication: RemoteTrackPublication) { changed(room) }
        func room(_ room: Room, participant: RemoteParticipant, didUnpublishTrack publication: RemoteTrackPublication) { changed(room) }
        func room(_ room: Room, participant: Participant, trackPublication: TrackPublication, didUpdateIsMuted isMuted: Bool) { changed(room) }
        func room(_ room: Room, participant: Participant, didUpdateName name: String) { changed(room) }
        func room(_ room: Room, didDisconnectWithError error: LiveKitError?) {
            Task { @MainActor [weak self] in self?.store?.roomEnded(room, error) }
        }
    }
}

/// Turns the mic's processed buffers into a 0…1 level (about 15 updates a
/// second). Called on the audio thread, so it only does arithmetic and hands
/// the number off.
private final class MicMeter: NSObject, AudioRenderer, @unchecked Sendable {
    private let onLevel: @Sendable (Float) -> Void
    private let lock = NSLock()
    private var lastEmit: UInt64 = 0

    init(onLevel: @escaping @Sendable (Float) -> Void) {
        self.onLevel = onLevel
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        let now = DispatchTime.now().uptimeNanoseconds
        lock.lock()
        let due = now - lastEmit > 66_000_000
        if due { lastEmit = now }
        lock.unlock()
        guard due else { return }
        let n = Int(pcmBuffer.frameLength)
        guard n > 0 else { return }
        var sum: Float = 0
        if let f = pcmBuffer.floatChannelData?[0] {
            for i in 0..<n { sum += f[i] * f[i] }
        } else if let s = pcmBuffer.int16ChannelData?[0] {
            for i in 0..<n { let v = Float(s[i]) / 32768; sum += v * v }
        } else {
            return
        }
        let rms = (sum / Float(n)).squareRoot()
        let db = 20 * log10(max(rms, 1e-6))
        // -50 dBFS (room noise) → 0, -10 dBFS (close, loud speech) → 1.
        onLevel(min(max((db + 50) / 40, 0), 1))
    }
}
