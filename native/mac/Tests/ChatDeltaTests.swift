import XCTest

/// The chat's catch-up after a reconnect (ChatDelta, owner 2026-11-25).
final class ChatDeltaTests: XCTestCase {
    struct Msg: ChatDeltaItem, Codable, Equatable { var id: Int; var sig: String?; var body: String; var createdAt: String }
    private func m(_ id: Int, _ sig: String?, body: String = "", at: String = "2026-11-25T00:00:00Z") -> Msg {
        Msg(id: id, sig: sig, body: body.isEmpty ? "m\(id)" : body, createdAt: at)
    }
    private func w(_ pairs: [(Int, String)]) -> [ChatDelta.WindowEntry] { pairs.map { .init(id: $0.0, sig: $0.1) } }

    func testNothingChangedReadsNothing() {
        let local = [m(1, "a"), m(2, "b"), m(3, "c")]
        let p = ChatDelta.plan(local: local, window: w([(1, "a"), (2, "b"), (3, "c")]))
        XCTAssertEqual(p, .init(removed: [], reread: []))
        XCTAssertEqual(ChatDelta.merge(local: local, plan: p, reread: [], new: []).map(\.id), [1, 2, 3])
    }

    func testChangedGoneMissingAndStreamChanged() {
        let local = [m(1, "a"), m(2, "b"), m(3, nil), m(5, "e")]
        // 1 edited, 2 deleted, 3 changed by the stream (no sig), 4 missed here, 5 the same
        let p = ChatDelta.plan(local: local, window: w([(1, "A"), (3, "c"), (4, "d"), (5, "e")]))
        XCTAssertEqual(p.removed, [2])
        XCTAssertEqual(p.reread, [1, 3, 4])
        let merged = ChatDelta.merge(local: local, plan: p, reread: [m(1, "A", body: "直した"), m(4, "d")], new: [m(6, "f")])
        XCTAssertEqual(merged.map(\.id), [1, 4, 5, 6]) // 3 was asked for and did not come back: gone
        XCTAssertEqual(merged.first?.body, "直した")
    }

    func testKeepsTheNewest() {
        let local = (1...10).map { m($0, "s\($0)") }
        let p = ChatDelta.plan(local: local, window: w(local.map { ($0.id, $0.sig!) }))
        let merged = ChatDelta.merge(local: local, plan: p, reread: [], new: [m(11, "x"), m(12, "y")], keep: 5)
        XCTAssertEqual(merged.map(\.id), [8, 9, 10, 11, 12])
    }

    func testWindowDecodesPairs() throws {
        let json = #"[[7,"abc"],[9,"def"]]"#
        let r = try JSONDecoder().decode([ChatDelta.WindowEntry].self, from: Data(json.utf8))
        XCTAssertEqual(r, w([(7, "abc"), (9, "def")]))
    }

    func testOldRowsAreNotShown() {
        let now = ISO8601DateFormatter().date(from: "2026-11-25T12:00:00Z")!
        let kept = ChatDelta.fresh([m(1, "a", at: "2026-11-24T11:00:00Z"), m(2, "b", at: "2026-11-25T11:00:00.123Z")], now: now)
        XCTAssertEqual(kept.map(\.id), [2])
    }

    func testCacheFilesAreKeptApartAndNotForDemo() {
        XCTAssertNil(LocalCache.url("chat", token: "demo"))
        XCTAssertNil(LocalCache.url("chat", token: ""))
        XCTAssertNotEqual(LocalCache.url("chat", token: "a"), LocalCache.url("chat", token: "b"))
        XCTAssertEqual(LocalCache.url("chat", token: "a"), LocalCache.url("chat", token: "a"))
    }
}
