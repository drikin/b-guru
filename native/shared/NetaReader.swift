import SwiftUI
import WebKit

/// 📝 ネタ帳の元記事をネタ帳の中で読む（2026-11-27 オーナー「内蔵のブラウザでネタ帳のビューの中でその記事を表示できる
/// オプションも追加してほしくて、そっちをデフォルトに」）。ネタ帳のページがほかのサイトへ行こうとしたら（リンク・target=_blank）、
/// 設定が「アプリの中で開く」（既定）ならネタ帳の上にこのブラウザを重ねる。切ると今までどおり普段のブラウザで開く。
///  - 記事のブラウザはネタ帳の WebView とは別。保存場所は普通の（端末の）もので、ネタ帳のログインとは混ざらない。
///    鍵（Authorization）はどの読み込みにも付けない。
///  - 中のリンクはこの中で進む。http(s) 以外（アプリのリンク・mailto など）は OS に渡す。
///  - バー: ✕ 閉じる（ネタ帳に戻る）、‹ › 戻る・進む、ページの題名、↗ 普段のブラウザで開く、共有。
enum NetaReaderSetting {
    static let key = "netaOpenLinksInApp"
    /// 既定はアプリの中。
    static var inApp: Bool { UserDefaults.standard.object(forKey: key) as? Bool ?? true }
}

@MainActor @Observable
final class NetaReader: NSObject {
    /// 開いている記事（nil = ネタ帳だけ）。
    private(set) var url: URL?
    private(set) var title = ""
    private(set) var canGoBack = false
    private(set) var canGoForward = false
    private(set) var loading = false

    @ObservationIgnored private(set) var web: WKWebView?
    @ObservationIgnored private var observers: [NSKeyValueObservation] = []

    /// ほかのサイトへのリンク: 設定に合わせてここか普段のブラウザで。
    func open(_ url: URL) {
        guard url.scheme == "http" || url.scheme == "https" else { Platform.open(url); return }
        guard NetaReaderSetting.inApp else { Platform.open(url); return }
        let v = web ?? make()
        self.url = url
        title = url.host ?? ""
        v.load(URLRequest(url: url))
    }

    func close() {
        web?.stopLoading()
        observers = []
        web?.navigationDelegate = nil
        web?.uiDelegate = nil
        web?.removeFromSuperview()
        web = nil
        url = nil
        title = ""
        canGoBack = false
        canGoForward = false
        loading = false
    }

    func back() { web?.goBack() }
    func forward() { web?.goForward() }
    func reload() { web?.reload() }

    /// 今のページを普段のブラウザで。
    func openOutside() {
        if let u = web?.url ?? url { Platform.open(u) }
    }

    var currentURL: URL? { web?.url ?? url }

    private func make() -> WKWebView {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .default()
        #if os(iOS)
        cfg.allowsInlineMediaPlayback = true
        #endif
        let v = WKWebView(frame: CGRect(x: 0, y: 0, width: 390, height: 700), configuration: cfg)
        v.navigationDelegate = self
        v.uiDelegate = self
        v.allowsBackForwardNavigationGestures = true
        #if os(macOS)
        v.pageZoom = TextScale.shared.scale
        #endif
        observers = [
            v.observe(\.title) { [weak self] w, _ in
                MainActor.assumeIsolated { if let t = w.title, !t.isEmpty { self?.title = t } }
            },
            v.observe(\.canGoBack) { [weak self] w, _ in MainActor.assumeIsolated { self?.canGoBack = w.canGoBack } },
            v.observe(\.canGoForward) { [weak self] w, _ in MainActor.assumeIsolated { self?.canGoForward = w.canGoForward } },
            v.observe(\.isLoading) { [weak self] w, _ in MainActor.assumeIsolated { self?.loading = w.isLoading } },
        ]
        web = v
        return v
    }
}

extension NetaReader: WKNavigationDelegate, WKUIDelegate {
    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        switch url.scheme {
        case "http", "https", "about", "blob", "data": return .allow
        default:
            // アプリのリンク・mailto・tel など。
            if action.targetFrame?.isMainFrame != false { Platform.open(url) }
            return .cancel
        }
    }

    /// target=_blank はこの中で開く（新しい WebView は作らない）。
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if url.scheme == "http" || url.scheme == "https" { webView.load(URLRequest(url: url)) } else { Platform.open(url) }
        }
        return nil
    }

    /// マイク・カメラは渡さない。
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin,
                 initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType) async -> WKPermissionDecision {
        .deny
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }
}

/// ネタ帳の上に重ねる記事のブラウザ（バー＋WebView）。reader.url があるときだけ出す。
struct NetaReaderOverlay: View {
    let reader: NetaReader

    var body: some View {
        if reader.url != nil, let web = reader.web {
            VStack(spacing: 0) {
                bar
                Divider()
                NetaReaderWebView(web: web)
                    .accessibilityIdentifier("neta-reader")
            }
            .background(Color.platformBackground)
            .transition(.move(edge: .trailing))
        }
    }

    private var bar: some View {
        HStack(spacing: 14) {
            Button { withAnimation(.easeOut(duration: 0.2)) { reader.close() } } label: {
                Label("ネタ帳に戻る", systemImage: "xmark").labelStyle(.iconOnly)
            }
            .keyboardShortcut(.cancelAction)
            .accessibilityIdentifier("neta-reader-close")
            Button { reader.back() } label: { Image(systemName: "chevron.left") }
                .disabled(!reader.canGoBack)
                .accessibilityLabel("戻る")
            Button { reader.forward() } label: { Image(systemName: "chevron.right") }
                .disabled(!reader.canGoForward)
                .accessibilityLabel("進む")
            VStack(spacing: 0) {
                Text(reader.title).font(.app(.subheadline).weight(.semibold)).lineLimit(1)
                if let host = reader.currentURL?.host {
                    Text(host).font(.app(.caption2)).foregroundStyle(.secondary).lineLimit(1)
                }
            }
            .frame(maxWidth: .infinity)
            if reader.loading {
                ProgressView().controlSize(.small)
            } else {
                Button { reader.reload() } label: { Image(systemName: "arrow.clockwise") }
                    .accessibilityLabel("再読み込み")
            }
            if let u = reader.currentURL {
                ShareLink(item: u) { Image(systemName: "square.and.arrow.up") }
                    .accessibilityLabel("共有")
            }
            Button { reader.openOutside() } label: { Image(systemName: "safari") }
                .accessibilityLabel("ブラウザで開く")
                .help("ブラウザで開く")
        }
        .buttonStyle(.borderless)
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

/// ネタ帳のページの設定（📝 の ⋯ / Mac の歯車）: 元記事をどこで開くか。
struct NetaLinksToggle: View {
    @AppStorage(NetaReaderSetting.key) private var inApp = true
    var body: some View {
        Toggle("記事をアプリの中で開く", isOn: $inApp)
    }
}

#if os(macOS)
private struct NetaReaderWebView: NSViewRepresentable {
    let web: WKWebView
    func makeNSView(context: Context) -> WKWebView { web }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#else
private struct NetaReaderWebView: UIViewRepresentable {
    let web: WKWebView
    func makeUIView(context: Context) -> WKWebView { web }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif
