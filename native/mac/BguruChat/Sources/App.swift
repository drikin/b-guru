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

    func applicationDidFinishLaunching(_ notification: Notification) {
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
        updateStatusIcon(unread: 0, mentions: 0, connection: .connecting)
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
            SelfTest.run(store: store, outDir: CommandLine.arguments[i + 1], send: false)
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
        store.onBecameVisible = { [weak self] in self?.clearBundledNotification() }
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
        let symbol = unread > 0 ? "dog.fill" : "dog"
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        img?.isTemplate = true
        button.image = img
        let n = min(unread, 99)
        button.title = unread == 0 ? "" : (mentions > 0 ? " @\(n)" : " \(n)")
        button.imagePosition = .imageLeading
        button.appearsDisabled = connection == .offline
        let state = connection == .offline ? "、オフライン" : ""
        let detail = mentions > 0 ? "、うちメンション \(mentions) 件" : ""
        button.setAccessibilityLabel(unread > 0 ? "B-guru チャット、未読 \(unread) 件\(detail)\(state)" : "B-guru チャット\(state)")
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

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse) async {
        let id = response.notification.request.content.userInfo["messageId"] as? Int
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        await MainActor.run {
            switch action {
            case "reply":
                if let text { self.store?.send(text, restore: { _ in }) }
            case "heart":
                if let id { self.store?.toggleReaction(id, emoji: "❤️") }
            default:
                // Click: open the chat at that message.
                self.showPanel()
                if let id { self.store?.reveal(id) }
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
