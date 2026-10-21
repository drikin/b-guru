import SwiftUI
import WebKit
#if os(iOS)
import UIKit
import UIKit.UIGestureRecognizerSubclass
#endif

// The ☗ 将棋 board: the server's /shogi-board/index.html in a WKWebView (the same part the
// web uses). It only draws: the position goes in with `window.shogiBoard.receive(msg)`, and
// what the member does comes back through `webkit.messageHandlers.shogi` (ready / move /
// haptic / flip / size / close / error, v: 1) — docs/shogi-spec.md「盤面の橋渡し」.
// No token and no cookie ever reach this page (a fresh non-persistent data store), and it
// may not navigate anywhere else.
//
// The web view exists only while a game is on the ☗ 将棋 screen: SwiftUI makes it with the
// view (makeCoordinator) and it is torn down when the view goes (dismantle). The chat's
// pages / tabs stay built while switching, so switching does not make it again.

@MainActor
final class ShogiBoardController: NSObject, WKNavigationDelegate {
    let webView: WKWebView
    private let proxy = ShogiMessageProxy()
    private let pageURL: URL
    private var ready = false
    private var sentStateKey = ""
    private var sentLabels = ""
    private var stateJSON = ""
    private var stateKey = ""
    private var labelsJSON = ""
    private var torn = false

    var onMove: ((String, String) -> Void)?
    var onFlip: ((ShogiSide) -> Void)?
    var onHeight: ((CGFloat) -> Void)?

    init(url: URL) {
        pageURL = url
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent() // never the member's B-guru cookies
        config.userContentController.add(proxy, name: "shogi")
        #if os(iOS)
        config.dataDetectorTypes = []
        #endif
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 360, height: 420), configuration: config)
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
        webView.load(URLRequest(url: url))
        HangWatch.note("shogi board open")
    }

    func tearDown() {
        guard !torn else { return }
        torn = true
        webView.stopLoading()
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "shogi")
        proxy.target = nil
        onMove = nil; onFlip = nil; onHeight = nil
        HangWatch.note("shogi board closed")
    }

    /// The latest `state` (sent again only when it changed, or the server answered a move)
    /// and `labels` (names and clocks, every second during a fast game).
    func update(state: String, key: String, revision: Int, labels: String) {
        stateJSON = state
        stateKey = "\(revision)|\(key)"
        labelsJSON = labels
        flush()
    }

    private func flush() {
        guard ready, !torn else { return }
        if stateKey != sentStateKey {
            sentStateKey = stateKey
            sentLabels = labelsJSON // the state carries the labels too
            send(stateJSON)
        } else if labelsJSON != sentLabels {
            sentLabels = labelsJSON
            send(labelsJSON)
        }
    }

    private func send(_ json: String) {
        webView.evaluateJavaScript("window.shogiBoard&&window.shogiBoard.receive(\(json));void 0") { _, _ in }
    }

    fileprivate func receive(_ body: Any) {
        guard !torn, let m = body as? [String: Any], let type = m["type"] as? String else { return }
        switch type {
        case "ready":
            ready = true
            sentStateKey = ""
            flush()
        case "move":
            guard let usi = m["usi"] as? String, usi.count <= 6 else { return }
            onMove?(usi, (m["label"] as? String) ?? "")
        case "haptic":
            #if os(iOS)
            switch m["kind"] as? String {
            case "move": UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            case "error": UINotificationFeedbackGenerator().notificationOccurred(.error)
            default: UIImpactFeedbackGenerator(style: .light).impactOccurred()
            }
            #endif
        case "flip":
            if let o = (m["orientation"] as? String).flatMap(ShogiSide.init(rawValue:)) { onFlip?(o) }
        case "size":
            if let h = (m["height"] as? NSNumber)?.doubleValue, h > 40, h < 4000 {
                onHeight?(CGFloat(h) + 12) // + the page's own padding (6 px above and below)
            }
        case "error":
            HangWatch.note("shogi board error: \(String(((m["message"] as? String) ?? "").prefix(120)))")
        default:
            break // close: the app has its own way back; unknown types are ignored
        }
    }

    /// Only the board page itself (its JS and font come as subresources, not navigations).
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == pageURL.scheme, url.host == pageURL.host, url.port == pageURL.port,
           url.path == pageURL.path, action.targetFrame?.isMainFrame == true { return .allow }
        return .cancel
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        // The page's process went away (memory pressure): load it again; `ready` resends the position.
        guard !torn else { return }
        ready = false
        HangWatch.note("shogi board process ended; reloading")
        webView.load(URLRequest(url: pageURL))
    }

    fileprivate func isBoardPage(_ origin: WKSecurityOrigin) -> Bool {
        origin.host == pageURL.host && origin.protocol == pageURL.scheme
    }
}

/// The page's messages, kept weak (the content controller holds its handler strongly).
@MainActor
private final class ShogiMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: ShogiBoardController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let target, message.frameInfo.isMainFrame, target.isBoardPage(message.frameInfo.securityOrigin) else { return }
        target.receive(message.body)
    }
}

/// The board in SwiftUI. `state` / `labels` are the JSON messages (see ShogiGameView).
#if os(iOS)
struct ShogiBoardWebView: UIViewRepresentable {
    let url: URL
    /// The full `state` message, and the same without the clocks (what decides a resend).
    let state: String
    let stateKey: String
    let revision: Int
    let labels: String
    let onMove: (String, String) -> Void
    let onFlip: (ShogiSide) -> Void
    @Binding var height: CGFloat

    func makeCoordinator() -> ShogiBoardController { ShogiBoardController(url: url) }

    func makeUIView(context: Context) -> ShogiBoardContainer {
        ShogiBoardContainer(web: context.coordinator.webView)
    }

    func updateUIView(_ uiView: ShogiBoardContainer, context: Context) {
        let c = context.coordinator
        c.onMove = onMove
        c.onFlip = onFlip
        let height = $height
        c.onHeight = { h in if abs(height.wrappedValue - h) > 0.5 { height.wrappedValue = h } }
        c.update(state: state, key: stateKey, revision: revision, labels: labels)
    }

    static func dismantleUIView(_ uiView: ShogiBoardContainer, coordinator: ShogiBoardController) {
        coordinator.tearDown()
    }
}

/// Holds the web view. On the board, a sideways drag moves a piece, never the page: every
/// scroll view around it (the iPhone's page pager, a list) waits for the touch on the board
/// to end before it may pan.
final class ShogiBoardContainer: UIView {
    let web: WKWebView
    private let blocker = BoardTouchBlocker()

    init(web: WKWebView) {
        self.web = web
        super.init(frame: .zero)
        backgroundColor = .clear
        web.frame = bounds
        web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        addSubview(web)
        web.addGestureRecognizer(blocker)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        guard window != nil else { return }
        var v = superview
        while let view = v {
            if let scroll = view as? UIScrollView { scroll.panGestureRecognizer.require(toFail: blocker) }
            v = view.superview
        }
    }
}

/// "Recognises" any touch on the board at once and keeps it until it ends — so the scroll
/// views that must wait for it to fail never start. It never cancels or delays the page's
/// own touches.
private final class BoardTouchBlocker: UIGestureRecognizer, UIGestureRecognizerDelegate {
    init() {
        super.init(target: nil, action: nil)
        cancelsTouchesInView = false
        delaysTouchesBegan = false
        delaysTouchesEnded = false
        delegate = self
    }

    override func touchesBegan(_ touches: Set<UITouch>, with event: UIEvent) {
        state = state == .possible ? .began : .changed
    }

    override func touchesMoved(_ touches: Set<UITouch>, with event: UIEvent) {
        if state == .began || state == .changed { state = .changed }
    }

    override func touchesEnded(_ touches: Set<UITouch>, with event: UIEvent) {
        let left = (event.allTouches ?? []).filter { $0.phase != .ended && $0.phase != .cancelled && $0.view?.isDescendant(of: view ?? UIView()) == true }
        if left.isEmpty { state = .ended }
    }

    override func touchesCancelled(_ touches: Set<UITouch>, with event: UIEvent) {
        state = .cancelled
    }

    func gestureRecognizer(_ g: UIGestureRecognizer, shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer) -> Bool { true }
}
#else
struct ShogiBoardWebView: NSViewRepresentable {
    let url: URL
    /// The full `state` message, and the same without the clocks (what decides a resend).
    let state: String
    let stateKey: String
    let revision: Int
    let labels: String
    let onMove: (String, String) -> Void
    let onFlip: (ShogiSide) -> Void
    @Binding var height: CGFloat

    func makeCoordinator() -> ShogiBoardController { ShogiBoardController(url: url) }

    func makeNSView(context: Context) -> WKWebView { context.coordinator.webView }

    func updateNSView(_ nsView: WKWebView, context: Context) {
        let c = context.coordinator
        c.onMove = onMove
        c.onFlip = onFlip
        let height = $height
        c.onHeight = { h in if abs(height.wrappedValue - h) > 0.5 { height.wrappedValue = h } }
        c.update(state: state, key: stateKey, revision: revision, labels: labels)
    }

    static func dismantleNSView(_ nsView: WKWebView, coordinator: ShogiBoardController) {
        coordinator.tearDown()
    }
}
#endif
