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
    /// 焼いた絵（電池の絵が変わったら BeagleRunner の分も含めて捨てる）。
    static var cache: [String: NSImage] = [:]
    /// ☕ スリープさせないが入っているあいだ、顔の前の足元に小さなカップの印を描く（どの絵にも。幅・位置は変わらない）。
    static var awake = false
    /// 🔋 ビーグルで電池の残量を見せる（nil = 見せない。いつもどおり体の塗り＝未読）。見せているあいだは未読でも体を塗らない。
    static var battery: BatteryBeagleLogic.Look? {
        didSet { if battery != oldValue { clearCaches() } }
    }
    /// キャッシュの鍵に足す今の印（☕・🔋）。
    static var styleKey: String { (awake ? "-awake" : "") + (battery.map { "-batt\($0.key)" } ?? "") }

    /// `filled`: 未読あり（dog.fill）。`bark`: 0 = 通常、1〜4 = 吠えるコマ。
    static func image(filled: Bool, bark: Int = 0) -> NSImage {
        let key = "\(filled)-\(bark)\(styleKey)"
        if let img = cache[key] { return img }
        let symbol = dogSymbol(filled: filled)
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
        let baked = bake(img, alignment: alignment, mark: awake, bolt: battery?.charging == true && k == 0) // 吠えるコマは ⚡ を出さない（「ワン」の線と重なる）
        cache[key] = baked
        return baked
    }

    /// ボタンの中の置き方（縦は記号 dog と同じ、横はキャンバス全体）。電池の絵でも同じ（位置が動かないように）。
    static var alignment: NSRect {
        var align = (NSImage(systemSymbolName: "dog", accessibilityDescription: nil) ?? NSImage()).alignmentRect
        align.size.width = canvas.width
        return align
    }

    /// 描き方（drawingHandler）の絵を @1x・@2x のビットマップに焼いておく（コマを差し替えるたびに描き直さない）。
    /// `mark`: ☕ の印（スリープさせない）を足す。`bolt`: ⚡ の印（充電中）を足す。
    static func bake(_ img: NSImage, alignment: NSRect, mark: Bool = false, bolt: Bool = false) -> NSImage {
        let out = NSImage(size: canvas)
        for scale in [1, 2] {
            let w = Int(canvas.width) * scale, h = Int(canvas.height) * scale
            guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4,
                                             hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { continue }
            rep.size = canvas
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
            img.draw(in: NSRect(origin: .zero, size: canvas))
            if mark { drawAwakeMark() }
            if bolt { drawChargingMark() }
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
    /// ☕ の印：顔の前の余白（左 8pt）の足元に 3.4×3pt のカップと取っ手。吠える線（余白の上・中ほど）とは重ならない。
    /// 座標は焼くときのキャンバス（左下が原点、左向きの絵）。足先の線（下から 2pt）に置く。テンプレートのまま（黒の形だけ）。
    fileprivate static func drawAwakeMark() {
        NSColor.black.set()
        NSBezierPath(roundedRect: NSRect(x: 1.2, y: 2, width: 3.4, height: 3), xRadius: 0.8, yRadius: 0.8).fill()
        let handle = NSBezierPath()
        handle.lineWidth = 0.9
        handle.appendArc(withCenter: NSPoint(x: 4.6, y: 3.6), radius: 1.0, startAngle: -90, endAngle: 90)
        handle.stroke()
    }

    /// ⚡ の印（充電中）：顔の前の余白（左 8pt）の上の方に 4×6.6pt の稲妻。☕ のカップ（足元）とは重ならない。
    /// 吠えるコマでは描かない（「ワン」の線が余白に出るので）。座標は焼くときのキャンバス（左下が原点、左向きの絵）。
    fileprivate static func drawChargingMark() {
        NSColor.black.set()
        let p = NSBezierPath()
        p.move(to: NSPoint(x: 4.6, y: 16.4))
        p.line(to: NSPoint(x: 1.3, y: 12.4))
        p.line(to: NSPoint(x: 3.0, y: 12.4))
        p.line(to: NSPoint(x: 2.2, y: 9.8))
        p.line(to: NSPoint(x: 5.5, y: 13.8))
        p.line(to: NSPoint(x: 3.8, y: 13.8))
        p.close()
        p.fill()
    }

    /// 体の高さ（右向きの絵の上から測った pt。記号の一番上の線〜足先の線）。電池の塗りはこの間を下から満たす。
    static let bodyTop: CGFloat = 1, bodyBottom: CGFloat = 16
    /// 塗りの段の数（体の縦を 0.5pt ずつ = @2x の 1 画素ずつ）。
    static let fillSteps = Int((bodyBottom - bodyTop) * 2)

    /// 犬の絵（22×17pt、右向き）。いつもは記号の dog / dog.fill。電池を見せているときは、輪郭（dog）に
    /// 残量ぶんの塗り（dog.fill を下から切り取ったもの）を重ね、しょんぼりなら頭を下げる。吠える・走るコマもこれを元に作る。
    static func dogSymbol(filled: Bool) -> NSImage {
        guard let b = battery else {
            return NSImage(systemSymbolName: filled ? "dog.fill" : "dog", accessibilityDescription: nil) ?? NSImage()
        }
        let outline = NSImage(systemSymbolName: "dog", accessibilityDescription: nil) ?? NSImage()
        let solid = NSImage(systemSymbolName: "dog.fill", accessibilityDescription: nil) ?? NSImage()
        let size = NSSize(width: dogWidth, height: 17)
        let dog = NSRect(origin: .zero, size: size)
        // 輪郭＋塗り（塗りは残量の線から下だけ）
        func gauge(_ ctx: CGContext) {
            outline.draw(in: dog)
            guard b.fillSteps > 0 else { return }
            let line = bodyBottom - CGFloat(b.fillSteps) * (bodyBottom - bodyTop) / CGFloat(max(b.steps, 1))
            ctx.saveGState()
            ctx.clip(to: CGRect(x: -1, y: b.fillSteps >= b.steps ? -1 : line, width: dogWidth + 2, height: 20))
            solid.draw(in: dog)
            ctx.restoreGState()
        }
        let flat = raster { ctx in gauge(ctx) }
        guard b.droopy else { return flat }
        // 傾ける絵は 16 倍のビットマップから描く（記号を傾けて描くと、ぼやけたビットマップにされる）
        return raster { ctx in
            droop(ctx) {
                NSGraphicsContext.current?.imageInterpolation = .high
                flat.draw(in: dog)
            }
        }
    }

    /// 犬の大きさ（22×17pt、上から測る座標）の絵を 16 倍のビットマップに描く。
    private static func raster(_ draw: @escaping (CGContext) -> Void) -> NSImage {
        let s = 16
        let size = NSSize(width: dogWidth, height: 17)
        let vector = NSImage(size: size, flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            draw(ctx)
            return true
        }
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width) * s, pixelsHigh: Int(size.height) * s, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
        else { return vector }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        vector.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        let img = NSImage(size: size)
        img.addRepresentation(rep)
        return img
    }

    /// しょんぼり：首から前・上（x ≥ hx, y ≤ hy）を首の付け根を軸に少し下へ傾けて縮め（鼻先・頭の上が下がる）、しっぽ（後ろ・上の小さな出っ張り）を潰して下げる。
    /// 吠えるときの頭の上げ方と同じ切り分けなので、境目で体とつながる。座標は右向きの絵の上から測った pt。
    private static func droop(_ ctx: CGContext, draw: () -> Void) {
        let hx: CGFloat = 13, hy: CGFloat = 8, tx: CGFloat = 6.6, ty: CGFloat = 6.4
        // 頭・しっぽ以外はそのまま
        ctx.saveGState()
        ctx.addRect(CGRect(x: -2, y: -2, width: dogWidth + 4, height: 21))
        ctx.addRect(CGRect(x: hx, y: -2, width: dogWidth - hx + 2, height: hy + 2))
        ctx.addRect(CGRect(x: -2, y: -2, width: tx + 2, height: ty + 2))
        ctx.clip(using: .evenOdd)
        draw()
        ctx.restoreGState()
        // 頭：首の付け根の高さ hy を軸に縦に縮め（頭の上が下がる）、前ほど下げる（y' = hy + (y − hy)·縮み + (x − hx)·傾き）
        ctx.saveGState()
        ctx.clip(to: CGRect(x: hx, y: -2, width: dogWidth - hx + 2, height: hy + 2))
        let drop = droopDrop
        ctx.translateBy(x: 0, y: hy)
        ctx.concatenate(CGAffineTransform(a: 1, b: drop / (dogWidth - hx), c: 0, d: (hy - 1 - droopSquash) / (hy - 1), tx: 0, ty: -hx * drop / (dogWidth - hx)))
        ctx.translateBy(x: 0, y: -hy)
        draw()
        ctx.restoreGState()
        // しっぽ：付け根の高さ ty を軸に縦に潰す
        ctx.saveGState()
        ctx.clip(to: CGRect(x: -2, y: -2, width: tx + 2, height: ty + 2))
        ctx.translateBy(x: 0, y: ty)
        ctx.scaleBy(x: 1, y: droopTail)
        ctx.translateBy(x: 0, y: -ty)
        draw()
        ctx.restoreGState()
    }
    /// しょんぼりの量（実寸の見本で決めた。これより強いと頭の形が崩れる）：鼻先が下がる量・頭の上が下がる量（pt）・しっぽの高さの倍率。
    private static let droopDrop: CGFloat = 2.0, droopSquash: CGFloat = 1.2, droopTail: CGFloat = 0.3

    /// 焼いた絵を捨てる（🔋 の絵が変わったとき。残量ごとの絵をため込まない）。
    static func clearCaches() {
        cache = [:]
        runCache = [:]
        cgCache = [:]
    }

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

#if DEBUG
extension BeagleIcon {
    /// 開発のみ：🔋 の絵の見本を PNG に書き出す（-batteryIconShots DIR。メニューバーの実寸 @2x と、確かめやすい 4 倍の一覧）。
    /// 残量 0・15・50・82・100%、充電中かどうか、ライト・ダーク、走る機能のオン・オフ（オンはレイヤーで描く走るコマ）。
    /// 1 枚の中は左から：通常・☕・未読あり・吠えるコマ 2・4（走るはオフ）／走るコマ 0〜3・☕（走るはオン）。設定・UserDefaults には触らない。
    static func debugBatteryShots(outDir: String) -> [String] {
        let saved = (awake, battery)
        defer { awake = saved.0; battery = saved.1 }
        try? FileManager.default.createDirectory(atPath: outDir, withIntermediateDirectories: true)
        let scale: CGFloat = 2
        let cell = NSSize(width: (canvas.width + 8) * scale, height: (canvas.height + 6) * scale)
        var written: [String] = []
        var rows: [(String, [CGImage], Bool)] = []
        func strip(_ name: String, dark: Bool, runner: Bool, filledRef: Bool = false) -> [CGImage] {
            var imgs: [(String, NSImage)] = []
            awake = false
            if runner {
                for f in 0..<runFrames { imgs.append(("run\(f)", runImage(filled: false, frame: f))) }
                awake = true
                imgs.append(("run0a", runImage(filled: false, frame: 0)))
            } else {
                imgs.append(("still", image(filled: filledRef)))
                awake = true
                imgs.append(("awake", image(filled: filledRef)))
                awake = false
                imgs.append(("unread", image(filled: true)))
                imgs.append(("bark2", image(filled: false, bark: 2)))
                imgs.append(("bark4", image(filled: false, bark: 4)))
            }
            awake = false
            return imgs.compactMap { tinted("shot-\(name)-\($0.0)\(styleKey)", $0.1, dark: dark, scale: scale) }
        }
        func write(_ images: [CGImage], dark: Bool, to path: String, magnify: Int = 1) {
            let w = Int(cell.width) * images.count * magnify, h = Int(cell.height) * magnify
            guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
            ctx.setFillColor(dark ? CGColor(gray: 0.13, alpha: 1) : CGColor(gray: 0.93, alpha: 1))
            ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
            ctx.interpolationQuality = .none
            for (i, img) in images.enumerated() {
                let m = CGFloat(magnify)
                ctx.draw(img, in: CGRect(x: (CGFloat(i) * cell.width + 4 * scale) * m, y: 3 * scale * m,
                                         width: CGFloat(img.width) * m, height: CGFloat(img.height) * m))
            }
            guard let out = ctx.makeImage(), let data = NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:]) else { return }
            try? data.write(to: URL(fileURLWithPath: path))
            written.append(path)
        }
        for dark in [false, true] {
            for runner in [false, true] {
                battery = nil
                rows.append(("off", strip("off", dark: dark, runner: runner, filledRef: false), dark))
                for level in [0, 15, 50, 82, 100] {
                    for charging in [false, true] {
                        let s = BatteryBeagleLogic.Status(percent: level, onAC: charging, isCharging: charging && level < 100)
                        battery = BatteryBeagleLogic.look(s, steps: fillSteps)
                        let name = String(format: "battery-%03d-%@-%@-%@", level, charging ? "charging" : "battery", dark ? "dark" : "light", runner ? "runner" : "still")
                        let imgs = strip(name, dark: dark, runner: runner)
                        write(imgs, dark: dark, to: (outDir as NSString).appendingPathComponent(name + ".png"))
                        rows.append((name, imgs, dark))
                    }
                }
            }
        }
        // 一覧（4 倍、行ごと）
        let mag = 4
        let rowW = Int(cell.width) * 5 * mag, rowH = Int(cell.height) * mag
        if let ctx = CGContext(data: nil, width: rowW * 2, height: rowH * (rows.count / 2), bitsPerComponent: 8, bytesPerRow: 0,
                               space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) {
            ctx.interpolationQuality = .none
            let perCol = rows.count / 2
            for (i, row) in rows.enumerated() {
                let col = i / perCol, r = i % perCol
                let y = CGFloat(rowH * (perCol - 1 - r))
                ctx.setFillColor(row.2 ? CGColor(gray: 0.13, alpha: 1) : CGColor(gray: 0.93, alpha: 1))
                ctx.fill(CGRect(x: CGFloat(rowW * col), y: y, width: CGFloat(rowW), height: CGFloat(rowH)))
                for (j, img) in row.1.enumerated() {
                    ctx.draw(img, in: CGRect(x: CGFloat(rowW * col) + (CGFloat(j) * cell.width + 4 * scale) * CGFloat(mag), y: y + 3 * scale * CGFloat(mag),
                                             width: CGFloat(img.width * mag), height: CGFloat(img.height * mag)))
                }
            }
            let path = (outDir as NSString).appendingPathComponent("contact-sheet-4x.png")
            if let out = ctx.makeImage(), let data = NSBitmapImageRep(cgImage: out).representation(using: .png, properties: [:]) {
                try? data.write(to: URL(fileURLWithPath: path))
                written.append(path)
            }
        }
        return written
    }
}
#endif
