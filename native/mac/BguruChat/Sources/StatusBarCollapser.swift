import AppKit

/// 試験的：ほかのステータスバーアイコンを畳む（Hidden Bar 風。権限なし・サンドボックスのまま）。
///
/// ビーグルの左に自前の区切り（NSStatusItem、autosaveName で位置を記憶）を置き、畳むときは区切りの幅を
/// 広げて、区切りより左のアイコンを macOS の「«」（あふれ）にしまう。
///
/// macOS 27 では Hidden Bar の「とても大きい幅で画面の外へ押し出す」は効かない（2026-10-21 実機）:
/// - 収まる幅のうちは左のアイコンが左へずれる。収まりきらないアイコンは macOS が «（あふれ）にしまう。
/// - 区切りが少しはみ出す幅だと、区切りごと « に入り「« ビーグル」になる（いちばん見た目がよい＝目標）。
/// - 大きすぎる幅だと区切りが外され、何も隠れない。
/// その境目は前面のアプリのメニューの長さ・ほかのアイコン・画面の幅で変わるので、毎回測って合わせる。
/// 区切りの window.frame の右端がビーグルの左（anchor）に付いていれば「収まっている」、少し手前なら
/// 「« に入った」、右へはみ出していれば「外された」。結果は揺れるので、待って 2 回同じ値になってから読む。
/// 測れない・不安定・区切りがビーグルの右にあるときは安全側（何も隠さない、最小の幅）に戻す。
/// macOS の仕様外の動きに頼るので、将来の macOS で効かなくなりうる（そのときも何も隠れないだけ）。
@MainActor
final class StatusBarCollapser {
    enum Fit: String { case fits, overflow, dropped, unknown }

    static let minLength: CGFloat = 16
    static let autosaveName = "bguruCollapseSeparator"
    /// 出したあと、この秒数で畳む（メニューバーの上にマウスがあるあいだ・ボタンを押しているあいだは待つ）。
    static let autoCollapseAfter: TimeInterval = 10
    /// 一度メニューバーに来たマウスが離れてから畳むまで。
    static let leaveGrace: TimeInterval = 1.5

    private let beagle: NSStatusItem
    private var separator: NSStatusItem?
    /// 利用者が望む状態（畳む／出す）。表示が安全側に戻っていても、これは保つ。
    private(set) var wantCollapsed = false
    /// いま本当に隠せているか（目標の形になったか）。
    private(set) var hiding = false
    private var anchorOffset: CGFloat = 0
    private var cache: [String: CGFloat] = [:]
    /// 余地がなかった組み合わせ（前面のアプリのメニューが長いなど）。画面の構成が変わるまで測らない。
    private var noRoom: Set<String> = []
    private var generation = 0
    private var fitTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?
    private var autoTimer: Timer?
    private var checkTimer: Timer?
    private var expandedAt = Date()
    private var mouseWasInBar = false
    private var leftBarAt: Date?
    private var observers: [(NotificationCenter, NSObjectProtocol)] = []
    private let quickLook = QuickLookCatcher()
    /// 状態が変わるたびに（ログ・デバッグ用）。
    var onLog: ((String) -> Void)?

    init(beagle: NSStatusItem) {
        self.beagle = beagle
    }

    var isEnabled: Bool { separator != nil }

    // MARK: - オン・オフ

    /// 区切りを置く。`collapse` が真なら位置を測ったあと畳む。
    func enable(collapse: Bool) {
        guard separator == nil else { return }
        let sep = NSStatusBar.system.statusItem(withLength: Self.minLength)
        sep.autosaveName = Self.autosaveName
        sep.behavior = [] // ⌘ ドラッグで外へ出しても消さない（オフは設定から）
        if let b = sep.button {
            b.target = self
            b.action = #selector(separatorClicked)
            b.sendAction(on: [.leftMouseUp])
            b.setAccessibilityLabel("ほかのアイコンを畳む区切り")
            b.toolTip = "この区切りより左のアイコンを畳みます（クリック、またはビーグルを ⌥＋クリックで出し入れ）"
        }
        separator = sep
        showSeparatorMark(true)
        installQuickLook()
        let ws = NSWorkspace.shared.notificationCenter
        observers.append((ws, ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.scheduleRemeasure("前面のアプリが変わった", delay: 0.4) }
        }))
        let nc = NotificationCenter.default
        observers.append((nc, nc.addObserver(forName: NSApplication.didChangeScreenParametersNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated {
                self?.noRoom.removeAll()
                self?.scheduleRemeasure("画面の構成が変わった", delay: 1.0)
            }
        }))
        // ほかのステータスアイテムの増減などは見えないので、畳んでいるあいだ定期的に軽く確かめる（幅は変えない）。
        checkTimer = Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.lightCheck() }
        }
        log("区切りを置いた")
        if collapse {
            wantCollapsed = true
            scheduleRemeasure("オンにした", delay: 0.3)
        } else {
            expand()
        }
    }

    /// 区切りを消して全部元に戻す（設定オフ・終了時）。
    func disable() {
        generation += 1
        fitTask?.cancel(); fitTask = nil
        debounceTask?.cancel(); debounceTask = nil
        autoTimer?.invalidate(); autoTimer = nil
        checkTimer?.invalidate(); checkTimer = nil
        for (center, o) in observers { center.removeObserver(o) }
        observers.removeAll()
        removeQuickLook()
        if let sep = separator {
            sep.length = Self.minLength
            NSStatusBar.system.removeStatusItem(sep)
        }
        separator = nil
        wantCollapsed = false
        hiding = false
        log("区切りを消した（元に戻した）")
    }

    // MARK: - 切り替え

    func toggle() {
        guard isEnabled else { return }
        if wantCollapsed { expand() } else { collapse() }
    }

    func collapse() {
        guard isEnabled else { return }
        autoTimer?.invalidate(); autoTimer = nil
        wantCollapsed = true
        scheduleRemeasure("畳む", delay: 0)
    }

    func expand() {
        guard let sep = separator else { return }
        generation += 1
        fitTask?.cancel(); fitTask = nil
        debounceTask?.cancel(); debounceTask = nil
        wantCollapsed = false
        hiding = false
        sep.length = Self.minLength
        showSeparatorMark(true)
        expandedAt = Date()
        mouseWasInBar = Self.mouseInMenuBar()
        leftBarAt = nil
        autoTimer?.invalidate()
        autoTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.autoTick() }
        }
        log("出した")
        // 区切りが最小のときの位置を基準（anchor）として測り直す。
        let gen = generation
        Task { [weak self] in
            guard let self, let frames = await self.settledFrames(gen) else { return }
            self.anchorOffset = frames.beagle.minX - frames.sep.maxX
            self.log("基準: 区切り右端=\(Int(frames.sep.maxX)) ビーグル左端=\(Int(frames.beagle.minX)) ずれ=\(Int(self.anchorOffset))")
        }
    }

    /// ビーグルの幅（未読の数）が変わったとき。
    private var lastBeagleWidth: CGFloat = 0
    func beagleChanged() {
        let w = beagle.button?.frame.width ?? 0
        guard w != lastBeagleWidth else { return }
        lastBeagleWidth = w
        guard wantCollapsed else { return }
        scheduleRemeasure("ビーグルの幅が変わった", delay: 0.8)
    }

    // MARK: - 自動で畳む

    private func autoTick() {
        guard !wantCollapsed, isEnabled else { autoTimer?.invalidate(); autoTimer = nil; return }
        // ボタンを押しているあいだ（⌘ ドラッグで並べ替え中など）・メニューが開いているあいだは待つ。
        if NSEvent.pressedMouseButtons != 0 || Self.menuIsOpen() { leftBarAt = nil; return }
        let now = Date()
        if Self.mouseInMenuBar() {
            mouseWasInBar = true
            leftBarAt = nil
            return
        }
        if mouseWasInBar {
            if leftBarAt == nil { leftBarAt = now }
            if let t = leftBarAt, now.timeIntervalSince(t) >= Self.leaveGrace { log("メニューバーを離れたので畳む"); collapse(); return }
        }
        if now.timeIntervalSince(expandedAt) >= Self.autoCollapseAfter { log("\(Int(Self.autoCollapseAfter)) 秒たったので畳む"); collapse() }
    }

    static func mouseInMenuBar() -> Bool {
        let p = NSEvent.mouseLocation
        guard let screen = NSScreen.screens.first(where: { NSMouseInRect(p, $0.frame, false) }) else { return false }
        let bar = max(NSStatusBar.system.thickness, screen.frame.maxY - screen.visibleFrame.maxY, 24)
        return p.y >= screen.frame.maxY - bar - 1
    }

    /// どこかのメニュー（ほかのアプリのステータスメニューも）が開いているか。窓の層だけを見る（画面収録の許可いらず）。
    static func menuIsOpen() -> Bool {
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return false }
        let menuLevel = Int(CGWindowLevelForKey(.popUpMenuWindow))
        return list.contains { ($0[kCGWindowLayer as String] as? Int) == menuLevel }
    }

    // MARK: - 測り直し

    private func scheduleRemeasure(_ reason: String, delay: Double) {
        guard wantCollapsed, isEnabled else { return }
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            if delay > 0 { try? await Task.sleep(for: .seconds(delay)) }
            guard !Task.isCancelled, let self else { return }
            self.startFit(reason)
        }
    }

    private func startFit(_ reason: String) {
        guard wantCollapsed, isEnabled else { return }
        generation += 1
        let gen = generation
        fitTask?.cancel()
        log("測り直し（\(reason)）")
        fitTask = Task { [weak self] in await self?.fit(gen) }
    }

    /// 畳んでいるあいだの軽い確認：幅は変えずに、今も目標の形かだけを見る。
    private func lightCheck() {
        guard wantCollapsed, isEnabled, fitTask == nil else { return }
        guard let s = separator?.button?.window?.frame, let b = beagle.button?.window?.frame else { return }
        let state = classify(sep: s, beagle: b)
        if !hiding || state != .overflow && state != .fits {
            scheduleRemeasure("定期確認: \(state.rawValue)", delay: 0)
        }
    }

    private func cacheKey() -> String {
        let app = NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "-"
        let screenW = Int(beagle.button?.window?.screen?.frame.width ?? 0)
        let bw = Int(beagle.button?.window?.frame.width ?? 0)
        return "\(app)|\(screenW)|\(bw)"
    }

    private func classify(sep s: NSRect, beagle b: NSRect) -> Fit {
        let anchor = b.minX - anchorOffset
        if abs(s.maxX - anchor) <= 1.5 { return .fits }
        if s.maxX < anchor - 1.5 && s.maxX > anchor - 40 { return .overflow }
        if s.maxX > anchor + 1.5 { return .dropped }
        return .unknown
    }

    /// 区切りと ビーグルの window.frame が 2 回続けて同じになるまで待って読む。揺れ続けたら nil。
    private func settledFrames(_ gen: Int) async -> (sep: NSRect, beagle: NSRect)? {
        var prev: (NSRect, NSRect)?
        for i in 0..<7 {
            try? await Task.sleep(for: .milliseconds(i == 0 ? 450 : 300))
            guard gen == generation, !Task.isCancelled else { return nil }
            guard let s = separator?.button?.window?.frame, let b = beagle.button?.window?.frame else { return nil }
            if let p = prev, p.0 == s, p.1 == b { return (s, b) }
            prev = (s, b)
        }
        return nil
    }

    private func fit(_ gen: Int) async {
        defer { if gen == generation { fitTask = nil } }
        guard let sep = separator, let bw = beagle.button?.window, let screen = bw.screen ?? NSScreen.main else { return safe("ビーグルが見つからない", gen) }
        // 区切りがビーグルの右にあると、広げたときにビーグルが押し出されるので畳まない。
        if let s = sep.button?.window?.frame, s.minX >= bw.frame.maxX - 1 {
            return safe("区切りがビーグルの右にある（⌘ を押しながらビーグルの左へ戻してください）", gen)
        }
        // 最小の幅のときは、まず基準（区切りの右端とビーグルの左端のずれ）を測る。
        if sep.length <= Self.minLength + 1 {
            guard let f = await settledFrames(gen) else { return gen == generation ? safe("位置が落ち着かない", gen) : () }
            anchorOffset = f.beagle.minX - f.sep.maxX
        }
        showSeparatorMark(false)
        let key = cacheKey()
        if noRoom.contains(key) { return safe("余地がない（前に測った）", gen) }
        let anchorX = bw.frame.minX - anchorOffset
        let room = max(anchorX - screen.frame.minX, 200)
        var lo = Self.minLength      // 収まる（« に入らない）ことが分かっている最大
        var hi: CGFloat?             // 外される（何も隠れない）ことが分かっている最小
        // 変化の少ない順：このアプリで前に合った幅 → いま隠せている幅 → 目安（区切りから画面の左端までの 6 割）
        var L = cache[key] ?? (hiding && sep.length > Self.minLength + 1 ? sep.length : (room * 0.6).rounded())
        for _ in 0..<12 {
            if sep.length != L { sep.length = L }
            guard let f = await settledFrames(gen) else { return gen == generation ? safe("位置が落ち着かない", gen) : () }
            let state = classify(sep: f.sep, beagle: f.beagle)
            log("  幅 \(Int(L)) → \(state.rawValue)（区切り右端 \(Int(f.sep.maxX)) / 基準 \(Int(f.beagle.minX - anchorOffset))）")
            switch state {
            case .overflow:
                cache[key] = L
                hiding = true
                log("畳んだ（« ビーグル、幅 \(Int(L))）")
                return
            case .fits: lo = max(lo, L)
            case .dropped:
                hi = min(hi ?? .infinity, L)
                // 細くしても外される＝メニューが長くて余地がない（ビーグルごと « に入っていることも）。待つ。
                if L < 60 { noRoom.insert(key); return safe("余地がない（前面のアプリのメニューが長い）", gen) }
            case .unknown: return safe("位置が読めない", gen)
            }
            if let h = hi {
                if h - lo < 6 { break }
                L = ((lo + h) / 2).rounded()
            } else {
                L = min(max((L * 1.4).rounded(), L + 60), room * 3)
                if L <= lo { break }
            }
        }
        // « にしまえる幅が見つからない：収まる最大の幅（左のアイコンはメニューの右の « に入る）で妥協する。
        if lo > Self.minLength + 40 {
            if sep.length != lo { sep.length = lo }
            if let f = await settledFrames(gen), classify(sep: f.sep, beagle: f.beagle) == .fits {
                cache[key] = lo
                hiding = true
                log("畳んだ（メニューの右に «、幅 \(Int(lo))）")
                return
            }
        }
        safe("畳める幅が見つからない", gen)
    }

    /// 安全側：何も隠さない（区切りは最小の幅）。畳みたい気持ちは保ち、次のきっかけで測り直す。
    private func safe(_ why: String, _ gen: Int) {
        guard gen == generation, let sep = separator else { return }
        sep.length = Self.minLength
        showSeparatorMark(true)
        hiding = false
        log("安全側に戻した: \(why)")
    }

    private func showSeparatorMark(_ on: Bool) {
        guard let b = separator?.button else { return }
        if on {
            let img = NSImage(systemSymbolName: "chevron.compact.left", accessibilityDescription: "区切り")
            img?.isTemplate = true
            b.image = img
        } else {
            b.image = nil
        }
        b.imagePosition = .imageOnly
    }

    @objc private func separatorClicked() { toggle() }

    // MARK: - 3 本指タップ（調べる＆データ検出）

    /// ビーグルのボタンの次の応答者に自前の応答者を差し込み、quickLook(with:) を受ける。
    private func installQuickLook() {
        guard let button = beagle.button, button.nextResponder !== quickLook else { return }
        quickLook.onQuickLook = { [weak self] in
            self?.log("3 本指タップ")
            self?.toggle()
        }
        quickLook.nextResponder = button.nextResponder
        button.nextResponder = quickLook
    }

    private func removeQuickLook() {
        guard let button = beagle.button, button.nextResponder === quickLook else { return }
        button.nextResponder = quickLook.nextResponder
        quickLook.nextResponder = nil
        quickLook.onQuickLook = nil
    }

    private func log(_ s: String) {
        onLog?(s)
        #if DEBUG
        NSLog("[collapse] %@", s)
        #endif
    }
}

/// 3 本指タップ（「調べる＆データ検出」）で届く quickLook(with:) を受ける応答者。
final class QuickLookCatcher: NSResponder {
    var onQuickLook: (() -> Void)?
    override func quickLook(with event: NSEvent) {
        if let onQuickLook { onQuickLook() } else { super.quickLook(with: event) }
    }
}
