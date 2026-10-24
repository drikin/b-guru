import SwiftUI
import PhotosUI

/// One thread: the post and its replies, with a reply bar (text + photos) at the bottom.
struct ThreadScreen: View {
    let id: Int
    let timeline: TimelineStore
    let capabilities: Capabilities?
    let onReconnect: () -> Void

    @State private var root: Post?
    @State private var replies: [Post] = []
    @State private var failed = false
    @State private var draft: PostDraft
    @State private var needsReconnect = false
    @State private var viewing: ImageViewerItem?
    @State private var replyFocused = false
    /// The whole thread fits on screen (iOS 18 / macOS 15: from the scroll view's geometry).
    @State private var fits = false

    init(id: Int, timeline: TimelineStore, capabilities: Capabilities?, onReconnect: @escaping () -> Void) {
        self.id = id
        self.timeline = timeline
        self.capabilities = capabilities
        self.onReconnect = onReconnect
        _draft = State(initialValue: PostDraft(maxImages: capabilities?.maxImages ?? 5))
    }

    private var canReact: Bool { capabilities?.canReactPosts ?? false }
    private var actions: PostActionsModel { timeline.actions }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let root {
                            row(root, isRoot: true)
                                .id("root")
                            Divider()
                            if replies.isEmpty {
                                Text("まだ返信はありません").font(.app(.callout)).foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity).padding(.vertical, 24)
                            }
                            ForEach(replies) { r in
                                row(r, isRoot: false)
                                    .padding(.leading, 20)
                                    .id(r.id)
                                Divider().padding(.leading, 20)
                            }
                        } else {
                            Text(failed ? "読み込めませんでした" : "読み込み中…").font(.app(.callout)).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, 40)
                        }
                    }
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                    .keyScrollTarget()
                }
                .pullToRefresh { await load() }
                .modifier(FitsTracker(fits: $fits))
                .scrollDismissesKeyboard(.interactively)
                .dismissesKeyboardOnTap()
                .onChange(of: replies.last?.id) { old, last in
                    guard let last else { return }
                    // A reply just added under the one before (sent from here): glide to it.
                    // Anything further — opening the thread, a reload that brought many —
                    // jumps. Animating to the end of a long thread scrolled through every
                    // reply in the lazy list, building and measuring each one, while the
                    // list's guessed height swung by tens of thousands of points (300 replies:
                    // 3 s of scrolling, 33 000 ↔ 72 000 pt, sometimes stopping half way) —
                    // the Mac froze opening threads with many replies (drikin 2026-10-21).
                    let near = old.flatMap { o in replies.firstIndex { $0.id == o } }.map { replies.count - 1 - $0 <= 3 } ?? false
                    // A thread shorter than the screen stays at the top: scrolling its last reply to
                    // the bottom pushed the whole thread down under the title (a big gap on iPhone).
                    // On opening, the geometry is only known a moment later (the retries below).
                    if near {
                        if !fits { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
                    } else {
                        proxy.scrollTo(last, anchor: .bottom)
                        // Again once the rows at the end have been measured and their pictures
                        // have come (the first jump goes by estimated heights).
                        Task { @MainActor in
                            for ms in [0, 60, 250] {
                                try? await Task.sleep(for: .milliseconds(ms))
                                guard replies.last?.id == last else { return }
                                if fits { proxy.scrollTo("root", anchor: .top); return }
                                proxy.scrollTo(last, anchor: .bottom)
                            }
                        }
                    }
                }
            }
            Divider()
            if capabilities?.canPublish == true {
                replyBar
            } else {
                // No permission yet: say so right where the reply would go.
                ReconnectBanner(onReconnect: onReconnect)
            }
        }
        .navigationTitle(root?.authorName.map { "\($0) さんの投稿" } ?? "スレッド")
        .inlineNavigationTitle()
        .task { await load() }
        // Edits, deletes, ☆, polls… made anywhere (the menu here, the list, the pinned list).
        .onChange(of: actions.lastChange) { _, c in if let c { apply(c.kind) } }
        .imageViewer($viewing)
        #if DEBUG
        // The self-checks act in the open thread as a member would (Notification.debugThreadAction).
        .onReceive(NotificationCenter.default.publisher(for: .debugThreadAction)) { note in
            let all = [root].compactMap { $0 } + replies
            switch note.object as? String {
            case "image":
                if let p = all.first(where: { !($0.images ?? []).isEmpty }) { viewing = ImageViewerItem(images: p.images ?? [], index: 0) }
            case "closeImage": viewing = nil
            case "react": // on screen only (react() would send it)
                if let i = replies.indices.last { replies[i].reactions = ChatStore.toggled(replies[i].reactions ?? [], emoji: "👍") }
                if var r = root { r.reactions = ChatStore.toggled(r.reactions ?? [], emoji: "👍"); root = r }
            case "focus": replyFocused = true
            case "type": draft.text = "テスト"
            case "mention": actions.loadMembers(); draft.text = "@ta"
            case "clear": draft.text = ""; replyFocused = false
            default: break
            }
        }
        #endif
    }

    private func row(_ p: Post, isRoot: Bool) -> some View {
        PostRow(post: p, clubName: isRoot ? (p.display?.clubLabel ?? timeline.clubName(p.club)) : nil, canReact: canReact,
                onReact: { react(p.id, $0) },
                onOpenImage: { viewing = ImageViewerItem(images: p.images ?? [], index: $0) },
                showReplyCount: false)
            // New replies stay highlighted until each has been on screen for a second.
            .readWhenSeen(p.unread == true) { read(p, isRoot: isRoot) }
    }

    private var replyBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            let matches = actions.mentionMatches(draft.text)
            if !matches.isEmpty {
                MentionSuggestions(members: matches) { m in draft.text = Mention.complete(draft.text, with: m.name); replyFocused = true }
            }
            DraftImages(draft: draft)
            if let e = draft.error { Text(e).font(.app(.caption)).foregroundStyle(.red) }
            // Two rows: the field the whole width, the buttons under it. In one row with 📷, 🖼,
            // うなる and 吠える the field was a few characters wide on the iPhone (drikin
            // 2026-10-24 「テキスト入力の部分が狭すぎて文字が入力しづらい」, the Mac panel too).
            PostTextInput(text: $draft.text, isFocused: $replyFocused, placeholder: "返信", onSubmit: { sendReply() })
                .padding(.vertical, 8)
                .padding(.horizontal, 12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(RoundedRectangle(cornerRadius: 18).fill(Color.primary.opacity(0.06)))
                .disabled(capabilities?.canPublish != true)
                .onTapGesture { if capabilities?.canPublish != true { needsReconnect = true } }
            HStack(alignment: .center, spacing: 14) {
                PhotosPicker(selection: $draft.picks, maxSelectionCount: max(1, draft.maxImages - draft.images.count), matching: .images) {
                    Image(systemName: "photo.on.rectangle").font(.app(size: 20))
                }
                .disabled(draft.images.count >= draft.maxImages || capabilities?.canPublish != true)
                .accessibilityLabel("写真を添付")
                #if os(iOS)
                if capabilities?.canPublish == true {
                    CameraButton(draft: draft) { Image(systemName: "camera").font(.app(size: 20)) }
                }
                #endif
                Spacer(minLength: 0)
                if actions.canWhisper {
                    // The web's two buttons: うなる (light blue, does not lift the thread or notify), 吠える (blue).
                    Button { sendReply(whisper: true) } label: {
                        Text("うなる").font(.app(.subheadline, weight: .bold))
                            .padding(.horizontal, 14).padding(.vertical, 7)
                            .background(Capsule().fill(Color.blue.opacity(0.14)))
                            .foregroundStyle(Color.blue)
                    }
                    .buttonStyle(.plain)
                    .disabled(!draft.canSend)
                    .opacity(draft.canSend ? 1 : 0.45)
                    .help("スレッドを上げず、通知も出さずに返信する")
                    .accessibilityHint("スレッドを上げず、通知も出さずに返信します")
                    Button { sendReply() } label: {
                        Text(draft.sending ? "…" : "吠える").font(.app(.subheadline, weight: .bold))
                            .padding(.horizontal, 14).padding(.vertical, 7)
                            .background(Capsule().fill(Color.blue))
                            .foregroundStyle(.white)
                    }
                    .buttonStyle(.plain)
                    .disabled(!draft.canSend)
                    .opacity(draft.canSend ? 1 : 0.45)
                    .help("返信する（Return）")
                } else {
                    Button { sendReply() } label: {
                        Image(systemName: draft.sending ? "hourglass.circle.fill" : "arrow.up.circle.fill").font(.app(size: 30))
                    }
                    .disabled(!draft.canSend)
                    .accessibilityLabel("返信を送信")
                }
            }
        }
        .onChange(of: replyFocused) { _, f in if f { actions.loadMembers() } }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    private func sendReply(whisper: Bool = false) {
        guard draft.canSend else { return }
        Task {
            if let post = await draft.send(api: timeline.api, parentId: id, whisper: whisper) {
                replies.append(post)
                timeline.didPublish(post, whisper: whisper)
                replyFocused = true
            }
        }
    }

    /// A change made to a post on this screen or elsewhere.
    private func apply(_ kind: PostChange.Kind) {
        if case let .deleted(pid, _) = kind {
            replies.removeAll { $0.id == pid }
            if root?.id == pid, var r = root { r.replyCount = replies.count; root = r }
            return
        }
        if let r = root, let q = kind.applied(to: r) { root = q }
        for i in replies.indices {
            if let q = kind.applied(to: replies[i]) { replies[i] = q }
        }
    }

    private func load() async {
        #if DEBUG
        if timeline.api.token == "demo", let p = timeline.posts.first(where: { $0.id == id }) {
            if id == TimelineStore.demoLongThreadId {
                // As from the server: the post and all its replies arrive together, a moment later.
                try? await Task.sleep(for: .milliseconds(300))
                root = p
                replies = TimelineStore.debugDemoReplies(root: id, count: TimelineStore.demoLongThreadReplies)
                return
            }
            root = p
            timeline.onThreadOpened?(p)
            replies = [Post(id: 9100, authorId: "t", authorName: "takuto", isAuthor: false, parentId: id, text: "かわいい！", createdAt: p.createdAt, unread: true),
                       Post(id: 9101, authorId: "me", authorName: "ドリキン", isAuthor: true, parentId: id, text: "名前なんでしたっけ", createdAt: p.createdAt)]
            return
        }
        #endif
        do {
            let t = try await timeline.api.thread(id: id)
            HangWatch.note("thread \(id) loaded: \(t.replies.count) replies")
            root = t.post
            replies = t.replies
            failed = false
            timeline.onThreadOpened?(t.post)
        } catch {
            failed = root == nil
        }
    }

    private func read(_ p: Post, isRoot: Bool) {
        if isRoot {
            if var r = root { r.unread = false; root = r }
            if timeline.posts.contains(where: { $0.id == p.id }) { timeline.sawPost(p.id) } else { timeline.markRead([p.id]) }
        } else if let i = replies.firstIndex(where: { $0.id == p.id }) {
            replies[i].unread = false
            timeline.sawReply(p.id, root: id)
        }
    }

    private func react(_ postId: Int, _ emoji: String) {
        timeline.toggleReaction(postId, emoji: emoji) // keeps the timeline row in sync
        let apply: (inout Post) -> Void = { $0.reactions = ChatStore.toggled($0.reactions ?? [], emoji: emoji) }
        if root?.id == postId, var r = root { apply(&r); root = r }
        if let i = replies.firstIndex(where: { $0.id == postId }) { apply(&replies[i]) }
        // Replies are not in the timeline list, so the store does not send for them.
        if !timeline.posts.contains(where: { $0.id == postId }) {
            Task { _ = try? await timeline.api.togglePostReaction(id: postId, emoji: emoji) }
        }
    }
}

/// Whether the content is no taller than the scroll view (iOS 18 / macOS 15; older: never).
private struct FitsTracker: ViewModifier {
    @Binding var fits: Bool
    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { g in
                g.contentSize.height <= g.containerSize.height - g.contentInsets.top - g.contentInsets.bottom + 1
            } action: { _, f in
                if fits != f { fits = f }
            }
        } else {
            content
        }
    }
}

#if DEBUG
extension Notification.Name {
    /// Dev only: something to do in the open thread (object: "image", "closeImage", "react", "focus", "type", "clear").
    static let debugThreadAction = Notification.Name("fm.backspace.bguru.debugThreadAction")
}
#endif
