import SwiftUI
import AVFoundation

/// B-guru Chat for iPhone / iPad. Same core as the Mac app (native/shared):
/// agent API, live stream, optimistic send, Keychain token.
@main
struct BguruChatApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = Session()

    var body: some Scene {
        WindowGroup {
            Group {
                if let store = session.store, let timeline = session.timeline {
                    MainView(store: store, timeline: timeline, onSignOut: { session.signOut() })
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
    private(set) var timeline: TimelineStore?
    private(set) var api: APIClient?

    init() {
        #if DEBUG
        // Dev only: SIMCTL_CHILD_BGURU_DEV_TOKEN=bga_… runs without the Keychain.
        if let dev = ProcessInfo.processInfo.environment["BGURU_DEV_TOKEN"], !dev.isEmpty {
            Keychain.save(dev) // so the Notification Service Extension can fill pushes in the simulator
            start(token: dev)
            return
        }
        // Dev only: SIMCTL_CHILD_BGURU_DEMO=1 → sample chat, sends succeed offline.
        if ProcessInfo.processInfo.environment["BGURU_DEMO"] == "1" {
            let s = ChatStore(api: APIClient(token: "demo"))
            s.debugOffline = true
            s.debugLoadDemo()
            if ProcessInfo.processInfo.environment["BGURU_DEMO_ROOM"] == "1" { s.room.debugLoadDemo() }
            if ProcessInfo.processInfo.environment["BGURU_DEMO_JUKEBOX"] != nil {
                s.jukebox.debugLoadDemo(base: ProcessInfo.processInfo.environment["BGURU_DEMO_AUDIO"])
                // BGURU_DEMO_JUKEBOX_PLAY=1: start today's record (checks that other sounds do not stop it).
                if ProcessInfo.processInfo.environment["BGURU_DEMO_JUKEBOX_PLAY"] != nil, let e = s.jukebox.todayEpisode {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { s.jukebox.play(e) }
                }
                // BGURU_TRACE_AUDIO=1: log the record's state every 2 s and any audio interruption (checks
                // that the game's sounds do not stop it).
                if ProcessInfo.processInfo.environment["BGURU_TRACE_AUDIO"] != nil {
                    let jukebox = s.jukebox
                    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
                        MainActor.assumeIsolated {
                            NSLog("[audio-trace] playing=%d position=%.1f category=%@", jukebox.isPlaying ? 1 : 0, jukebox.position,
                                  AVAudioSession.sharedInstance().category.rawValue)
                        }
                    }
                    NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { n in
                        NSLog("[audio-trace] interruption %@", String(describing: n.userInfo ?? [:]))
                    }
                }
            }
            // BGURU_DEMO_SHOGI_OPEN=lobby | <game id>: open ☗ 将棋 at once (101 = my game, 102 = to watch).
            if let open = ProcessInfo.processInfo.environment["BGURU_DEMO_SHOGI_OPEN"] {
                if let id = Int(open) { s.shogi.openGame(id) } else { s.shogi.show() }
            }
            // BGURU_DEMO_MINIGAME_OPEN=1: 🎮 open at once (answered locally, nothing is sent).
            if ProcessInfo.processInfo.environment["BGURU_DEMO_MINIGAME_OPEN"] != nil { s.minigame.show() }
            store = s
            let t = TimelineStore(api: APIClient(token: "demo"))
            t.debugLoadDemo()
            timeline = t
            // BGURU_DEMO_THREAD_CHECK=1: the long-thread check (scripts/thread-check.sh).
            ThreadCheck.runIfAsked(timeline: t)
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
        let api = self.api
        store?.stop()
        store = nil
        timeline = nil
        MediaCache.shared.token = nil
        self.api = nil
        PushCenter.shared.session = nil
        Keychain.delete()
        if let api {
            Task {
                await PushCenter.shared.disable(api: api)
                await api.revokeSelf()
            }
        }
    }

    private func start(token: String) {
        let api = APIClient(token: token)
        let s = ChatStore(api: api)
        self.api = api
        store = s
        timeline = TimelineStore(api: api)
        MediaCache.shared.token = token
        s.start()
        observeSignOut(s)
        PushCenter.shared.session = self
        PushCenter.shared.enable()
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
