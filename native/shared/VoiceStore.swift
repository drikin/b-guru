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
    /// Above the noise floor. Its own value, set only when it flips: the room map and the
    /// mic button's colour read this, so the 15-a-second level redraws only the ring.
    private(set) var micTalking = false
    /// My voice is going out (mic on and above the noise floor).
    var micActive: Bool { micOn && micTalking }
    /// Shown under the bar until the next action.
    private(set) var notice: String?
    private(set) var enabled = false
    private(set) var canJoin = false
    private(set) var isAdmin = false
    /// At most this many people with the mic on at once (server-provided).
    private(set) var maxSpeakers = 10
    var myUserId: String?

    var inRoom: Bool { phase != .idle }
    /// I opened this session (or am an admin): may remove people.
    /// Only admins remove / mute / ban (the server enforces the same).
    var canModerate: Bool { isAdmin }

    private let api: APIClient
    private var room: Room?
    /// The club room listens for changes in the call (people joining get their volume
    /// and permission at once).
    @ObservationIgnored var onParticipantsChanged: (() -> Void)?
    /// The call went on on another device of mine (DUPLICATE_IDENTITY): the club room shows it too.
    @ObservationIgnored var onContinuedElsewhere: (() -> Void)?
    /// 部室で聞いているのに、つながっていた音声が切れた（管理者に退出させられたら true）。別の端末で続けたときは呼ばない。
    @ObservationIgnored var onDropped: ((_ removed: Bool) -> Void)?
    /// 部室の音声として入っている（音量は距離 × 自分で決めた音量、出入りの効果音は声が届く人だけ）。
    /// RoomStore が入る前に立てる。抜けると下りる。
    @ObservationIgnored var clubRoom = false
    /// 部室の距離の音量（user id → 0…1）。まだ決まっていなければ nil。
    @ObservationIgnored private var nearVolumes: [String: Double]?
    /// 最後に入ろうとして、会員資格が確認できなかった（部室は試し直さない）。
    @ObservationIgnored private(set) var membershipEnded = false
    /// 相手ごとの音量（自分だけ、0…1、無ければ 1）。端末に覚える（Web と同じ、2026-11-08）。
    private(set) var gains: [String: Double] = VoiceGains.sanitized(UserDefaults.standard.dictionary(forKey: VoiceGains.key))
    /// 出入りの効果音（既定はオン、端末に覚える）。
    private(set) var sfxOn = UserDefaults.standard.object(forKey: "voiceSfx") as? Bool ?? true
    @ObservationIgnored private var sfxGate = RateGate(interval: 1.2)
    @ObservationIgnored private let sfx = VoiceSfxPlayer()
    /// 「スマホで続ける」 (Mac; set by ChatStore).
    @ObservationIgnored var handoff: VoiceHandoff?
    static let continuedElsewhere = "別の端末で続けています"
    /// Last set of people allowed to receive my mic (participant sids), nil = everyone.
    @ObservationIgnored private var allowedSids: Set<String>?
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
        maxSpeakers = caps?.voiceMaxSpeakers ?? 10
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

    /// Called just before joining: the jukebox pauses (the call wins).
    var onWillJoin: (() -> Void)?

    func join() async {
        if let d = devDirect { await joinDirect(url: d.url, token: d.token); return }
        guard phase == .idle, canJoin else { return }
        onWillJoin?()
        notice = nil
        membershipEnded = false
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
            clubRoom = false
            if case let .http(_, code, _) = e, code == "membership_ended" { membershipEnded = true }
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
        onWillJoin?()
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
        playSfx(.join, mine: true)
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
        if phase == .connected, room != nil {
            playSfx(.leave, mine: true)
            #if os(iOS)
            // LiveKit は抜けると音声のセッションを止める（isAutomaticDeactivationEnabled）。効果音が途中で切れないよう少し待つ
            try? await Task.sleep(for: .milliseconds(250))
            #endif
        }
        await teardown()
    }

    // MARK: 相手ごとの音量・出入りの効果音

    /// 相手の声の大きさ（0…1）。1 は覚えない（いつもの大きさ）。
    func setGain(_ userId: String, _ gain: Double) {
        gains = VoiceGains.setting(gains, id: userId, to: gain)
        if gains.isEmpty { UserDefaults.standard.removeObject(forKey: VoiceGains.key) }
        else { UserDefaults.standard.set(gains, forKey: VoiceGains.key) }
        applyVolumes()
    }

    func gain(_ userId: String) -> Double { gains[userId] ?? 1 }

    func setSfx(_ on: Bool) {
        sfxOn = on
        UserDefaults.standard.set(on, forKey: "voiceSfx")
    }

    /// 自分の出入りは毎回、ほかの人の分は 1.2 秒に 1 回まで（大勢の出入りで鳴りっぱなしにしない）。
    func playSfx(_ kind: VoiceSfxTone.Kind, mine: Bool) {
        guard sfxOn else { return }
        if !mine, !sfxGate.allow() { return }
        sfx.play(kind, mine: mine)
    }

    /// その人の出入りを鳴らすか: 部室では声が届く範囲の人だけ、ボイスルームでは全員。
    private func audibleToMe(_ id: String) -> Bool {
        clubRoom ? (nearVolumes?[id] ?? 0) > 0 : true
    }

    /// 音量 = 距離の音量（部室のときだけ）× 自分で決めた音量。部室で距離がまだ決まっていなければ触らない。
    private func applyVolumes() {
        guard let room else { return }
        if clubRoom && nearVolumes == nil { return }
        for p in room.remoteParticipants.values {
            guard let id = p.identity?.stringValue else { continue }
            let near = clubRoom ? (nearVolumes?[id] ?? 0) : 1
            let v = near * gain(id)
            for pub in p.audioTracks {
                if let t = pub.track as? RemoteAudioTrack, abs(t.volume - v) > 0.005 { t.volume = v }
            }
        }
    }

    fileprivate func participantCame(_ from: Room, _ id: String?, joined: Bool) {
        guard let room, room === from, phase == .connected, let id else { return }
        if audibleToMe(id) { playSfx(joined ? .join : .leave, mine: false) }
    }

    /// The first unmute starts the mic and publishes the track, which takes a
    /// second or two. The button flips at once (optimistic) and ignores taps
    /// until that finishes — otherwise a second tap queued a "mute" and the
    /// first unmute seemed not to work.
    func setMic(_ on: Bool) async {
        guard let room, phase == .connected || phase == .reconnecting, !micBusy else { return }
        if on, members.filter({ !$0.isMe && !$0.muted }).count >= maxSpeakers {
            notice = "話せるのは同時に \(maxSpeakers) 人までです。誰かがミュートするまでお待ちください"
            return
        }
        micBusy = true
        micOn = on
        notice = nil
        defer { micBusy = false }
        do {
            // Speech-quality Opus, nothing sent during silence (DTX), no redundant
            // copy (RED doubles the bytes) — the server is shared and up to 100 listen.
            try await room.localParticipant.setMicrophone(
                enabled: on,
                publishOptions: AudioPublishOptions(encoding: .presetSpeech, dtx: true, red: false)
            )
            setMeter(on)
        } catch {
            #if DEBUG
            FileHandle.standardError.write(Data("[voice] setMic(\(on)) error: \(error)\n".utf8))
            #endif
            micOn = room.localParticipant.isMicrophoneEnabled()
            notice = on ? "マイクを使えません（設定でマイクを許可してください）" : nil
        }
        refreshMembers()
    }

    /// Someone the member chose to report (the bar shows the reason prompt).
    var reportTarget: Member?

    func report(_ userId: String, reason: String) async {
        do {
            try await api.voiceReport(userId: userId, reason: reason)
            notice = "管理者に通報しました"
        } catch let e as APIError {
            notice = Self.message(for: e)
        } catch {
            notice = "通報できませんでした"
        }
    }

    func forceMute(_ userId: String) async {
        do {
            let muted = try await api.voiceMute(userId: userId)
            notice = muted ? "ミュートしました" : "マイクはオフでした"
        } catch let e as APIError {
            notice = Self.message(for: e)
        } catch {
            notice = "操作できませんでした"
        }
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
        allowedSids = nil
        nearVolumes = nil
        clubRoom = false
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
                    let next = level > self.micLevel ? level : max(level, self.micLevel * 0.7)
                    // Silence (and changes too small to see) writes nothing.
                    if abs(next - self.micLevel) >= 0.01 || (next < 0.01) != (self.micLevel < 0.01) {
                        self.micLevel = next < 0.01 ? 0 : next
                    }
                    let talking = self.micLevel > 0.12
                    if talking != self.micTalking { self.micTalking = talking }
                }
            }
            AudioManager.shared.add(localAudioRenderer: m)
            meter = m
        } else if !on, let m = meter {
            AudioManager.shared.remove(localAudioRenderer: m)
            meter = nil
            micLevel = 0
            micTalking = false
        }
    }

    // MARK: LiveKit events (via Observer)

    fileprivate func roomChanged(_ from: Room) {
        guard let room, room === from else { return } // late event from an earlier room
        // An admin turned my mic off from the server: follow it.
        if micOn, !micBusy, !room.localParticipant.isMicrophoneEnabled(), phase == .connected {
            micOn = false
            setMeter(false)
            notice = "マイクがオフにされました（管理者の操作か、話せる人数の上限のため）"
        }
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
        // つながっていた・つなぎ直し中から切れたときだけ（つなぐ途中の失敗は join の側で扱う）
        let wasLive = phase == .connected || phase == .reconnecting
        let duplicate = error?.type == .duplicateIdentity
        let removed = error?.type == .participantRemoved
        if duplicate {
            // The same member joined from another device (「スマホで続ける」, or simply opened it there):
            // LiveKit lets one connection per identity, so this one was let go. Not a failure, and no rejoin
            // (that would take it back from the other device).
            notice = Self.continuedElsewhere
            onContinuedElsewhere?()
        } else if error?.type == .participantRemoved {
            notice = "ボイスルームから退出させられました"
        } else if error != nil {
            notice = "ボイスルームの接続が切れました"
        }
        Task {
            await teardown()
            if wasLive, !duplicate { onDropped?(removed) }
        }
    }

    // MARK: Club room proximity

    /// Room view: each person's volume (0…1 by distance / zone) and who may receive my
    /// microphone. The permission is what keeps the meeting table private — LiveKit
    /// refuses my track to anyone not listed, whatever their app asks for.
    func applyProximity(volumes: [String: Double], allowed: Set<String>) async {
        guard let room else { return }
        clubRoom = true
        nearVolumes = volumes
        applyVolumes()
        let sids = Set(room.remoteParticipants.values.filter { allowed.contains($0.identity?.stringValue ?? "") }.compactMap { $0.sid?.stringValue })
        guard sids != allowedSids else { return }
        allowedSids = sids
        try? await room.localParticipant.setTrackSubscriptionPermissions(
            allParticipantsAllowed: false,
            trackPermissions: sids.sorted().map { ParticipantTrackPermission(participantSid: $0, allTracksAllowed: true) }
        )
    }

    private func refreshMembers() {
        defer { onParticipantsChanged?() }
        guard let room else { members = []; return }
        // ボイスルーム（部室でない）: 入ってきた人・新しい音声にも自分で決めた音量を
        if !clubRoom { applyVolumes() }
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
        // Talking first, then mics on, then listeners — the bar only shows the first few.
        out += room.remoteParticipants.values
            .compactMap { member($0, isMe: false) }
            .sorted {
                if $0.speaking != $1.speaking { return $0.speaking }
                if $0.muted != $1.muted { return !$0.muted }
                return $0.name.localizedStandardCompare($1.name) == .orderedAscending
            }
        if out != members { members = out }
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
        func room(_ room: Room, participantDidConnect participant: RemoteParticipant) {
            let id = participant.identity?.stringValue
            Task { @MainActor [weak self] in self?.store?.participantCame(room, id, joined: true) }
            changed(room)
        }
        func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) {
            let id = participant.identity?.stringValue
            Task { @MainActor [weak self] in self?.store?.participantCame(room, id, joined: false) }
            changed(room)
        }
        func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) { changed(room) }
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

/// 出入りの効果音を鳴らす（VoiceSfxTone で作った WAV を AVAudioPlayer で）。音声のセッションの設定には触らない
/// （LiveKit が決めた今のセッションのまま鳴らす）。鳴るのはつながっている間と、抜ける直前だけ。
@MainActor
private final class VoiceSfxPlayer {
    private var cache: [String: Data] = [:]
    private var playing: [AVAudioPlayer] = []

    func play(_ kind: VoiceSfxTone.Kind, mine: Bool) {
        let key = "\(kind)-\(mine)"
        let data: Data
        if let hit = cache[key] { data = hit } else {
            data = VoiceSfxTone.wav(VoiceSfxTone.samples(kind, mine: mine))
            cache[key] = data
        }
        playing.removeAll { !$0.isPlaying }
        guard let p = try? AVAudioPlayer(data: data) else { return }
        p.prepareToPlay()
        p.play()
        playing.append(p) // 鳴り終わるまで手放さない
    }
}
