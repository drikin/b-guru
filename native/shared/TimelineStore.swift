import Foundation
import Observation
import SwiftUI

/// Chat or timeline (iPhone pages, the Mac panel switch).
enum MainTab: Hashable { case timeline, chat, jukebox }

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

    /// A post's link in the chat opens its thread here, not in the browser. Made once: a new
    /// action on every body run was a new environment value for everything below it.
    @ObservationIgnored private(set) lazy var postLinkAction = OpenURLAction { [weak self] url in
        if let id = ChatStore.postId(in: url) { self?.openThread = id; return .handled }
        return .systemAction
    }

    var unreadCount: Int { posts.filter { $0.unread == true }.count }

    func refresh() async {
        #if DEBUG
        if api.token == "demo" { return }
        #endif
        HangWatch.note("timeline refresh (\(posts.count) posts)")
        lastRefresh = Date()
        if clubs.isEmpty, let c = try? await api.clubs() {
            clubs = Dictionary(c.map { ($0.key, $0.name) }, uniquingKeysWith: { a, _ in a })
        }
        do {
            let r = try await api.posts()
            // Keep "read on this device" marks the server has not echoed yet.
            let fresh = r.posts.map { p in
                var p = p
                if pendingRead.contains(p.id) { p.unread = false }
                return p
            }
            // Nothing new (most minutes): leave the list alone. Every assignment, even of
            // the same posts, made the whole list (and everything reading it) update.
            if fresh != posts { posts = fresh }
            if nextCursor != r.nextCursor { nextCursor = r.nextCursor }
            if failed { failed = false }
            HangWatch.note("timeline refreshed → \(posts.count) posts")
        } catch {
            if failed != posts.isEmpty { failed = posts.isEmpty }
            HangWatch.note("timeline refresh failed: \(error.localizedDescription)")
        }
        if !hasLoaded { hasLoaded = true }
    }

    /// When the list was last fetched (polling resumes with a fetch if that is over a minute ago).
    @ObservationIgnored private var lastRefresh: Date?

    func loadMore() async {
        guard let cursor = nextCursor, !loadingMore else { return }
        loadingMore = true
        defer { loadingMore = false }
        HangWatch.note("timeline load more (\(posts.count) posts)")
        if let r = try? await api.posts(cursor: cursor) {
            let known = Set(posts.map(\.id))
            posts += r.posts.filter { !known.contains($0.id) }
            nextCursor = r.nextCursor
            HangWatch.note("timeline loaded more → \(posts.count) posts")
        }
    }

    /// While the timeline can be seen: refresh every minute (and now, if the list is older).
    func startPolling() {
        guard pollTask == nil else { return }
        let stale = lastRefresh.map { Date().timeIntervalSince($0) >= 60 } ?? false
        pollTask = Task { [weak self] in
            if stale { await self?.refresh() }
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
    static let demoMarkdown = """
    ## 🐾 ビーグル更新情報（10/14〜10/19）

    今週は **101 コミット**・追加 **57,704 行**／削除 **2,661 行**。`baseline-prof.txt` は生成ファイルだわん。

    ---

    ### ✨ 今週の新機能

    - **ボイスルーム（LiveKit）が動き出した** — Web・iPhone・Mac・Android
    - **ルーム（部室）** — 詳しくは [仕様](https://bsm.backspace.fm) を見てね
      - 入れ子の項目
    1. 番号付き
    2. ~~取り消し~~ と *斜体*

    > 引用です
    > 2 行目

    ```
    let x = 1
    ```
    @ドリキン さん https://bsm.backspace.fm/#/post/1
    """

    func debugLoadDemo() {
        let now = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-300))
        let old = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-7200))
        posts = [
            Post(id: 6, authorId: "g", authorName: "ビーグル", isAuthor: false, replyCount: 2,
                 text: "📅 7 年前の今日の backspace.fm\n\n**#313:Galaxy ＆ 樋口監督ドヤ vs. GoPro 8ドヤ**\n2019.10.20 ・ 2:30:21\n\n🎧 下の再生ボタンで聴けます。感想はこのスレッドへどうぞ",
                 audioUrl: (ProcessInfo.processInfo.environment["BGURU_DEMO_AUDIO"] ?? "http://127.0.0.1:8097") + "/tone.mp3",
                 createdAt: now),
            Post(id: 5, authorId: "g", authorName: "ビーグル", isAuthor: false, replyCount: 0,
                 text: Self.demoMarkdown, createdAt: now, club: "chat"),
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
            // A long thread (the Mac froze opening threads with many replies, 2026-10-21).
            Post(id: Self.demoLongThreadId, authorId: "me", authorName: "ドリキン", isAuthor: true, replyCount: Self.demoLongThreadReplies,
                 text: "みなさんの今年買ってよかったものを教えてください！ **一つだけ** でも、たくさんでも。https://bsm.backspace.fm",
                 createdAt: old, club: "chat", reactions: [Reaction(emoji: "❤️", count: 42, mine: true, reactors: []), Reaction(emoji: "👍", count: 9, mine: false, reactors: [])],
                 unread: false, unreadReplies: 30),
        ]
        clubs = ["chat": "雑談", "pet": "ペット部", "apple": "リンゴ部", "improve": "機能改善"]
        hasLoaded = true
    }

    /// The demo thread with many replies (`-demoOpenThread`, the self-test's thread check).
    static let demoLongThreadId = 7
    /// How many: `-demoReplies N` (Mac) or BGURU_DEMO_REPLIES=N (simulator); 240 by default.
    static var demoLongThreadReplies: Int {
        if let i = CommandLine.arguments.firstIndex(of: "-demoReplies"), i + 1 < CommandLine.arguments.count,
           let n = Int(CommandLine.arguments[i + 1]) { return n }
        if let n = ProcessInfo.processInfo.environment["BGURU_DEMO_REPLIES"].flatMap(Int.init) { return n }
        return 240
    }

    /// Replies of every kind: short, long, Markdown, links with cards, photos, reactions,
    /// @mentions, unread ones at the end (as a real long thread has).
    static func debugDemoReplies(root: Int, count: Int) -> [Post] {
        let names = ["mazzo", "takuto", "NORIO TAKAHASHI", "リュウ", "ビーグル", "ドリキン", "kei", "sumi"]
        let base = Date().addingTimeInterval(-Double(count) * 120)
        let fmt = ISO8601DateFormatter()
        let long = String(repeating: "長文の返信です。今年は本当にいろいろ買いましたが、結局毎日使っているのはこれでした。", count: 6)
        let emojis = ["❤️", "👍", "😂", "🎉", "🙏", "👀", "🔥", "💯", "🐶", "🍣"]
        // Pictures (wide, tall, photos, avatars, link cards): drawn here and put in the image
        // cache, so nothing is fetched. BGURU_DEMO_MEDIA=http://127.0.0.1:PORT instead loads
        // them from a local server, arriving after the rows are laid out, as from the real one.
        let server = ProcessInfo.processInfo.environment["BGURU_DEMO_MEDIA"]
        let media = server ?? "selftest-media"
        var drawn: [String: [String]] = [:] // picture → paths that show it
        func pic(_ name: String, _ i: Int) -> String {
            let path = "\(media)/\(name)?i=\(i)"
            drawn[name, default: []].append(path)
            return path
        }
        let replies = (0..<count).map { i in
            let name = names[i % names.count]
            var text: String
            var images: [String]? = nil
            var preview: UrlPreview? = nil
            switch i % 9 {
            case 0: text = "わかります！ \(i)"
            case 1: text = long + " (\(i))"
            case 2: text = "これです https://www.apple.com/jp/iphone/ \(i)"
                preview = UrlPreview(url: "https://www.apple.com/jp/iphone/", title: "iPhone - Apple（日本） \(i)",
                                     description: "新しい iPhone を見てみましょう。", image: pic("photo.jpg", i), siteName: "Apple")
            case 3: text = "写真です \(i)"; images = [pic(i % 2 == 0 ? "wide.jpg" : "tall.jpg", i)]
            case 4: text = "@ドリキン さん **太字** と `code` と [リンク](https://bsm.backspace.fm) \(i)\n- 箇条書き\n- もう一つ"
            case 5: text = "3 枚 \(i)"; images = [pic("photo.jpg", i), pic("wide.jpg", i + 1), pic("tall.jpg", i + 2)]
            case 6: text = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
                preview = UrlPreview(url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", title: "動画 \(i)", description: "説明", image: nil, siteName: "YouTube", videoId: "dQw4w9WgXcQ")
            case 7: text = "> 引用\n> 2 行目\n\nそれな \(i)"
            default: text = "😂😂😂 \(i)"
            }
            let reactions: [Reaction]? = i % 3 == 0
                ? (0..<(1 + i % 8)).map { k in Reaction(emoji: emojis[(i + k) % emojis.count], count: 1 + (i * 7 + k) % 23, mine: k == 0 && i % 2 == 0, reactors: ["a", "b"]) }
                : nil
            return Post(id: 10_000 + i, authorId: name, authorName: name, authorAvatar: pic("avatar.jpg", i % names.count),
                        isAuthor: name == "ドリキン", parentId: root,
                        text: text, images: images, createdAt: fmt.string(from: base.addingTimeInterval(Double(i) * 120)),
                        reactions: reactions, unread: i >= count - 30, urlPreview: preview)
        }
        if server == nil {
            let sizes = ["wide.jpg": (1800, 300), "tall.jpg": (400, 1200), "photo.jpg": (1200, 900), "avatar.jpg": (128, 128)]
            for (name, paths) in drawn {
                let (w, h) = sizes[name] ?? (600, 600)
                guard let img = debugPicture(width: w, height: h, hue: CGFloat(abs(name.hashValue) % 360) / 360) else { continue }
                for p in Set(paths) { MediaCache.shared.debugInsert(img, for: p) }
            }
        }
        return replies
    }

    /// A plain picture (two colour bands), drawn with Core Graphics.
    private static func debugPicture(width: Int, height: Int, hue: CGFloat) -> PlatformImage? {
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        ctx.setFillColor(CGColor(red: 0.3 + hue * 0.6, green: 0.55, blue: 0.9 - hue * 0.5, alpha: 1))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.35))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height / 3))
        return ctx.makeImage().map(PlatformImage.decoded)
    }
    #endif

    func clubName(_ key: String?) -> String? {
        guard let key, key != "__unset__" else { return nil }
        return clubs[key]
    }
}
