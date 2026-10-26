import SwiftUI
import UIKit
import UserNotifications

/// APNs on iPhone/iPad: ask permission once signed in, register this device's
/// token with the server, handle the notification actions (reply / ❤️) and the
/// tap (open the chat at that message).
///
/// The push itself carries only ids; the Notification Service Extension fills
/// in the real text (see native/ios/NSE). Until the server has an APNs key,
/// registration still works but nothing is sent.
@MainActor
final class PushCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCenter()

    /// Set by the Session while signed in.
    weak var session: Session?
    private var deviceToken: String?

    /// Notification settings for this device (kept by the server per device).
    /// "all": every new chat message (one rolling notification) / "mentions": mentions + replies only.
    var notifyMode: String {
        get { UserDefaults.standard.string(forKey: "notifyMode") ?? "all" }
        set { UserDefaults.standard.set(newValue, forKey: "notifyMode"); syncSettings() }
    }
    /// 0:00–7:00 JST: no new-message notifications (mentions still come).
    var quietHours: Bool {
        get { UserDefaults.standard.object(forKey: "quietHours") as? Bool ?? true }
        set { UserDefaults.standard.set(newValue, forKey: "quietHours"); syncSettings() }
    }

    /// Also new timeline posts (comments not included). Off until the member turns it on.
    var notifyTimeline: Bool {
        get { UserDefaults.standard.bool(forKey: "notifyTimeline") }
        set { UserDefaults.standard.set(newValue, forKey: "notifyTimeline"); syncSettings() }
    }

    private func syncSettings() {
        guard let hex = deviceToken, let api = session?.api else { return }
        let platform = UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
        let mode = notifyMode, quiet = quietHours, timeline = notifyTimeline
        Task {
            // notify_shogi: this app opens ☗ 将棋 notifications (shogi_offer / shogi_turn) at the game.
            // notify_sync: it knows read_sync (a background push that removes what was read elsewhere) and
            // voice_handoff (「🎧 音声をこの端末で続ける」).
            try? await api.registerPush(deviceToken: hex, environment: Self.environment, platform: platform,
                                        notifyMode: mode, quietHours: quiet, notifyTimeline: timeline, notifyShogi: true,
                                        notifySync: true)
        }
    }

    #if DEBUG
    static let environment = "sandbox"     // Xcode-installed builds get sandbox tokens
    #else
    static let environment = "production"  // TestFlight / App Store
    #endif

    func configure() {
        let center = UNUserNotificationCenter.current()
        center.delegate = self
        // .authenticationRequired: someone holding a locked phone must not be able
        // to post or react as its owner from the lock screen.
        let reply = UNTextInputNotificationAction(identifier: "reply", title: "返信", options: [.authenticationRequired],
                                                  textInputButtonTitle: "送信", textInputPlaceholder: "メッセージ")
        let heart = UNNotificationAction(identifier: "heart", title: "❤️", options: [.authenticationRequired])
        let open = UNNotificationAction(identifier: "open", title: "開く", options: [.foreground])
        center.setNotificationCategories([
            UNNotificationCategory(identifier: "mention", actions: [reply, heart], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "newmsg", actions: [reply], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "reply", actions: [open], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "newpost", actions: [open], intentIdentifiers: [], options: []),
            // ☗ 将棋: an offer to me / my move in a slow game (a tap opens the game).
            UNNotificationCategory(identifier: "shogioffer", actions: [open], intentIdentifiers: [], options: []),
            UNNotificationCategory(identifier: "shogiturn", actions: [open], intentIdentifiers: [], options: []),
            // ✉️ 簡易 DM (a tap opens that conversation).
            UNNotificationCategory(identifier: "dm", actions: [open], intentIdentifiers: [], options: []),
            // 🎧 音声をこの端末で続ける (the Mac's 「スマホで続ける」; a tap joins the sound here).
            UNNotificationCategory(identifier: "voicehandoff", actions: [open], intentIdentifiers: [], options: []),
        ])
    }

    /// After sign-in: permission (once) → APNs registration.
    func enable() {
        Task {
            let granted = (try? await UNUserNotificationCenter.current()
                .requestAuthorization(options: [.alert, .sound, .badge])) ?? false
            guard granted else { return }
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    func didRegister(_ token: Data) {
        deviceToken = token.map { String(format: "%02x", $0) }.joined()
        syncSettings()
    }

    /// Sign-out: stop pushes to this device (the token is revoked right after,
    /// which stops them server-side too).
    func disable(api: APIClient) async {
        if let t = deviceToken { await api.unregisterPush(deviceToken: t) }
        UIApplication.shared.unregisterForRemoteNotifications()
        deviceToken = nil
    }

    // MARK: UNUserNotificationCenterDelegate

    /// In the foreground the chat is already on screen: don't show chat
    /// notifications again; replies to your posts still show as a banner.
    ///
    /// The completion-handler forms (not the `async` ones) on purpose: UIKit
    /// asserts its completion handler runs on the main thread, and the async
    /// form resumes it from a background executor — tapping a notification
    /// crashed every TestFlight build up to 0.1.2 (SIGABRT in
    /// -[UIApplication _performBlockAfterCATransactionCommitSynchronizes:]).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping @Sendable (UNNotificationPresentationOptions) -> Void) {
        let kind = notification.request.content.userInfo["kind"] as? String
        let gameId = (notification.request.content.userInfo["game_id"] as? NSNumber)?.intValue
        let dmPeer = kind == "dm" ? notification.request.content.userInfo["peer_id"] as? String : nil
        // In the app, the chat and the timeline show what is new themselves. Everything else — 🎧 voice_handoff
        // included (the Mac's button was pressed while this app is open) — shows as a banner.
        let options: UNNotificationPresentationOptions = kind == "chat_mention" || kind == "chat_new" || kind == "timeline_new" ? [] : [.banner, .sound]
        DispatchQueue.main.async {
            // ☗ 将棋: not while that very game is on screen.
            let watching = gameId.map { id in MainActor.assumeIsolated { PushCenter.shared.isShowingShogi(id) } } ?? false
            // ✉️ Not while that DM conversation is on screen.
            let readingDM = dmPeer.map { id in MainActor.assumeIsolated { PushCenter.shared.session?.store?.dm.isShowing(peerId: id) ?? false } } ?? false
            // 🍻 Not while the 🍻 tab is on screen (it already shows the event).
            let seeingOffkai = kind == "offkai_start" && MainActor.assumeIsolated {
                UIApplication.shared.applicationState == .active && PushCenter.shared.session?.store?.offkai.open == true
            }
            completionHandler(watching || readingDM || seeingOffkai ? [] : options)
        }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let info = response.notification.request.content.userInfo
        let messageId = (info["message_id"] as? NSNumber)?.intValue
        let postId = (info["post_id"] as? NSNumber)?.intValue
        let kind = info["kind"] as? String
        let gameId = kind?.hasPrefix("shogi_") == true ? (info["game_id"] as? NSNumber)?.intValue : nil
        let dmPeer = kind == "dm" ? info["peer_id"] as? String : nil
        let offkai = kind == "offkai_start"
        // 🎧 音声をこの端末で続ける: { target: offkai | voice | room, mic }.
        let handoff = kind == "voice_handoff" ? info["target"] as? String : nil
        let handoffMic = ReadSync.bool(info["mic"])
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                if let handoff, let store = PushCenter.shared.session?.store {
                    // The chat with that feature, and into its sound (VoiceHandoff.swift).
                    store.continueVoiceHere(target: handoff, mic: handoffMic)
                } else if offkai, let store = PushCenter.shared.session?.store {
                    // 🍻 オフ会が始まった: the chat page with the 🍻 tab (聞く is one tap from there).
                    store.showChat?()
                    store.offkai.show()
                } else if let dmPeer, let store = PushCenter.shared.session?.store {
                    // ✉️ 簡易 DM: the chat page with that conversation open (its name comes with the thread).
                    store.showChat?()
                    store.dm.open(DMPeer(userId: dmPeer, name: nil, avatar: nil))
                } else {
                    PushCenter.shared.handle(action: action, messageId: messageId, postId: postId, shogiGameId: gameId, text: text)
                }
            }
            completionHandler()
        }
    }

    /// That ☗ 将棋 game is on screen now (its notification would only repeat it).
    func isShowingShogi(_ id: Int) -> Bool {
        guard UIApplication.shared.applicationState == .active, let shogi = session?.store?.shogi else { return false }
        return shogi.open && shogi.selectedId == id
    }

    // MARK: 既読で知らせを消す (read_sync)

    /// Watch what comes on screen: the notifications it covers go (a background push may not come — iOS
    /// drops them for an app swiped away — so the app also cleans up after itself). The stream's
    /// `event: sync` removes them too while the app is open.
    func attach(_ store: ChatStore) {
        store.onBecameVisible = { [weak self] in self?.cleanOnScreen() }
        store.dm.onShowing = { [weak self] peer in self?.remove(ReadSync(scope: .dm, peerId: peer)) }
        store.shogi.onShowingGame = { [weak self] id in
            guard let self, self.isShowingShogi(id) else { return }
            self.remove(ReadSync(scope: .shogi, gameId: id))
        }
        store.onReadSync = { [weak self] sync in self?.remove(sync) }
    }

    /// What is on screen now: the chat (its read mark moves to the end), an open DM, the ☗ game on the board.
    func cleanOnScreen() {
        guard UIApplication.shared.applicationState == .active, let store = session?.store else { return }
        if store.isVisible {
            remove(ReadSync(scope: .chat))
            if let id = store.shogi.selectedId, isShowingShogi(id) { remove(ReadSync(scope: .shogi, gameId: id)) }
        }
        if let peer = store.dm.openPeer, store.dm.appVisible { remove(ReadSync(scope: .dm, peerId: peer.userId)) }
    }

    /// Remove the delivered notifications this word covers (decided by ReadSync on each one's userInfo).
    nonisolated func remove(_ sync: ReadSync, then done: (@Sendable () -> Void)? = nil) {
        UNUserNotificationCenter.current().getDeliveredNotifications { list in
            let ids = list.filter { sync.matchesPush(identifier: $0.request.identifier, userInfo: $0.request.content.userInfo) }
                .map(\.request.identifier)
            if !ids.isEmpty { UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids) }
            NSLog("[push] read_sync %@: removed %d of %d", sync.scope.rawValue, ids.count, list.count)
            done?()
        }
    }

    private func handle(action: String, messageId: Int?, postId: Int?, shogiGameId: Int? = nil, text: String?) {
        switch action {
        case "reply":
            if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                session?.store?.send(text, restore: { _ in })
            }
        case "heart":
            if let messageId { session?.store?.toggleReaction(messageId, emoji: "❤️") }
        default:
            if let shogiGameId, let store = session?.store {
                // ☗ 将棋 (an offer / my move): the chat page with the game on the board.
                store.showChat?()
                store.shogi.openGame(shogiGameId)
            } else if let messageId {
                session?.store?.reveal(messageId)
            } else if let postId {
                // A reply to your post or a new post: open the thread in the app's timeline.
                if let timeline = session?.timeline {
                    timeline.openThread = postId
                } else if let url = URL(string: "https://bsm.backspace.fm/#/post/\(postId)") {
                    Platform.open(url)
                }
            }
        }
    }
}

/// UIKit hooks SwiftUI does not expose (APNs registration callbacks).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        MainActor.assumeIsolated { PushCenter.shared.configure() }
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        MainActor.assumeIsolated { PushCenter.shared.didRegister(deviceToken) }
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        NSLog("[push] registration failed: %@", error.localizedDescription)
    }

    /// A background push (content-available). read_sync: read on another device → remove the notifications
    /// it covers, then tell iOS at once (a slow answer makes it wake the app less often). Anything else: no data.
    /// The completion-handler form, called on the main thread (see willPresent above).
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any],
                     fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void) {
        guard let sync = ReadSync(payload: userInfo), userInfo["kind"] as? String == "read_sync" else {
            completionHandler(.noData)
            return
        }
        let done = CompletionBox(completionHandler)
        PushCenter.shared.remove(sync) {
            DispatchQueue.main.async { done.call(.newData) }
        }
    }
}

/// UIKit's background-fetch completion handler is not Sendable; it is only ever called once, on the main thread.
private final class CompletionBox: @unchecked Sendable {
    private let handler: (UIBackgroundFetchResult) -> Void
    init(_ handler: @escaping (UIBackgroundFetchResult) -> Void) { self.handler = handler }
    func call(_ r: UIBackgroundFetchResult) { handler(r) }
}
