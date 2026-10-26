import AVFoundation
import Foundation

// 🍻 チャットの読み上げ (docs/offkai-spec.md「チャットの読み上げ」): while this device is in the event's sound
// (listening or speaking) and its 「🔈 チャットを読み上げる」 is on, new chat messages are read aloud on the
// device (AVSpeechSynthesizer, a Japanese voice). Nothing is sent anywhere. One at a time, oldest first;
// a message that has waited 2 minutes is dropped when its turn comes. No count cap.

/// The words for one message, and the queue's rule — pure, so the tests can run them (BguruChatTests).
enum ChatSpeech {
    // MARK: 声（docs/offkai-spec.md「声の選び方」）

    /// One Japanese voice on this device, as the chooser sees it (`quality`: 1 標準・2 拡張・3 プレミアム).
    struct VoiceInfo: Equatable {
        var id: String
        var name: String
        var language: String
        var quality: Int
        var novelty: Bool
    }

    /// The chosen voice's identifier (UserDefaults; none = 自動). Per device.
    static let voiceKey = "chatVoice"
    static let previewText = "みなさん、こんばんは。チャットを読み上げます。"
    private static let knownVoices: Set<String> = ["O-ren", "Kyoko", "Otoya", "Hattori"]

    /// 自動: quality → a well-known natural voice → ja-JP → the list's order. Novelty voices only when nothing
    /// else is there. A chosen voice that is gone falls back to 自動.
    static func pickVoice(_ voices: [VoiceInfo], preferred: String?) -> VoiceInfo? {
        let ja = voices.filter { $0.language.hasPrefix("ja") }
        if let preferred, let hit = ja.first(where: { $0.id == preferred }) { return hit }
        func score(_ v: VoiceInfo) -> Int {
            v.novelty ? 0 : v.quality * 10 + (knownVoices.contains(v.name) ? 2 : 0) + (v.language == "ja-JP" ? 1 : 0)
        }
        var best: VoiceInfo?
        for v in ja where best.map({ score(v) > score($0) }) ?? true { best = v }
        return best
    }

    /// This device's Japanese voices, best first (the chooser's list).
    static func japaneseVoices() -> [VoiceInfo] {
        AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix("ja") }
            .map { v in
                VoiceInfo(id: v.identifier, name: v.name, language: v.language,
                          quality: v.quality == .premium ? 3 : v.quality == .enhanced ? 2 : 1,
                          novelty: v.voiceTraits.contains(.isNoveltyVoice) || v.identifier.contains("eloquence"))
            }
            .sorted { ($0.novelty ? 1 : 0, -$0.quality, $0.name) < ($1.novelty ? 1 : 0, -$1.quality, $1.name) }
    }

    /// The voice to read with now (the chosen one, else 自動). nil: no Japanese voice (the system default).
    static func currentVoice() -> AVSpeechSynthesisVoice? {
        let chosen = UserDefaults.standard.string(forKey: voiceKey)
        guard let v = pickVoice(japaneseVoices(), preferred: chosen) else { return AVSpeechSynthesisVoice(language: "ja-JP") }
        return AVSpeechSynthesisVoice(identifier: v.id)
    }

    /// Longer bodies are cut here and end in 「、以下略」.
    static let maxBodyLength = 80
    /// A message that waited this long is not read (do not read an old conversation on and on).
    static let maxWait: TimeInterval = 120

    /// The same person again within this long (from when this device began reading their last one): no name.
    static let sameSpeakerWindow: TimeInterval = 60

    /// 「〇〇さん、本文」 with the call name (`callName`, or `nickname` from the on-device model). URLs read
    /// 「リンク」; over 80 code points → cut + 「、以下略」. Photos only → 「〇〇さんが写真を送りました」 (photos + text
    /// read the text). No name → the body alone. `sameSpeaker` (the one read just before, within 60 s): the body
    /// alone, photos only → 「写真です」. nil: nothing to read.
    static func utterance(name rawName: String?, body rawBody: String, hasPhotos: Bool,
                          sameSpeaker: Bool = false, nickname: String? = nil) -> String? {
        // The server's stand-in body for a photo-only message (ChatMessage.displayBody).
        let given = (hasPhotos && rawBody.trimmingCharacters(in: .whitespacesAndNewlines) == "📷 写真") ? "" : rawBody
        let body = spokenBody(given)
        let call = sameSpeaker ? "" : (nickname.map(withHonorific) ?? callName(rawName ?? "").spoken)
        if body.isEmpty {
            guard hasPhotos else { return nil }
            if sameSpeaker { return "写真です" }
            return call.isEmpty ? "写真が送られました" : "\(call)が写真を送りました"
        }
        return call.isEmpty ? body : "\(call)、\(body)"
    }

    // MARK: Call names (the same steps on Web and Android; docs/offkai-spec.md「賢い読み方」)

    struct CallName: Equatable {
        /// The name to say, without さん (empty: no name).
        var base: String
        /// What is said: base + 「さん」 unless it already ends in an honorific.
        var spoken: String
        /// Step 4 cut it (still long): the Apple apps may ask the on-device model for a nickname.
        var wasCut: Bool
    }

    static let maxNameLength = 8
    static let cutNameLength = 6
    private static let honorifics = ["さん", "様", "さま", "氏", "くん", "君", "ちゃん", "先生"]

    /// 1. drop what is in brackets 2. drop leading @ / ＠, split at separators, 3. the first part with a letter
    /// or digit 4. over 8 code points → the first 6 5. nothing left → the whole name (spaces as one) cut to 6
    /// 6. no 「さん」 after an honorific.
    static func callName(_ raw: String) -> CallName {
        var s = raw
        for p in [#"（[^（）]*）"#, #"\([^()]*\)"#, #"【[^【】]*】"#, #"\[[^\[\]]*\]"#, #"「[^「」]*」"#, #"『[^『』]*』"#, #"〔[^〔〕]*〕"#] {
            s = s.replacingOccurrences(of: p, with: "", options: .regularExpression)
        }
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        while let f = s.first, f == "@" || f == "＠" { s.removeFirst() }
        let parts = s.components(separatedBy: CharacterSet(charactersIn: "／/|｜・:：@＠～〜").union(.whitespacesAndNewlines))
        var base = parts.first { !$0.isEmpty && hasLetterOrDigit($0) } ?? ""
        var cut = false
        if base.unicodeScalars.count > maxNameLength {
            base = prefix(base, cutNameLength)
            cut = true
        }
        if base.isEmpty {
            let whole = raw.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            base = prefix(whole, cutNameLength).trimmingCharacters(in: .whitespacesAndNewlines)
        }
        return CallName(base: base, spoken: base.isEmpty ? "" : withHonorific(base), wasCut: cut)
    }

    /// 「さん」 unless the name already ends in one (さん・様・さま・氏・くん・君・ちゃん・先生).
    static func withHonorific(_ name: String) -> String {
        honorifics.contains { name.hasSuffix($0) } ? name : name + "さん"
    }

    /// A nickname from the on-device model is used only when it is 1–8 code points, one line, has a letter or
    /// digit, carries no honorific of its own (dropped if it does) and — stricter than the spec, against made-up
    /// names — is a part of the display name as written (ignoring case). nil: use the rule's name.
    static func acceptNickname(_ raw: String?, for name: String) -> String? {
        guard var n = raw?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty, !n.contains(where: \.isNewline) else { return nil }
        n = n.trimmingCharacters(in: CharacterSet(charactersIn: "「」『』\"'“”"))
        for h in honorifics where n.hasSuffix(h) && n.count > h.count { n.removeLast(h.count); break }
        guard (1...maxNameLength).contains(n.unicodeScalars.count), hasLetterOrDigit(n),
              name.range(of: n, options: [.caseInsensitive, .widthInsensitive]) != nil else { return nil }
        return n
    }

    private static func hasLetterOrDigit(_ s: String) -> Bool {
        s.unicodeScalars.contains { CharacterSet.letters.contains($0) || CharacterSet.decimalDigits.contains($0) }
    }

    private static func prefix(_ s: String, _ n: Int) -> String {
        String(String.UnicodeScalarView(s.unicodeScalars.prefix(n)))
    }

    /// The body as read: URLs → 「リンク」, lines and runs of spaces → one space, then the 80-character cut.
    /// Same rules as Web and Android: a URL is `https?://` and the printable ASCII after it (`[!-~]+`, so a
    /// Japanese 「）」 or word right after it stays); the 80 are counted in Unicode code points.
    static func spokenBody(_ raw: String) -> String {
        var s = raw.replacingOccurrences(of: #"https?://[!-~]+"#, with: "リンク", options: .regularExpression)
        s = s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression)
        s = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard s.unicodeScalars.count > maxBodyLength else { return s }
        let head = String(String.UnicodeScalarView(s.unicodeScalars.prefix(maxBodyLength)))
        return head.trimmingCharacters(in: .whitespacesAndNewlines) + "、以下略"
    }

    /// How long one line may take before the reader gives up waiting for the synthesizer's word (a call or an
    /// audio-session change can swallow didFinish): 0.2 s a character + 5 s.
    static func watchdog(for text: String) -> TimeInterval {
        Double(text.unicodeScalars.count) * 0.2 + 5
    }

    /// The queue's next turn: items that arrived more than 2 minutes before `now` are dropped first.
    /// Returns the index of the first one still worth reading (nil: none) and how many to drop before it.
    static func nextTurn(arrivals: [Date], now: Date) -> (index: Int?, dropped: Int) {
        var dropped = 0
        for (i, at) in arrivals.enumerated() {
            if now.timeIntervalSince(at) > maxWait { dropped += 1; continue }
            return (i, dropped)
        }
        return (nil, dropped)
    }
}

/// Reads queued lines one after another. Main-actor only.
///
/// iPhone: the synthesizer plays through the app's own audio session (`usesApplicationAudioSession = true`,
/// set explicitly) and never changes its category. While this device is in the 🍻 sound, LiveKit owns that
/// session (playback + mixWithOthers when listening, playAndRecord / voiceChat when speaking) and keeps it
/// active, so the voice simply mixes into what is already playing: no second session, no interruption of the
/// LiveKit audio, and LiveKit's route (speaker / AirPods) is the one used. With `false` the synthesizer would
/// activate a session of its own, which can interrupt or duck the call's session. The Mac has no audio session.
@MainActor
final class ChatSpeaker: NSObject {
    /// One message to read. The words are made when its turn comes (the name depends on who was read before).
    struct Item {
        var authorId: String?
        var name: String?
        var body: String
        var hasPhotos: Bool
        var arrived = Date()
    }

    private var queue: [Item] = []
    private var current: AVSpeechUtterance?
    /// Waiting (at most ~1.5 s) for the on-device model's nickname before reading.
    private var preparing = false
    /// Bumped by stop(): a nickname that comes back after it is not read.
    private var generation = 0
    /// Who was read last, and when that began (「同じ人が続けたら名前を省く」).
    private var lastAuthor: (id: String, at: Date)?

    /// The on-device model's nickname for a long name (ChatStore sets it; nil: rule names only). Never blocks
    /// reading longer than `nicknameWait`.
    var nicknamer: (@MainActor (String) async -> String?)?
    static let nicknameWait: Duration = .milliseconds(1500)
    /// authorId + name → the accepted nickname ("" = asked, none usable). A new name asks again.
    private var nicknames: [String: String] = [:]
    private var asking: [String: Task<String?, Never>] = [:]
    /// Moves on if the synthesizer never reports the current line finished (ChatSpeech.watchdog).
    private var watchdog: Task<Void, Never>?
    private var synth: AVSpeechSynthesizer?

    /// Waiting or being read now.
    var isBusy: Bool { current != nil || preparing || !queue.isEmpty }

    func enqueue(_ item: Item) {
        guard ChatSpeech.utterance(name: item.name, body: item.body, hasPhotos: item.hasPhotos) != nil else { return }
        queue.append(item)
        askNickname(for: item) // starts now, so it is usually ready by its turn
        if current == nil, !preparing { speakNext() }
    }

    private static func nicknameKey(_ item: Item) -> String? {
        guard let name = item.name, ChatSpeech.callName(name).wasCut else { return nil }
        return (item.authorId ?? "") + "\u{1F}" + name
    }

    private func askNickname(for item: Item) {
        guard let nicknamer, let key = Self.nicknameKey(item), let name = item.name,
              nicknames[key] == nil, asking[key] == nil else { return }
        asking[key] = Task { [weak self] in
            let n = ChatSpeech.acceptNickname(await nicknamer(name), for: name)
            self?.nicknames[key] = n ?? ""
            self?.asking[key] = nil
            return n
        }
    }

    /// Stop mid-sentence and forget everything waiting.
    func stop() {
        #if DEBUG
        if isBusy { NSLog("[offkai-read] stop (%d waiting dropped)", queue.count) }
        #endif
        queue.removeAll()
        generation += 1
        preparing = false
        watchdog?.cancel()
        watchdog = nil
        guard current != nil else { return }
        current = nil
        synth?.stopSpeaking(at: .immediate)
    }

    private func speakNext() {
        let turn = ChatSpeech.nextTurn(arrivals: queue.map(\.arrived), now: Date())
        guard let i = turn.index else { queue.removeAll(); current = nil; return }
        let item = queue[i]
        queue.removeFirst(i + 1)
        #if DEBUG
        if turn.dropped > 0 { NSLog("[offkai-read] %d dropped (waited over 2 min)", turn.dropped) }
        #endif
        let now = Date()
        let same = item.authorId.map { id in lastAuthor.map { $0.id == id && now.timeIntervalSince($0.at) <= ChatSpeech.sameSpeakerWindow } ?? false } ?? false
        // A long name not yet given a nickname: wait for the model a little (never past nicknameWait).
        if !same, let key = Self.nicknameKey(item), nicknames[key] == nil, let task = asking[key] {
            preparing = true
            let gen = generation
            Task { [weak self] in
                let nick = await Self.first(within: Self.nicknameWait, task)
                guard let self, self.generation == gen, self.preparing else { return }
                self.preparing = false
                self.say(item, sameSpeaker: false, nickname: nick)
            }
            return
        }
        say(item, sameSpeaker: same, nickname: Self.nicknameKey(item).flatMap { nicknames[$0] }.flatMap { $0.isEmpty ? nil : $0 })
    }

    private func say(_ item: Item, sameSpeaker: Bool, nickname: String?) {
        guard let text = ChatSpeech.utterance(name: item.name, body: item.body, hasPhotos: item.hasPhotos,
                                              sameSpeaker: sameSpeaker, nickname: nickname) else {
            if !queue.isEmpty { speakNext() }
            return
        }
        if let id = item.authorId { lastAuthor = (id, Date()) } else { lastAuthor = nil }
        let s = synth ?? makeSynth()
        let u = AVSpeechUtterance(string: text)
        u.voice = ChatSpeech.currentVoice() // 選んだ声・自動（その時点で入っている声。設定の変更もすぐ効く）
        current = u
        #if DEBUG
        NSLog("[offkai-read] speak (%d waiting): %@", queue.count, text)
        #endif
        s.speak(u)
        watchdog?.cancel()
        let limit = ChatSpeech.watchdog(for: text)
        watchdog = Task { [weak self] in
            try? await Task.sleep(for: .seconds(limit))
            guard !Task.isCancelled else { return }
            self?.timedOut(u)
        }
    }

    /// No didFinish / didCancel in time: treat the line as done (only if it is still the one being read).
    private func timedOut(_ u: AVSpeechUtterance) {
        guard let current, current === u else { return }
        #if DEBUG
        NSLog("[offkai-read] no word from the synthesizer, moving on: %@", u.speechString)
        #endif
        self.current = nil
        watchdog = nil
        synth?.stopSpeaking(at: .immediate) // its late didCancel is ignored (no longer current)
        if !queue.isEmpty { speakNext() }
    }

    /// The value, or nil if it takes longer than `limit` (the work goes on and still fills the cache).
    /// (Not a task group: that would wait for the model before returning.)
    private static func first(within limit: Duration, _ task: Task<String?, Never>) async -> String? {
        await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            let once = ResumeOnce(c)
            Task.detached { once.resume(await task.value) }
            Task.detached { try? await Task.sleep(for: limit); once.resume(nil) }
        }
    }

    private func makeSynth() -> AVSpeechSynthesizer {
        let s = AVSpeechSynthesizer()
        #if os(iOS)
        s.usesApplicationAudioSession = true // see the type's note: mix into LiveKit's session, never take it
        s.mixToTelephonyUplink = false // not sent to the room (the speaker's mic may still pick it up from the speaker)
        #endif
        s.delegate = self
        synth = s
        return s
    }

    private func finished(_ u: AVSpeechUtterance) {
        #if DEBUG
        NSLog("[offkai-read] done%@: %@", current === u ? "" : " (stopped)", u.speechString)
        #endif
        guard let current, current === u else { return } // a stop() or the watchdog already moved on
        self.current = nil
        watchdog?.cancel()
        watchdog = nil
        if !queue.isEmpty { speakNext() }
    }
}

extension ChatSpeaker: AVSpeechSynthesizerDelegate {
    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        let u = UncheckedUtterance(utterance)
        Task { @MainActor [weak self] in self?.finished(u.value) }
    }

    nonisolated func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance) {
        let u = UncheckedUtterance(utterance)
        Task { @MainActor [weak self] in self?.finished(u.value) }
    }
}

/// The utterance only goes back to the main actor to be compared by identity.
private struct UncheckedUtterance: @unchecked Sendable {
    let value: AVSpeechUtterance
    init(_ v: AVSpeechUtterance) { value = v }
}

/// Resumes a continuation once, from whichever side comes first.
private final class ResumeOnce: @unchecked Sendable {
    private let lock = NSLock()
    private var c: CheckedContinuation<String?, Never>?
    init(_ c: CheckedContinuation<String?, Never>) { self.c = c }
    func resume(_ v: String?) {
        lock.lock()
        let pending = c
        c = nil
        lock.unlock()
        pending?.resume(returning: v)
    }
}
