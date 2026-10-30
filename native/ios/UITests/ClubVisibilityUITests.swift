import XCTest

/// 部活の表示（iPhone、オフラインのデモ。何も送らない）。
/// 2026-10-28 ドリキン「ネイティブアプリで部活ごとの表示非表示がコントロールできない」。
final class ClubVisibilityUITests: XCTestCase {
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

    private func isOn(_ e: XCUIElement) -> Bool {
        (e.value as? String) == "1"
    }

    func testMenuOpensTheSetting() {
        let app = launch()
        let menu = app.buttons["一覧（ピン留め・ブックマーク・お気に入りの人）と表示の設定"]
        XCTAssertTrue(menu.waitForExistence(timeout: 8), "no lists menu on the timeline")
        menu.tap()
        let item = app.buttons["部活の表示…"]
        XCTAssertTrue(item.waitForExistence(timeout: 4), "no 「部活の表示…」 in the menu")
        item.tap()
        XCTAssertTrue(app.staticTexts["部活の表示"].waitForExistence(timeout: 4))
    }

    func testToggleShowsTheSavedStateAndChanges() {
        let app = launch(action: "clubs")
        XCTAssertTrue(app.staticTexts["部活の表示"].waitForExistence(timeout: 8))
        let car = app.switches["club-car"]
        let apple = app.switches["club-apple"]
        XCTAssertTrue(car.waitForExistence(timeout: 4), "the clubs did not load")
        XCTAssertFalse(isOn(car), "クルマ部 is hidden in the demo")
        XCTAssertTrue(isOn(apple))
        XCTAssertTrue(app.switches["club-__unset__"].exists, "no 未設定 row")

        apple.switches.firstMatch.tap()
        XCTAssertTrue(NSPredicate(format: "value == '0'").evaluate(with: apple) || waitValue(apple, "0"), "リンゴ部 did not turn off")
        car.switches.firstMatch.tap()
        XCTAssertTrue(waitValue(car, "1"), "クルマ部 did not turn on")

        app.buttons["閉じる"].tap()
        XCTAssertTrue(app.staticTexts["部活の表示"].waitForNonExistence(timeout: 4))

        // Opened again: the saved state (from the demo server), not the first one.
        app.buttons["一覧（ピン留め・ブックマーク・お気に入りの人）と表示の設定"].tap()
        app.buttons["部活の表示…"].tap()
        XCTAssertTrue(app.switches["club-apple"].waitForExistence(timeout: 4))
        XCTAssertTrue(waitValue(app.switches["club-apple"], "0"))
        XCTAssertTrue(waitValue(app.switches["club-car"], "1"))
    }

    private func waitValue(_ e: XCUIElement, _ v: String) -> Bool {
        let x = expectation(for: NSPredicate(format: "value == %@", v), evaluatedWith: e)
        return XCTWaiter.wait(for: [x], timeout: 4) == .completed
    }
}
