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
        guard isVisible else { return false }
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
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        // Always above other apps' windows (drikin 2026-10-15「常に前面に」).
        level = .floating
        minSize = NSSize(width: 300, height: 320)
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        delegate = self
        animationBehavior = .utilityWindow
        let root = MainPanelView(store: store, timeline: timeline, pin: pin, onClose: { [weak self] in self?.dismiss() }, onSignOut: onSignOut)
        contentView = NSHostingView(rootView: root)
        pin.onChange = { [weak self] pinned in self?.applyPin(pinned) }
        if UserDefaults.standard.bool(forKey: "pinned") { pin.pinned = true }
    }

    override var canBecomeKey: Bool { true }

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

    private func applyPin(_ pinned: Bool) {
        UserDefaults.standard.set(pinned, forKey: "pinned")
        if pinned {
            setFrameAutosaveName("BguruChatPinned")
            UserDefaults.standard.set(true, forKey: "hasPinnedFrame")
        }
    }

    // Esc closes.
    override func cancelOperation(_ sender: Any?) { dismiss() }

    func windowDidResignKey(_ notification: Notification) {
        lastResignKeyAt = Date()
        // Peek mode: click elsewhere and it gets out of the way.
        if !pin.pinned { dismiss() }
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
    @ObservationIgnored var onChange: ((Bool) -> Void)?
}
