import SwiftUI
import UIKit
import UniformTypeIdentifiers
import ImageIO

/// 共有メニューの「B-guru Chat」: ブラウザや他のアプリの URL・文章・写真を、
/// タイムラインの投稿かチャットのメッセージとしてその場で送る（2026-11-11 ドリキン）。
/// The app's own token comes from the shared Keychain (same group as the NSE).
/// Self-contained on purpose: an extension has ~120 MB and should not pull the whole app in.
final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.finish = { [weak self] posted in
            guard let ctx = self?.extensionContext else { return }
            if posted { ctx.completeRequest(returningItems: nil) }
            else { ctx.cancelRequest(withError: NSError(domain: "fm.backspace.bguru.chat.share", code: 0)) }
        }
        let host = UIHostingController(rootView: ShareView(model: model))
        addChild(host)
        host.view.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(host.view)
        NSLayoutConstraint.activate([
            host.view.leadingAnchor.constraint(equalTo: view.leadingAnchor),
            host.view.trailingAnchor.constraint(equalTo: view.trailingAnchor),
            host.view.topAnchor.constraint(equalTo: view.topAnchor),
            host.view.bottomAnchor.constraint(equalTo: view.bottomAnchor),
        ])
        host.didMove(toParent: self)
        let items = (extensionContext?.inputItems as? [NSExtensionItem]) ?? []
        Task { await model.load(items) }
    }
}

enum ShareDestination: String, CaseIterable, Identifiable {
    case timeline, chat
    var id: String { rawValue }
    var label: String { self == .timeline ? "📰 タイムライン" : "💬 チャット" }
    var maxImages: Int { self == .timeline ? 5 : 4 }
}

@MainActor
@Observable
final class ShareModel {
    var text = ""
    var images: [Data] = []          // already JPEG, ≤ 2048 px
    var destination: ShareDestination = ShareDestination(rawValue: UserDefaults.standard.string(forKey: "share.destination") ?? "") ?? .timeline {
        didSet { UserDefaults.standard.set(destination.rawValue, forKey: "share.destination") }
    }
    var loading = true
    var sending = false
    var error: String?
    let token: String? = {
        #if DEBUG
        // Dev only (simulator): `simctl spawn <端末> defaults write fm.backspace.bguru.chat.share BGURU_DEV_TOKEN <token>`.
        if let t = UserDefaults.standard.string(forKey: "BGURU_DEV_TOKEN"), !t.isEmpty { return t }
        #endif
        return Keychain.load()
    }()
    var finish: (Bool) -> Void = { _ in }

    var canSend: Bool {
        token != nil && !loading && !sending
            && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty)
    }

    func load(_ items: [NSExtensionItem]) async {
        let got = await SharedContent.read(items)
        text = got.text
        images = got.images
        loading = false
    }

    func send() async {
        guard let token, canSend else { return }
        sending = true
        error = nil
        defer { sending = false }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let pics = Array(images.prefix(destination.maxImages))
        do {
            let api = ShareAPI(token: token)
            switch destination {
            case .timeline:
                let urls = pics.isEmpty ? [] : try await api.upload(pics, path: "/api/agent/upload")
                try await api.postJSON("/api/agent/publish", ["text": body, "images": urls])
            case .chat:
                let urls = pics.isEmpty ? [] : try await api.upload(pics, path: "/api/agent/chat/upload")
                var j: [String: Any] = ["body": body, "client_id": UUID().uuidString.lowercased()]
                if !urls.isEmpty { j["images"] = urls }
                try await api.postJSON("/api/agent/chat", j)
            }
            finish(true)
        } catch let e as ShareAPI.Failure {
            error = e.message
        } catch {
            self.error = "送れませんでした。電波を確かめてもう一度お試しください"
        }
    }
}

struct ShareView: View {
    @Bindable var model: ShareModel
    @FocusState private var focused: Bool

    var body: some View {
        NavigationStack {
            Group {
                if model.token == nil {
                    ContentUnavailableView("ログインしていません",
                                           systemImage: "person.crop.circle.badge.questionmark",
                                           description: Text("B-guru Chat アプリを開いてログインしてから、もう一度共有してください。"))
                } else {
                    form
                }
            }
            .navigationTitle("B-guru に投稿")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("キャンセル") { model.finish(false) }
                        .disabled(model.sending)
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.sending {
                        ProgressView()
                    } else {
                        Button("投稿") { Task { await model.send() } }
                            .bold()
                            .disabled(!model.canSend)
                            .accessibilityIdentifier("share.send")
                    }
                }
            }
        }
    }

    private var form: some View {
        VStack(alignment: .leading, spacing: 12) {
            Picker("送り先", selection: $model.destination) {
                ForEach(ShareDestination.allCases) { Text($0.label).tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("share.destination")

            ZStack(alignment: .topLeading) {
                TextEditor(text: $model.text)
                    .focused($focused)
                    .scrollContentBackground(.hidden)
                    .padding(6)
                    .background(Color(uiColor: .secondarySystemBackground), in: RoundedRectangle(cornerRadius: 10))
                    .accessibilityIdentifier("share.text")
                if model.text.isEmpty && !model.loading {
                    Text(model.destination == .timeline ? "ひとこと添えて投稿" : "メッセージ")
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12).padding(.vertical, 14)
                        .allowsHitTesting(false)
                }
                if model.loading { ProgressView().padding(14) }
            }
            .frame(minHeight: 140)

            if !model.images.isEmpty { thumbnails }

            Text(hint)
                .font(.footnote)
                .foregroundStyle(.secondary)
            if let e = model.error {
                Text(e).font(.footnote).foregroundStyle(.red)
            }
            Spacer(minLength: 0)
        }
        .padding()
        .disabled(model.sending)
        .onAppear { focused = true }
    }

    private var thumbnails: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(model.images.enumerated()), id: \.offset) { i, data in
                    ZStack(alignment: .topTrailing) {
                        if let ui = UIImage(data: data) {
                            Image(uiImage: ui).resizable().scaledToFill()
                                .frame(width: 72, height: 72).clipped()
                                .clipShape(RoundedRectangle(cornerRadius: 8))
                                .opacity(i < model.destination.maxImages ? 1 : 0.3)
                        }
                        Button {
                            model.images.remove(at: i)
                        } label: {
                            Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .padding(2)
                        .accessibilityLabel("この写真を外す")
                    }
                }
            }
        }
    }

    private var hint: String {
        var s = model.destination == .timeline
            ? "部活は自動で選ばれます。URL はリンクのカードになります。"
            : "部室のチャットにみんな向けに送ります。"
        if model.images.count > model.destination.maxImages {
            s += " 写真は \(model.destination.maxImages) 枚まで（薄い写真は送りません）。"
        }
        return s
    }
}

/// What the other app handed us, turned into a draft: text (title + URL) and JPEGs.
@MainActor
enum SharedContent {
    static func read(_ items: [NSExtensionItem]) async -> (text: String, images: [Data]) {
        var lines: [String] = []
        var urls: [String] = []
        var images: [Data] = []
        for item in items {
            let title = item.attributedTitle?.string.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let content = item.attributedContentText?.string.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.image.identifier), images.count < 5,
                   let data = await loadImage(provider) {
                    images.append(data)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                          let url = await loadURL(provider), !url.isFileURL {
                    urls.append(url.absoluteString)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let s = await loadText(provider) {
                    lines.append(s)
                }
            }
            for s in [title, content] where !s.isEmpty && !lines.contains(s) && !urls.contains(s) {
                lines.insert(s, at: 0)
            }
        }
        // A URL already inside the shared text (Safari sometimes sends both) is not repeated.
        let joined = lines.joined(separator: "\n")
        for u in urls where !joined.contains(u) { lines.append(u) }
        var seen = Set<String>()
        let text = lines.filter { seen.insert($0).inserted }.joined(separator: "\n")
        return (text, images)
    }

    private static func loadURL(_ p: NSItemProvider) async -> URL? {
        await withCheckedContinuation { (c: CheckedContinuation<URL?, Never>) in
            p.loadItem(forTypeIdentifier: UTType.url.identifier, options: nil) { item, _ in
                if let u = item as? URL { c.resume(returning: u) }
                else if let s = item as? String { c.resume(returning: URL(string: s)) }
                else if let d = item as? Data { c.resume(returning: URL(dataRepresentation: d, relativeTo: nil)) }
                else { c.resume(returning: nil) }
            }
        }
    }

    private static func loadText(_ p: NSItemProvider) async -> String? {
        await withCheckedContinuation { (c: CheckedContinuation<String?, Never>) in
            p.loadItem(forTypeIdentifier: UTType.plainText.identifier, options: nil) { item, _ in
                var s: String?
                if let t = item as? String { s = t }
                else if let d = item as? Data { s = String(data: d, encoding: .utf8) }
                else if let a = item as? NSAttributedString { s = a.string }
                let t = s?.trimmingCharacters(in: .whitespacesAndNewlines)
                c.resume(returning: (t?.isEmpty ?? true) ? nil : t)
            }
        }
    }

    /// Any image (HEIC, PNG, a screenshot…) → a JPEG of at most 2048 px, decoded small
    /// so a 48 MP photo does not blow the extension's memory.
    private static func loadImage(_ p: NSItemProvider) async -> Data? {
        let id = UTType.image.identifier
        let viaFile = await withCheckedContinuation { (c: CheckedContinuation<Data?, Never>) in
            _ = p.loadFileRepresentation(forTypeIdentifier: id) { url, _ in
                // The file only lives during this callback: read it here.
                guard let url, let src = CGImageSourceCreateWithURL(url as CFURL, nil) else { c.resume(returning: nil); return }
                c.resume(returning: jpeg(src))
            }
        }
        if let viaFile { return viaFile }
        return await withCheckedContinuation { (c: CheckedContinuation<Data?, Never>) in
            _ = p.loadDataRepresentation(forTypeIdentifier: id) { data, _ in
                guard let data, let src = CGImageSourceCreateWithData(data as CFData, nil) else { c.resume(returning: nil); return }
                c.resume(returning: jpeg(src))
            }
        }
    }

    nonisolated private static func jpeg(_ src: CGImageSource) -> Data? {
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: 2048,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: 0.82] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? out as Data : nil
    }
}

/// The two or three calls this extension makes, with the app's token.
struct ShareAPI: Sendable {
    struct Failure: Error { let message: String }
    let token: String
    private static let base: URL = {
        #if DEBUG
        // Dev only: BGURU_DEV_BASE_URL in this extension's defaults talks to a local server.
        if let s = UserDefaults.standard.string(forKey: "BGURU_DEV_BASE_URL"), let u = URL(string: s) { return u }
        #endif
        return URL(string: "https://bsm.backspace.fm")!
    }()

    private var session: URLSession {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 30
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        cfg.httpAdditionalHeaders = ["User-Agent": "BguruChatShare/\(v)"]
        return URLSession(configuration: cfg)
    }

    private func request(_ path: String) -> URLRequest {
        var req = URLRequest(url: Self.base.appendingPathComponent(path))
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        return req
    }

    @discardableResult
    func postJSON(_ path: String, _ json: [String: Any]) async throws -> Data {
        var req = request(path)
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: json)
        return try await perform(req)
    }

    func upload(_ jpegs: [Data], path: String) async throws -> [String] {
        let boundary = "bguru-\(UUID().uuidString)"
        var body = Data()
        for (i, d) in jpegs.enumerated() {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"images\"; filename=\"photo\(i).jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8))
            body.append(d)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        var req = request(path)
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        req.timeoutInterval = 120
        let data = try await perform(req)
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        guard let urls = obj?["urls"] as? [String], urls.count == jpegs.count else {
            throw Failure(message: "写真を送れませんでした")
        }
        return urls
    }

    private func perform(_ req: URLRequest) async throws -> Data {
        let (data, resp) = try await session.data(for: req)
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if (200..<300).contains(status) { return data }
        if status == 401 { throw Failure(message: "ログインが切れています。B-guru Chat アプリを開いてログインし直してください") }
        let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        if let msg = obj?["error"] as? String, !msg.isEmpty { throw Failure(message: msg) }
        throw Failure(message: "送れませんでした（\(status)）")
    }
}
