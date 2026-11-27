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
        // The simulator keeps the keyboard floating from a run before: dock it (spread it out).
        if keyboard.frame.width < width * 0.7 {
            keyboard.pinch(withScale: 3, velocity: 1)
            sleep(2)
            guard keyboard.frame.width >= width * 0.7 else { throw XCTSkip("the keyboard did not dock") }
        }
        XCTAssertLessThanOrEqual(box.frame.maxY, keyboard.frame.minY + 1,
                                 "the reply box is under the docked keyboard")
        // …and right above it (the row of 📷 buttons is between), not lifted twice.
        XCTAssertLessThan(keyboard.frame.minY - box.frame.maxY, 150, "extra room between the reply box and the keyboard")
    }

    /// The floating keyboard (pinch the keyboard): the reply box stays at the bottom, no room kept for it.
    func testThreadReplyNoRoomForFloatingKeyboard() throws {
        guard UIDevice.current.userInterfaceIdiom == .pad else { throw XCTSkip("iPad only") }
        let app = XCUIApplication()
        app.launchEnvironment["BGURU_DEMO"] = "1"
        app.launchEnvironment["BGURU_DEMO_TAP"] = "post:3"
        app.launchEnvironment["BGURU_DEMO_TAP_AFTER"] = "2"
        app.launch()

        let window = app.windows.firstMatch.frame
        var box: XCUIElement?
        let deadline = Date().addingTimeInterval(10)
        while box == nil, Date() < deadline {
            sleep(1)
            box = app.textViews.allElementsBoundByIndex.first { $0.frame.minX < window.width / 2 }
        }
        guard let box else { return XCTFail("the thread's reply box did not show") }
        let restingY = box.frame.maxY
        let chat = app.textViews.allElementsBoundByIndex.first { $0.frame.minX > window.width / 2 }
        let chatResting = chat?.frame.maxY
        box.tap()
        let keyboard = app.keyboards.firstMatch
        guard keyboard.waitForExistence(timeout: 4) else { throw XCTSkip("no software keyboard") }
        sleep(1)
        keyboard.pinch(withScale: 0.4, velocity: -1) // docked → floating
        sleep(2)
        print("[kb] window=\(window) keyboard=\(keyboard.frame) box=\(box.frame) resting=\(restingY)")
        guard keyboard.frame.width < window.width * 0.7 else { throw XCTSkip("the keyboard did not float") }
        XCTAssertGreaterThan(box.frame.maxY, restingY - 60, "room kept under the reply box for the floating keyboard")
        if let chat, let chatResting {
            XCTAssertGreaterThan(chat.frame.maxY, chatResting - 60, "room kept under the chat composer for the floating keyboard")
        }
        keyboard.pinch(withScale: 3, velocity: 1) // dock it again for the next run
    }
}
