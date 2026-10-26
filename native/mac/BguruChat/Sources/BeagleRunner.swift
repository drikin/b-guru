import AppKit
import Darwin
import IOKit

extension BeagleIcon {
    /// 記号を 16 倍のビットマップにしたもの（傾けて描くとき用）。
    private static func hiRes(_ symbol: NSImage) -> NSImage {
        let s = 16
        let size = NSSize(width: dogWidth, height: 17)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width) * s, pixelsHigh: Int(size.height) * s, bitsPerSample: 8,
                                         samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return symbol }
        rep.size = size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        symbol.draw(in: NSRect(origin: .zero, size: size))
        NSGraphicsContext.restoreGraphicsState()
        let img = NSImage(size: size)
        img.addRepresentation(rep)
        return img
    }

    /// 走るコマの数。
    static let runFrames = 4
    static var runCache: [String: NSImage] = [:]

    /// 走るコマ（0〜3）。キャンバス・左向き・足元の基準線は通常の絵と同じ（30×17pt、足先は y=15）。
    /// 脚は描き足さず、記号の脚の部分だけを付け根から傾けて作る（胴・頭・しっぽは元のまま）。宙に浮くコマだけ犬ごと 1pt 上がる。
    /// 座標は右向きの絵の上から測った pt（犬は x 0〜22）。
    static func runImage(filled: Bool, frame k: Int) -> NSImage {
        let key = "\(filled)-\(k)\(styleKey)"
        if let img = runCache[key] { return img }
        let symbol = dogSymbol(filled: filled)
        let hi = hiRes(symbol)
        let W = canvas.width
        // (前脚, 後ろ脚) の傾き（度、正 = 足先が前へ）と、体ごと上がる量。伸びる・着地・縮む（宙に浮く）・けり出す。
        let frames: [(CGFloat, CGFloat, CGFloat)] = [(24, -24, 0), (9, -9, 0), (-24, 24, -1), (-9, 9, 0)]
        let (front, hind, up) = frames[k % frames.count]
        let img = NSImage(size: canvas, flipped: true) { _ in
            guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
            ctx.saveGState()
            defer { ctx.restoreGState() }
            ctx.translateBy(x: W, y: 0) // 左向き
            ctx.scaleBy(x: -1, y: 1)
            ctx.translateBy(x: 0, y: up) // 宙に浮くコマは犬ごと 1pt 上へ（ほかのコマの足先は座った絵と同じ線）
            let dog = NSRect(x: 0, y: 0, width: dogWidth, height: 17)
            // 脚は描き足さない。記号の脚の部分（お腹の線より下）を、付け根の高さ y0 を軸に横へ傾ける（x' = x + (y − y0)·tan）。
            // y0 ではずれが 0 なので胴との継ぎ目に段や隙間が出ず、脚の丸み・線の太さ・抜きは元の絵のまま。前脚と後ろ脚は逆向き。
            let y0: CGFloat = 11.6
            ctx.saveGState()
            ctx.clip(to: CGRect(x: -2, y: -2, width: dogWidth + 4, height: y0 + 2))
            symbol.draw(in: dog)
            ctx.restoreGState()
            let parts: [(CGRect, CGFloat)] = [(CGRect(x: -2, y: y0 - 0.3, width: 11.5, height: 8), hind),  // 後ろ脚（x < 9.5）
                                              (CGRect(x: 9.5, y: y0 - 0.3, width: 14, height: 8), front)]  // 前脚（付け根を 0.3pt 重ねて筋を消す）
            for (rect, deg) in parts {
                ctx.saveGState()
                ctx.clip(to: rect)
                let t = tan(deg * .pi / 180)
                ctx.concatenate(CGAffineTransform(a: 1, b: 0, c: t, d: 1, tx: -t * y0, ty: 0))
                NSGraphicsContext.current?.imageInterpolation = .high
                hi.draw(in: dog) // 傾けて描いてもぼやけないよう、16 倍のビットマップから
                ctx.restoreGState()
            }
            return true
        }
        let baked = bake(img, alignment: alignment, mark: awake, bolt: battery?.charging == true)
        runCache[key] = baked
        return baked
    }
}

extension BeagleIcon {
    /// 走っているあいだボタンに置く透明な絵（大きさ・置き方は通常の絵と同じ。配置は変わらない）。
    static let blank: NSImage = {
        let symbol = NSImage(systemSymbolName: "dog", accessibilityDescription: nil) ?? NSImage()
        var align = symbol.alignmentRect
        align.size.width = canvas.width
        return bake(NSImage(size: canvas, flipped: true) { _ in true }, alignment: align)
    }()
    static var cgCache: [String: CGImage] = [:]

    /// 絵（通常・吠える・走る）を文字色（ダーク＝白、ライト＝黒）で塗った CGImage（前もって作ってキャッシュ）。
    static func tinted(_ name: String, _ img: NSImage, dark: Bool, scale: CGFloat) -> CGImage? {
        let key = "\(name)-\(dark)-\(scale)"
        if let c = cgCache[key] { return c }
        let w = Int(canvas.width * scale), h = Int(canvas.height * scale)
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(cgContext: ctx, flipped: false)
        let r = NSRect(x: 0, y: 0, width: w, height: h)
        img.draw(in: r)
        (dark ? NSColor.white : NSColor.black).set()
        r.fill(using: .sourceAtop)
        NSGraphicsContext.restoreGraphicsState()
        let c = ctx.makeImage()
        cgCache[key] = c
        return c
    }
}

/// 走るコマを重ねるビュー（クリック・ホバーはボタンへ素通し）。
final class RunnerOverlay: NSView {
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
}

/// Mac の CPU・GPU の負荷に合わせて、メニューバーのビーグルが走る（RunCat 風。設定、既定は切）。
/// - 負荷は 2 秒ごとに 1 回だけ測る（CPU: host_processor_info で全コアの使用率、GPU: IOKit の IOAccelerator の
///   PerformanceStatistics「Device Utilization %」）。高いほうの直近 3 回の平均で決める。
/// - 15 % 未満は座ったまま（コマのタイマーなし）、15〜40 % は歩く（0.25 秒）、40〜70 % は走る（0.12 秒）、70 % 以上は全力（0.06 秒）。
/// - 動かし方は絵の差し替えだけ。コマは前もって作ってキャッシュ。吠えているあいだは止まり、終わったら負荷に合わせて再開。
/// - 視差効果を減らすがオンなら走らない。
@MainActor
final class BeagleRunner {
    enum Pace: Int, Comparable {
        case still = 0, walk, run, sprint
        var interval: TimeInterval {
            switch self {
            case .still: return 0
            case .walk: return 0.25
            case .run: return 0.12
            case .sprint: return 0.06
            }
        }
        var name: String { ["座る", "歩く", "走る", "全力"][rawValue] }
        static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
        static func from(load: Double) -> Pace {
            load >= 70 ? .sprint : load >= 40 ? .run : load >= 15 ? .walk : .still
        }
    }

    private let item: NSStatusItem
    private weak var barker: BeagleBarker?
    private var sampleTimer: Timer?
    private var frameTimer: Timer?
    private var frame = 0
    private var history: [Double] = []
    private var lastTicks: [UInt32]?
    private(set) var pace: Pace = .still
    private(set) var lastCPU: Double = 0
    private(set) var lastGPU: Double?
    #if DEBUG
    /// 開発のみ：負荷を固定して見本を撮る（nil = 実際の負荷）。
    var debugLoad: Double?
    #endif

    var enabled = false {
        didSet {
            guard enabled != oldValue else { return }
            if enabled { start() } else { stop() }
        }
    }

    init(item: NSStatusItem, barker: BeagleBarker?) {
        self.item = item
        self.barker = barker
        // 画面が消えている・ロック中は負荷を測らず、走らせない（誰も見ていない絵を 16 コマ/秒で描いていた）。
        let ws = NSWorkspace.shared.notificationCenter
        // 画面の消灯・ユーザの切り替え・ロックは別々に覚える（ロック中に画面が点いても走り出さない）。
        for (n, flag, on) in [(NSWorkspace.screensDidSleepNotification, 0, true), (NSWorkspace.screensDidWakeNotification, 0, false),
                              (NSWorkspace.sessionDidResignActiveNotification, 1, true), (NSWorkspace.sessionDidBecomeActiveNotification, 1, false)] {
            observers.append(ws.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.setAway(flag, on) }
            })
        }
        let dnc = DistributedNotificationCenter.default()
        for (n, on) in [("com.apple.screenIsLocked", true), ("com.apple.screenIsUnlocked", false)] {
            observers.append(dnc.addObserver(forName: Notification.Name(n), object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.setAway(2, on) }
            })
        }
    }

    private var observers: [NSObjectProtocol] = []
    /// 画面が消えている・別のユーザ・ロック中（どれか 1 つでも）。
    private var away: [Bool] = [false, false, false]
    private var screensAsleep: Bool { away.contains(true) }

    private func setAway(_ which: Int, _ on: Bool) {
        let was = screensAsleep
        away[which] = on
        let asleep = screensAsleep
        guard asleep != was, enabled else { return }
        if asleep {
            sampleTimer?.invalidate()
            sampleTimer = nil
            setPace(.still)
        } else if sampleTimer == nil {
            start()
        }
    }

    var isRunning: Bool { frameTimer != nil }
    /// GPU の負荷も見る（既定は切 = CPU だけで速さを決める）。
    var useGPU = false

    /// この機能がオンのあいだは、ビーグルの絵をすべて（座る・走る・吠える）重ねたレイヤーで描く。
    /// ボタンの画像を差し替えると毎回ボタンの配置の計算が走って重い（全力で CPU 5〜6 %）ので、ボタンには同じ大きさの透明な絵を
    /// 置いたままにし、レイヤーの中身（前もって焼いた絵）だけを替える。システムが描く絵とレイヤーとでは縦が 1px ずれることがある
    /// （実機の差分で確認）ので、オンのあいだは座っている絵もレイヤーで描き、走る・吠える・止まるの切り替えで位置が動かないようにする。
    var drawsIcon: Bool { enabled }

    private func start() {
        guard !screensAsleep else { return } // 画面が戻ったときに始める
        lastTicks = nil
        history = []
        _ = Self.cpuTicks() // 最初の差分の基準
        barker?.onFrame = { [weak self] in self?.render() }
        let t = Timer(timeInterval: 2, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.sample() }
        }
        t.tolerance = 0.2
        RunLoop.main.add(t, forMode: .common)
        sampleTimer = t
        render()
        sample()
    }

    private func stop() {
        sampleTimer?.invalidate()
        sampleTimer = nil
        frameTimer?.invalidate()
        frameTimer = nil
        pace = .still
        barker?.onFrame = nil
        overlay?.removeFromSuperview()
        overlay = nil
        lastBounds = nil
        item.button?.image = BeagleIcon.image(filled: barker?.filled ?? false) // システムの描き方に戻す
    }

    // MARK: - 負荷

    private func sample() {
        let cpu = cpuUsage()
        // GPU は設定「GPU の負荷も見る」がオンのときだけ読む（オフのときは IOKit も読まない）。写真の解析などで普段から高い Mac がある。
        let gpu = useGPU ? Self.gpuUtilization() : nil
        lastCPU = cpu
        lastGPU = gpu
        var load = max(cpu, gpu ?? 0)
        #if DEBUG
        if let d = debugLoad { load = d }
        #endif
        history.append(load)
        if history.count > 3 { history.removeFirst(history.count - 3) }
        let avg = history.reduce(0, +) / Double(history.count)
        var next = Pace.from(load: avg)
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { next = .still }
        #if DEBUG
        NSLog("[run] CPU %.0f%% GPU %@ → 平均 %.0f%% %@", cpu, useGPU ? (gpu.map { String(format: "%.0f%%", $0) } ?? "読めない") : "見ない", avg, next.name)
        #endif
        if next != pace {
            StatusBarDiag.note("走る: \(next.name)")
            setPace(next)
        }
    }

    private func setPace(_ p: Pace) {
        pace = p
        frameTimer?.invalidate()
        frameTimer = nil
        if p != .still {
            let t = Timer(timeInterval: p.interval, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.barker?.isBarking != true else { return } // 吠えているあいだは止まる
                    self.frame = (self.frame + 1) % BeagleIcon.runFrames
                    self.render()
                }
            }
            t.tolerance = p.interval * 0.1
            RunLoop.main.add(t, forMode: .common)
            frameTimer = t
        }
        render()
    }

    /// 今の絵を描く：吠えている → 吠えるコマ、走っている → 走るコマ、それ以外 → 座っている絵（未読・接続の状態どおり）。
    func render() {
        guard enabled, let button = item.button else { return }
        let filled = barker?.filled ?? false
        let ov = overlay ?? makeOverlay(on: button)
        if button.image !== BeagleIcon.blank || lastBounds != button.bounds {
            // システムが通常の絵を描く位置を測り（ボタンを自分で描かせて絵の一番上・一番左の画素を探す）、透明な絵に替える。
            ov.isHidden = true
            button.image = BeagleIcon.image(filled: filled)
            button.layoutSubtreeIfNeeded()
            ov.frame = measuredCanvasRect(button, filled: filled)
            button.image = BeagleIcon.blank
            lastBounds = button.bounds
            ov.isHidden = false
            #if DEBUG
            NSLog("[run] 重ねる位置 %@（ボタン %@）", NSStringFromRect(ov.frame), NSStringFromRect(button.bounds))
            #endif
        }
        let dark = button.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
        let scale = button.window?.backingScaleFactor ?? 2
        let name: String
        let img: NSImage
        if let k = barker?.currentFrame, k > 0 {
            name = "bark-\(filled)-\(k)"; img = BeagleIcon.image(filled: filled, bark: k)
        } else if pace != .still {
            name = "run-\(filled)-\(frame)"; img = BeagleIcon.runImage(filled: filled, frame: frame)
        } else {
            name = "still-\(filled)"; img = BeagleIcon.image(filled: filled)
        }
        ov.layer?.contentsScale = scale
        ov.layer?.contents = BeagleIcon.tinted(name + BeagleIcon.styleKey, img, dark: dark, scale: scale)
        ov.alphaValue = button.appearsDisabled ? 0.5 : 1 // 接続していないときは淡く（ボタンの淡色表示と同じ）
    }

    /// ボタンに今の絵を描かせ、キャンバス（30×17pt）の左上が来る位置をボタンの座標で返す。
    private func measuredCanvasRect(_ button: NSButton, filled: Bool) -> NSRect {
        let c = BeagleIcon.canvas
        let r = button.cell?.imageRect(forBounds: button.bounds) ?? .zero
        let fallback = NSRect(x: r.midX - c.width / 2, y: r.midY - c.height / 2, width: c.width, height: c.height)
        guard let rep = button.bitmapImageRepForCachingDisplay(in: button.bounds) else { return fallback }
        button.cacheDisplay(in: button.bounds, to: rep)
        let scale = CGFloat(rep.pixelsWide) / max(button.bounds.width, 1)
        // 絵の範囲（セルの絵の位置の付近）だけで、不透明な画素の一番上・一番左を探す（右の未読の数は見ない）
        let x0 = max(0, Int((fallback.minX - 2) * scale)), x1 = min(rep.pixelsWide, Int((fallback.minX + c.width * 0.75) * scale))
        guard let drawn = Self.topLeft(rep, x0: x0, x1: x1),
              let own = BeagleIcon.image(filled: filled).representations.compactMap({ $0 as? NSBitmapImageRep })
                .min(by: { abs(CGFloat($0.pixelsWide) / c.width - scale) < abs(CGFloat($1.pixelsWide) / c.width - scale) }),
              let mine = Self.topLeft(own, x0: 0, x1: own.pixelsWide) else { return fallback }
        let ownScale = CGFloat(own.pixelsWide) / c.width
        let x = CGFloat(drawn.x) / scale - CGFloat(mine.x) / ownScale
        let y = CGFloat(drawn.y) / scale - CGFloat(mine.y) / ownScale
        return NSRect(x: x, y: y, width: c.width, height: c.height) // ボタンは上下反転の座標（上から）
    }

    /// 不透明な画素の一番上の行と、一番左の列（画素の座標、上から）。
    private static func topLeft(_ rep: NSBitmapImageRep, x0: Int, x1: Int) -> (x: Int, y: Int)? {
        var top: Int?, left: Int?
        for y in 0..<rep.pixelsHigh {
            for x in x0..<x1 where (rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) > 0.5 {
                if top == nil { top = y }
                left = min(left ?? x, x)
            }
        }
        guard let top, let left else { return nil }
        return (left, top)
    }

    private var overlay: NSView?
    private var lastBounds: NSRect?

    private func makeOverlay(on button: NSButton) -> NSView {
        overlay?.removeFromSuperview()
        let v = RunnerOverlay(frame: .zero)
        v.wantsLayer = true
        v.layer?.contentsGravity = .resize
        button.addSubview(v)
        overlay = v
        return v
    }


    /// 全コアの CPU の使用率（前回からの差分、%）。
    private func cpuUsage() -> Double {
        guard let ticks = Self.cpuTicks() else { return 0 }
        defer { lastTicks = ticks }
        guard let prev = lastTicks, prev.count == ticks.count else { return 0 }
        var busy: UInt64 = 0, total: UInt64 = 0
        for i in stride(from: 0, to: ticks.count, by: Int(CPU_STATE_MAX)) {
            let user = UInt64(ticks[i + Int(CPU_STATE_USER)] &- prev[i + Int(CPU_STATE_USER)])
            let sys = UInt64(ticks[i + Int(CPU_STATE_SYSTEM)] &- prev[i + Int(CPU_STATE_SYSTEM)])
            let nice = UInt64(ticks[i + Int(CPU_STATE_NICE)] &- prev[i + Int(CPU_STATE_NICE)])
            let idle = UInt64(ticks[i + Int(CPU_STATE_IDLE)] &- prev[i + Int(CPU_STATE_IDLE)])
            busy += user + sys + nice
            total += user + sys + nice + idle
        }
        return total == 0 ? 0 : Double(busy) / Double(total) * 100
    }

    /// host_processor_info のコアごとの ticks（user, system, idle, nice の並び）。
    nonisolated static func cpuTicks() -> [UInt32]? {
        var count: natural_t = 0
        var info: processor_info_array_t?
        var infoCount: mach_msg_type_number_t = 0
        guard host_processor_info(mach_host_self(), PROCESSOR_CPU_LOAD_INFO, &count, &info, &infoCount) == KERN_SUCCESS,
              let info else { return nil }
        defer {
            vm_deallocate(mach_task_self_, vm_address_t(bitPattern: info), vm_size_t(Int(infoCount) * MemoryLayout<integer_t>.stride))
        }
        return (0..<Int(infoCount)).map { UInt32(bitPattern: info[$0]) }
    }

    /// GPU の使用率（%）。IOAccelerator の PerformanceStatistics「Device Utilization %」。読めなければ nil。
    nonisolated static func gpuUtilization() -> Double? {
        var iterator: io_iterator_t = 0
        guard IOServiceGetMatchingServices(kIOMainPortDefault, IOServiceMatching("IOAccelerator"), &iterator) == KERN_SUCCESS else { return nil }
        defer { IOObjectRelease(iterator) }
        var best: Double?
        while case let service = IOIteratorNext(iterator), service != 0 {
            defer { IOObjectRelease(service) }
            guard let prop = IORegistryEntryCreateCFProperty(service, "PerformanceStatistics" as CFString, kCFAllocatorDefault, 0)?
                .takeRetainedValue() as? [String: Any] else { continue }
            if let u = (prop["Device Utilization %"] as? NSNumber)?.doubleValue { best = max(best ?? 0, u) }
        }
        return best
    }
}
