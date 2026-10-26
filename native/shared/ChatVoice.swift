import AVFoundation
import SwiftUI

// 🗣 読み上げの声 (docs/offkai-spec.md「声の選び方」): 自動 (this device's most natural Japanese voice) or one
// chosen from the list, with ▶ 試しに聞く. Sits in the chat's ⋯ menu (Mac and iPhone). Nothing leaves the device.

/// The menu: 自動 / each Japanese voice (with its quality), ▶ 試しに聞く, and how to add a better voice when
/// only the standard ones are installed.
struct ChatVoiceMenu: View {
    @AppStorage(ChatSpeech.voiceKey) private var chosen = ""
    @State private var voices: [ChatSpeech.VoiceInfo] = []

    var body: some View {
        Menu("🗣 読み上げの声") {
            Picker("読み上げの声", selection: $chosen) {
                Text(autoLabel).tag("")
                ForEach(voices, id: \.id) { v in Text(Self.label(v)).tag(v.id) }
            }
            .pickerStyle(.inline)
            Button("▶ 試しに聞く") { ChatVoicePreview.shared.play(chosen.isEmpty ? nil : chosen) }
            if (voices.filter { !$0.novelty }.map(\.quality).max() ?? 1) < 2 {
                Text(Self.installHint)
            }
        }
        .onAppear { voices = ChatSpeech.japaneseVoices() }
    }

    private var autoLabel: String {
        ChatSpeech.pickVoice(voices, preferred: nil).map { "自動（\(Self.label($0))）" } ?? "自動"
    }

    static func label(_ v: ChatSpeech.VoiceInfo) -> String {
        v.name + (v.quality == 3 ? "（プレミアム）" : v.quality == 2 ? "（拡張）" : "")
    }

    #if os(macOS)
    static let installHint = "「システム設定 › アクセシビリティ › 読み上げコンテンツ › システムの声 › 声を管理」で日本語の拡張・プレミアムの声を入れると自然になります"
    #else
    static let installHint = "「設定 › アクセシビリティ › 読み上げコンテンツ › 声 › 日本語」で拡張・プレミアムの声を入れると自然になります"
    #endif
}

/// ▶ 試しに聞く: one short sentence in the given voice (or 自動). Separate from the chat's reader so a preview
/// never mixes into its queue.
@MainActor
final class ChatVoicePreview {
    static let shared = ChatVoicePreview()
    private let synth = AVSpeechSynthesizer()

    func play(_ id: String?) {
        synth.stopSpeaking(at: .immediate)
        let u = AVSpeechUtterance(string: ChatSpeech.previewText)
        let pick = ChatSpeech.pickVoice(ChatSpeech.japaneseVoices(), preferred: id)
        u.voice = pick.flatMap { AVSpeechSynthesisVoice(identifier: $0.id) } ?? AVSpeechSynthesisVoice(language: "ja-JP")
        synth.speak(u)
    }
}
