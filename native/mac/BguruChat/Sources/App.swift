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
    private var hotKey: HotKey?
    private var observeTask: Task<Void, Never>?

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
        updateStatusIcon(unread: 0, connection: .connecting)

        let center = UNUserNotificationCenter.current()
        center.delegate = self
        let reply = UNTextInputNotificationAction(identifier: "reply", title: "返信", options: [],
                                                  textInputButtonTitle: "送信", textInputPlaceholder: "メッセージ")
        let heart = UNNotificationAction(identifier: "heart", title: "❤️", options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: "mention", actions: [reply, heart],
                                                                 intentIdentifiers: [], options: [])])

        hotKey = HotKey(keyCode: 11 /* B */, modifiers: [.control, .option]) { [weak self] in
            self?.togglePanel()
        }

        #if DEBUG
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
            if CommandLine.arguments.contains("-reopenTest") {
                // open → close → open via the hotkey path, to check the caret lands in the box each time
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { self.togglePanel() }
                DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { self.togglePanel() }
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
        let store = ChatStore(api: APIClient(token: token))
        store.onMention = { [weak self] m in self?.notifyMention(m) }
        self.store = store
        store.start()
        panel = ChatPanel(store: store, onSignOut: { [weak self] in self?.signOut() })
        observeStore()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    /// Re-render the menu bar icon whenever unread / connection / sign-out changes.
    private func observeStore() {
        guard let store else { return }
        withObservationTracking {
            _ = store.unreadCount
            _ = store.connection
            _ = store.signedOut
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, let store = self.store else { return }
                self.updateStatusIcon(unread: store.unreadCount, connection: store.connection)
                if store.signedOut { self.signOut(revoke: false) } else { self.observeStore() }
            }
        }
        updateStatusIcon(unread: store.unreadCount, connection: store.connection)
    }

    private func signOut(revoke: Bool = true) {
        let token = store?.token
        store?.stop()
        panel?.close()
        panel = nil
        store = nil
        Keychain.delete()
        if revoke, let token { Task { await APIClient(token: token).revokeSelf() } }
        updateStatusIcon(unread: 0, connection: .offline)
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
            openPanelFromStatusItem()
        }
    }

    private func showMenu() {
        let menu = NSMenu()
        menu.addItem(withTitle: "チャットを開く  ⌃⌥B", action: #selector(openPanelAction), keyEquivalent: "").target = self
        menu.addItem(withTitle: "B-guru をブラウザで開く", action: #selector(openWeb), keyEquivalent: "").target = self
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
    @objc private func openWeb() { NSWorkspace.shared.open(APIClient.baseURL) }

    /// Menu bar click: always bring the chat to the front (never toggles it
    /// away — close with Esc, or by clicking elsewhere when not pinned).
    private func openPanelFromStatusItem() {
        guard panel != nil else { showLogin(); return }
        showPanel()
    }

    /// ⌃⌥B: toggle — open in front, or put it away if it is already in front.
    private func togglePanel() {
        guard let panel else { showLogin(); return }
        if panel.isVisible && panel.isKeyWindow && panel.alphaValue > 0.9 { panel.dismiss() } else { showPanel() }
    }

    private func showPanel() {
        guard let panel, let button = statusItem.button, let win = button.window else { return }
        let r = win.convertToScreen(button.convert(button.bounds, to: nil))
        panel.present(below: r)
    }

    private func updateStatusIcon(unread: Int, connection: ChatStore.Connection) {
        guard let button = statusItem?.button else { return }
        // Posture tells the state, not colour (template image stays monochrome).
        let symbol = unread > 0 ? "dog.fill" : "dog"
        let img = NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
        img?.isTemplate = true
        button.image = img
        button.title = unread > 0 ? " \(min(unread, 99))" : ""
        button.imagePosition = .imageLeading
        button.appearsDisabled = connection == .offline
        let state = connection == .offline ? "、オフライン" : ""
        button.setAccessibilityLabel(unread > 0 ? "B-guru チャット、未読 \(unread) 件\(state)" : "B-guru チャット\(state)")
    }

    // MARK: - Notifications

    private func notifyMention(_ m: ChatMessage) {
        let content = UNMutableNotificationContent()
        content.title = "\(m.authorName ?? "誰か") がメンションしました"
        content.body = m.body
        content.categoryIdentifier = "mention"
        content.threadIdentifier = "chat"
        content.userInfo = ["messageId": m.id]
        content.sound = UNNotificationSound(named: UNNotificationSoundName("bark.caf"))
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "chat-\(m.id)", content: content, trigger: nil))
    }

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
                self.showPanel()
            }
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .sound]
    }
}
