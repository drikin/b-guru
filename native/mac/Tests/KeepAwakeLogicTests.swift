import XCTest

/// ☕ スリープさせない（BguruChat/Sources/KeepAwakeLogic.swift, docs/mac-keep-awake-spec.md）: 手動・自動・電池の決め方。
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class KeepAwakeLogicTests: XCTestCase {
    private let now = Date(timeIntervalSince1970: 1_800_000_000)
    private let tokyo = TimeZone(identifier: "Asia/Tokyo")!

    private func input(manual: KeepAwakeLogic.Manual? = nil, auto: KeepAwakeLogic.AutoFlags = .init(),
                       conditions: KeepAwakeLogic.Conditions = .init(), battery: KeepAwakeLogic.Battery = .desktop,
                       threshold: Int = 20, batteryLow: Bool = false, keepDisplay: Bool = false) -> KeepAwakeLogic.Input {
        var i = KeepAwakeLogic.Input()
        i.manual = manual
        i.auto = auto
        i.conditions = conditions
        i.battery = battery
        i.threshold = threshold
        i.batteryLow = batteryLow
        i.keepDisplay = keepDisplay
        i.now = now
        i.timeZone = tokyo
        return i
    }

    private func onBattery(_ p: Int) -> KeepAwakeLogic.Battery { .init(hasBattery: true, onAC: false, percent: p) }

    func testNothingApplies() {
        let d = KeepAwakeLogic.decide(input())
        XCTAssertFalse(d.holdSystem)
        XCTAssertFalse(d.holdDisplay)
        XCTAssertEqual(d.reasons, [])
        XCTAssertNil(KeepAwakeLogic.summary(d))
    }

    func testManualUntilOff() {
        let d = KeepAwakeLogic.decide(input(manual: .init(until: nil)))
        XCTAssertTrue(d.holdSystem)
        XCTAssertFalse(d.holdDisplay, "画面も消さないは既定で切")
        XCTAssertEqual(d.reasons, ["切るまで"])
        XCTAssertEqual(KeepAwakeLogic.summary(d), "スリープさせない（切るまで）")
    }

    func testManualTimedShowsEndTime() {
        // 1_800_000_000 + 30 分 = 2027-01-15 17:30 (JST)
        let d = KeepAwakeLogic.decide(input(manual: .init(until: now.addingTimeInterval(30 * 60)), keepDisplay: true))
        XCTAssertTrue(d.holdSystem)
        XCTAssertTrue(d.holdDisplay)
        XCTAssertEqual(d.reasons, ["17:30 まで"])
        XCTAssertFalse(d.clearManual)
        XCTAssertEqual(KeepAwakeLogic.summary(d), "スリープさせない（17:30 まで）・画面も")
    }

    func testManualExpires() {
        let d = KeepAwakeLogic.decide(input(manual: .init(until: now)))
        XCTAssertFalse(d.holdSystem)
        XCTAssertTrue(d.clearManual)
        XCTAssertTrue(d.manualExpired)
        // 切るまでは終わらない
        XCTAssertFalse(KeepAwakeLogic.decide(input(manual: .init(until: nil))).manualExpired)
    }

    func testManualExpiredButAutoStillHolds() {
        let d = KeepAwakeLogic.decide(input(manual: .init(until: now.addingTimeInterval(-1)),
                                            conditions: .init(call: "🍻 の音声")))
        XCTAssertTrue(d.manualExpired)
        XCTAssertTrue(d.holdSystem)
        XCTAssertEqual(d.reasons, ["🍻 の音声"])
    }

    func testAutoDefaultsCallAndWatchOn() {
        let c = KeepAwakeLogic.Conditions(call: "ボイスルーム", watchPlaying: true, runningApps: ["Xcode"], externalDisplay: true)
        let d = KeepAwakeLogic.decide(input(conditions: c, battery: .init(hasBattery: true, onAC: true, percent: 80)))
        XCTAssertTrue(d.holdSystem)
        // 既定：通話・📺 はオン、アプリ・電源・外部ディスプレイはオフ
        XCTAssertEqual(d.reasons, ["ボイスルーム", "📺 の再生"])
    }

    func testAutoAllFlags() {
        let flags = KeepAwakeLogic.AutoFlags(call: true, watch: true, apps: true, power: true, display: true)
        let c = KeepAwakeLogic.Conditions(call: "部室の音声", watchPlaying: true, runningApps: ["Final Cut Pro", "Xcode"], externalDisplay: true)
        let d = KeepAwakeLogic.decide(input(manual: .init(until: nil), auto: flags, conditions: c,
                                            battery: .init(hasBattery: true, onAC: true, percent: 50)))
        XCTAssertEqual(d.reasons, ["切るまで", "部室の音声", "📺 の再生", "Final Cut Pro が動いている", "Xcode が動いている",
                                   "電源につながっている", "外部ディスプレイ"])
    }

    func testAutoFlagsOff() {
        let flags = KeepAwakeLogic.AutoFlags(call: false, watch: false, apps: false, power: false, display: false)
        let c = KeepAwakeLogic.Conditions(call: "🍻 の音声", watchPlaying: true, runningApps: ["Xcode"], externalDisplay: true)
        XCTAssertFalse(KeepAwakeLogic.decide(input(auto: flags, conditions: c)).holdSystem)
    }

    func testPowerFlagOnBattery() {
        let flags = KeepAwakeLogic.AutoFlags(call: false, watch: false, power: true)
        XCTAssertFalse(KeepAwakeLogic.decide(input(auto: flags, battery: onBattery(90))).holdSystem)
        XCTAssertTrue(KeepAwakeLogic.decide(input(auto: flags, battery: .init(hasBattery: true, onAC: true, percent: 90))).holdSystem)
        // デスクトップ（電池なし）は電源につながっている
        XCTAssertTrue(KeepAwakeLogic.decide(input(auto: flags)).holdSystem)
    }

    func testBatteryStopsManualAndAutoOnce() {
        let d = KeepAwakeLogic.decide(input(manual: .init(until: nil), conditions: .init(call: "🍻 の音声"), battery: onBattery(20)))
        XCTAssertFalse(d.holdSystem)
        XCTAssertFalse(d.holdDisplay)
        XCTAssertTrue(d.batteryLow)
        XCTAssertTrue(d.clearManual, "手動も止める")
        XCTAssertTrue(d.stoppedByBattery, "知らせは 1 回")
        // 次の回（まだ少ない）：知らせない
        let d2 = KeepAwakeLogic.decide(input(conditions: .init(call: "🍻 の音声"), battery: onBattery(19), batteryLow: true))
        XCTAssertFalse(d2.holdSystem)
        XCTAssertTrue(d2.batteryLow)
        XCTAssertFalse(d2.stoppedByBattery)
    }

    func testBatteryLowWithNothingAppliedDoesNotNotify() {
        let d = KeepAwakeLogic.decide(input(battery: onBattery(10)))
        XCTAssertTrue(d.batteryLow)
        XCTAssertFalse(d.stoppedByBattery)
        XCTAssertFalse(d.clearManual)
    }

    func testBatteryAboveThreshold() {
        let d = KeepAwakeLogic.decide(input(manual: .init(until: nil), battery: onBattery(21)))
        XCTAssertTrue(d.holdSystem)
        XCTAssertFalse(d.batteryLow)
    }

    func testBatteryHysteresis() {
        let auto = KeepAwakeLogic.Conditions(call: "🍻 の音声")
        // 止めたあと：値 + 5% 未満なら入れない
        for p in [20, 21, 24] {
            let d = KeepAwakeLogic.decide(input(conditions: auto, battery: onBattery(p), batteryLow: true))
            XCTAssertFalse(d.holdSystem, "\(p)%")
            XCTAssertTrue(d.batteryLow, "\(p)%")
        }
        // 値 + 5% で戻る
        let back = KeepAwakeLogic.decide(input(conditions: auto, battery: onBattery(25), batteryLow: true))
        XCTAssertTrue(back.holdSystem)
        XCTAssertFalse(back.batteryLow)
        // 電源につなげばすぐ戻る
        let ac = KeepAwakeLogic.decide(input(conditions: auto, battery: .init(hasBattery: true, onAC: true, percent: 5), batteryLow: true))
        XCTAssertTrue(ac.holdSystem)
        XCTAssertFalse(ac.batteryLow)
    }

    func testThresholdSetting() {
        let auto = KeepAwakeLogic.Conditions(call: "🍻 の音声")
        XCTAssertTrue(KeepAwakeLogic.decide(input(conditions: auto, battery: onBattery(30), threshold: 30)).batteryLow)
        XCTAssertFalse(KeepAwakeLogic.decide(input(conditions: auto, battery: onBattery(30), threshold: 20)).batteryLow)
        XCTAssertEqual(KeepAwakeLogic.defaultThreshold, 20)
        XCTAssertEqual(KeepAwakeLogic.hysteresis, 5)
    }

    func testDesktopIgnoresBattery() {
        // 電池の無い Mac：残りの値は見ない
        let d = KeepAwakeLogic.decide(input(manual: .init(until: nil), battery: .init(hasBattery: false, onAC: false, percent: 0), batteryLow: true))
        XCTAssertTrue(d.holdSystem)
        XCTAssertFalse(d.batteryLow)
    }

    func testDurationLabels() {
        XCTAssertEqual(KeepAwakeLogic.durations.map(KeepAwakeLogic.durationLabel), ["切るまで", "30 分", "1 時間", "2 時間", "4 時間"])
    }
}
