import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#endif

// 🎮 散財ダッシュ above the chat: the server's /minigame/index.html in a WKWebView (the same
// part the web uses), docs/minigame-spec.md「橋渡し」(bridge_version 1). Like the ☗ board: no
// token and no cookie reach the page (a fresh non-persistent data store), it may not navigate
// anywhere, and the web view lives only while the game is open (made with the view, torn down
// with it). Hidden panel / app in the background / another page / typing in the message box →
// `pause`; back → `resume`.

struct MinigameScreen: View {
    let minigame: MinigameStore
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screenVisibility) private var visibility
    @State private var height: CGFloat = 0

    /// The game's height limit: half the chat column (150–520), so the chat keeps the other half. The game
    /// fills the width up to this (drikin 2026-10-24: it was drawn at whole multiples only and came out small).
    private var maxHeight: Int {
        let area = minigame.areaHeight > 0 ? minigame.areaHeight : 600
        return Int(min(520, max(150, area * 0.5)))
    }

    var body: some View {
        let running = (visibility?.room ?? true) && !minigame.inputFocused
        MinigameWebView(
            minigame: minigame,
            running: running,
            theme: scheme == .dark ? "dark" : "light",
            maxHeight: maxHeight,
            height: $height
        )
        // Exactly the height the game says it uses (size), never more than the limit.
        .frame(height: height > 0 ? min(height, CGFloat(maxHeight)) : CGFloat(maxHeight) * 0.6)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 2)
        .accessibilityLabel("ゲーム（散財ダッシュ）")
    }
}

@MainActor
final class MinigameController: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    private let proxy = MinigameMessageProxy()
    private let pageURL: URL
    private weak var store: MinigameStore?
    private var ready = false
    private var torn = false
    private var running = true
    private var sentRunning: Bool?
    private var theme = "light"
    private var maxHeight = 260
    private var sentLook = ""

    var onHeight: ((CGFloat) -> Void)?

    init(store: MinigameStore, theme: String, maxHeight: Int) {
        self.store = store
        self.theme = theme
        self.maxHeight = maxHeight
        var c = URLComponents(url: store.gameURL, resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "theme", value: theme), URLQueryItem(name: "max_height", value: String(maxHeight))]
        pageURL = c?.url ?? store.gameURL
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent() // never the member's B-guru cookies
        config.userContentController.add(proxy, name: "minigame")
        #if DEBUG
        if ProcessInfo.processInfo.environment["BGURU_MINIGAME_TRACE"] != nil {
            let js = "['pointerdown','pointerup','touchstart','touchend'].forEach(function(t){window.addEventListener(t,function(e){try{window.webkit.messageHandlers.minigame.postMessage({type:'trace',v:1,ev:t,x:e.clientX||0,y:e.clientY||0,tag:(e.target&&e.target.className)||''})}catch(_){}},true)})"
            config.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        }
        #endif
        #if os(iOS)
        config.dataDetectorTypes = []
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []
        #endif
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 384, height: 216), configuration: config)
        super.init()
        proxy.target = self
        webView.navigationDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        #if os(iOS)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        webView.scrollView.bounces = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        #else
        webView.setValue(false, forKey: "drawsBackground")
        webView.underPageBackgroundColor = .clear
        #endif
        #if DEBUG
        if #available(macOS 13.3, iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webView.load(URLRequest(url: pageURL))
        store.onEvent = { [weak self] data in self?.send(["type": "event", "data": data]) }
        HangWatch.note("minigame open")
    }

    func tearDown() {
        guard !torn else { return }
        torn = true
        if store?.onEvent != nil { store?.onEvent = nil }
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "minigame")
        proxy.target = nil
        onHeight = nil
        HangWatch.note("minigame closed")
    }

    /// Run or pause, and the look (theme, height limit): sent when they change.
    func update(running: Bool, theme: String, maxHeight: Int) {
        self.running = running
        self.theme = theme
        self.maxHeight = maxHeight
        flush()
    }

    private func flush() {
        guard ready, !torn else { return }
        if sentRunning != running {
            sentRunning = running
            send(["type": running ? "resume" : "pause"])
        }
        let look = "\(theme)|\(maxHeight)"
        if look != sentLook {
            sentLook = look
            send(["type": "state", "theme": theme, "max_height": maxHeight])
        }
    }

    private func send(_ m: [String: Any]) {
        guard !torn, let d = try? JSONSerialization.data(withJSONObject: m) else { return }
        let json = String(decoding: d, as: UTF8.self)
        webView.evaluateJavaScript("window.bguruMinigame&&window.bguruMinigame.receive(\(json));void 0") { _, _ in }
    }

    /// GET me → `state` (the info, with the theme and the height limit).
    private func sendInfo() {
        guard let store else { return }
        Task { @MainActor [weak self] in
            let (status, body) = await store.me()
            guard let self, (200..<300).contains(status) else { return }
            var m = body
            m["apiVersion"] = nil
            m["type"] = "state"
            m["theme"] = self.theme
            m["max_height"] = self.maxHeight
            self.send(m)
        }
    }

    /// An answer to a request (matched by `req`): the body, or `{ req, error, code }`.
    private func reply(_ key: String, req: Int, status: Int, body: [String: Any], payload: Any?) {
        if (200..<300).contains(status), var p = payload as? [String: Any] {
            p["req"] = req
            send(["type": "state", key: p])
        } else {
            let error = (body["error"] as? String) ?? (status == 0 ? "通信できませんでした" : "うまくいきませんでした（\(status)）")
            send(["type": "state", key: ["req": req, "error": error, "code": (body["code"] as? String) ?? (status == 0 ? "offline" : "error")]])
        }
    }

    fileprivate func receive(_ body: Any) {
        guard !torn, let m = body as? [String: Any], let type = m["type"] as? String, let store else { return }
        let req = (m["req"] as? NSNumber)?.intValue ?? 0
        switch type {
        case "ready":
            ready = true
            sentRunning = nil
            sentLook = "\(theme)|\(maxHeight)" // the page was opened with these
            if let v = (m["engine_version"] as? NSNumber)?.intValue { store.noteEngine(v) }
            sendInfo()
            flush()
        case "request_info":
            sendInfo()
        case "request_play":
            let mode = (m["mode"] as? String) ?? "free"
            let character = (m["character"] as? String) ?? "drikin"
            Task { @MainActor [weak self] in
                let (status, b) = await store.requestPlay(mode: mode, character: character)
                self?.reply("play", req: req, status: status, body: b, payload: b["play"])
            }
        case "finished":
            guard let playId = (m["play_id"] as? NSNumber)?.intValue else { return }
            let inputs = ((m["inputs"] as? [NSNumber]) ?? []).map(\.intValue)
            let engine = (m["engine_version"] as? NSNumber)?.intValue ?? 1
            let score = (m["score"] as? NSNumber)?.intValue
            let ticks = (m["ticks"] as? NSNumber)?.intValue
            Task { @MainActor [weak self] in
                let (status, b) = await store.finish(playId: playId, inputs: inputs, engineVersion: engine, score: score, ticks: ticks)
                self?.reply("result", req: req, status: status, body: b, payload: b["result"])
            }
        case "request_leaderboard":
            let period = (m["period"] as? String) ?? "today"
            Task { @MainActor [weak self] in
                let (status, b) = await store.leaderboard(period: period)
                var p = b
                p["apiVersion"] = nil
                self?.reply("leaderboard", req: req, status: status, body: b, payload: p)
            }
        case "haptic":
            #if os(iOS)
            switch m["kind"] as? String {
            case "dead", "hit": UINotificationFeedbackGenerator().notificationOccurred(.error)
            case "highscore", "powerup": UINotificationFeedbackGenerator().notificationOccurred(.success)
            default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            #endif
        case "size":
            if let h = (m["height"] as? NSNumber)?.doubleValue, h > 40, h < 2000 { onHeight?(CGFloat(h)) }
        case "trace":
            NSLog("[minigame-trace] %@", String(describing: m))
        case "error":
            HangWatch.note("minigame error: \(String(((m["message"] as? String) ?? "").prefix(120)))")
        default:
            break
        }
    }

    /// Only the game page itself (its script comes as a subresource, not a navigation).
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == pageURL.scheme, url.host == pageURL.host, url.port == pageURL.port,
           url.path == pageURL.path, action.targetFrame?.isMainFrame == true { return .allow }
        return .cancel
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard !torn else { return }
        ready = false
        HangWatch.note("minigame process ended; reloading")
        webView.load(URLRequest(url: pageURL))
    }

    fileprivate func isGamePage(_ origin: WKSecurityOrigin) -> Bool {
        origin.host == pageURL.host && origin.protocol == pageURL.scheme
    }
}

/// The page's messages, kept weak (the content controller holds its handler strongly).
@MainActor
private final class MinigameMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: MinigameController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let target, message.frameInfo.isMainFrame, target.isGamePage(message.frameInfo.securityOrigin) else { return }
        target.receive(message.body)
    }
}

#if os(iOS)
struct MinigameWebView: UIViewRepresentable {
    let minigame: MinigameStore
    let running: Bool
    let theme: String
    let maxHeight: Int
    @Binding var height: CGFloat

    func makeCoordinator() -> MinigameController { MinigameController(store: minigame, theme: theme, maxHeight: maxHeight) }

    /// The same holder as the ☗ board: a tap or drag on the game never moves the page.
    func makeUIView(context: Context) -> ShogiBoardContainer { ShogiBoardContainer(web: context.coordinator.webView) }

    func updateUIView(_ uiView: ShogiBoardContainer, context: Context) {
        let c = context.coordinator
        let height = $height
        c.onHeight = { h in if abs(height.wrappedValue - h) > 0.5 { height.wrappedValue = h } }
        c.update(running: running, theme: theme, maxHeight: maxHeight)
    }

    static func dismantleUIView(_ uiView: ShogiBoardContainer, coordinator: MinigameController) {
        coordinator.tearDown()
    }
}
#else
struct MinigameWebView: NSViewRepresentable {
    let minigame: MinigameStore
    let running: Bool
    let theme: String
    let maxHeight: Int
    @Binding var height: CGFloat

    func makeCoordinator() -> MinigameController { MinigameController(store: minigame, theme: theme, maxHeight: maxHeight) }

    func makeNSView(context: Context) -> WKWebView { context.coordinator.webView }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        let c = context.coordinator
        let height = $height
        c.onHeight = { h in if abs(height.wrappedValue - h) > 0.5 { height.wrappedValue = h } }
        c.update(running: running, theme: theme, maxHeight: maxHeight)
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: MinigameController) {
        coordinator.tearDown()
    }
}
#endif
