import XCTest

/// 画面の隅でパネルを開閉する（BguruChat/Sources/HotCornerLogic.swift）。
final class HotCornerLogicTests: XCTestCase {
    // 内蔵（1512×982）と、その右に外部（2560×1440、下揃え）
    private let screens = [CGRect(x: 0, y: 0, width: 1512, height: 982), CGRect(x: 1512, y: 0, width: 2560, height: 1440)]

    func testCornersOfEachScreen() {
        XCTAssertEqual(HotCornerLogic.screenIndex(at: CGPoint(x: 0, y: 981), corner: .topLeft, screens: screens), 0)
        XCTAssertEqual(HotCornerLogic.screenIndex(at: CGPoint(x: 0, y: 0), corner: .bottomLeft, screens: screens), 0)
        XCTAssertEqual(HotCornerLogic.screenIndex(at: CGPoint(x: 4071, y: 1439), corner: .topRight, screens: screens), 1)
        XCTAssertEqual(HotCornerLogic.screenIndex(at: CGPoint(x: 4072, y: 0), corner: .bottomRight, screens: screens), 1)
        // 外部の左上（内蔵の上の空き）にも
        XCTAssertEqual(HotCornerLogic.screenIndex(at: CGPoint(x: 1512, y: 1439), corner: .topLeft, screens: screens), 1)
    }

    func testNotACorner() {
        XCTAssertNil(HotCornerLogic.screenIndex(at: CGPoint(x: 0, y: 981), corner: .topRight, screens: screens))
        XCTAssertNil(HotCornerLogic.screenIndex(at: CGPoint(x: 10, y: 981), corner: .topLeft, screens: screens)) // 上の端だけ
        XCTAssertNil(HotCornerLogic.screenIndex(at: CGPoint(x: 700, y: 500), corner: .topLeft, screens: screens))
        XCTAssertNil(HotCornerLogic.screenIndex(at: CGPoint(x: 0, y: 981), corner: .off, screens: screens))
    }

    func testLeavingNeedsDistance() {
        XCTAssertFalse(HotCornerLogic.hasLeft(CGPoint(x: 10, y: 970), corner: .topLeft, screens: screens))
        XCTAssertTrue(HotCornerLogic.hasLeft(CGPoint(x: 40, y: 970), corner: .topLeft, screens: screens))
    }

    func testInnerSeamBetweenScreensIsNotACorner() {
        // 同じ高さで左右に並べる：内蔵の右上と外部の左上は通り道
        let side = [CGRect(x: 0, y: 0, width: 1512, height: 982), CGRect(x: 1512, y: 0, width: 1512, height: 982)]
        XCTAssertNil(HotCornerLogic.screenIndex(at: CGPoint(x: 1511, y: 981), corner: .topRight, screens: side))
        XCTAssertNil(HotCornerLogic.screenIndex(at: CGPoint(x: 1512, y: 981), corner: .topLeft, screens: side))
        XCTAssertEqual(HotCornerLogic.screenIndex(at: CGPoint(x: 3023, y: 981), corner: .topRight, screens: side), 1)
        // 高さ違い（上の例）では、内蔵の右上の上は空いているが右に外部があるので隅にしない
        XCTAssertNil(HotCornerLogic.screenIndex(at: CGPoint(x: 1511, y: 981), corner: .topRight, screens: screens))
    }

    func testFractionalCoordinates() {
        XCTAssertEqual(HotCornerLogic.screenIndex(at: CGPoint(x: 0.4, y: 981.5), corner: .topLeft, screens: screens), 0)
    }
}
