import Foundation
import Sparkle

/// Automatic updates (Sparkle 2). The appcast and the DMG are members-only on
/// the server, so every Sparkle request carries this Mac's agent token.
/// Updates must be signed with the project's EdDSA key (SUPublicEDKey) — an
/// unsigned or tampered file is refused by Sparkle itself.
///
/// Debug builds never check (a dev build must not replace itself with a release).
@MainActor
final class Updater: NSObject, SPUUpdaterDelegate {
    static let shared = Updater()

    private var controller: SPUStandardUpdaterController?

    /// Start checking once we have a token (before login the appcast is 401).
    func start(token: String) {
        #if DEBUG
        return
        #else
        if controller == nil {
            controller = SPUStandardUpdaterController(startingUpdater: false, updaterDelegate: self, userDriverDelegate: nil)
        }
        guard let updater = controller?.updater else { return }
        updater.httpHeaders = ["Authorization": "Bearer \(token)"]
        if !updater.sessionInProgress {
            do {
                try updater.start()
            } catch {
                NSLog("[updater] start failed: %@", String(describing: error))
            }
        }
        #endif
    }

    /// Signed out: stop sending the old token.
    func stop() {
        controller?.updater.httpHeaders = nil
    }

    var canCheck: Bool {
        #if DEBUG
        return false
        #else
        return controller?.updater.canCheckForUpdates ?? false
        #endif
    }

    /// Menu: "アップデートを確認…"
    func checkNow() {
        controller?.checkForUpdates(nil)
    }

    var currentVersion: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "?"
    }
}
