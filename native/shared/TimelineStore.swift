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
    /// The clubs in the server's order (「部活動を選択」).
    private(set) var clubList: [ClubInfo] = []
    /// Edit, delete, pin, bookmark, ☆, polls… (段階 3, docs/timeline-spec.md §10).
    @ObservationIgnored private(set) lazy var actions: PostActionsModel = {
        let a = PostActionsModel(api: api)
        a.timeline = self
        return a
    }()
    /// Set by a "reply to your post" notification tap: the app shows the timeline
    /// and opens this thread.
    var openThread: Int?
    /// A thread was opened (its root post), and a reply was sent in a thread (the root's id).
    /// Mac: the on-device AI's picks remember what the member looked at (kept on this Mac only).
    @ObservationIgnored var onThreadOpened: ((Post) -> Void)?
    @ObservationIgnored var onReplied: ((Int) -> Void)?
    private var nextCursor: String?
    /// How many posts the last refresh's first page had (the rest came from loading more).
    @ObservationIgnored private var firstPageCount = 0

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

    /// The loaded posts as 🐶 Beagle's knowledge (BeagleOnDevice): who and what, the link's title too.
    func beagleNotes() -> [BeagleOnDevice.Note] {
        posts.compactMap { p in
            let title = p.urlPreview?.title.map { "（リンク: \($0)）" } ?? ""
            let text = (p.text + title).trimmingCharacters(in: .whitespacesAndNewlines)
            return text.isEmpty ? nil : BeagleOnDevice.Note(name: p.authorName ?? "?", text: text)
        }
    }

    /// A non-`full` refresh in flight: a second caller (coming back fires the screen's
    /// refresh and the poll's at once) waits for it instead of fetching the same page again.
    @ObservationIgnored private var refreshing: Task<Void, Never>?

    /// `full`: asked for (pull, ⟳) — the list starts again from the first page. Otherwise
    /// (every minute, on coming back) the pages read further down are kept.
    func refresh(full: Bool = false) async {
        if full { return await fetch(full: true) }
        if let refreshing {
            // Asked for during a fetch that may have started before what we want to see
            // (a "post" event): once it ends, one more.
            refetch = true
            return await refreshing.value
        }
        let t = Task {
            repeat {
                refetch = false
                await fetch(full: false)
            } while refetch
        }
        refreshing = t
        await t.value
        refreshing = nil
    }
    @ObservationIgnored private var refetch = false

    /// The live stream's "post" event (someone published): on screen, show it now;
    /// off screen, the next time the timeline can be seen fetches at once.
    func postCreated() {
        if pollTask != nil { Task { await refresh() } } else if lastRefresh != nil { lastRefresh = .distantPast }
    }

    private func fetch(full: Bool) async {
        #if DEBUG
        if api.token == "demo" { return }
        #endif
        HangWatch.note("timeline refresh (\(posts.count) posts)")
        lastRefresh = Date()
        // Members' names decide which @ are drawn as mentions (the chat may have loaded them).
        if MemberDirectory.shared.isEmpty, let m = try? await api.members() { MemberDirectory.shared.set(m) }
        if clubs.isEmpty { await loadClubs() }
        do {
            let r = try await api.posts()
            // Keep "read on this device" marks the server has not echoed yet.
            let fresh = r.posts.map { p in
                var p = p
                if pendingRead.contains(p.id) { p.unread = false }
                return p
            }
            // The first page replaces the top; the older pages already read further down stay
            // under it (and so does the cursor for the next one). Replacing the whole list
            // with the first 30 every minute cut it short under someone reading post 80: the
            // scroll position fell past the end, the last row came on screen, the next page
            // loaded, and a minute later the same again (drikin 2026-10-23, freezes / jank).
            // Of the previous first page, what is missing now was either pushed down by as many
            // posts that came in (kept, at the top of the older part) or deleted (dropped). What
            // was on later pages is kept as it was until a full refresh.
            let freshIds = Set(fresh.map(\.id))
            var older: [Post] = []
            if !full, posts.count > firstPageCount {
                let prevFirst = posts.prefix(firstPageCount)
                let prevIds = Set(prevFirst.map(\.id))
                let cameIn = fresh.filter { !prevIds.contains($0.id) }.count
                let pushedDown = prevFirst.filter { !freshIds.contains($0.id) }.suffix(cameIn)
                older = Array(pushedDown) + posts.dropFirst(firstPageCount).filter { !freshIds.contains($0.id) }
            }
            firstPageCount = fresh.count
            let merged = older.isEmpty ? fresh : fresh + older
            // Nothing new (most minutes): leave the list alone. Every assignment, even of
            // the same posts, made the whole list (and everything reading it) update.
            if merged != posts { posts = merged }
            if older.isEmpty, nextCursor != r.nextCursor { nextCursor = r.nextCursor }
            if failed { failed = false }
            HangWatch.note("timeline refreshed → \(posts.count) posts")
        } catch {
            if failed != posts.isEmpty { failed = posts.isEmpty }
            HangWatch.note("timeline refresh failed: \(error.localizedDescription)")
        }
        if !hasLoaded { hasLoaded = true }
    }

    func loadClubs() async {
        guard let c = try? await api.clubs() else { return }
        clubList = c
        clubs = Dictionary(c.map { ($0.key, $0.name) }, uniquingKeysWith: { a, _ in a })
    }

    /// A change made here (PostActionsModel) to the posts in the list.
    func apply(_ kind: PostChange.Kind) {
        switch kind {
        case .fields, .favorite, .unpinnedOthers:
            for i in posts.indices {
                if let q = kind.applied(to: posts[i]), q != posts[i] { posts[i] = q }
            }
        case let .deleted(id, parentId):
            posts.removeAll { $0.id == id }
            if let parentId, let i = posts.firstIndex(where: { $0.id == parentId }), let n = posts[i].replyCount, n > 0 {
                posts[i].replyCount = n - 1
            }
        }
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
        markRead([id])
        // The list shows it as read a moment later, together with the others read meanwhile:
        // each change to `posts` re-runs the whole list, and scrolling through unread posts
        // changed it for every one of them in turn.
        seenNotShown.insert(id)
        guard seenTask == nil else { return }
        seenTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(300))
            guard let self else { return }
            seenTask = nil
            let ids = seenNotShown
            seenNotShown = []
            var p = posts
            for i in p.indices where ids.contains(p[i].id) && p[i].unread == true { p[i].unread = false }
            if p != posts { posts = p }
        }
    }
    @ObservationIgnored private var seenNotShown = Set<Int>()
    @ObservationIgnored private var seenTask: Task<Void, Never>?

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
    /// うなる (`whisper`): the reply counts but the thread stays where it is (the web's).
    func didPublish(_ post: Post, whisper: Bool = false) {
        if let parent = post.parentId { onReplied?(parent) }
        if post.parentId == nil {
            posts.removeAll { $0.id == post.id }
            posts.insert(post, at: 0)
        } else if let i = posts.firstIndex(where: { $0.id == post.parentId }) {
            if whisper {
                posts[i].replyCount = (posts[i].replyCount ?? 0) + 1
                return
            }
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

    /// Dev only: replace the list (the Mac's AI picks test brings its own posts).
    func debugSetPosts(_ p: [Post], clubs c: [String: String]) {
        posts = p
        clubs = c
        hasLoaded = true
    }

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
        clubs = ["chat": "雑談", "pet": "ペット部", "apple": "リンゴ部", "improve": "機能改善", "car": "クルマ部"]
        clubList = DemoPostServer.clubs.map { ClubInfo(key: $0.0, name: $0.1, category: $0.2) }
        clubs = Dictionary(clubList.map { ($0.key, $0.name) }, uniquingKeysWith: { a, _ in a })
        DemoPostServer.shared.timeline = self
        // 段階 3: my post with a poll (open, answers editable), someone's closed poll, my pinned
        // post, a bookmarked post and a favourite's post.
        posts.insert(contentsOf: Self.demoActionPosts(), at: 1)
        if let i = posts.firstIndex(where: { $0.id == 3 }) { posts[i].bookmarkedByMe = true; posts[i].favoriteByMe = true }
        // The display rules (long text, pictures, video, sound, GIF, reactions, mentions),
        // after today's jukebox post.
        posts.insert(contentsOf: TimelineDemoMedia.posts(now: now), at: 1)
        MemberDirectory.shared.set(TimelineDemoMedia.members.map { MentionMember(userId: $0, name: $0, avatar: nil) })
        DemoPostServer.shared.seed(posts)
        // -demoPosts N / BGURU_DEMO_POSTS=N: a full first page (the server sends 30).
        let want = CommandLine.arguments.firstIndex(of: "-demoPosts").flatMap { i in i + 1 < CommandLine.arguments.count ? Int(CommandLine.arguments[i + 1]) : nil }
            ?? ProcessInfo.processInfo.environment["BGURU_DEMO_POSTS"].flatMap(Int.init) ?? 0
        debugFill(to: want)
        hasLoaded = true
    }

    /// Dev only: the operations' sample posts (ids 120–122).
    static func demoActionPosts() -> [Post] {
        let f = ISO8601DateFormatter()
        let recent = f.string(from: Date().addingTimeInterval(-600))
        let old = f.string(from: Date().addingTimeInterval(-26 * 3600))
        var mine = Post(id: 120, authorId: "me", authorName: "ドリキン", isAuthor: true, replyCount: 1,
                        text: "次の配信で話してほしいのはどれ？", createdAt: recent, club: "chat")
        mine.poll = PostPoll(question: "次の配信で話してほしいのはどれ？", endsAt: f.string(from: Date().addingTimeInterval(5.5 * 3600)),
                             closed: false, editable: true, totalVotes: 5, voterCount: 5, myVote: nil,
                             options: [.init(id: 1201, label: "新しい MacBook", votes: 3, pct: 60),
                                       .init(id: 1202, label: "カメラの話", votes: 2, pct: 40),
                                       .init(id: 1203, label: "散財の振り返り", votes: 0, pct: 0)])
        mine.pinnedAt = f.string(from: Date().addingTimeInterval(-300))
        mine.clubManual = true
        var closed = Post(id: 121, authorId: "a", authorName: "mazzo", isAuthor: false, replyCount: 0,
                          text: "朝はパン派？ごはん派？", createdAt: old, club: "chat")
        closed.poll = PostPoll(question: "朝はパン派？ごはん派？", endsAt: f.string(from: Date().addingTimeInterval(-3600)),
                               closed: true, editable: false, totalVotes: 7, voterCount: 7, myVote: 1212,
                               options: [.init(id: 1211, label: "パン", votes: 3, pct: 43), .init(id: 1212, label: "ごはん", votes: 4, pct: 57),
                                         .init(id: 1213, label: "食べない", votes: 0, pct: 0)])
        closed.favoriteByMe = true
        let plain = Post(id: 122, authorId: "me", authorName: "ドリキン", isAuthor: true, replyCount: 0,
                         text: "部活ラベルの無い自分の投稿（＋部活 から選べる）", images: [TimelineDemoMedia.picture("mine", 1200, 800, hue: 0.4)],
                         createdAt: recent)
        return [mine, closed, plain]
    }

    /// Dev only: made-up posts after the sample ones, up to `n`.
    func debugFill(to n: Int) {
        guard n > posts.count else { return }
        posts += TimelineStore.debugDemoReplies(root: 0, count: n - posts.count).enumerated().map { i, r in
            var p = r
            p.id = 20_000 + i
            p.parentId = nil
            p.replyCount = i % 4
            p.club = ["chat", "pet", "apple", "improve"][i % 4]
            p.unread = i % 5 == 0
            p.unreadReplies = i % 7 == 0 ? 1 : nil
            // GIFs and videos all down a long list (the scroll check: they must not stall it).
            if i % 10 == 4 { p.images = [TimelineDemoMedia.gif(100 + i)] + (i % 20 == 4 ? [] : (p.images ?? [])) }
            if i % 15 == 7 { p.videoUrl = TimelineDemoMedia.video }
            return p
        }
    }

    /// Dev only: what a minute's refresh does to the list (the Mac froze when one came with a
    /// thread open, 2026-10-22). Round by round: the same posts as fresh values, one post
    /// moved to the top with a new reply, read marks and reactions changed, counts changed.
    func debugRefresh(round: Int) {
        var p = posts
        guard !p.isEmpty else { return }
        switch round % 4 {
        case 0: // someone replied to a post further down: it moves to the top
            let i = min(p.count - 1, 3 + round % max(1, p.count - 3))
            var moved = p.remove(at: i)
            moved.replyCount = (moved.replyCount ?? 0) + 1
            moved.unreadReplies = (moved.unreadReplies ?? 0) + 1
            p.insert(moved, at: 0)
        case 1: // read marks and reactions from another device
            for j in p.indices where j % 3 == round % 3 { p[j].unread = !(p[j].unread ?? false) }
            if var r = p[0].reactions, !r.isEmpty { r[0].count += 1; p[0].reactions = r } else { p[0].reactions = [Reaction(emoji: "👍", count: 1, mine: false, reactors: [])] }
        case 2: // a new post on top, the oldest falls off the first page
            let id = 30_000 + round
            p.insert(Post(id: id, authorId: "n", authorName: "新しい人", isAuthor: false, replyCount: 0, text: "新しい投稿 \(round)",
                          createdAt: ISO8601DateFormatter().string(from: Date()), club: "chat", unread: true), at: 0)
            p.removeLast()
        default: // the same posts, nothing changed but the values were decoded again
            break
        }
        posts = p
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
