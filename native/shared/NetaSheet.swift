import SwiftUI

/// 「ネタ帳に送る」の確認 (docs/neta-client-spec.md): BS ネタ帳 is a public site, so the
/// member always sees what goes out. The description starts empty — the post's own text
/// (members only) is never sent on its own.
struct NetaSheet: View {
    let post: Post
    let store: ChatStore
    let onClose: () -> Void

    @State private var url: String
    @State private var title: String
    @State private var note = ""
    @State private var sending = false
    @State private var outcome: NetaOutcome?
    private let urls: [String]

    init(post: Post, store: ChatStore, onClose: @escaping () -> Void) {
        self.post = post
        self.store = store
        self.onClose = onClose
        let urls = NetaLinks.candidates(text: post.text, previewURL: post.urlPreview?.url)
        self.urls = urls
        let first = urls.first ?? ""
        _url = State(initialValue: first)
        _title = State(initialValue: Self.defaultTitle(first, post))
    }

    private static func defaultTitle(_ url: String, _ post: Post) -> String {
        guard let p = post.urlPreview, p.url == url else { return "" }
        return String((p.title ?? "").trimmingCharacters(in: .whitespacesAndNewlines).prefix(200))
    }

    private var site: URL { URL(string: store.capabilities?.features?.neta?.site ?? "https://neta.backspace.fm") ?? URL(string: "https://neta.backspace.fm")! }
    private var canSend: Bool { !sending && !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !url.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("ネタ帳に送る").font(.headline)
            if let outcome { result(outcome) } else { form }
        }
        .padding(20)
        .frame(maxWidth: 420, alignment: .leading)
    }

    @ViewBuilder private var form: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("URL").font(.caption).foregroundStyle(.secondary)
            if urls.count > 1 {
                Picker("URL", selection: $url) {
                    ForEach(urls, id: \.self) { Text($0).lineLimit(1).truncationMode(.middle).tag($0) }
                }
                .labelsHidden()
                .onChange(of: url) { old, new in
                    // A title still at the old link's default follows the new link; an edited one stays.
                    if title == Self.defaultTitle(old, post) { title = Self.defaultTitle(new, post) }
                }
            } else {
                Text(url).font(.callout).lineLimit(2).truncationMode(.middle).textSelection(.enabled)
            }
        }
        VStack(alignment: .leading, spacing: 4) {
            Text("題名").font(.caption).foregroundStyle(.secondary)
            TextField("題名（必須）", text: $title, axis: .vertical)
                .lineLimit(1...3)
                .textFieldStyle(.roundedBorder)
                .onChange(of: title) { _, t in if t.count > 200 { title = String(t.prefix(200)) } }
        }
        VStack(alignment: .leading, spacing: 4) {
            Text("説明（任意）").font(.caption).foregroundStyle(.secondary)
            TextField("説明", text: $note, axis: .vertical)
                .lineLimit(2...5)
                .textFieldStyle(.roundedBorder)
                .onChange(of: note) { _, t in if t.count > 1000 { note = String(t.prefix(1000)) } }
        }
        Text("ネタ帳は公開サイトです。B-guru の表示名で投稿されます。")
            .font(.caption).foregroundStyle(.secondary)
        HStack {
            Spacer()
            Button("キャンセル", role: .cancel, action: onClose)
                .keyboardShortcut(.cancelAction)
                .disabled(sending)
            Button {
                send()
            } label: {
                if sending { ProgressView().controlSize(.small) } else { Text("送る") }
            }
            .buttonStyle(.borderedProminent)
            .disabled(!canSend)
        }
    }

    @ViewBuilder private func result(_ o: NetaOutcome) -> some View {
        switch o {
        case .sent:
            Label("ネタ帳に送りました", systemImage: "checkmark.circle.fill").foregroundStyle(.green)
        case .duplicate(let t, let who):
            Text("今週のネタ帳には \(who.isEmpty ? "だれか" : who) さんが「\(t)」として投稿済みです")
        case .failed(let message):
            Text(message).foregroundStyle(.red)
        }
        HStack {
            Spacer()
            if case .failed = o {
                Button("戻る") { outcome = nil }
            } else {
                Link("ネタ帳を開く", destination: site)
            }
            Button("閉じる", action: onClose).keyboardShortcut(.cancelAction)
        }
    }

    private func send() {
        guard canSend else { return }
        sending = true
        let t = title.trimmingCharacters(in: .whitespacesAndNewlines)
        let d = note.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            outcome = await store.sendToNeta(url: url, title: t, description: d)
            sending = false
        }
    }
}
