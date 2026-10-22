package fm.backspace.bguru.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** Chat or timeline (phone pages / the switch at the top). */
enum class MainTab { TIMELINE, CHAT }

/** The timeline: root posts by latest activity, like the iOS / Mac apps
 *  (native/shared/TimelineStore.swift). Not streamed: refreshed on appear, on
 *  pull, when the app comes back and every minute while on screen. */
class TimelineStore(
    val api: ApiClient,
    /** The operations' calls (tests: a fake that fails). */
    private val ops: PostOpsApi = api,
    dispatcher: kotlinx.coroutines.CoroutineDispatcher = Dispatchers.Main.immediate,
) {
    /** What the server allows (set by the screen): e.g. the idempotent bookmark. */
    var capabilities: Capabilities? = null
    var posts by mutableStateOf<List<Post>>(emptyList()); private set
    var hasLoaded by mutableStateOf(false); private set
    var loadingMore by mutableStateOf(false); private set
    var failed by mutableStateOf(false); private set
    var clubs by mutableStateOf<Map<String, String>>(emptyMap()); private set
    /** Members' names, lower-cased: which @mentions in posts are marked (TimelineRules). */
    var memberNames by mutableStateOf<Set<String>>(emptySet()); private set
    /** The members, for @mention completion in the post and reply boxes (GET /api/agent/members). */
    var members by mutableStateOf<List<MentionMember>>(emptyList()); private set
    /** The operation dialog on screen (edit, delete, picker…), drawn over the list and the thread. */
    var dialog by mutableStateOf<PostDialog?>(null)
    /** A short message at the bottom (Snackbar); `undo` = 「タップで取り消し」. */
    var toast by mutableStateOf<PostToast?>(null)
    /** Demo only: open the long-press menu of this post at launch. */
    var demoMenu by mutableStateOf<Long?>(null)
    private var membersJob: Job? = null
    /** Set by a "reply to your post" notification: show the timeline and open this thread. */
    var openThread by mutableStateOf<Long?>(null)

    private var nextCursor: String? = null
    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val pendingRead = mutableSetOf<Long>()
    private var readJob: Job? = null
    var demo = false

    val unreadCount get() = posts.count { it.unread == true }

    fun clubName(key: String?): String? = key?.takeIf { it != "__unset__" }?.let { clubs[it] }

    suspend fun refresh() {
        if (demo) return
        lastRefreshAt = android.os.SystemClock.elapsedRealtime() // tried (failures wait a minute too)
        if (clubs.isEmpty()) runCatching { clubs = api.clubs().associate { it.key to it.name } }
        if (members.isEmpty() && membersJob?.isActive != true) {
            membersJob = scope.launch { runCatching { applyMembers(api.members()) } }
        }
        try {
            val r = api.posts()
            // Unchanged posts keep their instance (their rows skip recomposition), and an
            // unchanged list is not even assigned (posts uses structural equality).
            val old = posts.associateBy { it.id }
            withContext(Dispatchers.Default) { PostMarkdown.warm(r.posts.map { it.text }) }
            posts = r.posts.map { p ->
                val q = if (p.id in pendingRead) p.copy(unread = false) else p
                old[q.id]?.takeIf { it == q } ?: q
            }
            nextCursor = r.nextCursor
            failed = false
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            failed = posts.isEmpty()
        }
        hasLoaded = true
    }

    fun refreshAsync() { scope.launch { refresh() } }

    /** The clubs (for 部活の選択), once. */
    suspend fun loadClubs() {
        if (clubs.isNotEmpty() || demo) return
        runCatching { clubs = api.clubs().associate { it.key to it.name } }
    }

    /** The members (for @mention completion), once. */
    suspend fun loadMembers() {
        if (members.isNotEmpty() || demo) return
        runCatching { applyMembers(api.members()) }
    }

    /** Demo only: where this Mac serves the sample pictures and sounds. */
    var demoMedia = "http://10.0.2.2:1"; private set

    private fun applyMembers(list: List<MentionMember>) {
        members = list
        memberNames = list.map { it.name.lowercase() }.toSet()
    }

    fun loadMore() {
        val cursor = nextCursor ?: return
        if (loadingMore || demo) return
        loadingMore = true
        scope.launch {
            runCatching { api.posts(cursor) }.getOrNull()?.let { r ->
                withContext(Dispatchers.Default) { PostMarkdown.warm(r.posts.map { it.text }) }
                val known = posts.map { it.id }.toSet()
                posts = posts + r.posts.filter { it.id !in known }
                nextCursor = r.nextCursor
            }
            loadingMore = false
        }
    }

    private var lastRefreshAt = 0L
    private val POLL_MS = 60_000L

    /** While the timeline is on screen (and the app in front): refresh every minute — at
     *  once when [now], or when the last refresh is already a minute old. Cancel to stop. */
    suspend fun pollWhileOnScreen(now: Boolean) {
        if (now && hasLoaded) refresh()
        while (true) {
            val wait = POLL_MS - (android.os.SystemClock.elapsedRealtime() - lastRefreshAt)
            if (wait > 0) delay(wait)
            refresh()
            if (demo) return
        }
    }

    /** A post was on screen for a second: read (per post, debounced, batched — like the web). */
    fun sawPost(id: Long) {
        val p = posts.firstOrNull { it.id == id } ?: return
        if (p.unread != true) return
        posts = posts.map { if (it.id == id) it.copy(unread = false) else it }
        markRead(listOf(id))
    }

    /** A reply in an open thread was read: one fewer "新着" on its root in the list. */
    fun sawReply(id: Long, root: Long) {
        markRead(listOf(id))
        posts = posts.map { if (it.id == root && (it.unreadReplies ?: 0) > 0) it.copy(unreadReplies = it.unreadReplies!! - 1) else it }
    }

    fun markRead(ids: List<Long>) {
        if (demo) return
        pendingRead += ids
        readJob?.cancel()
        readJob = scope.launch {
            delay(800)
            val batch = pendingRead.toList()
            api.markPostsRead(batch)
            pendingRead -= batch.toSet()
        }
    }

    /** Optimistic; the server's counts replace it (with `mine` carried over). */
    fun toggleReaction(postId: Long, emoji: String, inTimeline: Boolean = true) {
        val old = posts.firstOrNull { it.id == postId }?.reactions ?: emptyList()
        if (inTimeline) posts = posts.map { if (it.id == postId) it.copy(reactions = ChatStore.toggled(old, emoji)) else it }
        if (demo) return
        scope.launch {
            try {
                val r = api.togglePostReaction(postId, emoji)
                posts = posts.map { if (it.id == postId) it.copy(reactions = merge(r, it.reactions ?: emptyList(), emoji)) else it }
            } catch (_: ApiError) {
                posts = posts.map { if (it.id == postId) it.copy(reactions = old) else it }
            }
        }
    }


    // MARK: 段階 3 — operations (docs/timeline-spec.md §10–§11)

    /** Every screen showing posts (the list here, an open thread) hears each change. */
    private val listeners = mutableListOf<(Long, (Post) -> Post?) -> Unit>()

    fun listen(f: (Long, (Post) -> Post?) -> Unit): () -> Unit { listeners += f; return { listeners -= f } }

    /** Change one post wherever it is shown; `f` returning null removes it. */
    fun patch(id: Long, f: (Post) -> Post?) {
        posts = posts.mapNotNull { if (it.id == id) f(it) else it }
        listeners.toList().forEach { it(id, f) }
    }

    /** The same change to every post by one author (☆ is about the person). */
    private fun patchAuthor(authorId: String, f: (Post) -> Post) {
        posts = posts.map { if (it.authorId == authorId) f(it) else it }
        listeners.toList().forEach { l -> l(-1L) { p -> if (p.authorId == authorId) f(p) else p } }
    }

    private fun fail(e: Throwable, fallback: String = "処理に失敗しました") { toast = PostToast(PostActions.errorText(e, fallback)) }

    /** 🔖: painted at once; the toast offers to undo for 5 seconds. */
    fun toggleBookmark(post: Post, showToast: Boolean = true) {
        val was = post.bookmarkedByMe == true
        patch(post.id) { it.copy(bookmarkedByMe = !was) }
        if (showToast) toast = PostToast(PostActions.bookmarkToast(!was)) { toggleBookmark(post.copy(bookmarkedByMe = !was), showToast = false) }
        if (demo) return
        scope.launch {
            try {
                val now = if (capabilities?.bookmarksSet == true) ops.setBookmark(post.id, !was) else ops.toggleBookmark(post.id)
                if (now == was) patch(post.id) { it.copy(bookmarkedByMe = now) }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                patch(post.id) { it.copy(bookmarkedByMe = was) }
                fail(e)
            }
        }
    }

    /** ☆ the post's author (every post of theirs on screen follows). */
    fun toggleFavorite(post: Post, showToast: Boolean = true) {
        val user = post.authorId ?: return
        val was = post.favoriteByMe == true
        val name = post.authorName ?: ""
        patchAuthor(user) { it.copy(favoriteByMe = !was) }
        if (showToast) toast = PostToast(PostActions.favoriteToast(name, !was)) { toggleFavorite(post.copy(favoriteByMe = !was), showToast = false) }
        if (demo) return
        scope.launch {
            try {
                ops.setFavorite(user, !was)
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                patchAuthor(user) { it.copy(favoriteByMe = was) }
                fail(e)
            }
        }
    }

    /** 📌 my root post for 24 hours (one per person: a new pin replaces the old one). */
    fun togglePin(post: Post) {
        val was = PostActions.isPinned(post)
        fun apply(now: Boolean) {
            val at = if (now) java.time.Instant.now().toString() else null
            if (now) posts.filter { it.isAuthor && it.pinnedAt != null && it.id != post.id }.forEach { o -> patch(o.id) { it.copy(pinnedAt = null) } }
            patch(post.id) { it.copy(pinnedAt = at) }
            pinned = if (now) listOf(post.copy(pinnedAt = at)) + pinned.filterNot { it.isAuthor || it.id == post.id } else pinned.filterNot { it.id == post.id }
        }
        if (demo) { apply(!was); return }
        scope.launch {
            try { apply(ops.togglePin(post.id)) } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                fail(e)
            }
        }
    }

    /** The confirmed delete. Returns null when done, or the server's words (shown in the dialog). */
    suspend fun delete(post: Post): String? {
        if (!demo) {
            try { api.deletePost(post.id) } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                return PostActions.errorText(e, "削除に失敗しました")
            }
        }
        patch(post.id) { null }
        pinned = pinned.filterNot { it.id == post.id }
        post.parentId?.let { root -> patch(root) { it.copy(replyCount = (it.replyCount - 1).coerceAtLeast(0)) } }
        return null
    }

    /** After an edit was saved (PostDraft.saveEdit). */
    fun didEdit(post: Post) {
        PostMarkdown.warm(listOf(post.text))
        patch(post.id) { post }
    }

    /** 部活の付け替え (my root post). key null = 「ラベルなし」. */
    fun setClub(post: Post, key: String?) {
        val old = post.club
        patch(post.id) { it.copy(club = key, clubManual = true, display = null) } // the label is worked out here again
        if (demo) return
        scope.launch {
            try {
                val now = ops.setClub(post.id, key)
                patch(post.id) { it.copy(club = now) }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                patch(post.id) { it.copy(club = old, display = post.display) }
                fail(e)
            }
        }
    }

    /** Vote (or move my vote). Shown at once; the server's counts replace it. */
    fun vote(post: Post, optionId: Long) {
        val poll = post.poll ?: return
        if (PollRules.isClosed(poll) || poll.myVote == optionId) return
        patch(post.id) { it.copy(poll = it.poll?.let { p -> PollRules.voted(p, optionId) }) }
        if (demo) return
        scope.launch {
            try {
                ops.vote(post.id, optionId)?.let { p -> patch(post.id) { it.copy(poll = p) } }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                patch(post.id) { it.copy(poll = poll) }
                fail(e, "投票できませんでした")
            }
        }
    }

    /** 「回答を編集」: null when saved, or the words to show in the dialog. */
    suspend fun editPoll(post: Post, options: List<PollRules.EditOption>): String? {
        val poll = post.poll ?: return "投稿が見つかりません"
        PollRules.validateEdit(poll, options)?.let { return it }
        val rows = options.filter { it.label.isNotBlank() }.map { it.id to it.label.trim() }
        val updated = if (demo) {
            val byId = poll.options.associateBy { it.id }
            var next = (poll.options.maxOfOrNull { it.id } ?: 0L) + 1
            poll.copy(options = rows.map { (id, label) -> byId[id]?.copy(label = label) ?: PostPoll.Option(next++, label) })
        } else {
            try { api.editPoll(post.id, rows) } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                return PostActions.errorText(e, "保存できませんでした")
            }
        }
        if (updated != null) patch(post.id) { it.copy(poll = updated) }
        return null
    }

    /** A reaction from the picker on a post shown anywhere (the list or a thread). */
    fun react(post: Post, emoji: String) {
        val old = post.reactions ?: emptyList()
        val inTimeline = posts.any { it.id == post.id }
        patch(post.id) { it.copy(reactions = ChatStore.toggled(it.reactions ?: emptyList(), emoji)) }
        if (demo) return
        scope.launch {
            try {
                val r = ops.togglePostReaction(post.id, emoji)
                patch(post.id) { it.copy(reactions = merge(r, it.reactions ?: emptyList(), emoji)) }
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                patch(post.id) { it.copy(reactions = old) }
                if (!inTimeline) fail(e)
            }
        }
    }

    // MARK: lists (ピン留め / ブックマーク / お気に入りの人)

    var pinned by mutableStateOf<List<Post>>(emptyList()); private set
    var listPosts by mutableStateOf<List<Post>?>(null); private set
    var listFailed by mutableStateOf<String?>(null); private set

    /** filter: "pinned" | "bm" | "fav". */
    fun loadList(filter: String) {
        listPosts = null
        listFailed = null
        if (demo) {
            listPosts = when (filter) {
                "pinned" -> posts.filter { PostActions.isPinned(it) }
                "bm" -> posts.filter { it.bookmarkedByMe == true }
                else -> posts.filter { it.favoriteByMe == true }
            }
            return
        }
        scope.launch {
            try {
                val r = api.postsWhere(filter).posts
                withContext(Dispatchers.Default) { PostMarkdown.warm(r.map { it.text }) }
                listPosts = r
                if (filter == "pinned") pinned = r
            } catch (e: Exception) {
                if (e is kotlinx.coroutines.CancellationException) throw e
                listFailed = PostActions.errorText(e, "読み込めませんでした")
                listPosts = emptyList()
            }
        }
    }

    init {
        // The open list follows every change (an unpin, an edit, a delete).
        listeners += { id, f -> listPosts = listPosts?.mapNotNull { if (it.id == id || id == -1L) f(it) else it } }
    }

    /** After posting or replying: show it at once (the next refresh confirms it). */
    fun didPublish(post: Post) {
        if (post.parentId == null) {
            posts = listOf(post) + posts.filterNot { it.id == post.id }
        } else {
            val root = posts.firstOrNull { it.id == post.parentId } ?: return
            posts = listOf(root.copy(replyCount = root.replyCount + 1, lastActivityAt = post.createdAt)) + posts.filterNot { it.id == root.id }
        }
    }

    fun stop() = scope.cancel()

    /** Tests only: start from these posts. */
    internal fun testPosts(list: List<Post>) { posts = list; hasLoaded = true }

    /** Debug only: sample timeline for offline UI checks. */
    fun loadDemo(images: String? = null, jukeboxAudio: String? = null, media: String? = null) {
        demo = true
        val now = java.time.Instant.now()
        applyMembers(listOf("ビーグル", "mazzo", "NORIO TAKAHASHI", "takuto", "coban", "ポンコツ散財王ドリキン").map { MentionMember(it, it) })
        demoMedia = media ?: "http://10.0.2.2:1"
        val many = if (images == null) emptyList() else (10L..70L).map { i ->
            val n = (i % 5).toInt() + 1
            Post(i, authorName = listOf("mazzo", "takuto", "NORIO TAKAHASHI", "coban")[(i % 4).toInt()],
                text = "写真のテスト $i 枚目まで。スクロールの重さを測るための投稿です https://bsm.backspace.fm",
                images = (1..n).map { k -> "$images/photo${(i + k) % 8}.jpg?p=$i-$k" },
                createdAt = now.minusSeconds(i * 600).toString(), replyCount = (i % 6).toInt(),
                reactions = if (i % 2 == 0L) listOf(Reaction("❤️", 3), Reaction("😂", 1)) else null,
                unread = i % 3 == 0L, unreadReplies = if (i % 6 == 5L) 2 else 0)
        }
        val anniversary = if (jukeboxAudio == null) emptyList() else listOf(
            Post(9002, authorName = "ジュークボックス", createdAt = now.minusSeconds(30).toString(), audioUrl = jukeboxAudio, replyCount = 3,
                text = "📅 7 年前の今日の backspace.fm\n#313:Galaxy ＆ 樋口監督ドヤ vs. GoPro 8ドヤ（デモ）"))
        posts = anniversary + demoParity(now, media) + listOf(Post(9001, authorName = "ビーグル", club = "chat", createdAt = now.minusSeconds(60).toString(), text = DEMO_MARKDOWN)) + many + listOf(
            Post(4, authorName = "NORIO TAKAHASHI", text = "https://share.google/BM8clX7MsYzuIrrCf", createdAt = now.minusSeconds(120).toString(), club = "car",
                urlPreview = UrlPreview("https://www.webcg.net/articles/-/50000", title = "ポルシェが未来のミドシップスーパースポーツカー「ミッションS」を発表 【ニュース】 - webCG",
                    description = "ポルシェは未来のミドシップスーパースポーツカーのコンセプトを発表した。",
                    image = "https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png", siteName = "webCG")),
            Post(3, authorName = "mazzo", replyCount = 4, text = "うちの犬が今朝こんな顔してました 🐶 https://bsm.backspace.fm",
                images = listOf("/api/media/demo-1.jpg"), createdAt = now.minusSeconds(300).toString(), club = "pet",
                reactions = listOf(Reaction("❤️", 3, mine = true)), unread = true, unreadReplies = 2),
            Post(2, authorName = "NORIO TAKAHASHI", text = "@ドリキン Android 版入れました。通知もちゃんと来ます",
                images = listOf("/api/media/a.jpg", "/api/media/b.jpg", "/api/media/c.jpg"), createdAt = now.minusSeconds(7200).toString(), club = "apple"),
            Post(1, authorName = "ドリキン", isAuthor = true, replyCount = 12, text = "ビーグルのアプリにタイムラインを追加しています",
                createdAt = now.minusSeconds(7200).toString(), club = "improve"),
        )
        // Every demo post has an author id (☆ お気に入り is about the person); mine is "me".
        posts = posts.map { p -> if (p.authorId != null) p else p.copy(authorId = if (p.isAuthor) "me" else p.authorName) }
        clubs = mapOf("pet" to "ペット部", "apple" to "リンゴ部", "improve" to "機能改善")
        hasLoaded = true
    }

    /** Debug only (`--es demo_ops <what>`): posts for the 段階 3 operations at the top — my pinned
     *  post with photos and a sound, a poll I voted in, a closed one, my own poll (editable) — and
     *  one screen opened: menu | menu_other | edit | delete | picker | poll_edit | club | pins |
     *  pins_empty | bookmarks | compose_poll | compose_mention | compose_media | compose_club |
     *  thread | toast | none. Nothing is sent: every operation is done here (demo). */
    fun demoOps(open: String?) {
        if (!demo) return
        val now = java.time.Instant.now()
        val m = demoMedia
        fun ago(min: Long) = now.minusSeconds(min * 60).toString()
        fun opts(vararg v: Pair<String, Int>): List<PostPoll.Option> {
            val total = v.sumOf { it.second }
            return v.mapIndexed { i, (l, n) -> PostPoll.Option(i + 1L, l, n, if (total > 0) Math.round(n * 100.0 / total).toInt() else 0) }
        }
        val mine = Post(9201, authorId = "me", authorName = "ドリキン", isAuthor = true, club = "improve", clubManual = true,
            pinnedAt = ago(30), createdAt = ago(35), replyCount = 2,
            text = "段階 3 の操作を確かめる投稿です。長押しでメニュー（🔖・チャットに引用・☆・リアクション・📌・✏️・🗑）。@mazzo さんも見てね",
            images = listOf("$m/parity-wide.jpg", "$m/parity-square.jpg"), audioUrl = "$m/parity-voice.m4a",
            reactions = listOf(Reaction("❤️", 2, reactors = listOf("mazzo", "takuto")), Reaction(":drikin:", 1, reactors = listOf("coban"))))
        val voted = Post(9202, authorId = "mazzo", authorName = "mazzo", createdAt = ago(50), bookmarkedByMe = true, favoriteByMe = true, club = "chat",
            text = "次の B-guru オフ会はどこがいい？",
            poll = PostPoll("次の B-guru オフ会はどこがいい？", now.plusSeconds(5 * 3600 + 20 * 60).toString(), totalVotes = 7, voterCount = 7, myVote = 2,
                options = opts("東京" to 3, "大阪" to 2, "オンライン" to 2)))
        val closed = Post(9203, authorId = "takuto", authorName = "takuto", createdAt = ago(60 * 26),
            text = "好きな backspace.fm のコーナーは？",
            poll = PostPoll("好きな backspace.fm のコーナーは？", now.minusSeconds(2 * 3600).toString(), closed = true, totalVotes = 12, voterCount = 12, myVote = 1,
                options = opts("散財" to 6, "ガジェット" to 4, "おたより" to 2)))
        val myPoll = Post(9204, authorId = "me", authorName = "ドリキン", isAuthor = true, createdAt = ago(10), club = "improve",
            text = "アプリの次の機能はどれがほしい？",
            poll = PostPoll("アプリの次の機能はどれがほしい？", now.plusSeconds(24 * 3600 - 600).toString(), editable = true, totalVotes = 3, voterCount = 3,
                options = opts("プロフィール" to 2, "検索" to 0, "下書き" to 0, "通知の設定" to 1)))
        posts = listOf(mine, voted, closed, myPoll) + posts.filterNot { it.id in setOf(9201L, 9202L, 9203L, 9204L) }
        pinned = listOf(mine)
        clubs = clubs + ("chat" to "雑談")
        EmojiCatalog.loadDemo(mapOf("drikin" to "$m/parity-square.jpg", "beagle" to "$m/parity-wide.jpg", "anim" to "$m/parity-anim.gif"))
        when (open) {
            "menu" -> demoMenu = mine.id
            "menu_other" -> demoMenu = voted.id
            "edit" -> dialog = PostDialog.Edit(mine)
            "delete" -> dialog = PostDialog.Delete(mine)
            "picker" -> dialog = PostDialog.Picker(voted)
            "poll_edit" -> dialog = PostDialog.PollEdit(myPoll)
            "club" -> dialog = PostDialog.Club(mine)
            "pins" -> dialog = PostDialog.List("pinned")
            "pins_empty" -> { posts = posts.map { it.copy(pinnedAt = null) }; pinned = emptyList(); dialog = PostDialog.List("pinned") }
            "bookmarks" -> dialog = PostDialog.List("bm")
            "compose_poll" -> dialog = PostDialog.Compose("poll")
            "compose_mention" -> dialog = PostDialog.Compose("mention")
            "compose_media" -> dialog = PostDialog.Compose("media")
            "compose_club" -> dialog = PostDialog.Compose("club")
            "thread" -> openThread = mine.id
            "toast" -> toggleBookmark(mine)
        }
    }

    /** Debug only: one post for each of the web's display rules (TimelineDisplay.kt) — a
     *  501-character text, photos 1/2/3/5 (tall and wide), video, sound, GIF, many reactions,
     *  mentions. `media`: where the photos and clips are served from this Mac (orientation-check.sh
     *  makes them: parity-*.jpg / .gif / .mp4 / .m4a); without it they show as empty boxes. */
    private fun demoParity(now: java.time.Instant, media: String?): List<Post> {
        fun at(min: Long) = now.minusSeconds(40 + min * 60).toString()
        val m = media ?: "http://10.0.2.2:1"
        val wide = "$m/parity-wide.jpg"
        val tall = "$m/parity-tall.jpg"
        val square = "$m/parity-square.jpg"
        val long = buildString {
            append("@mazzo さん、@[NORIO TAKAHASHI] さん、@nobody さん（会員でない名前は普通の文字）。\n")
            while (length < 501) append("長い投稿の折りたたみを確かめるための文章です。Web と同じく 500 文字を超えたら先頭 500 文字で切って「続きを読む」を出します。")
        }.take(501)
        val names = listOf("mazzo", "takuto", "NORIO TAKAHASHI", "coban", "ビーグル", "ドリキン", "ぽん", "たろう", "はなこ", "じろう", "さぶろう", "しろう")
        return listOf(
            Post(9101, authorName = "ビーグル", club = "improve", createdAt = at(1), text = long, replyCount = 2,
                reactions = listOf(Reaction("😂", 2, reactors = listOf("mazzo", "coban")), Reaction("❤️", 15, mine = true, reactors = names),
                    Reaction("👍", 15, reactors = names.reversed()), Reaction("🎉", 1, reactors = listOf("takuto")), Reaction("🙏", 3, reactors = names.take(3)))),
            Post(9102, authorName = "mazzo", club = TimelineRules.CLUB_UNSET, createdAt = at(2), text = "横長 1 枚（切り抜かない・最大幅 360）", images = listOf(wide)),
            Post(9103, authorName = "takuto", createdAt = at(3), text = "縦長 1 枚（高さの上限 480）", images = listOf(tall)),
            Post(9104, authorName = "coban", createdAt = at(4), text = "2 枚は 2 列", images = listOf(wide, tall)),
            Post(9105, authorName = "NORIO TAKAHASHI", createdAt = at(5), text = "3 枚は 3 列", images = listOf(tall, wide, square)),
            Post(9106, authorName = "mazzo", createdAt = at(6), text = "5 枚は 3 列 + 2", images = listOf(wide, tall, square, "$m/parity-anim.gif", wide + "?5")),
            Post(9107, authorName = "ビーグル", createdAt = at(7), text = "動画（▶ で再生）", videoUrl = "$m/parity-clip.mp4"),
            Post(9108, authorName = "takuto", createdAt = at(8), text = "音声", audioUrl = "$m/parity-voice.m4a"),
            Post(9109, authorName = "coban", createdAt = at(9), text = "GIF は動く", images = listOf("$m/parity-anim.gif")),
        )
    }

    companion object {
        fun merge(r: PostReactionToggle, previous: List<Reaction>, toggled: String): List<Reaction> = r.reactions.map { x ->
            val prev = previous.firstOrNull { it.emoji == x.emoji }
            Reaction(x.emoji, x.count, mine = if (x.emoji == toggled) r.added else prev?.mine ?: false, reactors = prev?.reactors ?: emptyList())
        }
    }
}

/** Debug only: a post that uses every kind of Markdown the timeline draws. */
private const val DEMO_MARKDOWN = """## 🐾 ビーグル更新情報（10/14〜10/19）

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
@ドリキン さん https://bsm.backspace.fm/#/post/1"""
