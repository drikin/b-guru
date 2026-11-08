import CoreGraphics

/// 部室の地図の倍率・カメラ・タップの座標変換（純粋な計算だけ。RoomView が使い、テストもここを見る）。
/// Web（src/ の部室）も同じ仕様: 倍率 = 自動の倍率 × 利用者の倍率（scale）。
///   - 自動の倍率: 横に 13 タイル（幅 600 未満）か 20 タイルが見える倍率（今までの固定の倍率）。
///   - scale の下限: 地図全体がちょうど収まる倍率 ÷ 自動の倍率（ただし 1 より大きくはしない —
///     地図が画面より小さいときも 1.0 は今までと同じ見た目のまま）。上限は 2（自動の倍率の 2 倍）。
///   - scale は端末に覚える（UserDefaults "roomZoomScale"）。0 以下や下限より小さい値は「全体」。
enum RoomZoom {
    static let scaleKey = "roomZoomScale"
    static let expandedKey = "roomExpanded"
    /// −/＋ 1 回の倍率。
    static let step: CGFloat = 1.25
    static let maxScale: CGFloat = 2
    /// 地図の部分の高さ（囲む画面の高さに対する割合）: ふだん / 広げたとき（チャット欄を最低限残す）。
    static let normalHeight: CGFloat = 0.5
    static let expandedHeight: CGFloat = 0.85
    private static let tile: CGFloat = 16

    static func heightFraction(expanded: Bool) -> CGFloat { expanded ? expandedHeight : normalHeight }

    /// 今までの固定の倍率（scale 1.0 のときの倍率）。
    static func auto(view: CGSize) -> CGFloat {
        let tilesAcross: CGFloat = view.width < 600 ? 13 : 20
        return max(1.5, view.width / (tile * tilesAcross))
    }

    /// 地図全体がちょうど収まる倍率。地図の大きさは art-pixel（タイル数 × 16）。
    static func fit(view: CGSize, map: CGSize) -> CGFloat {
        guard map.width > 0, map.height > 0, view.width > 0, view.height > 0 else { return auto(view: view) }
        return min(view.width / map.width, view.height / map.height)
    }

    /// scale の下限（「全体」）。
    static func minScale(view: CGSize, map: CGSize) -> CGFloat {
        min(1, fit(view: view, map: map) / auto(view: view))
    }

    static func clamp(_ scale: CGFloat, view: CGSize, map: CGSize) -> CGFloat {
        let lo = minScale(view: view, map: map)
        guard scale.isFinite else { return 1 }
        return min(maxScale, max(lo, scale))
    }

    /// 画面に描く倍率（art-pixel 1 つが何ポイントか）。
    static func zoom(scale: CGFloat, view: CGSize, map: CGSize) -> CGFloat {
        auto(view: view) * clamp(scale, view: view, map: map)
    }

    static func zoomedIn(_ scale: CGFloat, view: CGSize, map: CGSize) -> CGFloat {
        clamp(clamp(scale, view: view, map: map) * step, view: view, map: map)
    }

    static func zoomedOut(_ scale: CGFloat, view: CGSize, map: CGSize) -> CGFloat {
        clamp(clamp(scale, view: view, map: map) / step, view: view, map: map)
    }

    /// 全体が見えている（scale が下限）か。
    static func isWhole(_ scale: CGFloat, view: CGSize, map: CGSize) -> Bool {
        clamp(scale, view: view, map: map) <= minScale(view: view, map: map) + 0.001
    }

    /// 「全体」: 全体が見えていれば 1.0 へ、そうでなければ全体（0 = いつも下限。画面の大きさが変わっても全体のまま）。
    static func toggledWhole(_ scale: CGFloat, view: CGSize, map: CGSize) -> CGFloat {
        isWhole(scale, view: view, map: map) && minScale(view: view, map: map) < 1 ? 1 : 0
    }

    /// 表示の左上（art-pixel）。focus（タイル座標、たとえば自分）を真ん中に追いかけ、地図の端では止め、
    /// 地図が画面より小さい向きは真ん中に寄せる。
    static func camera(view: CGSize, z: CGFloat, map: CGSize, focus: (x: Double, y: Double)) -> CGPoint {
        let vw = view.width / z, vh = view.height / z
        let cx = (CGFloat(focus.x) + 0.5) * tile - vw / 2, cy = (CGFloat(focus.y) + 0.5) * tile - vh / 2
        let x = map.width <= vw ? (map.width - vw) / 2 : min(max(cx, 0), map.width - vw)
        let y = map.height <= vh ? (map.height - vh) / 2 : min(max(cy, 0), map.height - vh)
        return CGPoint(x: x.rounded(), y: y.rounded())
    }

    /// 画面の点（ポイント）→ タイル。描くときと同じ z と cam を使う。
    static func tile(at p: CGPoint, z: CGFloat, cam: CGPoint) -> (x: Int, y: Int) {
        (Int((((p.x / z) + cam.x) / tile).rounded(.down)), Int((((p.y / z) + cam.y) / tile).rounded(.down)))
    }
}
