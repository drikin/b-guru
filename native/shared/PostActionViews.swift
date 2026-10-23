import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// The screens of the timeline's operations (docs/timeline-spec.md §10.2): the post's menu,
// the poll card, edit / delete / poll answers dialogs, the pinned / bookmark lists, the toast.

// MARK: - The post's menu (long press on iPhone / iPad, right click on the Mac)

/// The web's card buttons, in its order: 🔖・チャットに引用・ネタ帳に送る・☆・リアクション・📌・
/// 部活・✏️・🗑. Each only when the server offers it (§10.2).
struct PostMenuItems: View {
    let post: Post
    let actions: PostActionsModel?
    let canReact: Bool
    let onReact: (String) -> Void
    let quoteToChat: PostAction?
    let sendToNeta: PostAction?
    let clubs: [ClubInfo]

    var body: some View {
        if let actions, actions.canBookmark, post.id > 0 {
            if post.bookmarkedByMe == true {
                Button("ブックマークを外す", systemImage: "bookmark.slash") { actions.toggleBookmark(post) }
            } else {
                Button("ブックマーク", systemImage: "bookmark") { actions.toggleBookmark(post) }
            }
        }
        if let quoteToChat {
            Button("チャットに引用", systemImage: "quote.bubble") { quoteToChat(post) }
        }
        // The article the post links to (not the post itself) — docs/neta-client-spec.md.
        if let sendToNeta, !NetaLinks.candidates(text: post.text, previewURL: post.urlPreview?.url).isEmpty {
            Button("ネタ帳に送る", systemImage: "note.text.badge.plus") { sendToNeta(post) }
        }
        if let actions, actions.canFavorite(post) {
            if post.favoriteByMe == true {
                Button("お気に入りから外す", systemImage: "star.slash") { actions.toggleFavorite(post) }
            } else {
                Button("お気に入りに追加", systemImage: "star") { actions.toggleFavorite(post) }
            }
        }
        if canReact {
            Menu {
                ForEach(ReactionPicker.unicode, id: \.self) { e in Button(e) { onReact(e) } }
                if let actions {
                    Divider()
                    Button("ほかの絵文字…", systemImage: "face.smiling") {
                        actions.loadEmojis()
                        actions.picker = ReactionPickRequest(postId: post.id, onPick: onReact)
                    }
                }
            } label: {
                Label("リアクション", systemImage: "face.smiling")
            }
        }
        if let actions, actions.canPin(post) {
            if PostActionsModel.isPinned(post) {
                Button("ピンを外す", systemImage: "pin.slash") { actions.togglePin(post) }
            } else {
                Button("ピン（24時間）", systemImage: "pin") { actions.togglePin(post) }
            }
        }
        if let actions, actions.canChangeClub(post), !clubs.isEmpty {
            Menu { ClubChoices(post: post, actions: actions, clubs: clubs) } label: { Label("部活動を選択", systemImage: "tag") }
        }
        if let actions, actions.canEdit(post) {
            Button("編集", systemImage: "pencil") { actions.editing = post }
        } else if let actions, actions.needsReloginToEdit(post) {
            // The key was issued before the operations (post, but no edit): an explanation, not a button.
            Button("編集するには一度ログインし直してください", systemImage: "pencil.slash") {}
                .disabled(true)
        }
        if let actions, actions.canDelete(post) {
            Button("削除", systemImage: "trash", role: .destructive) { actions.deleting = post }
        }
    }
}

/// 「部活動を選択」: the clubs (✓ on the current one), then 「ラベルなし」 (red) — the web's.
struct ClubChoices: View {
    let post: Post
    let actions: PostActionsModel
    let clubs: [ClubInfo]
    var body: some View {
        Section("部活動を選択") {
            ForEach(clubs, id: \.key) { c in
                Button { actions.setClub(post, key: c.key) } label: {
                    if post.club == c.key { Label(c.name, systemImage: "checkmark") } else { Text(c.name) }
                }
            }
        }
        Button("ラベルなし", role: .destructive) { actions.setClub(post, key: nil) }
    }
}

/// The club's tag on my own root post opens 「部活動を選択」; 「＋部活」 when it has none.
struct ClubTag: View {
    let post: Post
    let name: String?
    @Environment(\.postActions) private var actions
    @Environment(\.postClubs) private var clubs

    var body: some View {
        if let actions, actions.canChangeClub(post), !clubs.isEmpty {
            Menu { ClubChoices(post: post, actions: actions, clubs: clubs) } label: { tag(name ?? "＋部活", dashed: name == nil) }
                .menuStyle(.button)
                .buttonStyle(.plain)
                .menuIndicator(.hidden)
                .fixedSize()
                .accessibilityLabel(name.map { "部活：\($0)（変更）" } ?? "部活を付ける")
        } else if let name {
            tag(name, dashed: false)
        }
    }

    private func tag(_ text: String, dashed: Bool) -> some View {
        // 「未設定」 (the AI could not tell the club) is grey, as on the web.
        let tint = (post.display?.clubUnset == true || dashed) ? Color.secondary : Color.accentGreen
        return Text(text).font(.caption2.bold())
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(Capsule().fill(tint.opacity(dashed ? 0 : 0.14)))
            .overlay(Capsule().strokeBorder(tint.opacity(dashed ? 0.5 : 0), style: StrokeStyle(lineWidth: 1, dash: [3, 2])))
            .foregroundStyle(tint)
    }
}

extension EnvironmentValues {
    /// The clubs (for 「部活動を選択」), in the server's order.
    @Entry var postClubs: [ClubInfo] = []
}

#if os(macOS)
/// Mac: the web's card buttons at the post's top right while the pointer is over it.
struct PostHoverBar: View {
    let post: Post
    let actions: PostActionsModel
    let canReact: Bool
    let onReact: (String) -> Void
    /// Held by the post: the bar must not go away while its popover is open.
    @Binding var picking: Bool

    var body: some View {
        HStack(spacing: 0) {
            if actions.canBookmark {
                ActionButton(systemImage: post.bookmarkedByMe == true ? "bookmark.fill" : "bookmark", text: nil,
                             help: post.bookmarkedByMe == true ? "ブックマークを外す" : "ブックマーク",
                             tint: post.bookmarkedByMe == true ? .blue : nil) { actions.toggleBookmark(post) }
            }
            if actions.canFavorite(post) {
                ActionButton(systemImage: post.favoriteByMe == true ? "star.fill" : "star", text: nil,
                             help: post.favoriteByMe == true ? "お気に入りから外す" : "お気に入りに追加",
                             tint: post.favoriteByMe == true ? .yellow : nil) { actions.toggleFavorite(post) }
            }
            if canReact {
                ActionButton(systemImage: "face.smiling", text: nil, help: "リアクション") { actions.loadEmojis(); picking = true }
                    .popover(isPresented: $picking, arrowEdge: .bottom) {
                        ReactionPicker { e in picking = false; onReact(e) }
                    }
            }
            if actions.canPin(post) {
                let pinned = PostActionsModel.isPinned(post)
                ActionButton(systemImage: pinned ? "pin.fill" : "pin", text: nil, help: pinned ? "ピンを外す" : "ピン（24時間）") { actions.togglePin(post) }
            }
            if actions.canEdit(post) {
                ActionButton(systemImage: "pencil", text: nil, help: "編集") { actions.editing = post }
            }
            if actions.canDelete(post) {
                ActionButton(systemImage: "trash", text: nil, help: "削除", tint: .red) { actions.deleting = post }
            }
        }
        .padding(2)
        .background(Capsule().fill(.background).shadow(color: .black.opacity(0.12), radius: 2, y: 1))
    }
}
#endif

// MARK: - 📊 投票

/// The poll under a post (the web's PollCard): 「📊 投票（N票）」, the answers (tap to vote, again
/// on another to change), the shares, 「N人が投票 · 全N票」 and the time left, 「回答を編集」.
struct PollCard: View {
    let post: Post
    let poll: PostPoll
    @Environment(\.postActions) private var actions

    private var closed: Bool {
        if poll.closed == true { return true }
        guard let s = poll.endsAt, let d = PostActionsModel.parseDate(s) else { return false }
        return Date() > d
    }
    private var total: Int { poll.totalVotes ?? poll.options.reduce(0) { $0 + ($1.votes ?? 0) } }
    private var canVote: Bool { !closed && (actions?.canVote ?? false) && post.id > 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("📊 投票（\(total)票）").font(.caption.bold()).foregroundStyle(.secondary)
                Spacer()
                if let actions, actions.canEditPoll(post) {
                    Button { actions.pollEditing = post } label: { Image(systemName: "pencil").font(.caption) }
                        .buttonStyle(.borderless)
                        .help("回答を編集")
                        .accessibilityLabel("回答を編集")
                }
            }
            ForEach(poll.options) { o in
                let mine = poll.myVote == o.id
                Button { actions?.vote(post, option: o.id) } label: {
                    HStack(spacing: 6) {
                        Text(o.label).font(.subheadline.weight(mine ? .bold : .medium)).foregroundStyle(.primary)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 4)
                        if mine && !closed {
                            Text("あなたの投票").font(.caption2.bold())
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Capsule().fill(Color.accentGreen.opacity(0.18)))
                                .foregroundStyle(Color.accentGreen)
                        }
                        if total > 0 {
                            Text("\(o.votes ?? 0)票 (\(Int(o.pct ?? 0))%)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
                        }
                    }
                    .padding(.horizontal, 10).padding(.vertical, 8)
                    .background(alignment: .leading) {
                        if total > 0 {
                            GeometryReader { g in
                                Rectangle().fill(Color.accentGreen.opacity(0.18))
                                    .frame(width: g.size.width * CGFloat(min(100, max(0, o.pct ?? 0))) / 100)
                            }
                        }
                    }
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.platformBackground))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(mine ? Color.accentGreen : Color.primary.opacity(0.15), lineWidth: mine ? 2 : 1))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canVote)
                .opacity(closed ? 0.75 : 1)
                .accessibilityLabel("\(o.label)、\(o.votes ?? 0)票")
                .accessibilityHint(closed ? "投票が終了しました" : mine ? "投票済み" : "投票する")
            }
            HStack {
                Text((closed ? "締め切りました" : total > 0 ? "\(total)人が投票" : "まだ投票はありません") + " · 全\(total)票")
                Spacer()
                Text(closed ? "終了" : Self.timeLeft(poll.endsAt))
            }
            .font(.caption).foregroundStyle(.secondary)
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.1)))
    }

    /// The web's pollTimeLeft: 「あと N分」「あと N時間M分」「あと N日M時間」.
    static func timeLeft(_ endsAt: String?, now: Date = Date()) -> String {
        guard let s = endsAt, let d = PostActionsModel.parseDate(s) else { return "" }
        let diff = d.timeIntervalSince(now)
        guard diff > 0 else { return "終了" }
        let m = Int(diff / 60)
        if m < 60 { return "あと\(m)分" }
        let h = m / 60, mm = m % 60, days = h / 24
        if days > 0 { return "あと\(days)日\(h % 24)時間" }
        return mm > 0 ? "あと\(h)時間\(mm)分" : "あと\(h)時間"
    }
}

extension Color {
    /// The card's own background (the poll's answers sit on it).
    static var platformBackground: Color {
        #if os(iOS)
        Color(uiColor: .systemBackground)
        #else
        Color(nsColor: .textBackgroundColor)
        #endif
    }
}

// MARK: - Dialogs (the web's modals: title, body, error in red, キャンセル / the action)

/// iPhone / iPad: a sheet. Mac: laid over the panel (a sheet bigger than the panel drew wrongly,
/// and an alert would take the panel's focus — it hides itself when it loses focus).
struct PanelDialog<Item: Identifiable, Dialog: View>: ViewModifier {
    @Binding var item: Item?
    var detents: Set<PresentationDetent> = [.medium, .large]
    @ViewBuilder let dialog: (Item) -> Dialog

    func body(content: Content) -> some View {
        #if os(iOS)
        content.sheet(item: $item) { it in
            dialog(it)
                .presentationDetents(detents)
                .presentationDragIndicator(.visible)
        }
        #else
        content.overlay {
            if let it = item {
                ZStack {
                    Color.black.opacity(0.35).ignoresSafeArea()
                        .onTapGesture { item = nil }
                    dialog(it)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                        .shadow(radius: 12)
                        .padding(14)
                }
                .transition(.opacity)
            }
        }
        #endif
    }
}

extension View {
    func panelDialog<Item: Identifiable, Dialog: View>(_ item: Binding<Item?>, detents: Set<PresentationDetent> = [.medium, .large],
                                                      @ViewBuilder _ dialog: @escaping (Item) -> Dialog) -> some View {
        modifier(PanelDialog(item: item, detents: detents, dialog: dialog))
    }
}

/// A filled button whose colour shows whether or not the window is key (macOS greys the
/// system's prominent buttons in a panel that is not key — 「削除する」 was not red).
/// `fill` nil = the plain grey 「キャンセル」. Only a disabled button is faded.
struct FilledButtonStyle: ButtonStyle {
    let fill: Color?
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.callout.weight(fill == nil ? .regular : .semibold))
            .foregroundStyle(fill == nil ? Color.primary : Color.white)
            .padding(.horizontal, 14).padding(.vertical, 7)
            .background(Capsule().fill(fill ?? Color.primary.opacity(0.1)))
            .opacity(enabled ? (configuration.isPressed ? 0.75 : 1) : 0.4)
            .contentShape(Capsule())
    }
}

/// Title, content, the error, and 「キャンセル」 + the action at the bottom right (the web's modal).
struct DialogFrame<Content: View>: View {
    let title: String
    let confirm: String
    var destructive = false
    var busy = false
    var canConfirm = true
    let error: String?
    let onCancel: () -> Void
    let onConfirm: () -> Void
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text(title).font(.headline)
                Spacer()
                Button(action: onCancel) { Image(systemName: "xmark").font(.callout) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("閉じる")
            }
            // As tall as its content (a short question is a short dialog); scrolls only when too tall.
            ViewThatFits(in: .vertical) {
                content().frame(maxWidth: .infinity, alignment: .leading)
                ScrollView { content().frame(maxWidth: .infinity, alignment: .leading) }
                    .scrollBounceBehavior(.basedOnSize)
            }
            if let error {
                Text(error).font(.callout).foregroundStyle(.red).fixedSize(horizontal: false, vertical: true)
            }
            HStack {
                Spacer()
                Button("キャンセル", action: onCancel)
                    .buttonStyle(FilledButtonStyle(fill: nil))
                    .keyboardShortcut(.cancelAction)
                Button(action: onConfirm) {
                    HStack(spacing: 6) {
                        if busy { ProgressView().controlSize(.small).tint(.white) }
                        Text(confirm)
                    }
                }
                .buttonStyle(FilledButtonStyle(fill: destructive ? .red : Color.accentGreen))
                .disabled(busy || !canConfirm)
            }
        }
        .padding(16)
        .frame(maxWidth: 520)
    }
}

/// 「投稿を削除」 — the web's words. A failure shows the server's error inside, in red.
struct DeletePostDialog: View {
    let post: Post
    let actions: PostActionsModel
    @State private var busy = false
    @State private var error: String?
    #if DEBUG
    var debugError: String? = nil
    #endif

    var body: some View {
        DialogFrame(title: "投稿を削除", confirm: "削除する", destructive: true, busy: busy, error: shownError,
                    onCancel: { actions.deleting = nil }, onConfirm: delete) {
            Text("この投稿を削除しますか？この操作は取り消せません。").font(.callout)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var shownError: String? {
        #if DEBUG
        if let debugError { return debugError }
        #endif
        return error
    }

    private func delete() {
        busy = true
        error = nil
        Task {
            let e = await actions.delete(post)
            busy = false
            if let e { error = e } else { actions.deleting = nil }
        }
    }
}

/// A picture of a post being edited: one already on the server, or one just picked.
enum EditImage: Identifiable {
    case remote(String)
    case local(id: UUID, preview: PlatformImage, data: Data)
    var id: String {
        switch self {
        case let .remote(u): return u
        case let .local(id, _, _): return id.uuidString
        }
    }
}

/// 「投稿を編集」: the text (with @mention completion), the pictures (reorder, remove, add — 5 at
/// most) and the sound (attach / remove). The video stays (the web's). A text-only key: the text.
struct EditPostDialog: View {
    let post: Post
    let actions: PostActionsModel
    @State private var text: String
    @State private var images: [EditImage]
    /// nil: no sound; the URL (on the server) or a file just picked.
    @State private var audio: String?
    @State private var newAudio: PickedMedia?
    @State private var picks: [PhotosPickerItem] = []
    @State private var importing: MediaKind?
    @State private var importingImages = false
    @State private var focused = false
    @State private var busy = false
    @State private var error: String?

    init(post: Post, actions: PostActionsModel) {
        self.post = post
        self.actions = actions
        _text = State(initialValue: post.text)
        _images = State(initialValue: (post.images ?? []).map { .remote($0) })
        _audio = State(initialValue: post.audioUrl)
    }

    private var full: Bool { !actions.editTextOnly }

    var body: some View {
        DialogFrame(title: "投稿を編集", confirm: "保存する", busy: busy, error: error,
                    onCancel: { actions.editing = nil }, onConfirm: save) {
            VStack(alignment: .leading, spacing: 10) {
                let matches = actions.mentionMatches(text)
                if !matches.isEmpty {
                    MentionSuggestions(members: matches) { m in text = Mention.complete(text, with: m.name); focused = true }
                }
                PostTextInput(text: $text, isFocused: $focused, placeholder: "本文", minLines: 3, maxLines: 12, onSubmit: save)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
                if full {
                    if !images.isEmpty { thumbnails }
                    if let name = audioName {
                        HStack(spacing: 8) {
                            Image(systemName: "waveform").foregroundStyle(Color.accentGreen)
                            Text(name).font(.callout).lineLimit(1).truncationMode(.middle)
                            Spacer()
                            Button { audio = nil; newAudio?.discard(); newAudio = nil } label: { Image(systemName: "xmark.circle.fill").foregroundStyle(.red) }
                                .buttonStyle(.plain).accessibilityLabel("音声を外す")
                        }
                        .padding(8)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.primary.opacity(0.05)))
                    }
                    HStack(spacing: 14) {
                        let photos = "📷 \(images.count)/5" // (the picker's label closure is Sendable)
                        PhotosPicker(selection: $picks, maxSelectionCount: max(1, 5 - images.count), matching: .images) {
                            Text(photos)
                        }
                        .disabled(images.count >= 5)
                        #if os(macOS)
                        Button("ファイルから") { importingImages = true }.disabled(images.count >= 5)
                        #endif
                        if actions.canAudio {
                            Button("🎵 音声") { importing = .audio }
                                .disabled(audioName != nil || post.videoUrl != nil)
                                .help(post.videoUrl != nil ? "動画と音声は同時に添付できません" : "音声を付ける")
                        }
                        if post.videoUrl != nil {
                            Text("動画は変えられません").font(.caption).foregroundStyle(.secondary)
                        }
                    }
                    .buttonStyle(.borderless)
                    .font(.callout)
                }
            }
        }
        .onAppear { actions.loadMembers() }
        .onDisappear { newAudio?.discard() } // sent or cancelled: the temporary copy goes
        .onChange(of: picks) { _, items in
            guard !items.isEmpty else { return }
            picks = []
            Task {
                for item in items where images.count < 5 {
                    if let data = try? await item.loadTransferable(type: Data.self) { await add(data) }
                }
            }
        }
        .fileImporter(isPresented: Binding(get: { importing != nil || importingImages }, set: { if !$0 { importing = nil; importingImages = false } }),
                      allowedContentTypes: importingImages ? [.image] : MediaKind.audio.contentTypes,
                      allowsMultipleSelection: importingImages) { result in
            let wasImages = importingImages
            importing = nil
            importingImages = false
            guard case let .success(urls) = result else { return }
            if wasImages {
                Task {
                    for u in urls.prefix(5 - images.count) {
                        let scoped = u.startAccessingSecurityScopedResource()
                        let data = try? Data(contentsOf: u)
                        if scoped { u.stopAccessingSecurityScopedResource() }
                        if let data { await add(data) }
                    }
                }
            } else if let u = urls.first {
                guard let m = PickedMedia.copy(u, kind: .audio) else { error = "音声を読み込めませんでした"; return }
                if let p = MediaKind.audio.problem(with: m.file, maxMB: actions.maxMediaMB) { m.discard(); error = p; return }
                error = nil
                newAudio?.discard()
                newAudio = m
            }
        }
    }

    private var audioName: String? {
        if let newAudio { return newAudio.name }
        return audio.map { URL(string: $0)?.lastPathComponent ?? "音声" }
    }

    private func add(_ data: Data) async {
        guard let cg = await Task.detached(priority: .userInitiated, operation: { MediaCache.decode(data, maxPixel: 600) }).value else {
            error = "画像を読み込めませんでした"
            return
        }
        guard images.count < 5 else { return }
        images.append(.local(id: UUID(), preview: PlatformImage.decoded(cg), data: data))
    }

    private var thumbnails: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(Array(images.enumerated()), id: \.element.id) { i, img in
                    VStack(spacing: 4) {
                        Group {
                            switch img {
                            case let .remote(u): MediaImage(path: u, maxPixel: 200)
                            case let .local(_, preview, _): Image(platformImage: preview).resizable().scaledToFill()
                            }
                        }
                        .frame(width: 64, height: 64)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .overlay(alignment: .topTrailing) {
                            Button { images.remove(at: i) } label: {
                                Image(systemName: "xmark.circle.fill").symbolRenderingMode(.palette).foregroundStyle(.white, .red)
                            }
                            .buttonStyle(.plain)
                            .offset(x: 5, y: -5)
                            .accessibilityLabel("画像 \(i + 1) を外す")
                        }
                        if images.count > 1 {
                            HStack(spacing: 10) {
                                Button { images.swapAt(i, i - 1) } label: { Image(systemName: "chevron.left") }
                                    .disabled(i == 0).accessibilityLabel("画像 \(i + 1) を前へ")
                                Button { images.swapAt(i, i + 1) } label: { Image(systemName: "chevron.right") }
                                    .disabled(i == images.count - 1).accessibilityLabel("画像 \(i + 1) を後ろへ")
                            }
                            .buttonStyle(.borderless)
                            .font(.caption)
                        }
                    }
                }
            }
            .padding(.top, 6)
        }
    }

    private func save() {
        guard !busy else { return }
        busy = true
        error = nil
        Task {
            defer { busy = false }
            var urls: [String]? = nil
            var audioChange: String?? = nil
            if full {
                let locals = images.compactMap { if case let .local(_, _, d) = $0 { return d } else { return nil } }
                var uploaded: [String] = []
                if !locals.isEmpty {
                    let jpegs = await Task.detached(priority: .userInitiated) { locals.compactMap { PostDraft.uploadJPEG($0) } }.value
                    guard jpegs.count == locals.count else { error = "画像を送れる形に変換できませんでした"; return }
                    do { uploaded = try await actions.api.upload(images: jpegs) } catch {
                        self.error = PostActionsModel.message(error, fallback: "画像を送れませんでした")
                        return
                    }
                }
                var next = uploaded.makeIterator()
                urls = images.compactMap { img in
                    switch img {
                    case let .remote(u): return u
                    case .local: return next.next()
                    }
                }
                if let newAudio {
                    do { audioChange = .some(try await actions.api.uploadMedia(file: newAudio.file, kind: .audio)) } catch {
                        self.error = PostActionsModel.message(error, fallback: "音声を送れませんでした")
                        return
                    }
                } else if audio != post.audioUrl {
                    audioChange = .some(audio) // taken off
                }
            }
            if let e = await actions.saveEdit(post, text: text, images: urls, audio: audioChange) {
                error = e
            } else {
                actions.editing = nil
            }
        }
    }
}

/// 「アンケートの回答を編集」: within an hour of posting; an answer with votes cannot be removed.
struct PollEditDialog: View {
    let post: Post
    let actions: PostActionsModel
    struct Row: Identifiable { let id = UUID(); var optionId: Int?; var label: String; var votes: Int }
    @State private var rows: [Row]
    @State private var busy = false
    @State private var error: String?

    init(post: Post, actions: PostActionsModel) {
        self.post = post
        self.actions = actions
        _rows = State(initialValue: (post.poll?.options ?? []).map { Row(optionId: $0.id, label: $0.label, votes: $0.votes ?? 0) })
    }

    private var filled: Int { rows.filter { !$0.label.trimmingCharacters(in: .whitespaces).isEmpty }.count }

    var body: some View {
        DialogFrame(title: "アンケートの回答を編集", confirm: "保存する", busy: busy, canConfirm: filled >= PollDraft.minOptions,
                    error: error, onCancel: { actions.pollEditing = nil }, onConfirm: save) {
            VStack(alignment: .leading, spacing: 6) {
                Text("回答の編集は投稿後1時間以内のみです。投票が付いた回答は削除できません。")
                    .font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                ForEach($rows) { $row in
                    let i = rows.firstIndex { $0.id == row.id } ?? 0
                    HStack(spacing: 6) {
                        TextField("回答 \(i + 1)", text: Binding(get: { row.label }, set: { row.label = String($0.prefix(PollDraft.maxLabel)) }))
                            .textFieldStyle(.roundedBorder)
                            .accessibilityLabel("回答 \(i + 1)")
                        Button { rows.removeAll { $0.id == row.id } } label: { Image(systemName: "xmark") }
                            .buttonStyle(.borderless)
                            .disabled(row.votes > 0 || rows.count <= PollDraft.minOptions)
                            .help(row.votes > 0 ? "投票が付いているため削除できません" : "回答を削除")
                    }
                }
                Button("＋ 回答を追加（\(rows.count)/\(PollDraft.maxOptions)）") { rows.append(Row(optionId: nil, label: "", votes: 0)) }
                    .buttonStyle(.borderless).font(.caption).tint(Color.accentGreen)
                    .disabled(rows.count >= PollDraft.maxOptions)
            }
        }
    }

    private func save() {
        busy = true
        error = nil
        let opts = rows.filter { !$0.label.trimmingCharacters(in: .whitespaces).isEmpty }
            .map { (id: $0.optionId, label: $0.label.trimmingCharacters(in: .whitespaces)) }
        Task {
            let e = await actions.savePoll(post, options: opts)
            busy = false
            if let e { error = e } else { actions.pollEditing = nil }
        }
    }
}

// MARK: - The pinned posts, bookmarks, favourites' posts

/// A simple list of posts (ピン留め・ブックマーク・お気に入りの人). Tap opens the thread.
struct PostListDialog: View {
    let kind: PostListKind
    let timeline: TimelineStore
    let capabilities: Capabilities?
    @State private var posts: [Post] = []
    @State private var loaded = false
    @State private var failed = false
    @State private var cursor: String?
    @State private var viewing: ImageViewerItem?

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Label(kind.title, systemImage: kind.systemImage).font(.headline)
                Spacer()
                Button { timeline.actions.list = nil } label: { Image(systemName: "xmark").font(.callout) }
                    .buttonStyle(.borderless)
                    .keyboardShortcut(.cancelAction)
                    .accessibilityLabel("閉じる")
            }
            .padding(14)
            Divider()
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if posts.isEmpty {
                        Text(!loaded ? "読み込み中…" : failed ? "読み込めませんでした" : kind.empty)
                            .font(.callout).foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                            .padding(24)
                            .frame(maxWidth: .infinity)
                    }
                    ForEach(posts) { post in
                        Button {
                            timeline.actions.list = nil
                            timeline.openThread = post.parentId ?? post.id
                        } label: {
                            PostRow(post: post, clubName: post.display?.clubLabel ?? timeline.clubName(post.club),
                                    canReact: capabilities?.canReactPosts ?? false,
                                    onReact: { e in react(post.id, e) },
                                    onOpenImage: { viewing = ImageViewerItem(images: post.images ?? [], index: $0) })
                        }
                        .buttonStyle(.plain)
                        .onAppear { if post.id == posts.last?.id { Task { await more() } } }
                        Divider()
                    }
                }
            }
        }
        .imageViewer($viewing)
        .task { await load() }
        .onChange(of: timeline.actions.lastChange) { _, c in
            guard let c else { return }
            if case let .deleted(id, _) = c.kind { posts.removeAll { $0.id == id }; return }
            for i in posts.indices.reversed() {
                guard let p = c.kind.applied(to: posts[i]) else { continue }
                // Off the list once it no longer belongs (unbookmarked, unpinned, ☆ off).
                let gone = (kind == .bookmarks && p.bookmarkedByMe == false) || (kind == .pinned && !PostActionsModel.isPinned(p))
                    || (kind == .favorites && p.favoriteByMe == false)
                if gone { posts.remove(at: i) } else { posts[i] = p }
            }
        }
    }

    private func load() async {
        do {
            let r = try await timeline.api.postList(kind)
            posts = r.posts
            cursor = r.nextCursor
            failed = false
        } catch { failed = true }
        loaded = true
    }

    private func more() async {
        guard let c = cursor else { return }
        cursor = nil
        if let r = try? await timeline.api.postList(kind, cursor: c) {
            let known = Set(posts.map(\.id))
            posts += r.posts.filter { !known.contains($0.id) }
            cursor = r.nextCursor
        }
    }

    private func react(_ id: Int, _ emoji: String) {
        if let i = posts.firstIndex(where: { $0.id == id }) { posts[i].reactions = ChatStore.toggled(posts[i].reactions ?? [], emoji: emoji) }
        if timeline.posts.contains(where: { $0.id == id }) {
            timeline.toggleReaction(id, emoji: emoji)
        } else {
            Task { _ = try? await timeline.api.togglePostReaction(id: id, emoji: emoji) }
        }
    }
}

// MARK: - Toast

/// 「…（タップで取り消し）」 for 5 s at the bottom (errors in red, no undo).
struct ActionToastView: View {
    let toast: ActionToast
    let onTap: () -> Void
    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 8) {
                Image(systemName: toast.isError ? "exclamationmark.triangle.fill" : "checkmark.circle.fill")
                    .foregroundStyle(toast.isError ? Color.red : Color.accentGreen)
                Text(toast.text).font(.callout).foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(.regularMaterial, in: Capsule())
            .overlay(Capsule().strokeBorder(Color.primary.opacity(0.1)))
            .shadow(color: .black.opacity(0.15), radius: 6, y: 2)
        }
        .buttonStyle(.plain)
        .padding(.horizontal, 16)
        // Above a thread's reply bar.
        .padding(.bottom, 64)
        .accessibilityHint(toast.undo != nil ? "取り消します" : "")
    }
}

/// Everything the timeline's operations open, on the screen that holds the list (and its threads).
struct PostActionPresenter: ViewModifier {
    let timeline: TimelineStore
    let capabilities: Capabilities?
    @Bindable var actions: PostActionsModel

    func body(content: Content) -> some View {
        content
            .panelDialog($actions.editing) { p in EditPostDialog(post: p, actions: actions).id(p.id) }
            .panelDialog($actions.deleting, detents: [.height(250)]) { p in DeletePostDialog(post: p, actions: actions).id(p.id) }
            .panelDialog($actions.pollEditing) { p in PollEditDialog(post: p, actions: actions).id(p.id) }
            .panelDialog($actions.list) { k in
                PostListDialog(kind: k, timeline: timeline, capabilities: capabilities)
                    .environment(\.postActions, actions)
                    .environment(\.postClubs, timeline.clubList)
            }
            .panelDialog($actions.picker, detents: [.height(360)]) { req in
                ReactionPicker { e in
                    actions.picker = nil
                    req.onPick(e)
                }
                .padding(.top, 8)
            }
            .overlay(alignment: .bottom) {
                if let t = actions.toast {
                    ActionToastView(toast: t) { actions.tapToast() }
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                        .id(t.id)
                }
            }
            .animation(.easeOut(duration: 0.2), value: actions.toast)
            .onChange(of: capabilities?.features?.posts, initial: true) { _, f in actions.features = f }
    }
}
