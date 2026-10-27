import XCTest
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// カスタム絵文字の登録（../shared/CustomEmojiRules.swift）: 名前の決まりがサーバ（lib/reactions.ts の CUSTOM_NAME_RE）と同じか、
/// 送る画像が 256KB に収まる形になるか。
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class CustomEmojiRulesTests: XCTestCase {
    // MARK: 名前

    func testNormalizedTrimsLowercasesAndDropsColons() {
        XCTAssertEqual(CustomEmojiRules.normalized("  Beagle "), "beagle")
        XCTAssertEqual(CustomEmojiRules.normalized(":sanzai:"), "sanzai")
        XCTAssertEqual(CustomEmojiRules.normalized("::wan::"), "wan")
    }

    func testValidNames() {
        XCTAssertNil(CustomEmojiRules.nameProblem("beagle"))
        XCTAssertNil(CustomEmojiRules.nameProblem("a_1"))
        XCTAssertNil(CustomEmojiRules.nameProblem("_"))
        XCTAssertNil(CustomEmojiRules.nameProblem(String(repeating: "a", count: 32)))
        // 大文字や前後の「:」はサーバと同じく小文字にして通す
        XCTAssertNil(CustomEmojiRules.nameProblem(":Beagle:"))
    }

    func testInvalidNames() {
        XCTAssertEqual(CustomEmojiRules.nameProblem(""), "名前を入れてください")
        XCTAssertEqual(CustomEmojiRules.nameProblem(" :: "), "名前を入れてください")
        XCTAssertEqual(CustomEmojiRules.nameProblem(String(repeating: "a", count: 33)), "名前は32文字までです")
        for bad in ["a-b", "a b", "ビーグル", "a.b", "é", "a:b", "ａ"] {
            XCTAssertEqual(CustomEmojiRules.nameProblem(bad), "名前は英小文字・数字・_ だけ使えます", bad)
        }
    }

    func testTakenName() {
        XCTAssertEqual(CustomEmojiRules.nameProblem("Wan", taken: ["wan"]), "その名前は既に使われています")
        XCTAssertNil(CustomEmojiRules.nameProblem("wan2", taken: ["wan"]))
    }

    func testSuggestedName() {
        XCTAssertEqual(CustomEmojiRules.suggestedName(fromFilename: "Beagle Face.png"), "beagle_face")
        XCTAssertEqual(CustomEmojiRules.suggestedName(fromFilename: "IMG-0012.HEIC"), "img_0012")
        XCTAssertEqual(CustomEmojiRules.suggestedName(fromFilename: "ビーグル.gif"), "")
        XCTAssertEqual(CustomEmojiRules.suggestedName(fromFilename: "犬dog!!.png"), "dog")
        XCTAssertEqual(CustomEmojiRules.suggestedName(fromFilename: String(repeating: "x", count: 40) + ".png").count, 32)
        for f in ["Beagle Face.png", "IMG-0012.HEIC", "犬dog!!.png"] {
            XCTAssertNil(CustomEmojiRules.nameProblem(CustomEmojiRules.suggestedName(fromFilename: f)), f)
        }
    }

    // MARK: 送り方と大きさ

    func testOutputChoice() {
        XCTAssertEqual(CustomEmojiRules.output(isGIF: true, byteCount: 1000), .asIs(mime: "image/gif", ext: "gif"))
        XCTAssertEqual(CustomEmojiRules.output(isGIF: true, byteCount: 256 * 1024), .asIs(mime: "image/gif", ext: "gif"))
        XCTAssertEqual(CustomEmojiRules.output(isGIF: true, byteCount: 256 * 1024 + 1), .png)
        XCTAssertEqual(CustomEmojiRules.output(isGIF: false, byteCount: 10), .png)
    }

    func testFittedSize() {
        XCTAssertTrue(CustomEmojiRules.fittedSize(width: 1024, height: 512) == (128, 64))
        XCTAssertTrue(CustomEmojiRules.fittedSize(width: 300, height: 900) == (43, 128))
        XCTAssertTrue(CustomEmojiRules.fittedSize(width: 64, height: 32) == (64, 32)) // 広げない
        XCTAssertTrue(CustomEmojiRules.fittedSize(width: 10_000, height: 1) == (128, 1)) // 1px 未満にしない
        XCTAssertTrue(CustomEmojiRules.fittedSize(width: 0, height: 10) == (0, 0))
    }

    // MARK: 実際の画像

    func testJPEGBecomesSmallPNG() throws {
        let jpeg = try encode(image(width: 1200, height: 800, noise: false), type: .jpeg)
        let out = try XCTUnwrap(CustomEmojiRules.prepare(jpeg))
        XCTAssertEqual(out.mime, "image/png")
        XCTAssertEqual(out.filename, "emoji.png")
        XCTAssertEqual(max(out.width, out.height), 128)
        XCTAssertLessThanOrEqual(out.data.count, CustomEmojiRules.maxBytes)
        XCTAssertEqual(typeOf(out.data), UTType.png.identifier)
    }

    func testSmallGIFKeptAsIs() throws {
        let gif = try encode(image(width: 64, height: 64, noise: false), type: .gif, frames: 3)
        XCTAssertLessThanOrEqual(gif.count, CustomEmojiRules.maxBytes)
        let out = try XCTUnwrap(CustomEmojiRules.prepare(gif))
        XCTAssertEqual(out.mime, "image/gif")
        XCTAssertEqual(out.data, gif) // 動きを残す（そのまま）
    }

    func testLargeGIFBecomesFirstFramePNG() throws {
        let gif = try encode(image(width: 700, height: 700, noise: true), type: .gif, frames: 2)
        XCTAssertGreaterThan(gif.count, CustomEmojiRules.maxBytes)
        let out = try XCTUnwrap(CustomEmojiRules.prepare(gif))
        XCTAssertEqual(out.mime, "image/png")
        XCTAssertEqual(max(out.width, out.height), 128)
        XCTAssertLessThanOrEqual(out.data.count, CustomEmojiRules.maxBytes)
    }

    func testNotAnImage() {
        XCTAssertNil(CustomEmojiRules.prepare(Data("hello".utf8)))
        XCTAssertNil(CustomEmojiRules.prepare(Data()))
    }

    func testMultipartBody() throws {
        let p = CustomEmojiRules.Prepared(data: Data([1, 2, 3]), mime: "image/png", filename: "emoji.png", width: 1, height: 1)
        let body = CustomEmojiRules.multipartBody(name: "beagle", image: p, boundary: "XYZ")
        let text = String(decoding: body, as: UTF8.self)
        XCTAssertTrue(text.hasPrefix("--XYZ\r\nContent-Disposition: form-data; name=\"name\"\r\n\r\nbeagle\r\n"))
        XCTAssertTrue(text.contains("name=\"image\"; filename=\"emoji.png\"\r\nContent-Type: image/png\r\n\r\n"))
        XCTAssertTrue(text.hasSuffix("\r\n--XYZ--\r\n"))
    }

    func testDeleteWarning() {
        XCTAssertEqual(CustomEmojiRules.deleteWarning("wan"), ":wan: を削除すると、この絵文字のリアクションも全部消えます")
    }

    // MARK: helpers

    private func image(width: Int, height: Int, noise: Bool) -> CGImage {
        let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        ctx.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.3, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        if noise, let p = ctx.data?.assumingMemoryBound(to: UInt8.self) {
            var seed: UInt32 = 12345
            for i in 0..<(ctx.bytesPerRow * height) where i % 4 != 3 {
                seed = seed &* 1_103_515_245 &+ 12345
                p[i] = UInt8(truncatingIfNeeded: seed >> 16)
            }
        }
        return ctx.makeImage()!
    }

    private func encode(_ cg: CGImage, type: UTType, frames: Int = 1) throws -> Data {
        let out = NSMutableData()
        let dest = try XCTUnwrap(CGImageDestinationCreateWithData(out, type.identifier as CFString, frames, nil))
        for _ in 0..<frames { CGImageDestinationAddImage(dest, cg, nil) }
        XCTAssertTrue(CGImageDestinationFinalize(dest))
        return out as Data
    }

    private func typeOf(_ data: Data) -> String? {
        CGImageSourceCreateWithData(data as CFData, nil).flatMap { CGImageSourceGetType($0) as String? }
    }
}
