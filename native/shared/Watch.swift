import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#else
import AppKit
#endif

// 📺 YouTube 共同鑑賞 (lib/watch.ts). The player is the server's /watch/index.html in a WKWebView — the same
// page the web shows — loaded from production (YouTube refuses an embed without a real https origin:
// errors 152/153). The page keeps no token: its actions come here and go to /api/agent/watch/action with the
// member's token; the state (GET state, each action's answer, the stream's `watch`) goes back to the page.
// While the player is open its web view lives in the store (not in a view), so moving it between the chat
// column and the floating window (iPhone) / its own window (Mac) never restarts the video. Main-actor only.

@MainActor
@Observable
final class WatchStore {
    enum Mode: String { case docked, floating }

    /// On for this member (capabilities `features.watch.enabled`, bridge 1).
    private(set) var enabled = false
    /// This token may operate (the "chat" scope); without it the page only shows.
    private(set) var canControl = true
    private(set) var path = "/api/agent/watch"
    private(set) var playerPath = "/watch/index.html"
    private(set) var open = false
    private(set) var mode: Mode = .docked
    /// What is on (for the 📺 button and the floating window's title): nil = nothing.
    private(set) var title: String?
    private(set) var playing = false
    /// The chat column's height (docked takes at most ~half of it).
    private(set) var areaHeight: CGFloat = 0
    func setAreaHeight(_ h: CGFloat) { if abs(h - areaHeight) > 1 { areaHeight = h } }

    /// The player's web view (made when first opened, kept while open).
    @ObservationIgnored private(set) var controller: WatchController?
    /// The latest state as the server sent it (passed to the page as is).
    @ObservationIgnored private var lastState: [String: Any]?
    @ObservationIgnored private var lastVersion = -1
    /// Mac: the player's own window comes and goes with the mode (set by the app).
    @ObservationIgnored var onModeChange: (@MainActor (Mode) -> Void)?
    /// About to open (chat overlay: from outside the switch row it is switched on, and expanded unless floating).
    @ObservationIgnored var willShow: (@MainActor (_ floating: Bool) -> Void)?
    /// Chat overlay: the page draws only the picture and its bar (a small window) — nil: as the mode says.
    @ObservationIgnored var compactOverride: Bool? {
        didSet { if compactOverride != oldValue { controller?.sendLayout() } }
    }

    private let api: APIClient

    init(api: APIClient) {
        self.api = api
    }

    var playerURL: URL {
        #if DEBUG
        if let s = ProcessInfo.processInfo.environment["BGURU_WATCH_URL"], let u = URL(string: s) { return u }
        #endif
        return APIClient.baseURL.appendingPathComponent(playerPath)
    }

    func configure(_ f: Capabilities.WatchFeatures?, enabled on: Bool) {
        if let p = f?.path, p.hasPrefix("/api/") { path = p }
        if let p = f?.playerUrl, p.hasPrefix("/watch/") { playerPath = p }
        canControl = f?.control ?? true
        enabled = on
        if on { Task { await reload() } } else { close() }
        #if DEBUG
        // Dev only: BGURU_WATCH_FAKE_VIDEO=ID — this app alone shows that video playing (nothing is sent;
        // the server's state is not changed, no chat line). For checking the player in the app.
        if on, let id = ProcessInfo.processInfo.environment["BGURU_WATCH_FAKE_VIDEO"] {
            canControl = false
            let now = Date().timeIntervalSince1970 * 1000
            take(["version": 999_999, "video": ["video_id": id, "title": "試し（この端末だけ）", "channel": NSNull(), "by": NSNull()],
                  "playing": true, "position": 0, "updated_at": now, "server_now": now, "last": NSNull(), "queue": [],
                  "youtube_host": "www.youtube.com"], force: true)
            lastVersion = Int.max
            show()
        }
        #endif
    }

    #if DEBUG
    /// The demo (BGURU_DEMO=1 + BGURU_DEMO_OVERLAY=1): 📺 on, nothing can be operated (with BGURU_WATCH_FAKE_VIDEO=ID
    /// that video plays on this device only). Only reads (the state, the player page) — nothing is sent.
    func debugLoadDemo() {
        configure(nil, enabled: true)
        canControl = false
    }
    #endif

    func show(_ m: Mode? = nil) {
        guard enabled else { return }
        willShow?(m == .floating)
        if controller == nil { controller = WatchController(store: self) }
        open = true
        if let m { setMode(m) }
        HangWatch.note("watch open (\(mode.rawValue))")
    }

    func toggle() { open ? close() : show() }

    func close() {
        guard open || controller != nil else { return }
        open = false
        if mode == .floating { mode = .docked; onModeChange?(.docked) }
        controller?.tearDown()
        controller = nil
        HangWatch.note("watch closed")
    }

    /// iOS: the app went to the background or came back. Pauses the video on this phone only
    /// (nothing is sent to the others: it would stop it for everyone) and lines up with the
    /// shared state again on return — decoding a video nobody sees cost battery.
    func setBackground(_ on: Bool) {
        inBackground = on
        if on { controller?.sendSuspend(true); return }
        // The shared state first (where the video is now), then play: resuming at once would
        // play the old place for a moment.
        Task { await reload(); controller?.sendSuspend(false) }
    }
    /// Sent again when the page (re)loads while the app is away.
    @ObservationIgnored private(set) var inBackground = false

    func setMode(_ m: Mode) {
        guard m != mode else { return }
        mode = m
        controller?.sendLayout()
        onModeChange?(m)
    }

    /// The page's ⧉: chat column ⇄ floating / own window.
    func togglePopout() { setMode(mode == .docked ? .floating : .docked) }

    /// The page is small (floating on a phone): only the picture and the bar.
    var compact: Bool {
        if let compactOverride { return compactOverride }
        #if os(iOS)
        return mode == .floating
        #else
        return false
        #endif
    }

    // MARK: State

    /// GET state (on start, on the stream's reconnect).
    func reload() async {
        guard enabled else { return }
        #if DEBUG
        if ProcessInfo.processInfo.environment["BGURU_WATCH_FAKE_VIDEO"] != nil { return }
        #endif
        let r = await api.minigameRaw("GET", path: "\(path)/state")
        guard r.0 == 200, let obj = (try? JSONSerialization.jsonObject(with: r.1)) as? [String: Any],
              let s = obj["state"] as? [String: Any] else { return }
        take(s, force: true)
    }

    /// The stream's `event: watch` ({ state }).
    func apply(_ data: Data) {
        guard enabled, let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let s = obj["state"] as? [String: Any] else { return }
        take(s)
    }

    private func take(_ s: [String: Any], force: Bool = false) {
        let v = (s["version"] as? NSNumber)?.intValue ?? 0
        if !force, v < lastVersion { return }
        lastVersion = v
        lastState = s
        let video = s["video"] as? [String: Any]
        let t = video?["title"] as? String
        if title != t { title = t }
        let p = video != nil && ((s["playing"] as? Bool) ?? false)
        if playing != p { playing = p }
        controller?.sendState(s)
    }

    var currentState: [String: Any]? { lastState }

    /// An action from the page (or a 「みんなで見る」 button) → the API; the answer's state back.
    @discardableResult
    func act(_ body: [String: any Sendable]) async -> Bool {
        guard enabled, canControl else { return false }
        let r = await api.minigameRaw("POST", path: "\(path)/action", json: body)
        let obj = (try? JSONSerialization.jsonObject(with: r.1)) as? [String: Any] ?? [:]
        if r.0 == 200, let s = obj["state"] as? [String: Any] {
            take(s)
            return true
        }
        let message = (obj["error"] as? String) ?? (r.0 == 0 ? "通信できませんでした" : "うまくいきませんでした（\(r.0)）")
        controller?.sendError(message)
        HangWatch.note("watch action refused: \(r.0) \((obj["code"] as? String) ?? "")")
        return false
    }

    /// A YouTube link's 「みんなで見る」: on now when nothing is, otherwise into the list. Opens the player.
    func watchTogether(_ url: String, floating: Bool = false) {
        guard enabled else { return }
        #if os(iOS)
        // From the timeline: float over it (the docked player is on the chat page).
        show(floating && !open ? .floating : nil)
        #else
        show()
        #endif
        let busy = (lastState?["video"] as? [String: Any]) != nil
        Task { await act(["action": busy ? "queue_add" : "load", "url": url]) }
    }

    /// A YouTube video link (the 「みんなで見る」 mark; the server checks it).
    static func isVideoURL(_ s: String) -> Bool {
        guard let u = URL(string: s), let host = u.host?.lowercased() else { return false }
        let id = #"^[A-Za-z0-9_-]{11}$"#
        if host == "youtu.be" { return u.pathComponents.dropFirst().first.map { $0.range(of: id, options: .regularExpression) != nil } ?? false }
        guard host == "youtube.com" || host.hasSuffix(".youtube.com") else { return false }
        if let v = URLComponents(url: u, resolvingAgainstBaseURL: false)?.queryItems?.first(where: { $0.name == "v" })?.value,
           v.range(of: id, options: .regularExpression) != nil { return true }
        let parts = u.pathComponents
        return parts.count >= 3 && ["shorts", "live", "embed"].contains(parts[1]) && parts[2].range(of: id, options: .regularExpression) != nil
    }
}

extension EnvironmentValues {
    /// 📺 for the 「みんなで見る」 buttons on YouTube links (nil when off for this member).
    @Entry var watch: WatchStore? = nil
}

extension WatchStore {
    /// The first YouTube video link in a chat message (its 「みんなで見る」).
    nonisolated static func firstVideoURL(in text: String) -> String? {
        guard text.contains("youtu"), let d = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) else { return nil }
        for m in d.matches(in: text, range: NSRange(text.startIndex..., in: text)) {
            if let u = m.url?.absoluteString, MainActor.assumeIsolated({ WatchStore.isVideoURL(u) }) { return u }
        }
        return nil
    }
}

// MARK: - The player's web view

@MainActor
final class WatchController: NSObject, WKNavigationDelegate, WKUIDelegate {
    let webView: WKWebView
    private let proxy = WatchMessageProxy()
    private let pageURL: URL
    private weak var store: WatchStore?
    private var ready = false
    private var torn = false

    init(store: WatchStore) {
        self.store = store
        pageURL = store.playerURL
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .nonPersistent() // never the member's B-guru cookies
        config.userContentController.add(proxy, name: "watch")
        config.mediaTypesRequiringUserActionForPlayback = [] // joins with the sound on (the page has 🔊 too)
        #if os(iOS)
        config.dataDetectorTypes = []
        config.allowsInlineMediaPlayback = true
        config.allowsPictureInPictureMediaPlayback = false
        #endif
        webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 384, height: 300), configuration: config)
        super.init()
        proxy.target = self
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        #if os(iOS)
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        #endif
        #if DEBUG
        if #available(macOS 13.3, iOS 16.4, *) { webView.isInspectable = true }
        #endif
        webView.load(URLRequest(url: pageURL))
    }

    func tearDown() {
        guard !torn else { return }
        torn = true
        webView.stopLoading()
        webView.loadHTMLString("", baseURL: nil) // stop the sound now
        webView.navigationDelegate = nil
        webView.uiDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "watch")
        proxy.target = nil
        webView.removeFromSuperview()
    }

    private func send(_ m: [String: Any]) {
        guard ready, !torn, let d = try? JSONSerialization.data(withJSONObject: m) else { return }
        let json = String(decoding: d, as: UTF8.self)
        webView.evaluateJavaScript("window.bguruWatch&&window.bguruWatch.receive(\(json));void 0") { _, _ in }
    }

    func sendState(_ s: [String: Any]) { send(["type": "state", "state": s]) }
    func sendError(_ message: String) { send(["type": "error", "message": message]) }
    func sendLayout() { send(["type": "layout", "compact": store?.compact ?? false]) }
    func sendSuspend(_ on: Bool) { send(["type": "suspend", "on": on]) }

    fileprivate func receive(_ body: Any) {
        guard !torn, let m = body as? [String: Any], let type = m["type"] as? String, let store else { return }
        switch type {
        case "ready":
            ready = true
            #if os(iOS)
            let platform = "ios"
            #else
            let platform = "mac"
            #endif
            send(["type": "hello", "bridge": 1, "platform": platform, "can_control": store.canControl, "compact": store.compact])
            if store.inBackground { sendSuspend(true) } // the page (re)loaded while away
            if let s = store.currentState { sendState(s) }
        case "action":
            guard let b = m["body"] as? [String: Any], let action = b["action"] as? String else { return }
            var body: [String: any Sendable] = ["action": action]
            for (k, v) in b where k != "action" {
                if let s = v as? String { body[k] = s } else if let n = v as? NSNumber { body[k] = n.doubleValue }
            }
            Task { await store.act(body) }
        case "popout":
            store.togglePopout()
        default:
            break // unknown messages from a newer page
        }
    }

    // The page itself in the main frame; YouTube (and what it loads) only inside its own frames.
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if action.targetFrame?.isMainFrame == true {
            if url.scheme == pageURL.scheme, url.host == pageURL.host, url.port == pageURL.port, url.path == pageURL.path { return .allow }
            if action.navigationType == .linkActivated { openOutside(url) }
            return .cancel
        }
        // Subframes: the YouTube player (and the frames it opens itself). https only.
        return url.scheme == "https" || url.scheme == "about" ? .allow : .cancel
    }

    /// 「YouTube で見る」 and other links that ask for a new window: the browser, never this view.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction,
                 windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url { openOutside(url) }
        return nil
    }

    private func openOutside(_ url: URL) {
        guard url.scheme == "https" else { return }
        #if os(iOS)
        UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        guard !torn else { return }
        ready = false
        HangWatch.note("watch process ended; reloading")
        webView.load(URLRequest(url: pageURL))
    }

    fileprivate func isPlayerPage(_ origin: WKSecurityOrigin) -> Bool {
        origin.host == pageURL.host && origin.protocol == pageURL.scheme
    }
}

/// The page's messages, kept weak (the content controller holds its handler strongly).
@MainActor
private final class WatchMessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: WatchController?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let target, message.frameInfo.isMainFrame, target.isPlayerPage(message.frameInfo.securityOrigin) else { return }
        target.receive(message.body)
    }
}

// MARK: - Where the player is shown

/// The store's web view, put into this place (taken from wherever it was). Nothing is torn down when the
/// place goes: the store keeps the player until it is closed.
#if os(iOS)
struct WatchPlayerHost: UIViewRepresentable {
    let watch: WatchStore

    func makeUIView(context: Context) -> UIView {
        let v = UIView()
        v.backgroundColor = .black
        v.clipsToBounds = true
        return v
    }

    func updateUIView(_ uiView: UIView, context: Context) {
        guard let web = watch.controller?.webView else { return }
        if web.superview !== uiView {
            web.removeFromSuperview()
            web.frame = uiView.bounds
            web.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            uiView.addSubview(web)
        }
    }
}
#else
struct WatchPlayerHost: NSViewRepresentable {
    let watch: WatchStore

    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        v.wantsLayer = true
        v.layer?.backgroundColor = NSColor.black.cgColor
        return v
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        guard let web = watch.controller?.webView else { return }
        if web.superview !== nsView {
            web.removeFromSuperview()
            web.frame = nsView.bounds
            web.autoresizingMask = [.width, .height]
            nsView.addSubview(web)
        }
    }
}
#endif

/// Docked: above the chat, the picture (16:9) with the page's bar, URL box and list below — at most about
/// half the chat column, so the chat stays in view.
struct WatchDockView: View {
    let watch: WatchStore
    @State private var width: CGFloat = 400

    var body: some View {
        WatchPlayerHost(watch: watch)
            .frame(maxWidth: .infinity)
            .frame(height: height)
            .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { if abs($0 - width) > 1 { width = $0 } }
            .accessibilityLabel("みんなで見る（YouTube）")
    }

    /// The picture (16:9 of the width), the page's bar and room for the URL box and a little of the list —
    /// at most ~55 % of the chat column (the chat keeps the rest).
    private var height: CGFloat {
        let area = watch.areaHeight > 0 ? watch.areaHeight : 700
        let wanted = width * 9 / 16 + 46 + 150
        return max(220, min(wanted, area * 0.55))
    }
}

/// 📺 next to テキスト｜ルーム｜☗｜🎮 (not one of them: the player stays open whatever the chat shows).
/// Red while a video is on and the player is closed.
struct WatchToggleButton: View {
    let watch: WatchStore

    var body: some View {
        Button { watch.toggle() } label: {
            HStack(spacing: 3) {
                Text("📺")
                if watch.title != nil && !watch.open { Circle().fill(Color.red).frame(width: 5, height: 5) }
            }
            .padding(.horizontal, 7)
            .frame(height: 22)
            .background(RoundedRectangle(cornerRadius: 6).fill(watch.open ? Color.accentColor.opacity(0.25) : Color.primary.opacity(0.08)))
        }
        .buttonStyle(.plain)
        .fixedSize() // the header is tight: never squeezed to an empty pill
        .help(watch.title.map { "みんなで見ている: \($0)" } ?? "みんなで見る（YouTube）")
        .accessibilityLabel(watch.open ? "みんなで見る を閉じる" : "みんなで見る")
    }
}

/// A YouTube link's 「📺 みんなで見る」 (chat message / timeline card), only when on for this member.
struct WatchTogetherButton: View {
    let watch: WatchStore
    let url: String
    /// On the timeline (iPhone: open floating over it).
    var floating = false

    var body: some View {
        if watch.enabled && watch.canControl {
            Button { watch.watchTogether(url, floating: floating) } label: {
                Text(watch.title == nil ? "📺 みんなで見る" : "📺 見たいものリストへ")
                    .font(.app(.caption, weight: .semibold))
                    .padding(.horizontal, 10).padding(.vertical, 4)
                    .background(Capsule().strokeBorder(Color.primary.opacity(0.2)))
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
        }
    }
}

#if os(iOS)
/// iPhone / iPad: the player floating over the chat — drag it anywhere (it settles in the nearest corner),
/// two sizes (the ⤢ button), ⤓ back above the chat, ✕ closes. Only the picture and the page's bar.
struct WatchFloatingView: View {
    let watch: WatchStore
    @State private var corner: Int // 0 top-left, 1 top-right, 2 bottom-left, 3 bottom-right
    @State private var large = false
    @State private var drag: CGSize = .zero
    /// Chat overlay: what ⤓ does (expand it over the chat) instead of docking it above the chat.
    private let onDock: (() -> Void)?
    /// Chat overlay: kept off the switch row (top) and the message box (bottom).
    private let insets: EdgeInsets
    /// Chat overlay: the corner is remembered on this device.
    private let remember: Bool
    /// Chat overlay: the small size's width (the mock's small window; the large one stays 360).
    private let smallWidth: CGFloat
    private static let cornerKey = "watchFloatingCorner"

    init(watch: WatchStore, onDock: (() -> Void)? = nil, insets: EdgeInsets = EdgeInsets(), remember: Bool = false,
         smallWidth: CGFloat = 240) {
        self.watch = watch
        self.smallWidth = smallWidth
        self.onDock = onDock
        self.insets = insets
        self.remember = remember
        let saved = UserDefaults.standard.object(forKey: Self.cornerKey) as? Int
        _corner = State(initialValue: remember ? (saved ?? 0) : 3)
    }

    var body: some View {
        GeometryReader { g in
            let w = min(g.size.width - 16, large ? 360 : smallWidth)
            let h = (w * 9 / 16) + 44 + 26
            let left = corner % 2 == 0
            let top = corner < 2
            let x = left ? 8 + w / 2 : g.size.width - 8 - w / 2
            let y = top ? 8 + insets.top + h / 2 : g.size.height - 8 - insets.bottom - h / 2
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Text("📺 \(watch.title ?? "みんなで見る")").font(.app(.caption2, weight: .semibold)).lineLimit(1)
                    Spacer(minLength: 4)
                    Button { large.toggle() } label: { Image(systemName: large ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right") }
                        .accessibilityLabel(large ? "小さくする" : "大きくする")
                    if let onDock {
                        Button(action: onDock) { Image(systemName: "arrow.up.left.and.arrow.down.right.rectangle") }
                            .accessibilityLabel("広げる")
                    } else {
                        Button { watch.setMode(.docked) } label: { Image(systemName: "rectangle.bottomhalf.inset.filled") }
                            .accessibilityLabel("チャットの上に戻す")
                    }
                    Button { watch.close() } label: { Image(systemName: "xmark") }
                        .accessibilityLabel("閉じる")
                }
                .font(.system(size: 12, weight: .semibold))
                .padding(.horizontal, 8)
                .frame(height: 26)
                .background(.regularMaterial)
                .contentShape(Rectangle())
                // Moved by its title bar only (the picture's bar has the seek slider).
                .gesture(
                    DragGesture(minimumDistance: 6)
                        .onChanged { drag = $0.translation }
                        .onEnded { v in
                            let px = x + v.translation.width
                            let py = y + v.translation.height
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.85)) {
                                corner = (py < g.size.height / 2 ? 0 : 2) + (px < g.size.width / 2 ? 0 : 1)
                                drag = .zero
                                if remember { UserDefaults.standard.set(corner, forKey: Self.cornerKey) }
                            }
                        }
                )
                WatchPlayerHost(watch: watch)
            }
            .frame(width: w, height: h)
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .shadow(color: .black.opacity(0.3), radius: 10, y: 4)
            .position(x: x + drag.width, y: y + drag.height)
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel("みんなで見る（浮かぶ窓）")
    }
}
#endif
