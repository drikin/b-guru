package fm.backspace.bguru.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
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
import kotlinx.serialization.Serializable
import java.time.Instant
import java.util.UUID

/** All chat state. Main thread only; network work suspends off it. Sending is
 *  optimistic: the bubble is on screen before the request leaves, and the stored
 *  message (POST response or the stream's create event, whichever lands first)
 *  replaces it in place by clientId — same rule as the web (chat-optimistic.ts). */
class ChatStore(val api: ApiClient) {
    enum class Connection { CONNECTING, LIVE, OFFLINE }

    var rows by mutableStateOf<List<ChatRow>>(emptyList()); private set
    var unreadCount by mutableIntStateOf(0); private set
    var onlineCount by mutableIntStateOf(0); private set
    var connection by mutableStateOf(Connection.CONNECTING); private set
    var capabilities by mutableStateOf<Capabilities?>(null); private set
    var hasLoaded by mutableStateOf(false); private set
    var members by mutableStateOf<List<MentionMember>>(emptyList()); private set
    /** Set by a notification tap: the list scrolls there and highlights it. */
    var scrollTarget by mutableStateOf<Long?>(null)
    var highlightId by mutableStateOf<Long?>(null); private set
    /** A newer APK is published (sideloaded app: no store to update it for us). */
    var update by mutableStateOf<AndroidReleaseInfo?>(null); private set
    /** The server revoked the token or membership ended. */
    var signedOut by mutableStateOf(false); private set

    /** True while the chat is on screen: drives read marking. */
    var isVisible = false
        set(v) {
            field = v
            if (v) markReadSoon()
        }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var streamJob: Job? = null
    private var readJob: Job? = null
    private var tempSeq = 0L
    private var latestId = 0L
    private var myUserId: String? = null

    /** Names of people who spoke recently (newest first) — ranked first in autocomplete. */
    val recentAuthors: List<String>
        get() = rows.asReversed().filter { !it.message.isAuthor }.mapNotNull { it.message.authorName?.takeIf(String::isNotBlank) }.distinct()

    val lastOwnMessage: ChatMessage?
        get() = rows.lastOrNull { it.message.isAuthor && it.message.id > 0 }?.message

    /** Debug only: sample chat, sends "succeed" locally (no network). */
    var demo = false

    fun loadDemo() {
        demo = true
        fun msg(id: Long, who: String, body: String, mine: Boolean = false, reactions: List<Reaction>? = null) =
            ChatRow(ChatMessage(id, authorId = if (mine) "me" else who, authorName = if (mine) "ドリキン" else who, body = body,
                createdAt = "2026-10-16T0${id % 10}:00:00Z", isAuthor = mine, reactions = reactions))
        rows = listOf(
            msg(1, "NORIO TAKAHASHI", "おはようございます"),
            msg(2, "mazzo", "Android 版いい感じ https://bsm.backspace.fm"),
            msg(3, "ドリキン", "ありがとうございます！", mine = true, reactions = listOf(Reaction("❤️", 2, mine = true), Reaction("😂", 1))),
            msg(4, "takuto", "@ドリキン 通知も来ました"),
            msg(5, "takuto", "👍"),
        )
        members = listOf("ビーグル", "mazzo", "NORIO TAKAHASHI", "takuto", "coban", "ポンコツ散財王ドリキン").map { MentionMember(it, it) }
        capabilities = Capabilities(features = Capabilities.Features(Capabilities.ChatFeatures(send = true, editOwn = true, reactions = true, markRead = false), Capabilities.PostFeatures(read = true, publish = true, upload = true, reactions = true, maxImages = 5)))
        hasLoaded = true
        connection = Connection.LIVE
        onlineCount = 12
    }

    /** On screen (ON_START): connect. Off screen the stream is closed — pushes
     *  cover the background, and an idle socket would only drain the battery. */
    fun start() {
        if (demo || streamJob?.isActive == true) return
        streamJob = scope.launch {
            if (capabilities == null) loadCapabilities()
            if (members.isEmpty()) launch { runCatching { members = api.members() } }
            if (update == null) launch {
                runCatching { api.androidRelease() }.getOrNull()
                    ?.takeIf { it.available && it.versionCode > BuildConfig.VERSION_CODE }
                    ?.let { update = it }
            }
            launch { EmojiCatalog.load() }
            runStream()
        }
    }

    fun pause() {
        streamJob?.cancel()
        streamJob = null
        connection = Connection.CONNECTING
    }

    fun stop() {
        scope.cancel()
    }

    private suspend fun loadCapabilities() {
        try {
            capabilities = api.capabilities()
        } catch (e: ApiError.Unauthorized) {
            signedOut = true
        } catch (_: Exception) {
            // Offline at launch: the stream loop retries.
        }
    }

    /** Reconnect forever with capped backoff. Every (re)connect resyncs the list
     *  on the `ready` event, so nothing sent while disconnected is missed. */
    private suspend fun runStream() {
        var backoff = 1000L
        while (scope.isActive && !signedOut) {
            connection = Connection.CONNECTING
            try {
                LiveStream.connect(api.token).collect { ev ->
                    backoff = 1000L
                    handle(ev)
                }
            } catch (e: ApiError.Unauthorized) {
                signedOut = true
                break
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                // backoff below
            }
            if (signedOut) break
            connection = Connection.OFFLINE
            delay(backoff)
            backoff = (backoff * 2).coerceAtMost(30_000L)
        }
    }

    @Serializable private data class ChatEvent(val action: String, val message: ChatMessage? = null, val id: Long? = null)
    @Serializable private data class Presence(val userIds: List<String> = emptyList())

    private suspend fun handle(ev: ServerEvent) {
        when (ev.event) {
            "ready" -> {
                connection = Connection.LIVE
                reload()
            }
            "chat" -> {
                val e = runCatching { ApiJson.decodeFromString<ChatEvent>(ev.data) }.getOrNull() ?: return
                when (e.action) {
                    "create" -> e.message?.let(::received)
                    "edit" -> e.message?.let { m ->
                        rows = rows.map { r ->
                            if (r.message.id == m.id) r.copy(message = m.copy(reactions = r.message.reactions, clientId = r.message.clientId)) else r
                        }
                    }
                    "delete" -> e.id?.let { id -> rows = rows.filterNot { it.message.id == id } }
                }
            }
            "presence" -> runCatching { ApiJson.decodeFromString<Presence>(ev.data) }.getOrNull()?.let { onlineCount = it.userIds.size }
            "revoked" -> signedOut = true
            else -> Unit // unknown events are ignored (forward compatible)
        }
    }

    private fun received(m: ChatMessage) {
        latestId = maxOf(latestId, m.id)
        if (m.isAuthor) myUserId = m.authorId
        val alreadyShown = rows.any { it.message.id == m.id }
        rows = reconcile(rows, m)
        if (m.isAuthor || alreadyShown) return
        if (isVisible) markReadSoon() else unreadCount += 1
    }

    suspend fun reload() {
        try {
            val r = api.chat()
            latestId = maxOf(latestId, r.latestId)
            unreadCount = if (isVisible) 0 else r.unreadCount
            r.messages.firstOrNull { it.isAuthor }?.let { myUserId = it.authorId }
            // Keep rows still sending / failed; keep the stable key of rows we sent.
            val local = rows.filter { it.message.id < 0 }
            val keys = rows.associate { it.message.id to it.key }
            rows = r.messages.map { m -> ChatRow(m, key = keys[m.id] ?: (m.clientId ?: "id-${m.id}")) } + local
            hasLoaded = true
            if (isVisible) markReadSoon()
            runCatching { onlineCount = api.summary().onlineCount }
        } catch (e: ApiError.Unauthorized) {
            signedOut = true
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            connection = Connection.OFFLINE
        }
    }

    fun refresh() {
        scope.launch { reload() }
    }

    // MARK: actions

    fun send(raw: String, restore: (String) -> Unit) {
        val body = raw.trim()
        if (body.isEmpty()) return
        val clientId = UUID.randomUUID().toString()
        tempSeq += 1
        val pending = ChatMessage(
            id = -tempSeq, authorId = myUserId, body = body, createdAt = Instant.now().toString(),
            isAuthor = true, clientId = clientId, reactions = emptyList(),
        )
        rows = rows + ChatRow(pending, SendState.PENDING)
        unreadCount = 0
        post(body, clientId, restore)
    }

    fun retry(row: ChatRow) {
        val cid = row.message.clientId ?: return
        setState(SendState.PENDING, cid)
        post(row.message.body, cid) {}
    }

    fun discard(row: ChatRow) {
        rows = rows.filterNot { it.message.id < 0 && it.message.clientId == row.message.clientId }
    }

    private fun post(body: String, clientId: String, restore: (String) -> Unit) {
        if (demo) {
            val m = rows.last { it.message.clientId == clientId }.message
            rows = reconcile(rows, m.copy(id = (rows.maxOf { it.message.id }) + 1, authorName = "ドリキン"))
            return
        }
        scope.launch {
            try {
                val m = api.post(body, clientId)
                myUserId = m.authorId ?: myUserId
                latestId = maxOf(latestId, m.id)
                rows = reconcile(rows, m)
            } catch (e: ApiError) {
                if (e.isPermanent) {
                    rows = rows.filterNot { it.message.id < 0 && it.message.clientId == clientId }
                    restore(body)
                    if (e is ApiError.Unauthorized) signedOut = true
                } else {
                    setState(SendState.FAILED, clientId)
                }
            }
        }
    }

    private fun setState(s: SendState, clientId: String) {
        rows = rows.map { if (it.message.id < 0 && it.message.clientId == clientId) it.copy(state = s) else it }
    }

    fun edit(id: Long, body: String) {
        val text = body.trim()
        val old = rows.firstOrNull { it.message.id == id }?.message ?: return
        if (text.isEmpty()) return
        rows = rows.map { if (it.message.id == id) it.copy(message = it.message.copy(body = text, edited = true)) else it }
        if (demo) return
        scope.launch {
            try {
                val m = api.edit(id, text)
                rows = rows.map { if (it.message.id == id) it.copy(message = it.message.copy(body = m.body, edited = m.edited)) else it }
            } catch (_: ApiError) {
                rows = rows.map { if (it.message.id == id) it.copy(message = old) else it }
            }
        }
    }

    fun toggleReaction(id: Long, emoji: String) {
        val old = rows.firstOrNull { it.message.id == id }?.message?.reactions ?: emptyList()
        rows = rows.map { if (it.message.id == id) it.copy(message = it.message.copy(reactions = toggled(old, emoji))) else it }
        if (demo) return
        scope.launch {
            try {
                val r = api.toggleReaction(id, emoji)
                rows = rows.map { if (it.message.id == id) it.copy(message = it.message.copy(reactions = r.reactions)) else it }
            } catch (_: ApiError) {
                rows = rows.map { if (it.message.id == id) it.copy(message = it.message.copy(reactions = old)) else it }
            }
        }
    }

    /** Jump to a message (from a notification tap) and highlight it briefly. */
    fun reveal(id: Long) {
        highlightId = id
        scrollTarget = id
        scope.launch {
            delay(1600)
            if (highlightId == id) highlightId = null
        }
    }

    private fun markReadSoon() {
        unreadCount = 0
        if (capabilities?.canMarkRead == false || latestId <= 0) return
        readJob?.cancel()
        readJob = scope.launch {
            delay(800)
            runCatching { api.markRead(latestId) }
        }
    }

    companion object {
        /** Same rule as reconcileChat in src/lib/chat-optimistic.ts: a pending row is
         *  replaced only by the same author's stored message with its clientId. */
        fun reconcile(rows: List<ChatRow>, m: ChatMessage): List<ChatRow> {
            fun isTwin(r: ChatRow) = r.message.id < 0 && m.clientId != null && r.message.clientId == m.clientId && m.isAuthor
            if (rows.any { it.message.id == m.id }) {
                return rows.filterNot(::isTwin).map {
                    if (it.message.id == m.id) it.copy(message = m.copy(reactions = m.reactions ?: it.message.reactions), state = SendState.SENT) else it
                }
            }
            val i = rows.indexOfFirst(::isTwin)
            if (i >= 0) return rows.toMutableList().also { it[i] = it[i].copy(message = m, state = SendState.SENT) }
            return rows + ChatRow(m)
        }

        fun toggled(list: List<Reaction>, emoji: String): List<Reaction> {
            val i = list.indexOfFirst { it.emoji == emoji }
            if (i < 0) return list + Reaction(emoji, 1, mine = true)
            val r = list[i]
            val next = if (r.mine) r.copy(count = r.count - 1, mine = false) else r.copy(count = r.count + 1, mine = true)
            return list.toMutableList().also { if (next.count <= 0) it.removeAt(i) else it[i] = next }
        }
    }
}
