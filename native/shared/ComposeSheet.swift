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
        var failed = 0
        for item in items where images.count < maxImages {
            if let img = await Self.load(item) { images.append(img) } else { failed += 1 }
        }
        error = failed > 0 ? "画像を \(failed) 枚読み込めませんでした（別の写真で試すか、ファイルから選んでください）" : nil
    }

    /// The photo's bytes; if the library will not hand them over directly (e.g. an
    /// original kept only in iCloud), take it as a file instead.
    private static func load(_ item: PhotosPickerItem) async -> PlatformImage? {
        if let data = try? await item.loadTransferable(type: Data.self), let img = PlatformImage(data: data) { return img }
        if let file = try? await item.loadTransferable(type: PickedImageFile.self) {
            defer { try? FileManager.default.removeItem(at: file.url) }
            if let data = try? Data(contentsOf: file.url), let img = PlatformImage(data: data) { return img }
        }
        return nil
    }

    /// macOS: images chosen with the file picker (or dropped on the composer).
    func add(fileURLs: [URL]) {
        var failed = 0
        for url in fileURLs where images.count < maxImages {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url), let img = PlatformImage(data: data) { images.append(img) } else { failed += 1 }
        }
        error = failed > 0 ? "画像を \(failed) 枚読み込めませんでした" : nil
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
                guard jpegs.count == images.count else {
                    error = "画像を送れる形に変換できませんでした"
                    return nil
                }
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

/// A picked photo received as a file (copied out of the picker's temporary location).
struct PickedImageFile: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            let dst = FileManager.default.temporaryDirectory
                .appendingPathComponent(UUID().uuidString)
                .appendingPathExtension(received.file.pathExtension)
            try FileManager.default.copyItem(at: received.file, to: dst)
            return PickedImageFile(url: dst)
        }
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
    @State private var focused = false
    @State private var importing = false
    @Environment(\.dismiss) private var dismiss

    init(api: APIClient, parentId: Int?, maxImages: Int, onPosted: @escaping (Post) -> Void) {
        self.api = api
        self.parentId = parentId
        self.onPosted = onPosted
        _draft = State(initialValue: PostDraft(maxImages: maxImages))
    }

    private func post() {
        guard draft.canSend else { return }
        Task {
            if let post = await draft.send(api: api, parentId: parentId) {
                onPosted(post)
                dismiss()
            }
        }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 8) {
                PostTextInput(text: $draft.text, isFocused: $focused, placeholder: "いまどうしてる？",
                              minLines: 5, maxLines: 20, onSubmit: post)
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
                    Button(draft.sending ? "送信中…" : "投稿", action: post)
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
