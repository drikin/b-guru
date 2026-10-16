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

    private func syncSettings() {
        guard let hex = deviceToken, let api = session?.api else { return }
        let platform = UIDevice.current.userInterfaceIdiom == .pad ? "ipados" : "ios"
        let mode = notifyMode, quiet = quietHours
        Task {
            try? await api.registerPush(deviceToken: hex, environment: Self.environment, platform: platform,
                                        notifyMode: mode, quietHours: quiet)
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
        let options: UNNotificationPresentationOptions = kind == "chat_mention" || kind == "chat_new" ? [] : [.banner, .sound]
        DispatchQueue.main.async { completionHandler(options) }
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter,
                                            didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping @Sendable () -> Void) {
        let info = response.notification.request.content.userInfo
        let messageId = (info["message_id"] as? NSNumber)?.intValue
        let postId = (info["post_id"] as? NSNumber)?.intValue
        let action = response.actionIdentifier
        let text = (response as? UNTextInputNotificationResponse)?.userText
        DispatchQueue.main.async {
            MainActor.assumeIsolated {
                PushCenter.shared.handle(action: action, messageId: messageId, postId: postId, text: text)
            }
            completionHandler()
        }
    }

    private func handle(action: String, messageId: Int?, postId: Int?, text: String?) {
        switch action {
        case "reply":
            if let text, !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                session?.store?.send(text, restore: { _ in })
            }
        case "heart":
            if let messageId { session?.store?.toggleReaction(messageId, emoji: "❤️") }
        default:
            if let messageId {
                session?.store?.reveal(messageId)
            } else if let postId {
                // A reply to your post: open the thread in the app's timeline.
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
}
