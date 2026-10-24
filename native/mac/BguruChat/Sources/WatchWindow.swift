import AppKit
import SwiftUI

/// 📺 The player in its own window (the page's ⧉, or ☗ / 🎮 opening over a docked player): resizable,
/// above other windows, on every desktop. The same web view as in the chat (the video does not restart).
/// Closing the window closes the player for this Mac; the others watch on.
@MainActor
final class WatchWindow: NSObject, NSWindowDelegate {
    private var panel: NSPanel?
    private weak var watch: WatchStore?
    private static let frameKey = "BguruWatchWindow"

    init(watch: WatchStore) {
        self.watch = watch
        super.init()
    }

    func update(_ mode: WatchStore.Mode) {
        guard let watch else { return }
        if mode == .floating && watch.open { show(watch) } else { hide() }
    }

    private func show(_ watch: WatchStore) {
        if panel == nil {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 400),
                            styleMask: [.titled, .closable, .resizable, .utilityWindow, .nonactivatingPanel],
                            backing: .buffered, defer: false)
            p.title = "📺 みんなで見る"
            p.level = .floating
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            p.isReleasedWhenClosed = false
            p.hidesOnDeactivate = false
            p.minSize = NSSize(width: 320, height: 220)
            p.delegate = self
            p.contentView = NSHostingView(rootView: WatchWindowContent(watch: watch))
            if !p.setFrameUsingName(Self.frameKey) { p.center() }
            p.setFrameAutosaveName(Self.frameKey)
            panel = p
        }
        panel?.title = "📺 " + (watch.title ?? "みんなで見る")
        panel?.orderFrontRegardless()
        HangWatch.note("watch window shown")
    }

    private func hide() {
        panel?.orderOut(nil)
    }

    func windowWillClose(_ notification: Notification) {
        watch?.close()
    }
}

private struct WatchWindowContent: View {
    let watch: WatchStore
    var body: some View {
        WatchPlayerHost(watch: watch)
            .frame(minWidth: 320, minHeight: 200)
            .onChange(of: watch.title) { _, _ in }
    }
}
