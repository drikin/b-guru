import Foundation
import Observation

/// The club room (ルーム) — an 8-bit room where members walk around and hear the
/// people near them. Spec: docs/room-client-spec.md; server: src/lib/room.ts.
///
/// The server holds everyone's tile; this store mirrors it from the stream's `room`
/// events and animates the walking between tiles. My own walk is local first (one
/// step every `stepTime`, each sent to the server without waiting). Voice uses the
/// existing VoiceStore: entering the room joins it muted, the text view leaves it,
/// and every change re-applies who I hear (volumes) and who may hear me (track
/// permissions, which is what keeps the meeting table private). Main-actor only.
@MainActor
@Observable
final class RoomStore {
    enum Mode { case text, room }

    static let stepTime: TimeInterval = 0.17

    private(set) var enabled = false
    private(set) var geometry: RoomGeometry?
    private(set) var members: [String: RoomMember] = [:]
    private(set) var meId: String?
    private(set) var mode: Mode = .text
    private(set) var listening = UserDefaults.standard.object(forKey: "roomListening") as? Bool ?? true
    private(set) var reactionChoices = ["👋", "❤️", "😂", "👏", "🎉", "🍻"]
    var notice: String?
    /// Debug demo: actions are applied locally, nothing is sent.
    private var offline = false

    /// Walks in progress: tiles to visit from `start`, one every stepTime.
    struct Walk { var from: (x: Double, y: Double); var steps: [(Int, Int)]; var start: Date }
    private var walks: [String: Walk] = [:]
    private(set) var bubbles: [String: (text: String, until: Date)] = [:]
    private(set) var reactions: [String: [(emoji: String, at: Date)]] = [:]
    /// Bumped on every change the map should redraw for (walks are time-based).
    private(set) var revision = 0

    let api: APIClient
    let voice: VoiceStore
    private var myWalk: Task<Void, Never>?
    private var proximityTask: Task<Void, Never>?
    private var noticeTask: Task<Void, Never>?
    /// サーバの起動ごとの印（GET /api/agent/room の boot）。変わったら再起動。
    private var lastBoot: String?
    /// 再起動のあとの入り直し（10 秒に 1 回まで）・音声の自動の入り直し（30 秒に 1 回まで）。
    private var rejoinGate = RateGate(interval: 10)
    private var voiceRejoinGate = RateGate(interval: 30)
    /// 部室に入る（入り直す）途中。
    private var entering = false
    // ステージの自動マイク（StageMic）: 自動で入れた / 本人が切った（または入れられなかった）/ 切り替え中 / 1 秒待ち。
    private var stageAuto = false
    private var stageSuppressed = false
    private var stageBusy = false
    private var stageTimer: Task<Void, Never>?

    init(api: APIClient, voice: VoiceStore) {
        self.api = api
        self.voice = voice
        voice.onParticipantsChanged = { [weak self] in self?.applyProximity() }
        voice.onContinuedElsewhere = { [weak self] in
            guard let self, self.mode == .room else { return }
            // The phone (same identity) is in the room now: step out here only. Telling the server (toText /
            // listening off) would move or mute the phone, since the server's "me" is that phone now.
            self.myWalk?.cancel()
            self.myWalk = nil
            self.mode = .text
            self.resetStage()
            self.notice = VoiceStore.continuedElsewhere
            self.revision += 1
        }
        voice.onDropped = { [weak self] removed in self?.voiceDropped(removed: removed) }
    }

    var me: RoomMember? { meId.flatMap { members[$0] } }

    // MARK: Load / events

    func configure(enabled: Bool) {
        self.enabled = enabled
        if enabled { Task { await load() } }
    }

    func load() async {
        guard enabled, !offline, let r = try? await api.room() else { return }
        let restarted = RoomRestart.restarted(previous: lastBoot, current: r.boot)
        if let b = r.boot { lastBoot = b }
        geometry = RoomGeometry(map: r.map)
        meId = r.me
        if let rs = r.reactions, !rs.isEmpty { reactionChoices = rs }
        var next: [String: RoomMember] = [:]
        for m in r.members { next[m.userId] = m }
        // While I walk, my local position wins over a snapshot taken mid-walk.
        if let id = meId, myWalk != nil, let mine = members[id] { next[id] = mine }
        members = next
        if let id = meId, let m = members[id] {
            if mode == .room, !m.inRoom, restarted, !entering {
                // サーバが再起動して私を忘れた（部室にいたのにテキスト扱い）: テキストに戻さず入り直す。音声はそのまま
                rejoinAfterRestart()
            } else if mode == .room, !m.inRoom, !entering {
                // ほかの端末で（テキストに戻した）
                mode = .text
                resetStage()
            } else if !entering {
                mode = m.inRoom ? .room : .text
            }
        }
        revision += 1
        applyProximity()
    }

    /// Stream event "room": join / update / leave, or a reaction.
    func apply(_ data: Data) {
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        struct Event: Decodable { var action: String; var member: RoomMember?; var userId: String?; var emoji: String?; var to: String? }
        guard let e = try? dec.decode(Event.self, from: data) else { return }
        switch e.action {
        case "react":
            if let id = e.userId, let emoji = e.emoji { react(id, emoji) }
            if let to = e.to, e.emoji == "👋" { react(to, "👋") }
        case "leave":
            if let m = e.member { members[m.userId] = nil; walks[m.userId] = nil }
        default:
            guard let m = e.member else { return }
            if e.action == "join", m.userId == meId, !m.inRoom, mode == .room {
                // 「join」で私がテキスト = サーバが私を覚えていない（再起動）。ほかの端末の操作なら update で来る
                rejoinAfterRestart()
                return
            }
            received(m)
        }
        revision += 1
        applyProximity()
    }

    private func received(_ m: RoomMember) {
        let old = members[m.userId]
        if m.userId == meId {
            // My position is driven locally; take the rest (mic turned off by the server, 💤).
            var mine = old ?? m
            mine.mode = m.mode; mine.listening = m.listening; mine.mic = m.mic; mine.away = m.away
            if old == nil || (myWalk == nil && (abs(m.x - mine.x) + abs(m.y - mine.y) > 2 || m.mode != old?.mode)) { mine.x = m.x; mine.y = m.y }
            members[m.userId] = mine
            if !m.mic, voice.micOn { Task { await voice.setMic(false) } }
            return
        }
        members[m.userId] = m
        guard let geo = geometry, let old else { return }
        let here = displayPosition(m.userId, at: Date()) ?? (Double(old.x), Double(old.y))
        if old.mode == "text" && m.inRoom {
            // Came into the room: walk in from the door.
            let door = geo.map.door
            walks[m.userId] = Walk(from: (Double(door.x), Double(door.y)), steps: geo.path(from: door.x, door.y, to: m.x, m.y), start: Date())
        } else if m.inRoom && (old.x != m.x || old.y != m.y) {
            let sx = Int(here.x.rounded()), sy = Int(here.y.rounded())
            let steps = abs(sx - m.x) + abs(sy - m.y) <= 1 ? [(m.x, m.y)] : geo.path(from: sx, sy, to: m.x, m.y)
            walks[m.userId] = Walk(from: here, steps: steps.isEmpty ? [(m.x, m.y)] : steps, start: Date())
        } else {
            walks[m.userId] = nil
        }
    }

    // MARK: Drawing helpers

    /// Where someone is drawn right now (tiles, fractional while walking).
    func displayPosition(_ id: String, at now: Date) -> (x: Double, y: Double)? {
        guard let m = members[id] else { return nil }
        guard let w = walks[id], !w.steps.isEmpty else { return (Double(m.x), Double(m.y)) }
        let t = now.timeIntervalSince(w.start) / Self.stepTime
        if t >= Double(w.steps.count) { return (Double(m.x), Double(m.y)) }
        let i = max(0, Int(t))
        let from: (x: Double, y: Double) = i == 0 ? w.from : (Double(w.steps[i - 1].0), Double(w.steps[i - 1].1))
        let to = w.steps[i]
        let f = t - Double(i)
        return (from.x + (Double(to.0) - from.x) * f, from.y + (Double(to.1) - from.y) * f)
    }

    /// Walking frame: 0 standing, 1/2 mid-step.
    func step(_ id: String, at now: Date) -> Int {
        guard let w = walks[id] else { return 0 }
        let t = now.timeIntervalSince(w.start) / Self.stepTime
        if t >= Double(w.steps.count) { return 0 }
        return t - Double(Int(t)) < 0.5 ? 1 : 2
    }

    /// Facing for a walker: the direction of the current step.
    func facing(_ id: String, at now: Date) -> RoomGeometry.Dir {
        guard let w = walks[id], !w.steps.isEmpty else { return members[id]?.mode == "text" ? .up : .down }
        let t = now.timeIntervalSince(w.start) / Self.stepTime
        let i = min(w.steps.count - 1, max(0, Int(t)))
        let from = i == 0 ? (Int(w.from.x.rounded()), Int(w.from.y.rounded())) : w.steps[i - 1]
        let to = w.steps[i]
        if to.0 > from.0 { return .right }
        if to.0 < from.0 { return .left }
        return to.1 < from.1 ? .up : .down
    }

    /// Until when something on the map moves smoothly (a walk, a floating reaction). After
    /// that only the beagle moves, a step every 0.45 s: the map can be drawn that often
    /// instead of 30 times a second (a speech bubble stands still; it goes at the next step).
    var busyUntil: Date {
        var until = Date.distantPast
        for w in walks.values {
            until = max(until, w.start.addingTimeInterval(Double(w.steps.count) * Self.stepTime))
        }
        for list in reactions.values {
            for r in list { until = max(until, r.at.addingTimeInterval(1.8)) }
        }
        return until
    }

    func bubble(_ id: String, at now: Date) -> String? {
        guard let b = bubbles[id], b.until > now else { return nil }
        return b.text
    }

    func floating(_ id: String, at now: Date) -> [(emoji: String, age: Double)] {
        (reactions[id] ?? []).map { ($0.emoji, now.timeIntervalSince($0.at)) }.filter { $0.1 < 1.8 }
    }

    /// Someone said something in the chat: show it over their head.
    func chatSaid(_ userId: String?, _ text: String, photos: Bool) {
        guard let userId, members[userId] != nil else { return }
        // Same as the web (room-logic.ts bubbleText).
        let flat = text.split(whereSeparator: \.isWhitespace).joined(separator: " ")
        guard !flat.isEmpty || photos else { return }
        let t = flat.isEmpty ? "📷" : (flat.count > 48 ? String(flat.prefix(47)) + "…" : flat)
        bubbles[userId] = (t, Date().addingTimeInterval(4.5))
        revision += 1
    }

    private func react(_ id: String, _ emoji: String) {
        var list = (reactions[id] ?? []).filter { Date().timeIntervalSince($0.at) < 1.8 }
        list.append((emoji, Date()))
        reactions[id] = list
    }

    var zoneName: String? {
        guard let geo = geometry, let m = me, m.inRoom else { return nil }
        return geo.zone(m.x, m.y)?.name
    }

    /// Who I hear and how loud (for the "聞こえている人" list).
    var heard: [(member: RoomMember, volume: Double)] {
        guard let geo = geometry, let m = me, m.inRoom, listening else { return [] }
        return members.values.filter { $0.userId != m.userId && $0.inRoom && $0.listening }
            .map { ($0, geo.audibility(listener: (m.x, m.y), speaker: ($0.x, $0.y))) }
            .filter { $0.1 > 0 }
            .sorted { $0.1 > $1.1 }
    }

    /// People in the voice (the text view's banner).
    var inVoice: [RoomMember] { members.values.filter { $0.inRoom && $0.listening }.sorted { $0.name < $1.name } }

    // MARK: Enter / leave

    func enter() async {
        guard enabled, mode == .text, !entering else { return }
        notice = nil
        entering = true
        defer { entering = false }
        do {
            let r: RoomActionResponse
            if offline, let id = meId, var m = members[id], let geo = geometry {
                m.mode = "room"; m.x = 15; m.y = 9; m.listening = listening
                r = RoomActionResponse(ok: true, member: m, from: geo.map.door, to: .init(x: 15, y: 9))
            } else {
                r = try await api.roomAction(["action": "enter", "listening": listening])
            }
            guard let m = r.member else { notice = r.error ?? "部室に入れませんでした"; return }
            mode = .room
            let door = r.from ?? geometry.map { RoomMapInfo.Spot(x: $0.map.door.x, y: $0.map.door.y) } ?? RoomMapInfo.Spot(x: m.x, y: m.y)
            members[m.userId] = m
            if let geo = geometry {
                walks[m.userId] = Walk(from: (Double(door.x), Double(door.y)), steps: geo.path(from: door.x, door.y, to: m.x, m.y), start: Date())
            }
            revision += 1
            entering = false
            if listening { await joinVoiceForRoom() }
            await applyProximityNow()
        } catch {
            notice = "部室に入れませんでした"
        }
    }

    /// サーバの再起動で私が忘れられたとき: テキストに戻さず、部室に入り直す（音声は切らない）。10 秒に 1 回まで。
    private func rejoinAfterRestart() {
        guard !entering, !offline, rejoinGate.allow() else { return }
        Task { await reenter() }
    }

    private func reenter() async {
        guard mode == .room, !entering else { return }
        entering = true
        defer { entering = false }
        guard let r = try? await api.roomAction(["action": "enter", "listening": listening]), let m = r.member else { return }
        guard mode == .room else { return }
        members[m.userId] = m
        if let geo = geometry, let door = r.from {
            walks[m.userId] = Walk(from: (Double(door.x), Double(door.y)), steps: geo.path(from: door.x, door.y, to: m.x, m.y), start: Date())
        }
        revision += 1
        if voice.micOn {
            // サーバは私のマイクも忘れている: オンを送り直す（断られたら、こちらも切る）
            do {
                let r = try await api.roomAction(["action": "voice", "mic": true])
                if let m = r.member { received(m) }
            } catch {
                await voice.setMic(false)
                stageAuto = false
            }
        }
        if listening && !voice.inRoom { await joinVoiceForRoom() }
        await applyProximityNow()
    }

    /// 部室の音声に入る。一度でつながらなければ 2 秒後にもう一度（会員資格が確認できないときは試し直さない）。
    /// それでもだめなら見るだけに。
    private func joinVoiceForRoom() async {
        voice.clubRoom = true
        await voice.join()
        if wantsVoice, voice.phase == .idle, !voice.membershipEnded {
            try? await Task.sleep(for: .seconds(2))
            if wantsVoice, voice.phase == .idle {
                voice.clubRoom = true
                await voice.join()
            }
        }
        if wantsVoice, voice.phase == .idle { fallBackToSeeOnly() }
    }

    /// 部室で聞いているつもり。
    private var wantsVoice: Bool { mode == .room && listening && !offline }

    /// つながっていた音声が切れた（VoiceStore.onDropped）: 見るだけに落とす前に、1 回自動で入り直す（30 秒に 1 回まで）。
    /// 管理者に退出させられたときは入り直さない（別の端末で続けたときは onContinuedElsewhere の側）。
    private func voiceDropped(removed: Bool) {
        guard wantsVoice else { return }
        stageAuto = false
        if !removed, voiceRejoinGate.allow() {
            // 大勢が同時に切れたときに一斉に入り直さないよう、0〜3 秒ずらす
            let wait = Double.random(in: 0...3)
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(wait))
                guard let self, self.wantsVoice, self.voice.phase == .idle else { return }
                await self.joinVoiceForRoom()
                await self.applyProximityNow()
            }
        } else {
            fallBackToSeeOnly()
        }
    }

    /// 見るだけにする（端末に覚えた「聞く」はそのまま。次に入るときはまた聞く）。
    private func fallBackToSeeOnly() {
        listening = false
        resetStage()
        notice = voice.notice ?? "ボイスにつながりませんでした（見るだけにしました）"
        let api = self.api
        Task { [weak self] in
            if let r = try? await api.roomAction(["action": "voice", "listening": false]), let m = r.member { self?.received(m) }
        }
    }

    func toText() async {
        guard mode == .room else { return }
        myWalk?.cancel()
        myWalk = nil
        mode = .text
        resetStage()
        if voice.inRoom { await voice.leave() }
        if offline, let id = meId { members[id]?.mode = "text"; members[id]?.x = 8; members[id]?.y = 3; walks[id] = nil }
        else if let r = try? await api.roomAction(["action": "text"]), let m = r.member { members[m.userId] = m; walks[m.userId] = nil }
        revision += 1
    }

    func setListening(_ on: Bool) async {
        listening = on
        UserDefaults.standard.set(on, forKey: "roomListening")
        guard mode == .room else { return }
        if let r = try? await api.roomAction(["action": "voice", "listening": on]), let m = r.member { received(m) }
        if on { await joinVoiceForRoom() } else { resetStage(); await voice.leave() }
        applyProximity()
    }

    func setMic(_ on: Bool) async {
        guard mode == .room else { return }
        if on {
            if !listening { await setListening(true) }
            do {
                let r = try await api.roomAction(["action": "voice", "mic": true])
                if let m = r.member { received(m) }
            } catch let e as APIError {
                if case let .http(_, _, message) = e { notice = message ?? "マイクを使えません" } else { notice = "マイクを使えません" }
                return
            } catch {
                return
            }
            await applyProximityNow()
            await voice.setMic(true)
        } else {
            await voice.setMic(false)
            if let r = try? await api.roomAction(["action": "voice", "mic": false]), let m = r.member { received(m) }
        }
    }

    /// 「🎧 音声をこの端末で続ける」 tapped (voice_handoff): into the room with its sound on, the mic as the
    /// other device had it.
    func continueHere(mic: Bool) async {
        notice = nil
        if !listening { await setListening(true) }
        if mode == .text { await enter() } else if !voice.inRoom { await joinVoiceForRoom() }
        if mic, mode == .room { await setMic(true) }
    }

    func sendReaction(_ emoji: String, to: String? = nil) {
        guard let id = meId else { return }
        react(id, emoji)
        if let to { react(to, emoji) }
        revision += 1
        let api = self.api
        Task {
            var body: [String: Any] = ["action": "react", "emoji": emoji]
            if let to { body["to"] = to }
            _ = try? await api.roomAction(body)
        }
    }

    // MARK: Walking

    /// Walk to a tile (or next to it when it is furniture or someone's spot).
    func walk(toX tx: Int, y ty: Int) {
        guard mode == .room, let geo = geometry, let m = me else { return }
        let blocked = Set(members.values.filter { $0.inRoom && $0.userId != m.userId }.map { $0.y * geo.map.w + $0.x })
        var target = (tx, ty)
        if !geo.walkable(tx, ty) || blocked.contains(ty * geo.map.w + tx) {
            let near = RoomGeometry.Dir.allCases.map { (tx + $0.delta.0, ty + $0.delta.1) }
                .filter { geo.walkable($0.0, $0.1) && !blocked.contains($0.1 * geo.map.w + $0.0) }
                .sorted { hypot(Double($0.0 - m.x), Double($0.1 - m.y)) < hypot(Double($1.0 - m.x), Double($1.1 - m.y)) }
            guard let n = near.first else { return }
            target = n
        }
        let steps = geo.path(from: m.x, m.y, to: target.0, target.1, blocked: blocked)
        run(steps)
    }

    /// One step in a direction (D-pad / arrow keys). Ignored while a step is under way.
    func nudge(_ d: RoomGeometry.Dir) {
        guard mode == .room, myWalk == nil, let geo = geometry, let m = me else { return }
        let nx = m.x + d.delta.0, ny = m.y + d.delta.1
        guard geo.walkable(nx, ny), !members.values.contains(where: { $0.inRoom && $0.userId != m.userId && $0.x == nx && $0.y == ny }) else { return }
        run([(nx, ny)])
    }

    var isWalking: Bool { myWalk != nil }

    private func run(_ steps: [(Int, Int)]) {
        myWalk?.cancel()
        guard let id = meId, let m = members[id], !steps.isEmpty else { myWalk = nil; return }
        let from = displayPosition(id, at: Date()) ?? (Double(m.x), Double(m.y))
        walks[id] = Walk(from: from, steps: steps, start: Date())
        revision += 1
        myWalk = Task { [weak self] in
            for (x, y) in steps {
                guard let self, !Task.isCancelled else { return }
                self.members[id]?.x = x
                self.members[id]?.y = y
                self.applyProximity()
                let api = self.api
                if !self.offline {
                    Task {
                        do {
                            _ = try await api.roomAction(["action": "move", "x": x, "y": y])
                            // ステージの乗り降り（サーバが位置を知ってから）
                            self.stageCheck()
                        } catch { await self.load() }
                    }
                }
                try? await Task.sleep(for: .seconds(Self.stepTime))
            }
            self?.myWalk = nil
        }
    }

    // MARK: ステージの自動マイク（ドリキン 2026-11-08、Web と同じ）

    /// マイクのボタン（本人の操作）。ステージの上で切ったら、ステージを出るまで自動では入れない。
    /// 自分で入れたマイクは、ステージを降りても切らない。
    func userSetMic(_ on: Bool) async {
        stageAuto = false
        stageTimer?.cancel()
        stageTimer = nil
        if !on, onStage { stageSuppressed = true }
        await setMic(on)
        // 許可を拒否されたなど、入れられなかった
        if on, !voice.micOn, onStage { stageSuppressed = true }
    }

    private var onStage: Bool {
        guard let geo = geometry, let m = me, m.inRoom else { return false }
        return geo.zone(m.x, m.y)?.kind == "stage"
    }

    /// 見るだけ・音声につながっていない・マイクを切り替えている最中は何もしない。
    private var stageReady: Bool {
        mode == .room && listening && (me?.listening ?? false) && voice.phase == .connected && !voice.micBusy && !offline
    }

    private func resetStage() {
        stageTimer?.cancel()
        stageTimer = nil
        stageAuto = false
        stageSuppressed = false
    }

    /// 今いる場所から「あるべき状態」を決め直す（位置がサーバに届いたあと・自動の切り替えのあと）。
    func stageCheck() {
        let here = onStage
        if !here {
            stageSuppressed = false
            stageTimer?.cancel()
            stageTimer = nil
        }
        if stageAuto && !voice.micOn { stageAuto = false } // サーバや管理者に切られた
        guard !stageBusy, stageReady else { return }
        switch StageMic.decide(onStage: here, micOn: voice.micOn, auto: stageAuto, suppressed: stageSuppressed) {
        case .turnOff:
            Task { await stageSwitch(false) }
        case .scheduleOn:
            // 1 秒立ち止まったら（歩く途中で通っただけでは入れない）。一歩ごとに待ち直す
            stageTimer?.cancel()
            stageTimer = Task { [weak self] in
                try? await Task.sleep(for: .seconds(StageMic.dwell))
                guard let self, !Task.isCancelled else { return }
                self.stageTimer = nil
                guard self.myWalk == nil, self.onStage else { return }
                await self.stageSwitch(true)
            }
        case .none:
            break
        }
    }

    private func stageSwitch(_ on: Bool) async {
        guard !stageBusy, stageReady else { return }
        let want = StageMic.decide(onStage: onStage, micOn: voice.micOn, auto: stageAuto, suppressed: stageSuppressed)
        guard want == (on ? .scheduleOn : .turnOff) else { stageCheck(); return }
        stageBusy = true
        if on {
            await setMic(true)
            if voice.micOn {
                stageAuto = true
                flash("ステージに上がったので、マイクをオンにしました（部室の全員に届きます）。🎙 で切れます")
                voice.playSfx(.join, mine: true)
            } else {
                stageSuppressed = true // 許可がない・上限など。今のマイクのボタンと同じ知らせ
            }
        } else {
            await setMic(false)
            stageAuto = false
            flash("ステージを降りたので、マイクを切りました")
        }
        stageBusy = false
        stageCheck() // 上がる・降りるを素早く繰り返しても食い違わないように
    }

    /// 普通の知らせ（エラーではない）を 6 秒ほど出して消す。
    private func flash(_ text: String) {
        notice = text
        noticeTask?.cancel()
        noticeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(6))
            guard let self, !Task.isCancelled, self.notice == text else { return }
            self.notice = nil
        }
    }

    // MARK: Voice: who I hear, who may hear me

    /// Batched: volumes for everyone I hear, and the people allowed to receive my mic.
    func applyProximity() {
        guard enabled, proximityTask == nil else { return }
        proximityTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(120))
            guard let self else { return }
            self.proximityTask = nil
            await self.applyProximityNow()
        }
    }

    /// Right away (before the mic goes live, the permission must already be in place).
    func applyProximityNow() async {
        guard let geo = geometry, let m = me, m.inRoom, voice.inRoom else { return }
        var volumes: [String: Double] = [:]
        var allowed: Set<String> = []
        for other in members.values where other.userId != m.userId && other.inRoom {
            volumes[other.userId] = geo.audibility(listener: (m.x, m.y), speaker: (other.x, other.y))
            if other.listening, geo.audibility(listener: (other.x, other.y), speaker: (m.x, m.y)) > 0 { allowed.insert(other.userId) }
        }
        await voice.applyProximity(volumes: volumes, allowed: allowed)
    }

    // MARK: Demo (debug builds)

    #if DEBUG
    /// Sample room for offline UI checks (no server).
    func debugLoadDemo(meId: String = "me") {
        enabled = true
        offline = true
        self.meId = meId
        var tiles: [String] = []
        let w = 32, h = 20
        for y in 0..<h {
            var row = ""
            for x in 0..<w {
                let edge = x == 0 || y == 0 || x == w - 1 || y == h - 1
                var t: Character = edge ? "#" : "."
                if y == 0 && [3, 4, 9, 10, 15, 16, 21, 22].contains(x) { t = "w" }
                if y == h - 1 && (x == 15 || x == 16) { t = "D" }
                if y == 1 && (1...4).contains(x) { t = "B" }
                if (y == 2 || y == 5) && (6...17).contains(x) { t = "C" }
                if (y == 3 || y == 6) && (6...17).contains(x) { t = "s" }
                if (1...4).contains(y) && (23...30).contains(x) { t = "S" }
                if y == 2 && x == 26 { t = "M" }
                if (12...13).contains(y) && (4...9).contains(x) { t = "T" }
                if (y == 11 || y == 14) && (4...9).contains(x) { t = "c" }
                if (12...13).contains(y) && (x == 3 || x == 10) { t = "c" }
                if (11...16).contains(y) && (14...20).contains(x) { t = "," }
                if y == 17 && (15...19).contains(x) { t = "F" }
                if x == 30 && (y == 8 || y == 9) { t = "V" }
                if [(1, 18), (30, 18), (1, 8), (20, 1)].contains(where: { $0 == (x, y) }) { t = "P" }
                if y == 17 && (x == 26 || x == 27) { t = "b" }
                row.append(t)
            }
            tiles.append(row)
        }
        let map = RoomMapInfo(w: w, h: h, tiles: tiles,
                              zones: [.init(kind: "table", name: "会議テーブル", x: 2, y: 10, w: 10, h: 7),
                                      .init(kind: "stage", name: "ステージ", x: 23, y: 1, w: 8, h: 4)],
                              door: .init(x: 15, y: 18), seats: [], labels: [.init(name: "チャット席", x: 6, y: 1)], hearRadius: 4)
        geometry = RoomGeometry(map: map)
        func p(_ id: String, _ name: String, _ x: Int, _ y: Int, _ mode: String = "room", mic: Bool = false) -> RoomMember {
            RoomMember(userId: id, name: name, avatar: nil, x: x, y: y, mode: mode, listening: mode == "room", mic: mic, away: false)
        }
        for m in [p(meId, "あなた", 8, 3, "text"), p("mazzo", "mazzo", 5, 11), p("takuto", "takuto", 6, 14, mic: true),
                  p("norio", "NORIO TAKAHASHI", 26, 3, mic: true), p("tochi", "tochi", 16, 12), p("ryu", "リュー", 18, 14),
                  p("eiko", "EIKO", 6, 3, "text"), p("shoichi", "Shoichi", 12, 6, "text")] {
            members[m.userId] = m
        }
        bubbles["norio"] = ("みなさん聞こえますかー", Date().addingTimeInterval(30))
        revision += 1
    }
    #endif
}
