import SwiftUI

/// The timeline on iPhone / iPad / Mac: root posts by latest activity, unread marked
/// like the web (green bar), reactions, tap → thread, ✎ → new post with photos.
struct TimelineScreen: View {
    @Bindable var timeline: TimelineStore
    let capabilities: Capabilities?
    var tabPicker: AnyView? = nil
    let onReconnect: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var path = NavigationPath()
    /// macOS: the open thread (the menu-bar panel has no navigation bar to push into).
    @State private var macThread: Int?
    @State private var composing = false
    @State private var needsReconnect = false
    @State private var viewing: ImageViewerItem?

    var body: some View {
        content
            .sheet(isPresented: $composing) {
                ComposeSheet(api: timeline.api, parentId: nil, maxImages: capabilities?.maxImages ?? 5) { post in
                    timeline.didPublish(post)
                }
            }
            .imageViewer($viewing)
            .task {
                if !timeline.hasLoaded { await timeline.refresh() }
            }
            .onAppear { timeline.startPolling() }
            .onChange(of: timeline.openThread, initial: true) { _, id in
                guard let id else { return }
                open(id)
                timeline.openThread = nil
            }
            .onDisappear { timeline.stopPolling() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await timeline.refresh() } }
            }
    }

    private func open(_ id: Int) {
        #if os(iOS)
        path = NavigationPath([id])
        #else
        macThread = id
        #endif
    }

    private func compose() {
        if capabilities?.canPublish == true { composing = true } else { needsReconnect = true }
    }

    @ViewBuilder private var content: some View {
        #if os(iOS)
        NavigationStack(path: $path) {
            list
                .navigationTitle("タイムライン")
                .inlineNavigationTitle()
                .toolbar {
                    if let tabPicker { ToolbarItem(placement: .principal) { tabPicker } }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(action: compose) { Image(systemName: "square.and.pencil") }
                            .accessibilityLabel("投稿する")
                    }
                }
                .navigationDestination(for: Int.self) { id in
                    ThreadScreen(id: id, timeline: timeline, capabilities: capabilities, onReconnect: onReconnect)
                }
        }
        #else
        // The panel's own header row: [‹ back] switch … [reload] [✎].
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                if macThread != nil {
                    Button { macThread = nil } label: { Image(systemName: "chevron.left") }
                        .buttonStyle(.borderless)
                        .keyboardShortcut("[", modifiers: .command)
                        .help("タイムラインに戻る（⌘[）")
                }
                if let tabPicker { tabPicker }
                Spacer()
                Button { Task { await timeline.refresh() } } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("r", modifiers: .command)
                    .help("再読み込み（⌘R）")
                Button(action: compose) { Image(systemName: "square.and.pencil") }
                    .buttonStyle(.borderless)
                    .keyboardShortcut("n", modifiers: .command)
                    .help("新しい投稿（⌘N）")
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 8)
            Divider()
            if let id = macThread {
                ThreadScreen(id: id, timeline: timeline, capabilities: capabilities, onReconnect: onReconnect)
                    .id(id)
            } else {
                list
            }
        }
        #endif
    }

    private var list: some View {
        VStack(spacing: 0) {
            // Above the list (not inside it) so it is visible wherever you have scrolled to.
            if needsReconnect {
                ReconnectBanner(onReconnect: onReconnect, onClose: { needsReconnect = false })
            }
            posts
        }
    }

    private var posts: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                if timeline.posts.isEmpty {
                    Text(timeline.hasLoaded ? (timeline.failed ? "読み込めませんでした。引っ張って再読み込み" : "まだ投稿がありません") : "読み込み中…")
                        .font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.top, 40)
                }
                ForEach(timeline.posts) { post in
                    Button { open(post.id) } label: {
                        PostRow(post: post, clubName: timeline.clubName(post.club),
                                canReact: capabilities?.canReactPosts ?? false,
                                onReact: { timeline.toggleReaction(post.id, emoji: $0) },
                                onOpenImage: { viewing = ImageViewerItem(images: post.images ?? [], index: $0) })
                    }
                    .buttonStyle(.plain)
                    .onAppear {
                        timeline.sawPost(post.id)
                        if post.id == timeline.posts.last?.id { Task { await timeline.loadMore() } }
                    }
                    Divider()
                }
                if timeline.loadingMore { ProgressView().frame(maxWidth: .infinity).padding() }
            }
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .refreshable { await timeline.refresh() }
        .scrollDismissesKeyboard(.immediately)
        .dismissesKeyboardOnTap()
    }
}

/// Posting needs the "post" permission, which tokens from before the timeline lack.
/// Shown in place (not as an alert: an alert would take the Mac panel's focus and
/// the panel hides itself when it loses focus).
struct ReconnectBanner: View {
    let onReconnect: () -> Void
    var onClose: (() -> Void)? = nil

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "key.fill").foregroundStyle(Color.accentGreen)
            VStack(alignment: .leading, spacing: 6) {
                Text("投稿・返信・リアクションには再接続が必要です").font(.subheadline.bold())
                Text("タイムラインに書き込む許可を追加するため、もう一度 B-guru にログインしてアプリを接続してください。")
                    .font(.caption).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                Button("再接続する", action: onReconnect)
                    .buttonStyle(.borderedProminent)
                    .tint(Color.accentGreen)
                    .controlSize(.small)
            }
            Spacer(minLength: 0)
            if let onClose {
                Button(action: onClose) { Image(systemName: "xmark").font(.caption) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("閉じる")
            }
        }
        .padding(12)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.accentGreen.opacity(0.10)))
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }
}

extension View {
    /// Full screen on iPhone / iPad, a sheet in the Mac panel.
    func imageViewer(_ item: Binding<ImageViewerItem?>) -> some View {
        #if os(iOS)
        fullScreenCover(item: item) { ImageViewer(item: $0) }
        #else
        sheet(item: item) { ImageViewer(item: $0).frame(minWidth: 520, minHeight: 480) }
        #endif
    }
}

struct ImageViewerItem: Identifiable {
    let id = UUID()
    let images: [String]
    let index: Int
}

/// One post (also used for the thread's root and replies).
struct PostRow: View {
    let post: Post
    let clubName: String?
    let canReact: Bool
    let onReact: (String) -> Void
    let onOpenImage: (Int) -> Void
    var showReplyCount = true

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            AvatarView(url: post.authorAvatar, name: post.authorName ?? "", size: 36)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(post.authorName ?? "").font(.subheadline.bold()).lineLimit(1)
                    if let clubName {
                        Text(clubName).font(.caption2.bold())
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(Color.accentGreen.opacity(0.14)))
                            .foregroundStyle(Color.accentGreen)
                    }
                    Spacer(minLength: 4)
                    Text(PostRow.relative(post.createdAt)).font(.caption).foregroundStyle(.tertiary).monospacedDigit()
                }
                if !post.text.isEmpty {
                    Text(MessageRow.attributed(post.text))
                        .font(.body)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let images = post.images, !images.isEmpty {
                    PostImages(images: images, onOpen: onOpenImage)
                }
                if post.videoUrl != nil || post.audioUrl != nil {
                    Label(post.videoUrl != nil ? "動画（Web で再生）" : "音声（Web で再生）", systemImage: post.videoUrl != nil ? "play.rectangle" : "waveform")
                        .font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 12) {
                    if let rs = post.reactions, !rs.isEmpty {
                        ReactionChips(reactions: rs, enabled: canReact, onTap: onReact)
                    }
                    if showReplyCount, let n = post.replyCount, n > 0 {
                        Label("\(n)", systemImage: "bubble.left").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .overlay(alignment: .leading) {
            // Unread: the same green bar as the web timeline.
            if post.unread == true { Rectangle().fill(Color.accentGreen).frame(width: 3) }
        }
        .contentShape(Rectangle())
        .contextMenu {
            if canReact {
                ForEach(MessageRow.quick, id: \.self) { e in Button(e) { onReact(e) } }
                Divider()
            }
            Button("テキストをコピー", systemImage: "doc.on.doc") { Platform.copy(post.text) }
            Button("Web で開く", systemImage: "safari") {
                Platform.open(URL(string: "https://bsm.backspace.fm/#/post/\(post.parentId ?? post.id)")!)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso = ISO8601DateFormatter()
    private static let md: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "M/d"
        return f
    }()

    /// 「たった今」「5分前」「3時間前」、それより前は日付。
    static func relative(_ s: String, now: Date = Date()) -> String {
        guard let d = isoFrac.date(from: s) ?? iso.date(from: s) else { return "" }
        let sec = now.timeIntervalSince(d)
        if sec < 60 { return "たった今" }
        if sec < 3600 { return "\(Int(sec / 60))分前" }
        if sec < 86400 { return "\(Int(sec / 3600))時間前" }
        return md.string(from: d)
    }
}

/// 1 image: wide; 2–5: a grid of squares. Tap → full screen.
struct PostImages: View {
    let images: [String]
    let onOpen: (Int) -> Void

    var body: some View {
        if images.count == 1 {
            Button { onOpen(0) } label: {
                MediaImage(path: images[0])
                    .frame(maxWidth: .infinity)
                    .frame(height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("画像")
        } else {
            let cols = Array(repeating: GridItem(.flexible(), spacing: 4), count: images.count == 2 || images.count == 4 ? 2 : 3)
            LazyVGrid(columns: cols, spacing: 4) {
                ForEach(Array(images.enumerated()), id: \.offset) { i, path in
                    Button { onOpen(i) } label: {
                        Color.clear
                            .aspectRatio(1, contentMode: .fit)
                            .overlay(MediaImage(path: path))
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("画像 \(i + 1)")
                }
            }
        }
    }
}

/// Full screen, swipe between images, pinch to zoom.
struct ImageViewer: View {
    let item: ImageViewerItem
    @Environment(\.dismiss) private var dismiss
    @State private var index = 0

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            #if os(iOS)
            TabView(selection: $index) {
                ForEach(Array(item.images.enumerated()), id: \.offset) { i, path in
                    ZoomableImage(path: path).tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: item.images.count > 1 ? .automatic : .never))
            #else
            if item.images.indices.contains(index) {
                ZoomableImage(path: item.images[index]).id(index)
            }
            if item.images.count > 1 {
                HStack {
                    Button { index = max(0, index - 1) } label: { Image(systemName: "chevron.left.circle.fill").font(.system(size: 28)) }
                        .keyboardShortcut(.leftArrow, modifiers: [])
                        .disabled(index == 0)
                    Spacer()
                    Text("\(index + 1) / \(item.images.count)").foregroundStyle(.white.opacity(0.8)).monospacedDigit()
                    Spacer()
                    Button { index = min(item.images.count - 1, index + 1) } label: { Image(systemName: "chevron.right.circle.fill").font(.system(size: 28)) }
                        .keyboardShortcut(.rightArrow, modifiers: [])
                        .disabled(index == item.images.count - 1)
                }
                .buttonStyle(.plain)
                .foregroundStyle(.white)
                .padding()
                .frame(maxHeight: .infinity, alignment: .bottom)
            }
            #endif
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 30)).symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .white.opacity(0.25))
            }
            .padding()
            .accessibilityLabel("閉じる")
        }
        .onAppear { index = item.index }
    }
}

private struct ZoomableImage: View {
    let path: String
    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        MediaImage(path: path, contentMode: .fit)
            .scaleEffect(scale * pinch)
            .gesture(
                MagnifyGesture()
                    .updating($pinch) { v, s, _ in s = v.magnification }
                    .onEnded { v in scale = min(max(scale * v.magnification, 1), 5) }
            )
            .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2.5 } }
    }
}
