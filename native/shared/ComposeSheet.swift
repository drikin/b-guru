import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import ImageIO

/// Text + up to 5 photos, shared by a new post (sheet) and a thread reply (bar).
/// Photos are resized (long side ≤ 2048 px) and sent as JPEG — HEIC and huge
/// originals never leave the phone — then the post references the uploaded URLs.
///
/// All image work happens off the main thread: the composer shows small previews,
/// and the 2048 px JPEGs are made from the original bytes in the background when
/// you send (doing it on the main thread froze the app for a second or more with a
/// few photos attached).
@MainActor
@Observable
final class PostDraft {
    var text = ""
    /// Previews for the composer (≤ 600 px).
    private(set) var images: [PlatformImage] = []
    /// The picked photos' original bytes, same order as `images`.
    private var originals: [Data] = []
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
            if let data = await Self.load(item), await append(data) {} else { failed += 1 }
        }
        error = failed > 0 ? "画像を \(failed) 枚読み込めませんでした（別の写真で試すか、ファイルから選んでください）" : nil
    }

    /// The photo's bytes; if the library will not hand them over directly (e.g. an
    /// original kept only in iCloud), take it as a file instead.
    private static func load(_ item: PhotosPickerItem) async -> Data? {
        if let data = try? await item.loadTransferable(type: Data.self), !data.isEmpty { return data }
        if let file = try? await item.loadTransferable(type: PickedImageFile.self) {
            defer { try? FileManager.default.removeItem(at: file.url) }
            if let data = try? Data(contentsOf: file.url), !data.isEmpty { return data }
        }
        return nil
    }

    /// Adds a photo if it decodes (preview made in the background). False if it is not an image.
    private func append(_ data: Data) async -> Bool {
        guard let cg = await Task.detached(priority: .userInitiated, operation: { MediaCache.decode(data, maxPixel: 600) }).value,
              images.count < maxImages else { return false }
        images.append(PlatformImage.decoded(cg))
        originals.append(data)
        return true
    }

    /// JPEG for upload from the original bytes: long side ≤ 2048 px, EXIF rotation
    /// applied, and no metadata at all (location and the rest never leave the device).
    nonisolated static func uploadJPEG(_ data: Data, maxSide: Int = 2048, quality: Double = 0.82) -> Data? {
        guard let cg = MediaCache.decode(data, maxPixel: maxSide) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, cg, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    /// macOS: images chosen with the file picker (or dropped on the composer).
    func add(fileURLs: [URL]) {
        var datas: [Data] = []
        var failed = 0
        for url in fileURLs.prefix(max(0, maxImages - images.count)) {
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            if let data = try? Data(contentsOf: url) { datas.append(data) } else { failed += 1 }
        }
        Task {
            for data in datas where !(await append(data)) { failed += 1 }
            error = failed > 0 ? "画像を \(failed) 枚読み込めませんでした" : nil
        }
    }

    /// A pasted image (macOS ⌘V of a screenshot).
    func add(imageData data: Data) {
        Task {
            if !(await append(data)) { error = "画像を読み込めませんでした" } else { error = nil }
        }
    }

    /// Hands the attached photos to a chat message and empties the tray.
    func takePhotos() -> OutgoingPhotos? {
        guard !originals.isEmpty else { return nil }
        let p = OutgoingPhotos(previews: images, originals: originals)
        images = []
        originals = []
        error = nil
        return p
    }

    func remove(_ i: Int) {
        guard images.indices.contains(i) else { return }
        images.remove(at: i)
        originals.remove(at: i)
    }

    /// Upload the photos, then publish. Returns the stored post, or nil (error set).
    func send(api: APIClient, parentId: Int?) async -> Post? {
        guard canSend else { return nil }
        sending = true
        error = nil
        defer { sending = false }
        do {
            var urls: [String] = []
            if !originals.isEmpty {
                let sources = originals
                let jpegs = await Task.detached(priority: .userInitiated) { sources.compactMap { PostDraft.uploadJPEG($0) } }.value
                guard jpegs.count == sources.count else {
                    error = "画像を送れる形に変換できませんでした"
                    return nil
                }
                urls = try await api.upload(images: jpegs)
            }
            let post = try await api.publish(text: text.trimmingCharacters(in: .whitespacesAndNewlines), images: urls, parentId: parentId)
            text = ""
            images = []
            originals = []
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

/// Photos on their way into a chat message: the previews show in the pending bubble,
/// the originals become small JPEGs when it is sent, and the uploaded URLs are kept so
/// a retry does not upload again.
@MainActor
final class OutgoingPhotos {
    let previews: [PlatformImage]
    let originals: [Data]
    var urls: [String]?

    init(previews: [PlatformImage], originals: [Data]) {
        self.previews = previews
        self.originals = originals
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
