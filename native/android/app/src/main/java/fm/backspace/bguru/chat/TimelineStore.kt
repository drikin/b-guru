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
class TimelineStore(val api: ApiClient) {
    var posts by mutableStateOf<List<Post>>(emptyList()); private set
    var hasLoaded by mutableStateOf(false); private set
    var loadingMore by mutableStateOf(false); private set
    var failed by mutableStateOf(false); private set
    var clubs by mutableStateOf<Map<String, String>>(emptyMap()); private set
    /** Members' names, lower-cased: which @mentions in posts are marked (TimelineRules). */
    var memberNames by mutableStateOf<Set<String>>(emptySet()); private set
    private var membersJob: Job? = null
    /** Set by a "reply to your post" notification: show the timeline and open this thread. */
    var openThread by mutableStateOf<Long?>(null)

    private var nextCursor: String? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val pendingRead = mutableSetOf<Long>()
    private var readJob: Job? = null
    var demo = false

    val unreadCount get() = posts.count { it.unread == true }

    fun clubName(key: String?): String? = key?.takeIf { it != "__unset__" }?.let { clubs[it] }

    suspend fun refresh() {
        if (demo) return
        lastRefreshAt = android.os.SystemClock.elapsedRealtime() // tried (failures wait a minute too)
        if (clubs.isEmpty()) runCatching { clubs = api.clubs().associate { it.key to it.name } }
        if (memberNames.isEmpty() && membersJob?.isActive != true) {
            membersJob = scope.launch { runCatching { memberNames = api.members().map { it.name.lowercase() }.toSet() } }
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

    /** Debug only: sample timeline for offline UI checks. */
    fun loadDemo(images: String? = null, jukeboxAudio: String? = null, media: String? = null) {
        demo = true
        val now = java.time.Instant.now()
        memberNames = setOf("ビーグル", "mazzo", "NORIO TAKAHASHI", "takuto", "coban", "ポンコツ散財王ドリキン").map { it.lowercase() }.toSet()
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
        clubs = mapOf("pet" to "ペット部", "apple" to "リンゴ部", "improve" to "機能改善")
        hasLoaded = true
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
