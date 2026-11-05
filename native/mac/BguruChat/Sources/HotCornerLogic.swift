import CoreGraphics

/// 画面の隅でパネルを開閉する（自前のホットコーナー、ドリキン 2026-11-04）。macOS のホットコーナーにはほかのアプリの動作を
/// 登録できないので、マウスの位置を見て自分で決める。ここは決め方だけ（単体テストあり）、見張りは HotCorner.swift。
/// - 座標は AppKit の画面座標（左下が原点、y は上へ）。画面ごとの隅で判定する（外部ディスプレイの隅でも開く）。
/// - 隅に入ってから少し止まったら開く（通りすぎただけでは開かない）。開いたら隅を出るまで次は開かない。
enum HotCornerLogic {
    enum Corner: String, CaseIterable, Identifiable {
        case off, topLeft, topRight, bottomLeft, bottomRight
        var id: String { rawValue }
        var label: String {
            switch self {
            case .off: return "使わない"
            case .topLeft: return "左上"
            case .topRight: return "右上"
            case .bottomLeft: return "左下"
            case .bottomRight: return "右下"
            }
        }
    }

    /// 隅とみなす幅（pt）。マウスを隅へ押し付けると端の 1px に止まるので、少しだけ余裕を持たせる。
    static let reach: CGFloat = 3
    /// 隅を出たとみなす距離（pt）。出入りの境目で何度も開かないように、入る幅より広くとる。
    static let leave: CGFloat = 24
    /// 隅で止まってから開くまで（秒）。ほぼすぐ（ドリキン 2026-11-04「もっと一瞬で」）。通りすぎただけで開かない程度。
    static let dwell: Double = 0.08

    /// その点が、どれかの画面の指定した隅にあるか（ある画面の番号）。
    static func screenIndex(at p: CGPoint, corner: Corner, screens: [CGRect], within d: CGFloat = reach) -> Int? {
        guard corner != .off else { return nil }
        for (i, f) in screens.enumerated() {
            // mouseLocation は右端・上端で maxX・maxY ちょうどになることも、1 小さいこともある
            let left = p.x <= f.minX + d, right = p.x >= f.maxX - 1 - d
            let bottom = p.y <= f.minY + d, top = p.y >= f.maxY - 1 - d
            let inX = p.x >= f.minX - 1 && p.x <= f.maxX + 1, inY = p.y >= f.minY - 1 && p.y <= f.maxY + 1
            guard inX, inY else { continue }
            let hit: Bool
            switch corner {
            case .topLeft: hit = left && top
            case .topRight: hit = right && top
            case .bottomLeft: hit = left && bottom
            case .bottomRight: hit = right && bottom
            case .off: hit = false
            }
            guard hit, isOuterCorner(corner, of: f, screens: screens) else { continue }
            return i
        }
        return nil
    }

    /// その隅の外側（横・縦・斜めに少し出た所）にほかの画面がないか。画面どうしの内側の境目は、マウスの通り道なので隅にしない。
    static func isOuterCorner(_ corner: Corner, of f: CGRect, screens: [CGRect]) -> Bool {
        let out: CGFloat = 2
        let (x, y, dx, dy): (CGFloat, CGFloat, CGFloat, CGFloat)
        switch corner {
        case .topLeft: (x, y, dx, dy) = (f.minX, f.maxY - 1, -out, out)
        case .topRight: (x, y, dx, dy) = (f.maxX - 1, f.maxY - 1, out, out)
        case .bottomLeft: (x, y, dx, dy) = (f.minX, f.minY, -out, -out)
        case .bottomRight: (x, y, dx, dy) = (f.maxX - 1, f.minY, out, -out)
        case .off: return false
        }
        let probes = [CGPoint(x: x + dx, y: y), CGPoint(x: x, y: y + dy), CGPoint(x: x + dx, y: y + dy)]
        return !probes.contains { p in screens.contains { $0 != f && $0.contains(p) } }
    }

    /// 前のアプリがその画面でフルスクリーンか（座標はすべて左上が原点の CG の画面座標）。
    /// - その画面に Dock の画面全体の窓がない（普段の Space では Dock が画面全体の窓を出していて、フルスクリーンの Space では消える。
    ///   ノッチのある画面ではフルスクリーンでもメニューバーの窓が残るので、メニューバーでは見分けられない。2026-11-04 実機で確認）
    /// - かつ、前のアプリの窓が画面の幅いっぱいで下の端まであり、上はノッチの下から（ノッチの分だけ低くてよい）
    static func isFullScreen(appWindows: [CGRect], dockWindows: [CGRect], display: CGRect, notch: CGFloat) -> Bool {
        let dockCovers = dockWindows.contains { abs($0.minX - display.minX) < 1 && abs($0.minY - display.minY) < 1
            && abs($0.width - display.width) < 1 && abs($0.height - display.height) < 1 }
        guard !dockCovers else { return false }
        return appWindows.contains { b in
            abs(b.minX - display.minX) < 1 && abs(b.width - display.width) < 1
                && abs(b.maxY - display.maxY) < 1 && b.minY <= display.minY + notch + 1
        }
    }

    /// 開いたあと、隅を出たか（leave より離れたら次に開けるようにする）。
    static func hasLeft(_ p: CGPoint, corner: Corner, screens: [CGRect]) -> Bool {
        screenIndex(at: p, corner: corner, screens: screens, within: leave) == nil
    }
}
