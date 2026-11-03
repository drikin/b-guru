import XCTest

/// 五撮 Vol.1 を端末の中で（../shared/Gosatsu.swift）: dk5090 の ffmpeg（promptcam_gateway.py の gosatsu_*）と
/// 同じ計算になっているか。期待値は ffmpeg 9.0 で出した値。写真での照合（平均の差 0.3〜0.7）は手元の検証用。
///   cd native/mac && xcodegen generate && xcodebuild test -project BguruChat.xcodeproj -scheme BguruChatTests
final class GosatsuTests: XCTestCase {
    /// ffmpeg の curves（自然 3 次スプライン）と同じ表になる。
    func testCurveMatchesFFmpeg() {
        let look = Gosatsu.curveLUT([(0, 0), (0.06, 0.045), (0.25, 0.225), (0.5, 0.5), (0.75, 0.785), (0.92, 0.925), (1, 0.975)])
        XCTAssertEqual([0, 10, 30, 64, 128, 192, 230, 250, 255].map { look[$0] }, [0, 7, 24, 58, 128, 201, 232, 245, 248])
        let hl = Gosatsu.curveLUT([(0, 0), (0.85, 0), (1, 1)])
        XCTAssertEqual([0, 100, 200, 216, 217, 230, 240, 255].map { hl[$0] }, [0, 0, 0, 0, 5, 86, 153, 255])
    }

    /// ffmpeg の gblur（1 段の再帰フィルタ）と同じ値になる。
    func testBlurMatchesFFmpeg() {
        let p: [UInt8] = [121, 66, 189, 242, 33, 6, 240, 132, 119, 98, 240, 243, 203, 77, 118, 77, 199, 7, 32, 81, 21, 154, 15, 137,
                          242, 198, 218, 202, 227, 68, 187, 49, 18, 69, 253, 111, 132, 223, 154, 215, 197, 179, 208, 118, 172, 14,
                          143, 83, 167, 53, 108, 136, 145, 63, 32, 246, 247, 45, 176, 34, 210, 77, 10, 150, 218, 212, 60, 22, 23,
                          193, 169, 142, 120, 18, 158, 3, 39, 55, 16, 101, 208, 149, 134, 79, 21, 173, 160, 184, 70, 193, 192, 235,
                          197, 52, 138, 220, 121, 154, 223, 132, 155, 173, 5, 212, 161, 10, 192, 68, 30, 170, 238, 180, 180, 142,
                          250, 11, 31, 10, 189, 128, 233, 152, 163, 90, 186, 94, 160, 189]
        let expected: [(Float, [UInt8], [UInt8])] = [
            (0.8, [121, 89, 155, 175, 68, 65, 166, 142, 139, 138, 214, 220, 188, 104, 114, 84], [193, 163, 98, 64]),
            (3, [125, 121, 129, 129, 117, 120, 136, 143, 147, 151, 163, 161, 151, 130, 123, 117], [148, 138, 131, 122]),
            (10, [133, 133, 134, 134, 133, 133, 135, 137, 137, 138, 140, 139, 138, 136, 135, 134], [138, 137, 136, 135]),
        ]
        for (sigma, row0, row4) in expected {
            let b = Gosatsu.gblur8(p, width: 16, height: 8, sigma: sigma)
            XCTAssertEqual(Array(b[0..<16]), row0, "sigma \(sigma)")
            XCTAssertEqual(Array(b[64..<68]), row4, "sigma \(sigma)")
        }
    }

    /// 写真ごとの土台（gosatsu_plan と同じ数値）。
    func testPlanFollowsThePhoto() {
        let flat = Gosatsu.plan(.init(yLow: 60, yHigh: 160, yAvg: 110, satAvg: 5, fine: 0.2, mid: 2))
        XCTAssertEqual(flat.levels.loOut, 48)  // 浮いた黒は引き下げる（最大 12）
        XCTAssertEqual(flat.levels.hiOut, 182.5)
        XCTAssertEqual(flat.sat, 1.12)
        XCTAssertEqual(flat.fine, 0.6)  // 柔らかい写真ほど最細部を足す
        let crisp = Gosatsu.plan(.init(yLow: 10, yHigh: 230, yAvg: 120, satAvg: 30, fine: 3, mid: 6))
        XCTAssertEqual(crisp.levels.loOut, 10)
        XCTAssertEqual(crisp.sat, 0.85)
        XCTAssertEqual(crisp.fine, 0)  // すでにシャープなスマホの写真には足さない
        XCTAssertTrue(Gosatsu.plan(.init(yLow: 20, yHigh: 200, yAvg: 50, satAvg: 0.5, fine: 1, mid: 4)).mono)
    }

    func testMonochromeStaysMonochromeAndSizeStays() {
        let (w, h) = (96, 64)
        var rgba = [UInt8](repeating: 255, count: w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                let v = UInt8((x * 255) / (w - 1))
                rgba[(y * w + x) * 4] = v
                rgba[(y * w + x) * 4 + 1] = v
                rgba[(y * w + x) * 4 + 2] = v
            }
        }
        let out = Gosatsu.apply(rgba: rgba, width: w, height: h, seed: 1)
        XCTAssertEqual(out.count, rgba.count)
        var maxCast = 0
        for i in 0..<(w * h) {
            let r = Int(out[i * 4]), g = Int(out[i * 4 + 1]), b = Int(out[i * 4 + 2])
            maxCast = max(maxCast, max(r, g, b) - min(r, g, b))
        }
        XCTAssertLessThanOrEqual(maxCast, 2)  // 色は付けない（YUV の丸めの ±1 程度だけ）
    }

    /// スマホ風のシャープ（縁取り）にならない: 輪郭から 2 px と 10 px の明るさの差が小さい
    /// （promptcam の test_no_outline_on_a_hard_edge と同じ測り方。スマホ風の unsharp では 20 を超える）。
    func testNoOutlineOnAHardEdge() {
        let (w, h) = (640, 480)
        var rgba = [UInt8](repeating: 255, count: w * h * 4)
        for y in 0..<h {
            for x in 0..<w {
                for c in 0..<3 { rgba[(y * w + x) * 4 + c] = x < w / 2 ? 60 : 190 }
            }
        }
        var p = Gosatsu.plan(.init(yLow: 60, yHigh: 190, yAvg: 125, satAvg: 0, fine: 0.2, mid: 1))
        p.dark = false
        let out = Gosatsu.render(Gosatsu.Planes(rgba: rgba, width: w, height: h), plan: p, seed: 1, grain: false)
        func y(_ x0: Int) -> Double {
            var s = 0.0
            for yy in 190..<290 { for x in x0..<(x0 + 2) { s += Double(out.g[yy * w + x]) } }
            return s / 200
        }
        XCTAssertLessThan(max(abs(y(318) - y(310)), abs(y(322) - y(330))), 8)
    }
}
