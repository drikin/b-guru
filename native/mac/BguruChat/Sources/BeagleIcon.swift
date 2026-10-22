import AppKit

/// メニューバーのビーグルの絵（Mac のメニューバーだけ。アプリのアイコン・iOS・Android・Web は別）。
///
/// SF Symbols の dog / dog.fill を左右反転して左向きにする（ティッカーの文字が左へ流れるので、左を向いて吠えて送り出す）。
/// キャンバスは記号と同じ 22×17pt・alignmentRect も同じなので、ボタンの中の位置・幅・未読の数の位置は変わらない。
/// 幅 22 は整数なので、反転しても @1x・@2x のピクセルの格子がそのまま重なる（足元・体は反転前と同じ格子に乗る）。
///
/// 吠えるコマ（1〜3）は通常の絵と同じ描き方の上に、鼻先の下を細く切って口を開け、短い下あごと「ワン」の短い線（顔の前＝左）を足すだけ。
/// 体・足元には触らないので、コマを差し替えても体は 1px も動かない。座標は整数か 0.5（@2x の 1px）。
@MainActor
enum BeagleIcon {
    /// 吠えるコマの数（0 = 通常の絵）。
    static let barkFrames = 3
    private static var cache: [String: NSImage] = [:]

    /// `filled`: 未読あり（dog.fill）。`bark`: 0 = 通常、1〜3 = 吠えるコマ。
    static func image(filled: Bool, bark: Int = 0) -> NSImage {
        let key = "\(filled)-\(bark)"
        if let img = cache[key] { return img }
        let symbol = NSImage(systemSymbolName: filled ? "dog.fill" : "dog", accessibilityDescription: nil) ?? NSImage()
        let size = symbol.size
        let k = bark
        let img = NSImage(size: size, flipped: true) { rect in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.saveGState()
            // 左向き：キャンバスの幅（整数）で左右反転。以下の座標は右向きの絵の上から測った pt。
            ctx.translateBy(x: size.width, y: 0)
            ctx.scaleBy(x: -1, y: 1)
            symbol.draw(in: rect)
            if k > 0 {
                func P(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }
                // 口：鼻先の下半分を細い三角に切る（上あごは残す）
                ctx.setBlendMode(.clear)
                ctx.beginPath()
                ctx.move(to: P(22, 5)); ctx.addLine(to: P(18, 5.5)); ctx.addLine(to: P(22, 9))
                ctx.closePath(); ctx.fillPath()
                ctx.setBlendMode(.normal)
                NSColor.black.set()
                ctx.setLineCap(.round)
                // 下あご（3 コマ目は半分閉じる）
                let o: CGFloat = k == 3 ? 0.5 : 1
                ctx.setLineWidth(1.5)
                ctx.beginPath(); ctx.move(to: P(18, 6)); ctx.addLine(to: P(20, 6 + 1.5 * o)); ctx.strokePath()
                // 「ワン」の短い線（顔の前。キャンバスの中なので隣のアイコンにかからない）
                ctx.setLineWidth(1)
                let lines: [(CGPoint, CGPoint)] = [(P(21, 2), P(22, 1)), (P(20, 1), P(20.5, 0)), (P(21.5, 7), P(21.5, 8))]
                let n = k == 1 ? 1 : (k == 2 ? 3 : 2)
                for l in lines.prefix(n) {
                    ctx.beginPath(); ctx.move(to: l.0); ctx.addLine(to: l.1); ctx.strokePath()
                }
            }
            ctx.restoreGState()
            return true
        }
        img.isTemplate = true
        img.alignmentRect = symbol.alignmentRect // ボタンの中の置き方を記号と同じに
        img.accessibilityDescription = "B-guru"
        cache[key] = img
        return img
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
        case message = "新着", mention = "メンション", notice = "お知らせ"
    }
    static let frameInterval: TimeInterval = 0.16
    /// 1 回の吠え：口を開け閉め（0.8 秒）。メンションは 2 回。
    static let once = [1, 2, 3, 2, 1]
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
        sequence = kind == .mention ? Self.once + [0] + Self.once : Self.once
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
        button.image = BeagleIcon.image(filled: filled, bark: k)
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
        item.button?.image = BeagleIcon.image(filled: filled)
    }
}
