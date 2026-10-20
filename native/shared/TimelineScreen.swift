import SwiftUI

/// The timeline on iPhone / iPad / Mac: root posts by latest activity, unread marked
/// like the web (green bar), reactions, tap → thread, ✎ → new post with photos.
struct TimelineScreen: View {
    @Bindable var timeline: TimelineStore
    let capabilities: Capabilities?
    var tabPicker: AnyView? = nil
    let onReconnect: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    /// False while the iPhone shows the chat page (the timeline page stays alive next to it).
    @State private var path = NavigationPath()
    /// macOS: the open thread (the menu-bar panel has no navigation bar to push into).
    @State private var macThread: Int?
    @State private var composing = false
    @State private var needsReconnect = false
    @State private var viewing: ImageViewerItem?
    /// The top of the list (the newest posts) is on screen.
    @State private var atTop = true
    /// Posts that arrived above while reading further down.
    @State private var newAbove = 0

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
            .modifier(OpenThreadWhenShown(timeline: timeline, open: open))
            .onDisappear { timeline.stopPolling() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await timeline.refresh() } }
            }
    }

    private func open(_ id: Int) {
        HangWatch.note("open thread \(id)")
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
                    Button { HangWatch.note("back to timeline"); macThread = nil } label: { Image(systemName: "chevron.left") }
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
            // The Mac keeps the tabs built: ⌘R / ⌘N / ⌘[ only while the timeline shows.
            .modifier(DisabledOffScreen())
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 8)
            Divider()
            // The list stays alive under an open thread, so coming back returns to where you were.
            ZStack {
                list
                    .opacity(macThread == nil ? 1 : 0)
                    .allowsHitTesting(macThread == nil)
                    .accessibilityHidden(macThread != nil)
                if let id = macThread {
                    ThreadScreen(id: id, timeline: timeline, capabilities: capabilities, onReconnect: onReconnect)
                        .id(id)
                }
            }
        }
        // The mouse's back button (sent by the panel) also leaves the thread (Ryu 2026-10-17).
        .onReceive(NotificationCenter.default.publisher(for: .timelineBack)) { _ in HangWatch.note("back to timeline (mouse)"); macThread = nil }
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
        ScrollViewReader { proxy in
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                TimelineTopSentinel(atTop: $atTop)
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
                                onOpenImage: { HangWatch.note("open image (post \(post.id))"); viewing = ImageViewerItem(images: post.images ?? [], index: $0) })
                    }
                    .buttonStyle(.plain)
                    .readWhenSeen(post.unread == true && macThread == nil) { timeline.sawPost(post.id) }
                    .onAppear {
                        if post.id == timeline.posts.last?.id { Task { await timeline.loadMore() } }
                    }
                    Divider()
                }
                if timeline.loadingMore { ProgressView().frame(maxWidth: .infinity).padding() }
            }
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .modifier(TopTracker(atTop: $atTop))
        .pullToRefresh { await timeline.refresh() }
        .scrollDismissesKeyboard(.immediately)
        .dismissesKeyboardOnTap()
        // Reading further down: a way back to the newest, like the chat's (drikin 2026-10-19).
        .onChange(of: timeline.posts.map(\.id)) { old, new in
            guard !atTop, let first = old.first, let i = new.firstIndex(of: first) else { return }
            newAbove += new[..<i].filter { id in timeline.posts.first { $0.id == id }?.isAuthor != true }.count
        }
        .onChange(of: atTop) { _, top in if top { newAbove = 0 } }
        .overlay(alignment: .bottomTrailing) {
            // The fade is the button's own: an animation on the whole scroll view also
            // animated the lazy list's layout each time this flipped.
            ZStack {
                if !atTop {
                    JumpButton(arrow: "↑", count: newAbove) {
                        withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("top", anchor: .top) }
                    }
                }
            }
            .animation(.easeOut(duration: 0.15), value: atTop)
        }
        }
    }
}

/// The first row of the list (the scroll target "top"). On systems without scroll
/// geometry it also tells whether the top is on screen.
private struct TimelineTopSentinel: View {
    @Binding var atTop: Bool
    var body: some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            Color.clear.frame(height: 1).id("top")
        } else {
            Color.clear.frame(height: 1).id("top")
                .onAppear { atTop = true }
                .onDisappear { atTop = false }
        }
    }
}

/// Whether the newest posts are on screen, from where the list is scrolled to (macOS 15 /
/// iOS 18+, like the chat's BottomTracker): only scrolling moves it. The first row's
/// appear / disappear can also fire while the lazy list rebuilds its rows.
private struct TopTracker: ViewModifier {
    @Binding var atTop: Bool

    func body(content: Content) -> some View {
        if #available(macOS 15.0, iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { g in
                g.contentOffset.y + g.contentInsets.top < 60
            } action: { _, top in
                if top != atTop { atTop = top }
            }
        } else {
            content
        }
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
    /// Full screen on iPhone / iPad; on the Mac, laid over the panel itself. It was a sheet,
    /// a separate window bigger than the narrow panel (520 × 480), and with the panel
    /// floating above other windows it could end up behind it, drawn wrongly — the chat's
    /// text showed upside down (reported 2026-10-19).
    @ViewBuilder func imageViewer(_ item: Binding<ImageViewerItem?>) -> some View {
        #if os(iOS)
        fullScreenCover(item: item) { ImageViewer(item: $0) }
        #else
        overlay {
            if let it = item.wrappedValue {
                ImageViewer(item: it, onClose: { item.wrappedValue = nil })
                    .transition(.opacity)
                    .onAppear { ImageViewerOverlay.open += 1 }
                    .onDisappear { ImageViewerOverlay.open -= 1 }
                    .onReceive(NotificationCenter.default.publisher(for: .closeImageViewer)) { _ in item.wrappedValue = nil }
            }
        }
        .animation(.easeOut(duration: 0.15), value: item.wrappedValue?.id)
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
    @Environment(\.jukebox) private var jukebox
    @Environment(\.quoteToChat) private var quoteToChat
    @Environment(\.sendToNeta) private var sendToNeta

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
                if !post.text.isEmpty && !post.isBareLink {
                    PostText(text: post.text)
                }
                if let pv = post.urlPreview, (post.images ?? []).isEmpty {
                    LinkCard(preview: pv)
                }
                if let images = post.images, !images.isEmpty {
                    PostImages(images: images, onOpen: onOpenImage)
                }
                if let audio = post.audioUrl, post.videoUrl == nil, let jb = jukebox, let ep = jb.episode(forAudioURL: audio) {
                    // The daily "N 年前の今日" post: play it in the jukebox.
                    Button { jb.play(ep) } label: {
                        Label(jb.current?.id == ep.id && jb.isPlaying ? "ジュークボックスで再生中" : "ジュークボックスで聴く",
                              systemImage: jb.current?.id == ep.id && jb.isPlaying ? "waveform" : "play.circle.fill")
                            .font(.subheadline.weight(.semibold))
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .foregroundStyle(.white)
                            .background(Capsule().fill(Color.accentGreen))
                    }
                    .buttonStyle(.plain)
                } else if post.videoUrl != nil || post.audioUrl != nil {
                    Label(post.videoUrl != nil ? "動画（Web で再生）" : "音声（Web で再生）", systemImage: post.videoUrl != nil ? "play.rectangle" : "waveform")
                        .font(.caption).foregroundStyle(.secondary)
                }
                HStack(spacing: 12) {
                    if let rs = post.reactions, !rs.isEmpty {
                        ReactionChips(reactions: rs, enabled: canReact, onTap: onReact)
                    }
                    if showReplyCount, let n = post.replyCount, n > 0 {
                        Label("\(n)", systemImage: "bubble.left").font(.caption).foregroundStyle(.secondary)
                        if let new = post.unreadReplies, new > 0 {
                            Text("新着 \(new)")
                                .font(.caption2.bold())
                                .padding(.horizontal, 6).padding(.vertical, 1)
                                .background(Capsule().fill(Color.accentGreen))
                                .foregroundStyle(.white)
                                .accessibilityLabel("新しい返信 \(new) 件")
                        }
                    }
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        // Unread: a light green card with the web's green bar. Read after a second on
        // screen, and the colour fades out — so you can see what you just read.
        .background(Color.accentGreen.opacity(post.unread == true ? 0.08 : 0))
        .overlay(alignment: .leading) {
            Rectangle().fill(Color.accentGreen).frame(width: 3).opacity(post.unread == true ? 1 : 0)
        }
        .animation(.easeOut(duration: 0.6), value: post.unread)
        .contentShape(Rectangle())
        .contextMenu {
            if canReact {
                ForEach(MessageRow.quick, id: \.self) { e in Button(e) { onReact(e) } }
                Divider()
            }
            if let quoteToChat {
                Button("チャットに引用", systemImage: "quote.bubble") { quoteToChat(post) }
            }
            // The article the post links to (not the post itself) — docs/neta-client-spec.md.
            if let sendToNeta, !NetaLinks.candidates(text: post.text, previewURL: post.urlPreview?.url).isEmpty {
                Button("ネタ帳に送る", systemImage: "note.text.badge.plus") { sendToNeta(post) }
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
                            .overlay(MediaImage(path: path, maxPixel: 600))
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
    /// Set when laid over a view (the Mac); otherwise it was presented and dismisses.
    var onClose: (() -> Void)? = nil
    @Environment(\.dismiss) private var environmentDismiss

    private func dismiss() {
        if let onClose { onClose() } else { environmentDismiss() }
    }
    @State private var index = 0

    var body: some View {
        ZStack(alignment: .topTrailing) {
            #if os(iOS)
            Color.black.ignoresSafeArea()
            #else
            // A click outside the picture closes it, as does Esc (Ryu 2026-10-18).
            Color.black.ignoresSafeArea()
                .contentShape(Rectangle())
                .onTapGesture { dismiss() }
            #endif
            #if os(iOS)
            TabView(selection: $index) {
                ForEach(Array(item.images.enumerated()), id: \.offset) { i, path in
                    ZoomableImage(path: path).tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: item.images.count > 1 ? .automatic : .never))
            #else
            if item.images.indices.contains(index) {
                // Centred; the empty space around it lets clicks through to the background.
                ZoomableImage(path: item.images[index]).id(index)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
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
            #if os(macOS)
            // Easy to find: a labelled button (the bare ✕ was easy to miss, Ryu 2026-10-18).
            Button { dismiss() } label: {
                HStack(spacing: 6) {
                    Image(systemName: "xmark").font(.system(size: 12, weight: .bold))
                    Text("閉じる").font(.system(size: 13, weight: .semibold))
                    Text("esc").font(.system(size: 10, weight: .medium)).foregroundStyle(.black.opacity(0.45))
                }
                .foregroundStyle(.black)
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(Capsule().fill(.white.opacity(0.92)))
                .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.cancelAction)
            .padding(12)
            .accessibilityLabel("閉じる")
            #else
            Button { dismiss() } label: {
                Image(systemName: "xmark.circle.fill").font(.system(size: 30)).symbolRenderingMode(.palette)
                    .foregroundStyle(.white, .white.opacity(0.25))
            }
            .padding()
            .accessibilityLabel("閉じる")
            #endif
        }
        .onAppear { index = item.index }
    }
}

private struct ZoomableImage: View {
    let path: String
    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1

    var body: some View {
        MediaImage(path: path, contentMode: .fit, maxPixel: 2560)
            .scaleEffect(scale * pinch)
            .gesture(
                MagnifyGesture()
                    .updating($pinch) { v, s, _ in s = v.magnification }
                    .onEnded { v in scale = min(max(scale * v.magnification, 1), 5) }
            )
            .onTapGesture(count: 2) { withAnimation { scale = scale > 1 ? 1 : 2.5 } }
    }
}

#if os(macOS)
extension Notification.Name {
    /// The mouse's back button was pressed over the timeline (posted by the Mac panel).
    static let timelineBack = Notification.Name("fm.backspace.bguru.timelineBack")
    /// Esc while a picture is open over the panel: close the picture, not the panel.
    static let closeImageViewer = Notification.Name("fm.backspace.bguru.closeImageViewer")
}

/// How many pictures are open over the panel (Esc closes them first).
@MainActor
enum ImageViewerOverlay {
    static var open = 0
    /// Closes an open picture; false when none was open.
    static func closeIfOpen() -> Bool {
        guard open > 0 else { return false }
        NotificationCenter.default.post(name: .closeImageViewer, object: nil)
        return true
    }
}
#endif


// MARK: read after a moment on screen (same rule as the web: 1 s, ≥ 25 % visible)

extension EnvironmentValues {
    /// 「チャットに引用」: puts the post into the chat's composer and shows the chat
    /// (nil when this member cannot send to the chat).
    @Entry var quoteToChat: (@MainActor (Post) -> Void)? = nil
    /// 「ネタ帳に送る」: opens the confirmation for the article the post links to
    /// (nil when this member cannot).
    @Entry var sendToNeta: (@MainActor (Post) -> Void)? = nil
    /// The timeline is the page on screen (iPhone pages keep the other one alive).
    @Entry var timelineOnScreen = true
}

extension View {
    /// Calls `onRead` once this view has stayed on screen for a second while `active`.
    /// Scrolling past quickly does not read it.
    func readWhenSeen(_ active: Bool, onRead: @escaping () -> Void) -> some View {
        modifier(ReadWhenSeen(active: active, onRead: onRead))
    }
}

/// Opens the thread asked for (a notification, a post's link in the chat). On the iPhone
/// the timeline is a page of a paged TabView: switching to it and pushing the thread in
/// the same moment made UIKit throw during layout and the app crashed (TestFlight reports
/// 2026-10-20, 「チャットからタイムラインへのリンクで落ちた」). So: wait until the page
/// shows, let the page settle, then push. The Mac's panel has no pages and opens at once.
private struct OpenThreadWhenShown: ViewModifier {
    let timeline: TimelineStore
    let open: (Int) -> Void
    @Environment(\.timelineOnScreen) private var onScreen
    @State private var waiting: Int?

    func body(content: Content) -> some View {
        content
            .onChange(of: timeline.openThread, initial: true) { _, id in
                guard let id else { return }
                timeline.openThread = nil
                #if os(iOS)
                waiting = id
                if onScreen { pushSoon() }
                #else
                open(id)
                #endif
            }
            .onChange(of: onScreen) { _, shown in
                if shown, waiting != nil { pushSoon() }
            }
    }

    private func pushSoon() {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.45) {
            guard let id = waiting, onScreen else { return }
            waiting = nil
            open(id)
        }
    }
}

/// Disabled while the timeline is not the page showing (reads the environment itself).
private struct DisabledOffScreen: ViewModifier {
    @Environment(\.timelineOnScreen) private var onScreen
    func body(content: Content) -> some View { content.disabled(!onScreen) }
}

private struct ReadWhenSeen: ViewModifier {
    let active: Bool
    let onRead: () -> Void
    /// Read here, not by the list: the list does not redraw every row when the page
    /// (or the Mac's tab) comes and goes.
    @Environment(\.timelineOnScreen) private var onScreen
    @State private var visible = false
    @State private var timer: Task<Void, Never>?

    func body(content: Content) -> some View {
        Group {
            if #available(iOS 18.0, macOS 15.0, *) {
                content.onScrollVisibilityChange(threshold: 0.25) { visible = $0 }
            } else {
                // Lazy stacks create rows just as they come on screen.
                content.onAppear { visible = true }
            }
        }
        .onDisappear { visible = false }
        .onChange(of: visible && active && onScreen, initial: true) { _, seen in
            timer?.cancel()
            timer = nil
            guard seen else { return }
            timer = Task { @MainActor in
                try? await Task.sleep(for: .seconds(1))
                guard !Task.isCancelled else { return }
                onRead()
            }
        }
    }
}


/// A link's page as a card: image, title, a line of description, the site. Opens the
/// page in the browser. (The web shows the same card under a post.)
struct LinkCard: View {
    let preview: UrlPreview

    var body: some View {
        Button {
            if let url = URL(string: preview.url) { Platform.open(url) }
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                if let img = preview.proxiedImage {
                    // The picture fills a fixed box and never sizes the card: a wide image
                    // used to push the card past the column (seen in the Mac thread view).
                    Color.clear
                        .frame(maxWidth: .infinity)
                        .frame(height: 170)
                        .overlay { MediaImage(path: img, maxPixel: 900) }
                        .clipped()
                        .overlay {
                            if preview.videoId != nil {
                                Image(systemName: "play.fill").font(.system(size: 20)).foregroundStyle(.white)
                                    .frame(width: 48, height: 48).background(Circle().fill(.black.opacity(0.7)))
                            }
                        }
                }
                VStack(alignment: .leading, spacing: 3) {
                    if let t = preview.title, !t.isEmpty {
                        Text(t).font(.subheadline.bold()).foregroundStyle(.primary).lineLimit(2).multilineTextAlignment(.leading)
                    }
                    if let d = preview.description, !d.isEmpty {
                        Text(d).font(.caption).foregroundStyle(.secondary).lineLimit(2).multilineTextAlignment(.leading)
                    }
                    Text(preview.siteName ?? URL(string: preview.url)?.host ?? preview.url)
                        .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Color.primary.opacity(0.04))
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.1)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("リンク：\(preview.title ?? preview.url)")
        .accessibilityHint("ブラウザで開きます")
    }
}
