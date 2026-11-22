#if DEBUG
import AppKit

/// Dev only: `-demoPanel -demoChatStress SECONDS [-stressRows N]` — the chat's scroll stress check.
///
/// The freezes members sent (hangs.log 2026-11-18 / 11-21, macOS 26) came while scrolling the chat:
/// the main thread at 100 % inside the lazy list's placement. This scrolls the real panel the way a
/// trackpad does (precise, phased scroll-wheel events sent to the panel, up and down at changing
/// speeds, with flings and the pointer passing over the rows) while messages arrive, reactions and
/// edits change rows' heights. It prints the longest main-thread wait and exits 1 if the main thread
/// stopped answering for 2 s or more (0 otherwise), so a build can be checked before it ships.
/// The member's own pointer is not moved: the events go to the panel only.
@MainActor
enum ChatStress {
    private static var timer: Timer?

    static func run(panel: ChatPanel, store: ChatStore, seconds: Double) {
        let rows = CommandLine.arguments.firstIndex(of: "-stressRows").flatMap { i in
            i + 1 < CommandLine.arguments.count ? Int(CommandLine.arguments[i + 1]) : nil
        } ?? 600
        store.debugLoadStress(count: rows)
        let resize = CommandLine.arguments.contains("-stressResize")
        panel.pin.tab = .chat
        panel.setContentSize(NSSize(width: 420, height: 760))

        let watch = MainThreadWatch(limit: 2.0) { waited, step in
            print("[stress] FAIL main thread did not answer for \(String(format: "%.1f", waited)) s (\(step))")
            fflush(stdout)
            exit(1)
        }
        watch.start()

        let start = Date()
        var frame = 0
        var tick = 0
        var gesture = Gesture.next(0)
        print("[stress] \(rows) rows, \(Int(seconds)) s")
        timer = Timer.scheduledTimer(withTimeInterval: 1.0 / 60, repeats: true) { _ in
            MainActor.assumeIsolated {
                let t = Date().timeIntervalSince(start)
                if t >= seconds {
                    timer?.invalidate()
                    watch.stop()
                    print("[stress] ok  longest main-thread wait \(String(format: "%.2f", watch.longest)) s, \(store.rows.count) rows")
                    fflush(stdout)
                    exit(0)
                }
                watch.step = "frame \(frame), \(gesture.label)"
                send(gesture.event(at: frame - gesture.startFrame), to: panel)
                if frame - gesture.startFrame >= gesture.frames { gesture = Gesture.next(frame + 1) }
                frame += 1
                // Twice a second: something arrives / changes (a new message every 1.5 s).
                if frame % 30 == 0 { store.debugStressTick(tick); tick += 1 }
                // -stressResize: the panel's width changes every 5 s (the table measures its rows again).
                if resize, frame % 300 == 150 {
                    let widths: [CGFloat] = [360, 700, 480, 900, 420]
                    panel.setContentSize(NSSize(width: widths[(frame / 300) % widths.count], height: 760))
                }
                if frame % 300 == 0 { print("[stress] t=\(Int(t)) s  \(scrollPlace(panel))"); fflush(stdout) }
            }
        }
    }

    /// `-demoPanel -demoChatCheck`: the chat's scroll behaviour, step by step, printed as where the
    /// list is (`gap` = how far above the bottom). Run on two builds to compare them.
    static func check(panel: ChatPanel, store: ChatStore) {
        panel.pin.tab = .chat
        panel.setContentSize(NSSize(width: 420, height: 700))
        store.debugLoadStress(count: 300)
        func place() -> (y: Double, gap: Double) {
            guard let content = panel.contentView,
                  let sv = scrollView(in: panel, at: NSPoint(x: content.bounds.midX, y: content.bounds.height * 0.5)) else { return (-1, -1) }
            let y = sv.contentView.bounds.origin.y
            let maxY = (sv.documentView?.frame.height ?? 0) - sv.contentView.bounds.height
            return (y, maxY - y)
        }
        func say(_ s: String) { let p = place(); print("[check] \(s): y \(Int(p.y)) gap \(Int(p.gap))"); fflush(stdout) }
        func wheel(_ dy: Double) {
            guard let content = panel.contentView,
                  let sv = scrollView(in: panel, at: NSPoint(x: content.bounds.midX, y: content.bounds.height * 0.5)) else { return }
            for (i, phase) in [CGScrollPhase.began, .changed, .changed, .changed, .ended].enumerated() {
                guard let e = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(i == 4 ? 0 : dy / 4), wheel2: 0, wheel3: 0) else { continue }
                e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
                e.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: i == 4 ? 0 : dy / 4)
                e.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(phase.rawValue))
                if let ns = NSEvent(cgEvent: e) { sv.scrollWheel(with: ns) }
            }
        }
        // As the member's scrolling does: the clip view moves and the scroller follows (wheel events
        // made here were taken differently by the two lists).
        func scrollBy(_ up: Double) {
            guard let content = panel.contentView,
                  let sv = scrollView(in: panel, at: NSPoint(x: content.bounds.midX, y: content.bounds.height * 0.5)) else { return }
            var o = sv.contentView.bounds.origin
            o.y = max(0, o.y - up)
            sv.contentView.scroll(to: o)
            sv.reflectScrolledClipView(sv.contentView)
            _ = wheel // (kept for trying wheel events by hand)
        }
        let steps: [(Double, String, () -> Void)] = [
            (2.0, "opened (expect gap 0)", {}),
            (0.0, "new message at the bottom", { store.debugReceive("下で届いた新着", id: 5000) }),
            (1.0, "after it (expect gap 0)", {}),
            (0.0, "reaction on the last", { store.debugAddReactionToLast() }),
            (1.0, "after it (expect gap 0)", {}),
            (0.0, "scroll up 1500", { scrollBy(1500) }),
            (1.0, "scrolled up (expect gap ~1500)", {}),
            (0.0, "new message while up", { store.debugReceive("上を読んでいる間の新着", id: 5001) }),
            (1.0, "after it (expect y unchanged)", {}),
            (0.0, "reaction on a row above", { store.debugStressTick(2) }),
            (1.0, "after it (expect y about unchanged)", {}),
            (0.0, "jump to message 100 (notification)", { store.reveal(100) }),
            (1.5, "jumped (expect gap large)", {}),
            (0.0, "own message sent", { store.send("自分の発言", restore: { _ in }) }),
            (2.0, "after it (expect gap 0)", {}),
        ]
        if let content = panel.contentView, let table = Self.find(NSTableView.self, in: content) {
            let sv = table.enclosingScrollView
            print("[check] table style \(table.style.rawValue) frame \(table.frame) intercell \(table.intercellSpacing) scrollers \(sv?.scrollerStyle.rawValue ?? -1) insets \(String(describing: sv?.contentInsets)) clip \(sv?.contentView.frame ?? .zero) panel \(content.bounds.width)")
            if let rv = table.rowView(atRow: max(0, table.numberOfRows - 2), makeIfNecessary: false) {
                print("[check] row \(rv.frame) cell \(rv.subviews.map { "\(type(of: $0)) \($0.frame)" })")
            }
        }
        var t = 1.0
        for (wait, label, act) in steps {
            t += wait
            DispatchQueue.main.asyncAfter(deadline: .now() + t) { act(); say(label) }
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + t + 0.5) { exit(0) }
    }

    /// `-demoPanel -demoClickCheck`: who has the keyboard after a click on a row's empty side and on a
    /// bubble (the message box should keep it: Esc, ↑ to edit, Space in side by side depend on it).
    static func clickCheck(panel: ChatPanel) {
        panel.pin.tab = .chat
        func responder() -> String { panel.firstResponder.map { r in "\(type(of: r))\((r as? NSTextView)?.isEditable == true ? " (editable)" : "")" } ?? "nil" }
        func click(_ p: NSPoint, _ label: String) {
            for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                if let e = NSEvent.mouseEvent(with: t, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                              windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                    panel.sendEvent(e)
                }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { print("[click] after \(label): \(responder())"); fflush(stdout) }
        }
        guard let content = panel.contentView else { return }
        let w = content.bounds.width, h = content.bounds.height
        print("[click] before: \(responder())")
        click(NSPoint(x: w - 30, y: h * 0.45), "row's empty side")
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { click(NSPoint(x: 80, y: h * 0.45), "left of the row") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { exit(0) }
    }

    /// One trackpad gesture: fingers down, moving at `speed` pt per frame for `frames`, then lifted
    /// (with `fling`, momentum events after it, as the trackpad sends them).
    struct Gesture {
        var startFrame: Int
        var frames: Int
        var speed: Double
        var fling: Bool
        var label: String { "\(speed > 0 ? "up" : "down") \(Int(abs(speed)))pt×\(frames)\(fling ? " fling" : "")" }

        nonisolated(unsafe) static var seed: UInt64 = 0x9E3779B97F4A7C15
        static func random() -> Double {
            seed ^= seed << 13; seed ^= seed >> 7; seed ^= seed << 17
            return Double(seed % 10_000) / 10_000
        }

        static func next(_ at: Int) -> Gesture {
            let up = random() < 0.75 // reading back through the day, mostly
            let speed = 2 + random() * (random() < 0.2 ? 60 : 18)
            return Gesture(startFrame: at, frames: 6 + Int(random() * 40), speed: up ? speed : -speed, fling: random() < 0.35)
        }

        /// (delta, phase, momentum phase) for frame `i` of the gesture; nil = a pause between gestures.
        func event(at i: Int) -> (Double, CGScrollPhase?, CGMomentumScrollPhase?)? {
            let momentum = fling ? 60 : 0
            switch i {
            case 0: return (speed, .began, nil)
            case 1..<frames: return (speed, .changed, nil)
            case frames: return (0, .ended, nil)
            case (frames + 1)...(frames + momentum) where momentum > 0:
                let k = i - frames
                let d = speed * 1.5 * pow(0.95, Double(k))
                return (d, nil, k == 1 ? .begin : (k == momentum ? .end : .continuous))
            default: return nil
            }
        }
    }

    static func find<T: NSView>(_ type: T.Type, in v: NSView) -> T? {
        if let t = v as? T { return t }
        for s in v.subviews { if let t = find(type, in: s) { return t } }
        return nil
    }

    static func scrollView(in panel: ChatPanel, at p: NSPoint) -> NSScrollView? {
        guard let content = panel.contentView, let hit = content.hitTest(content.convert(p, from: nil)) else { return nil }
        var v: NSView? = hit
        while let view = v, !(view is NSScrollView) { v = view.superview }
        return v as? NSScrollView
    }

    /// Where the scroll view under the messages is (proves the events scroll it).
    static func scrollPlace(_ panel: ChatPanel) -> String {
        guard let content = panel.contentView,
              let sv = scrollView(in: panel, at: NSPoint(x: content.bounds.midX, y: content.bounds.height * 0.5)) else { return "no scroll view" }
        let y = sv.contentView.bounds.origin.y
        let h = sv.documentView?.frame.height ?? 0
        return "y \(Int(y)) of \(Int(h - sv.contentView.bounds.height)) (\(type(of: sv)))"
    }

    private static func send(_ e: (Double, CGScrollPhase?, CGMomentumScrollPhase?)?, to panel: ChatPanel) {
        guard let e, let content = panel.contentView else { return }
        // Over the chat's messages: the middle of the panel, a little above the message box,
        // wandering sideways so the pointer passes over avatars, bubbles and reaction chips.
        let wobble = sin(Date().timeIntervalSinceReferenceDate * 1.3) * content.bounds.width * 0.3
        let inWindow = NSPoint(x: content.bounds.midX + wobble, y: content.bounds.height * 0.5)
        let onScreen = panel.convertPoint(toScreen: inWindow)
        let primary = NSScreen.screens.first?.frame.height ?? 0
        let cgPoint = CGPoint(x: onScreen.x, y: primary - onScreen.y) // CG: top-left origin

        if let move = NSEvent.mouseEvent(with: .mouseMoved, location: inWindow, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 0, pressure: 0) {
            panel.sendEvent(move)
        }
        guard let wheel = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1,
                                  wheel1: Int32(e.0.rounded()), wheel2: 0, wheel3: 0) else { return }
        wheel.location = cgPoint
        wheel.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
        wheel.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: e.0)
        wheel.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: e.0)
        wheel.setIntegerValueField(.scrollWheelEventScrollPhase, value: Int64(e.1?.rawValue ?? 0))
        wheel.setIntegerValueField(.scrollWheelEventMomentumPhase, value: Int64(e.2?.rawValue ?? 0))
        // To the scroll view under the point (an event made from a CGEvent carries no window, so the
        // panel could not route it); the real pointer does not move.
        guard let ns = NSEvent(cgEvent: wheel), let sv = scrollView(in: panel, at: inWindow) else { return }
        let before = sv.contentView.bounds.origin
        sv.scrollWheel(with: ns)
        // The List's table takes no wheel event made here: move its clip view by the same amount
        // (what the trackpad's scrolling does to it), so both lists get the same scrolling.
        if sv.contentView.bounds.origin == before, e.0 != 0 {
            var o = before
            let maxY = max(0, (sv.documentView?.frame.height ?? 0) - sv.contentView.bounds.height)
            o.y = min(maxY, max(0, o.y - e.0))
            sv.contentView.scroll(to: o)
            sv.reflectScrolledClipView(sv.contentView)
        }
    }
}
#endif
