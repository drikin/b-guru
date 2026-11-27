import XCTest

/// iPad の 2 列: キーボードを避けるのは画面の下にくっついた（固定の）キーボードのときだけ。
/// リュー 2026-11-27「フローティングキーボード使っていると固定キーボードの幅の余白が取られてしまう」で
/// SwiftUI 任せの回避をやめて自前（MainView の KeyboardOverlapReader）にしたので、固定キーボードで
/// 返信欄が隠れないことを確かめる（オフラインのデモ。何も送らない）。
final class KeyboardAvoidUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    func testThreadReplyStaysAboveDockedKeyboard() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad only") }
        let app = XCUIApplication()
        app.launchEnvironment["BGURU_DEMO"] = "1"
        app.launchEnvironment["BGURU_DEMO_TAP"] = "post:3"
        app.launchEnvironment["BGURU_DEMO_TAP_AFTER"] = "2"
        app.launch()

        let width = app.windows.firstMatch.frame.width
        // The thread's reply box: the text view in the left column.
        let reply = app.textViews.allElementsBoundByIndex.first { $0.frame.minX < width / 2 }
        let deadline = Date().addingTimeInterval(10)
        var box = reply
        while box == nil, Date() < deadline {
            sleep(1)
            box = app.textViews.allElementsBoundByIndex.first { $0.frame.minX < width / 2 }
        }
        guard let box else { return XCTFail("the thread's reply box did not show") }
        box.tap()

        let keyboard = app.keyboards.firstMatch
        guard keyboard.waitForExistence(timeout: 4) else {
            throw XCTSkip("no software keyboard (the simulator has a hardware keyboard connected)")
        }
        sleep(1) // the keyboard's animation
        XCTAssertLessThanOrEqual(box.frame.maxY, keyboard.frame.minY + 1,
                                 "the reply box is under the docked keyboard")
        // …and right above it (the row of 📷 buttons is between), not lifted twice.
        XCTAssertLessThan(keyboard.frame.minY - box.frame.maxY, 150, "extra room between the reply box and the keyboard")
    }
}
