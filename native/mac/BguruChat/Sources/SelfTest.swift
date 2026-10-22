#if DEBUG
import AppKit
import SwiftUI
import Vision

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
            let draft = CommandLine.arguments.contains("-demo") ? "こんにちは @n" : ""
            let host: NSView
            if CommandLine.arguments.contains("-timeline") {
                let t = TimelineStore(api: APIClient(token: "demo"))
                t.debugLoadDemo()
                host = NSHostingView(rootView: MainPanelView(store: store, timeline: t, pin: pin, onClose: {}, onSignOut: {}, initialTab: .timeline))
            } else {
                host = NSHostingView(rootView: ChatView(store: store, pin: pin, onClose: {}, onSignOut: {}, initialDraft: draft))
            }
            let win = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 380, height: 560),
                               styleMask: [.borderless], backing: .buffered, defer: false)
            win.appearance = NSAppearance(named: CommandLine.arguments.contains("-dark") ? .darkAqua : .aqua)
            win.contentView = host
            win.orderFrontRegardless()
            try? await Task.sleep(for: .milliseconds(900))
            if CommandLine.arguments.contains("-reactLast") {
                // Local-only, AFTER the list is on screen: react to the last
                // message, as a user would, and see whether the chips stay visible.
                store.debugAddReactionToLast()
                try? await Task.sleep(for: .milliseconds(600))
            }
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

// MARK: - Upside-down check (in-process)

extension SelfTest {
    /// `-selftest DIR -demo -orientation`: draws each screen of the panel (chat, timeline,
    /// jukebox playing, ☗, 🎮, the picture viewer; light and dark) in an off-screen window,
    /// reads it with Vision as drawn and mirrored top to bottom, writes DIR/orientation-*.png
    /// and DIR/orientation.json, and quits with status 1 if any screen is not clearly upright.
    /// It sees what AppKit draws (the 2026-10-19 glyph-cache kind of flip); what WindowServer
    /// composites — and the web views (board, game) — is checked by scripts/orientation-tour.sh.
    static func runOrientation(store: ChatStore, outDir: String) {
        Task { @MainActor in
            let dir = URL(fileURLWithPath: outDir)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let timeline = TimelineStore(api: APIClient(token: "demo"))
            timeline.debugLoadDemo()
            store.jukebox.debugLoadDemo(base: ProcessInfo.processInfo.environment["BGURU_DEMO_AUDIO"] ?? "http://127.0.0.1:9")
            let pin = PinState()
            pin.windowVisible = true
            let host = NSHostingView(rootView: MainPanelView(store: store, timeline: timeline, pin: pin, onClose: {}, onSignOut: {}))
            let win = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 380, height: 720),
                               styleMask: [.borderless], backing: .buffered, defer: false)
            win.contentView = host
            win.orderFrontRegardless()
            store.isVisible = true

            // A picture with words (so the viewer can be told upright), as a local file.
            let photoFile = dir.appendingPathComponent("orientation-photo.png")
            writeTestPhoto(to: photoFile)
            let photo = "selftest/orientation-photo.png"
            if let img = NSImage(contentsOf: photoFile) { MediaCache.shared.debugInsert(img, for: photo) }

            typealias Step = (name: String, minChars: Int, setup: @MainActor () -> Void)
            var steps: [Step] = [
                ("chat", 12, { pin.tab = .chat }),
                ("timeline", 12, { pin.tab = .timeline }),
                ("jukebox-playing", 12, {
                    pin.tab = .jukebox
                    if let e = store.jukebox.todayEpisode { store.jukebox.play(e) }
                }),
                ("chat-after-jukebox", 12, { pin.tab = .chat }),
                ("viewer", 8, { NotificationCenter.default.post(name: .debugOpenImageViewer, object: photo) }),
                ("viewer-closed", 12, { NotificationCenter.default.post(name: .closeImageViewer, object: nil) }),
                ("shogi", 6, { store.shogi.openGame(101) }),
                ("minigame", 6, { store.minigame.show() }),
            ]
            let dark: [Step] = [
                ("dark-chat", 12, {
                    RoomModePicker.choose(.text, room: store.room, shogi: store.shogi, minigame: store.minigame)
                    win.appearance = NSAppearance(named: .darkAqua)
                }),
                ("dark-jukebox", 12, { pin.tab = .jukebox }),
                ("dark-timeline", 12, { pin.tab = .timeline }),
                ("final-chat", 12, { win.appearance = NSAppearance(named: .aqua); pin.tab = .chat }),
            ]
            steps.append(contentsOf: dark)

            var results: [[String: Any]] = []
            var failed = 0
            for step in steps {
                step.setup()
                try? await Task.sleep(for: .milliseconds(1100))
                host.layoutSubtreeIfNeeded()
                guard let image = render(host) else { failed += 1; continue }
                let png = dir.appendingPathComponent("orientation-\(step.name).png")
                if let rep = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) { try? rep.write(to: png) }
                let upright = readChars(image), mirroredChars = mirrored(image).map(readChars) ?? 0
                let ok = upright >= step.minChars && Double(upright) > Double(mirroredChars) * 1.5
                if !ok { failed += 1 }
                print("[orientation] \(ok ? "ok  " : "FAIL") \(step.name): upright \(upright), mirrored \(mirroredChars)")
                results.append(["screen": step.name, "ok": ok, "upright": upright, "mirrored": mirroredChars])
            }
            let json = try? JSONSerialization.data(withJSONObject: ["failed": failed, "screens": results], options: [.prettyPrinted, .sortedKeys])
            try? json?.write(to: dir.appendingPathComponent("orientation.json"))
            fflush(stdout)
            exit(failed == 0 ? 0 : 1)
        }
    }

    /// The view as AppKit draws it, at 2× (small text reads better).
    private static func render(_ view: NSView) -> CGImage? {
        let b = view.bounds
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(b.width * 2), pixelsHigh: Int(b.height * 2),
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                         colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else { return nil }
        rep.size = b.size
        view.cacheDisplay(in: b, to: rep)
        return rep.cgImage
    }

    private static func mirrored(_ image: CGImage) -> CGImage? {
        let w = image.width, h = image.height
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.translateBy(x: 0, y: CGFloat(h))
        ctx.scaleBy(x: 1, y: -1)
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        return ctx.makeImage()
    }

    /// Characters Vision reads with confidence (Japanese + English).
    private static func readChars(_ image: CGImage) -> Int {
        let req = VNRecognizeTextRequest()
        req.recognitionLevel = .accurate
        req.recognitionLanguages = ["ja-JP", "en-US"]
        req.usesLanguageCorrection = false
        req.minimumTextHeight = 0.008 // small labels count too (the default skips text under 1/32 of the height)
        try? VNImageRequestHandler(cgImage: image, options: [:]).perform([req])
        return (req.results ?? []).reduce(0) { n, o in
            guard let c = o.topCandidates(1).first, c.confidence >= 0.5 else { return n }
            return n + c.string.count
        }
    }

    /// Large words on white, drawn with Core Graphics + Core Text into a bitmap whose
    /// coordinates are NOT flipped (no SwiftUI, no ImageRenderer: see RecordArtwork).
    private static func writeTestPhoto(to url: URL) {
        let w = 900, h = 600
        guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return }
        ctx.setFillColor(CGColor(gray: 1, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: w, height: h))
        let font = CTFontCreateWithName("HiraginoSans-W6" as CFString, 72, nil)
        for (i, text) in ["写真のテスト", "B-guru Photo", "上が上です"].enumerated() {
            let line = CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: [
                .font: font, .foregroundColor: CGColor(gray: 0, alpha: 1)]))
            ctx.textPosition = CGPoint(x: 60, y: CGFloat(h - 140 - i * 160))
            CTLineDraw(line, ctx)
        }
        guard let img = ctx.makeImage(), let png = NSBitmapImageRep(cgImage: img).representation(using: .png, properties: [:]) else { return }
        try? png.write(to: url)
    }
}

// MARK: - Long thread check (the Mac froze opening a thread with many replies, 2026-10-21)

extension SelfTest {
    /// `-selftest DIR -demo -threadCheck [-demoReplies N]`: opens the demo thread with many
    /// replies in the real panel view (off-screen), scrolls it from the bottom to the top and
    /// back like a member would, reacts, closes it — and checks that the main thread keeps
    /// answering throughout. A watcher on another thread pings the main thread; if it does
    /// not answer within the limit (default 5 s, `-threadLimit S`), the check prints FAIL
    /// and exits 1 at once (the hang itself is also in HangWatch's hangs.log with the stack).
    /// Writes DIR/thread.json and DIR/thread-*.png. Exit 0 = passed.
    static func runThreadCheck(store: ChatStore, outDir: String) {
        let args = CommandLine.arguments
        let limit = args.firstIndex(of: "-threadLimit").flatMap { i in i + 1 < args.count ? Double(args[i + 1]) : nil } ?? 5
        let dir = URL(fileURLWithPath: outDir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let watch = MainThreadWatch(limit: limit) { stalled, step in
            let line = "[thread-check] FAIL main thread did not respond for \(String(format: "%.1f", stalled)) s (during: \(step))"
            print(line)
            fflush(stdout)
            try? Data((line + "\n").utf8).write(to: dir.appendingPathComponent("thread.json"))
            exit(1)
        }
        Task { @MainActor in
            var report: [String: Any] = ["replies": TimelineStore.demoLongThreadReplies, "limit_s": limit]
            let timeline = TimelineStore(api: APIClient(token: "demo"))
            timeline.debugLoadDemo()
            let pin = PinState()
            pin.windowVisible = true
            let host = NSHostingView(rootView: MainPanelView(store: store, timeline: timeline, pin: pin, onClose: {}, onSignOut: {}, initialTab: .timeline))
            host.sizingOptions = [] // as in the panel (ChatPanel)
            // -threadSize WxH: the panel's size (default 380×640; the narrowest panel is 300×320).
            let size = args.firstIndex(of: "-threadSize").flatMap { i -> [Double]? in
                guard i + 1 < args.count else { return nil }
                let p = args[i + 1].split(separator: "x").compactMap { Double($0) }
                return p.count == 2 ? p : nil
            } ?? [380, 640]
            let win = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: size[0], height: size[1]),
                               styleMask: [.borderless], backing: .buffered, defer: false)
            win.contentView = host
            win.orderFrontRegardless()
            store.isVisible = true
            report["size"] = "\(Int(size[0]))x\(Int(size[1]))"
            watch.start()
            try? await Task.sleep(for: .milliseconds(800))

            @MainActor func shot(_ name: String) {
                host.layoutSubtreeIfNeeded()
                guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return }
                host.cacheDisplay(in: host.bounds, to: rep)
                try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("thread-\(name).png"))
            }
            /// The tallest scroll view: the open thread (the timeline under it has a few posts).
            @MainActor func threadScroll() -> NSScrollView? {
                var all: [NSScrollView] = []
                func walk(_ v: NSView) { if let s = v as? NSScrollView { all.append(s) }; v.subviews.forEach(walk) }
                walk(host)
                return all.filter { !$0.isHidden && $0.alphaValue > 0 }.max { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
            }

            let t0 = Date()
            watch.step = "open thread"
            timeline.openThread = TimelineStore.demoLongThreadId
            // Opened when the thread's content is taller than many screens.
            var scroll: NSScrollView?
            while Date().timeIntervalSince(t0) < 10 {
                try? await Task.sleep(for: .milliseconds(50))
                if let s = threadScroll(), (s.documentView?.frame.height ?? 0) > 3000 { scroll = s; break }
            }
            report["open_ms"] = Int(Date().timeIntervalSince(t0) * 1000)
            guard let scroll, let doc = scroll.documentView else {
                print("[thread-check] FAIL the thread did not open")
                report["ok"] = false
                write(report, dir)
                exit(1)
            }
            let clip = scroll.contentView
            // The member scrolls at once, while the list may still be moving to the newest reply.
            watch.step = "scroll while opening"
            for _ in 0..<40 {
                var o = clip.bounds.origin
                o.y += doc.isFlipped ? -120 : 120
                clip.scroll(to: o)
                scroll.reflectScrolledClipView(clip)
                try? await Task.sleep(for: .milliseconds(16))
            }
            watch.step = "settle"
            try? await Task.sleep(for: .milliseconds(1200)) // unread replies on screen get read
            shot("opened")
            report["content_height"] = Int(doc.frame.height)

            // Scroll from where it is (the newest reply) to the top, a screen at a time, then
            // jump back to the bottom and to the middle (rows built and thrown away).
            @MainActor func scrollTo(_ y: CGFloat) async {
                let maxY = max(0, doc.frame.height - clip.bounds.height)
                let target = doc.isFlipped ? min(max(0, y), maxY) : maxY - min(max(0, y), maxY)
                clip.scroll(to: NSPoint(x: 0, y: target))
                scroll.reflectScrolledClipView(clip)
                try? await Task.sleep(for: .milliseconds(40))
            }
            let s0 = Date()
            var steps = 0
            watch.step = "scroll up"
            var y = doc.frame.height
            while y > 0 {
                y -= clip.bounds.height * 0.8
                await scrollTo(y)
                steps += 1
            }
            shot("top")
            watch.step = "jump to bottom"
            await scrollTo(.greatestFiniteMagnitude)
            try? await Task.sleep(for: .milliseconds(300))
            watch.step = "jump to middle"
            await scrollTo(doc.frame.height / 2)
            try? await Task.sleep(for: .milliseconds(300))
            watch.step = "scroll down"
            y = doc.frame.height / 2
            while y < doc.frame.height {
                y += clip.bounds.height * 0.8
                await scrollTo(y)
                steps += 1
            }
            report["scroll_steps"] = steps
            report["scroll_ms"] = Int(Date().timeIntervalSince(s0) * 1000)

            // Back to the timeline (the ‹ button / the mouse's back button), and open it again.
            watch.step = "close thread"
            NotificationCenter.default.post(name: .timelineBack, object: nil)
            try? await Task.sleep(for: .milliseconds(600))
            watch.step = "open thread again"
            timeline.openThread = TimelineStore.demoLongThreadId
            try? await Task.sleep(for: .milliseconds(1500))
            shot("reopened")
            // Opening shows the newest reply at the bottom (where it lands, not a failure by itself).
            if let s = threadScroll(), let d = s.documentView {
                let visible = s.contentView.bounds
                let bottomGap = d.isFlipped ? d.frame.height - visible.maxY : visible.minY
                report["reopened_bottom_gap"] = Int(bottomGap)
            }
            watch.step = "close thread again"
            NotificationCenter.default.post(name: .timelineBack, object: nil)
            try? await Task.sleep(for: .milliseconds(600))

            watch.stop()
            report["longest_stall_ms"] = Int(watch.longest * 1000)
            report["ok"] = true
            print("[thread-check] ok   \(TimelineStore.demoLongThreadReplies) replies: opened in \(report["open_ms"] ?? 0) ms, \(steps) scroll steps in \(report["scroll_ms"] ?? 0) ms, longest main-thread stall \(Int(watch.longest * 1000)) ms")
            write(report, dir)
            fflush(stdout)
            exit(0)
        }
    }

    private static func write(_ report: [String: Any], _ dir: URL) {
        let json = try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try? json?.write(to: dir.appendingPathComponent("thread.json"))
    }
}

#endif
