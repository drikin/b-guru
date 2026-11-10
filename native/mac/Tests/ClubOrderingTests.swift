import XCTest

/// 部活一覧の並び順（ドリキン 2026-11-09「自分でカスタマイズした順番か未読順かで選べるように」）。
final class ClubOrderingTests: XCTestCase {
    private let clubs = ["chat", "pet", "apple", "car", "improve"]
    private func keys(_ c: [String]) -> [String] { c }

    func testNoSavedOrderIsTheCatalog() {
        XCTAssertEqual(keys(ClubOrdering.ordered(clubs, key: { $0 }, saved: [], unread: [:], sort: .custom)), ["chat", "pet", "apple", "car", "improve"])
    }

    func testSavedFirstThenTheRestInCatalogOrder() {
        // "gone" (deleted / hidden) is skipped; the ones not placed follow in the catalog's order.
        let o = ClubOrdering.ordered(clubs, key: { $0 }, saved: ["car", "gone", "apple"], unread: [:], sort: .custom)
        XCTAssertEqual(keys(o), ["car", "apple", "chat", "pet", "improve"])
    }

    func testUnreadMostFirstTiesInMyOrder() {
        let o = ClubOrdering.ordered(clubs, key: { $0 }, saved: ["car", "apple"], unread: ["pet": 3, "improve": 3, "chat": 10], sort: .unread)
        XCTAssertEqual(keys(o), ["chat", "pet", "improve", "car", "apple"])
    }

    func testUnreadIgnoredInMyOrder() {
        let o = ClubOrdering.ordered(clubs, key: { $0 }, saved: [], unread: ["improve": 50], sort: .custom)
        XCTAssertEqual(keys(o).first, "chat")
    }

    func testBadge() {
        XCTAssertNil(ClubOrdering.badge(0))
        XCTAssertEqual(ClubOrdering.badge(7), "7")
        XCTAssertEqual(ClubOrdering.badge(100), "99+")
    }
}
