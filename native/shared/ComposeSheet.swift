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
    /// A video or a sound (one of them, §10.2), a poll, a club chosen by hand — new posts only.
    /// Its temporary copy is removed when it is replaced, taken off or sent.
    var media: PickedMedia? {
        didSet { if let old = oldValue, old != media { old.discard() } }
    }
    var poll: PollDraft?
    var club: String?

    init(maxImages: Int) { self.maxImages = maxImages }

    var canSend: Bool {
        guard !sending else { return false }
        if let poll, !poll.isComplete { return false }
        return !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty || media != nil
    }

    /// Something typed or attached (closing would lose it).
    var hasContent: Bool { !text.isEmpty || !images.isEmpty || media != nil || poll != nil }

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

    /// Upload the photos (and the video / sound), then publish. Returns the stored post, or nil (error set).
    func send(api: APIClient, parentId: Int?, whisper: Bool = false) async -> Post? {
        guard canSend else { return nil }
        sending = true
        error = nil
        defer { sending = false }
        do {
            var body = PublishBody(text: text.trimmingCharacters(in: .whitespacesAndNewlines), parentId: parentId, whisper: whisper && parentId != nil)
            if let media {
                let url = try await api.uploadMedia(file: media.file, kind: media.kind)
                if media.kind == .video { body.videoUrl = url } else { body.audioUrl = url }
            }
            if let poll, parentId == nil {
                body.poll = .init(question: body.text, options: poll.labels, durationHours: poll.hours)
            }
            if parentId == nil { body.club = club }
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
            body.images = urls
            let post = try await api.publish(body)
            text = ""
            images = []
            originals = []
            media = nil
            poll = nil
            club = nil
            return post
        } catch let e as APIError {
            switch e {
            case let .http(_, code, message):
                error = code == "rate_limited" ? "少し時間をおいてから試してください" : (message ?? "投稿できませんでした")
            case .unauthorized: error = "ログインが切れました。再接続してください"
            case let .transport(m): error = m.hasPrefix("decode") || m.isEmpty ? "通信できませんでした。もう一度お試しください" : (m.contains("ファイル") ? m : "通信できませんでした。もう一度お試しください")
            }
        } catch {
            self.error = "投稿できませんでした"
        }
        return nil
    }
}

/// 📊 a poll being written (the web's composer): 3–10 answers of up to 100 characters, a
/// deadline of 1 / 6 / 12 / 24 hours. The question is the post's text.
struct PollDraft: Equatable {
    static let minOptions = 3
    static let maxOptions = 10
    static let maxLabel = 100
    static let durations = [1, 6, 12, 24]
    var options = ["", "", ""]
    var hours = 24

    var labels: [String] { options.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    var isComplete: Bool { labels.count >= Self.minOptions }
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

/// New post: text (with @mention completion), up to 5 photos, a video or a sound, a poll,
/// and a club chosen by hand (otherwise the server's AI sorts it) — the web's composer.
/// iPhone / iPad: a sheet. Mac: laid over the panel (a sheet bigger than the panel drew wrongly).
struct ComposeSheet: View {
    let api: APIClient
    let parentId: Int?
    let onPosted: (Post) -> Void
    var actions: PostActionsModel? = nil
    var clubs: [ClubInfo] = []
    /// Mac: the panel's overlay closes through this (a sheet uses dismiss).
    var onClose: (() -> Void)? = nil
    @State private var draft: PostDraft
    @State private var focused = false
    @State private var importKind: ImportKind?
    @State private var videoPick: PhotosPickerItem?
    @Environment(\.dismiss) private var dismiss

    enum ImportKind: Identifiable { case images, video, audio; var id: Self { self } }

    init(api: APIClient, parentId: Int?, maxImages: Int, actions: PostActionsModel? = nil, clubs: [ClubInfo] = [],
         onClose: (() -> Void)? = nil, onPosted: @escaping (Post) -> Void) {
        self.api = api
        self.parentId = parentId
        self.onPosted = onPosted
        self.actions = actions
        self.clubs = clubs
        self.onClose = onClose
        _draft = State(initialValue: PostDraft(maxImages: maxImages))
    }

    #if DEBUG
    /// Dev only: a composer already filled in (the self-test's pictures).
    init(api: APIClient, maxImages: Int, actions: PostActionsModel?, clubs: [ClubInfo], debugDraft: PostDraft) {
        self.api = api
        self.parentId = nil
        self.onPosted = { _ in }
        self.actions = actions
        self.clubs = clubs
        _draft = State(initialValue: debugDraft)
    }
    #endif

    private func close() {
        draft.media = nil // its temporary copy goes
        if let onClose { onClose() } else { dismiss() }
    }

    private func post() {
        guard draft.canSend else { return }
        Task {
            if let post = await draft.send(api: api, parentId: parentId) {
                onPosted(post)
                close()
            }
        }
    }

    private var canMedia: Bool { (actions?.canVideo ?? false) || (actions?.canAudio ?? false) }

    var body: some View {
        #if os(iOS)
        NavigationStack {
            ScrollView { form.padding() }
                .navigationTitle(parentId == nil ? "新しい投稿" : "返信")
                .inlineNavigationTitle()
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) { Button("キャンセル") { close() }.disabled(draft.sending) }
                    ToolbarItem(placement: .confirmationAction) {
                        Button(draft.sending ? "送信中…" : "投稿", action: post)
                        .disabled(!draft.canSend)
                    }
                }
                .interactiveDismissDisabled(draft.sending || draft.hasContent)
                .modifier(pickers)
                .onAppear { focused = true; actions?.loadMembers() }
                .onDisappear { draft.media = nil }
        }
        #else
        VStack(spacing: 0) {
            HStack {
                Button("キャンセル") { close() }.disabled(draft.sending).keyboardShortcut(.cancelAction)
                    .buttonStyle(FilledButtonStyle(fill: nil))
                Spacer()
                Text(parentId == nil ? "新しい投稿" : "返信").font(.headline)
                Spacer()
                Button(draft.sending ? "送信中…" : "投稿", action: post)
                    .buttonStyle(FilledButtonStyle(fill: Color.accentGreen))
                    .disabled(!draft.canSend)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            Divider()
            ScrollView { form.padding(14) }
        }
        .modifier(pickers)
        .dropDestination(for: URL.self) { urls, _ in
            draft.add(fileURLs: urls)
            return true
        }
        .onAppear { focused = true; actions?.loadMembers() }
        .onDisappear { draft.media = nil }
        #endif
    }

    private var pickers: ComposePickers { ComposePickers(draft: draft, importKind: $importKind, videoPick: $videoPick, maxMB: actions?.maxMediaMB ?? 100) }

    @ViewBuilder private var form: some View {
        VStack(alignment: .leading, spacing: 10) {
            let matches = actions?.mentionMatches(draft.text) ?? []
            if !matches.isEmpty {
                MentionSuggestions(members: matches) { m in draft.text = Mention.complete(draft.text, with: m.name); focused = true }
            }
            PostTextInput(text: $draft.text, isFocused: $focused, placeholder: draft.poll == nil ? "いまどうしてる？" : "投票の質問",
                          minLines: 5, maxLines: 20, onSubmit: post)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
            DraftImages(draft: draft)
            if let m = draft.media { MediaChip(media: m) { draft.media = nil } }
            if draft.poll != nil, parentId == nil {
                PollDraftEditor(poll: Binding(get: { draft.poll ?? PollDraft() }, set: { draft.poll = $0 }), onRemove: { draft.poll = nil })
            }
            if let e = draft.error { Text(e).font(.caption).foregroundStyle(.red) }
            attachRow
            if parentId == nil, actions?.canPickClub == true, !clubs.isEmpty {
                ClubPickMenu(clubs: clubs, selected: $draft.club)
            }
        }
    }

    private var attachRow: some View {
        // Wraps on a narrow panel / phone.
        FlowRow(spacing: 12) {
            let photos = "写真 \(draft.images.count)/\(draft.maxImages)" // (the picker's label closure is Sendable)
            PhotosPicker(selection: $draft.picks, maxSelectionCount: max(1, draft.maxImages - draft.images.count), matching: .images) {
                Label(photos, systemImage: "photo.on.rectangle")
            }
            .disabled(draft.images.count >= draft.maxImages)
            #if os(iOS)
            CameraButton(draft: draft) { Label("カメラ", systemImage: "camera") }
            #endif
            #if os(macOS)
            Button { importKind = .images } label: { Label("ファイルから", systemImage: "folder") }
                .disabled(draft.images.count >= draft.maxImages)
            #endif
            if actions?.canVideo == true {
                #if os(iOS)
                PhotosPicker(selection: $videoPick, matching: .videos) { Label("動画", systemImage: "film") }
                    .disabled(draft.media != nil)
                #else
                Button { importKind = .video } label: { Label("動画", systemImage: "film") }.disabled(draft.media != nil)
                #endif
            }
            if actions?.canAudio == true {
                Button { importKind = .audio } label: { Label("音声", systemImage: "waveform") }.disabled(draft.media != nil)
            }
            if actions?.canPoll == true, parentId == nil {
                Button { draft.poll = draft.poll == nil ? PollDraft() : nil } label: { Label("投票", systemImage: "chart.bar") }
                    .tint(draft.poll == nil ? nil : Color.accentGreen)
            }
        }
        .buttonStyle(.borderless)
        .font(.callout)
        .lineLimit(1)
        .fixedSize(horizontal: false, vertical: true)
    }
}

/// The file pickers of a composer (photos from files on the Mac, a video, a sound).
struct ComposePickers: ViewModifier {
    let draft: PostDraft
    @Binding var importKind: ComposeSheet.ImportKind?
    @Binding var videoPick: PhotosPickerItem?
    let maxMB: Int

    func body(content: Content) -> some View {
        content
            .fileImporter(isPresented: Binding(get: { importKind != nil }, set: { if !$0 { importKind = nil } }),
                          allowedContentTypes: types, allowsMultipleSelection: importKind == .images) { result in
                let kind = importKind
                importKind = nil
                guard case let .success(urls) = result else { return }
                switch kind {
                case .images: draft.add(fileURLs: urls)
                case .video: if let u = urls.first { take(u, .video) }
                case .audio: if let u = urls.first { take(u, .audio) }
                case nil: break
                }
            }
            .onChange(of: videoPick) { _, item in
                guard let item else { return }
                videoPick = nil
                Task {
                    if let f = try? await item.loadTransferable(type: PickedMovieFile.self) {
                        take(f.url, .video, copy: false)
                    } else {
                        draft.error = "動画を読み込めませんでした"
                    }
                }
            }
    }

    private var types: [UTType] {
        switch importKind {
        case .images: return [.image]
        case .video: return MediaKind.video.contentTypes
        case .audio: return MediaKind.audio.contentTypes
        case nil: return [.item]
        }
    }

    private func take(_ url: URL, _ kind: MediaKind, copy: Bool = true) {
        let picked = copy ? PickedMedia.copy(url, kind: kind) : PickedMedia(kind: kind, file: url)
        guard let picked else { draft.error = "\(kind.label)を読み込めませんでした"; return }
        if let problem = kind.problem(with: picked.file, maxMB: maxMB) { picked.discard(); draft.error = problem; return }
        draft.error = nil
        draft.media = picked
    }
}

/// The attached video / sound, with ✕.
struct MediaChip: View {
    let media: PickedMedia
    let onRemove: () -> Void
    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: media.kind == .video ? "film" : "waveform").foregroundStyle(Color.accentGreen)
            VStack(alignment: .leading, spacing: 1) {
                Text(media.name).font(.callout).lineLimit(1).truncationMode(.middle)
                Text("\(media.kind.label)・\(media.sizeText)").font(.caption).foregroundStyle(.secondary)
            }
            Spacer(minLength: 0)
            Button(action: onRemove) { Image(systemName: "xmark.circle.fill").foregroundStyle(.secondary) }
                .buttonStyle(.plain)
                .accessibilityLabel("\(media.kind.label)を外す")
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.05)))
    }
}

/// 📊 the poll part of a new post (the web's: deadline buttons, answers with ✕, ＋ 回答を追加).
struct PollDraftEditor: View {
    @Binding var poll: PollDraft
    let onRemove: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text("アンケート").font(.subheadline.bold())
                Spacer(minLength: 4)
                Text("締切").font(.caption).foregroundStyle(.secondary)
                ForEach(PollDraft.durations, id: \.self) { h in
                    Button("\(h)時間") { poll.hours = h }
                        .font(.caption.weight(poll.hours == h ? .bold : .regular))
                        .padding(.horizontal, 6).padding(.vertical, 3)
                        .background(Capsule().fill(poll.hours == h ? Color.accentGreen : .clear))
                        .foregroundStyle(poll.hours == h ? Color.white : Color.accentGreen)
                        .buttonStyle(.plain)
                }
                Button(action: onRemove) { Image(systemName: "xmark") }
                    .buttonStyle(.borderless).accessibilityLabel("アンケートをやめる")
            }
            Text("質問は投稿の本文になります。本文に投票の質問を書いてね。").font(.caption).foregroundStyle(.secondary)
            ForEach(poll.options.indices, id: \.self) { i in
                HStack(spacing: 6) {
                    TextField("回答 \(i + 1)", text: Binding(get: { poll.options[i] },
                                                          set: { poll.options[i] = String($0.prefix(PollDraft.maxLabel)) }))
                        .textFieldStyle(.roundedBorder)
                        .accessibilityLabel("回答 \(i + 1)")
                    Button { poll.options.remove(at: i) } label: { Image(systemName: "xmark") }
                        .buttonStyle(.borderless)
                        .disabled(poll.options.count <= PollDraft.minOptions)
                        .accessibilityLabel("回答 \(i + 1) を削除")
                }
            }
            Button("＋ 回答を追加（\(poll.options.count)/\(PollDraft.maxOptions)）") { poll.options.append("") }
                .buttonStyle(.borderless).font(.caption).tint(Color.accentGreen)
                .disabled(poll.options.count >= PollDraft.maxOptions)
            Text("投票は1人1回・締切まで回答を変更できます。").font(.caption).foregroundStyle(.secondary)
        }
        .padding(10)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.1)))
    }
}

/// 部活: chosen by hand, or 「自動で分類」 (the server's AI picks one after posting).
struct ClubPickMenu: View {
    let clubs: [ClubInfo]
    @Binding var selected: String?
    var body: some View {
        Menu {
            Button { selected = nil } label: { if selected == nil { Label("自動で分類", systemImage: "checkmark") } else { Text("自動で分類") } }
            Section("部活動を選択") {
                ForEach(clubs, id: \.key) { c in
                    Button { selected = c.key } label: {
                        if selected == c.key { Label(c.name, systemImage: "checkmark") } else { Text(c.name) }
                    }
                }
            }
        } label: {
            Label("部活：\(clubs.first { $0.key == selected }?.name ?? "自動で分類（AI）")", systemImage: "tag")
                .font(.callout)
        }
        .fixedSize()
        .accessibilityLabel("部活動を選択")
    }
}
