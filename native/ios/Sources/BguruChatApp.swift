import SwiftUI

/// B-guru Chat for iPhone / iPad. Same core as the Mac app (native/shared):
/// agent API, live stream, optimistic send, Keychain token.
@main
struct BguruChatApp: App {
    @State private var session = Session()

    var body: some Scene {
        WindowGroup {
            Group {
                if let store = session.store {
                    ChatScreen(store: store, onSignOut: { session.signOut() })
                } else {
                    NavigationStack {
                        LoginView { token in session.signIn(token: token) }
                            .navigationTitle("B-guru にログイン")
                            .navigationBarTitleDisplayMode(.inline)
                    }
                }
            }
            .tint(Color.accentGreen)
        }
    }
}

/// Signed-in state: a ChatStore while a token exists (Keychain, this device only).
@MainActor
@Observable
final class Session {
    private(set) var store: ChatStore?

    init() {
        #if DEBUG
        // Dev only: SIMCTL_CHILD_BGURU_DEV_TOKEN=bga_… runs without the Keychain.
        if let dev = ProcessInfo.processInfo.environment["BGURU_DEV_TOKEN"], !dev.isEmpty {
            start(token: dev)
            return
        }
        #endif
        if let token = Keychain.load() { start(token: token) }
    }

    func signIn(token: String) {
        Keychain.save(token)
        start(token: token)
    }

    func signOut() {
        let token = store?.token
        store?.stop()
        store = nil
        Keychain.delete()
        if let token { Task { await APIClient(token: token).revokeSelf() } }
    }

    private func start(token: String) {
        let s = ChatStore(api: APIClient(token: token))
        store = s
        s.start()
        observeSignOut(s)
    }

    /// The server revoked the token / membership ended → back to login.
    private func observeSignOut(_ s: ChatStore) {
        withObservationTracking { _ = s.signedOut } onChange: { [weak self] in
            Task { @MainActor in
                guard let self, self.store === s else { return }
                if s.signedOut { self.signOut() } else { self.observeSignOut(s) }
            }
        }
    }
}
