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

    init(id: Int, timeline: TimelineStore, capabilities: Capabilities?, onReconnect: @escaping () -> Void) {
        self.id = id
        self.timeline = timeline
        self.capabilities = capabilities
        self.onReconnect = onReconnect
        _draft = State(initialValue: PostDraft(maxImages: capabilities?.maxImages ?? 5))
    }

    private var canReact: Bool { capabilities?.canReactPosts ?? false }

    var body: some View {
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 0) {
                        if let root {
                            row(root, isRoot: true)
                            Divider()
                            if replies.isEmpty {
                                Text("まだ返信はありません").font(.callout).foregroundStyle(.secondary)
                                    .frame(maxWidth: .infinity).padding(.vertical, 24)
                            }
                            ForEach(replies) { r in
                                row(r, isRoot: false)
                                    .padding(.leading, 20)
                                    .id(r.id)
                                Divider().padding(.leading, 20)
                            }
                        } else {
                            Text(failed ? "読み込めませんでした" : "読み込み中…").font(.callout).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, 40)
                        }
                    }
                    .frame(maxWidth: 760)
                    .frame(maxWidth: .infinity)
                }
                .refreshable { await load() }
                .scrollDismissesKeyboard(.interactively)
                .dismissesKeyboardOnTap()
                .onChange(of: replies.last?.id) { _, last in
                    if let last { withAnimation { proxy.scrollTo(last, anchor: .bottom) } }
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
        .imageViewer($viewing)
    }

    private func row(_ p: Post, isRoot: Bool) -> some View {
        PostRow(post: p, clubName: isRoot ? timeline.clubName(p.club) : nil, canReact: canReact,
                onReact: { react(p.id, $0) },
                onOpenImage: { viewing = ImageViewerItem(images: p.images ?? [], index: $0) },
                showReplyCount: false)
            // New replies stay highlighted until each has been on screen for a second.
            .readWhenSeen(p.unread == true) { read(p, isRoot: isRoot) }
    }

    private var replyBar: some View {
        VStack(alignment: .leading, spacing: 4) {
            DraftImages(draft: draft)
            if let e = draft.error { Text(e).font(.caption).foregroundStyle(.red) }
            HStack(alignment: .bottom, spacing: 8) {
                PhotosPicker(selection: $draft.picks, maxSelectionCount: max(1, draft.maxImages - draft.images.count), matching: .images) {
                    Image(systemName: "photo.on.rectangle").font(.system(size: 20))
                }
                .disabled(draft.images.count >= draft.maxImages || capabilities?.canPublish != true)
                .accessibilityLabel("写真を添付")
                PostTextInput(text: $draft.text, isFocused: $replyFocused, placeholder: "返信", onSubmit: sendReply)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color.primary.opacity(0.06)))
                    .disabled(capabilities?.canPublish != true)
                    .onTapGesture { if capabilities?.canPublish != true { needsReconnect = true } }
                Button(action: sendReply) {
                    Image(systemName: draft.sending ? "hourglass.circle.fill" : "arrow.up.circle.fill").font(.system(size: 30))
                }
                .disabled(!draft.canSend)
                .accessibilityLabel("返信を送信")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    private func sendReply() {
        guard draft.canSend else { return }
        Task {
            if let post = await draft.send(api: timeline.api, parentId: id) {
                replies.append(post)
                timeline.didPublish(post)
                replyFocused = true
            }
        }
    }

    private func load() async {
        #if DEBUG
        if timeline.api.token == "demo", let p = timeline.posts.first(where: { $0.id == id }) {
            root = p
            replies = [Post(id: 100, authorName: "takuto", isAuthor: false, parentId: id, text: "かわいい！", createdAt: p.createdAt, unread: true),
                       Post(id: 101, authorName: "ドリキン", isAuthor: true, parentId: id, text: "名前なんでしたっけ", createdAt: p.createdAt)]
            return
        }
        #endif
        do {
            let t = try await timeline.api.thread(id: id)
            root = t.post
            replies = t.replies
            failed = false
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
