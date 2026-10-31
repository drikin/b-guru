import SwiftUI
import WebKit

/// Web 版のタイムライン（試験的、ドリキン 2026-10-31「Web 版のタイムラインをそのまま表示…フル機能使えたり」）。
/// 設定で切り替え、既定は切。パネルの 📰 にネイティブの代わりに bsm.backspace.fm を出す。
///  - Web のログイン（6 桁のコード）はこの WebView だけの保存場所に残る（ほかの WebView はどれも
///    残さない）。アプリからログアウトすると保存場所ごと消す。
///  - UA に `BguruMacApp/<版>` を付ける。Web はそれを見て上部の「チャット」を出さず、チャットを開く操作を
///    `bguruMac` のメッセージでアプリに頼む（src/lib/mac-app-client.ts）。受けるのは自分のサイトの
///    いちばん外のページからの openChat だけ。
///  - ほかのサイトへの移動は普段のブラウザで開く。埋め込み（YouTube など）は中で動く。
///  - マイク・カメラは渡さない（ボイスはアプリのチャットで）。
@MainActor
final class WebTimeline: NSObject {
    static let shared = WebTimeline()

    /// チャットを開く（パネルが設定する）。mention は入力欄に入れる @ 名前、shogiGameId は開く対局。
    var onOpenChat: ((_ mention: String?, _ shogiGameId: Int?) -> Void)?

    private static let storeID = UUID(uuidString: "6F1D2C3B-8A4E-4B7F-9C21-B6E0A9D4F512")!
    /// 自分のサイト（開発では BGURU_DEV_BASE_URL のローカルも）。
    nonisolated private static let base = APIClient.baseURL

    private var web: WKWebView?
    /// 読み込みが終わる前に頼まれた投稿（終わったら開く）。
    private var pendingPost: Int?
    private var loaded = false

    /// 最初に見せるときに作る（設定を入れても 📰 を開くまではメモリを使わない）。
    var view: WKWebView {
        if let web { return web }
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = WKWebsiteDataStore(forIdentifier: Self.storeID)
        cfg.applicationNameForUserAgent = "BguruMacApp/\(Updater.shared.currentVersion)"
        cfg.userContentController.add(MessageProxy(self), name: "bguruMac")
        let v = WKWebView(frame: CGRect(x: 0, y: 0, width: 420, height: 600), configuration: cfg)
        v.navigationDelegate = self
        v.uiDelegate = self
        // 横スワイプはパネルのタブの切り替え（戻るは ‹・⌘[・マウスの戻る）。
        v.allowsBackForwardNavigationGestures = false
        v.setValue(false, forKey: "drawsBackground") // 読み込み中にパネルの地が見えるように
        v.pageZoom = TextScale.shared.scale
        web = v
        #if DEBUG
        // 開発のみ：手元のサーバ（localhost）の使い捨てのログインを渡す。本番には決して渡さない。
        if let s = ProcessInfo.processInfo.environment["BGURU_DEV_WEB_SESSION"], let host = Self.base.host,
           host == "localhost" || host == "127.0.0.1",
           let c = HTTPCookie(properties: [.name: "bsm_session", .value: s, .domain: host, .path: "/"]) {
            cfg.websiteDataStore.httpCookieStore.setCookie(c) { v.load(URLRequest(url: APIClient.baseURL)) }
            return v
        }
        #endif
        v.load(URLRequest(url: APIClient.baseURL))
        return v
    }

    func reload() {
        guard let web else { return }
        if web.url == nil { web.load(URLRequest(url: APIClient.baseURL)) } else { web.reload() }
    }

    func goBack() { web?.goBack() }

    func openInBrowser() { Platform.open(web?.url.flatMap(Self.isOurs) ?? APIClient.baseURL) }

    /// 知らせ・チャットのリンクから投稿を開く（Web の #/post/<id>）。
    func open(post id: Int) {
        guard let web, loaded else {
            pendingPost = id
            _ = view
            return
        }
        web.evaluateJavaScript("location.hash = '/post/\(id)'; void 0") { _, _ in }
    }

    #if DEBUG
    func debugEval(_ js: String) {
        web?.evaluateJavaScript(js) { r, e in NSLog("[webtl] %@ → %@", js, e.map { "\($0)" } ?? "\(r ?? "nil")") }
    }
    #endif

    func setZoom(_ scale: CGFloat) { if let web, web.pageZoom != scale { web.pageZoom = scale } }

    /// アプリからログアウトしたとき・設定を切ったとき：WebView を捨てる。ログアウトでは保存場所（Web の
    /// ログイン）も消す。
    func tearDown(forgetLogin: Bool) {
        web?.configuration.userContentController.removeScriptMessageHandler(forName: "bguruMac")
        web?.stopLoading()
        web?.removeFromSuperview()
        web = nil
        loaded = false
        pendingPost = nil
        guard forgetLogin else { return }
        // サーバのログインを消し（30 日残さない）、中身（cookie ほか）を消す。保存場所ごとの削除は WebView が
        // 残っていると失敗するので、その後で試すだけ。
        let store = WKWebsiteDataStore(forIdentifier: Self.storeID)
        Task {
            let cookies = await store.httpCookieStore.allCookies()
            if let c = cookies.first(where: { $0.name == "bsm_session" && $0.domain == Self.base.host }) {
                var req = URLRequest(url: Self.base.appendingPathComponent("/api/auth/logout"))
                req.httpMethod = "POST"
                req.httpShouldHandleCookies = false
                req.setValue("bsm_session=\(c.value)", forHTTPHeaderField: "Cookie")
                _ = try? await URLSession.shared.data(for: req)
            }
            await store.removeData(ofTypes: WKWebsiteDataStore.allWebsiteDataTypes(), modifiedSince: .distantPast)
            try? await WKWebsiteDataStore.remove(forIdentifier: Self.storeID)
        }
    }

    /// 自分のサイトの URL だけ通す。
    nonisolated static func isOurs(_ url: URL) -> URL? {
        url.scheme == base.scheme && url.host == base.host && url.port == base.port ? url : nil
    }

    /// 自分のサイトのいちばん外のページか（埋め込みのほかのサイトからは、アプリの画面に見えるものを出させない）。
    static func isOurs(_ f: WKFrameInfo) -> Bool {
        let o = f.securityOrigin
        return f.isMainFrame && o.protocol == base.scheme && o.host == base.host && o.port == (base.port ?? 0)
    }

    fileprivate func received(_ m: WKScriptMessage) {
        guard Self.isOurs(m.frameInfo),
              let body = m.body as? [String: Any], body["type"] as? String == "openChat" else { return }
        let mention = (body["mention"] as? String).flatMap { $0.hasPrefix("@") && $0.count <= 80 ? $0 : nil }
        let game = (body["shogiGameId"] as? Int).flatMap { $0 > 0 ? $0 : nil }
        onOpenChat?(mention, game)
    }
}

/// WKUserContentController が強く持つので、間に挟む（WebTimeline を手放せるように）。
private final class MessageProxy: NSObject, WKScriptMessageHandler {
    weak var target: WebTimeline?
    init(_ t: WebTimeline) { target = t }
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        MainActor.assumeIsolated { target?.received(m) }
    }
}

extension WebTimeline: WKNavigationDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        // 埋め込み（iframe）はそのまま（保存はさせない）。いちばん外のページは自分のサイトだけ。
        if action.targetFrame?.isMainFrame == false { return action.shouldPerformDownload ? .cancel : .allow }
        if action.shouldPerformDownload { return Self.isOurs(url) != nil || url.scheme == "blob" ? .download : .cancel }
        // data: はアドレスバーのないパネルで偽の画面を出せるので通さない。
        if url.scheme == "about" || url.scheme == "blob" { return .allow }
        if Self.isOurs(url) != nil { return .allow }
        if ["http", "https", "mailto"].contains(url.scheme ?? "") { Platform.open(url) }
        return .cancel
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        response.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        loaded = true
        if let id = pendingPost {
            pendingPost = nil
            open(post: id)
        }
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) { loaded = false }

    /// 読めなかった（オフラインなど）：↻ でもう一度。
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        NSLog("[webtl] 読み込めませんでした: %@", "\(error)")
    }

    /// WebView の中身が落ちたら読み直す（白いままにしない）。
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        loaded = false
        reload()
    }

    /// 指の下・キーを持っているのがこの Web か（パネルのスワイプ・← などを Web に任せる）。
    func owns(_ view: NSView?) -> Bool {
        guard let web, let view else { return false }
        return view === web || view.isDescendant(of: web)
    }
}

extension WebTimeline: WKUIDelegate {
    /// target=_blank：自分のサイトならこの中で、ほかは普段のブラウザで。
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if Self.isOurs(url) != nil { webView.load(URLRequest(url: url)) } else if ["http", "https", "mailto"].contains(url.scheme ?? "") { Platform.open(url) }
        }
        return nil
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async {
        guard Self.isOurs(frame) else { return }
        _ = await ask(webView, message, buttons: ["OK"])
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String,
                 initiatedByFrame frame: WKFrameInfo) async -> Bool {
        guard Self.isOurs(frame) else { return false }
        return await ask(webView, message, buttons: ["OK", "キャンセル"]) == .alertFirstButtonReturn
    }

    func webView(_ webView: WKWebView, runJavaScriptTextInputPanelWithPrompt prompt: String,
                 defaultText: String?, initiatedByFrame frame: WKFrameInfo) async -> String? {
        guard Self.isOurs(frame) else { return nil }
        let field = NSTextField(string: defaultText ?? "")
        field.frame = NSRect(x: 0, y: 0, width: 260, height: 24)
        return await ask(webView, prompt, buttons: ["OK", "キャンセル"], accessory: field) == .alertFirstButtonReturn ? field.stringValue : nil
    }

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters,
                 initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window = webView.window else { return panel.runModal() == .OK ? panel.urls : nil }
        return await panel.beginSheetModal(for: window) == .OK ? panel.urls : nil
    }

    /// マイク・カメラは渡さない（Web のボイスに入るとアプリのボイスと二重になる）。
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        .deny
    }

    private func ask(_ webView: WKWebView, _ text: String, buttons: [String], accessory: NSView? = nil) async -> NSApplication.ModalResponse {
        let alert = NSAlert()
        alert.messageText = text
        for b in buttons { alert.addButton(withTitle: b) }
        alert.accessoryView = accessory
        guard let window = webView.window else { return alert.runModal() }
        return await alert.beginSheetModal(for: window)
    }
}

extension WebTimeline: WKDownloadDelegate {
    /// 保存先は毎回聞く（サンドボックスで書けるのは選んだ場所だけ）。
    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse,
                  suggestedFilename: String) async -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        if let window = web?.window { return await panel.beginSheetModal(for: window) == .OK ? panel.url : nil }
        return panel.runModal() == .OK ? panel.url : nil
    }
}

/// パネルの 📰：上の段（‹ 戻る・切り替え・↻・ブラウザで開く）と Web。
struct WebTimelineScreen: View {
    let tabPicker: MainTabPicker

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Button { WebTimeline.shared.goBack() } label: { Image(systemName: "chevron.left") }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("[", modifiers: .command)
                    .help("戻る（⌘[）")
                tabPicker
                Spacer()
                Button { WebTimeline.shared.reload() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("r", modifiers: .command)
                    .help("再読み込み（⌘R）")
                Button { WebTimeline.shared.openInBrowser() } label: { Image(systemName: "safari") }
                    .buttonStyle(.borderless)
                    .help("ブラウザで開く")
            }
            .modifier(DisabledOffScreen())
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 8)
            Divider()
            WebTimelineView(scale: TextScale.shared.scale)
        }
    }
}

private struct WebTimelineView: NSViewRepresentable {
    let scale: CGFloat
    func makeNSView(context: Context) -> WKWebView { WebTimeline.shared.view }
    func updateNSView(_ v: WKWebView, context: Context) { WebTimeline.shared.setZoom(scale) }
}
