import XCTest

/// NG ワード（iPhone、オフラインのデモ。何も送らない）。デモは「ネタバレ」が 1 つ入った状態で始まる。
/// 2026-10-29 ドリキン「ユーザーごとに NG ワードを設定して、含む投稿はタイムラインに出さない」。
final class MutedWordsUITests: XCTestCase {
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

    func testMenuOpensTheSetting() {
        let app = launch()
        let menu = app.buttons["一覧（ピン留め・ブックマーク・お気に入りの人）と表示の設定"]
        XCTAssertTrue(menu.waitForExistence(timeout: 8), "no lists menu on the timeline")
        menu.tap()
        let item = app.buttons["NG ワード…"]
        XCTAssertTrue(item.waitForExistence(timeout: 4), "no 「NG ワード…」 in the menu")
        item.tap()
        XCTAssertTrue(app.staticTexts["NG ワード"].waitForExistence(timeout: 4))
    }

    func testAddAndRemoveAWord() {
        let app = launch()
        let menu = app.buttons["一覧（ピン留め・ブックマーク・お気に入りの人）と表示の設定"]
        XCTAssertTrue(menu.waitForExistence(timeout: 8))
        menu.tap()
        app.buttons["NG ワード…"].tap()
        XCTAssertTrue(app.staticTexts["NG ワード"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.staticTexts["ネタバレ"].waitForExistence(timeout: 4), "the saved word did not load")

        let field = app.textFields["muted-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 4))
        field.tap()
        field.typeText("ABC")
        app.buttons["muted-add"].tap()
        // The server's form (lower case) comes back.
        XCTAssertTrue(app.staticTexts["abc"].waitForExistence(timeout: 4), "the added word did not show")
        XCTAssertEqual(field.value as? String, "言葉を入力", "the field was not cleared")

        app.buttons["「ネタバレ」を消す"].tap()
        XCTAssertTrue(app.staticTexts["ネタバレ"].waitForNonExistence(timeout: 4), "the word was not removed")

        app.buttons["閉じる"].tap()
        XCTAssertTrue(app.staticTexts["NG ワード"].waitForNonExistence(timeout: 4))

        // Opened again: the saved list (from the demo server).
        app.buttons["一覧（ピン留め・ブックマーク・お気に入りの人）と表示の設定"].tap()
        app.buttons["NG ワード…"].tap()
        XCTAssertTrue(app.staticTexts["abc"].waitForExistence(timeout: 4))
        XCTAssertFalse(app.staticTexts["ネタバレ"].exists)
    }
}
