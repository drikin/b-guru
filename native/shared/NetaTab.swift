import SwiftUI
import WebKit

/// 📝 ネタ帳のタブ（✉️ と 📻 の間、2026-11-14 オーナー「アプリはそもそも会員限定なので DM とプレイヤーの間のタブにネタ帳」）。
/// サーバの /neta/app（Web のネタ帳と同じ中身、ページの中で切り替える）を WKWebView で出す。
///  - 入口は capabilities の features.neta.tab（"/neta/app/enter"）。最初の読み込み（とログインが切れたときの入り直し）
///    だけにアプリの鍵を Authorization で付ける。サーバはネタ帳だけのログイン（neta_session、12 時間、元の鍵に結ぶ）を置く。
///    鍵はそれ以外のどの読み込みにも付けない。
///  - 保存場所は揮発（nonPersistent）でこのタブ専用: B-guru の Web のログイン（Mac の Web タイムライン）とは混ざらない。
///    アプリからログアウトしたら WebView ごと捨てる（signOut）。
///  - ページが bguru-neta://reenter に移ろうとしたら（ログインが切れた）入り直す。このスキームは OS には登録しない
///    （ここで横取りするだけ）。
///  - 自分のサイトの中だけ WebView で動く。ほかのサイト・新しいタブで開くリンクは、既定ではネタ帳の上に重ねる
///    記事のブラウザ（NetaReader、2026-11-27）で、設定を切ると普段のブラウザで開く。
///  - 📜 台本のタブ（いちばん右、2026-11-14）も同じ作り: NetaTabWeb.script（入口は features.neta.scriptTab、
///    "/neta/app/enter?to=script" で /neta/app/script へ）。WebView と保存場所はタブごとに別。
@MainActor
final class NetaTabWeb: NSObject {
    static let shared = NetaTabWeb()
    /// 📜 台本のタブ。
    static let script = NetaTabWeb()

    /// アプリからログアウト: 両方のタブを捨てる。
    static func signOutAll() {
        shared.signOut()
        script.signOut()
    }

    /// 入り直す間隔（サーバのログインは 12 時間）。
    private static let reenterAfter: TimeInterval = 6 * 3600
    nonisolated private static let base = APIClient.baseURL

    private var web: WKWebView?
    /// 元記事を読むブラウザ（ネタ帳の上に重ねる）。
    let reader = NetaReader()
    private var path = "/neta/app/enter"
    private var enteredAt: Date?
    #if os(iOS)
    private var refresh: UIRefreshControl?
    #endif

    /// 最初に見せるときに作る（タブを開くまではメモリを使わない）。
    func view(path: String) -> WKWebView {
        self.path = path
        if let web { return web }
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        cfg.applicationNameForUserAgent = "BguruNetaTab"
        #if os(iOS)
        cfg.allowsInlineMediaPlayback = true
        #endif
        let v = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 700), configuration: cfg)
        v.navigationDelegate = self
        v.uiDelegate = self
        v.allowsBackForwardNavigationGestures = false // 横スワイプはタブの切り替え
        #if os(macOS)
        v.setValue(false, forKey: "drawsBackground")
        v.pageZoom = TextScale.shared.scale
        #else
        v.isOpaque = false
        v.backgroundColor = .clear
        let rc = UIRefreshControl()
        rc.addTarget(self, action: #selector(pulled), for: .valueChanged)
        v.scrollView.refreshControl = rc
        refresh = rc
        #endif
        web = v
        enter()
        return v
    }

    /// タブが前に出たとき: 長く空いていたら入り直す。
    func shown() {
        guard web != nil else { return }
        if let at = enteredAt, Date().timeIntervalSince(at) < Self.reenterAfter { return }
        enter()
    }

    /// アプリの鍵を付けて入口を開く（ログインを置いて /neta/app へ転送される）。
    func enter() {
        guard let web, let token = Keychain.load(), let url = URL(string: path, relativeTo: Self.base)?.absoluteURL,
              Self.isOurs(url) else { return }
        var req = URLRequest(url: url)
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        enteredAt = Date()
        web.load(req)
    }

    func reload() {
        guard let web else { return }
        if web.url.map(Self.isOurs) == true { web.reload() } else { enter() }
    }

    #if os(macOS)
    func setZoom(_ scale: CGFloat) { web?.pageZoom = scale }
    #endif

    /// アプリからログアウト: WebView ごと捨てる（揮発の保存場所＝ネタ帳のログインも消える）。
    func signOut() {
        web?.stopLoading()
        web?.navigationDelegate = nil
        web?.uiDelegate = nil
        web?.removeFromSuperview()
        web = nil
        enteredAt = nil
        reader.close()
        #if os(iOS)
        refresh = nil
        #endif
    }

    #if os(iOS)
    @objc private func pulled() {
        reload()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.refresh?.endRefreshing() }
    }
    #endif

    nonisolated static func isOurs(_ url: URL) -> Bool {
        url.scheme == base.scheme && url.host == base.host && url.port == base.port
    }
}

extension NetaTabWeb: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == "bguru-neta" {
            if url.host == "reenter" { enter() }
            return .cancel
        }
        // data: はいちばん外では通さない（アドレスバーのない画面で、偽の画面を出せないように。WebTimeline と同じ）。
        if Self.isOurs(url) || url.scheme == "about" || url.scheme == "blob" { return .allow }
        // 埋め込み（iframe）はそのまま。ページそのものがほかのサイトへ行くときは普段のブラウザで。
        if action.targetFrame?.isMainFrame == false { return .allow }
        if url.scheme == "http" || url.scheme == "https" { reader.open(url) }
        return .cancel
    }

    /// target=_blank: 記事のブラウザ（設定を切ると普段のブラウザ）で開く（新しい WebView は作らない）。
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url, url.scheme == "http" || url.scheme == "https" { reader.open(url) }
        return nil
    }

    /// マイク・カメラは渡さない。
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        .deny
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        reload()
    }
}

/// タブの中身（SwiftUI）。path は capabilities の netaTabPath（📜 は scriptTabPath と web: .script）。
#if os(macOS)
struct NetaTabView: NSViewRepresentable {
    let path: String
    var web: NetaTabWeb = .shared
    func makeNSView(context: Context) -> WKWebView { web.view(path: path) }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#else
struct NetaTabView: UIViewRepresentable {
    let path: String
    var web: NetaTabWeb = .shared
    func makeUIView(context: Context) -> WKWebView { web.view(path: path) }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif
