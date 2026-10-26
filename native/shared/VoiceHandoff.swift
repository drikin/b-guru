import Foundation
import Observation
import SwiftUI

// 音声をスマホで続ける (docs/device-sync-spec.md §2). The Mac's 「スマホで続ける」 asks the server to send one
// notification to my phones; the phone that taps it joins the same sound, and LiveKit (one connection per
// identity) lets the Mac's go — the Mac then says 「別の端末で続けています」 (VoiceStore / OffkaiStore.roomEnded).
// The Mac keeps talking until then: iOS cannot start the microphone from the background, so nothing switches
// by itself.

/// 「スマホで続ける」 (Mac): the request and what came of it. Lives in ChatStore; the voice bar, the club room
/// and 🍻 reach it through their stores' `handoff`.
@MainActor
@Observable
final class VoiceHandoff {
    enum Target: String, Sendable { case offkai, voice, room }

    private(set) var busy = false
    private var last: (text: String, target: Target, at: Date)?

    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    /// What to say under that feature's buttons (the server's notification lasts 5 minutes; so does this).
    func notice(for target: Target) -> String? {
        guard let n = last, n.target == target, Date().timeIntervalSince(n.at) < 300 else { return nil }
        return n.text
    }

    func send(_ target: Target, mic: Bool) async {
        guard !busy else { return }
        busy = true
        defer { busy = false }
        let text: String
        do {
            let sent = try await api.voiceHandoff(target: target.rawValue, mic: mic)
            text = sent > 0 ? "スマホの知らせをタップすると、そちらに切り替わります" : "続けられるスマホが見つかりません（アプリを最新にしてください）"
        } catch let APIError.http(status, _, message) {
            text = status == 429 ? "少し待ってから試してください" : (message ?? "スマホに送れませんでした（\(status)）")
        } catch {
            text = "スマホに送れませんでした"
        }
        last = (text, target, Date())
    }
}

extension ChatStore {
    /// 「🎧 音声をこの端末で続ける」 tapped (voice_handoff { target, mic }): the chat with that feature on screen,
    /// and into its sound. 🍻: speaking if the server says I am the speaker, else listening; the voice room
    /// and the club room: the mic as the other device had it (the app is in front now, so it may start).
    func continueVoiceHere(target: String, mic: Bool) {
        showChat?()
        Task {
            // A tap that launched the app: what is on for this member comes with the capabilities.
            for _ in 0..<50 where capabilities == nil { try? await Task.sleep(for: .milliseconds(200)) }
            switch VoiceHandoff.Target(rawValue: target) {
            case .offkai:
                offkai.show()
                await offkai.continueHere()
            // "voice" from a device without the club room: here the room is the voice room (as on Android).
            case .room where room.enabled, .voice where room.enabled:
                if overlay.enabled && overlay.anyAvailable {
                    overlay.show(.room, expand: true)
                } else {
                    // What the テキスト｜ルーム row does (one thing above the chat).
                    shogi.close()
                    minigame.close()
                    offkai.close()
                }
                await room.continueHere(mic: mic)
            case .voice, .room:
                guard voice.enabled else { return }
                if voice.phase == .idle { await voice.join() }
                if mic { await voice.setMic(true) }
            case nil:
                break // a newer server's target
            }
        }
    }
}

#if os(macOS)
/// 「📱 スマホで続ける」 for the Mac's voice bar / club room / 🍻: the button in the style of the row it sits
/// in (`label` draws it), and the answer below it is shown by `VoiceHandoffNotice`.
struct VoiceHandoffButton<Label: View>: View {
    let handoff: VoiceHandoff?
    let target: VoiceHandoff.Target
    let mic: Bool
    @ViewBuilder var label: () -> Label

    var body: some View {
        if let handoff {
            Button { Task { await handoff.send(target, mic: mic) } } label: { label() }
                .disabled(handoff.busy)
                .help("iPhone に知らせを送ります。タップすると、そちらで続きを聞けます（話せます）")
                .accessibilityLabel("スマホで続ける")
        }
    }
}

struct VoiceHandoffNotice: View {
    let handoff: VoiceHandoff?
    let target: VoiceHandoff.Target
    var font: Font = .app(.caption)

    var body: some View {
        if let text = handoff?.notice(for: target) {
            Text(text).font(font).foregroundStyle(.secondary).lineLimit(2)
        }
    }
}
#endif
