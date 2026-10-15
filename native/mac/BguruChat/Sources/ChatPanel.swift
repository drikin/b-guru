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

    init(store: ChatStore, onSignOut: @escaping () -> Void) {
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
        minSize = NSSize(width: 300, height: 320)
        standardWindowButton(.miniaturizeButton)?.isHidden = true
        standardWindowButton(.zoomButton)?.isHidden = true
        delegate = self
        animationBehavior = .utilityWindow
        let root = ChatView(store: store, pin: pin, onClose: { [weak self] in self?.dismiss() }, onSignOut: onSignOut)
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
        alphaValue = 0
        makeKeyAndOrderFront(nil)
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.16
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            animator().alphaValue = 1
        }
        store.isVisible = true
    }

    func dismiss() {
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.12
            animator().alphaValue = 0
        }, completionHandler: { [weak self] in
            Task { @MainActor in
                self?.orderOut(nil)
                self?.alphaValue = 1
                self?.store.isVisible = false
            }
        })
    }

    private func applyPin(_ pinned: Bool) {
        level = pinned ? .floating : .normal
        UserDefaults.standard.set(pinned, forKey: "pinned")
        if pinned {
            setFrameAutosaveName("BguruChatPinned")
            UserDefaults.standard.set(true, forKey: "hasPinnedFrame")
        }
    }

    // Esc closes.
    override func cancelOperation(_ sender: Any?) { dismiss() }

    func windowDidResignKey(_ notification: Notification) {
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
    @ObservationIgnored var onChange: ((Bool) -> Void)?
}
