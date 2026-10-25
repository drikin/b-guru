import AppKit
import QuartzCore

/// メニューバーのティッカー：新着のチャット・自分へのメンション・ビーグルのお知らせを、ビーグルのアイコンの左に 1 行ずつ流す（設定、既定は切）。
///
/// 畳む機能の跡の空白は区切りごと « に入っているので描けない。代わりにビーグルの NSStatusItem 自体を左へ広げる:
/// ボタンのタイトルの先頭に幅だけの透明な添付（スペーサー）を入れ、画像をタイトルの右（imageTrailing）に置くと、
/// アイコン（と未読の数）が右端に寄り、左に空いた部分へ自前のビュー（クリックは素通し）を重ねて文字を流す。
/// 畳めているときは区切りを同じ幅だけ縮めてから広げる（合計の幅が変わらないので、« の中のアイコンは飛び出さない）。
/// 畳む機能がオフ・出している・安全側のときは最大 200pt で、広げたあとビーグルが押し出されていないか確かめ、だめなら戻す。
/// 動かすのは Core Animation（レンダーサーバー側）。流していないときはタイマーもアニメーションもない。
@MainActor
final class StatusTicker {
    enum Style { case message, mention, notice, suggest, assistant }
    struct Item {
        var text: String
        var style: Style
        var messageId: Int?
        /// アシスタントの知らせ：クリックで行うこと（そのアプリを前に出す）。
        var action: (() -> Void)?
    }

    static let maxQueue = 5
    static let maxWidthCollapsed: CGFloat = 300
    static let maxWidthPlain: CGFloat = 200
    static let minWidth: CGFloat = 60

    private let item: NSStatusItem
    weak var collapser: StatusBarCollapser?
    var enabled = false { didSet { if !enabled { stop(clear: true) } } }
    var namesOnly = false
    /// 流してよいか（チャットを見ていない・静かな時間でない）。
    var canShow: () -> Bool = { true }
    /// ティッカーの部分がクリックされた（その発言へ）。
    var onOpen: ((Int?) -> Void)?
    /// 1 件を流し始めるとき（空きがなくて流せないときも）。ビーグルが同時に吠える。
    var onShow: ((Style) -> Void)?
    /// 流し終えて元に戻すとき、ボタンのタイトル（未読の数）と画像の位置を元どおりにする。
    var restoreButton: (() -> Void)?
    #if DEBUG
    /// 開発のみ：メニューバーの色の見本（ライト／ダーク）を撮るために文字色の外観を固定する。
    var debugAppearance: NSAppearance?
    #endif

    private var queue: [Item] = []
    private(set) var current: Item?
    private var width: CGFloat = 0
    private var countText = ""
    private var overlay: TickerOverlay?
    private var task: Task<Void, Never>?

    init(item: NSStatusItem) {
        self.item = item
    }

    var isShowing: Bool { current != nil }

    // MARK: - 入れる

    /// チャットの新着（自分の発言・部室の出入りは呼ぶ側で除く）。
    func enqueue(message m: ChatMessage) {
        guard enabled else { return }
        let name = Self.clean(m.authorName ?? "だれか", limit: 16)
        let photo = (m.images?.isEmpty == false) && (m.body.isEmpty || m.body == "📷 写真")
        let body = photo ? "📷 写真" : Self.clean(m.body, limit: 60)
        let style: Style = m.mentionsMe ? .mention : .message
        let text: String
        if namesOnly {
            text = m.mentionsMe ? "@ \(name) さんからメンション" : "\(name) さんの新着"
        } else {
            text = m.mentionsMe ? "@ \(name)：\(body)" : "\(name)：\(body)"
        }
        push(Item(text: text, style: style, messageId: m.id))
    }

    /// ビーグルのお知らせ（将棋の見どころ・終局、散財ダッシュなど）。部室の出入りは流さない。
    /// お知らせは会員の発言ではないので「名前だけ」のときも本文を出す。
    func enqueue(announcement m: ChatMessage) {
        guard enabled else { return }
        let body = Self.clean(m.body, limit: 60)
        guard !body.isEmpty, !Self.isRoomNotice(body) else { return }
        push(Item(text: "🐶 \(body)", style: .notice, messageId: m.id))
    }

    static func isRoomNotice(_ body: String) -> Bool {
        body.contains("部室に入") || body.contains("部室を出")
    }

    /// 改行・連続する空白を 1 つの空白に詰め、長いものは「…」で切る。
    static func clean(_ s: String, limit: Int) -> String {
        let one = s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        return one.count > limit ? String(one.prefix(limit)) + "…" : one
    }

    private func push(_ it: Item) {
        guard canShow() else { return }
        queue.append(it)
        if queue.count > Self.maxQueue { queue.removeFirst(queue.count - Self.maxQueue) } // 古いものは捨てる
        if current == nil { showNext() }
    }

    // MARK: - 流す

    /// 未読の数が変わったとき（流しているあいだはボタンのタイトルをティッカーが持つ）。
    func setCount(_ text: String) {
        countText = text
        guard isShowing, let button = item.button else { return }
        button.attributedTitle = title(spacer: width)
    }

    private func showNext() {
        // 端末内 AI のおすすめ（suggest）は、ティッカーがオフでも流す（その機能をオンにした人だけが入れる）。
        guard enabled || queue.first?.style == .suggest || queue.first?.style == .assistant, current == nil, !queue.isEmpty, let button = item.button else { return }
        guard canShow() else { queue.removeAll(); return }
        let it = queue.removeFirst()
        onShow?(it.style)
        let text = attributed(it)
        let textWidth = ceil(text.size().width)
        // いつも右から流すので、短い文でも流れる場所（最低 160pt）を取る。
        let wanted = min(max(textWidth + 14, 160), Self.maxWidthCollapsed)
        var w: CGFloat
        var lent = false
        if let granted = collapser?.beginTicker(want: wanted) {
            w = granted
            lent = granted > 0
        } else {
            w = min(wanted, Self.maxWidthPlain)
        }
        guard w >= Self.minWidth else {
            StatusBarDiag.note("ティッカー: 空きなし（未読の数だけ）")
            scheduleNext(after: 0.3)
            return
        }
        w = w.rounded()
        if !lent { collapser?.noteTicker(width: w) }
        current = it
        width = w
        let beforeMaxX = button.window?.frame.maxX
        // 広げる（区切りを縮めたのと同じ処理の中で）
        button.attributedTitle = title(spacer: w)
        button.imagePosition = .imageTrailing
        let ov = TickerOverlay(frame: NSRect(x: 0, y: 0, width: w - 2, height: button.bounds.height))
        button.addSubview(ov)
        overlay = ov
        // ティッカーは短い文でも右から左へ流す（オーナー 2026-10-22「流れてない」）。止めて出すのは「視差効果を減らす」のときだけ。
        let scroll = !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
        let duration = scroll ? min(12, max(5, Double(w + textWidth) / 55)) : 6
        ov.run(text: text, textWidth: textWidth, scroll: scroll, duration: duration, scale: button.window?.backingScaleFactor ?? 2)
        StatusBarDiag.note("ティッカー: 表示（\(Self.styleName(it.style))・幅 \(Int(w))\(lent ? "・区切りから借りた" : "")・\(scroll ? "流す \(String(format: "%.1f", duration)) 秒" : "流さない（視差効果を減らす）")）")
        // VoiceOver には 1 回だけ読み上げる
        NSAccessibility.post(element: button, notification: .announcementRequested,
                             userInfo: [.announcement: it.text, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
        task?.cancel()
        task = Task { [weak self] in
            // 広げた結果を確かめる：畳めていれば « にしまえたまま、そうでなければビーグルが押し出されていないこと
            try? await Task.sleep(for: .milliseconds(150))
            guard let self, !Task.isCancelled else { return }
            if lent {
                if let c = self.collapser, !(await c.tickerStillHiding()) {
                    guard !Task.isCancelled else { return }
                    StatusBarDiag.note("ティッカー: 空きなし（広げると « にしまえない）")
                    self.finish(next: true)
                    return
                }
            } else {
                try? await Task.sleep(for: .milliseconds(600))
                guard !Task.isCancelled else { return }
                let after = self.item.button?.window?.frame
                if let b = beforeMaxX, let a = after, abs(a.maxX - b) > 2 || a.width < w {
                    StatusBarDiag.note("ティッカー: 空きなし（ビーグルが押し出される）")
                    self.finish(next: true)
                    return
                }
            }
            try? await Task.sleep(for: .seconds(duration))
            guard !Task.isCancelled else { return }
            self.finish(next: true)
        }
    }

    private func scheduleNext(after delay: Double) {
        task?.cancel()
        task = Task { [weak self] in
            try? await Task.sleep(for: .seconds(delay))
            guard let self, !Task.isCancelled else { return }
            self.task = nil
            self.showNext()
        }
    }

    /// アイコンだけに戻す（区切りの幅も同じ処理の中で戻す）。
    private func finish(next: Bool) {
        task?.cancel(); task = nil
        overlay?.stop()
        overlay?.removeFromSuperview()
        overlay = nil
        if current != nil {
            current = nil
            width = 0
            restoreButton?()
            collapser?.endTicker()
        }
        if next, !queue.isEmpty { scheduleNext(after: 0.5) }
    }

    /// チャットを開いたとき・設定をオフにしたとき。
    func stop(clear: Bool) {
        if clear { queue.removeAll() }
        finish(next: false)
    }

    // MARK: - クリック

    /// カーソルがティッカーの部分（ボタンの左の広げた所）の上か。
    func mouseOverTicker() -> Bool {
        guard isShowing, let win = item.button?.window else { return false }
        var r = win.frame
        r.size.width = width
        return NSMouseInRect(NSEvent.mouseLocation, r, false)
    }

    func clicked() {
        let id = current?.messageId
        let suggest = current?.style == .suggest
        let action = current?.action
        StatusBarDiag.note("ティッカー: クリック")
        stop(clear: true)
        if let action { action(); return }
        if suggest, let id { onOpenThread?(id) } else { onOpen?(id) }
    }

    /// ティッカーの部分のクリックで、おすすめの投稿のスレッドを開く。
    var onOpenThread: ((Int) -> Void)?

    /// 端末内 AI のおすすめ（ティッカーがオフでも流す）。`postId` はクリックで開くスレッド。
    func enqueue(suggestion text: String, postId: Int) {
        push(Item(text: text, style: .suggest, messageId: postId))
    }

    /// アシスタントの知らせ（ティッカーがオフでも流す）。クリックで `action`（そのアプリを前に出す）。
    func enqueue(assistant text: String, action: @escaping () -> Void) {
        push(Item(text: text, style: .assistant, messageId: nil, action: action))
    }

    // MARK: - 文字

    private static func styleName(_ s: Style) -> String {
        switch s {
        case .message: return "新着"
        case .mention: return "メンション"
        case .notice: return "お知らせ"
        case .suggest: return "おすすめ"
        case .assistant: return "アシスタント"
        }
    }

    private func attributed(_ it: Item) -> NSAttributedString {
        // メンションは色を変えず太字に（メニューバーの文字は他のアイコンと同じ色で）。
        let font = it.style == .mention ? NSFont.boldSystemFont(ofSize: NSFont.menuBarFont(ofSize: 0).pointSize) : NSFont.menuBarFont(ofSize: 0)
        var color = NSColor.labelColor.cgColor
        let appearance: NSAppearance? = {
            #if DEBUG
            if let a = debugAppearance { return a }
            #endif
            return item.button?.effectiveAppearance
        }()
        (appearance ?? NSAppearance.currentDrawing()).performAsCurrentDrawingAppearance {
            switch it.style {
            case .mention, .message, .notice, .suggest, .assistant: color = NSColor.labelColor.cgColor
            }
        }
        return NSAttributedString(string: it.text, attributes: [.font: font, .foregroundColor: NSColor(cgColor: color) ?? .labelColor])
    }

    /// 先頭に幅 `spacer` の透明な添付、続けて未読の数。画像はタイトルの右に置く。
    private func title(spacer: CGFloat) -> NSAttributedString {
        let att = NSTextAttachment()
        att.image = NSImage(size: NSSize(width: spacer, height: 1))
        att.bounds = NSRect(x: 0, y: 0, width: spacer, height: 1)
        let t = NSMutableAttributedString(attachment: att)
        let count = countText.trimmingCharacters(in: .whitespaces)
        t.append(BeagleIcon.countTitle(count.isEmpty ? " " : " \(count) "))
        return t
    }
}

/// ティッカーの文字を流すビュー。クリック・ホバーはボタンへ素通し（hitTest が nil）。
final class TickerOverlay: NSView {
    private let textLayer = CATextLayer()
    private var stepTimer: Timer?

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.masksToBounds = true
        setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func run(text: NSAttributedString, textWidth: CGFloat, scroll: Bool, duration: Double, scale: CGFloat) {
        guard let root = layer else { return }
        // 画面が消えているあいだは流さず、止めて置く（60 Hz の刻みを誰も見ていない）。
        let scroll = scroll && CGDisplayIsAsleep(CGMainDisplayID()) == 0
        let h = ceil(text.size().height)
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        textLayer.string = text
        textLayer.contentsScale = scale
        textLayer.truncationMode = scroll ? .none : .end
        textLayer.anchorPoint = CGPoint(x: 0, y: 0.5)
        let y = bounds.midY - (isFlipped ? -0.5 : 0.5)
        textLayer.bounds = CGRect(x: 0, y: 0, width: scroll ? textWidth + 2 : bounds.width - 4, height: h)
        textLayer.position = CGPoint(x: scroll ? bounds.width : 2, y: y)
        if textLayer.superlayer == nil { root.addSublayer(textLayer) }
        CATransaction.commit()
        stepTimer?.invalidate()
        stepTimer = nil
        if scroll {
            // 右から入って左へ抜ける（1 回）。Core Animation の暗黙の動きはオーナーの Mac（macOS 26）のステータスバーで
            // 動かなかった（出るだけ）ので、刻み（60 Hz、流しているあいだだけ）で位置を書き換える。
            let from = bounds.width, to = -textWidth, start = CACurrentMediaTime()
            let t = Timer(timeInterval: 1.0 / 60, repeats: true) { [weak self] timer in
                guard let self else { timer.invalidate(); return }
                let p = min(1, (CACurrentMediaTime() - start) / duration)
                CATransaction.begin()
                CATransaction.setDisableActions(true)
                self.textLayer.position.x = (from + (to - from) * p).rounded(.toNearestOrAwayFromZero)
                CATransaction.commit()
                if p >= 1 { timer.invalidate(); self.stepTimer = nil }
            }
            RunLoop.main.add(t, forMode: .common)
            stepTimer = t
        } else {
            let a = CABasicAnimation(keyPath: "opacity")
            a.fromValue = 0
            a.toValue = 1
            a.duration = 0.25
            textLayer.add(a, forKey: "fade")
        }
    }

    func stop() {
        stepTimer?.invalidate()
        stepTimer = nil
        textLayer.removeAllAnimations()
    }
}
