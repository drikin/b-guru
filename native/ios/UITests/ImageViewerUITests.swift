import XCTest

/// 画像の拡大表示（iPhone、オフラインのデモ）。下にスワイプすると閉じ、少しだけなら戻る。
/// 2026-10-30 ドリキン「画像をタップして拡大表示した時に、下にスワイプして画像を閉じたい」。
final class ImageViewerUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    private func openViewer() -> (XCUIApplication, XCUIElement) {
        let app = XCUIApplication()
        app.launchEnvironment["BGURU_DEMO"] = "1"
        app.launchEnvironment["BGURU_DEMO_ACTION"] = "image"
        app.launch()
        let close = app.buttons["閉じる"]
        XCTAssertTrue(close.waitForExistence(timeout: 8), "the picture did not open")
        return (app, close)
    }

    func testSwipeDownCloses() {
        let (app, close) = openViewer()
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
        from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85)))
        XCTAssertTrue(close.waitForNonExistence(timeout: 4), "a swipe down did not close the picture")
    }

    func testShortPullSpringsBack() {
        let (app, close) = openViewer()
        let from = app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.4))
        // ~30 pt, slowly: not far enough and not a flick.
        from.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.435)),
                   withVelocity: 60, thenHoldForDuration: 0.3)
        sleep(1)
        XCTAssertTrue(close.exists, "a short pull closed the picture")
    }
}
