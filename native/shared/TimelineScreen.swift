import SwiftUI

/// The timeline on iPhone / iPad / Mac: root posts by latest activity, unread marked
/// like the web (green bar), reactions, tap → thread, ✎ → new post with photos.
struct TimelineScreen: View {
    @Bindable var timeline: TimelineStore
    let capabilities: Capabilities?
    var tabPicker: MainTabPicker? = nil
    let onReconnect: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    /// False while the iPhone shows the chat page (the timeline page stays alive next to it).
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
            // Polling every minute is started and stopped by the window (MainView on iOS,
            // MainPanelView on the Mac): only while the timeline can be seen.
            .modifier(OpenThreadWhenShown(timeline: timeline, open: open))
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
            TimelinePostList(timeline: timeline, capabilities: capabilities, threadOpen: macThread != nil || !path.isEmpty,
                             open: open, viewing: $viewing)
        }
    }
}

/// The posts. Its own view: a post read, a reaction or a refresh re-runs this list, not the
/// screen around it (the navigation stack and its toolbar on the iPhone).
private struct TimelinePostList: View {
    let timeline: TimelineStore
    let capabilities: Capabilities?
    /// macOS: a thread is open over the list (nothing under it is being read).
    let threadOpen: Bool
    let open: (Int) -> Void
    @Binding var viewing: ImageViewerItem?
    /// The top of the list (the newest posts) is on screen.
    @State private var atTop = true
    /// Posts that arrived above while reading further down.
    @State private var newAbove = 0
    /// While a thread is open over the list: the posts as they were when it opened. The list
    /// under the thread stays built (coming back returns to the same place) but is not changed
    /// while it cannot be seen; what came in meanwhile shows when the thread is closed.
    /// A refresh that reordered the hidden lazy list under an open thread (a post with a new
    /// reply moving to the top) spun the Mac's main thread at 99 % for good — SwiftUI kept
    /// updating the hidden list's items (LazyLayoutViewCache.updateItemPhases) and never
    /// finished (drikin's hangs.log, 0.3.44, 2026-10-22).
    @State private var frozen: [Post]?
    private var posts: [Post] { frozen ?? timeline.posts }

    var body: some View {
        ScrollViewReader { proxy in
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                TimelineTopSentinel(atTop: $atTop)
                if posts.isEmpty {
                    Text(timeline.hasLoaded ? (timeline.failed ? "読み込めませんでした。引っ張って再読み込み" : "まだ投稿がありません") : "読み込み中…")
                        .font(.callout).foregroundStyle(.secondary)
                        .frame(maxWidth: .infinity).padding(.top, 40)
                }
                let canReact = capabilities?.canReactPosts ?? false
                let lastId = posts.last?.id
                ForEach(posts) { post in
                    Button { open(post.id) } label: {
                        PostRow(post: post, clubName: post.display?.clubLabel ?? timeline.clubName(post.club),
                                canReact: canReact,
                                onReact: { timeline.toggleReaction(post.id, emoji: $0) },
                                onOpenImage: { HangWatch.note("open image (post \(post.id))"); viewing = ImageViewerItem(images: post.images ?? [], index: $0) })
                    }
                    .buttonStyle(.plain)
                    .readWhenSeen(post.unread == true && !threadOpen) { timeline.sawPost(post.id) }
                    .onAppear {
                        if post.id == lastId { Task { await timeline.loadMore() } }
                    }
                    Divider()
                }
                if timeline.loadingMore { ProgressView().frame(maxWidth: .infinity).padding() }
            }
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
            // GIFs and videos stand still under an open thread (the Mac keeps the list built).
            .environment(\.mediaActive, !threadOpen)
        }
        .modifier(TopTracker(atTop: $atTop))
        .pullToRefresh { await timeline.refresh() }
        .scrollDismissesKeyboard(.immediately)
        .dismissesKeyboardOnTap()
        // Reading further down: a way back to the newest, like the chat's (drikin 2026-10-19).
        .onChange(of: posts.map(\.id)) { old, new in
            guard !atTop, let first = old.first, let i = new.firstIndex(of: first) else { return }
            newAbove += new[..<i].filter { id in posts.first { $0.id == id }?.isAuthor != true }.count
        }
        .onChange(of: threadOpen, initial: true) { _, open in
            frozen = open ? timeline.posts : nil
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
                        // 「未設定」 (the AI could not tell the club) is grey, as on the web.
                        let tint = post.display?.clubUnset == true ? Color.secondary : Color.accentGreen
                        Text(clubName).font(.caption2.bold())
                            .padding(.horizontal, 6).padding(.vertical, 1)
                            .background(Capsule().fill(tint.opacity(0.14)))
                            .foregroundStyle(tint)
                    }
                    Spacer(minLength: 4)
                    Text(PostRow.relative(post.createdAt)).font(.caption).foregroundStyle(.tertiary).monospacedDigit()
                }
                if !post.text.isEmpty && !post.isBareLink {
                    PostBody(post: post)
                }
                // The web's order: pictures, sound, video, then the link's card — all of them
                // always shown, folded text or not.
                if let images = post.images, !images.isEmpty {
                    PostImages(images: images, columns: TimelineRules.imageColumns(post), onOpen: onOpenImage)
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
                } else if let audio = post.audioUrl {
                    PostAudio(url: audio)
                }
                if let video = post.videoUrl {
                    PostVideo(url: video)
                }
                if let pv = TimelineRules.linkCard(post) {
                    LinkCard(preview: pv, youtube: TimelineRules.isYouTubeCard(post))
                }
                HStack(spacing: 12) {
                    if let rs = post.reactions, !rs.isEmpty {
                        ReactionChips(reactions: TimelineRules.sortedReactions(post), enabled: canReact, onTap: onReact)
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
        guard let p = parsed(s) else { return "" }
        let sec = now.timeIntervalSince(p.date)
        if sec < 60 { return "たった今" }
        if sec < 3600 { return "\(Int(sec / 60))分前" }
        if sec < 86400 { return "\(Int(sec / 3600))時間前" }
        return p.day
    }

    /// Each timestamp is parsed (and its "M/d" made) once: parsing ISO 8601 on every redraw
    /// was about three quarters of a row's time (measured).
    private final class Parsed {
        let date: Date
        let day: String
        init(date: Date, day: String) { self.date = date; self.day = day }
    }
    private static let parsedCache: NSCache<NSString, Parsed> = {
        let c = NSCache<NSString, Parsed>()
        c.countLimit = 2000
        return c
    }()

    private static func parsed(_ s: String) -> Parsed? {
        if let hit = parsedCache.object(forKey: s as NSString) { return hit }
        guard let d = isoFrac.date(from: s) ?? iso.date(from: s) else { return nil }
        let p = Parsed(date: d, day: md.string(from: d))
        parsedCache.setObject(p, forKey: s as NSString)
        return p
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
    @Entry var quoteToChat: PostAction? = nil
    /// 「ネタ帳に送る」: opens the confirmation for the article the post links to
    /// (nil when this member cannot).
    @Entry var sendToNeta: PostAction? = nil
    /// What can be seen right now (set once per window; nil = everything).
    @Entry var screenVisibility: ScreenVisibility? = nil
}

/// Which parts of the window can be seen: the page / tab on screen, with the app active
/// (iPhone) or the panel open (Mac). An object handed down once, read by observation: the
/// tabs and pages are Equatable views, and a plain environment value changed above them
/// never reached the views inside (measured: the chat stayed "visible", read and un-badged,
/// while the iPhone showed the timeline).
@MainActor
@Observable
final class ScreenVisibility {
    private(set) var timeline = true
    private(set) var chat = true
    private(set) var jukebox = true
    /// The club room's map (inside the chat).
    private(set) var room = true

    init() {}

    func set(timeline: Bool, chat: Bool, jukebox: Bool, room: Bool) {
        if self.timeline != timeline { self.timeline = timeline }
        if self.chat != chat { self.chat = chat }
        if self.jukebox != jukebox { self.jukebox = jukebox }
        if self.room != room { self.room = room }
    }
}

/// Something to do with a timeline post, handed down the environment (「チャットに引用」,
/// 「ネタ帳に送る」). Compared by who made it and what it is: a bare closure cannot be
/// compared, so every update of the view that set it counted as a new value and redrew
/// every post row that reads it.
struct PostAction: Equatable {
    let owner: ObjectIdentifier
    let kind: String
    let run: @MainActor (Post) -> Void

    @MainActor func callAsFunction(_ post: Post) { run(post) }
    static func == (a: Self, b: Self) -> Bool { a.owner == b.owner && a.kind == b.kind }
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
    @Environment(\.screenVisibility) private var visibility
    private var onScreen: Bool { visibility?.timeline ?? true }
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
    @Environment(\.screenVisibility) private var visibility
    private var onScreen: Bool { visibility?.timeline ?? true }
    func body(content: Content) -> some View { content.disabled(!onScreen) }
}

private struct ReadWhenSeen: ViewModifier {
    let active: Bool
    let onRead: () -> Void
    /// Read here, not by the list: the list does not redraw every row when the page
    /// (or the Mac's tab) comes and goes.
    @Environment(\.screenVisibility) private var visibility
    private var onScreen: Bool { visibility?.timeline ?? true }
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
    /// The display's card kind is "youtube" (16:9, at most 480 wide).
    var youtube = false
    /// The picture's shape once it is here (not changed under an open thread: see PostImages).
    @State private var aspect: CGFloat?
    @State private var pending: CGFloat?
    @Environment(\.mediaActive) private var mediaActive

    var body: some View {
        Button {
            if let url = URL(string: preview.url) { Platform.open(url) }
        } label: {
            VStack(alignment: .leading, spacing: 0) {
                if let img = preview.proxiedImage {
                    if youtube {
                        // YouTube: the thumbnail at 16:9, up to 480 wide (the web's).
                        FitBox(aspect: 16.0 / 9.0, maxWidth: 480, maxHeight: .infinity) {
                            Color.clear
                                .overlay { MediaImage(path: img, maxPixel: 900) }
                                .clipped()
                                .overlay {
                                    Image(systemName: "play.fill").font(.system(size: 20)).foregroundStyle(.white)
                                        .frame(width: 52, height: 52).background(Circle().fill(.black.opacity(0.75)))
                                }
                        }
                    } else {
                        // Not cropped: the card's width, the picture's own shape, at most 240 tall
                        // (a taller one is fitted inside). The box never sizes the card wider than
                        // the column (a wide image once pushed the card past it, Mac thread view).
                        FitBox(aspect: aspect ?? ImageAspects.aspect(img) ?? 1.91, maxWidth: .infinity, maxHeight: 240) {
                            MediaImage(path: img, contentMode: .fit, maxPixel: 900, onSize: { size in
                                let a = size.width / max(size.height, 1)
                                guard mediaActive else { pending = a; return }
                                ImageAspects.record(img, size)
                                if aspect != a { aspect = a }
                            })
                        }
                        .onChange(of: mediaActive) { _, on in
                            if on, let p = pending { pending = nil; aspect = p; ImageAspects.record(img, CGSize(width: p, height: 1)) }
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


/// A post's text, folded like the web's when it is long: the first 500 characters (JS
/// `length`, TimelineRules) fading out, 「続きを読む」 to open it and 「閉じる」 to fold it
/// again. Opened posts stay open while the app runs (rows are rebuilt as they scroll).
struct PostBody: View {
    let post: Post
    @State private var expanded: Bool

    init(post: Post) {
        self.post = post
        _expanded = State(initialValue: PostExpansion.isOpen(post.id))
    }

    var body: some View {
        if let folded = TimelineRules.foldedText(post) {
            VStack(alignment: .leading, spacing: 4) {
                if expanded {
                    PostText(text: post.text, mentions: TimelineRules.mentionNames(post))
                } else {
                    PostText(text: folded, mentions: TimelineRules.mentionNames(post))
                        // Fades into whatever is behind (the unread tint, dark mode), not white.
                        .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: 0.55),
                                                     .init(color: .black.opacity(0.15), location: 1)],
                                             startPoint: .top, endPoint: .bottom))
                }
                Button {
                    expanded.toggle()
                    PostExpansion.set(post.id, open: expanded)
                } label: {
                    Text(expanded ? "閉じる" : "続きを読む")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(Color.accentGreen)
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .frame(maxWidth: .infinity)
                .accessibilityHint(expanded ? "長い本文を畳みます" : "本文を全部表示します")
            }
        } else {
            PostText(text: post.text, mentions: TimelineRules.mentionNames(post))
        }
    }
}

/// Which long posts were opened (by id), for the life of the app.
@MainActor
enum PostExpansion {
    private static var open = Set<Int>()
    static func isOpen(_ id: Int) -> Bool { open.contains(id) }
    static func set(_ id: Int, open o: Bool) { if o { open.insert(id) } else { open.remove(id) } }
}
