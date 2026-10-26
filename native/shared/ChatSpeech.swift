import AVFoundation
import Foundation

// 🍻 チャットの読み上げ (docs/offkai-spec.md「チャットの読み上げ」): while this device is in the event's sound
// (listening or speaking) and its 「🔈 チャットを読み上げる」 is on, new chat messages are read aloud on the
// device (AVSpeechSynthesizer, a Japanese voice). Nothing is sent anywhere. One at a time, oldest first;
// a message that has waited 2 minutes is dropped when its turn comes. No count cap.

/// The words for one message, and the queue's rule — pure, so the tests can run them (BguruChatTests).
enum ChatSpeech {
    /// Longer bodies are cut here and end in 「、以下略」.
    static let maxBodyLength = 80
    /// A message that waited this long is not read (do not read an old conversation on and on).
    static let maxWait: TimeInterval = 120

    /// 「〇〇さん、本文」. URLs read 「リンク」; over 80 characters → cut + 「、以下略」. Photos only →
    /// 「〇〇さんが写真を送りました」 (photos + text read the text). No name → the body alone. nil: nothing to read.
    static func utterance(name rawName: String?, body rawBody: String, hasPhotos: Bool) -> String? {
        let name = rawName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // The server's stand-in body for a photo-only message (ChatMessage.displayBody).
        let given = (hasPhotos && rawBody.trimmingCharacters(in: .whitespacesAndNewlines) == "📷 写真") ? "" : rawBody
        let body = spokenBody(given)
        if body.isEmpty {
            guard hasPhotos else { return nil }
            return name.isEmpty ? "写真が送られました" : "\(name)さんが写真を送りました"
        }
        return name.isEmpty ? body : "\(name)さん、\(body)"
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
    private struct Item { var text: String; var arrived: Date }

    private var queue: [Item] = []
    private var current: AVSpeechUtterance?
    /// Moves on if the synthesizer never reports the current line finished (ChatSpeech.watchdog).
    private var watchdog: Task<Void, Never>?
    private var synth: AVSpeechSynthesizer?
    private let voice = AVSpeechSynthesisVoice(language: "ja-JP")

    /// Waiting or being read now.
    var isBusy: Bool { current != nil || !queue.isEmpty }

    func enqueue(_ text: String, arrived: Date = Date()) {
        queue.append(Item(text: text, arrived: arrived))
        if current == nil { speakNext() }
    }

    /// Stop mid-sentence and forget everything waiting.
    func stop() {
        #if DEBUG
        if isBusy { NSLog("[offkai-read] stop (%d waiting dropped)", queue.count) }
        #endif
        queue.removeAll()
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
        let s = synth ?? makeSynth()
        let u = AVSpeechUtterance(string: item.text)
        u.voice = voice
        current = u
        #if DEBUG
        NSLog("[offkai-read] speak (%d dropped, %d waiting): %@", turn.dropped, queue.count, item.text)
        #endif
        s.speak(u)
        watchdog?.cancel()
        let limit = ChatSpeech.watchdog(for: item.text)
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
