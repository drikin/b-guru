import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

/// Text + up to 5 photos, shared by a new post (sheet) and a thread reply (bar).
/// Photos are resized (long side ≤ 2048 px) and sent as JPEG — HEIC and huge
/// originals never leave the phone — then the post references the uploaded URLs.
@MainActor
@Observable
final class PostDraft {
    var text = ""
    var images: [PlatformImage] = []
    var picks: [PhotosPickerItem] = [] {
        didSet { Task { await loadPicks() } }
    }
    private(set) var sending = false
    var error: String?
    let maxImages: Int

    init(maxImages: Int) { self.maxImages = maxImages }

    var canSend: Bool {
        !sending && (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty)
    }

    private func loadPicks() async {
        guard !picks.isEmpty else { return }
        let items = picks
        picks = []
        for item in items where images.count < maxImages {
            if let data = try? await item.loadTransferable(type: Data.self), let img = PlatformImage(data: data) {
                images.append(img)
            }
        }
    }

    /// macOS: images chosen with the file picker (or dropped on the composer).
    func add(fileURLs: [URL]) {
        for url in fileURLs where images.count < maxImages {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url), let img = PlatformImage(data: data) { images.append(img) }
        }
    }

    func remove(_ i: Int) { if images.indices.contains(i) { images.remove(at: i) } }

    /// Upload the photos, then publish. Returns the stored post, or nil (error set).
    func send(api: APIClient, parentId: Int?) async -> Post? {
        guard canSend else { return nil }
        sending = true
        error = nil
        defer { sending = false }
        do {
            var urls: [String] = []
            if !images.isEmpty {
                let jpegs = images.compactMap { $0.uploadJPEG() }
                urls = try await api.upload(images: jpegs)
            }
            let post = try await api.publish(text: text.trimmingCharacters(in: .whitespacesAndNewlines), images: urls, parentId: parentId)
            text = ""
            images = []
            return post
        } catch let e as APIError {
            switch e {
            case let .http(_, _, message): error = message ?? "投稿できませんでした"
            case .unauthorized: error = "ログインが切れました。再接続してください"
            case .transport: error = "通信できませんでした。もう一度お試しください"
            }
        } catch {
            self.error = "投稿できませんでした"
        }
        return nil
    }
}

/// Thumbnails of the attached photos with ✕.
struct DraftImages: View {
    let draft: PostDraft

    var body: some View {
        if !draft.images.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 6) {
                    ForEach(Array(draft.images.enumerated()), id: \.offset) { i, img in
                        Image(platformImage: img).resizable().scaledToFill()
                            .frame(width: 64, height: 64)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .overlay(alignment: .topTrailing) {
                                Button { draft.remove(i) } label: {
                                    Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.55))
                                }
                                .offset(x: 4, y: -4)
                                .accessibilityLabel("画像 \(i + 1) を外す")
                            }
                    }
                }
                .padding(.top, 4)
            }
        }
    }
}

/// New post.
struct ComposeSheet: View {
    let api: APIClient
    let parentId: Int?
    let onPosted: (Post) -> Void
    @State private var draft: PostDraft
    @FocusState private var focused: Bool
    @State private var importing = false
    @Environment(\.dismiss) private var dismiss

    init(api: APIClient, parentId: Int?, maxImages: Int, onPosted: @escaping (Post) -> Void) {
        self.api = api
        self.parentId = parentId
        self.onPosted = onPosted
        _draft = State(initialValue: PostDraft(maxImages: maxImages))
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                TextField("いまどうしてる？", text: $draft.text, axis: .vertical)
                    .lineLimit(5...20)
                    .focused($focused)
                DraftImages(draft: draft)
                if let e = draft.error { Text(e).font(.caption).foregroundStyle(.red) }
                Spacer()
                HStack {
                    PhotosPicker(selection: $draft.picks, maxSelectionCount: max(1, draft.maxImages - draft.images.count), matching: .images) {
                        Label("写真", systemImage: "photo.on.rectangle")
                    }
                    .disabled(draft.images.count >= draft.maxImages)
                    #if os(macOS)
                    Button { importing = true } label: { Label("ファイル…", systemImage: "folder") }
                        .disabled(draft.images.count >= draft.maxImages)
                    #endif
                    Text("\(draft.images.count)/\(draft.maxImages)").font(.caption).foregroundStyle(.secondary)
                    Spacer()
                }
            }
            .padding()
            .navigationTitle(parentId == nil ? "新しい投稿" : "返信")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { dismiss() }.disabled(draft.sending) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(draft.sending ? "送信中…" : "投稿") {
                        Task {
                            if let post = await draft.send(api: api, parentId: parentId) {
                                onPosted(post)
                                dismiss()
                            }
                        }
                    }
                    .disabled(!draft.canSend)
                }
            }
            .interactiveDismissDisabled(draft.sending || !draft.text.isEmpty || !draft.images.isEmpty)
            .fileImporter(isPresented: $importing, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
                if case let .success(urls) = result { draft.add(fileURLs: urls) }
            }
            .dropDestination(for: URL.self) { urls, _ in
                draft.add(fileURLs: urls)
                return true
            }
            #if os(macOS)
            .frame(minWidth: 420, minHeight: 320)
            #endif
            .onAppear { focused = true }
        }
    }
}
