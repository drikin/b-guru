import AppKit

/// メニューバーのビーグルの絵（Mac のメニューバーだけ。アプリのアイコン・iOS・Android・Web は別）。
///
/// SF Symbols の dog / dog.fill（22×17pt）を左右反転して左向きにし（ティッカーの文字が左へ流れるので、左を向いて吠えて送り出す）、
/// 顔の前（左）に 8pt の余白を足した 30×17pt のキャンバスに描く。余白は通常のときもあるので、吠えても幅は変わらない。
/// 幅は整数なので、反転しても @1x・@2x のピクセルの格子がそのまま重なる。
///
/// 吠えるコマ（1〜4）: 首から前・上を上へ 1pt 引き伸ばして頭を上げ（境目でつながる。足・後ろ足・しっぽには触らない）、
/// 口を大きく開け、余白に太い「ワン」の線を放射状に 3 本（1 コマ目は 1 本、3 コマ目は長く）、4 コマ目は「!」。
/// 座標は右向きの絵の上から測った pt（犬は x 0〜22、余白は x 22〜30）。
@MainActor
enum BeagleIcon {
    static let canvas = NSSize(width: 30, height: 17)
    static let dogWidth: CGFloat = 22
    private static var cache: [String: NSImage] = [:]

    /// `filled`: 未読あり（dog.fill）。`bark`: 0 = 通常、1〜4 = 吠えるコマ。
    static func image(filled: Bool, bark: Int = 0) -> NSImage {
        let key = "\(filled)-\(bark)"
        if let img = cache[key] { return img }
        let symbol = NSImage(systemSymbolName: filled ? "dog.fill" : "dog", accessibilityDescription: nil) ?? NSImage()
        let W = canvas.width
        let k = bark
        let img = NSImage(size: canvas, flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.saveGState()
            defer { ctx.restoreGState() }
            ctx.translateBy(x: W, y: 0) // 左向き：キャンバスの幅で左右反転
            ctx.scaleBy(x: -1, y: 1)
            let dog = NSRect(x: 0, y: 0, width: dogWidth, height: 17)
            guard k > 0 else { symbol.draw(in: dog); return true }
            func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
            // 頭を上げる：首から前・上（x ≥ hx, y ≤ hy）だけを上へ 1pt 引き伸ばす。y = hy の境目で体とつながる。
            let hx: CGFloat = 13, hy: CGFloat = 8, top: CGFloat = 1.1, lift: CGFloat = 1
            ctx.saveGState()
            ctx.addRect(CGRect(x: 0, y: 0, width: W, height: 17))
            ctx.addRect(CGRect(x: hx, y: -2, width: dogWidth - hx, height: hy + 2))
            ctx.clip(using: .evenOdd)
            symbol.draw(in: dog)
            ctx.restoreGState()
            ctx.saveGState()
            ctx.clip(to: CGRect(x: hx, y: -2, width: dogWidth - hx + 1, height: hy + 2))
            ctx.translateBy(x: 0, y: hy)
            ctx.scaleBy(x: 1, y: (hy - top + lift) / (hy - top))
            ctx.translateBy(x: 0, y: -hy)
            symbol.draw(in: dog)
            ctx.restoreGState()
            // 口を大きく開ける：鼻先の下半分を三角に切り、太い下あごを描く
            ctx.setBlendMode(.clear)
            ctx.beginPath()
            ctx.move(to: P(23, 4.6)); ctx.addLine(to: P(17.5, 5.2)); ctx.addLine(to: P(23, 11))
            ctx.closePath(); ctx.fillPath()
            ctx.setBlendMode(.normal)
            NSColor.black.set()
            ctx.setLineCap(.round)
            ctx.setLineWidth(1.8)
            ctx.beginPath(); ctx.move(to: P(17.6, 6.2)); ctx.addLine(to: P(20, 7.8)); ctx.strokePath()
            // 「ワン」：余白に放射状の太い線（1 コマ目は 1 本、2 コマ目は 3 本、3 コマ目は長く）、4 コマ目は「!」
            ctx.setLineWidth(1.5)
            if k <= 3 {
                let near: CGFloat = k == 3 ? 23.5 : 23
                let far: CGFloat = k == 1 ? 26 : (k == 2 ? 27.5 : 29.5)
                let rays: [(CGPoint, CGPoint)] = [(P(near, 6), P(far, 6)), (P(near, 3.2), P(far - 0.5, 1)), (P(near, 8.8), P(far - 0.5, 11))]
                for r in rays.prefix(k == 1 ? 1 : 3) {
                    ctx.beginPath(); ctx.move(to: r.0); ctx.addLine(to: r.1); ctx.strokePath()
                }
            } else {
                ctx.setLineWidth(2)
                ctx.beginPath(); ctx.move(to: P(27, 1.5)); ctx.addLine(to: P(27, 6.5)); ctx.strokePath()
                ctx.fillEllipse(in: CGRect(x: 26, y: 8.2, width: 2, height: 2))
                ctx.setLineWidth(1.5)
                ctx.beginPath(); ctx.move(to: P(23, 3)); ctx.addLine(to: P(24.5, 1.5)); ctx.strokePath()
                ctx.beginPath(); ctx.move(to: P(23, 8.5)); ctx.addLine(to: P(24.5, 10)); ctx.strokePath()
            }
            return true
        }
        var align = symbol.alignmentRect
        align.size.width = W
        let baked = bake(img, alignment: align) // ボタンの中の縦の置き方は記号と同じ（横はキャンバス全体）
        cache[key] = baked
        return baked
    }

    /// 描き方（drawingHandler）の絵を @1x・@2x のビットマップに焼いておく（コマを差し替えるたびに描き直さない）。
    static func bake(_ img: NSImage, alignment: NSRect) -> NSImage {
        let out = NSImage(size: canvas)
        for scale in [1, 2] {
            let w = Int(canvas.width) * scale, h = Int(canvas.height) * scale
            guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
            rep.size = canvas
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            img.draw(in: NSRect(origin: .zero, size: canvas))
            NSGraphicsContext.restoreGraphicsState()
            out.addRepresentation(rep)
        }
        out.isTemplate = true
        out.alignmentRect = alignment
        out.accessibilityDescription = "B-guru"
        return out
    }
}

extension BeagleIcon {
    /// 未読の数の文字（数字の幅をそろえる：1→2 などで幅が変わってビーグルが横にずれないように）。
    static func countTitle(_ text: String) -> NSAttributedString {
        let size = NSFont.menuBarFont(ofSize: 0).pointSize
        return NSAttributedString(string: text, attributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .regular)])
    }
}

/// 新着でビーグルが吠える（絵の差し替えだけ。位置・大きさ・回転は動かさない）。
/// 刻みはタイマー（Core Animation は macOS 26 のメニューバーで動かなかった前例があるため）。終わったら最新の状態の絵に戻す。
@MainActor
final class BeagleBarker {
    enum Kind: String {
        case message = "新着", mention = "メンション", notice = "お知らせ", suggest = "おすすめ", assistant = "アシスタント"
    }
    static let frameInterval: TimeInterval = 0.15
    /// 1 回の吠え（約 1.2 秒）：頭を上げて口を開け、線が伸びて「!」、最後に通常の絵で一息。新着・お知らせは 2 回、メンションは 3 回。
    static let once = [1, 2, 3, 2, 3, 4, 4, 0]
    static let minGap: TimeInterval = 10

    private let item: NSStatusItem
    var enabled = true
    /// 吠えてよいか（チャットを見ていない・静かな時間でない）。理由を返す（nil = よい）。
    var blockedReason: () -> String? = { nil }
    /// 最新の状態（未読あり＝塗りつぶし）。吠えている途中に変わっても、終わったらこれに戻す。
    var filled = false
    private var timer: Timer?
    private var sequence: [Int] = []
    private var lastBark: Date?
    /// 走る機能がオンのとき：コマを自分で描かず、これを呼ぶ（走る機能がレイヤーで描く）。
    var onFrame: (() -> Void)?
    /// 今の吠えるコマ（nil = 吠えていない）。
    private(set) var currentFrame: Int?
    private var startFrame: NSRect?

    init(item: NSStatusItem) {
        self.item = item
    }

    var isBarking: Bool { timer != nil }

    func bark(_ kind: Kind) {
        guard enabled else { return }
        if let why = blockedReason() { StatusBarDiag.note("吠えない（\(why)）"); return }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { StatusBarDiag.note("吠えない（視差効果を減らす）"); return }
        if isBarking { return }
        if let t = lastBark, Date().timeIntervalSince(t) < Self.minGap {
            StatusBarDiag.note("吠えない（10 秒以内）")
            return
        }
        lastBark = Date()
        let times = kind == .mention ? 3 : (kind == .suggest || kind == .assistant ? 1 : 2)
        sequence = Array(repeating: Self.once, count: times).flatMap { $0 }
        startFrame = nil
        StatusBarDiag.note("吠えた（\(kind.rawValue)）")
        // 未読の数（ボタンの幅）が先に変わるのを待ってから始める（吠えているあいだは幅も位置も変えない）。
        let t = Timer(timeInterval: Self.frameInterval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.step() }
        }
        t.fireDate = Date().addingTimeInterval(0.12)
        RunLoop.main.add(t, forMode: .common)
        timer = t
    }

    private func step() {
        guard let button = item.button else { stop(); return }
        guard !sequence.isEmpty else { stop(); return }
        let k = sequence.removeFirst()
        #if DEBUG
        let before = button.frame
        let winBefore = button.window?.frame ?? .zero
        #endif
        if let onFrame {
            currentFrame = k
            onFrame()
        } else {
            button.image = BeagleIcon.image(filled: filled, bark: k)
        }
        #if DEBUG
        button.layoutSubtreeIfNeeded()
        if startFrame == nil { startFrame = before }
        NSLog("[bark] コマ %d: ボタン %@ 窓 %@%@", k, NSStringFromRect(button.frame), NSStringFromRect(winBefore),
              button.frame != before || startFrame != before ? "（変わった）" : "")
        #endif
    }

    /// 終わり：必ず最新の状態の絵に戻す。
    func stop() {
        timer?.invalidate()
        timer = nil
        sequence = []
        currentFrame = nil
        if let onFrame { onFrame() } else { item.button?.image = BeagleIcon.image(filled: filled) }
    }
}
