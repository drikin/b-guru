import Foundation
import Observation

/// Chat or timeline (iPhone pages, the Mac panel switch).
enum MainTab: Hashable { case timeline, chat }

/// The timeline (root posts, newest activity first) for the native apps.
/// Read-mostly: list + reactions + unread, open a thread, reply / post with images.
/// Not streamed: refreshed on appear, on pull, when the app comes back and every
/// minute while on screen (posts arrive far less often than chat messages).
@MainActor
@Observable
final class TimelineStore {
    private(set) var posts: [Post] = []
    private(set) var hasLoaded = false
    private(set) var loadingMore = false
    private(set) var failed = false
    private(set) var clubs: [String: String] = [:]
    /// Set by a "reply to your post" notification tap: the app shows the timeline
    /// and opens this thread.
    var openThread: Int?
    private var nextCursor: String?

    let api: APIClient
    private var pendingRead = Set<Int>()
    private var readTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    init(api: APIClient) { self.api = api }

    var unreadCount: Int { posts.filter { $0.unread == true }.count }

    func refresh() async {
        #if DEBUG
        if api.token == "demo" { return }
        #endif
        if clubs.isEmpty, let c = try? await api.clubs() {
            clubs = Dictionary(c.map { ($0.key, $0.name) }, uniquingKeysWith: { a, _ in a })
        }
        do {
            let r = try await api.posts()
            // Keep "read on this device" marks the server has not echoed yet.
            posts = r.posts.map { p in
                var p = p
                if pendingRead.contains(p.id) { p.unread = false }
                return p
            }
            nextCursor = r.nextCursor
            failed = false
        } catch {
            failed = posts.isEmpty
        }
        hasLoaded = true
    }

    func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        if let r = try? await api.posts(cursor: cursor) {
            let known = Set(posts.map(\.id))
            posts += r.posts.filter { !known.contains($0.id) }
            nextCursor = r.nextCursor
        }
    }

    /// While the timeline is on screen: refresh every minute.
    func startPolling() {
        pollTask?.cancel()
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(60))
                guard !Task.isCancelled else { return }
                await self?.refresh()
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    /// A post was on screen for a moment: read (same rule as the web — per post,
    /// debounced, batched).
    func sawPost(_ id: Int) {
        guard let i = posts.firstIndex(where: { $0.id == id }), posts[i].unread == true else { return }
        posts[i].unread = false
        markRead([id])
    }

    /// A reply in an open thread was read: one fewer "新着" on its root in the list.
    func sawReply(_ id: Int, root: Int) {
        markRead([id])
        if let i = posts.firstIndex(where: { $0.id == root }), let n = posts[i].unreadReplies, n > 0 {
            posts[i].unreadReplies = n - 1
        }
    }

    func markRead(_ ids: [Int]) {
        pendingRead.formUnion(ids)
        readTask?.cancel()
        readTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(800))
            guard let self, !Task.isCancelled else { return }
            let batch = Array(self.pendingRead)
            await self.api.markPostsRead(batch)
            self.pendingRead.subtract(batch)
        }
    }

    func toggleReaction(_ postId: Int, emoji: String) {
        guard let i = posts.firstIndex(where: { $0.id == postId }) else { return }
        let old = posts[i].reactions ?? []
        posts[i].reactions = ChatStore.toggled(old, emoji: emoji)
        Task {
            do {
                let r = try await api.togglePostReaction(id: postId, emoji: emoji)
                if let j = posts.firstIndex(where: { $0.id == postId }) {
                    posts[j].reactions = Self.merge(r, previous: posts[j].reactions ?? [], toggled: emoji)
                }
            } catch {
                if let j = posts.firstIndex(where: { $0.id == postId }) { posts[j].reactions = old }
            }
        }
    }

    /// The server's counts, with `mine` carried over (and set for the emoji just toggled).
    static func merge(_ r: PostReactionToggleResponse, previous: [Reaction], toggled: String) -> [Reaction] {
        r.reactions.map { x in
            let mine = x.emoji == toggled ? r.added : (previous.first { $0.emoji == x.emoji }?.mine ?? false)
            let reactors = previous.first { $0.emoji == x.emoji }?.reactors ?? []
            return Reaction(emoji: x.emoji, count: x.count, mine: mine, reactors: reactors)
        }
    }

    /// After posting or replying: show it at once (the next refresh confirms it).
    func didPublish(_ post: Post) {
        if post.parentId == nil {
            posts.removeAll { $0.id == post.id }
            posts.insert(post, at: 0)
        } else if let i = posts.firstIndex(where: { $0.id == post.parentId }) {
            var root = posts.remove(at: i)
            root.replyCount = (root.replyCount ?? 0) + 1
            root.lastActivityAt = post.createdAt
            posts.insert(root, at: 0)
        }
    }

    #if DEBUG
    /// Sample timeline for offline UI checks (no network).
    func debugLoadDemo() {
        let now = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-300))
        let old = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-7200))
        posts = [
            Post(id: 4, authorId: "n", authorName: "NORIO TAKAHASHI", isAuthor: false, replyCount: 0,
                 text: "https://share.google/BM8clX7MsYzuIrrCf", createdAt: now, club: "car",
                 urlPreview: UrlPreview(url: "https://www.webcg.net/articles/-/50000", title: "ポルシェが未来のミドシップスーパースポーツカー「ミッションS」を発表 【ニュース】 - webCG",
                                        description: "ポルシェは未来のミドシップスーパースポーツカーのコンセプトを発表した。", image: "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png", siteName: "webCG")),
            Post(id: 3, authorId: "a", authorName: "mazzo", isAuthor: false, replyCount: 4,
                 text: "うちの犬が今朝こんな顔してました 🐶 https://bsm.backspace.fm", images: ["/api/media/demo-1.jpg"],
                 createdAt: now, club: "pet", reactions: [Reaction(emoji: "❤️", count: 3, mine: true, reactors: [])], unread: true, unreadReplies: 2),
            Post(id: 2, authorId: "b", authorName: "NORIO TAKAHASHI", isAuthor: false, replyCount: 0,
                 text: "@ドリキン Android 版入れました。通知もちゃんと来ます", images: ["/api/media/a.jpg", "/api/media/b.jpg", "/api/media/c.jpg"],
                 createdAt: old, club: "apple", unread: false),
            Post(id: 1, authorId: "me", authorName: "ドリキン", isAuthor: true, replyCount: 12,
                 text: "ビーグルのアプリにタイムラインを追加しています", createdAt: old, club: "improve", unread: false),
        ]
        clubs = ["pet": "ペット部", "apple": "リンゴ部", "improve": "機能改善"]
        hasLoaded = true
    }
    #endif

    func clubName(_ key: String?) -> String? {
        guard let key, key != "__unset__" else { return nil }
        return clubs[key]
    }
}
