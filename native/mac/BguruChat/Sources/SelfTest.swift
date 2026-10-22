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
            timeline.debugFill(to: 30) // a full first page, as the server sends
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
            @MainActor func threadScroll(excluding: NSScrollView? = nil) -> NSScrollView? {
                var all: [NSScrollView] = []
                func walk(_ v: NSView) { if let s = v as? NSScrollView { all.append(s) }; v.subviews.forEach(walk) }
                walk(host)
                return all.filter { !$0.isHidden && $0.alphaValue > 0 && $0 !== excluding }
                    .max { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }
            }

            // 1) The minute's refresh while a thread is open (drikin 2026-10-22, 0.3.44: a thread with 4
            //    replies open, the timeline refreshed, and the panel spun at 99 % CPU for good). With the
            //    list at the top and scrolled down, a short and the long thread, 10 refreshes each.
            var refreshRounds = 0
            for (scrolled, thread) in [(false, 3), (true, 3), (true, TimelineStore.demoLongThreadId)] {
                NotificationCenter.default.post(name: .timelineBack, object: nil)
                try? await Task.sleep(for: .milliseconds(400))
                if let list = threadScroll(), let d = list.documentView {
                    let clip = list.contentView
                    let y: CGFloat = scrolled ? d.frame.height / 2 : 0
                    clip.scroll(to: NSPoint(x: 0, y: d.isFlipped ? y : max(0, d.frame.height - clip.bounds.height - y)))
                    list.reflectScrolledClipView(clip)
                }
                try? await Task.sleep(for: .milliseconds(400))
                watch.step = "open thread \(thread) (list \(scrolled ? "scrolled down" : "at the top"))"
                timeline.openThread = thread
                try? await Task.sleep(for: .milliseconds(1200))
                // What the member does in the thread around each refresh (a click there also makes the
                // app active, which refreshes the timeline): a picture, the reply box, a reaction.
                let actions = ["none", "image", "none", "closeImage", "focus", "type", "react", "clear", "image", "closeImage"]
                for r in 0..<10 {
                    let action = actions[r % actions.count]
                    watch.step = "refresh \(r) after \(action), thread \(thread) open (list \(scrolled ? "scrolled down" : "at the top"))"
                    NotificationCenter.default.post(name: .debugThreadAction, object: action)
                    try? await Task.sleep(for: .milliseconds(150))
                    timeline.debugRefresh(round: refreshRounds)
                    refreshRounds += 1
                    try? await Task.sleep(for: .milliseconds(600))
                }
                NotificationCenter.default.post(name: .debugThreadAction, object: "closeImage")
            }
            report["refreshes_with_thread_open"] = refreshRounds
            NotificationCenter.default.post(name: .timelineBack, object: nil)
            try? await Task.sleep(for: .milliseconds(400))
            if let list = threadScroll() { list.contentView.scroll(to: .zero); list.reflectScrolledClipView(list.contentView) }
            try? await Task.sleep(for: .milliseconds(800))
            shot("after-refreshes")

            // 2) A long thread: open, scroll, close, reopen.
            let timelineList = threadScroll() // the list under the thread (not the one to scroll)
            let t0 = Date()
            watch.step = "open thread"
            timeline.openThread = TimelineStore.demoLongThreadId
            // Opened when the thread's content is taller than many screens.
            var scroll: NSScrollView?
            while Date().timeIntervalSince(t0) < 10 {
                try? await Task.sleep(for: .milliseconds(50))
                if let s = threadScroll(excluding: timelineList), (s.documentView?.frame.height ?? 0) > 3000 { scroll = s; break }
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
            if let s = threadScroll(excluding: timelineList), let d = s.documentView {
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
            print("[thread-check] ok   \(refreshRounds) refreshes with a thread open; \(TimelineStore.demoLongThreadReplies) replies: opened in \(report["open_ms"] ?? 0) ms, \(steps) scroll steps in \(report["scroll_ms"] ?? 0) ms, longest main-thread stall \(Int(watch.longest * 1000)) ms")
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

// MARK: - Timeline like the web (docs: timeline parity, 2026-10-22)

extension SelfTest {
    /// `-selftest DIR -demo -timelineShots`: the sample posts for each display rule (long text
    /// folded and opened, pictures 1/2/3/5 tall and wide, video, sound, GIFs, many reactions,
    /// mentions) drawn as one long column at the panel's width, light and dark, and the panel
    /// itself on the timeline → DIR/parity-*.png. Offline.
    static func runTimelineShots(store: ChatStore, outDir: String) {
        Task { @MainActor in
            let dir = URL(fileURLWithPath: outDir)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let timeline = TimelineStore(api: APIClient(token: "demo"))
            timeline.debugLoadDemo()
            let posts = timeline.posts.filter { (101...111).contains($0.id) }
            @MainActor func render(_ name: String, dark: Bool, width: CGFloat, @ViewBuilder _ view: () -> some View) async {
                let host = NSHostingView(rootView: view().frame(width: width).background(Color(nsColor: .windowBackgroundColor)))
                let size = host.fittingSize
                let win = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: width, height: max(size.height, 100)),
                                   styleMask: [.borderless], backing: .buffered, defer: false)
                win.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                win.contentView = host
                win.orderFrontRegardless()
                try? await Task.sleep(for: .milliseconds(2500)) // pictures, the video's first frame, a GIF frame or two
                host.layoutSubtreeIfNeeded()
                if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                    host.cacheDisplay(in: host.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("parity-\(name).png"))
                    print("[parity] wrote parity-\(name).png \(Int(host.bounds.width))x\(Int(host.bounds.height))")
                }
                win.orderOut(nil)
            }
            @MainActor func column(_ ps: [Post]) -> some View {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(ps) { p in
                        PostRow(post: p, clubName: timeline.clubName(p.club), canReact: true, onReact: { _ in }, onOpenImage: { _ in })
                        Divider()
                    }
                }
            }
            for dark in [false, true] {
                let look = dark ? "dark" : "light"
                PostExpansion.set(101, open: false)
                await render("\(look)-posts", dark: dark, width: 380) { column(posts) }
                PostExpansion.set(101, open: true)
                await render("\(look)-expanded", dark: dark, width: 380) { column(posts.filter { $0.id == 101 }) }
                PostExpansion.set(101, open: false)
                // A wide panel: one picture stops at 360, the video at 560.
                await render("\(look)-wide", dark: dark, width: 720) { column(posts.filter { [102, 103, 106, 107].contains($0.id) }) }
                if let r = posts.first(where: { $0.id == 101 })?.reactions?.first(where: { $0.emoji == "❤️" }) {
                    await render("\(look)-reactors", dark: dark, width: 260) { ReactorsList(reaction: r) }
                    print("[parity] hover text: \(TimelineRules.reactorsText(r).replacingOccurrences(of: "\n", with: " / "))")
                }
                // The panel itself (lazy list) on the timeline.
                let pin = PinState()
                pin.windowVisible = true
                await render("\(look)-panel", dark: dark, width: 380) {
                    MainPanelView(store: store, timeline: timeline, pin: pin, onClose: {}, onSignOut: {}, initialTab: .timeline).frame(height: 720)
                }
            }
            print("[parity] order of reactions: \(TimelineRules.sortedReactions(posts[0]).map { "\($0.emoji)\($0.count)" }.joined(separator: " "))")
            print("[parity] folded length: \(TimelineRules.foldedText(posts[0])?.utf16.count ?? -1) of \(posts[0].text.utf16.count)")
            fflush(stdout)
            exit(0)
        }
    }

    /// `-selftest DIR -demo -timelineCheck [-demoPosts N]`: a long timeline (300 posts by
    /// default, a GIF in every tenth and a video in every fifteenth) in the real panel view,
    /// scrolled to the end a screen at a time, flung back to the top, and left still with GIFs
    /// on screen — the main thread must keep answering (5 s, as the thread check). Prints the
    /// longest stall and the app's CPU while GIFs move; writes DIR/timeline.json.
    static func runTimelineCheck(store: ChatStore, outDir: String) {
        let dir = URL(fileURLWithPath: outDir)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let watch = MainThreadWatch(limit: 5) { stalled, step in
            print("[timeline-check] FAIL main thread did not respond for \(String(format: "%.1f", stalled)) s (during: \(step))")
            fflush(stdout)
            exit(1)
        }
        Task { @MainActor in
            let timeline = TimelineStore(api: APIClient(token: "demo"))
            timeline.debugLoadDemo()
            if timeline.posts.count < 100 { timeline.debugFill(to: 300) }
            let pin = PinState()
            pin.windowVisible = true
            let host = NSHostingView(rootView: MainPanelView(store: store, timeline: timeline, pin: pin, onClose: {}, onSignOut: {}, initialTab: .timeline))
            host.sizingOptions = []
            let win = NSWindow(contentRect: NSRect(x: -4000, y: -4000, width: 380, height: 640), styleMask: [.borderless], backing: .buffered, defer: false)
            win.contentView = host
            win.orderFrontRegardless()
            store.isVisible = true
            watch.start()
            try? await Task.sleep(for: .milliseconds(1000))
            var all: [NSScrollView] = []
            func walk(_ v: NSView) { if let s = v as? NSScrollView { all.append(s) }; v.subviews.forEach(walk) }
            walk(host)
            guard let scroll = all.max(by: { ($0.documentView?.frame.height ?? 0) < ($1.documentView?.frame.height ?? 0) }),
                  let doc = scroll.documentView else { print("[timeline-check] FAIL no list"); exit(1) }
            let clip = scroll.contentView
            func to(_ y: CGFloat) {
                let maxY = max(0, doc.frame.height - clip.bounds.height)
                let c = min(max(0, y), maxY)
                clip.scroll(to: NSPoint(x: 0, y: doc.isFlipped ? c : maxY - c))
                scroll.reflectScrolledClipView(clip)
            }
            func at() -> CGFloat { doc.isFlipped ? clip.bounds.minY : max(0, doc.frame.height - clip.bounds.height) - clip.bounds.minY }
            let t0 = Date()
            var steps = 0
            watch.step = "scroll down a screen at a time"
            var last: CGFloat = -1
            while steps == 0 || (at() > last + 1 && steps < 3000) {
                last = at()
                to(last + clip.bounds.height * 0.8)
                steps += 1
                try? await Task.sleep(for: .milliseconds(40))
            }
            let downMs = Int(Date().timeIntervalSince(t0) * 1000)
            watch.step = "fling to the top"
            var y = at()
            while y > 0 {
                y -= clip.bounds.height * 3
                to(y)
                try? await Task.sleep(for: .milliseconds(16))
            }
            // Still, with the sample GIFs on screen: what moving GIFs cost.
            watch.step = "still with GIFs on screen"
            y = 0
            while GIFPlayer.moving == 0, y < doc.frame.height {
                y += clip.bounds.height * 0.5
                to(y)
                try? await Task.sleep(for: .milliseconds(300))
            }
            try? await Task.sleep(for: .milliseconds(1200))
            let movingOnScreen = GIFPlayer.moving
            func cpu() -> Double { var u = rusage(); getrusage(RUSAGE_SELF, &u); return Double(u.ru_utime.tv_sec + u.ru_stime.tv_sec) + Double(u.ru_utime.tv_usec + u.ru_stime.tv_usec) / 1e6 }
            let c0 = cpu(), w0 = Date()
            try? await Task.sleep(for: .seconds(6))
            let gifCPU = (cpu() - c0) / Date().timeIntervalSince(w0) * 100
            // And the same, scrolled where no GIF is in view (GIFs off screen must stop).
            y = 0
            to(0)
            try? await Task.sleep(for: .milliseconds(600))
            while GIFPlayer.moving > 0, y < doc.frame.height {
                y += clip.bounds.height * 0.5
                to(y)
                try? await Task.sleep(for: .milliseconds(300))
            }
            try? await Task.sleep(for: .milliseconds(1200))
            let movingOff = GIFPlayer.moving
            let c1 = cpu(), w1 = Date()
            try? await Task.sleep(for: .seconds(6))
            let idleCPU = (cpu() - c1) / Date().timeIntervalSince(w1) * 100
            watch.stop()
            let report: [String: Any] = ["posts": timeline.posts.count, "steps": steps, "scroll_down_ms": downMs,
                                         "longest_stall_ms": Int(watch.longest * 1000), "content_height": Int(doc.frame.height),
                                         "cpu_gifs_on_screen_pct": Int(gifCPU * 10) / 10, "cpu_no_gif_on_screen_pct": Int(idleCPU * 10) / 10,
                                         "gifs_moving_on_screen": movingOnScreen, "gifs_moving_when_none_shown": movingOff]
            try? JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys]).write(to: dir.appendingPathComponent("timeline.json"))
            print("[timeline-check] ok   \(timeline.posts.count) posts, \(steps) steps down in \(downMs) ms, longest main-thread stall \(Int(watch.longest * 1000)) ms, CPU with \(movingOnScreen) GIF(s) moving \(String(format: "%.1f", gifCPU)) %, with none on screen (\(movingOff) moving) \(String(format: "%.1f", idleCPU)) %")
            fflush(stdout)
            exit(0)
        }
    }
}

extension SelfTest {
    /// `-timelineFixtures DIR`: DIR holds copies of src/lib/__tests__/fixtures/timeline/posts.json and
    /// expected.json (docs/timeline-spec.md §9). For each example: the app's own display rules
    /// (TimelineRules.computed, used when a server sends no `display`) must give exactly the
    /// expected `display`; and with the expected `display` added, the folded body must end at
    /// `fold_at` and each mention range must cover its "@name". Exit 0 = all match.
    static func runTimelineFixtures(dir: String) {
        Task { @MainActor in
            let d = URL(fileURLWithPath: dir)
            let dec = JSONDecoder()
            dec.keyDecodingStrategy = .convertFromSnakeCase
            struct Ctx: Decodable { var memberNames: [String]; var clubs: [String: String] }
            struct Posts: Decodable { var context: Ctx; var posts: [Post] }
            struct Expected: Decodable { var displays: [String: PostDisplayHints] }
            guard let pd = try? Data(contentsOf: d.appendingPathComponent("posts.json")),
                  let ed = try? Data(contentsOf: d.appendingPathComponent("expected.json")) else { print("[fixtures] FAIL cannot read"); exit(1) }
            let posts: Posts, expected: Expected
            do { posts = try dec.decode(Posts.self, from: pd); expected = try dec.decode(Expected.self, from: ed) }
            catch { print("[fixtures] FAIL decode: \(error)"); exit(1) }
            var fails = 0
            for p in posts.posts {
                guard let want = expected.displays[String(p.id)] else { continue }
                let got = TimelineRules.computed(p, memberNames: posts.context.memberNames, clubName: { posts.context.clubs[$0] })
                if got != want {
                    fails += 1
                    print("[fixtures] FAIL \(p.id) computed ≠ expected\n  got  \(got)\n  want \(want)")
                }
                var q = p
                q.display = want
                let folded = TimelineRules.foldedText(q)
                if folded?.utf16.count != want.foldAt {
                    fails += 1; print("[fixtures] FAIL \(p.id) folded \(folded?.utf16.count ?? -1) ≠ fold_at \(want.foldAt ?? -1)")
                }
                if TimelineRules.sortedReactions(q).map(\.emoji) != (want.reactionsOrder ?? []) {
                    fails += 1; print("[fixtures] FAIL \(p.id) reaction order")
                }
                let u = Array(p.text.utf16)
                for m in want.mentionRanges ?? [] {
                    let s = String(decoding: u[m.start..<m.end], as: UTF16.self)
                    if s != "@\(m.name)" && s != "@[\(m.name)]" { fails += 1; print("[fixtures] FAIL \(p.id) mention \(m.start)-\(m.end) = \(s)") }
                }
                print("[fixtures] \(fails == 0 ? "ok  " : "…   ") \(p.id)")
            }
            // A display the app cannot read drops only the display; fold points out of range are brought inside.
            let broken = #"{"posts":[{"id":1,"text":"a","created_at":"x","display":{"fold":"yes","mention_ranges":[1,2]}},{"id":2,"text":"b","created_at":"x"}]}"#
            if let l = try? dec.decode(PostListResponse.self, from: Data(broken.utf8)), l.posts.count == 2, l.posts[0].display == nil {
                print("[fixtures] ok   an unreadable display is dropped, the list stays")
            } else { fails += 1; print("[fixtures] FAIL an unreadable display broke the list") }
            // 段階 3: the example with a poll reads its poll; a poll the app cannot read drops only the poll;
            // the stage-3 fields (bookmarked_by_me / favorite_by_me / pinned_at) decode.
            if let p = posts.posts.first(where: { $0.poll != nil }), p.poll?.options.count == 3, p.poll?.totalVotes == 3 {
                print("[fixtures] ok   poll \(p.id) decoded (\(p.poll?.options.map(\.label).joined(separator: "/") ?? ""))")
            } else { fails += 1; print("[fixtures] FAIL the example's poll did not decode") }
            let stage3 = #"{"posts":[{"id":1,"text":"a","created_at":"x","poll":{"options":"?"},"bookmarked_by_me":true,"favorite_by_me":true,"pinned_at":"2026-10-22T00:00:00Z"},{"id":2,"text":"b","created_at":"x"}]}"#
            if let l = try? dec.decode(PostListResponse.self, from: Data(stage3.utf8)), l.posts.count == 2, l.posts[0].poll == nil,
               l.posts[0].bookmarkedByMe == true, l.posts[0].favoriteByMe == true, l.posts[0].pinnedAt != nil {
                print("[fixtures] ok   an unreadable poll is dropped; bookmarked_by_me / favorite_by_me / pinned_at read")
            } else { fails += 1; print("[fixtures] FAIL stage-3 fields") }
            if var p = posts.posts.first(where: { $0.text.utf16.count > 500 }) {
                let n = p.text.utf16.count
                p.display = PostDisplayHints(fold: true, foldAt: -5)
                let a = TimelineRules.foldedText(p)  // nothing before the fold: not folded
                p.display = PostDisplayHints(fold: true, foldAt: n + 100)
                let b = TimelineRules.foldedText(p)
                if a == nil && b == nil { print("[fixtures] ok   fold_at out of range is clamped") }
                else { fails += 1; print("[fixtures] FAIL fold_at clamp \(a?.utf16.count ?? -1) \(b?.utf16.count ?? -1)") }
            }
            print(fails == 0 ? "[fixtures] ok   \(posts.posts.count) examples match" : "[fixtures] FAIL \(fails) differences")
            fflush(stdout)
            exit(fails == 0 ? 0 : 1)
        }
    }
}

extension SelfTest {
    /// `-selftest DIR -demo -actionShots`: the timeline's operations (段階 3, docs/timeline-spec.md §10)
    /// drawn offline, light and dark → DIR/actions-*.png: posts with a poll / pin / 🔖 / ☆ / club tag,
    /// the hover buttons, edit (full and text-only), delete (and its error), the poll's answers, a new
    /// post with a poll, a sound and a club, the emoji picker, the pinned / favourites lists (and an
    /// empty one), the toast, a thread's reply bar with うなる / 吠える and @mention suggestions.
    static func runActionShots(store: ChatStore, outDir: String) {
        Task { @MainActor in
            let dir = URL(fileURLWithPath: outDir)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let timeline = TimelineStore(api: APIClient(token: "demo"))
            timeline.debugLoadDemo()
            let actions = timeline.actions
            actions.features = store.capabilities?.features?.posts
            actions.loadMembers()
            actions.loadEmojis()
            try? await Task.sleep(for: .milliseconds(600))
            @MainActor func render(_ name: String, dark: Bool, width: CGFloat, height: CGFloat? = nil, @ViewBuilder _ view: () -> some View) async {
                let root = view()
                    .environment(\.postActions, actions)
                    .environment(\.postClubs, timeline.clubList)
                    .frame(width: width, height: height)
                    .background(Color(nsColor: .windowBackgroundColor))
                let host = NSHostingView(rootView: root)
                let size = host.fittingSize
                let win = NSWindow(contentRect: NSRect(x: -6000, y: -6000, width: width, height: max(height ?? size.height, 100)),
                                   styleMask: [.borderless], backing: .buffered, defer: false)
                win.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
                win.contentView = host
                win.orderFrontRegardless()
                try? await Task.sleep(for: .milliseconds(1500))
                host.layoutSubtreeIfNeeded()
                if let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) {
                    host.cacheDisplay(in: host.bounds, to: rep)
                    try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("actions-\(name).png"))
                    print("[actions] wrote actions-\(name).png \(Int(host.bounds.width))x\(Int(host.bounds.height))")
                }
                win.orderOut(nil)
            }
            func dialog(@ViewBuilder _ v: () -> some View) -> some View {
                v().background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12)).padding(14)
            }
            let ids = [120, 121, 122, 3]
            let posts = ids.compactMap { id in timeline.posts.first { $0.id == id } }
            let full = actions.features
            for dark in [false, true] {
                let look = dark ? "dark" : "light"
                await render("\(look)-posts", dark: dark, width: 400) {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(posts) { p in
                            PostRow(post: p, clubName: p.display?.clubLabel ?? timeline.clubName(p.club), canReact: true, onReact: { _ in }, onOpenImage: { _ in })
                            Divider()
                        }
                    }
                }
                if let p = posts.first {
                    await render("\(look)-hover", dark: dark, width: 400) {
                        PostRow(post: p, clubName: timeline.clubName(p.club), canReact: true, onReact: { _ in }, onOpenImage: { _ in })
                            .environment(\.debugForceHover, true)
                    }
                }
                if let p = timeline.posts.first(where: { $0.id == 122 }) {
                    await render("\(look)-edit", dark: dark, width: 400) { dialog { EditPostDialog(post: p, actions: actions) } }
                    actions.features?.edit = false
                    actions.features?.editTextOnly = true
                    await render("\(look)-edit-textonly", dark: dark, width: 400) { dialog { EditPostDialog(post: p, actions: actions) } }
                    actions.features = full
                }
                if let p = posts.first {
                    await render("\(look)-delete", dark: dark, width: 400) { dialog { DeletePostDialog(post: p, actions: actions) } }
                    await render("\(look)-delete-error", dark: dark, width: 400) {
                        dialog { DeletePostDialog(post: p, actions: actions, debugError: "少し時間をおいてから試してください") }
                    }
                    await render("\(look)-polledit", dark: dark, width: 400) { dialog { PollEditDialog(post: p, actions: actions) } }
                }
                let draft = PostDraft(maxImages: 5)
                draft.text = "次の配信で話してほしいのはどれ？ @ta"
                var poll = PollDraft()
                poll.options = ["新しい MacBook", "カメラの話", ""]
                poll.hours = 6
                draft.poll = poll
                draft.media = PickedMedia(kind: .audio, file: URL(fileURLWithPath: TimelineDemoMedia.audio.replacingOccurrences(of: "file://", with: "")))
                draft.club = "camera"
                await render("\(look)-compose", dark: dark, width: 420, height: 700) {
                    ComposeSheet(api: timeline.api, maxImages: 5, actions: actions, clubs: timeline.clubList, debugDraft: draft)
                }
                await render("\(look)-picker", dark: dark, width: 290) { ReactionPicker { _ in } }
                await render("\(look)-pins", dark: dark, width: 400, height: 520) {
                    PostListDialog(kind: .pinned, timeline: timeline, capabilities: store.capabilities)
                }
                await render("\(look)-favorites", dark: dark, width: 400, height: 520) {
                    PostListDialog(kind: .favorites, timeline: timeline, capabilities: store.capabilities)
                }
                let empty = TimelineStore(api: APIClient(token: "demo"))
                DemoPostServer.shared.timeline = empty
                await render("\(look)-pins-empty", dark: dark, width: 400, height: 260) {
                    PostListDialog(kind: .pinned, timeline: empty, capabilities: store.capabilities)
                }
                DemoPostServer.shared.timeline = timeline
                await render("\(look)-toast", dark: dark, width: 400, height: 90) {
                    ActionToastView(toast: ActionToast(text: "ブックマークに保存しました（タップで取り消し）", undo: {})) {}
                }
                await render("\(look)-thread", dark: dark, width: 400, height: 560) {
                    ThreadScreen(id: 120, timeline: timeline, capabilities: store.capabilities, onReconnect: {})
                        .onAppear {
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                                NotificationCenter.default.post(name: .debugThreadAction, object: "mention")
                            }
                        }
                }
            }
            fflush(stdout)
            exit(0)
        }
    }
}

extension SelfTest {
    /// `BGURU_DEV_BASE_URL=http://127.0.0.1:PORT BGURU_DEV_TOKEN=… BGURU_DEV_TOKEN2=… "B-guru Chat" -apiCheck`:
    /// every timeline operation (段階 3) through the app's own client against a LOCAL dev server
    /// (refuses any other host): two members (TOKEN = me, TOKEN2 = someone else). Exit 0 = all ok.
    static func runAPICheck(token: String) {
        Task { @MainActor in
            guard let host = APIClient.baseURL.host, ["127.0.0.1", "localhost"].contains(host) else {
                print("[api] FAIL refusing: BGURU_DEV_BASE_URL must be a local server (\(APIClient.baseURL))"); exit(2)
            }
            guard let token2 = ProcessInfo.processInfo.environment["BGURU_DEV_TOKEN2"] else { print("[api] FAIL no BGURU_DEV_TOKEN2"); exit(2) }
            let me = APIClient(token: token), other = APIClient(token: token2)
            var fails = 0
            func check(_ ok: Bool, _ what: String) { print("[api] \(ok ? "ok  " : "FAIL") \(what)"); if !ok { fails += 1 } }
            @MainActor func attempt<T>(_ what: String, _ f: @MainActor () async throws -> T) async -> T? {
                do { return try await f() } catch { check(false, "\(what): \(error)"); return nil }
            }
            let caps = await attempt("capabilities") { try await me.capabilities() }
            let f = caps?.features?.posts
            check(f?.edit == true && f?.delete == true && f?.pin == true && f?.poll == true && f?.whisper == true && f?.clubChange == true,
                  "capabilities.features.posts has the operations")
            let timeline = TimelineStore(api: me)
            let actions = timeline.actions
            actions.features = f
            let members = await attempt("members") { try await me.members() } ?? []
            check(members.count >= 0, "members (\(members.count))")
            let clubs = await attempt("clubs") { try await me.clubs() } ?? []
            check(!clubs.isEmpty, "clubs (\(clubs.count))")
            let emojis = await attempt("emojis") { try await me.customEmojis(path: f?.customEmojiList ?? "") } ?? []
            check(emojis.contains { $0.name == "beagle" }, "custom emojis (\(emojis.map(\.name)))")

            // 📊 someone's poll; I vote and change my vote; they edit the answers.
            let pollPost = await attempt("publish poll") {
                try await other.publish(PublishBody(text: "API チェックの投票？", poll: .init(question: "API チェックの投票？", options: ["A", "B", "C"], durationHours: 1)))
            }
            check(pollPost?.poll?.options.count == 3 && pollPost?.poll?.editable == true, "publish with a poll → poll decoded, editable")
            if let p = pollPost, let o = p.poll?.options {
                let v1 = await attempt("vote") { try await me.vote(postId: p.id, optionId: o[0].id) }
                check(v1?.myVote == o[0].id && v1?.totalVotes == 1, "vote → my_vote, 1 vote")
                let v2 = await attempt("change vote") { try await me.vote(postId: p.id, optionId: o[1].id) }
                check(v2?.myVote == o[1].id && v2?.totalVotes == 1, "change the vote → still 1 vote")
                do {
                    _ = try await other.editPoll(postId: p.id, options: [(o[0].id, "A"), (o[2].id, "C"), (nil, "D")])
                    check(false, "removing a voted answer must fail")
                } catch { check(PostActionsModel.message(error, fallback: "?") != "?", "removing a voted answer fails: \(PostActionsModel.message(error, fallback: "?"))") }
                var asOther = p
                asOther.isAuthor = true
                let otherActions = PostActionsModel(api: other)
                let e = await otherActions.savePoll(asOther, options: [(o[0].id, "A2"), (o[1].id, "B"), (o[2].id, "C"), (nil, "D")])
                check(e == nil, "edit the answers (rename, add) \(e ?? "")")
                do { _ = try await me.editPoll(postId: p.id, options: [(o[0].id, "x"), (o[1].id, "y"), (o[2].id, "z")]); check(false, "someone else's poll must not be editable") }
                catch { check(true, "someone else's poll cannot be edited: \(PostActionsModel.message(error, fallback: "?"))") }
            }

            // My post: a picture and a club chosen by hand.
            let jpeg: Data? = {
                guard let ctx = CGContext(data: nil, width: 64, height: 48, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                          bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
                ctx.setFillColor(CGColor(red: 0.2, green: 0.6, blue: 0.3, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
                let out = NSMutableData()
                guard let img = ctx.makeImage(), let d = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
                CGImageDestinationAddImage(d, img, nil); CGImageDestinationFinalize(d); return out as Data
            }()
            let urls = await attempt("upload image") { try await me.upload(images: [jpeg ?? Data(), jpeg ?? Data()]) } ?? []
            check(urls.count == 2, "upload 2 pictures")
            let club = clubs.first?.key
            let mine = await attempt("publish with club") { try await me.publish(PublishBody(text: "API チェック @ほかの人", images: urls, club: club)) }
            check(mine?.club == club && mine?.clubManual == true, "publish with a club chosen by hand → club \(mine?.club ?? "nil"), manual")

            // A sound (WAV) and a video (mp4), each uploaded and attached.
            let wav = FileManager.default.temporaryDirectory.appendingPathComponent("apicheck.wav")
            var w = Data("RIFF".utf8); let n = 8000
            func le32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(v).littleEndian) { Data($0) } }
            func le16(_ v: Int) -> Data { withUnsafeBytes(of: UInt16(v).littleEndian) { Data($0) } }
            for part in [le32(36 + n), Data("WAVEfmt ".utf8), le32(16), le16(1), le16(1), le32(8000), le32(8000), le16(1), le16(8),
                         Data("data".utf8), le32(n)] { w.append(part) }
            w += Data(repeating: 128, count: n)
            try? w.write(to: wav)
            let audioURL = await attempt("upload audio") { try await me.uploadMedia(file: wav, kind: .audio) }
            check(audioURL?.hasPrefix("/api/media/") == true, "upload a sound → \(audioURL ?? "nil")")
            let videoFile = URL(string: TimelineDemoMedia.video)!
            let videoURL = await attempt("upload video") { try await me.uploadMedia(file: videoFile, kind: .video) }
            check(videoURL?.hasPrefix("/api/media/") == true, "upload a video → \(videoURL ?? "nil")")
            let vpost = await attempt("publish video") { try await me.publish(PublishBody(text: "動画つき", videoUrl: videoURL)) }
            check(vpost?.videoUrl == videoURL, "publish with the video")
            do { _ = try await me.publish(PublishBody(text: "両方", videoUrl: videoURL, audioUrl: audioURL)); check(false, "video + sound must fail") }
            catch { check(true, "video + sound refused: \(PostActionsModel.message(error, fallback: "?"))") }

            // ✏️ edit: text, pictures reordered and one removed, the sound attached.
            if let p = mine, let a = audioURL {
                let e = await actions.saveEdit(p, text: "API チェック（編集）", images: [urls[1]], audio: .some(a))
                check(e == nil, "edit text + pictures + sound \(e ?? "")")
                let t = await attempt("thread") { try await me.thread(id: p.id) }
                check(t?.post.text == "API チェック（編集）" && t?.post.images == [urls[1]] && t?.post.audioUrl == a, "the edit is stored")
                let e2 = await actions.saveEdit(p, text: "API チェック（音声を外す）", images: nil, audio: .some(nil))
                let t2 = await attempt("thread") { try await me.thread(id: p.id) }
                check(e2 == nil && t2?.post.audioUrl == nil && t2?.post.images == [urls[1]], "take the sound off (pictures kept)")
                if let v = vpost {
                    let e3 = await actions.saveEdit(v, text: "動画に音声", images: nil, audio: .some(a))
                    check(e3 != nil, "a sound on a video post is refused: \(e3 ?? "")")
                }
            }

            // 📌 pin: one per member, list.
            if let p = mine, let v = vpost {
                let on = await attempt("pin") { try await me.togglePin(id: p.id) }
                check(on == true, "pin")
                _ = await attempt("pin 2") { try await me.togglePin(id: v.id) }
                let pins = await attempt("pinned list") { try await me.postList(.pinned) }
                check(pins?.posts.map(\.id).contains(v.id) == true && pins?.posts.map(\.id).contains(p.id) == false, "one pin per member (pinned=1 → \(pins?.posts.map(\.id) ?? []))")
                check(pins?.posts.first?.pinnedAt != nil, "pinned_at on the pinned post")
                let off = await attempt("unpin") { try await me.togglePin(id: v.id) }
                check(off == false, "unpin")
                if let pp = pollPost {
                    do { _ = try await me.togglePin(id: pp.id); check(false, "pinning someone's post must fail") }
                    catch { check(true, "someone's post cannot be pinned: \(PostActionsModel.message(error, fallback: "?"))") }
                }
            }

            // 🔖 / ☆
            if let pp = pollPost {
                let b = await attempt("bookmark") { try await me.toggleBookmark(postId: pp.id) }
                let bl = await attempt("bm list") { try await me.postList(.bookmarks) }
                check(b == true && bl?.posts.first { $0.id == pp.id }?.bookmarkedByMe == true, "bookmark → in bm=1, bookmarked_by_me")
                let b2 = await attempt("unbookmark") { try await me.toggleBookmark(postId: pp.id) }
                check(b2 == false, "unbookmark")
                if let author = pp.authorId {
                    _ = await attempt("favorite") { try await me.setFavorite(userId: author, on: true) }
                    let fl = await attempt("fav list") { try await me.postList(.favorites) }
                    check(fl?.posts.contains { $0.id == pp.id && $0.favoriteByMe == true } == true, "☆ → fav=1 has their post, favorite_by_me")
                    _ = await attempt("unfavorite") { try await me.setFavorite(userId: author, on: false) }
                    let fl2 = await attempt("fav list 2") { try await me.postList(.favorites) }
                    check(fl2?.posts.isEmpty == true, "☆ off → fav=1 empty")
                }
                if let mid = mine?.authorId {
                    do { try await me.setFavorite(userId: mid, on: true); check(false, "favouriting myself must fail") }
                    catch { check(true, "favouriting myself refused: \(PostActionsModel.message(error, fallback: "?"))") }
                }
            }

            // 部活の付け替え
            if let p = mine, clubs.count > 1 {
                let r1: Void? = await attempt("set club") { try await me.setClub(id: p.id, club: clubs[1].key) }
                let t = await attempt("thread") { try await me.thread(id: p.id) }
                check(r1 != nil && t?.post.club == clubs[1].key, "change the club → \(clubs[1].key)")
                let r2: Void? = await attempt("no club") { try await me.setClub(id: p.id, club: nil) }
                let t2 = await attempt("thread") { try await me.thread(id: p.id) }
                check(r2 != nil && t2?.post.club == nil, "ラベルなし → club nil")
            }

            // うなる: a reply that does not lift the thread.
            if let pp = pollPost, let v = vpost {
                let before = await attempt("list") { try await me.posts() }
                let topBefore = before?.posts.first?.id
                let w = await attempt("whisper") { try await me.publish(PublishBody(text: "うなる返信", parentId: pp.id, whisper: true)) }
                let after = await attempt("list") { try await me.posts() }
                check(w?.parentId == pp.id && after?.posts.first?.id == topBefore, "うなる: reply stored, the list's order unchanged (top \(topBefore ?? -1) / \(v.id))")
                let r = await attempt("reaction") { try await me.togglePostReaction(id: pp.id, emoji: ":beagle:") }
                check(r?.added == true, "custom emoji reaction :beagle:")
            }

            // 🗑 delete: someone's fails, mine works.
            if let pp = pollPost, let v = vpost {
                do { try await me.deletePost(id: pp.id); check(false, "deleting someone's post must fail") }
                catch { check(true, "someone's post cannot be deleted: \(PostActionsModel.message(error, fallback: "?"))") }
                let e = await actions.delete(v)
                let gone: ThreadResponse? = try? await me.thread(id: v.id)
                check(e == nil && gone == nil, "delete my post → gone")
            }
            print(fails == 0 ? "[api] ok   all operations" : "[api] FAIL \(fails)")
            fflush(stdout)
            exit(fails == 0 ? 0 : 1)
        }
    }
}

#endif
