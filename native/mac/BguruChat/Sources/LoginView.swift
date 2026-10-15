import SwiftUI
import WebKit

/// First run: sign in to B-guru in an embedded, non-persistent web view, then
/// the app issues itself a device token (read / read_state / chat) from that
/// signed-in page and keeps only the token, in the Keychain. The web session
/// itself is thrown away with the web view. No JS bridge is installed: the
/// token comes back as the return value of callAsyncJavaScript on our own
/// origin, and navigation is confined to bsm.backspace.fm.
struct LoginView: View {
    let onToken: (String) -> Void
    @State private var status: String?
    @State private var working = false
    @State private var web = LoginWeb()

    var body: some View {
        VStack(spacing: 0) {
            WebViewRepresentable(web: web)
            Divider()
            HStack(spacing: 10) {
                Text(status ?? "B-guru にログインしてから「このアプリを接続」を押してください")
                    .font(.callout)
                    .foregroundStyle(status == nil ? .secondary : .primary)
                    .fixedSize(horizontal: false, vertical: true)
                Spacer()
                Button(working ? "接続中…" : "このアプリを接続") { connect() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(working)
            }
            .padding(12)
        }
        .frame(minWidth: 420, minHeight: 560)
    }

    private func connect() {
        working = true
        status = nil
        Task {
            defer { working = false }
            do {
                let token = try await web.issueToken()
                onToken(token)
            } catch {
                status = "接続できませんでした。ログインしているか確認してください"
            }
        }
    }
}

@MainActor
final class LoginWeb: NSObject, WKNavigationDelegate {
    let view: WKWebView

    override init() {
        let cfg = WKWebViewConfiguration()
        cfg.websiteDataStore = .nonPersistent()
        view = WKWebView(frame: .zero, configuration: cfg)
        super.init()
        view.navigationDelegate = self
        view.load(URLRequest(url: APIClient.baseURL))
    }

    func issueToken() async throws -> String {
        let device = "B-guru Chat (Mac) \(Host.current().localizedName ?? "")".trimmingCharacters(in: .whitespaces)
        let js = """
        const r = await fetch('/api/agent/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_name: device, scopes: ['read', 'read_state', 'chat'] }),
          credentials: 'same-origin'
        });
        if (!r.ok) return null;
        const d = await r.json();
        return d.token || null;
        """
        guard view.url?.host == APIClient.baseURL.host else { throw APIError.unauthorized(code: nil) }
        let result = try await view.callAsyncJavaScript(js, arguments: ["device": String(device.prefix(100))],
                                                        contentWorld: .defaultClient)
        guard let token = result as? String, !token.isEmpty else { throw APIError.unauthorized(code: nil) }
        return token
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == "https", url.host == APIClient.baseURL.host { return .allow }
        if url.scheme == "about" { return .allow }
        if action.navigationType == .linkActivated { NSWorkspace.shared.open(url) }
        return .cancel
    }
}

struct WebViewRepresentable: NSViewRepresentable {
    let web: LoginWeb
    func makeNSView(context: Context) -> WKWebView { web.view }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
