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
    /// 新着でビーグルが吠える（絵の差し替え）。
    private var barker: BeagleBarker?
    /// ビーグルの右の未読の数（ティッカーが流しているあいだはティッカーがタイトルを持つ）。
    private var countTitle = ""

    func applicationDidFinishLaunching(_ notification: Notification) {
        HangWatch.shared.start()
        TextComposition.watchReturnKey()
        #if DEBUG
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
        if !CommandLine.arguments.contains("-selftest") { setupCollapser(); setupTicker() }
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
            self?.togglePanel()
        }

        #if DEBUG
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
            self.store = store
            self.timeline = timeline
            panel = ChatPanel(store: store, timeline: timeline, onSignOut: {})
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
                if CommandLine.arguments.contains("-demoShogiGame") { store.shogi.openGame(101) }
                if CommandLine.arguments.contains("-demoShogiWatch") { store.shogi.openGame(101) }
                // -orientationTour: walk through every screen for the upside-down check
                // (native/mac/scripts/orientation-tour.sh takes a picture at each step).
                if CommandLine.arguments.contains("-orientationTour") { self.runOrientationTour(store: store) }
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
        self.store = store
        store.start()
        Updater.shared.start(token: token)
        panel = ChatPanel(store: store, timeline: timeline, onSignOut: { [weak self] in self?.signOut() })
        observeStore()
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
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, let store = self.store else { return }
                self.updateStatusIcon(unread: store.unreadCount, mentions: store.mentionCount, connection: store.connection)
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

    @objc private func openPanelAction() { showPanel() }
    @objc private func toggleCollapseSetting() { settings.collapseStatusItems.toggle() }
    @objc private func toggleCollapseHover() { settings.collapseRevealOnHover.toggle() }
    @objc private func toggleTicker() { settings.menuBarTicker.toggle() }
    @objc private func toggleBark() { settings.menuBarBark.toggle() }
    @objc private func toggleTickerNames() { settings.menuBarTickerNamesOnly.toggle() }
    @objc private func signOutAction() { signOut() }
    @objc private func checkUpdates() { Updater.shared.checkNow() }
    @objc private func openWeb() { NSWorkspace.shared.open(APIClient.baseURL) }

    /// Menu bar click and ⌃⌥B both toggle: if the chat is in front, put it
    /// away; otherwise bring it to the front with the caret in the message box.
    /// (A pinned panel sitting behind your work is brought forward, not closed.)
    private func togglePanel() {
        guard let panel else { showLogin(); return }
        if panel.isFrontForToggle {
            if !panel.isDismissing { panel.dismiss() }
        } else {
            showPanel()
        }
    }

    private func showPanel() {
        guard let panel, let button = statusItem.button, let win = button.window else { return }
        let r = win.convertToScreen(button.convert(button.bounds, to: nil))
        panel.present(below: r)
    }

    private func updateStatusIcon(unread: Int, mentions: Int, connection: ChatStore.Connection) {
        guard let button = statusItem?.button else { return }
        // Posture tells the state, not colour (template image stays monochrome):
        // sitting = nothing new, filled = new messages, "@" = someone called you.
        // 左向きのビーグル（BeagleIcon）。吠えている途中なら、終わったときにこの状態の絵に戻る。
        barker?.filled = unread > 0
        if barker?.isBarking != true { button.image = BeagleIcon.image(filled: unread > 0) }
        let n = min(unread, 99)
        countTitle = unread == 0 ? "" : (mentions > 0 ? " @\(n)" : " \(n)")
        if let ticker, ticker.isShowing {
            ticker.setCount(countTitle)
        } else {
            button.attributedTitle = BeagleIcon.countTitle(countTitle)
            button.imagePosition = .imageLeading
        }
        button.appearsDisabled = connection == .offline
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
        if CommandLine.arguments.contains("-collapseTest") || CommandLine.arguments.contains("-tickerTest") {
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
            }
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
        DistributedNotificationCenter.default().addObserver(forName: Notification.Name("fm.backspace.bguru.chat.debugCollapse"), object: nil, queue: .main) { [weak self] n in
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
                default: break
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
        if let store, store.isVisible, panel?.pin.tab == .chat, store.shogi.open, store.shogi.selectedId == g.id { return }
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

    /// 「タイムラインの新しい投稿も通知する」: the stream says a post or comment was made;
    /// a moment later the timeline is read again and posts newer than any seen before
    /// (not mine, still unread) become one notification each (at most 3 at a time).
    /// Not while the timeline is on screen — it shows them itself.
    private var newestPostSeen = 0
    private var postCheckTask: Task<Void, Never>?

    private func timelinePostCreated() {
        guard settings.notifyTimeline, let timeline else { return }
        postCheckTask?.cancel()
        postCheckTask = Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled, let self else { return }
            let before = self.newestPostSeen > 0 ? self.newestPostSeen : (timeline.posts.map(\.id).max() ?? 0)
            await timeline.refresh()
            self.newestPostSeen = max(before, timeline.posts.map(\.id).max() ?? 0)
            guard before > 0, !self.settings.isQuietNow() else { return }
            if self.store?.isVisible == true, self.panel?.pin.tab == .timeline { return }
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
            ("text", { RoomModePicker.choose(.text, room: store.room, shogi: store.shogi, minigame: store.minigame) }),
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
                RoomModePicker.choose(.text, room: store.room, shogi: store.shogi, minigame: store.minigame)
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
                if let shogiGameId {
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
