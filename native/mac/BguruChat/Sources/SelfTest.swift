#if DEBUG
import AppKit
import SwiftUI

/// Dev-only headless check (no screen recording needed):
///   BGURU_DEV_TOKEN=bga_… "B-guru Chat" -selftest OUT_DIR [-selftest-send]
/// Waits for the live stream + first load, optionally sends one message and
/// times "send() → bubble on screen" and "→ confirmed by the server", renders
/// the chat view to OUT_DIR/chat.png, writes OUT_DIR/selftest.json, and quits.
@MainActor
enum SelfTest {
    static func run(store: ChatStore, outDir: String, send: Bool) {
        Task { @MainActor in
            var report: [String: Any] = [:]
            let t0 = Date()
            while store.connection != .live || store.rows.isEmpty {
                if Date().timeIntervalSince(t0) > 20 { break }
                try? await Task.sleep(for: .milliseconds(50))
            }
            report["connected_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
            report["connection"] = "\(store.connection)"
            report["rows"] = store.rows.count
            report["can_send"] = store.capabilities?.canSend ?? false
            report["can_react"] = store.capabilities?.canReact ?? false
            report["online"] = store.onlineCount
            report["unread"] = store.unreadCount

            if send {
                let body = "（Claude による Mac アプリ試作の送信テストです。すぐ消します🐶）"
                let before = store.rows.count
                let s0 = Date()
                store.send(body, restore: { _ in })
                report["send_to_bubble_ms"] = store.rows.count > before ? Int(Date().timeIntervalSince(s0) * 1000) : -1
                report["bubble_state"] = "\(store.rows.last?.state ?? .sent)"
                while store.rows.last?.state != .sent || (store.rows.last?.message.id ?? -1) < 0 {
                    if Date().timeIntervalSince(s0) > 15 { break }
                    try? await Task.sleep(for: .milliseconds(5))
                }
                report["send_to_confirmed_ms"] = Int(Date().timeIntervalSince(s0) * 1000)
                report["sent_id"] = store.rows.last?.message.id ?? -1
                report["duplicates"] = store.rows.filter { $0.message.body == body }.count
                try? await Task.sleep(for: .seconds(2)) // let the stream echo arrive
                report["duplicates_after_echo"] = store.rows.filter { $0.message.body == body }.count
            }

            store.isVisible = true
            if CommandLine.arguments.contains("-reveal"), store.rows.count > 6 {
                let target = store.rows[store.rows.count - 7].message.id
                report["revealed_id"] = target
                store.reveal(target)
            }
            // Render through a real (off-screen) window so AppKit-backed views
            // — ScrollView, TextField — draw too; ImageRenderer cannot.
            let pin = PinState()
            let host = NSHostingView(rootView: ChatView(store: store, pin: pin, onClose: {}, onSignOut: {}))
            let win = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 380, height: 560),
                               styleMask: [.borderless], backing: .buffered, defer: false)
            win.appearance = NSAppearance(named: CommandLine.arguments.contains("-dark") ? .darkAqua : .aqua)
            win.contentView = host
            win.orderFrontRegardless()
            try? await Task.sleep(for: .milliseconds(900))
            host.layoutSubtreeIfNeeded()
            if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                host.cacheDisplay(in: host.bounds, to: rep)
                if let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: outDir).appendingPathComponent("chat.png"))
                    report["snapshot"] = "chat.png"
                }
            }
            // The reaction picker on its own.
            let pickerHost = NSHostingView(rootView: ReactionPicker { _ in })
            let pwin = NSWindow(contentRect: NSRect(x: -4000, y: -3000, width: 230, height: 260),
                                styleMask: [.borderless], backing: .buffered, defer: false)
            pwin.contentView = pickerHost
            pwin.orderFrontRegardless()
            try? await Task.sleep(for: .milliseconds(1200))
            if let rep = pickerHost.bitmapImageRepForCachingDisplay(in: pickerHost.bounds) {
                pickerHost.cacheDisplay(in: pickerHost.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?
                    .write(to: URL(fileURLWithPath: outDir).appendingPathComponent("picker.png"))
            }
            let json = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
            try? json?.write(to: URL(fileURLWithPath: outDir).appendingPathComponent("selftest.json"))
            NSApp.terminate(nil)
        }
    }
}
#endif
