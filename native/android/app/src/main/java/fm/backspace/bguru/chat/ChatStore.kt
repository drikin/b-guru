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
class ChatStore(val api: ApiClient, app: android.content.Context) {
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
    /** Why the last send was refused (e.g. a photo the server would not take). */
    var sendError by mutableStateOf<String?>(null)

    /** The voice room. Lives as long as the sign-in, so a call survives the chat
     *  leaving the screen (the stream pauses; LiveKit has its own connection). */
    val voice = VoiceStore(api, app)
    /** The club room (ルーム) — only when the server turns it on for this member. */
    val room = RoomStore(api, voice)
    private val voiceApp = app.applicationContext

    /** True while the chat is on screen: drives read marking. */
    var isVisible = false
        set(v) {
            val was = field
            field = v
            if (v && !was) beginViewing()
            if (v) markReadSoon()
        }

    /** The first message the member had not read when the chat came on screen (drawn
     *  as a "ここから未読" line). The list opens there instead of jumping to the bottom;
     *  nothing new: it stays, and the list stays where they were (drikin 2026-10-19). */
    var unreadMarkerId by mutableStateOf<Long?>(null); private set
    /** Bumped each time the chat comes on screen with something to open at. */
    var openSeq by mutableIntStateOf(0); private set
    /** Last message read here or on another device (the server's cursor). */
    private var readCursor: Long? = null
    /** Came on screen moments ago and found nothing unread yet: the list that the
     *  reconnect brings (coming back from the background) may still have some. */
    private var openPendingSince: Long? = null

    private fun beginViewing() {
        openPendingSince = System.currentTimeMillis() // the old line stays until something new is unread
        findUnreadMarker()
    }

    private fun findUnreadMarker() {
        val since = openPendingSince ?: return
        if (System.currentTimeMillis() - since > 15_000) { openPendingSince = null; return }
        val cursor = readCursor
        if (!hasLoaded || cursor == null) return
        val first = rows.firstOrNull { r ->
            r.message.id > cursor && r.message.id > 0 && !r.message.isAuthor && !r.message.isNotice
        } ?: return
        unreadMarkerId = first.message.id
        openPendingSince = null
        openSeq += 1
    }

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var streamJob: Job? = null
    private var readJob: Job? = null
    private var tempSeq = 0L
    private var latestId = 0L
    private var myUserId: String? = null

    /** What a pending message still has to send, by clientId. Memory only: the JPEGs
     *  stay until the post lands (or is discarded), so 再送 can re-upload them; `urls`
     *  is set once the upload succeeded, so a retry after that only re-posts. */
    private class Outgoing(val body: String, val photos: List<ChatPhoto>, var urls: List<String>? = null)
    private val outbox = HashMap<String, Outgoing>()

    /** Names of people who spoke recently (newest first) — ranked first in autocomplete. */
    val recentAuthors: List<String>
        get() = rows.asReversed().filter { !it.message.isAuthor }.mapNotNull { it.message.authorName?.takeIf(String::isNotBlank) }.distinct()

    val lastOwnMessage: ChatMessage?
        get() = rows.lastOrNull { it.message.isAuthor && it.message.id > 0 }?.message

    /** Debug only: sample chat, sends "succeed" locally (no network). */
    var demo = false

    fun loadDemo(scale: Boolean = false, images: String? = null) {
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
        ) + (if (!scale) emptyList() else (6L..300L).map { i ->
            val who = listOf("mazzo", "takuto", "NORIO TAKAHASHI", "coban", "ちい")[(i % 5).toInt()]
            msg(i, who, when (i % 4) {
                0L -> "@ドリキン これ見ました？ https://bsm.backspace.fm/#/post/$i"
                1L -> "なるほど、それはいいですね。ボイスルームも試してみます $i"
                2L -> "😂"
                else -> "今日は長めのメッセージを書いてみます。スクロールが重くならないか確認するためのテキストで、改行もなく続きます。$i"
            }, mine = i % 7 == 0L, reactions = if (i % 3 == 0L) listOf(Reaction("❤️", 2), Reaction("👍", 1, mine = true)) else null)
        }) + demoPhotos(images)
        members = listOf("ビーグル", "mazzo", "NORIO TAKAHASHI", "takuto", "coban", "ポンコツ散財王ドリキン").map { MentionMember(it, it) }
        capabilities = Capabilities(features = Capabilities.Features(
            Capabilities.ChatFeatures(send = true, editOwn = true, reactions = true, markRead = false, images = true, maxImages = 4),
            Capabilities.PostFeatures(read = true, publish = true, upload = true, reactions = true, maxImages = 5),
            room = Capabilities.RoomFeatures(enabled = true),
        ))
        // A local fake room: its people talk in the chat too (bubbles come from these rows).
        room.loadDemo { id, name, text ->
            val next = (rows.maxOfOrNull { it.message.id } ?: 0L) + 1
            val m = ChatMessage(next, authorId = id, authorName = name, body = text, createdAt = Instant.now().toString())
            rows = rows + ChatRow(m)
            room.onChat(m)
        }
        hasLoaded = true
        connection = Connection.LIVE
        onlineCount = 12
        // The big demo opens at a "ここから未読" line (read up to #250).
        if (scale) readCursor = 250
        latestId = rows.maxOf { it.message.id }
    }

    /** Photo messages for the demo, served from this Mac (`--es demo_images`); none without it. */
    private fun demoPhotos(base: String?): List<ChatRow> = if (base == null) emptyList() else listOf(
        ChatRow(ChatMessage(301, authorId = "mazzo", authorName = "mazzo", body = "今朝の散歩コース", createdAt = "2026-10-16T06:10:00Z",
            images = listOf("$base/photo1.jpg"), reactions = listOf(Reaction("❤️", 1)))),
        ChatRow(ChatMessage(302, authorId = "takuto", authorName = "takuto", body = ChatMessage.PHOTO_PLACEHOLDER, createdAt = "2026-10-16T06:12:00Z",
            images = listOf("$base/photo2.jpg", "$base/photo3.jpg", "$base/photo4.jpg"))),
    )

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
        room.close()
        voice.close()
        scope.cancel()
    }

    private suspend fun loadCapabilities() {
        try {
            val caps = api.capabilities()
            capabilities = caps
            voice.configure(caps)
            room.configure(caps)
            // Voice is on for me but this token predates the "voice" scope: send the member
            // back to sign in once (a new sign-in gets the scope). Only once per install,
            // so a server that still withholds it cannot loop us.
            if (caps.voiceEnabled && !caps.canJoinVoice && !LoginNotice.voiceReloginAsked(voiceApp)) {
                LoginNotice.markVoiceReloginAsked(voiceApp)
                LoginNotice.message = "ボイスルームに対応しました。お手数ですが、一度ログインし直してください。"
                signedOut = true
            }
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

    @Serializable private data class ChatEvent(val action: String, val message: ChatMessage? = null, val id: Long? = null, val reactions: List<Reaction>? = null)
    @Serializable private data class Presence(val userIds: List<String> = emptyList())

    private suspend fun handle(ev: ServerEvent) {
        when (ev.event) {
            "ready" -> {
                connection = Connection.LIVE
                if (voice.enabled) scope.launch { voice.loadState() } // resync after a reconnect
                if (room.enabled) scope.launch { room.reload() }
                reload()
            }
            "room" -> room.apply(ev.data)
            "voice" -> runCatching { ApiJson.decodeFromString<VoiceRoomInfo>(ev.data) }.getOrNull()?.let(voice::apply)
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
                    // Someone (or you, elsewhere) reacted: update the chips at once.
                    "reactions" -> e.id?.let { id ->
                        rows = rows.map { if (it.message.id == id) it.copy(message = it.message.copy(reactions = e.reactions ?: emptyList())) else it }
                    }
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
        // A quiet note (room comings and goings): in the list, but no bubble, never unread.
        if (!alreadyShown && !m.isNotice) room.onChat(m)
        if (m.isAuthor || alreadyShown || m.isNotice) return
        if (isVisible) markReadSoon() else unreadCount += 1
    }

    suspend fun reload() {
        try {
            val r = api.chat()
            latestId = maxOf(latestId, r.latestId)
            r.lastReadId?.let { c -> readCursor = maxOf(readCursor ?: 0L, c) }
            unreadCount = if (isVisible) 0 else r.unreadCount
            r.messages.firstOrNull { it.isAuthor }?.let { myUserId = it.authorId }
            // Keep rows still sending / failed; keep the stable key of rows we sent.
            val local = rows.filter { it.message.id < 0 }
            val keys = rows.associate { it.message.id to it.key }
            val previews = rows.filter { it.localImages.isNotEmpty() }.associate { it.message.id to it.localImages }
            rows = r.messages.map { m ->
                ChatRow(m, key = keys[m.id] ?: (m.clientId ?: "id-${m.id}"), localImages = previews[m.id] ?: emptyList())
            } + local
            hasLoaded = true
            if (isVisible) {
                findUnreadMarker()
                openPendingSince = null
                markReadSoon()
            }
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

    /** Text and/or photos. The bubble (with the local previews) shows at once; the
     *  photos upload first, then the message posts with their URLs. */
    fun send(raw: String, photos: List<ChatPhoto> = emptyList(), restore: (String, List<ChatPhoto>) -> Unit) {
        val body = raw.trim()
        if (body.isEmpty() && photos.isEmpty()) return
        val clientId = UUID.randomUUID().toString()
        tempSeq += 1
        val pending = ChatMessage(
            id = -tempSeq, authorId = myUserId, body = body, createdAt = Instant.now().toString(),
            isAuthor = true, clientId = clientId, reactions = emptyList(),
        )
        outbox[clientId] = Outgoing(body, photos)
        sendError = null
        rows = rows + ChatRow(pending, SendState.PENDING, localImages = photos.map { it.preview })
        unreadCount = 0
        post(clientId, restore)
    }

    fun retry(row: ChatRow) {
        val cid = row.message.clientId ?: return
        if (cid !in outbox) outbox[cid] = Outgoing(row.message.body, emptyList())
        setState(SendState.PENDING, cid)
        post(cid) { _, _ -> }
    }

    fun discard(row: ChatRow) {
        row.message.clientId?.let(outbox::remove)
        rows = rows.filterNot { it.message.id < 0 && it.message.clientId == row.message.clientId }
    }

    private fun post(clientId: String, restore: (String, List<ChatPhoto>) -> Unit) {
        val out = outbox[clientId] ?: return
        if (demo) {
            outbox.remove(clientId)
            val m = rows.last { it.message.clientId == clientId }.message
            val stored = m.copy(id = (rows.maxOf { it.message.id }) + 1, authorName = "ドリキン", authorId = m.authorId ?: "me")
            rows = reconcile(rows, stored)
            room.onChat(stored)
            return
        }
        scope.launch {
            try {
                val urls = out.urls ?: if (out.photos.isEmpty()) emptyList() else
                    api.uploadChatImages(out.photos.map { it.jpeg }, capabilities?.chatImageUpload ?: "/api/agent/chat/upload")
                        .also { out.urls = it }
                val m = api.post(out.body, clientId, urls)
                outbox.remove(clientId)
                myUserId = m.authorId ?: myUserId
                latestId = maxOf(latestId, m.id)
                val shown = rows.any { it.message.id == m.id }
                rows = reconcile(rows, m)
                if (!shown) room.onChat(m)
            } catch (e: ApiError) {
                if (e.isPermanent) {
                    outbox.remove(clientId)
                    rows = rows.filterNot { it.message.id < 0 && it.message.clientId == clientId }
                    if (e is ApiError.Http && e.serverMessage != null) sendError = e.serverMessage
                    restore(out.body, out.photos)
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
        readCursor?.let { readCursor = maxOf(it, latestId) }
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
