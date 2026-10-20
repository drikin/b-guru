import AppKit
import SwiftUI

/// The chat window: a non-activating panel that drops from the menu bar like
/// Spotlight. It takes keyboard focus without pulling the app (or its other
/// windows) forward, and hides when you click elsewhere — unless pinned, in
/// which case it floats above everything on every Space (e.g. over OBS during
/// a broadcast) and remembers where you put it.
@MainActor
final class ChatPanel: NSPanel, NSWindowDelegate {
    private let store: ChatStore
    let pin = PinState()
    /// Bumped on every present/dismiss. A fade-out only hides the panel if no
    /// present() happened meanwhile — otherwise clicking the menu bar icon
    /// (which first takes focus away and starts a fade-out) would reopen the
    /// panel and then have the stale fade-out hide it again.
    private var generation = 0
    /// True between dismiss() and the end of its fade-out.
    private(set) var isDismissing = false
    /// When the panel last lost keyboard focus. Clicking the menu bar icon can
    /// itself take focus away a moment before the click action runs; a toggle
    /// must still see that as "the panel was in front" and close it.
    private var lastResignKeyAt: Date?

    /// Open and in front as far as a toggle is concerned.
    var isFrontForToggle: Bool {
        if isDismissing { return true } // already closing because of this very click
        guard isVisible, isOnActiveSpace else { return false } // pinned on another desktop: summon it here
        if isKeyWindow { return true }
        if let t = lastResignKeyAt, Date().timeIntervalSince(t) < 0.35 { return true }
        return false
    }

    init(store: ChatStore, timeline: TimelineStore, onSignOut: @escaping () -> Void) {
        self.store = store
        super.init(contentRect: NSRect(x: 0, y: 0, width: 380, height: 560),
                   styleMask: [.titled, .closable, .resizable, .fullSizeContentView, .nonactivatingPanel],
                   backing: .buffered, defer: false)
        titleVisibility = .hidden
        titlebarAppearsTransparent = true
        isMovableByWindowBackground = true
        isReleasedWhenClosed = false
        hidesOnDeactivate = false
        becomesKeyOnlyIfNeeded = false
        collectionBehavior = Self.peekBehavior
        // Always above other apps' windows (drikin 2026-10-15「常に前面に」).
        level = .floating
        minSize = NSSize(width: 300, height: 320)
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        delegate = self
        animationBehavior = .utilityWindow
        let root = MainPanelView(store: store, timeline: timeline, pin: pin, onClose: { [weak self] in self?.dismiss() }, onSignOut: onSignOut)
        let host = NSHostingView(rootView: root)
        // Only keep the content's minimum: growing to its ideal size made the panel wide
        // (the jukebox's sideways chip rows, three long tabs — drikin 2026-10-19).
        host.sizingOptions = [.minSize]
        contentView = host
        pin.wantsHeight = { [weak self] h in self?.grow(toHeight: h) }
        pin.onChange = { [weak self] pinned in self?.applyPin(pinned) }
        pin.openEmoji = { [weak self] in self?.openEmojiPalette() }
        if UserDefaults.standard.bool(forKey: "pinned") { pin.pinned = true }
        narrowOnce()
    }

    /// 0.3.13–0.3.18 widened the panel to fit the jukebox, and the pinned frame kept that
    /// width. Once, bring it back to the usual width (drikin 2026-10-19「もうちょっと縦長に」);
    /// a width the member sets afterwards stays.
    private func narrowOnce() {
        let key = "panelNarrowed20261019"
        guard !UserDefaults.standard.bool(forKey: key) else { return }
        UserDefaults.standard.set(true, forKey: key)
        var f = frame
        guard f.width > 400 else { return }
        f.origin.x += (f.width - 380) / 2
        f.size.width = 380
        setFrame(f, display: false)
    }

    override var canBecomeKey: Bool { true }

    /// Taller for the jukebox (the turntable and the shelf), never wider; keeps the top
    /// edge where it is and stays on the screen. Never shrinks what the member set.
    private func grow(toHeight h: CGFloat) {
        guard let screen = screen ?? NSScreen.main else { return }
        let visible = screen.visibleFrame
        var f = frame
        let target = min(h, visible.height)
        guard f.height < target else { return }
        let top = f.maxY
        f.size.height = target
        f.origin.y = max(visible.minY, top - target)
        if f.maxY > visible.maxY { f.origin.y = visible.maxY - target }
        setFrame(f, display: true, animate: false) // an animated resize relaid the whole view every frame
    }

    private var swipe = SwipeTracker()

    /// A sideways swipe over something that scrolls sideways (the jukebox's chip rows)
    /// scrolls it, not the tabs.
    private func overSidewaysScroller(_ event: NSEvent) -> Bool {
        guard let content = contentView,
              let hit = content.hitTest(content.convert(event.locationInWindow, from: nil)) else { return false }
        var v: NSView? = hit
        while let view = v {
            if let sv = view as? NSScrollView, let doc = sv.documentView,
               doc.frame.width > sv.contentView.bounds.width + 1 { return true }
            v = view.superview
        }
        return false
    }

    override func sendEvent(_ event: NSEvent) {
        // The cheap tracker first; the view lookup only once a swipe has fired (it ran on
        // every scroll event and made all scrolling heavier — drikin 2026-10-19).
        if event.type == .scrollWheel, let step = swipe.handle(event), !overSidewaysScroller(event) {
            // 📰 → 💬 → 📻 (the tabs' order), one step per swipe (drikin 2026-10-19: with three
            // tabs the swipe only went between the first two).
            var order: [MainTab] = [.timeline, .chat]
            if store.capabilities?.jukeboxEnabled ?? false { order.append(.jukebox) }
            if let i = order.firstIndex(of: pin.tab) {
                let next = max(0, min(order.count - 1, i + step))
                if next != i { withAnimation(.easeOut(duration: 0.18)) { pin.tab = order[next] } }
            }
        }
        // ⌘V with an image (and no text) on the pasteboard in the chat: attach it.
        if event.type == .keyDown, event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
           event.charactersIgnoringModifiers == "v", pin.tab == .chat, let data = Self.pastedImage() {
            NotificationCenter.default.post(name: .chatPasteImage, object: data)
            return
        }
        // Mouse back button (button 4 = number 3): thread → timeline.
        if event.type == .otherMouseDown, event.buttonNumber == 3, pin.tab == .timeline {
            NotificationCenter.default.post(name: .timelineBack, object: nil)
            return
        }
        super.sendEvent(event)
    }

    /// Image bytes on the general pasteboard when it holds an image and no text
    /// (copying text from a web page also puts an image there sometimes: text wins).
    private static func pastedImage() -> Data? {
        let pb = NSPasteboard.general
        if pb.string(forType: .string) != nil { return nil }
        if let png = pb.data(forType: .png) { return png }
        if let tiff = pb.data(forType: .tiff), let rep = NSBitmapImageRep(data: tiff) { return rep.representation(using: .png, properties: [:]) }
        if let url = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true])?.first as? URL,
           let data = try? Data(contentsOf: url), NSImage(data: data) != nil { return data }
        return nil
    }

    func present(below anchor: NSRect) {
        if !pin.pinned || !UserDefaults.standard.bool(forKey: "hasPinnedFrame") {
            let screen = NSScreen.screens.first { $0.frame.contains(anchor.origin) } ?? NSScreen.main
            var origin = NSPoint(x: anchor.midX - frame.width / 2, y: anchor.minY - frame.height - 6)
            if let vis = screen?.visibleFrame {
                origin.x = min(max(origin.x, vis.minX + 8), vis.maxX - frame.width - 8)
            }
            setFrameOrigin(origin)
        }
        generation += 1
        isDismissing = false
        let fadeIn = !isVisible || alphaValue < 1
        if fadeIn { alphaValue = 0 }
        if pin.pinned, isVisible, !isOnActiveSpace {
            // Pinned on another desktop and called up here (⌃⌥B / menu bar):
            // bring it to this desktop and pin it here from now on.
            collectionBehavior = Self.peekBehavior
            orderFrontRegardless()
            collectionBehavior = Self.pinnedBehavior
        }
        orderFrontRegardless()
        makeKey()
        if fadeIn {
            NSAnimationContext.runAnimationGroup { ctx in
                ctx.duration = 0.16
                ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
                animator().alphaValue = 1
            }
        }
        store.isVisible = true
        focusComposer()
    }

    /// Every open puts the caret in the message box so you can type and hit
    /// Enter immediately (drikin 2026-10-15). SwiftUI focus is asked first;
    /// AppKit makes sure on the next runloop turn in case SwiftUI kept a stale
    /// "already focused" state from the previous open.
    private func focusComposer() {
        pin.focusRequest += 1
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isKeyWindow else { return }
            if !Self.isEditingText(self.firstResponder), let field = Self.firstEditableText(in: self.contentView) {
                self.makeFirstResponder(field)
            }
            #if DEBUG
            if CommandLine.arguments.contains("-logFocus") {
                NSLog("[focus] key=%d responder=%@ editing=%d", self.isKeyWindow ? 1 : 0,
                      String(describing: type(of: self.firstResponder as Any)), Self.isEditingText(self.firstResponder) ? 1 : 0)
            }
            #endif
        }
    }

    private static func isEditingText(_ r: NSResponder?) -> Bool {
        guard let tv = r as? NSTextView else { return false }
        return tv.isEditable
    }

    private static func firstEditableText(in view: NSView?) -> NSView? {
        guard let view else { return nil }
        if let tf = view as? NSTextField, tf.isEditable { return tf }
        if let tv = view as? NSTextView, tv.isEditable { return tv }
        for sub in view.subviews {
            if let hit = firstEditableText(in: sub) { return hit }
        }
        return nil
    }

    func dismiss() {
        stopFollowingPalette()
        if let prev = previousApp {
            previousApp = nil
            prev.activate()
        }
        generation += 1
        isDismissing = true
        let mine = generation
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.12
            animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                guard let self, self.generation == mine else { return } // reopened meanwhile
                self.isDismissing = false
                self.orderOut(nil)
                self.alphaValue = 1
                self.store.isVisible = false
            }
        })
    }

    /// Peek (not pinned): drops down on whichever desktop (Space) you are on.
    static let peekBehavior: NSWindow.CollectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
    /// Pinned: stays on the desktop where it was pinned (drikin 2026-10-17) —
    /// switching desktops leaves it behind; coming back finds it where it was.
    static let pinnedBehavior: NSWindow.CollectionBehavior = [.fullScreenAuxiliary, .ignoresCycle]

    private func applyPin(_ pinned: Bool) {
        // Dropping canJoinAllSpaces while on screen binds the panel to the current desktop.
        collectionBehavior = pinned ? Self.pinnedBehavior : Self.peekBehavior
        UserDefaults.standard.set(pinned, forKey: "pinned")
        if pinned {
            setFrameAutosaveName("BguruChatPinned")
            UserDefaults.standard.set(true, forKey: "hasPinnedFrame")
        }
    }

    // Esc closes.
    override func cancelOperation(_ sender: Any?) {
        if ImageViewerOverlay.closeIfOpen() { return } // a picture over the panel goes first
        dismiss()
    }

    func windowDidResignKey(_ notification: Notification) {
        lastResignKeyAt = Date()
        // Peek mode: click elsewhere and it gets out of the way — but not when the
        // focus only moved to our own sheet (new post, image viewer, alert) or the
        // photo / file picker it opened. Decide once the new key window is known.
        guard !pin.pinned else { return }
        // The emoji & symbols palette appears a moment after it takes the focus,
        // so look twice before deciding the user clicked elsewhere.
        DispatchQueue.main.async { [weak self] in self?.dismissIfFocusLeft(recheck: true) }
    }

    private func dismissIfFocusLeft(recheck: Bool) {
        guard isVisible, !isDismissing, !pin.pinned, !isKeyWindow, !ownsKeyWindow else { return }
        if Self.systemInputPaletteVisible {
            // Opened with 🌐E / Edit menu of the system: it is bound to the input it
            // was opened from — activating our app now would make it close at once.
            followPalette(activate: false)
            return
        }
        if recheck {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { [weak self] in self?.dismissIfFocusLeft(recheck: false) }
            return
        }
        dismiss()
    }

    // MARK: Emoji & symbols palette (⌃⌘Space / 🌐E)

    /// Processes whose windows are part of typing into us (the emoji & symbols
    /// palette, press-and-hold accents): focus moving there is not "clicked elsewhere".
    private static let inputPaletteBundles: Set<String> = [
        "com.apple.CharacterPaletteIM", "com.apple.PressAndHold", "com.apple.inputmethod.EmojiFunctionRowItem",
    ]

    static var systemInputPaletteVisible: Bool {
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for w in list {
            // Only a palette you can see (the process keeps helper windows around).
            if let alpha = w[kCGWindowAlpha as String] as? CGFloat, alpha < 0.05 { continue }
            if let b = w[kCGWindowBounds as String] as? [String: CGFloat], (b["Width"] ?? 0) < 60 || (b["Height"] ?? 0) < 60 { continue }
            guard let pid = w[kCGWindowOwnerPID as String] as? pid_t,
                  let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier else { continue }
            if inputPaletteBundles.contains(id) { return true }
        }
        return false
    }

    private var paletteWatch: Timer?
    private var outsideClick: Any?
    /// The app that was in front before we activated for the palette (given back on dismiss).
    private var previousApp: NSRunningApplication?

    /// The palette types into the ACTIVE app, and this panel normally never
    /// activates its app — so become active (remembering who was) while it is used.
    private func activateForPalette() {
        if !NSApp.isActive {
            let front = NSWorkspace.shared.frontmostApplication
            if front?.processIdentifier != ProcessInfo.processInfo.processIdentifier { previousApp = front }
            NSApp.activate()
        }
        makeKeyAndOrderFront(nil)
    }

    /// While the palette is open: stay. When it closes, give the caret back to the
    /// message box; a click anywhere else (not on the palette) puts the panel away.
    private func followPalette(activate: Bool) {
        stopFollowingPalette()
        if activate { activateForPalette() }
        paletteWatch = Timer.scheduledTimer(withTimeInterval: 0.4, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                if !self.isVisible || self.isKeyWindow { self.stopFollowingPalette(); return }
                if !Self.systemInputPaletteVisible {
                    self.stopFollowingPalette()
                    self.makeKeyAndOrderFront(nil)
                    self.pin.focusRequest += 1
                }
            }
        }
        outsideClick = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .leftMouseUp]) { [weak self] e in
            let type = e.type
            Task { @MainActor in
                guard let self else { return }
                if Self.paletteUnderMouse {
                    // Picked an emoji: it is typed into this panel only once the panel has
                    // the keyboard again (it is not the active app), so take it back.
                    if type == .leftMouseUp {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in
                            guard let self, self.isVisible, !self.isKeyWindow else { return }
                            self.stopFollowingPalette()
                            self.makeKeyAndOrderFront(nil)
                        }
                    }
                    return
                }
                guard type != .leftMouseUp else { return }
                self.stopFollowingPalette()
                if !self.pin.pinned { self.dismiss() }
            }
        }
    }

    private func stopFollowingPalette() {
        paletteWatch?.invalidate()
        paletteWatch = nil
        if let m = outsideClick { NSEvent.removeMonitor(m) }
        outsideClick = nil
    }

    private static var paletteUnderMouse: Bool {
        let p = NSEvent.mouseLocation
        guard let screenH = NSScreen.screens.first?.frame.height else { return false }
        let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
        for w in list {
            guard let pid = w[kCGWindowOwnerPID as String] as? pid_t,
                  let id = NSRunningApplication(processIdentifier: pid)?.bundleIdentifier,
                  inputPaletteBundles.contains(id),
                  let b = w[kCGWindowBounds as String] as? [String: CGFloat],
                  let x = b["X"], let y = b["Y"], let wd = b["Width"], let ht = b["Height"] else { continue }
            // CG window bounds are top-left based; NSEvent.mouseLocation is bottom-left.
            if NSRect(x: x, y: screenH - y - ht, width: wd, height: ht).contains(p) { return true }
        }
        return false
    }

    /// The 😀 button and ⌃⌘Space.
    func openEmojiPalette() {
        activateForPalette()
        NSApp.orderFrontCharacterPalette(nil)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.followPalette(activate: false) }
    }

    /// ⌃⌘Space opens the emoji & symbols palette for the message box (an
    /// accessory app has no Edit menu to provide that shortcut).
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.charactersIgnoringModifiers == " ",
           event.modifierFlags.intersection(.deviceIndependentFlagsMask) == [.control, .command] {
            NSApp.orderFrontCharacterPalette(nil)
            return true
        }
        return super.performKeyEquivalent(with: event)
    }

    /// The key window belongs to this panel: an attached sheet (and anything it
    /// opened), a child window, or a picker presented for it.
    private var ownsKeyWindow: Bool {
        if attachedSheet != nil { return true }
        guard let key = NSApp.keyWindow else { return false }
        var w: NSWindow? = key
        while let cur = w {
            if cur === self { return true }
            w = cur.sheetParent ?? cur.parent
        }
        return key is NSOpenPanel || key is NSSavePanel
    }

    func windowDidBecomeKey(_ notification: Notification) {
        store.isVisible = true
    }

    func windowWillClose(_ notification: Notification) {
        store.isVisible = false
    }
}

@MainActor
@Observable
final class PinState {
    var pinned = false {
        didSet { onChange?(pinned) }
    }
    /// Incremented each time the panel opens; the chat view moves the caret
    /// into the message box when it changes.
    var focusRequest = 0
    /// Chat or timeline (the switch at the top, ⌘1 / ⌘2, or a two-finger swipe).
    var tab: MainTab = .chat
    /// Opens the emoji & symbols palette for the message box (set by the panel).
    @ObservationIgnored var openEmoji: (() -> Void)?
    @ObservationIgnored var onChange: ((Bool) -> Void)?
    /// Asks the panel to be at least this tall (set by the panel).
    @ObservationIgnored var wantsHeight: ((CGFloat) -> Void)?
}

/// Two-finger horizontal swipe on the trackpad → switch chat ⇄ timeline, like
/// paging. Fingers to the left = the page on the right (timeline), fingers to the
/// right = back to chat — whatever the "natural scrolling" setting is.
/// One switch per gesture; vertical scrolling and momentum are left alone.
struct SwipeTracker {
    private var dx: CGFloat = 0
    private var dy: CGFloat = 0
    private var fired = false

    /// Returns +1 (fingers moved left → next page), -1 (fingers moved right → previous) or nil.
    mutating func handle(_ e: NSEvent) -> Int? {
        guard e.hasPreciseScrollingDeltas, e.momentumPhase.isEmpty else { return nil }
        if e.phase.contains(.began) { dx = 0; dy = 0; fired = false }
        // Finger direction: with natural scrolling the deltas already follow the fingers.
        let sign: CGFloat = e.isDirectionInvertedFromDevice ? 1 : -1
        dx += e.scrollingDeltaX * sign
        dy += e.scrollingDeltaY
        if e.phase.contains(.ended) || e.phase.contains(.cancelled) { defer { dx = 0; dy = 0 } ; return nil }
        guard !fired, abs(dx) > 60, abs(dx) > abs(dy) * 2 else { return nil }
        fired = true
        return dx < 0 ? 1 : -1
    }
}
