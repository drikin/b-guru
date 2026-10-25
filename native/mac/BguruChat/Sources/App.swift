import AppKit
import SwiftUI
import UserNotifications

@main
struct BguruChatApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    var body: some Scene {
        Settings { EmptyView() } // menu-bar app: no main window scene
    }
}

/// Owns the menu bar item, the chat panel, the global hotkey and notifications.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate, UNUserNotificationCenterDelegate {
    private var statusItem: NSStatusItem!
    private var panel: ChatPanel?
    private var loginWindow: NSWindow?
    private var store: ChatStore?
    private var timeline: TimelineStore?
    private var hotKey: HotKey?
    private var observeTask: Task<Void, Never>?
    private let settings = AppSettings.shared
    /// The bundled "new messages" notification: how many it covers and the
    /// first message to jump to when it is clicked.
    private var bundledCount = 0
    private var bundledFirstId: Int?
    /// 試験的：ほかのステータスバーアイコンを畳む（設定でオンにした人だけ）。
    private var collapser: StatusBarCollapser?
    /// メニューバーのティッカー（設定でオンにした人だけ）。
    private var ticker: StatusTicker?
    /// 📺 the player's own window.
    private var watchWindow: WatchWindow?
    /// 新着でビーグルが吠える（絵の差し替え）。
    private var barker: BeagleBarker?
    /// 負荷に合わせてビーグルが走る。
    private var runner: BeagleRunner?
    /// 端末内 AI のタイムラインのおすすめ。
    private let aiPicks = AIPicks()
    /// ビーグルの右の未読の数（ティッカーが流しているあいだはティッカーがタイトルを持つ）。
    private var countTitle = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        HangWatch.shared.start()
        #if DEBUG
        // Dev only: BGURU_HANG_TEST=秒 — 3 秒後にメインスレッドをその秒数ふさぐ（HangWatch の確かめ）。
        if let v = ProcessInfo.processInfo.environment["BGURU_HANG_TEST"], let secs = Double(v) {
            DispatchQueue.main.asyncAfter(deadline: .now() + 3) { Thread.sleep(forTimeInterval: secs) }
        }
        #endif
        TextComposition.watchReturnKey()
        #if DEBUG
        // Dev only: -assistantSelfTest runs the assistant's filter / addressee tests and exits (1 on failure).
        if CommandLine.arguments.contains("-assistantSelfTest") { exit(Assistant.selfTest() ? 0 : 1) }
        // Dev only: -beagleAsk Q1 Q2 … — 🐶 Beagle's on-device answers to these questions, with the demo
        // chat and timeline as knowledge, printed to stderr (to compare prompt changes; nothing is sent).
        if let i = CommandLine.arguments.firstIndex(of: "-beagleAsk") {
            let questions = Array(CommandLine.arguments[(i + 1)...]).filter { !$0.hasPrefix("-") }
            let store = ChatStore(api: APIClient(token: "demo"))
            store.debugLoadDemo()
            let timeline = TimelineStore(api: APIClient(token: "demo"))
            timeline.debugLoadDemo()
            let chat = store.rows.map { BeagleOnDevice.Note(name: $0.message.authorName ?? "?", text: $0.message.body) }
            let posts = timeline.beagleNotes()
            Task {
                FileHandle.standardError.write("[beagle] available=\(BeagleOnDevice.isAvailable)\n".data(using: .utf8)!)
                for q in questions {
                    let a = await BeagleOnDevice.answer(question: "@ビーグル " + q, asker: "ドリキン", chat: chat, posts: posts)
                    FileHandle.standardError.write("Q: \(q)\nA: \(a ?? "(nil)")\n\n".data(using: .utf8)!)
                }
                exit(0)
            }
            return
        }
        // Dev only: show in the Dock so UI automation can find the app.
        if CommandLine.arguments.contains("-regular") { NSApp.setActivationPolicy(.regular) }
        #endif
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let button = statusItem.button {
            button.target = self
            button.action = #selector(statusItemClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }
        setupBarker()
        updateStatusIcon(unread: 0, mentions: 0, connection: .connecting)
        if !CommandLine.arguments.contains("-selftest") { setupCollapser(); setupTicker(); setupAIPicks(); setupAssistant() }
        settings.onDockChange = { [weak self] _ in self?.applyDockSetting() }
        applyDockSetting()

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let reply = UNTextInputNotificationAction(identifier: "reply", title: "返信", options: [],
                                                  textInputButtonTitle: "送信", textInputPlaceholder: "メッセージ")
        let heart = UNNotificationAction(identifier: "heart", title: "❤️", options: [])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "mention", actions: [reply, heart], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "newmsg", actions: [reply], intentIdentifiers: [], options: []),
        ])

        hotKey = HotKey(keyCode: 11 /* B */, modifiers: [.control, .option]) { [weak self] in
            self?.togglePanel(toChat: true) // ⌃⌥B: the chat with the caret in the message box
        }

        #if DEBUG
        // Dev only: -timelineFixtures DIR — the display rules against the shared examples.
        // (scripts/timeline-fixtures.sh copies the repository's examples to the default place first.)
        if let i = CommandLine.arguments.firstIndex(of: "-timelineFixtures") {
            let a = CommandLine.arguments
            let dir = i + 1 < a.count && !a[i + 1].hasPrefix("-") ? a[i + 1]
                : (NSTemporaryDirectory() as NSString).appendingPathComponent("timeline-fixtures")
            SelfTest.runTimelineFixtures(dir: dir)
            return
        }
        // Dev only: offline demo data → screenshot (no token, no network).
        if let i = CommandLine.arguments.firstIndex(of: "-selftest"), i + 1 < CommandLine.arguments.count,
           CommandLine.arguments.contains("-demo") {
            let store = ChatStore(api: APIClient(token: "demo"))
            store.debugLoadDemo()
            // -orientation: every screen drawn and read for upside-down text; exit 1 if any is.
            if CommandLine.arguments.contains("-orientation") {
                SelfTest.runOrientation(store: store, outDir: CommandLine.arguments[i + 1])
                return
            }
            // -timelineShots / -timelineCheck: the web-like timeline's samples, and a long list's scrolling.
            if CommandLine.arguments.contains("-timelineShots") {
                SelfTest.runTimelineShots(store: store, outDir: CommandLine.arguments[i + 1])
                return
            }
            if CommandLine.arguments.contains("-actionShots") {
                SelfTest.runActionShots(store: store, outDir: CommandLine.arguments[i + 1])
                return
            }
            if CommandLine.arguments.contains("-timelineCheck") {
                SelfTest.runTimelineCheck(store: store, outDir: CommandLine.arguments[i + 1])
                return
            }
            // -threadCheck: open a thread with many replies, scroll it, close it; exit 1 if the app stops responding.
            if CommandLine.arguments.contains("-threadCheck") {
                SelfTest.runThreadCheck(store: store, outDir: CommandLine.arguments[i + 1])
                return
            }
            SelfTest.run(store: store, outDir: CommandLine.arguments[i + 1], send: false)
            return
        }
        // Dev only: -demoPanel opens the real panel with sample data (no token, no network).
        if CommandLine.arguments.contains("-demoPanel") {
            let store = ChatStore(api: APIClient(token: "demo"))
            store.debugLoadDemo()
            store.debugOffline = true // sends "succeed" (there is no server)
            // -demoRoom: the club room with sample members (offline).
            if CommandLine.arguments.contains("-demoRoom") {
                store.room.debugLoadDemo()
                if CommandLine.arguments.contains("-demoRoomEnter") { Task { await store.room.enter() } }
            }
            // -demoJukebox: the jukebox with sample records; the sound is a test tone from
            // BGURU_DEMO_AUDIO (default http://127.0.0.1:8097), never the real feed.
            if CommandLine.arguments.contains("-demoJukebox") {
                store.jukebox.debugLoadDemo(base: ProcessInfo.processInfo.environment["BGURU_DEMO_AUDIO"] ?? "http://127.0.0.1:8097")
            }
            let timeline = TimelineStore(api: APIClient(token: "demo"))
            timeline.debugLoadDemo()
            store.beagleTimeline = { [weak timeline] in timeline?.beagleNotes() ?? [] }
            self.store = store
            self.timeline = timeline
            panel = ChatPanel(store: store, timeline: timeline, onSignOut: {})
            wireAIPicks(timeline)
            if CommandLine.arguments.contains("-aiPicksNow") { startAIPicksDemo(timeline) }
            if CommandLine.arguments.contains("-tickerTest") {
                // -tickerTest: the panel stays closed; debug commands feed the ticker (offline).
                wireTicker(store)
                observeStore()
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                self.showPanel()
                // -demoTimelineTab: open on the timeline (UI checks).
                // -demoSendTest: my long messages and others' arriving in turn (the list must follow).
                if CommandLine.arguments.contains("-demoSendTest") {
                    store.debugOffline = true
                    for i in 0..<6 {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2 + Double(i) * 1.5) {
                            if i % 2 == 0 {
                                store.send("送信テスト \(i)：長めの文章を送ったときに一番下まで追従するかを確かめるための投稿です。改行もなく続く文章で、行が折り返して高さが変わります。", restore: { _ in })
                            } else {
                                store.debugReceive("ほかの人の発言 \(i)", id: 900 + i)
                            }
                        }
                    }
                }
                // -demoQuote: 「チャットに引用」 of the first timeline post (as if chosen from its menu).
                if CommandLine.arguments.contains("-demoQuote"), let post = timeline.posts.dropFirst().first {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                        store.quoteAction { self.panel?.pin.tab = .chat }?(post)
                    }
                }
                // -demoNeta: 「ネタ帳に送る」 of the first post with a link (offline: sending does nothing).
                if CommandLine.arguments.contains("-demoNeta"), let post = timeline.posts.first(where: { $0.urlPreview != nil }) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
                        self.panel?.pin.tab = .timeline
                        store.netaPost = post
                    }
                }
                // -demoOpenPostLink: as if a post's link in the chat were clicked.
                if CommandLine.arguments.contains("-demoOpenPostLink"), let post = timeline.posts.first(where: { $0.urlPreview != nil }) {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                        let url = URL(string: "https://bsm.backspace.fm/#/post/\(post.id)")!
                        _ = ChatStore.openPostLinks(in: timeline).callAsFunction(url)
                    }
                }
                if CommandLine.arguments.contains("-demoJukeboxTab") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.panel?.pin.tab = .jukebox }
                }
                if CommandLine.arguments.contains("-demoJukeboxPlay"), let e = store.jukebox.todayEpisode {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { store.jukebox.play(e) }
                }
                // -demoShogi: the ☗ 将棋 lobby; -demoShogiGame: my game (my move); -demoShogiWatch: a game to watch.
                if CommandLine.arguments.contains("-demoShogi") { store.shogi.show() }
                // -demoMinigame: 🎮 open (answered locally, nothing is sent).
                if CommandLine.arguments.contains("-demoMinigame") { store.minigame.show() }
                // -demoOffkai: 🍻 open (a sample event going on; -demoOffkaiIdle: only the archive). Nothing is sent.
                if CommandLine.arguments.contains("-demoOffkai") || CommandLine.arguments.contains("-demoOffkaiIdle") { store.offkai.show() }
                if CommandLine.arguments.contains("-demoShogiGame") { store.shogi.openGame(101) }
                if CommandLine.arguments.contains("-demoShogiWatch") { store.shogi.openGame(101) }
                // -orientationTour: walk through every screen for the upside-down check
                // (native/mac/scripts/orientation-tour.sh takes a picture at each step).
                if CommandLine.arguments.contains("-orientationTour") { self.runOrientationTour(store: store) }
                // -panelMemoryCheck PHASE: size / place / tab remembered across opens and launches.
                if let i = CommandLine.arguments.firstIndex(of: "-panelMemoryCheck"), i + 1 < CommandLine.arguments.count {
                    self.runPanelMemoryCheck(phase: CommandLine.arguments[i + 1], store: store)
                }
                if CommandLine.arguments.contains("-demoTimelineTab") {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.panel?.pin.tab = .timeline }
                }
                // -demoOpenThread [ID]: the timeline with a thread open (default the long demo thread, -demoReplies N replies).
                if let i = CommandLine.arguments.firstIndex(of: "-demoOpenThread") {
                    let id = i + 1 < CommandLine.arguments.count ? Int(CommandLine.arguments[i + 1]) : nil
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.0) {
                        self.panel?.pin.tab = .timeline
                        timeline.openThread = id ?? TimelineStore.demoLongThreadId
                    }
                }
                // -demoActivateEvery S: the app loses and regains focus every S seconds (a click elsewhere and back).
                if let i = CommandLine.arguments.firstIndex(of: "-demoActivateEvery"), i + 1 < CommandLine.arguments.count,
                   let every = Double(CommandLine.arguments[i + 1]) {
                    var on = true
                    Timer.scheduledTimer(withTimeInterval: every, repeats: true) { _ in
                        MainActor.assumeIsolated {
                            on.toggle()
                            HangWatch.note("demo \(on ? "activate" : "deactivate")")
                            if on { NSApp.activate(ignoringOtherApps: true); self.showPanel() } else { NSApp.deactivate() }
                        }
                    }
                }
                // -demoSplit [W]: pinned and W wide (default 1000): the timeline and the chat side by side.
                if let i = CommandLine.arguments.firstIndex(of: "-demoSplit") {
                    let w = i + 1 < CommandLine.arguments.count ? Double(CommandLine.arguments[i + 1]) ?? 1000 : 1000
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        guard let panel = self.panel else { return }
                        panel.pin.pinned = true
                        panel.setContentSize(NSSize(width: w, height: 760))
                    }
                }
                // -demoKeyScroll: Space, Space, J, K, ⇧Space pressed on the panel; prints where the timeline is.
                if CommandLine.arguments.contains("-demoKeyScroll") {
                    // First a click on the timeline (left side): the message box lets go of the caret.
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
                        guard let panel = self.panel else { return }
                        NSLog("[keyscroll] before click: %@", panel.firstResponder.map { "\(type(of: $0)) editable=\(($0 as? NSTextView)?.isEditable ?? false)" } ?? "nil")
                        for t in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
                            if let e = NSEvent.mouseEvent(with: t, location: NSPoint(x: 200, y: 712), modifierFlags: [], timestamp: 0,
                                                          windowNumber: panel.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) {
                                panel.sendEvent(e)
                            }
                        }
                        NSLog("[keyscroll] after click: %@", panel.firstResponder.map { "\(type(of: $0)) editable=\(($0 as? NSTextView)?.isEditable ?? false)" } ?? "nil")
                    }
                    let keys: [(UInt16, String, NSEvent.ModifierFlags)] = [(49, " ", []), (49, " ", []), (38, "j", []), (40, "k", []), (49, " ", .shift)]
                    for (n, key) in keys.enumerated() {
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5 + Double(n) * 0.6) {
                            guard let panel = self.panel, let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: key.2,
                                timestamp: 0, windowNumber: panel.windowNumber, context: nil, characters: key.1,
                                charactersIgnoringModifiers: key.1, isARepeat: false, keyCode: key.0) else { return }
                            panel.sendEvent(e)
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) {
                                NSLog("[keyscroll] %@ y=%d", key.1 == " " ? (key.2.isEmpty ? "space" : "shift-space") : key.1, Int(KeyScroll.current?.contentView.bounds.origin.y ?? -1))
                            }
                        }
                    }
                }
                // -demoToggleEvery S: the panel closes and opens again every S seconds (the menu bar icon).
                if let i = CommandLine.arguments.firstIndex(of: "-demoToggleEvery"), i + 1 < CommandLine.arguments.count,
                   let every = Double(CommandLine.arguments[i + 1]) {
                    Timer.scheduledTimer(withTimeInterval: every, repeats: true) { _ in
                        MainActor.assumeIsolated {
                            guard let panel = self.panel else { return }
                            if panel.isVisible && !panel.isDismissing { panel.dismiss() } else { self.showPanel() }
                        }
                    }
                }
                // -demoRefreshEvery S: the minute's refresh, every S seconds, with changes (TimelineStore.debugRefresh).
                if let i = CommandLine.arguments.firstIndex(of: "-demoRefreshEvery"), i + 1 < CommandLine.arguments.count,
                   let every = Double(CommandLine.arguments[i + 1]) {
                    var round = 0
                    Timer.scheduledTimer(withTimeInterval: every, repeats: true) { _ in
                        MainActor.assumeIsolated {
                            HangWatch.note("demo refresh \(round)")
                            timeline.debugRefresh(round: round)
                            round += 1
                        }
                    }
                }
            }
            return
        }
        // Dev only: BGURU_DEV_TOKEN=bga_… runs against a token without touching the Keychain.
        if let dev = ProcessInfo.processInfo.environment["BGURU_DEV_TOKEN"], !dev.isEmpty {
            if CommandLine.arguments.contains("-apiCheck") { SelfTest.runAPICheck(token: dev); return }
            startSession(token: dev)
            let args = CommandLine.arguments
            if let i = args.firstIndex(of: "-selftest"), i + 1 < args.count, let store {
                SelfTest.run(store: store, outDir: args[i + 1], send: args.contains("-selftest-send"))
                return
            }
            if CommandLine.arguments.contains("-showPanel") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.showPanel() }
            }
            if CommandLine.arguments.contains("-notifyTest") {
                // Fake 3 new messages + 1 mention, then log what the notification centre holds.
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) { self.runNotifyTest() }
            }
            if CommandLine.arguments.contains("-reopenTest") {
                // open → toggle (close) → toggle (open) → focus lost right before a toggle (must stay closed)
                let state = { (tag: String) in
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) {
                        NSLog("[toggle] %@ visible=%d", tag, (self.panel?.isVisible ?? false) ? 1 : 0)
                    }
                }
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.togglePanel(); state("close") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.togglePanel(); state("open") }
                DispatchQueue.main.asyncAfter(deadline: .now() + 3.5) {
                    self.panel?.resignKey() // what a click on the menu bar icon can do first
                    self.togglePanel()
                    state("race-close")
                }
            }
            return
        }
        #endif
        if let token = Keychain.load() {
            startSession(token: token)
            #if DEBUG
            // Dev only: open the panel at once (checking the real timeline without the menu bar).
            if CommandLine.arguments.contains("-showPanel") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { self.showPanel() }
            }
            #endif
        } else {
            showLogin()
        }
    }

    // MARK: - Session

    private func startSession(token: String) {
        let api = APIClient(token: token)
        let store = ChatStore(api: api)
        let timeline = TimelineStore(api: api)
        self.timeline = timeline
        store.beagleTimeline = { [weak timeline] in timeline?.beagleNotes() ?? [] }
        wireAIPicks(timeline)
        MediaCache.shared.token = token
        store.onMention = { [weak self] m in self?.notifyMention(m) }
        store.onNewMessage = { [weak self] m in self?.notifyNewMessage(m) }
        wireTicker(store)
        store.onPostCreated = { [weak self] in self?.timelinePostCreated() }
        store.onBecameVisible = { [weak self] in
            self?.clearBundledNotification()
            self?.ticker?.stop(clear: true) // チャットを見ているときは流さない
        }
        store.shogi.onOffer = { [weak self] g in self?.notifyShogi(g, offer: true) }
        store.shogi.onMyTurn = { [weak self] g in self?.notifyShogi(g, offer: false) }
        store.dm.onIncoming = { [weak self] m, peer in self?.notifyDM(m, peer: peer) }
        // 📺 the player's own window (⧉): follows the mode.
        let watchWindow = WatchWindow(watch: store.watch)
        self.watchWindow = watchWindow
        store.watch.onModeChange = { [weak watchWindow] mode in watchWindow?.update(mode) }
        self.store = store
        store.start()
        Updater.shared.start(token: token)
        panel = ChatPanel(store: store, timeline: timeline, onSignOut: { [weak self] in self?.signOut() })
        observeStore()
        #if DEBUG
        // Dev only, on the real account (with BGURU_NO_READ=1 nothing is marked read):
        // BGURU_DEBUG_SPLIT_THREAD=ID[,W] pins the panel W wide (default 1168), side by side, and opens thread ID.
        if let v = ProcessInfo.processInfo.environment["BGURU_DEBUG_SPLIT_THREAD"] {
            let parts = v.split(separator: ",").compactMap { Double($0) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 2) {
                guard let panel = self.panel, let id = parts.first else { return }
                self.showPanel(toChat: true)
                panel.pin.pinned = true
                panel.setContentSize(NSSize(width: parts.count > 1 ? parts[1] : 1168, height: 906))
                DispatchQueue.main.asyncAfter(deadline: .now() + 3) {
                    HangWatch.note("debug open thread \(Int(id))")
                    self.timeline?.openThread = Int(id)
                }
            }
        }
        #endif
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    /// Re-render the menu bar icon whenever unread / connection / sign-out changes.
    private func observeStore() {
        guard let store else { return }
        withObservationTracking {
            _ = store.unreadCount
            _ = store.mentionCount
            _ = store.connection
            _ = store.signedOut
            _ = store.capabilities
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, let store = self.store else { return }
                self.updateStatusIcon(unread: store.unreadCount, mentions: store.mentionCount, connection: store.connection)
                self.applyAssistant() // capabilities（features.mac_assistant）が届いたら
                if store.signedOut { self.signOut(revoke: false) } else { self.observeStore() }
            }
        }
        updateStatusIcon(unread: store.unreadCount, mentions: store.mentionCount, connection: store.connection)
    }

    private func signOut(revoke: Bool = true) {
        let token = store?.token
        store?.stop()
        panel?.close()
        panel = nil
        store = nil
        timeline = nil
        MediaCache.shared.token = nil
        Keychain.delete()
        Updater.shared.stop()
        if revoke, let token { Task { await APIClient(token: token).revokeSelf() } }
        updateStatusIcon(unread: 0, mentions: 0, connection: .offline)
        showLogin()
    }

    private func showLogin() {
        if let w = loginWindow { w.makeKeyAndOrderFront(nil); NSApp.activate(); return }
        let view = LoginView { [weak self] token in
            guard let self else { return }
            Keychain.save(token)
            self.loginWindow?.close()
            self.loginWindow = nil
            self.startSession(token: token)
            self.showPanel()
        }
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 480, height: 640),
                         styleMask: [.titled, .closable], backing: .buffered, defer: false)
        w.title = "B-guru にログイン"
        w.contentView = NSHostingView(rootView: view)
        w.center()
        w.isReleasedWhenClosed = false
        loginWindow = w
        w.makeKeyAndOrderFront(nil)
        NSApp.activate()
    }

    // MARK: - Menu bar

    @objc private func statusItemClicked() {
        // 畳む機能がオンのとき：⌥＋クリックで出し入れ。
        // （⌘＋クリックは macOS 27 ではアプリに届かない：⌘ を押してステータスアイコンを押すと、システムが並べ替えに使う。
        //  また macOS 27 のステータスアイテムのクリックは修飾キーの消えたイベントで届くので、今押しているキーは NSEvent.modifierFlags で見る。2026-10-21 実機）
        if let collapser, collapser.isEnabled, let ev = NSApp.currentEvent, ev.type == .leftMouseUp,
           ev.modifierFlags.contains(.option) || NSEvent.modifierFlags.contains(.option) {
            collapser.toggle(via: "⌥クリック")
            return
        }
        #if DEBUG
        NSLog("[collapse] ビーグルの action: type=%d mouse=%@ ticker=%d", Int(NSApp.currentEvent?.type.rawValue ?? 0),
              NSStringFromPoint(NSEvent.mouseLocation), ticker?.mouseOverTicker() == true ? 1 : 0)
        #endif
        // ティッカーの部分（ビーグルの左に広げた所）のクリック：チャットを開いてその発言へ。
        if let ticker, NSApp.currentEvent?.type == .leftMouseUp, ticker.mouseOverTicker() {
            ticker.clicked()
            return
        }
        if NSApp.currentEvent?.type == .rightMouseUp {
            showMenu()
        } else {
            togglePanel()
        }
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "チャットを開く  ⌃⌥B", action: #selector(openPanelAction), keyEquivalent: "").target = self
        menu.addItem(withTitle: "B-guru をブラウザで開く", action: #selector(openWeb), keyEquivalent: "").target = self
        let update = NSMenuItem(title: "アップデートを確認…", action: #selector(checkUpdates), keyEquivalent: "")
        update.target = self
        update.isEnabled = Updater.shared.canCheck
        menu.addItem(update)
        let collapse = NSMenuItem(title: "試験的：ほかのステータスバーアイコンを畳む", action: #selector(toggleCollapseSetting), keyEquivalent: "")
        collapse.target = self
        collapse.state = settings.collapseStatusItems ? .on : .off
        menu.addItem(collapse)
        if settings.collapseStatusItems {
            let hover = NSMenuItem(title: "カーソルを乗せたら出す", action: #selector(toggleCollapseHover), keyEquivalent: "")
            hover.target = self
            hover.indentationLevel = 1
            hover.state = settings.collapseRevealOnHover ? .on : .off
            menu.addItem(hover)
        }
        let bark = NSMenuItem(title: "新着でビーグルが吠える", action: #selector(toggleBark), keyEquivalent: "")
        bark.target = self
        bark.state = settings.menuBarBark ? .on : .off
        menu.addItem(bark)
        let run = NSMenuItem(title: "負荷に合わせてビーグルが走る", action: #selector(toggleRunner), keyEquivalent: "")
        run.target = self
        run.state = settings.menuBarRunner ? .on : .off
        menu.addItem(run)
        if settings.menuBarRunner {
            let gpu = NSMenuItem(title: "GPU の負荷も見る", action: #selector(toggleRunnerGPU), keyEquivalent: "")
            gpu.target = self
            gpu.indentationLevel = 1
            gpu.state = settings.menuBarRunnerGPU ? .on : .off
            menu.addItem(gpu)
        }
        let tick = NSMenuItem(title: "メニューバーにティッカーを流す", action: #selector(toggleTicker), keyEquivalent: "")
        tick.target = self
        tick.state = settings.menuBarTicker ? .on : .off
        menu.addItem(tick)
        if settings.menuBarTicker {
            let names = NSMenuItem(title: "名前だけ（本文を出さない）", action: #selector(toggleTickerNames), keyEquivalent: "")
            names.target = self
            names.indentationLevel = 1
            names.state = settings.menuBarTickerNamesOnly ? .on : .off
            menu.addItem(names)
        }
        let aiState = AIPicks.availability()
        let ai = NSMenuItem(title: "AI がタイムラインのおすすめを教える（この Mac の中だけで動きます）", action: #selector(toggleAIPicks), keyEquivalent: "")
        ai.target = self
        ai.state = settings.aiTimelinePicks ? .on : .off
        ai.isEnabled = aiState.ok || settings.aiTimelinePicks
        menu.addItem(ai)
        if let reason = aiState.reason {
            let r = NSMenuItem(title: reason, action: nil, keyEquivalent: "")
            r.isEnabled = false
            r.indentationLevel = 1
            menu.addItem(r)
        }
        addAssistantMenu(to: menu)
        let ver = NSMenuItem(title: "バージョン \(Updater.shared.currentVersion)（ベータ）", action: nil, keyEquivalent: "")
        ver.isEnabled = false
        menu.addItem(ver)
        menu.addItem(.separator())
        if store != nil {
            menu.addItem(withTitle: "ログアウト", action: #selector(signOutAction), keyEquivalent: "").target = self
        }
        menu.addItem(withTitle: "終了", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func openPanelAction() { showPanel(toChat: true) }
    @objc private func toggleCollapseSetting() { settings.collapseStatusItems.toggle() }
    @objc private func toggleCollapseHover() { settings.collapseRevealOnHover.toggle() }
    @objc private func toggleTicker() { settings.menuBarTicker.toggle() }
    @objc private func toggleBark() { settings.menuBarBark.toggle() }
    @objc private func toggleRunner() { settings.menuBarRunner.toggle() }
    @objc private func toggleRunnerGPU() { settings.menuBarRunnerGPU.toggle() }
    @objc private func toggleAIPicks() { settings.aiTimelinePicks.toggle() }
    @objc private func toggleTickerNames() { settings.menuBarTickerNamesOnly.toggle() }
    @objc private func signOutAction() { signOut() }
    @objc private func checkUpdates() { Updater.shared.checkNow() }
    @objc private func openWeb() { NSWorkspace.shared.open(APIClient.baseURL) }

    /// Menu bar click and ⌃⌥B both toggle: if the chat is in front, put it
    /// away; otherwise bring it to the front with the caret in the message box.
    /// (A pinned panel sitting behind your work is brought forward, not closed.)
    /// `toChat`: ⌃⌥B (and 「チャットを開く」) open the chat with the caret in the message box;
    /// a click on the icon opens the tab the panel was left on (PanelMemory).
    private func togglePanel(toChat: Bool = false) {
        guard let panel else { showLogin(); return }
        if panel.isFrontForToggle {
            if !panel.isDismissing { panel.dismiss() }
        } else {
            showPanel(toChat: toChat)
        }
    }

    private func showPanel(toChat: Bool = false) {
        guard let panel, let button = statusItem.button, let win = button.window else { return }
        let r = win.convertToScreen(button.convert(button.bounds, to: nil))
        panel.present(below: r, toChat: toChat)
    }

    private func updateStatusIcon(unread: Int, mentions: Int, connection: ChatStore.Connection) {
        guard let button = statusItem?.button else { return }
        // Posture tells the state, not colour (template image stays monochrome):
        // sitting = nothing new, filled = new messages, "@" = someone called you.
        // 左向きのビーグル（BeagleIcon）。吠えている途中なら、終わったときにこの状態の絵に戻る。
        barker?.filled = unread > 0
        if runner?.drawsIcon == true {
            runner?.render() // 走る機能がオンのあいだは、絵はレイヤーで描く
        } else if barker?.isBarking != true {
            button.image = BeagleIcon.image(filled: unread > 0)
        }
        let n = min(unread, 99)
        countTitle = unread == 0 ? "" : (mentions > 0 ? " @\(n)" : " \(n)")
        if let ticker, ticker.isShowing {
            ticker.setCount(countTitle)
        } else {
            button.attributedTitle = BeagleIcon.countTitle(countTitle)
            button.imagePosition = .imageLeading
        }
        button.appearsDisabled = connection == .offline
        if runner?.drawsIcon == true { runner?.render() } // 淡色（接続していない）もレイヤーの絵に
        let state = connection == .offline ? "、オフライン" : ""
        let detail = mentions > 0 ? "、うちメンション \(mentions) 件" : ""
        button.setAccessibilityLabel(unread > 0 ? "B-guru チャット、未読 \(unread) 件\(detail)\(state)" : "B-guru チャット\(state)")
        collapser?.beagleChanged()
        if settings.showInDock {
            NSApp.dockTile.badgeLabel = unread > 0 ? (mentions > 0 ? "@\(n)" : "\(n)") : nil
        }
    }

    /// Menu-bar only by default; optionally also a Dock icon with an unread badge.
    private func applyDockSetting() {
        #if DEBUG
        if CommandLine.arguments.contains("-regular") { return }
        #endif
        if settings.showInDock {
            NSApp.setActivationPolicy(.regular)
            if let icon = NSImage(named: "AppIcon") { NSApp.applicationIconImage = icon }
            let unread = store?.unreadCount ?? 0
            let n = min(unread, 99)
            NSApp.dockTile.badgeLabel = unread > 0 ? ((store?.mentionCount ?? 0) > 0 ? "@\(n)" : "\(n)") : nil
        } else {
            NSApp.dockTile.badgeLabel = nil
            NSApp.setActivationPolicy(.accessory)
        }
    }

    // MARK: - ほかのステータスバーアイコンを畳む（試験的）

    private func setupCollapser() {
        let c = StatusBarCollapser(beagle: statusItem)
        collapser = c
        settings.onCollapseChange = { [weak self] on in self?.applyCollapseSetting(on, userAction: true) }
        c.revealOnHover = settings.collapseRevealOnHover
        settings.onCollapseHoverChange = { [weak self] on in
            self?.collapser?.revealOnHover = on
            StatusBarDiag.note("カーソルを乗せたら出す: \(on ? "オン" : "オフ")")
        }
        if settings.collapseStatusItems { applyCollapseSetting(true, userAction: false) }
        #if DEBUG
        if CommandLine.arguments.contains("-collapseTest") || CommandLine.arguments.contains("-tickerTest")
            || CommandLine.arguments.contains("-assistantTest") {
            StatusBarDiag.forced = true
            StatusBarDiag.enabled = true
            startDebugCommands()
        }
        if CommandLine.arguments.contains("-collapseTest") { startCollapseTest() }
        #endif
    }

    private func applyCollapseSetting(_ on: Bool, userAction: Bool) {
        guard let collapser else { return }
        if !on {
            StatusBarDiag.note("設定をオフにした")
            collapser.disable()
            StatusBarDiag.update(collapse: false, ticker: settings.menuBarTicker)
            return
        }
        StatusBarDiag.update(collapse: true, ticker: settings.menuBarTicker)
        StatusBarDiag.note("設定をオン（macOS \(ProcessInfo.processInfo.operatingSystemVersionString)）")
        let firstTime = !UserDefaults.standard.bool(forKey: "collapseHintShown")
        // 初めてオンにしたときは出した状態で説明を出す（区切りが見えるように）。
        collapser.enable(collapse: !(userAction && firstTime))
        if userAction && firstTime {
            UserDefaults.standard.set(true, forKey: "collapseHintShown")
            DispatchQueue.main.async { self.showCollapseHint() }
        }
    }

    private func showCollapseHint() {
        let alert = NSAlert()
        alert.messageText = "ほかのステータスバーアイコンを畳む（試験的）"
        alert.informativeText = "ビーグルの左に区切り（‹）を置きました。隠したいアイコンを ⌘ を押しながら区切りの左へドラッグしてください。\n\n"
            + "ビーグルにカーソルを乗せて少し止める（⋯ メニューで切れます）か、ビーグルを ⌥（option）＋クリック、または区切り（‹）のクリックで出し入れします。出したあと 10 秒たつか、"
            + "メニューバーからマウスを離すとまた畳みます。畳んだアイコンは macOS の « からも開けます。\n\n"
            + "macOS の仕様にない動きに頼る試験的な機能です。将来の macOS で効かなくなることがあります（そのときは何も隠れないだけです）。"
            + "オフにすると区切りを消して元に戻します。"
        alert.addButton(withTitle: "OK")
        NSApp.activate()
        alert.runModal()
        if collapser?.isEnabled == true { collapser?.expand() } // 読み終えてから 10 秒を数え直す
    }

    func applicationWillTerminate(_ notification: Notification) {
        collapser?.disable() // 区切りを残さない
    }

    // MARK: - 新着でビーグルが吠える

    private func setupBarker() {
        let b = BeagleBarker(item: statusItem)
        b.enabled = settings.menuBarBark
        b.blockedReason = { [weak self] in
            guard let self else { return "終了中" }
            if self.store?.isVisible == true { return "チャットを見ている" }
            var quiet = self.settings.isQuietNow()
            #if DEBUG
            if CommandLine.arguments.contains("-tickerTest") { quiet = false } // 開発のみ：夜中でも試せるように
            #endif
            return quiet ? "静かな時間" : nil
        }
        settings.onBarkChange = { [weak self] on in
            self?.barker?.enabled = on
            if !on { self?.barker?.stop() }
            StatusBarDiag.note("新着でビーグルが吠える: \(on ? "オン" : "オフ")")
        }
        barker = b
        let r = BeagleRunner(item: statusItem, barker: b)
        runner = r
        settings.onRunnerChange = { [weak self] on in
            guard let self else { return }
            self.runner?.useGPU = self.settings.menuBarRunnerGPU
            self.runner?.enabled = on
            StatusBarDiag.note("負荷に合わせてビーグルが走る: \(on ? "オン" : "オフ")\(self.settings.menuBarRunnerGPU ? "（GPU も見る）" : "（CPU だけ）")")
        }
        r.useGPU = settings.menuBarRunnerGPU
        if !CommandLine.arguments.contains("-selftest") { r.enabled = settings.menuBarRunner }
    }

    // MARK: - 端末内 AI のおすすめ

    // MARK: - アシスタント（試験的）

    /// アシスタントのメニュー項目を出してよいか（サーバーの capabilities `features.mac_assistant` が true のときだけ。古いサーバー・false では出さない）。
    private var assistantAllowed: Bool {
        #if DEBUG
        if CommandLine.arguments.contains("-assistantTest") { return true }
        #endif
        return store?.capabilities?.macAssistantEnabled == true
    }
    /// 静かな時間に出せなかった知らせ（明けたら最新の 3 件だけ出す）。
    private var assistantHeld: [Assistant.Notice] = []
    private var assistantHoldTimer: Timer?
    #if DEBUG
    private var debugQuiet = false
    #endif

    private var assistantQuiet: Bool {
        #if DEBUG
        if debugQuiet { return true }
        if CommandLine.arguments.contains("-assistantTest") { return false }
        #endif
        return settings.isQuietNow()
    }

    private func setupAssistant() {
        let a = Assistant.shared
        a.blockedReason = { [weak self] in (self?.settings.isQuietNow() ?? false) ? "静かな時間" : nil }
        a.ownerNames = { [weak self] in
            var names = [NSFullUserName(), NSUserName()]
            if let me = self?.store?.lastOwnMessage?.authorName { names.insert(me, at: 0) }
            return names.filter { !$0.isEmpty }
        }
        a.deliver = { [weak self] notice in self?.deliverAssistant(notice) }
        settings.onAssistantChange = { [weak self] in
            self?.applyAssistant()
            // 記録は実際に動いているかで（開発の -assistantTest は設定がオフのまま動くので、設定の値だと「オフ（一時停止）」になる）
            StatusBarDiag.note("アシスタント: \(Assistant.shared.enabled ? "オン" : "オフ")\(self?.settings.assistantPaused == true ? "（一時停止）" : "")")
        }
        #if DEBUG
        if CommandLine.arguments.contains("-assistantTest") {
            // 開発のみ：自分のテスト用の窓だけを見張る。ほかのアプリの中身は読まない。
            a.testOwnWindowsOnly = true
            // 通しの試験では件数の上限を切る（同じ知らせの 30 分の見送りは残す）
            let n = CommandLine.arguments.firstIndex(of: "-assistantTestWindows").flatMap { i in i + 1 < CommandLine.arguments.count ? Int(CommandLine.arguments[i + 1]) : nil } ?? 3
            AssistantTestWindows.shared.show(count: n)
        }
        #endif
        // 静かな時間が明けたら、保留した知らせの最新 3 件を出す
        assistantHoldTimer = Timer.scheduledTimer(withTimeInterval: 30, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated {
                guard let self else { return }
                self.flushHeldAssistant()
                // 端末内 AI が後から使えるようになったら（準備中 → 使える）、再起動を待たずにオンにする
                if self.settings.assistant, !Assistant.shared.enabled { self.applyAssistant() }
            }
        }
        assistantHoldTimer?.tolerance = 10 // 静かな時間の明けが数秒ずれてよい（起きる回数を寄せられる）
        applyAssistant()
    }

    private func applyAssistant() {
        let a = Assistant.shared
        a.paused = settings.assistantPaused
        a.autoFront = settings.assistantAutoFront
        a.interest = settings.assistantInterest.isEmpty ? Assistant.defaultInterest : settings.assistantInterest
        a.excluded = settings.assistantExcluded
        var on = settings.assistant && Assistant.availability().ok && assistantAllowed
        #if DEBUG
        if CommandLine.arguments.contains("-assistantTest") { on = (settings.assistant || !debugAssistantOff) && Assistant.availability().ok }
        #endif
        a.enabled = on
        // 設定がオフなら、AI が使えない Mac でも必ず記録を消す
        if !settings.assistant {
            #if DEBUG
            if CommandLine.arguments.contains("-assistantTest") && !debugAssistantOff { return }
            #endif
            a.eraseMemory()
        } else if store?.capabilities != nil, !assistantAllowed {
            // サーバー側で対象から外した（capabilities が届いて false）：設定は残し、記録は消す
            a.eraseMemory()
        }
    }
    #if DEBUG
    private var debugAssistantOff = false
    #endif

    /// 知らせを届ける：パネルが見えていればヘッダーに 1 行、見えていなければティッカー、静かな時間は保留。
    private func deliverAssistant(_ n: Assistant.Notice) {
        if assistantQuiet {
            assistantHeld.append(n)
            if assistantHeld.count > 3 { assistantHeld.removeFirst(assistantHeld.count - 3) }
            StatusBarDiag.note("アシスタント: 静かな時間なので保留（\(assistantHeld.count) 件）")
            return
        }
        let text = Assistant.shared.tickerText(n, namesOnly: settings.menuBarTickerNamesOnly)
        if store?.isVisible == true {
            AssistantBanner.shared.current = n
            AssistantBanner.shared.text = text
            barker?.bark(.assistant)
            StatusBarDiag.note("アシスタント: パネルのヘッダーに出した")
        } else {
            ticker?.enqueue(assistant: text) { Assistant.shared.bringToFront(n) }
        }
    }

    private func flushHeldAssistant() {
        guard !assistantHeld.isEmpty, !assistantQuiet else { return }
        let held = assistantHeld.suffix(3)
        assistantHeld.removeAll()
        StatusBarDiag.note("アシスタント: 保留していた \(held.count) 件を出す")
        for n in held { deliverAssistant(n) }
    }

    @objc private func toggleAssistant() {
        if settings.assistant { AssistantUI.disable(settings) } else { AssistantUI.enable(settings) }
    }
    @objc private func toggleAssistantAuto() { settings.assistantAutoFront.toggle() }
    @objc private func toggleAssistantPause() { settings.assistantPaused.toggle() }
    @objc private func assistantWrong(_ sender: NSMenuItem) { Assistant.shared.markWrong(sender.representedObject as? UUID) }
    @objc private func assistantRight(_ sender: NSMenuItem) { Assistant.shared.markRight(sender.representedObject as? UUID) }
    @objc private func assistantMuteApp(_ sender: NSMenuItem) { muteAssistantApp(sender.representedObject as? UUID) }
    /// 最近の知らせのアプリを除外リストに入れる（1 クリック。「除外するアプリ…」で外せる）。
    private func muteAssistantApp(_ id: UUID?) {
        let a = Assistant.shared
        guard let n = id.flatMap({ id in a.recent.first { $0.id == id } }) ?? a.recent.first else { return }
        let key = n.bundleID.isEmpty ? n.app : n.bundleID
        if !settings.assistantExcluded.contains(key) { settings.assistantExcluded.append(key) }
        a.forgetRecent(app: n.app)
        StatusBarDiag.note("アシスタント: このアプリは知らせない（\(n.app)）")
    }
    @objc private func editAssistantInterest() { AssistantUI.editInterest(settings) }
    @objc private func editAssistantExcluded() { AssistantUI.editExcluded(settings) }

    private func addAssistantMenu(to menu: NSMenu) {
        guard assistantAllowed else { return }
        let avail = Assistant.availability()
        let item = NSMenuItem(title: "アシスタント：ウインドウの変化を知らせる（試験的）", action: #selector(toggleAssistant), keyEquivalent: "")
        item.target = self
        item.state = settings.assistant ? .on : .off
        item.isEnabled = avail.ok || settings.assistant
        menu.addItem(item)
        if let reason = avail.reason {
            let r = NSMenuItem(title: reason, action: nil, keyEquivalent: "")
            r.isEnabled = false
            r.indentationLevel = 1
            menu.addItem(r)
            return
        }
        guard settings.assistant else { return }
        let sub = NSMenu()
        func add(_ title: String, _ action: Selector?, state: Bool? = nil, object: Any? = nil, indent: Int = 0) {
            let i = NSMenuItem(title: title, action: action, keyEquivalent: "")
            i.target = self
            i.representedObject = object
            i.indentationLevel = indent
            if let state { i.state = state ? .on : .off }
            if action == nil { i.isEnabled = false }
            sub.addItem(i)
        }
        let a = Assistant.shared
        add(a.permissionMissing ? "画面収録の許可が要ります（システム設定 → プライバシーとセキュリティ → 画面収録）" : "見張っているウインドウ：\(a.watchingCount) 個", nil)
        add(a.weekSummary, nil)
        if !a.recent.isEmpty {
            sub.addItem(.separator())
            add("最近の知らせ（違う・合ってたを選ぶ）", nil)
            let f = DateFormatter()
            f.dateFormat = "H:mm"
            let namesOnly = settings.menuBarTickerNamesOnly
            for n in a.recent {
                // 「名前だけ」の設定ではアプリ名だけ（理由は画面の文字から作られることがあるので出さない）
                add(namesOnly ? "\(f.string(from: n.at)) \(n.app)" : "\(f.string(from: n.at)) \(n.app)：\(AIPicks.short(n.reason, 20))", nil, indent: 1)
                add("違う（次から知らせない）", #selector(assistantWrong(_:)), object: n.id, indent: 2)
                add("合ってた", #selector(assistantRight(_:)), object: n.id, indent: 2)
                add("このアプリは知らせない", #selector(assistantMuteApp(_:)), object: n.id, indent: 2)
            }
        }
        sub.addItem(.separator())
        add("知りたいこと…", #selector(editAssistantInterest))
        add("除外するアプリ…", #selector(editAssistantExcluded))
        add("自動で前に出す（離席中だけ・ブラウザは除く）", #selector(toggleAssistantAuto), state: settings.assistantAutoFront)
        add("見張りを一時停止", #selector(toggleAssistantPause), state: settings.assistantPaused)
        add("画面の中身は Mac の中の AI だけが読み、外には出しません", nil)
        let parent = NSMenuItem(title: "アシスタントの設定", action: nil, keyEquivalent: "")
        parent.submenu = sub
        parent.indentationLevel = 1
        menu.addItem(parent)
    }

    private func setupAIPicks() {
        aiPicks.blockedReason = { [weak self] in
            guard let self else { return "終了中" }
            if self.store?.isVisible == true { return "チャットを見ている" }
            return self.settings.isQuietNow() ? "静かな時間" : nil
        }
        aiPicks.onPick = { [weak self] text, postId in self?.ticker?.enqueue(suggestion: text, postId: postId) }
        let apply = { [weak self] in
            guard let self else { return }
            self.aiPicks.enabled = self.settings.aiTimelinePicks && AIPicks.availability().ok
        }
        settings.onAIPicksChange = { on in
            apply()
            StatusBarDiag.note("AI おすすめ: \(on ? "オン" : "オフ")")
        }
        apply()
        StatusBarDiag.update(collapse: settings.collapseStatusItems, ticker: settings.menuBarTicker || settings.aiTimelinePicks)
    }

    #if DEBUG
    /// 開発のみ（-aiPicksNow）：デモのタイムラインと興味の材料で、すぐにおすすめを回す（オフライン。何も送らない）。
    private func startAIPicksDemo(_ timeline: TimelineStore) {
        let demo = AIPicks.debugTimeline()
        timeline.debugSetPosts(demo.posts, clubs: demo.clubs)
        let avail = AIPicks.availability()
        NSLog("[ai] availability ok=%d %@", avail.ok ? 1 : 0, avail.reason ?? "")
        guard avail.ok else { return }
        StatusBarDiag.forced = true
        StatusBarDiag.enabled = true
        aiPicks.enabled = true
        aiPicks.debugForce = true
        aiPicks.debugSeed(opened: [(801, "RED KOMODO の色の作り方を教えてください。IPP2 とログの違い"), (802, "Final Cut と DaVinci、どっちで編集してる？")],
                          replied: [(803, "トーク動画の照明、キーライトとフィルの比率")])
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1))
            let t0 = Date()
            await self.aiPicks.run()
            NSLog("[ai] 1 回目 %.1f 秒", Date().timeIntervalSince(t0))
            let t1 = Date()
            await self.aiPicks.run() // 2 回目（まとめは今日の分を使う・出した投稿は除く）
            NSLog("[ai] 2 回目 %.1f 秒", Date().timeIntervalSince(t1))
        }
    }
    #endif

    /// タイムラインで開いたスレッド・返信を、おすすめの材料として（オンのあいだだけ、この Mac の中に）覚える。
    private func wireAIPicks(_ timeline: TimelineStore) {
        aiPicks.timeline = timeline
        timeline.onThreadOpened = { [weak self] p in self?.aiPicks.noteOpened(p) }
        timeline.onReplied = { [weak self] id in self?.aiPicks.noteReplied(id) }
    }

    // MARK: - メニューバーのティッカー

    private func setupTicker() {
        let t = StatusTicker(item: statusItem)
        t.collapser = collapser
        t.restoreButton = { [weak self] in
            guard let self, let button = self.statusItem.button else { return }
            button.attributedTitle = BeagleIcon.countTitle(self.countTitle)
            button.imagePosition = .imageLeading
        }
        t.canShow = { [weak self] in
            guard let self else { return false }
            if self.store?.isVisible == true { return false } // チャットを見ている
            var quiet = self.settings.isQuietNow()               // 静かな時間（0:00〜7:00）
            #if DEBUG
            if CommandLine.arguments.contains("-tickerTest") { quiet = false } // 開発のみ：夜中でも試せるように
            #endif
            if quiet { return false }
            return true
        }
        t.onOpen = { [weak self] id in
            guard let self else { return }
            self.showPanel()
            self.panel?.pin.tab = .chat
            if let id { self.store?.reveal(id) }
        }
        t.onShow = { [weak self] style in
            switch style {
            case .message: self?.barker?.bark(.message)
            case .mention: self?.barker?.bark(.mention)
            case .notice: self?.barker?.bark(.notice)
            case .suggest: self?.barker?.bark(.suggest)
            case .assistant: self?.barker?.bark(.assistant)
            }
        }
        t.onOpenThread = { [weak self] id in
            guard let self else { return }
            self.showPanel()
            self.panel?.pin.tab = .timeline
            self.timeline?.openThread = id
        }
        ticker = t
        let apply = { [weak self] in
            guard let self, let t = self.ticker else { return }
            t.enabled = self.settings.menuBarTicker
            t.namesOnly = self.settings.menuBarTickerNamesOnly
            StatusBarDiag.update(collapse: self.settings.collapseStatusItems, ticker: self.settings.menuBarTicker)
        }
        settings.onTickerChange = { [weak self] in
            apply()
            guard let self else { return }
            StatusBarDiag.note("ティッカー: \(self.settings.menuBarTicker ? "オン" : "オフ")\(self.settings.menuBarTickerNamesOnly ? "（名前だけ）" : "")")
        }
        apply()
    }

    /// ChatStore の受信からティッカーへ（通知のほうの受け取りはそのまま）。
    private func wireTicker(_ store: ChatStore) {
        let mention = store.onMention
        // 吠える：ティッカーがオンなら流れ始めと同時に（StatusTicker.onShow）、オフならここで。
        store.onMention = { [weak self] m in
            mention?(m)
            guard let self else { return }
            self.ticker?.enqueue(message: m)
            if self.ticker?.enabled != true { self.barker?.bark(.mention) }
        }
        let newMessage = store.onNewMessage
        store.onNewMessage = { [weak self] m in
            newMessage?(m)
            guard let self, m.kind == nil else { return } // ☗ のカードはお知らせのほうで
            self.ticker?.enqueue(message: m)
            if self.ticker?.enabled != true { self.barker?.bark(.message) }
        }
        store.onAnnouncement = { [weak self] m in
            guard let self else { return }
            self.ticker?.enqueue(announcement: m)
            if self.ticker?.enabled != true, !StatusTicker.isRoomNotice(m.body) { self.barker?.bark(.notice) }
        }
    }

    #if DEBUG
    /// 開発のみ：-collapseTest で自分のダミーのアイコン（★ ♥）を区切りの左に置き、
    /// 分散通知 fm.backspace.bguru.chat.debugCollapse（object = コマンド）で操作する。
    private var debugItems: [NSStatusItem] = []
    private func startCollapseTest() {
        if collapser?.isEnabled != true { collapser?.enable(collapse: false) }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) {
            for sym in ["star.fill", "heart.fill"] {
                let s = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
                let img = NSImage(systemSymbolName: sym, accessibilityDescription: nil)
                img?.isTemplate = true
                s.button?.image = img
                self.debugItems.append(s)
            }
        }
    }

    /// 開発のみ：分散通知 fm.backspace.bguru.chat.debugCollapse（object = コマンド）で畳む機能とティッカーを操作する。
    private var debugSeq = 0
    private func startDebugCommands() {
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("fm.backspace.bguru.chat.debugCollapse" + (ProcessInfo.processInfo.environment["BGURU_DEBUG_CHANNEL"] ?? "")), object: nil, queue: .main) { [weak self] n in
            let cmd = n.object as? String ?? ""
            MainActor.assumeIsolated {
                guard let self, let c = self.collapser else { return }
                NSLog("[collapse] debug command: %@", cmd)
                switch cmd {
                case "toggle": c.toggle(via: "デバッグ")
                case "collapse": c.collapse()
                case "expand": c.expand()
                case "settingOn": self.settings.collapseStatusItems = true
                case "settingOff": self.settings.collapseStatusItems = false
                case "hoverOn": self.settings.collapseRevealOnHover = true
                case "hoverOff": self.settings.collapseRevealOnHover = false
                case "unread": self.updateStatusIcon(unread: 12, mentions: 0, connection: .live)
                case "frames":
                    NSLog("[collapse] frames beagle=%@ dummies=%@", NSStringFromRect(self.statusItem.button?.window?.frame ?? .zero),
                          self.debugItems.map { NSStringFromRect($0.button?.window?.frame ?? .zero) }.joined(separator: " "))
                case "closeAlert": NSApp.abortModal()
                case "runOn": self.settings.menuBarRunner = true
                case "runOff": self.settings.menuBarRunner = false
                case "gpuOn": self.settings.menuBarRunnerGPU = true
                case "gpuOff": self.settings.menuBarRunnerGPU = false
                case "load0": self.runner?.debugLoad = 0
                case "load25": self.runner?.debugLoad = 25
                case "load55": self.runner?.debugLoad = 55
                case "load90": self.runner?.debugLoad = 90
                case "loadReal": self.runner?.debugLoad = nil
                case "barkOn": self.settings.menuBarBark = true
                case "barkOff": self.settings.menuBarBark = false
                case "tickerOn": self.settings.menuBarTicker = true
                case "tickerOff": self.settings.menuBarTicker = false
                case "namesOnly": self.settings.menuBarTickerNamesOnly = true
                case "namesFull": self.settings.menuBarTickerNamesOnly = false
                case "forceLight": self.ticker?.debugAppearance = NSAppearance(named: .aqua)
                case "forceDark": self.ticker?.debugAppearance = NSAppearance(named: .darkAqua)
                case "forceNone": self.ticker?.debugAppearance = nil
                case "msg", "mention", "notice", "photo", "long", "room", "burst":
                    guard let store = self.store else { return }
                    self.debugSeq += 1
                    let id = 5000 + self.debugSeq
                    switch cmd {
                    case "msg": store.debugReceive("今日の散財、届きました！\nあとで写真あげます", id: id, author: "コバン")
                    case "mention": store.debugReceive("@ドリキン さん、明日の配信何時からですか？", id: id, author: "ゆう", mention: true)
                    case "notice": store.debugReceive("☗ 見どころ：先手の銀が中央へ。後手は受けに回るか", id: id, author: "B-guru", kind: "notice")
                    case "photo": store.debugReceive("📷 写真", id: id, author: "たけし", images: ["/api/media/chat-demo.jpg"])
                    case "long": store.debugReceive(String(repeating: "とても長いメッセージを流してみるテストです。", count: 4), id: id, author: "長文さん")
                    case "room": store.debugReceive("🎧 コバンが部室に入りました", id: id, author: "B-guru", kind: "notice")
                    default:
                        for k in 0..<7 { store.debugReceive("連投 \(k + 1)", id: id + 100 + k, author: "連投さん") }
                    }
                case "quit": NSApp.terminate(nil)
                case "awWrong": Assistant.shared.markWrong()
                case "awRight": Assistant.shared.markRight()
                case "awMute": self.muteAssistantApp(nil)
                case "awExcluded": NSLog("[assistant] 除外 %d 件・最後: %@", self.settings.assistantExcluded.count, self.settings.assistantExcluded.last ?? "")
                case "awAutoOn": self.settings.assistantAutoFront = true
                case "awAutoOff": self.settings.assistantAutoFront = false
                case "awPause": self.settings.assistantPaused = true
                case "awResume": self.settings.assistantPaused = false
                case "awOff": self.debugAssistantOff = true; self.applyAssistant()
                case "awOn": self.debugAssistantOff = false; self.applyAssistant()
                case "awQuietOn": self.debugQuiet = true
                case "awQuietOff": self.debugQuiet = false; self.flushHeldAssistant()
                case "awFrontCheckBrowser":
                    if var n = Assistant.shared.recent.first {
                        n.bundleID = "com.apple.Safari"
                        NSLog("[assistant] ブラウザなら自動で出すか: %@", Assistant.shared.autoFrontBlockReason(n) ?? "出す")
                    }
                case "awFrontCheck":
                    if let n = Assistant.shared.recent.first { NSLog("[assistant] 自動で出すか: %@", Assistant.shared.autoFrontBlockReason(n) ?? "出す") }
                case "awMemory":
                    NSLog("[assistant] 見張り %d 個・覚えている行 %d", Assistant.shared.watchingCount, Assistant.shared.lineCount)
                case "showPanel": self.showPanel()
                case "hidePanel": self.panel?.dismiss()
                default:
                    if cmd.hasPrefix("aw:") { AssistantTestWindows.shared.command(cmd) }
                    if cmd.hasPrefix("awForceKind:") { Assistant.shared.debugForceKind = String(cmd.dropFirst("awForceKind:".count)) }
                }
            }
        }
    }
    #endif

    // MARK: - Notifications

    private func notifyMention(_ m: ChatMessage) {
        let content = UNMutableNotificationContent()
        content.title = "\(m.authorName ?? "誰か") がメンションしました"
        content.body = m.body
        content.categoryIdentifier = "mention"
        content.threadIdentifier = "chat"
        content.userInfo = ["messageId": m.id]
        // Quiet hours: still delivered, but without the bark.
        if !settings.isQuietNow() { content.sound = UNNotificationSound(named: UNNotificationSoundName("bark.caf")) }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "chat-\(m.id)", content: content, trigger: nil))
    }

    /// ☗ 将棋: an offer to me, or my move in a slow game — like a mention (always; no sound in
    /// the quiet hours). Not while that game is on screen.
    private func notifyShogi(_ g: ShogiGame, offer: Bool) {
        if let store, store.isVisible, panel?.pin.chatShown == true, store.shogi.open, store.shogi.selectedId == g.id { return }
        let content = UNMutableNotificationContent()
        content.title = "☗ 将棋"
        if offer {
            content.body = "\(g.creator?.name ?? "だれか") さんから対局の申し込みが届きました\(g.rematchOf != nil ? "（再戦）" : "")"
        } else {
            let opponent = store?.shogi.myColor(in: g).flatMap { g.player($0.other)?.name } ?? "相手"
            content.body = "\(opponent) さんが\(g.lastMove.map { "\($0.label) と" } ?? "")指しました。あなたの番です"
        }
        content.threadIdentifier = "shogi-\(g.id)"
        content.userInfo = ["shogiGameId": g.id]
        if !settings.isQuietNow() { content.sound = .default }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "shogi-\(g.id)", content: content, trigger: nil))
    }

    /// ✉️ 簡易 DM from someone (not while that conversation is on screen): 「〇〇さんからの DM」 and the text.
    /// One notification per person (the next replaces it). DMs are to me, so quiet hours keep only the sound off.
    private func notifyDM(_ m: DMMessage, peer: DMPeer) {
        let t = DMLogic.notificationText(name: peer.name, body: m.body)
        let content = UNMutableNotificationContent()
        content.title = t.title
        content.body = t.body
        content.threadIdentifier = "dm-\(peer.userId)"
        content.userInfo = ["dmPeerId": peer.userId, "dmPeerName": peer.name ?? ""]
        if !settings.isQuietNow() { content.sound = .default }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "dm-\(peer.userId)", content: content, trigger: nil))
    }

    /// 「タイムラインの新しい投稿も通知する」: the stream says a post or comment was made;
    /// a moment later the timeline is read again and posts newer than any seen before
    /// (not mine, still unread) become one notification each (at most 3 at a time).
    /// Not while the timeline is on screen — it shows them itself.
    private var newestPostSeen = 0
    private var postCheckTask: Task<Void, Never>?

    private func timelinePostCreated() {
        // Also without the notice option while the timeline can be seen: it updates by itself
        // (drikin 2026-10-24「タイムラインの自動更新を有効にする」), not only every minute.
        let seen = store?.isVisible == true && panel?.pin.timelineShown == true && panel?.pin.windowVisible == true
        guard settings.notifyTimeline || seen, let timeline else { return }
        postCheckTask?.cancel()
        postCheckTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            let before = self.newestPostSeen > 0 ? self.newestPostSeen : (timeline.posts.map(\.id).max() ?? 0)
            await timeline.refresh()
            self.newestPostSeen = max(before, timeline.posts.map(\.id).max() ?? 0)
            guard before > 0, self.settings.notifyTimeline, !self.settings.isQuietNow() else { return }
            if self.store?.isVisible == true, self.panel?.pin.timelineShown == true { return }
            let fresh = timeline.posts.filter { $0.id > before && $0.isAuthor != true && $0.unread == true }
            for p in fresh.sorted(by: { $0.id < $1.id }).prefix(3) { self.notifyPost(p) }
        }
    }

    private func notifyPost(_ p: Post) {
        let content = UNMutableNotificationContent()
        content.title = "\(p.authorName ?? "誰か") が投稿しました"
        let text = p.text.trimmingCharacters(in: .whitespacesAndNewlines)
        content.body = text.count > 240 ? String(text.prefix(240)) + "…" : (text.isEmpty ? "新しい投稿があります" : text)
        content.categoryIdentifier = "newpost"
        content.threadIdentifier = "timeline"
        content.userInfo = ["postId": p.id]
        content.sound = .default
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "post-\(p.id)", content: content, trigger: nil))
    }

    /// Everything that is not a mention goes into ONE notification that is
    /// updated in place ("ゆう: …（ほか 3 件の新着）"), so a busy room never
    /// floods the notification centre. Updates are debounced (0.4 s): re-adding
    /// the same identifier within the same instant can drop the notification,
    /// and a burst of messages should become one update anyway. Only the first
    /// of a batch makes a sound. Cleared when the panel opens.
    private var bundledLine = ""
    private var bundledSounded = false
    private var bundlePostTask: Task<Void, Never>?

    private func notifyNewMessage(_ m: ChatMessage) {
        guard settings.notifyMode == .all, !settings.isQuietNow() else { return }
        bundledCount += 1
        if bundledFirstId == nil { bundledFirstId = m.id }
        bundledLine = "\(m.authorName ?? "誰か"): \(m.body)"
        bundlePostTask?.cancel()
        bundlePostTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled, let self, self.bundledCount > 0 else { return }
            self.postBundled()
        }
    }

    private func postBundled() {
        let content = UNMutableNotificationContent()
        content.title = "B-guru チャット"
        content.body = bundledCount == 1 ? bundledLine : "\(bundledLine)\n（ほか \(bundledCount - 1) 件の新着）"
        content.categoryIdentifier = "newmsg"
        content.threadIdentifier = "chat"
        if let id = bundledFirstId { content.userInfo = ["messageId": id] }
        if !bundledSounded {
            content.sound = .default
            bundledSounded = true
        }
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "chat-new", content: content, trigger: nil))
    }

    private func clearBundledNotification() {
        bundlePostTask?.cancel()
        bundledCount = 0
        bundledFirstId = nil
        bundledSounded = false
        UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["chat-new"])
    }

    #if DEBUG
    private func runNotifyTest() {
        func fake(_ id: Int, _ who: String, _ body: String, mention: Bool = false) -> ChatMessage {
            ChatMessage(id: id, authorId: "t", authorName: who, avatar: nil, body: body, createdAt: "", edited: false,
                        editedAt: nil, isAuthor: false, mentionsMe: mention, clientId: nil, reactions: nil)
        }
        let quiet = settings.quietHours
        settings.quietHours = false
        // Burst: three in the same instant must end up as ONE bundled notification.
        notifyNewMessage(fake(900001, "テストA", "（通知テスト）一件目"))
        notifyNewMessage(fake(900002, "テストB", "（通知テスト）二件目"))
        notifyNewMessage(fake(900003, "テストC", "（通知テスト）三件目"))
        notifyMention(fake(900004, "テストD", "@ドリキン（通知テスト）メンション", mention: true))
        settings.quietHours = quiet
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
            UNUserNotificationCenter.current().getDeliveredNotifications { list in
                for n in list {
                    NSLog("[notify] id=%@ title=%@ body=%@ jump=%@", n.request.identifier, n.request.content.title,
                          n.request.content.body.replacingOccurrences(of: "\n", with: " / "),
                          String(describing: n.request.content.userInfo["messageId"] ?? "-"))
                }
                UNUserNotificationCenter.current().getNotificationSettings { st in
                    NSLog("[notify] auth=%ld delivered=%ld", st.authorizationStatus.rawValue, list.count)
                    UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ["chat-new", "chat-900004"])
                }
            }
        }
    }
    #endif

    #if DEBUG
    /// The screens one after another, each announced on stdout as `[tour] N name` and held
    /// for 3 s; the script captures the window and reads it (orientation-check.swift).
    /// Ends with `[tour] done` and quits.
    private func runOrientationTour(store: ChatStore) {
        let photo = ProcessInfo.processInfo.environment["BGURU_DEMO_PHOTOS"].map { "\($0)/photo1.jpg" }
        var steps: [(String, @MainActor () -> Void)] = [
            ("chat", { self.panel?.pin.tab = .chat }),
            ("jukebox-playing", {
                self.panel?.pin.tab = .jukebox
                if let e = store.jukebox.todayEpisode, !store.jukebox.isPlaying { store.jukebox.play(e) }
            }),
            ("chat-after-jukebox", { self.panel?.pin.tab = .chat }),
            ("timeline", { self.panel?.pin.tab = .timeline }),
            ("jukebox-again", { self.panel?.pin.tab = .jukebox }),
            ("chat-again", { self.panel?.pin.tab = .chat }),
            // The record stopped part way round, then the panel resized / closed and reopened /
            // turned dark while it shows (the turntable is the one layer the app turns itself).
            ("jukebox-paused", { self.panel?.pin.tab = .jukebox; store.jukebox.pause() }),
            ("jukebox-paused-resized", {
                guard let p = self.panel else { return }
                var f = p.frame
                f.size.height += 60
                f.origin.y -= 60
                p.setFrame(f, display: true)
            }),
            ("jukebox-reopened", {
                self.panel?.orderOut(nil)
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(0.6))
                    self.showPanel()
                    store.jukebox.resume()
                }
            }),
            ("jukebox-dark", { NSApp.appearance = NSAppearance(named: .darkAqua) }),
            ("chat-after-turntable", { NSApp.appearance = NSAppearance(named: .aqua); self.panel?.pin.tab = .chat }),
        ]
        if let photo {
            steps.append(("image-viewer", { NotificationCenter.default.post(name: .debugOpenImageViewer, object: photo) }))
            steps.append(("viewer-closed", { NotificationCenter.default.post(name: .closeImageViewer, object: nil) }))
        }
        let more: [(String, @MainActor () -> Void)] = [
            ("shogi", { store.shogi.openGame(101) }),
            ("minigame", { store.minigame.show() }),
            ("text", { RoomModePicker.choose(.text, room: store.room, shogi: store.shogi, minigame: store.minigame, offkai: store.offkai) }),
            ("reopened", {
                self.panel?.orderOut(nil)
                Task { @MainActor in
                    try? await Task.sleep(for: .seconds(0.6))
                    self.showPanel()
                }
            }),
            ("resized", {
                guard let p = self.panel else { return }
                var f = p.frame
                f.size.height += 120
                f.origin.y -= 120
                p.setFrame(f, display: true)
            }),
            ("dark-chat", { NSApp.appearance = NSAppearance(named: .darkAqua) }),
            ("dark-jukebox", { self.panel?.pin.tab = .jukebox }),
            ("dark-shogi", { self.panel?.pin.tab = .chat; store.shogi.openGame(101) }),
            ("dark-minigame", { store.minigame.show() }),
            ("light-chat", {
                NSApp.appearance = NSAppearance(named: .aqua)
                RoomModePicker.choose(.text, room: store.room, shogi: store.shogi, minigame: store.minigame, offkai: store.offkai)
            }),
            ("light-timeline", { self.panel?.pin.tab = .timeline }),
            ("final-chat", { self.panel?.pin.tab = .chat }),
        ]
        steps.append(contentsOf: more)
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            for (i, step) in steps.enumerated() {
                step.1()
                try? await Task.sleep(for: .seconds(1.2))
                print("[tour] \(i) \(step.0)"); fflush(stdout)
                try? await Task.sleep(for: .seconds(1.8))
            }
            print("[tour] done"); fflush(stdout)
            try? await Task.sleep(for: .seconds(0.5))
            NSApp.terminate(nil)
        }
    }
    #endif

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.content.userInfo["messageId"] as? Int
        let postId = response.notification.request.content.userInfo["postId"] as? Int
        let shogiGameId = response.notification.request.content.userInfo["shogiGameId"] as? Int
        let dmPeerId = response.notification.request.content.userInfo["dmPeerId"] as? String
        let dmPeerName = response.notification.request.content.userInfo["dmPeerName"] as? String
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        await MainActor.run {
            switch action {
            case "reply":
                if let text { self.store?.send(text, restore: { _ in }) }
            case "heart":
                if let id { self.store?.toggleReaction(id, emoji: "❤️") }
            default:
                // Click: open the chat at that message, or the post's thread in the timeline.
                self.showPanel()
                if let dmPeerId, let store = self.store {
                    // ✉️ That person's DM conversation, over the chat.
                    self.panel?.pin.tab = .chat
                    store.dm.open(DMPeer(userId: dmPeerId, name: dmPeerName?.isEmpty == false ? dmPeerName : nil, avatar: nil))
                } else if let shogiGameId {
                    self.panel?.pin.tab = .chat
                    self.store?.shogi.openGame(shogiGameId)
                } else if let id { self.store?.reveal(id) }
                else if let postId { self.timeline?.openThread = postId }
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}


#if DEBUG
extension AppDelegate {
    /// Dev only, with `-demoPanel -panelMemory -panelMemoryCheck PHASE` (scripts run the phases
    /// one launch after another): 1 = resize as the member would, close, open (same size?), move,
    /// switch to the timeline, open ☗ in the chat; 2 = after a relaunch (same size, place, tab, ☗?);
    /// 3 = a place saved off this display and a size bigger than it (opened inside the display?).
    /// Prints `[panel-memory] …` lines with the frames, holds the panel open 4 s for a screenshot
    /// at each `[panel-memory] shot NAME x y w h` (top-left screen coordinates), then quits.
    func runPanelMemoryCheck(phase: String, store: ChatStore) {
        guard let panel else { return }
        @MainActor func say(_ s: String) { print("[panel-memory] \(s)"); fflush(stdout) }
        @MainActor func shot(_ name: String) async {
            let f = panel.frame
            let h = NSScreen.screens.first?.frame.height ?? 0
            say("shot \(name) \(Int(f.minX)) \(Int(h - f.maxY)) \(Int(f.width)) \(Int(f.height))")
            try? await Task.sleep(for: .seconds(4))
        }
        Task { @MainActor in
            try? await Task.sleep(for: .seconds(1.5))
            let vis = (panel.screen ?? NSScreen.main)!.visibleFrame
            var ok = true
            switch phase {
            case "1":
                say("opened \(panel.frame) tab \(panel.pin.tab)")
                let resized = NSRect(x: panel.frame.minX, y: panel.frame.maxY - 700, width: 460, height: 700)
                panel.debugAsMember(resized)
                panel.dismiss()
                try? await Task.sleep(for: .seconds(1))
                showPanel()
                try? await Task.sleep(for: .seconds(1))
                let sameSize = abs(panel.frame.width - 460) < 1 && abs(panel.frame.height - 700) < 1
                ok = ok && sameSize
                say("resized, closed, opened: \(panel.frame) same size \(sameSize)")
                await shot("1-resized-reopened")
                store.shogi.show() // ☗ makes the panel taller (at least 820)
                try? await Task.sleep(for: .seconds(1))
                panel.debugAsMember(NSRect(x: vis.minX + 120, y: vis.minY + 60, width: panel.frame.width, height: panel.frame.height))
                panel.pin.tab = .timeline
                try? await Task.sleep(for: .seconds(1))
                say("moved to \(panel.frame), tab timeline, ☗ open")
                await shot("1-moved-timeline")
            case "2":
                let f = panel.frame
                let place = abs(f.minX - (vis.minX + 120)) < 2 && abs(f.minY - (vis.minY + 60)) < 2
                let size = abs(f.width - 460) < 1 && abs(f.height - 820) < 1 // as left (☗ had made it 820 tall)
                let tab = panel.pin.tab == .timeline
                let shogi = store.shogi.open
                ok = place && size && tab && shogi
                say("display \(PanelMemory.displayKey(panel.screen ?? NSScreen.main!))")
                say("relaunched: \(f) place \(place) size \(size) tab \(panel.pin.tab) ☗ open \(shogi)")
                await shot("2-relaunched")
                panel.pin.tab = .chat
                try? await Task.sleep(for: .seconds(1))
                await shot("2-chat-shogi")
            case "3":
                let f = panel.frame
                let inside = vis.contains(f)
                ok = inside
                say("saved place off screen and size 5000×5000 → opened at \(f) inside visible \(vis): \(inside)")
                await shot("3-fitted")
            default: break
            }
            say(ok ? "ok   phase \(phase)" : "FAIL phase \(phase)")
            NSApp.terminate(nil)
        }
    }
}
#endif
