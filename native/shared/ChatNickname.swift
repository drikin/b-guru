import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

// 賢い読み方 (docs/offkai-spec.md): a name still long after the rule (ChatSpeech.callName cut it) gets a short
// nickname from this device's own language model (Apple Intelligence). Nothing leaves the device. The reader
// checks the answer (ChatSpeech.acceptNickname), keeps it per person and waits for it at most ~1.5 s.
enum ChatNickname {
    /// nil when the model is not here / not ready / fails.
    @MainActor static func ask(_ name: String) async -> String? {
        #if canImport(FoundationModels)
        guard #available(iOS 26, macOS 26, *), BeagleOnDevice.isAvailable else { return nil }
        do {
            // Picks a part of the name, never makes one up (「とも」 for 「とても長い名前のメンバーです」 before the examples).
            let session = LanguageModelSession(instructions: """
            チャットの読み上げで使う、会員の呼び名を決める。表示名の中から、呼び名として自然な連続した部分を 1 つだけ抜き出して書く。\
            人名・あだ名らしい部分があればそれ、なければ意味のまとまった語。6 文字以内。表示名の文字をそのまま使い、\
            読み替え・略し・言葉の追加はしない。敬称（さん・様・くん など）は付けない。呼び名だけを書く。
            例: 散財大好きサラリーマン太郎 → 太郎
            例: ガジェット好きのたかし → たかし
            例: MacBookProユーザー → MacBook
            """)
            let r = try await session.respond(to: "表示名: \(name)", options: GenerationOptions(temperature: 0, maximumResponseTokens: 20))
            return r.content
        } catch {
            return nil
        }
        #else
        return nil
        #endif
    }
}
