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
import kotlinx.coroutines.launch
import kotlinx.serialization.Serializable
import java.time.Instant
import java.util.UUID

// MARK: wire (src/lib/dm.ts)

/** The other person of a conversation (`user_id` is the chat's `author_id`). */
@androidx.compose.runtime.Immutable
@Serializable
data class DMPeer(val userId: String, val name: String? = null, val avatar: String? = null) {
    val displayName: String get() = name?.trim()?.takeIf { it.isNotEmpty() } ?: "会員"
}

/** Mirrors `DmMessageDto`. `peerId` = the other party from the viewer's side. */
@androidx.compose.runtime.Immutable
@Serializable
data class DMMessage(
    val id: Long,
    val fromId: String = "",
    val toId: String = "",
    val peerId: String = "",
    val body: String,
    val createdAt: String = "",
    val isAuthor: Boolean = false,
    val clientId: String? = null,
)

@Serializable data class DMConversation(val peer: DMPeer, val lastMessage: DMMessage, val unreadCount: Int = 0)
@Serializable data class DMListResponse(val conversations: List<DMConversation> = emptyList(), val unreadCount: Int = 0)
@Serializable data class DMThreadResponse(
    val peer: DMPeer? = null,
    val messages: List<DMMessage> = emptyList(),
    val unreadCount: Int = 0,
    val lastReadId: Long = 0,
    val canSend: Boolean = true,
)
@Serializable data class DMSendResponse(val message: DMMessage)
@Serializable data class DMReadResponse(val unreadCount: Int = 0)
@Serializable data class DMMessageResponse(val message: DMMessage, val peer: DMPeer? = null)

/** The stream's `dm` event: `create` (a DM to me, or mine from another device) or `read`
 *  (my read mark from another device). */
@Serializable data class DMEvent(
    val action: String,
    val message: DMMessage? = null,
    val peer: DMPeer? = null,
    val peerId: String? = null,
    val lastReadId: Long? = null,
    val unreadCount: Int? = null,
)

@Serializable data class DMReadyUnread(val unreadCount: Int? = null)
/** The `ready` event's `dm` part (servers with DM). */
@Serializable data class DMReadyEvent(val dm: DMReadyUnread? = null)

/** A bubble in a conversation. `key` stays the same across the pending → stored swap. */
@androidx.compose.runtime.Immutable
data class DMRow(
    val message: DMMessage,
    val state: SendState = SendState.SENT,
    val key: String = message.clientId ?: "dm-${message.id}",
)

// MARK: pure rules (unit-tested: DMLogicTest)

object DMLogic {
    const val NOTIFY_TEXT_MAX = 240

    /** Same rule as the chat (ChatStore.reconcile): my pending bubble is replaced in place by the
     *  stored message carrying its clientId; a message already shown is updated; else appended. */
    fun reconcile(rows: List<DMRow>, m: DMMessage): List<DMRow> {
        fun isTwin(r: DMRow) = r.message.id < 0 && m.clientId != null && r.message.clientId == m.clientId && m.isAuthor
        if (rows.any { it.message.id == m.id }) {
            return rows.filterNot(::isTwin).map { if (it.message.id == m.id) it.copy(message = m, state = SendState.SENT) else it }
        }
        val i = rows.indexOfFirst(::isTwin)
        if (i >= 0) return rows.toMutableList().also { it[i] = it[i].copy(message = m, state = SendState.SENT) }
        return rows + DMRow(m)
    }

    /** Still within the TTL (24 h). An unparseable time is kept (the server sweeps anyway). */
    fun isFresh(createdAt: String, now: Instant, ttlHours: Int): Boolean {
        val t = runCatching { Instant.parse(createdAt) }.getOrNull() ?: return true
        return t.isAfter(now.minusSeconds(ttlHours * 3600L))
    }

    /** Hide what is past the TTL locally too; my bubbles still sending / failed always stay. */
    fun fresh(rows: List<DMRow>, now: Instant, ttlHours: Int): List<DMRow> =
        rows.filter { it.message.id < 0 || isFresh(it.message.createdAt, now, ttlHours) }

    fun freshConversations(list: List<DMConversation>, now: Instant, ttlHours: Int): List<DMConversation> =
        list.filter { isFresh(it.lastMessage.createdAt, now, ttlHours) }

    /** A new DM (either direction) moves its conversation to the top. `viewing` = that conversation
     *  is on screen (it is read at once, so its unread count stays 0). */
    fun upsert(list: List<DMConversation>, peer: DMPeer?, m: DMMessage, viewing: Boolean): List<DMConversation> {
        val peerId = m.peerId.ifEmpty { peer?.userId ?: return list }
        val old = list.firstOrNull { it.peer.userId == peerId }
        if (old != null && old.lastMessage.id >= m.id && m.id > 0) return list
        // Sending marks the conversation read up to it (the server does the same).
        val unread = if (viewing || m.isAuthor) 0 else (old?.unreadCount ?: 0) + 1
        val p = peer?.takeIf { it.userId == peerId } ?: old?.peer ?: DMPeer(peerId)
        return listOf(DMConversation(p, m, unread)) + list.filterNot { it.peer.userId == peerId }
    }

    /** My read mark (here or on another device): that conversation has nothing unread up to it. */
    fun markRead(list: List<DMConversation>, peerId: String, lastReadId: Long): List<DMConversation> =
        list.map { if (it.peer.userId == peerId && it.lastMessage.id <= lastReadId) it.copy(unreadCount = 0) else it }

    /** The id to send as `last_read_id`: the newest stored message on screen (0 = nothing). */
    fun latestStoredId(rows: List<DMRow>): Long = rows.maxOfOrNull { it.message.id }?.coerceAtLeast(0) ?: 0

    /** The total when the server did not say: the conversations' own counts. */
    fun totalUnread(list: List<DMConversation>): Int = list.sumOf { it.unreadCount }

    /** Notification texts — the same as the server's dmNotificationText (iPhone shows the same). */
    fun notificationTitle(name: String?): String = "${name?.trim()?.takeIf { it.isNotEmpty() } ?: "会員"}さんからの DM"
    fun notificationText(body: String): String = if (body.length > NOTIFY_TEXT_MAX) body.take(NOTIFY_TEXT_MAX) + "…" else body
    const val FALLBACK_TITLE = "B-guru DM"
    const val FALLBACK_TEXT = "DM が届きました"

    /** One notification per peer (a later DM from the same person replaces it). */
    fun notificationId(peerId: String): Int = 5_000_000 + (peerId.hashCode() and 0x7fffffff) % 1_000_000

    /** The list's last-message line: one line, mine marked. */
    fun preview(m: DMMessage): String {
        val t = m.body.replace('\n', ' ').trim()
        return if (m.isAuthor) "あなた: $t" else t
    }
}

/** ✉️ 簡易 DM: the conversation list, the open conversation and the unread total. Main thread only.
 *  Sending is optimistic like the chat: the bubble shows at once and the stored message (the POST's
 *  reply or the stream's create, whichever lands first) replaces it by clientId. */
class DMStore(private val api: ApiClient) {
    sealed interface Route {
        data object Inbox : Route
        data class Conversation(val peer: DMPeer) : Route
    }

    var enabled by mutableStateOf(false); private set
    var canSendCap by mutableStateOf(false); private set
    var maxBody by mutableIntStateOf(1000); private set
    var ttlHours by mutableIntStateOf(24); private set
    private var base = "/api/agent/dm"

    var conversations by mutableStateOf<List<DMConversation>>(emptyList()); private set
    var unreadTotal by mutableIntStateOf(0); private set
    var listLoaded by mutableStateOf(false); private set

    /** What is on screen above the chat (empty: nothing DM). Back pops one. */
    var stack by mutableStateOf<List<Route>>(emptyList()); private set
    val route: Route? get() = stack.lastOrNull()
    val openPeer: DMPeer? get() = (route as? Route.Conversation)?.peer

    var rows by mutableStateOf<List<DMRow>>(emptyList()); private set
    var threadLoaded by mutableStateOf(false); private set
    var canSendHere by mutableStateOf(true); private set
    /** Why the last send / load was refused (the server's own words). */
    var error by mutableStateOf<String?>(null)

    /** The peer whose conversation is on screen right now (resumed): read marking and pushes. */
    @Volatile var visiblePeerId: String? = null
        private set
    private var screenVisible = false

    var demo = false
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var readJob: Job? = null
    private var threadJob: Job? = null
    private var tempSeq = 0L
    private var lastReadSent = 0L

    fun configure(caps: Capabilities) {
        enabled = caps.dmEnabled
        canSendCap = caps.canSendDM
        maxBody = caps.dmMaxBody
        ttlHours = caps.dmTtlHours
        base = caps.dmPath
        if (!enabled) { stack = emptyList(); return }
        refreshList()
    }

    fun close() { scope.cancel() }

    // MARK: navigation

    fun openList() {
        if (!enabled) return
        stack = listOf(Route.Inbox)
        refreshList()
    }

    fun openConversation(peer: DMPeer) {
        if (!enabled || peer.userId.isBlank()) return
        val known = conversations.firstOrNull { it.peer.userId == peer.userId }?.peer
        val p = if (peer.name == null && known != null) known else peer
        val current = openPeer
        if (current?.userId == p.userId) return
        // From the list: back goes to it; from the chat or a notification: back closes.
        stack = (if (route == Route.Inbox) listOf(Route.Inbox) else emptyList()) + Route.Conversation(p)
        rows = emptyList()
        threadLoaded = false
        canSendHere = true
        error = null
        lastReadSent = 0
        loadThread(p.userId)
    }

    fun back() {
        val s = stack
        if (s.isEmpty()) return
        stack = s.dropLast(1)
        if (stack.lastOrNull() == Route.Inbox) refreshList()
    }

    fun closeAll() { stack = emptyList() }

    /** DMScreen tells whether the conversation is really on screen (resumed). */
    fun setScreenVisible(peerId: String?, visible: Boolean) {
        screenVisible = visible
        visiblePeerId = if (visible) peerId else null
        if (visible && peerId != null) markReadSoon(peerId)
    }

    // MARK: loading

    fun refreshList() {
        if (demo || !enabled) return
        scope.launch {
            runCatching { api.dmConversations(base) }.onSuccess { r ->
                conversations = DMLogic.freshConversations(r.conversations, Instant.now(), ttlHours)
                unreadTotal = r.unreadCount
                listLoaded = true
            }
        }
    }

    private fun loadThread(peerId: String) {
        threadJob?.cancel()
        if (demo) {
            rows = DMLogic.fresh(demoThreads[peerId].orEmpty().map { DMRow(it) }, Instant.now(), ttlHours)
            threadLoaded = true
            return
        }
        threadJob = scope.launch {
            try {
                val r = api.dmThread(peerId, base)
                if (openPeer?.userId != peerId) return@launch
                val local = rows.filter { it.message.id < 0 }
                var next = r.messages.map { DMRow(it) }
                local.forEach { l -> if (next.none { it.message.clientId != null && it.message.clientId == l.message.clientId }) next = next + l }
                rows = DMLogic.fresh(next, Instant.now(), ttlHours)
                canSendHere = r.canSend
                r.peer?.let { p -> stack = stack.map { if (it is Route.Conversation && it.peer.userId == p.userId) Route.Conversation(p) else it } }
                threadLoaded = true
                if (visiblePeerId == peerId) markReadSoon(peerId)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: ApiError.Http) {
                error = e.serverMessage ?: "読み込めませんでした"
                if (e.status == 403) canSendHere = false
                threadLoaded = true
            } catch (_: Exception) {
                error = "読み込めませんでした"
                threadLoaded = true
            }
        }
    }

    /** Hide what passed the TTL while the screen stays open (DMScreen calls it every minute). */
    fun prune() {
        val now = Instant.now()
        rows = DMLogic.fresh(rows, now, ttlHours)
        conversations = DMLogic.freshConversations(conversations, now, ttlHours)
    }

    // MARK: stream

    /** `ready` (every (re)connect): the server's unread total, and a resync of what is open. */
    fun onReady(data: String) {
        if (!enabled) return
        runCatching { ApiJson.decodeFromString<DMReadyEvent>(data) }.getOrNull()?.dm?.unreadCount?.let { unreadTotal = it }
        if (route != null) refreshList()
        openPeer?.let { loadThread(it.userId) }
    }

    fun apply(data: String) {
        if (!enabled) return
        val e = runCatching { ApiJson.decodeFromString<DMEvent>(data) }.getOrNull() ?: return
        when (e.action) {
            "create" -> e.message?.let { received(it, e.peer, e.unreadCount) }
            "read" -> {
                val peerId = e.peerId ?: return
                conversations = DMLogic.markRead(conversations, peerId, e.lastReadId ?: 0)
                e.unreadCount?.let { unreadTotal = it }
            }
        }
    }

    private fun received(m: DMMessage, peer: DMPeer?, total: Int?) {
        val peerId = m.peerId.ifEmpty { peer?.userId ?: return }
        val viewing = visiblePeerId == peerId
        val wasNew = conversations.firstOrNull { it.peer.userId == peerId }?.lastMessage?.id?.let { it < m.id } ?: true
        conversations = DMLogic.upsert(conversations, peer, m, viewing)
        if (openPeer?.userId == peerId) rows = DMLogic.reconcile(rows, m)
        when {
            total != null && !viewing -> unreadTotal = total
            !m.isAuthor && !viewing && wasNew -> unreadTotal += 1
        }
        if (viewing && !m.isAuthor) markReadSoon(peerId)
    }

    // MARK: sending

    fun send(raw: String, restore: (String) -> Unit) {
        val peer = openPeer ?: return
        val body = raw.trim().take(maxBody)
        if (body.isEmpty() || !canSendCap || !canSendHere) return
        val clientId = UUID.randomUUID().toString()
        tempSeq += 1
        val pending = DMMessage(id = -tempSeq, peerId = peer.userId, toId = peer.userId, body = body,
            createdAt = Instant.now().toString(), isAuthor = true, clientId = clientId)
        error = null
        rows = rows + DMRow(pending, SendState.PENDING)
        post(peer, pending, restore)
    }

    fun retry(row: DMRow) {
        val peer = openPeer ?: return
        if (row.message.id >= 0) return
        setState(row.message.clientId, SendState.PENDING)
        post(peer, row.message) { }
    }

    fun discard(row: DMRow) {
        rows = rows.filterNot { it.message.id < 0 && it.message.clientId == row.message.clientId }
    }

    private fun post(peer: DMPeer, pending: DMMessage, restore: (String) -> Unit) {
        val clientId = pending.clientId ?: return
        if (demo) {
            val stored = pending.copy(id = (demoThreads.values.flatten().maxOfOrNull { it.id } ?: 0L) + rows.size + 1, fromId = "me")
            demoThreads[peer.userId] = demoThreads[peer.userId].orEmpty() + stored
            rows = DMLogic.reconcile(rows, stored)
            conversations = DMLogic.upsert(conversations, peer, stored, viewing = true)
            return
        }
        scope.launch {
            try {
                val m = api.dmSend(peer.userId, pending.body, clientId, base)
                if (openPeer?.userId == peer.userId) rows = DMLogic.reconcile(rows, m)
                conversations = DMLogic.upsert(conversations, peer, m, viewing = true)
            } catch (e: ApiError) {
                if (e is ApiError.Http && e.serverMessage != null) error = e.serverMessage
                if (e.isPermanent) {
                    rows = rows.filterNot { it.message.id < 0 && it.message.clientId == clientId }
                    if (e is ApiError.Http && e.status == 403) canSendHere = false
                    restore(pending.body)
                } else {
                    setState(clientId, SendState.FAILED)
                }
            }
        }
    }

    private fun setState(clientId: String?, s: SendState) {
        rows = rows.map { if (it.message.id < 0 && it.message.clientId == clientId) it.copy(state = s) else it }
    }

    // MARK: read

    private fun markReadSoon(peerId: String) {
        if (openPeer?.userId != peerId) return
        val upTo = DMLogic.latestStoredId(rows)
        val before = conversations.firstOrNull { it.peer.userId == peerId }?.unreadCount ?: 0
        conversations = DMLogic.markRead(conversations, peerId, Long.MAX_VALUE)
        unreadTotal = (unreadTotal - before).coerceAtLeast(0)
        if (demo || upTo <= 0 || upTo <= lastReadSent) return
        readJob?.cancel()
        readJob = scope.launch {
            delay(600)
            runCatching { api.dmMarkRead(peerId, upTo, base) }.onSuccess { total ->
                lastReadSent = upTo
                unreadTotal = total
            }
        }
    }

    // MARK: demo

    private val demoThreads = HashMap<String, List<DMMessage>>()

    /** Debug only: sample conversations among the demo chat's people (one unread), offline. */
    fun loadDemo() {
        demo = true
        enabled = true
        canSendCap = true
        val now = Instant.now()
        fun at(minAgo: Long) = now.minusSeconds(minAgo * 60).toString()
        var id = 0L
        fun m(peer: String, mine: Boolean, body: String, minAgo: Long) = DMMessage(++id,
            fromId = if (mine) "me" else peer, toId = if (mine) peer else "me", peerId = peer, body = body, createdAt = at(minAgo), isAuthor = mine)
        demoThreads["mazzo"] = listOf(
            m("mazzo", false, "さっきの将棋、いい勝負でしたね", 95),
            m("mazzo", true, "ありがとうございます！次は負けません", 90),
            m("mazzo", false, "Android 版の DM、試してます。届いてますか？", 6),
            m("mazzo", false, "24 時間で消えるのはいいですね", 5),
        )
        demoThreads["takuto"] = listOf(
            m("takuto", false, "通知の件、ありがとうございました", 300),
            m("takuto", true, "いえいえ、また何かあれば DM ください", 280),
        )
        demoThreads["NORIO TAKAHASHI"] = listOf(
            m("NORIO TAKAHASHI", true, "おはようございます。今日の配信、何時からでしたっけ？", 20 * 60),
            m("NORIO TAKAHASHI", false, "21 時からです！", 19 * 60),
            // Past 24 h: hidden here too.
            m("NORIO TAKAHASHI", false, "（これは 25 時間前なので見えないはず）", 25 * 60),
        )
        val peers = mapOf("mazzo" to 2, "takuto" to 0, "NORIO TAKAHASHI" to 0)
        conversations = DMLogic.freshConversations(peers.mapNotNull { (p, unread) ->
            val last = DMLogic.fresh(demoThreads[p].orEmpty().map { DMRow(it) }, now, ttlHours).lastOrNull()?.message ?: return@mapNotNull null
            DMConversation(DMPeer(p, p), last, unread)
        }.sortedByDescending { it.lastMessage.createdAt }, now, ttlHours)
        unreadTotal = DMLogic.totalUnread(conversations)
        listLoaded = true
    }
}
