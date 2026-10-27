import XCTest

/// 編集の操作（iPhone、オフラインのデモ。何も送らない）。
/// 2026-10-27 リュー「長押しして『編集』を選ぶとキーボードが出てこない」: the dialog held two copies of its
/// content (ViewThatFits) and swapped the text box being typed in for the other one when the keyboard took
/// the room, so the keyboard closed again. These keep the text box focused while typing.
final class EditFlowUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func launch(action: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchEnvironment["BGURU_DEMO"] = "1"
        if let action { app.launchEnvironment["BGURU_DEMO_ACTION"] = action }
        app.launch()
        return app
    }

    /// Has the keyboard focus (works with the on-screen keyboard and with a hardware one).
    private func focused(_ e: XCUIElement) -> Bool {
        (e.value(forKey: "hasKeyboardFocus") as? Bool) ?? false
    }

    private func waitFocused(_ e: XCUIElement, timeout: TimeInterval = 4, file: StaticString = #filePath, line: UInt = #line) {
        let p = NSPredicate { _, _ in self.focused(e) }
        let x = expectation(for: p, evaluatedWith: nil)
        wait(for: [x], timeout: timeout)
    }

    /// Still focused a while later (the bug: focused for a moment, then gone).
    private func assertStaysFocused(_ e: XCUIElement, file: StaticString = #filePath, line: UInt = #line) {
        waitFocused(e, file: file, line: line)
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertTrue(focused(e), "the text box lost the focus (keyboard closed)", file: file, line: line)
    }

    private func editSheet(_ app: XCUIApplication) -> XCUIElement {
        let title = app.staticTexts["投稿を編集"]
        XCTAssertTrue(title.waitForExistence(timeout: 8), "「投稿を編集」 did not open")
        return app.textViews.firstMatch
    }

    func testEditPostOpensReadyToType() {
        let app = launch(action: "edit")
        let text = editSheet(app)
        assertStaysFocused(text)
        let before = (text.value as? String) ?? ""
        text.typeText("123")
        XCTAssertTrue(((text.value as? String) ?? "").contains("123"), "typing did not reach the text box")
        XCTAssertNotEqual(before, text.value as? String)
        XCTAssertTrue(focused(text))
        // The pictures and the sound stay in the dialog while the keyboard is up.
        XCTAssertTrue(app.buttons["📷 1/5"].exists || app.staticTexts["📷 1/5"].exists, "the photo button is gone")
    }

    func testEditPostTapAgainAfterKeyboardClosed() {
        let app = launch(action: "edit")
        let text = editSheet(app)
        waitFocused(text)
        // Close the keyboard (the sheet's title area), then tap the text box again.
        app.staticTexts["投稿を編集"].tap()
        if focused(text) { app.swipeDown() }
        text.tap()
        assertStaysFocused(text)
        text.typeText("9")
        XCTAssertTrue(((text.value as? String) ?? "").contains("9"))
    }

    func testEditPostCancelAndSave() {
        let app = launch(action: "edit")
        let text = editSheet(app)
        waitFocused(text)
        app.buttons["キャンセル"].tap()
        XCTAssertTrue(app.staticTexts["投稿を編集"].waitForNonExistence(timeout: 4), "キャンセル did not close the dialog")
    }

    func testPollEditTyping() {
        let app = launch(action: "pollEdit")
        XCTAssertTrue(app.staticTexts["アンケートの回答を編集"].waitForExistence(timeout: 8))
        let field = app.textFields.firstMatch
        field.tap()
        assertStaysFocused(field)
        field.typeText("7")
        XCTAssertTrue(((field.value as? String) ?? "").contains("7"))
    }

    func testChatLongPressEdit() {
        let app = launch()
        let mine = app.staticTexts["ありがとうございます！"]
        XCTAssertTrue(mine.waitForExistence(timeout: 8), "my demo message is not in the chat")
        mine.press(forDuration: 1.0)
        let edit = app.buttons["編集"]
        if !edit.waitForExistence(timeout: 4) { print("TREE>>>\n\(app.debugDescription)") }
        XCTAssertTrue(edit.exists, "no 「編集」 in the long-press menu")
        edit.tap()
        let composer = app.textViews.firstMatch
        assertStaysFocused(composer)
        XCTAssertTrue(((composer.value as? String) ?? "").contains("ありがとうございます"), "the message is not in the box to edit")
    }
}
