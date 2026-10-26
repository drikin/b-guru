import XCTest

/// 🍻 アルバムをまとめて保存（../shared/OffkaiSaveNames.swift, docs/offkai-spec.md「アルバムをまとめて保存」）:
/// Web の zip（lib/offkai.ts の albumZip・safeFilePart）と同じ名前になるか。
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class OffkaiSaveNamesTests: XCTestCase {
    /// 2026-10-26 19:30:05 日本時間（= 10:30:05Z）。
    private let evening = ISO8601DateFormatter().date(from: "2026-10-26T10:30:05Z")!

    // MARK: safePart（サーバの safeFilePart と同じ）

    func testSafePartDropsForbiddenAndControl() {
        XCTAssertEqual(OffkaiSaveNames.safePart("a\\b/c:d*e?f\"g<h>i|j", max: 30), "abcdefghij")
        XCTAssertEqual(OffkaiSaveNames.safePart("x\u{0}y\u{1F}z\u{7F}", max: 30), "xyz")
        // 切ったあとの末尾の空白、先頭の「.」と空白は落とす（サーバと同じ）
        XCTAssertEqual(OffkaiSaveNames.safePart("123456789012345 6789", max: 16), "123456789012345")
        XCTAssertEqual(OffkaiSaveNames.safePart(". .abc", max: 16), "abc")
    }

    func testSafePartDropsFormatCharacters() {
        // U+202E（右から左へ）で「gpj.exe」を「exe.jpg」に見せる手を防ぐ。U+200B・U+FEFF も落とす。
        XCTAssertEqual(OffkaiSaveNames.safePart("ab\u{202E}gpj.exe", max: 30), "abgpj.exe")
        XCTAssertEqual(OffkaiSaveNames.safePart("x\u{200B}y\u{FEFF}z", max: 30), "xyz")
        XCTAssertEqual(OffkaiSaveNames.safePart("\u{202E}.名前", max: 30), "名前")
    }

    func testSafePartCollapsesSpacesAndTrims() {
        XCTAssertEqual(OffkaiSaveNames.safePart("  渋谷\t\n で　乾杯  ", max: 30), "渋谷 で 乾杯")
        XCTAssertEqual(OffkaiSaveNames.safePart("   ", max: 30), "")
        // 消した記号の両側の空白も 1 つに。
        XCTAssertEqual(OffkaiSaveNames.safePart("a / b", max: 30), "a b")
    }

    func testSafePartCutsByCodePointAndDropsLeadingDots() {
        XCTAssertEqual(OffkaiSaveNames.safePart("あいうえおかきくけこさしすせそたちつてとなにぬねの", max: 16), "あいうえおかきくけこさしすせそた")
        XCTAssertEqual(OffkaiSaveNames.safePart("..hidden", max: 16), "hidden")
        // 絵文字は JS の [...s] と同じくコードポイントで数える（👍🏽 は 2 つ）。
        XCTAssertEqual(OffkaiSaveNames.safePart("ab👍🏽", max: 3), "ab👍")
    }

    // MARK: ファイル名

    func testFileName() {
        XCTAssertEqual(OffkaiSaveNames.fileName(index: 0, count: 40, uploader: "ドリキン", createdAt: evening,
                                                url: "/api/media/offkai-abc.JPG"), "001_ドリキン_1930.jpg")
        XCTAssertEqual(OffkaiSaveNames.fileName(index: 11, count: 12, uploader: "mazzo", createdAt: evening,
                                                url: "/api/media/offkai-abc.png"), "012_mazzo_1930.png")
    }

    func testFileNameWidensForThousands() {
        XCTAssertEqual(OffkaiSaveNames.fileName(index: 6, count: 1200, uploader: "a", createdAt: evening, url: "x.jpg"), "0007_a_1930.jpg")
        XCTAssertEqual(OffkaiSaveNames.fileName(index: 999, count: 1000, uploader: "a", createdAt: evening, url: "x.jpg"), "1000_a_1930.jpg")
    }

    func testFileNameWithoutUploaderOrExtension() {
        XCTAssertEqual(OffkaiSaveNames.fileName(index: 1, count: 3, uploader: "", createdAt: evening, url: "/api/media/offkai-abc.jpg"),
                       "002_1930.jpg")
        XCTAssertEqual(OffkaiSaveNames.fileName(index: 1, count: 3, uploader: "???", createdAt: evening, url: "/api/media/offkai-abc"),
                       "002_1930")
    }

    func testFileNameSanitizesAndCutsUploader() {
        let name = OffkaiSaveNames.fileName(index: 0, count: 1, uploader: "a/b:c 12345678901234567890", createdAt: evening, url: "p.jpeg")
        XCTAssertEqual(name, "001_abc 123456789012_1930.jpeg")
    }

    func testFileNameUsesTokyoTimeAcrossMidnight() {
        // 15:05Z = 翌日 00:05 日本時間。
        let late = ISO8601DateFormatter().date(from: "2026-10-26T15:05:00Z")!
        XCTAssertEqual(OffkaiSaveNames.fileName(index: 0, count: 1, uploader: "a", createdAt: late, url: "x.jpg"), "001_a_0005.jpg")
    }

    func testFileExtension() {
        XCTAssertEqual(OffkaiSaveNames.fileExtension("/api/media/offkai-a.b.JPG"), ".jpg")
        XCTAssertEqual(OffkaiSaveNames.fileExtension("https://bsm.backspace.fm/api/media/offkai-a.webp?v=1"), ".webp")
        XCTAssertEqual(OffkaiSaveNames.fileExtension("/api/media.d/offkai-a"), "")
        XCTAssertEqual(OffkaiSaveNames.fileExtension(".hidden"), "")
    }

    // MARK: フォルダ名

    func testFolderName() {
        XCTAssertEqual(OffkaiSaveNames.folderName(title: "渋谷 オフ会", startedAt: evening), "B-guru オフ会 2026-10-26 渋谷 オフ会")
        XCTAssertEqual(OffkaiSaveNames.folderName(title: "", startedAt: evening), "B-guru オフ会 2026-10-26")
        XCTAssertEqual(OffkaiSaveNames.folderName(title: " / ", startedAt: evening), "B-guru オフ会 2026-10-26")
        let long = String(repeating: "あ", count: 40)
        XCTAssertEqual(OffkaiSaveNames.folderName(title: long, startedAt: evening), "B-guru オフ会 2026-10-26 " + String(repeating: "あ", count: 30))
    }

    func testFolderNameUsesTokyoDate() {
        let late = ISO8601DateFormatter().date(from: "2026-10-26T15:05:00Z")!
        XCTAssertEqual(OffkaiSaveNames.folderName(title: "", startedAt: late), "B-guru オフ会 2026-10-27")
    }

    // MARK: 上書きしない

    func testUniqueName() {
        XCTAssertEqual(OffkaiSaveNames.uniqueName("001_a_1930.jpg") { _ in false }, "001_a_1930.jpg")
        let taken: Set = ["001_a_1930.jpg", "001_a_1930 (2).jpg"]
        XCTAssertEqual(OffkaiSaveNames.uniqueName("001_a_1930.jpg") { taken.contains($0) }, "001_a_1930 (3).jpg")
        XCTAssertEqual(OffkaiSaveNames.uniqueName("002_1930") { $0 == "002_1930" }, "002_1930 (2)")
    }

    func testUniqueFolderKeepsDotsInTitle() {
        let name = "B-guru オフ会 2026-10-26 v2.0 リリース"
        XCTAssertEqual(OffkaiSaveNames.uniqueName(name, folder: true) { $0 == name }, name + " (2)")
    }

    func testResultMessage() {
        XCTAssertEqual(OffkaiSaveNames.resultMessage(saved: 40, failed: 0), "40 枚を保存しました")
        XCTAssertEqual(OffkaiSaveNames.resultMessage(saved: 38, failed: 2), "38 枚を保存、2 枚は失敗")
    }
}
