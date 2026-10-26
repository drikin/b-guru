import XCTest

/// 🍻 チャットの読み上げ (shared/ChatSpeech.swift, docs/offkai-spec.md「チャットの読み上げ」): what is said, and the queue's 2-minute rule.
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class ChatSpeechTests: XCTestCase {
    private func say(_ name: String?, _ body: String, photos: Bool = false) -> String? {
        ChatSpeech.utterance(name: name, body: body, hasPhotos: photos)
    }

    func testNameAndBody() {
        XCTAssertEqual(say("コバン", "今日の散財、届きました！"), "コバンさん、今日の散財、届きました！")
        XCTAssertEqual(say(nil, "名前なし"), "名前なし")
        XCTAssertEqual(say("  ", "空白の名前"), "空白の名前")
        XCTAssertEqual(say("ゆう", "1 行目\n\n2 行目   です"), "ゆうさん、1 行目 2 行目 です")
        XCTAssertEqual(say("ゆう", "改行\r\nして\tURL\nhttps://x.jp/a\n終わり\n"), "ゆうさん、改行 して URL リンク 終わり")
    }

    func testURLsReadAsLink() {
        XCTAssertEqual(say("たけし", "これ見て https://example.com/a?b=1&c=2 すごい"), "たけしさん、これ見て リンク すごい")
        // The shared rule (Web / Android too): `https?://[!-~]+` — printable ASCII only, lower-case scheme.
        XCTAssertEqual(say(nil, "詳細はhttps://a.b/c）を見て"), "詳細はリンク）を見て", "a Japanese ） ends the URL")
        XCTAssertEqual(say(nil, "見てhttps://a.b/cです"), "見てリンクです", "URL + Japanese right after it")
        XCTAssertEqual(say(nil, "(https://a.b/c)です"), "(リンクです", "an ASCII ) is part of the URL")
        XCTAssertEqual(say(nil, "HTTP://EXAMPLE.COM"), "HTTP://EXAMPLE.COM", "upper-case scheme is not matched")
        XCTAssertEqual(say("たけし", "（https://bsm.backspace.fm/x）だよ"), "たけしさん、（リンク）だよ")
        XCTAssertEqual(say("たけし", "a http://x.jp b https://y.jp/z"), "たけしさん、a リンク b リンク")
    }

    func testLongBodyIsCut() {
        let body = String(repeating: "あ", count: 81)
        XCTAssertEqual(say("長文", body), "長文さん、" + String(repeating: "あ", count: 80) + "、以下略")
        let exact = String(repeating: "い", count: 80)
        XCTAssertEqual(say(nil, exact), exact, "80 characters exactly is not cut")
        // Counted after the URL became 「リンク」: a long URL alone is short to say.
        XCTAssertEqual(say(nil, "https://example.com/" + String(repeating: "x", count: 200)), "リンク")
        // Counted in Unicode code points (as Web / Android): 🍻 is one, a flag 🇯🇵 is two.
        let emoji = String(repeating: "🍻", count: 81)
        XCTAssertEqual(say(nil, emoji), String(repeating: "🍻", count: 80) + "、以下略")
        let flags = String(repeating: "🇯🇵", count: 41)
        XCTAssertEqual(say(nil, flags), String(repeating: "🇯🇵", count: 40) + "、以下略")
        XCTAssertEqual(say(nil, String(repeating: "🇯🇵", count: 40)), String(repeating: "🇯🇵", count: 40), "80 code points: not cut")
        // A space at the cut is trimmed before 「、以下略」.
        let spaced = String(repeating: "う", count: 79) + " " + String(repeating: "え", count: 10)
        XCTAssertEqual(say(nil, spaced), String(repeating: "う", count: 79) + "、以下略")
    }

    func testPhotos() {
        XCTAssertEqual(say("たけし", "📷 写真", photos: true), "たけしさんが写真を送りました")
        XCTAssertEqual(say("たけし", "", photos: true), "たけしさんが写真を送りました")
        XCTAssertEqual(say(nil, "📷 写真", photos: true), "写真が送られました")
        XCTAssertEqual(say("たけし", "乾杯！", photos: true), "たけしさん、乾杯！", "photos + text read the text")
        XCTAssertEqual(say(nil, "店の外観 https://x.jp", photos: true), "店の外観 リンク", "photos + text, no name")
        XCTAssertEqual(say("たけし", "📷 写真"), "たけしさん、📷 写真", "without photos the body is just text")
    }

    func testNothingToSay() {
        XCTAssertNil(say("たけし", ""))
        XCTAssertNil(say("たけし", "  \n "))
    }

    // MARK: 賢い読み方 (the same results on Web and Android)

    private func call(_ n: String) -> ChatSpeech.CallName { ChatSpeech.callName(n) }

    func testCallNames() {
        XCTAssertEqual(call("ドリキン").spoken, "ドリキンさん")
        XCTAssertEqual(call("山田太郎（Backspace）").spoken, "山田太郎さん")
        XCTAssertEqual(call("@koh_aoki").spoken, "koh_aokiさん", "leading @ dropped; _ is not a separator; 8 code points is not cut")
        XCTAssertEqual(call("＠ゆう").spoken, "ゆうさん")
        XCTAssertEqual(call("Koh Aoki").spoken, "Kohさん")
        XCTAssertEqual(call("たなかさん").spoken, "たなかさん", "an honorific already there: no extra さん")
        XCTAssertEqual(call("鈴木先生").spoken, "鈴木先生")
        XCTAssertEqual(call("ゆう｜散財部").spoken, "ゆうさん")
        XCTAssertEqual(call("【公式】B-guru").spoken, "B-guruさん")
        XCTAssertEqual(call("🍻 mazzo").spoken, "mazzoさん", "a part of emoji only is skipped")
        XCTAssertFalse(call("ドリキン").wasCut)

        let long = call("とても長い名前のメンバーです")
        XCTAssertEqual(long.spoken, "とても長い名さん")
        XCTAssertTrue(long.wasCut, "step 4 cut it: the Apple apps may ask for a nickname")

        let emoji = call("🍺🍺")
        XCTAssertEqual(emoji.base, "🍺🍺", "nothing with a letter: the whole name, cut to 6")
        XCTAssertEqual(emoji.spoken, "🍺🍺さん")
        XCTAssertFalse(emoji.wasCut)
        XCTAssertEqual(call("🍺🍺🍺🍺🍺🍺🍺🍺").base, "🍺🍺🍺🍺🍺🍺")
        XCTAssertEqual(call("").spoken, "")
        XCTAssertEqual(call("   ").spoken, "")
    }

    func testCallNameInTheLine() {
        XCTAssertEqual(say("山田太郎（Backspace）", "こんばんは"), "山田太郎さん、こんばんは")
        XCTAssertEqual(say("たなかさん", "📷 写真", photos: true), "たなかさんが写真を送りました")
        XCTAssertEqual(ChatSpeech.utterance(name: "とても長い名前のメンバーです", body: "やあ", hasPhotos: false, nickname: "メンバー"),
                       "メンバーさん、やあ", "the on-device nickname replaces the cut name")
    }

    func testSameSpeakerLeavesOutTheName() {
        XCTAssertEqual(ChatSpeech.utterance(name: "コバン", body: "続きです", hasPhotos: false, sameSpeaker: true), "続きです")
        XCTAssertEqual(ChatSpeech.utterance(name: "コバン", body: "📷 写真", hasPhotos: true, sameSpeaker: true), "写真です")
        XCTAssertEqual(ChatSpeech.utterance(name: "コバン", body: "乾杯", hasPhotos: true, sameSpeaker: true), "乾杯")
        XCTAssertNil(ChatSpeech.utterance(name: "コバン", body: "", hasPhotos: false, sameSpeaker: true))
    }

    func testAcceptNickname() {
        let name = "とても長い名前のメンバーです"
        func ok(_ n: String?) -> String? { ChatSpeech.acceptNickname(n, for: name) }
        XCTAssertEqual(ok("メンバー"), "メンバー")
        XCTAssertEqual(ok(" 「メンバー」 "), "メンバー")
        XCTAssertEqual(ok("メンバーさん"), "メンバー", "the model's honorific is dropped (ours is added)")
        XCTAssertNil(ok("とも"), "not a part of the name: made up")
        XCTAssertNil(ok("ともくん"))
        XCTAssertNil(ok("メンバー\nです"))
        XCTAssertNil(ok(""))
        XCTAssertNil(ok(nil))
        XCTAssertEqual(ChatSpeech.acceptNickname("macbook", for: "MacBookProユーザー"), "macbook", "case is ignored")
        XCTAssertEqual(ChatSpeech.acceptNickname("12345678", for: "123456789012"), "12345678")
        XCTAssertNil(ChatSpeech.acceptNickname("123456789", for: "123456789012"), "over 8")
        XCTAssertNil(ChatSpeech.acceptNickname("🍺🍺", for: "🍺🍺の会のみなさまがた"), "symbols only")
    }

    func testWatchdog() {
        XCTAssertEqual(ChatSpeech.watchdog(for: ""), 5, accuracy: 0.001)
        XCTAssertEqual(ChatSpeech.watchdog(for: "コバンさん、乾杯"), 8 * 0.2 + 5, accuracy: 0.001)
        XCTAssertEqual(ChatSpeech.watchdog(for: "🇯🇵"), 2 * 0.2 + 5, accuracy: 0.001, "code points, like the 80 cut")
    }

    func testQueueDropsWhatWaitedTwoMinutes() {
        let now = Date(timeIntervalSince1970: 1_000_000)
        XCTAssertEqual(ChatSpeech.nextTurn(arrivals: [], now: now).index, nil)
        let fresh = ChatSpeech.nextTurn(arrivals: [now.addingTimeInterval(-5), now], now: now)
        XCTAssertEqual(fresh.index, 0)
        XCTAssertEqual(fresh.dropped, 0)
        let mixed = ChatSpeech.nextTurn(arrivals: [now.addingTimeInterval(-300), now.addingTimeInterval(-121), now.addingTimeInterval(-120), now],
                                        now: now)
        XCTAssertEqual(mixed.index, 2, "exactly 2 minutes is still read")
        XCTAssertEqual(mixed.dropped, 2)
        let stale = ChatSpeech.nextTurn(arrivals: [now.addingTimeInterval(-200), now.addingTimeInterval(-130)], now: now)
        XCTAssertNil(stale.index)
        XCTAssertEqual(stale.dropped, 2)
    }

    // MARK: 声の選び方（docs/offkai-spec.md「声の選び方」）

    private func v(_ id: String, _ name: String, q: Int = 1, novelty: Bool = false, lang: String = "ja-JP") -> ChatSpeech.VoiceInfo {
        .init(id: id, name: name, language: lang, quality: q, novelty: novelty)
    }

    func testPickVoicePrefersQualityAndSkipsNovelty() {
        let list = [v("eddy", "Eddy", novelty: true), v("kyoko", "Kyoko"), v("kyokoE", "Kyoko", q: 2), v("sam", "Samantha", q: 3, lang: "en-US")]
        XCTAssertEqual(ChatSpeech.pickVoice(list, preferred: nil)?.id, "kyokoE")
        XCTAssertEqual(ChatSpeech.pickVoice(list + [v("oren", "O-ren", q: 3)], preferred: nil)?.id, "oren")
        XCTAssertEqual(ChatSpeech.pickVoice([v("eddy", "Eddy", novelty: true), v("kyoko", "Kyoko")], preferred: nil)?.id, "kyoko")
        XCTAssertEqual(ChatSpeech.pickVoice([v("eddy", "Eddy", novelty: true)], preferred: nil)?.id, "eddy") // それしか無ければ
        XCTAssertNil(ChatSpeech.pickVoice([v("sam", "Samantha", lang: "en-US")], preferred: nil))
    }

    func testPickVoiceUsesTheChosenOneUntilItIsGone() {
        let list = [v("kyoko", "Kyoko"), v("kyokoE", "Kyoko", q: 2), v("flo", "Flo", novelty: true)]
        XCTAssertEqual(ChatSpeech.pickVoice(list, preferred: "flo")?.id, "flo")
        XCTAssertEqual(ChatSpeech.pickVoice(list, preferred: "gone")?.id, "kyokoE")
    }
}
