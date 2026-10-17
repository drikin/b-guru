import SwiftUI
import WebKit
#if os(iOS)
import UIKit
#endif

/// First run: sign in to B-guru in an embedded, non-persistent web view, then
/// the app issues itself a device token (read / read_state / chat / post / voice) from that
/// signed-in page and keeps only the token, in the Keychain. The web session
/// itself is thrown away with the web view. No JS bridge is installed: the
/// token comes back as the return value of callAsyncJavaScript on our own
/// origin, and navigation is confined to bsm.backspace.fm.
/// A one-off message for the next sign-in screen (e.g. why the app signed out).
@MainActor
enum LoginNotice {
    static var message: String?
}

struct LoginView: View {
    let onToken: (String) -> Void
    @State private var status: String? = LoginNotice.message
    @State private var showDevices = false
    @State private var working = false
    @State private var web = LoginWeb()

    var body: some View {
        VStack(spacing: 0) {
            WebViewRepresentable(web: web)
            Divider()
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(status ?? "B-guru にログインしてから「このアプリを接続」を押してください")
                        .font(.callout)
                        .foregroundStyle(status == nil ? .secondary : .primary)
                        .fixedSize(horizontal: false, vertical: true)
                    if showDevices {
                        Button("デバイスの管理を開く") {
                            web.view.load(URLRequest(url: APIClient.baseURL.appendingPathComponent("/settings/agent")))
                        }
                        .linkButton()
                        .font(.callout)
                    }
                }
                Spacer()
                Button(working ? "接続中…" : "このアプリを接続") { connect() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(working)
            }
            .padding(12)
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 560)
        #endif
    }

    private func connect() {
        working = true
        status = nil
        Task {
            defer { working = false }
            do {
                let token = try await web.issueToken()
                onToken(token)
            } catch let e as LoginWeb.IssueError {
                status = e.message
                showDevices = e.isLimit
            } catch {
                status = "接続できませんでした。ログインしているか確認してください"
                showDevices = false
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

    /// Per-device name for the token. `replace_same_device` revokes tokens with
    /// the SAME name, so it must differ between a member's devices. On iOS the
    /// system device name is just "iPhone"/"iPad" for every app, so a short
    /// per-install id is added.
    static var deviceName: String {
        #if os(macOS)
        let name = "B-guru Chat (Mac) \(Host.current().localizedName ?? "")"
        #else
        let kind = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        let id = UIDevice.current.identifierForVendor?.uuidString.prefix(6) ?? "000000"
        let name = "B-guru Chat (\(kind)) \(id)"
        #endif
        return String(name.trimmingCharacters(in: .whitespaces).prefix(100))
    }

    struct IssueError: Error {
        var message: String
        var isLimit = false
    }

    /// Issues this Mac's token from the signed-in page. `replace_same_device`
    /// revokes the previous token of this same Mac first, so reinstalling or
    /// signing in again never fills up the 5-token limit. On failure the
    /// server's own reason is shown (e.g. the limit, with a link to the
    /// device list) instead of a generic message.
    func issueToken() async throws -> String {
        let device = Self.deviceName
        let js = """
        const r = await fetch('/api/agent/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_name: device, scopes: ['read', 'read_state', 'chat', 'post', 'voice'], replace_same_device: true }),
          credentials: 'same-origin'
        });
        let d = null;
        try { d = await r.json(); } catch (e) {}
        return { status: r.status, token: (d && d.token) || '', error: (d && d.error) || '', hint: (d && d.hint) || '' };
        """
        guard view.url?.host == APIClient.baseURL.host else {
            throw IssueError(message: "B-guru のページを開いてから接続してください")
        }
        let raw = try await view.callAsyncJavaScript(js, arguments: ["device": String(device.prefix(100))],
                                                     contentWorld: .defaultClient)
        let r = raw as? [String: Any] ?? [:]
        let status = (r["status"] as? NSNumber)?.intValue ?? 0
        if let token = r["token"] as? String, !token.isEmpty, status == 201 { return token }
        let error = (r["error"] as? String) ?? ""
        let hint = (r["hint"] as? String) ?? ""
        switch status {
        case 401:
            throw IssueError(message: "まだログインしていません。上の画面で B-guru にログインしてください")
        case 403:
            throw IssueError(message: error.isEmpty ? "会員資格が確認できませんでした" : error)
        default:
            let isLimit = error.contains("本まで")
            let text = [error, hint].filter { !$0.isEmpty }.joined(separator: "。")
            throw IssueError(message: text.isEmpty ? "接続できませんでした（\(status)）" : text, isLimit: isLimit)
        }
    }

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
        guard let url = action.request.url else { return .cancel }
        if url.scheme == "https", url.host == APIClient.baseURL.host { return .allow }
        if url.scheme == "about" { return .allow }
        if action.navigationType == .linkActivated { Platform.open(url) }
        return .cancel
    }
}

#if os(macOS)
struct WebViewRepresentable: NSViewRepresentable {
    let web: LoginWeb
    func makeNSView(context: Context) -> WKWebView { web.view }
    func updateNSView(_ nsView: WKWebView, context: Context) {}
}
#else
struct WebViewRepresentable: UIViewRepresentable {
    let web: LoginWeb
    func makeUIView(context: Context) -> WKWebView { web.view }
    func updateUIView(_ uiView: WKWebView, context: Context) {}
}
#endif
