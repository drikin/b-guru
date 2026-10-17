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
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

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
    /** Set by a "reply to your post" notification: show the timeline and open this thread. */
    var openThread by mutableStateOf<Long?>(null)

    private var nextCursor: String? = null
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val pendingRead = mutableSetOf<Long>()
    private var readJob: Job? = null
    private var pollJob: Job? = null
    var demo = false

    val unreadCount get() = posts.count { it.unread == true }

    fun clubName(key: String?): String? = key?.takeIf { it != "__unset__" }?.let { clubs[it] }

    suspend fun refresh() {
        if (demo) return
        if (clubs.isEmpty()) runCatching { clubs = api.clubs().associate { it.key to it.name } }
        try {
            val r = api.posts()
            posts = r.posts.map { if (it.id in pendingRead) it.copy(unread = false) else it }
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
                val known = posts.map { it.id }.toSet()
                posts = posts + r.posts.filter { it.id !in known }
                nextCursor = r.nextCursor
            }
            loadingMore = false
        }
    }

    fun startPolling() {
        pollJob?.cancel()
        pollJob = scope.launch {
            while (isActive) {
                delay(60_000)
                refresh()
            }
        }
    }

    fun stopPolling() { pollJob?.cancel(); pollJob = null }

    /** A post came on screen: read (per post, debounced, batched — like the web). */
    fun sawPost(id: Long) {
        val p = posts.firstOrNull { it.id == id } ?: return
        if (p.unread != true) return
        posts = posts.map { if (it.id == id) it.copy(unread = false) else it }
        markRead(listOf(id))
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
    fun loadDemo() {
        demo = true
        val now = java.time.Instant.now()
        posts = listOf(
            Post(3, authorName = "mazzo", replyCount = 4, text = "うちの犬が今朝こんな顔してました 🐶 https://bsm.backspace.fm",
                images = listOf("/api/media/demo-1.jpg"), createdAt = now.minusSeconds(300).toString(), club = "pet",
                reactions = listOf(Reaction("❤️", 3, mine = true)), unread = true),
            Post(2, authorName = "NORIO TAKAHASHI", text = "@ドリキン Android 版入れました。通知もちゃんと来ます",
                images = listOf("/api/media/a.jpg", "/api/media/b.jpg", "/api/media/c.jpg"), createdAt = now.minusSeconds(7200).toString(), club = "apple"),
            Post(1, authorName = "ドリキン", isAuthor = true, replyCount = 12, text = "ビーグルのアプリにタイムラインを追加しています",
                createdAt = now.minusSeconds(7200).toString(), club = "improve"),
        )
        clubs = mapOf("pet" to "ペット部", "apple" to "リンゴ部", "improve" to "機能改善")
        hasLoaded = true
    }

    companion object {
        fun merge(r: PostReactionToggle, previous: List<Reaction>, toggled: String): List<Reaction> = r.reactions.map { x ->
            val prev = previous.firstOrNull { it.emoji == x.emoji }
            Reaction(x.emoji, x.count, mine = if (x.emoji == toggled) r.added else prev?.mine ?: false, reactors = prev?.reactors ?: emptyList())
        }
    }
}
