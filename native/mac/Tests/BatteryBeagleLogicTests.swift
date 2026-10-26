import XCTest

/// 🔋 ビーグルで電池の残量を見せる（BguruChat/Sources/BatteryBeagleLogic.swift, docs/mac-battery-beagle-spec.md）:
/// 残量 → 塗りの段・⚡・しょんぼり、描き直すとき、細かい値の文字。
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class BatteryBeagleLogicTests: XCTestCase {
    private typealias L = BatteryBeagleLogic
    private func status(_ p: Int, onAC: Bool = false, charging: Bool = false, empty: Int? = nil, full: Int? = nil,
                        warning: Bool = false) -> L.Status {
        L.Status(percent: p, onAC: onAC, isCharging: charging, minutesToEmpty: empty, minutesToFull: full, lowWarning: warning)
    }

    func testFillEnds() {
        XCTAssertEqual(L.fillSteps(percent: 0, steps: 30), 0, "0% は輪郭だけ")
        XCTAssertEqual(L.fillSteps(percent: 100, steps: 30), 30, "100% で全部")
        XCTAssertEqual(L.fillSteps(percent: -5, steps: 30), 0)
        XCTAssertEqual(L.fillSteps(percent: 120, steps: 30), 30)
    }

    func testFillMiddleNeverEmptyOrFull() {
        XCTAssertEqual(L.fillSteps(percent: 1, steps: 30), 1, "少しでも残っていれば足元が塗られる")
        XCTAssertEqual(L.fillSteps(percent: 99, steps: 30), 29, "満充電の手前は満ちきらない")
        XCTAssertEqual(L.fillSteps(percent: 50, steps: 30), 15)
        XCTAssertEqual(L.fillSteps(percent: 82, steps: 30), 25)
        XCTAssertEqual(L.fillSteps(percent: 15, steps: 30), 5) // 4.5 → 5
    }

    func testFillMonotonic() {
        var last = 0
        for p in 0...100 {
            let s = L.fillSteps(percent: p, steps: 30)
            XCTAssertGreaterThanOrEqual(s, last, "\(p)%")
            last = s
        }
    }

    func testDroopy() {
        XCTAssertTrue(L.isDroopy(status(20)), "20% 以下でしょんぼり")
        XCTAssertTrue(L.isDroopy(status(5)))
        XCTAssertFalse(L.isDroopy(status(21)))
        XCTAssertTrue(L.isDroopy(status(35, warning: true)), "macOS の低電力の目安でも")
    }

    func testLook() {
        let a = L.look(status(82, onAC: true, charging: true), steps: 30)
        XCTAssertEqual(a, L.Look(fillSteps: 25, steps: 30, charging: true, droopy: false))
        XCTAssertEqual(a.key, "25/30c")
        let b = L.look(status(15), steps: 30)
        XCTAssertTrue(b.droopy)
        XCTAssertFalse(b.charging)
        XCTAssertEqual(b.key, "5/30d")
        // 電源につながっていても充電していなければ ⚡ は出さない（満充電・充電の最適化）
        XCTAssertFalse(L.look(status(100, onAC: true), steps: 30).charging)
    }

    func testRedrawOnlyOnPercentOrState() {
        let s = status(82, empty: 250)
        XCTAssertFalse(L.needsRedraw(old: s, new: status(82, empty: 240)), "残り時間だけの変化では描き直さない")
        XCTAssertTrue(L.needsRedraw(old: s, new: status(81, empty: 240)), "1% 変わったら")
        XCTAssertTrue(L.needsRedraw(old: s, new: status(82, onAC: true)), "電源につないだら")
        XCTAssertTrue(L.needsRedraw(old: status(82, onAC: true), new: status(82, onAC: true, charging: true)), "充電が始まったら")
        XCTAssertTrue(L.needsRedraw(old: s, new: status(82, warning: true)))
        XCTAssertTrue(L.needsRedraw(old: nil, new: s), "見せ始め")
        XCTAssertTrue(L.needsRedraw(old: s, new: nil), "やめる")
        XCTAssertFalse(L.needsRedraw(old: nil, new: nil))
    }

    func testDetail() {
        XCTAssertEqual(L.detail(status(82, empty: 250)), "🔋 82%・残り 4:10")
        XCTAssertEqual(L.detail(status(82, onAC: true, charging: true, full: 40)), "⚡ 充電中 82%・満充電まで 0:40")
        XCTAssertEqual(L.detail(status(100, onAC: true, full: 0)), "電源につながっています 100%")
        XCTAssertEqual(L.detail(status(80, onAC: true)), "電源につながっています 80%", "充電の最適化で止まっている")
        // 計算中（-1）・分からないときは % だけ
        XCTAssertEqual(L.detail(status(50, empty: -1)), "🔋 50%")
        XCTAssertEqual(L.detail(status(50)), "🔋 50%")
        XCTAssertEqual(L.detail(status(30, onAC: true, charging: true, full: -1)), "⚡ 充電中 30%")
    }

    func testClock() {
        XCTAssertEqual(L.clock(250), "4:10")
        XCTAssertEqual(L.clock(40), "0:40")
        XCTAssertEqual(L.clock(605), "10:05")
        XCTAssertNil(L.clock(0))
        XCTAssertNil(L.clock(-1))
    }
}
