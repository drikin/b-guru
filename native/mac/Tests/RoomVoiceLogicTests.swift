import XCTest

/// 部室・音声まわりの決まり（shared/RoomVoiceLogic.swift）。Web の src/lib/__tests__/room-logic.test.ts と同じ例。
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class RoomVoiceLogicTests: XCTestCase {
    // MARK: 頭の上の名前

    func testShortNameSameAsWeb() {
        XCTAssertEqual(RoomNameTag.short("Ken"), "Ken")
        XCTAssertEqual(RoomNameTag.short("ドリキン"), "ドリキン")
        XCTAssertEqual(RoomNameTag.short("yatakaharu（グルペット）"), "yatakaharu…")
        XCTAssertEqual(RoomNameTag.short("KOJI SHIGEMURA（しげ）"), "KOJI SHIGEM…")
        XCTAssertEqual(RoomNameTag.short("散財王ドリキン様"), "散財王ドリ…")
        XCTAssertEqual(RoomNameTag.short("  a\n b "), "a b")
    }

    func testShortNameEdges() {
        XCTAssertEqual(RoomNameTag.short(""), "")
        XCTAssertEqual(RoomNameTag.short("ちょうど六文字"), "ちょうど六…") // 7 字 = 幅 14
        XCTAssertEqual(RoomNameTag.short("六文字ちょう"), "六文字ちょう") // 幅 12 はそのまま
        XCTAssertEqual(RoomNameTag.short("abcdefghijkl"), "abcdefghijkl")
        XCTAssertEqual(RoomNameTag.short("abcdefghijklm"), "abcdefghijk…")
        // 切る位置の直前の空白は残さない
        XCTAssertEqual(RoomNameTag.short("abcdefghij klm"), "abcdefghij…")
    }

    func testShortNameKeepsGraphemes() {
        // 家族の絵文字（ZWJ）と国旗は 1 文字（幅 2）として数え、途中で切らない
        let family = "👨‍👩‍👧‍👦"
        XCTAssertEqual(RoomNameTag.short("ab\(family)"), "ab\(family)")
        let long = "abcdefgh\(family)🇯🇵xyz"
        let s = RoomNameTag.short(long)
        XCTAssertEqual(s, "abcdefgh\(family)…")
        XCTAssertEqual(RoomNameTag.short("abcdefghi🇯🇵🇯🇵"), "abcdefghi🇯🇵…")
    }

    // MARK: 相手ごとの音量

    func testGains() {
        var g: [String: Double] = [:]
        g = VoiceGains.setting(g, id: "a", to: 0.5)
        XCTAssertEqual(g["a"], 0.5)
        g = VoiceGains.setting(g, id: "a", to: 1)
        XCTAssertNil(g["a"], "1 は覚えない")
        g = VoiceGains.setting(g, id: "b", to: -3)
        XCTAssertEqual(g["b"], 0)
        g = VoiceGains.setting(g, id: "c", to: 0.333)
        XCTAssertEqual(g["c"], 0.33)
        g = VoiceGains.setting(g, id: "d", to: 7)
        XCTAssertNil(g["d"])
        let raw: [String: Any] = ["a": 0.4, "b": 2, "c": "x", "d": -0.1, "e": 0]
        XCTAssertEqual(VoiceGains.sanitized(raw), ["a": 0.4, "e": 0])
        XCTAssertEqual(VoiceGains.sanitized(nil), [:])
    }

    // MARK: 効果音

    func testSfxTones() {
        XCTAssertEqual(VoiceSfxTone.frequencies(.join), [660, 990])
        XCTAssertEqual(VoiceSfxTone.frequencies(.leave), [740, 494])
        let mine = VoiceSfxTone.samples(.join, mine: true)
        let other = VoiceSfxTone.samples(.join, mine: false)
        XCTAssertEqual(mine.count, Int((0.27 * 44_100).rounded(.up)))
        XCTAssertEqual(mine.first, 0)
        let peakMine = mine.map { abs($0) }.max() ?? 0
        let peakOther = other.map { abs($0) }.max() ?? 0
        XCTAssertGreaterThan(peakMine, peakOther, "自分の出入りは少し大きく")
        XCTAssertLessThanOrEqual(peakMine, 0.13)
        XCTAssertLessThan(abs(mine.last ?? 1), 0.001, "最後は消えている")
        let wav = VoiceSfxTone.wav(mine)
        XCTAssertEqual(wav.count, 44 + mine.count * 2)
        XCTAssertEqual(String(decoding: wav.prefix(4), as: UTF8.self), "RIFF")
    }

    // MARK: 回数の制限・再起動・ステージ

    func testRateGate() {
        var g = RateGate(interval: 1.2)
        let t = Date(timeIntervalSince1970: 1000)
        XCTAssertTrue(g.allow(now: t))
        XCTAssertFalse(g.allow(now: t.addingTimeInterval(1.1)))
        XCTAssertTrue(g.allow(now: t.addingTimeInterval(1.2)))
    }

    func testRestart() {
        XCTAssertFalse(RoomRestart.restarted(previous: nil, current: "a"))
        XCTAssertFalse(RoomRestart.restarted(previous: "a", current: "a"))
        XCTAssertFalse(RoomRestart.restarted(previous: "a", current: nil))
        XCTAssertTrue(RoomRestart.restarted(previous: "a", current: "b"))
    }

    func testStageMic() {
        XCTAssertEqual(StageMic.decide(onStage: true, micOn: false, auto: false, suppressed: false), .scheduleOn)
        XCTAssertEqual(StageMic.decide(onStage: true, micOn: false, auto: false, suppressed: true), .none, "本人が切った")
        XCTAssertEqual(StageMic.decide(onStage: true, micOn: true, auto: true, suppressed: false), .none)
        XCTAssertEqual(StageMic.decide(onStage: false, micOn: true, auto: true, suppressed: false), .turnOff)
        XCTAssertEqual(StageMic.decide(onStage: false, micOn: true, auto: false, suppressed: false), .none, "自分で入れたマイクは切らない")
        XCTAssertEqual(StageMic.decide(onStage: false, micOn: false, auto: true, suppressed: false), .none)
    }
}
