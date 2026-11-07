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

/*
 * 👥 グループ DM (docs/group-dm-spec.md): 3 人以上で話せる DM。1 対 1 の ✉️ DM（DMStore）の横に置き、
 * 一覧は DM の一覧に混ぜる。決まりは 1 対 1 と同じ（30 日で消える・文字だけ・ブロック／通報なし）。
 */

// MARK: wire (src/lib/gdm.ts)

/** A member (`user_id` is the chat's `author_id`). `isMe` = the viewer. */
@androidx.compose.runtime.Immutable
@Serializable
data class GMember(
    val userId: String,
    val name: String? = null,
    val avatar: String? = null,
    val isCreator: Boolean = false,
    val isMe: Boolean = false,
) {
    val displayName: String get() = name?.trim()?.takeIf { it.isNotEmpty() } ?: "会員"
}

/** Mirrors `Group`. `title` = the name, or the other members' names (the server words it). */
@androidx.compose.runtime.Immutable
@Serializable
data class GDMGroup(
    val id: Long,
    val name: String? = null,
    val title: String = "",
    val members: List<GMember> = emptyList(),
    val memberCount: Int = 0,
    val isCreator: Boolean = false,
    val muted: Boolean = false,
    val createdAt: String = "",
    /** `/api/gdm/:gid/photo?v=…` (members only: read with the token), or null. Last, so positional calls stay. */
    val photo: String? = null,
    /** 🐶 members' @ビーグル gets an answer here (any member turns it on/off; off by default). */
    val beagle: Boolean = false,
) {
    val displayTitle: String get() = title.trim().ifEmpty { name?.trim()?.takeIf { it.isNotEmpty() } ?: "グループ" }
    val count: Int get() = if (memberCount > 0) memberCount else members.size
}

/** Mirrors `GMessage`. `kind` "system" = a line the server wrote (入った・抜けた…): no sender. */
@androidx.compose.runtime.Immutable
@Serializable
data class GMessage(
    val id: Long,
    val groupId: Long = 0,
    val kind: String = "text",
    val fromId: String? = null,
    val fromName: String? = null,
    val fromAvatar: String? = null,
    val body: String,
    val createdAt: String = "",
    val isAuthor: Boolean = false,
    val clientId: String? = null,
    /** 🐶 Beagle's answer (kind stays "text"). */
    val isBeagle: Boolean = false,
) {
    val isSystem: Boolean get() = kind == "system"
    val senderName: String get() = fromName?.trim()?.takeIf { it.isNotEmpty() } ?: "会員"
}

@Serializable data class GroupSummary(val group: GDMGroup, val lastMessage: GMessage? = null, val unreadCount: Int = 0)
@Serializable data class GDMListResponse(val groups: List<GroupSummary> = emptyList(), val groupUnreadCount: Int = 0)
@Serializable data class GDMGroupResponse(val group: GDMGroup)
@Serializable data class GDMThreadResponse(
    val group: GDMGroup? = null,
    val messages: List<GMessage> = emptyList(),
    val unreadCount: Int = 0,
    val lastReadId: Long = 0,
    val canSend: Boolean = true,
)
@Serializable data class GDMSendResponse(val message: GMessage)
@Serializable data class GDMReadResponse(val unreadCount: Int = 0, val groupUnreadCount: Int? = null)
@Serializable data class GDMMessageResponse(val message: GMessage, val group: GDMGroup? = null)

/** The stream's `gdm` event: create / read / group / removed. */
@Serializable data class GDMEvent(
    val action: String,
    val message: GMessage? = null,
    val groupId: Long? = null,
    val group: GDMGroup? = null,
    val lastReadId: Long? = null,
    val unreadCount: Int? = null,
    val groupUnreadCount: Int? = null,
)

/** A bubble / system line in a group. `key` stays the same across the pending → stored swap. */
@androidx.compose.runtime.Immutable
data class GRow(
    val message: GMessage,
    val state: SendState = SendState.SENT,
    val key: String = message.clientId ?: "gdm-${message.id}",
)

/** One line of the DM list: a 1 対 1 conversation or a group, newest first. */
@androidx.compose.runtime.Immutable
sealed interface DMInboxItem {
    val key: String
    val at: Instant
    data class One(val c: DMConversation, override val at: Instant) : DMInboxItem { override val key get() = "dm-${c.peer.userId}" }
    data class Group(val s: GroupSummary, override val at: Instant) : DMInboxItem { override val key get() = "gdm-${s.group.id}" }
}

// MARK: pure rules (unit-tested: GDMLogicTest)

object GDMLogic {
    const val NOTIFY_TEXT_MAX = DMLogic.NOTIFY_TEXT_MAX
    const val FALLBACK_TITLE = "B-guru グループ DM"
    const val FALLBACK_TEXT = "グループ DM が届きました"
    /** Lines one group's notification keeps (the newest last). */
    const val NOTIFY_LINES = 5
    /** The system account (@ビーグル): never a group member. */
    const val BEAGLE_NAME = "ビーグル"

    /** Same as the 1 対 1: my pending bubble is replaced in place by the stored one carrying its clientId. */
    fun reconcile(rows: List<GRow>, m: GMessage): List<GRow> {
        fun isTwin(r: GRow) = r.message.id < 0 && m.clientId != null && r.message.clientId == m.clientId && m.isAuthor
        if (rows.any { it.message.id == m.id }) {
            return rows.filterNot(::isTwin).map { if (it.message.id == m.id) it.copy(message = m, state = SendState.SENT) else it }
        }
        val i = rows.indexOfFirst(::isTwin)
        if (i >= 0) return rows.toMutableList().also { it[i] = it[i].copy(message = m, state = SendState.SENT) }
        return rows + GRow(m)
    }

    /** Hide what is past the TTL locally too; my bubbles still sending / failed always stay. */
    fun fresh(rows: List<GRow>, now: Instant, ttlHours: Int): List<GRow> =
        rows.filter { it.message.id < 0 || DMLogic.isFresh(it.message.createdAt, now, ttlHours) }

    /** A group stays without messages (the spec): only its last message goes when it is past the TTL. */
    fun freshSummaries(list: List<GroupSummary>, now: Instant, ttlHours: Int): List<GroupSummary> =
        list.map { s -> if (s.lastMessage != null && !DMLogic.isFresh(s.lastMessage.createdAt, now, ttlHours)) s.copy(lastMessage = null, unreadCount = 0) else s }

    private fun instant(iso: String?): Instant = iso?.let { runCatching { Instant.parse(it) }.getOrNull() } ?: Instant.EPOCH

    /** When a group last moved: its last message, else when it was made. */
    fun activity(s: GroupSummary): Instant = maxOf(instant(s.lastMessage?.createdAt), instant(s.group.createdAt))

    /** The DM list: 1 対 1 and groups mixed, newest first. */
    fun mergeInbox(conversations: List<DMConversation>, groups: List<GroupSummary>): List<DMInboxItem> =
        (conversations.map { DMInboxItem.One(it, instant(it.lastMessage.createdAt)) } + groups.map { DMInboxItem.Group(it, activity(it)) })
            .sortedByDescending { it.at }

    /** A new message moves its group to the top. Null = a group this device does not know (reload the list).
     *  `viewing` = that group is on screen (it is read at once). System lines are never unread. */
    fun upsert(list: List<GroupSummary>, m: GMessage, viewing: Boolean): List<GroupSummary>? {
        val old = list.firstOrNull { it.group.id == m.groupId } ?: return null
        if (old.lastMessage != null && old.lastMessage.id >= m.id && m.id > 0) return list
        val unread = when {
            viewing || m.isAuthor -> 0
            m.isSystem -> old.unreadCount
            else -> old.unreadCount + 1
        }
        return listOf(old.copy(lastMessage = m, unreadCount = unread)) + list.filterNot { it.group.id == m.groupId }
    }

    /** Whether [m] adds one to the unread total (when the server did not say the total). */
    fun countsAsUnread(list: List<GroupSummary>, m: GMessage, viewing: Boolean): Boolean {
        if (viewing || m.isAuthor || m.isSystem) return false
        val last = list.firstOrNull { it.group.id == m.groupId }?.lastMessage ?: return true
        return last.id < m.id
    }

    fun markRead(list: List<GroupSummary>, groupId: Long, lastReadId: Long): List<GroupSummary> =
        list.map { if (it.group.id == groupId && (it.lastMessage?.id ?: 0) <= lastReadId) it.copy(unreadCount = 0) else it }

    /** A `group` event: the new name / members / mute. A group not in the list yet (I was just added) is added. */
    fun applyGroup(list: List<GroupSummary>, g: GDMGroup): List<GroupSummary> =
        if (list.any { it.group.id == g.id }) list.map { if (it.group.id == g.id) it.copy(group = g) else it }
        else listOf(GroupSummary(g)) + list

    fun remove(list: List<GroupSummary>, groupId: Long): List<GroupSummary> = list.filterNot { it.group.id == groupId }

    fun latestStoredId(rows: List<GRow>): Long = rows.maxOfOrNull { it.message.id }?.coerceAtLeast(0) ?: 0

    fun totalUnread(list: List<GroupSummary>): Int = list.sumOf { it.unreadCount }

    /** The list's last-message line. */
    fun preview(m: GMessage?): String {
        if (m == null) return "まだメッセージはありません"
        val t = m.body.replace('\n', ' ').trim()
        return when {
            m.isSystem -> t
            m.isAuthor -> "あなた: $t"
            else -> "${m.senderName}: $t"
        }
    }

    /** The group's name as typed: trimmed, at most [max] characters ("" = no name). */
    fun cleanName(raw: String, max: Int): String = raw.trim().take(max)

    /** Who can be picked: not me, not ビーグル, not already in the group; [query] narrows by name. */
    fun pickable(members: List<MentionMember>, exclude: Set<String>, query: String): List<MentionMember> {
        fun norm(s: String) = s.lowercase().filterNot { it.isWhitespace() || it == '　' }
        val q = norm(query)
        return members.filter { it.userId.isNotBlank() && it.userId !in exclude && it.name != BEAGLE_NAME && (q.isEmpty() || norm(it.name).contains(q)) }
            .distinctBy { it.userId }
    }

    const val PICKER_LIMIT = 10

    /** What the picker shows (ドリキン 2026-11-06: the member total is private, so never the whole list up front).
     *  Nothing typed: only my 1 対 1 DM partners and those already chosen. Typed: matches, at most [PICKER_LIMIT],
     *  plus those already chosen. */
    fun pickerList(all: List<MentionMember>, peerIds: Set<String>, picked: List<String>, exclude: Set<String>, query: String): List<MentionMember> {
        val chosen = all.filter { it.userId in picked }.distinctBy { it.userId }
        val pool = pickable(all, exclude + picked, query)
        val more = if (query.isBlank()) pool.filter { it.userId in peerIds } else pool
        return chosen + more.take(PICKER_LIMIT)
    }

    /** The picker's people: my 1 対 1 DM partners first (newest first), then the chat's members, once each. */
    fun candidates(members: List<MentionMember>, peers: List<DMPeer>): List<MentionMember> =
        (peers.map { MentionMember(it.userId, it.displayName, it.avatar) } + members).distinctBy { it.userId }

    /** 👥 the group photo: the phone sends a JPEG about this long on its long side (the server makes it 512 px square). */
    const val PHOTO_SIDE = 1024
    const val PHOTO_QUALITY = 85

    /** The group's photo to show: only our own server's relative path (it is read with the token), else none (👥). */
    fun photoUrl(g: GDMGroup?): String? = g?.photo?.trim()?.takeIf { it.startsWith("/api/") }

    fun photoButtonLabel(g: GDMGroup): String = if (photoUrl(g) != null) "写真を変える" else "写真を設定"

    /** Said before sending when the resized JPEG is still over the server's limit (null = fine). */
    fun photoSizeError(bytes: Int, maxBytes: Long): String? =
        when {
            bytes <= 0 -> "写真を読み込めませんでした"
            bytes > maxBytes -> "写真が大きすぎます"
            else -> null
        }

    /** 外す is offered to the creator only, and never on myself (that is 抜ける). */
    fun canRemove(g: GDMGroup, member: GMember): Boolean = g.isCreator && !member.isMe

    fun me(g: GDMGroup?): GMember? = g?.members?.firstOrNull { it.isMe }

    // Notifications: one per group (the server's thread-id / collapse gdm-<group_id>).
    fun notificationTitle(title: String?): String = title?.trim()?.takeIf { it.isNotEmpty() } ?: FALLBACK_TITLE
    fun notificationText(fromName: String?, body: String): String {
        val b = if (body.length > NOTIFY_TEXT_MAX) body.take(NOTIFY_TEXT_MAX) + "…" else body
        return "${fromName?.trim()?.takeIf { it.isNotEmpty() } ?: "会員"}: $b"
    }
    fun notificationId(groupId: Long): Int = 8_000_000 + (groupId % 1_000_000).toInt()
    /** The lines of a group's notification: the earlier ones (still on screen) and the new one, at most [NOTIFY_LINES]. */
    fun notificationLines(previous: List<String>, line: String): List<String> = (previous + line).takeLast(NOTIFY_LINES)
}

/** 👥 グループ DM: the groups, the open group and the unread total. Main thread only. The screens and the
 *  navigation live with the 1 対 1 (DMStore / DMScreen); this holds the group side. */
class GDMStore(private val api: ApiClient) {
    var enabled by mutableStateOf(false); private set
    var canSendCap by mutableStateOf(false); private set
    var maxBody by mutableIntStateOf(1000); private set
    var maxName by mutableIntStateOf(40); private set
    var maxMembers by mutableIntStateOf(100); private set
    var ttlHours by mutableIntStateOf(30 * 24); private set
    /** capabilities `gdm.photo` (and a token that may send): offer 写真を設定 / 外す. */
    var canSetPhoto by mutableStateOf(false); private set
    var photoMaxBytes = 15L * 1024 * 1024; private set
    /** capabilities `gdm.beagle` (and a token that may send): offer the 🐶 switch. */
    var canSetBeagle by mutableStateOf(false); private set
    private var base = "/api/agent/gdm"

    var groups by mutableStateOf<List<GroupSummary>>(emptyList()); private set
    var unreadTotal by mutableIntStateOf(0); private set
    var listLoaded by mutableStateOf(false); private set

    /** The group on the screen stack (its members screen may be on top). */
    var openId by mutableStateOf<Long?>(null); private set
    var openGroup by mutableStateOf<GDMGroup?>(null); private set
    var rows by mutableStateOf<List<GRow>>(emptyList()); private set
    var threadLoaded by mutableStateOf(false); private set
    var canSendHere by mutableStateOf(true); private set
    /** Why the last send / load was refused (the server's own words). */
    var error by mutableStateOf<String?>(null)
    /** The members screen / create / add: working, and why it was refused. */
    var busy by mutableStateOf(false); private set
    var actionError by mutableStateOf<String?>(null)

    /** The group on screen right now (resumed): read marking and pushes. */
    @Volatile var visibleGroupId: Long? = null
        private set

    /** My user id when no group tells (ChatStore learns it from the chat). */
    var fallbackMe: () -> String? = { null }
    /** The group went (I left, was removed, or it was deleted): DMStore drops its screens. */
    var onRemoved: (Long) -> Unit = {}

    var demo = false
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private var readJob: Job? = null
    private var threadJob: Job? = null
    private var listJob: Job? = null
    private var tempSeq = 0L
    private var lastReadSent = 0L

    fun configure(caps: Capabilities) {
        enabled = caps.gdmEnabled
        canSendCap = caps.canSendGDM
        maxBody = caps.gdmMaxBody
        maxName = caps.gdmMaxName
        maxMembers = caps.gdmMaxMembers
        ttlHours = caps.gdmTtlHours
        canSetPhoto = caps.canSetGDMPhoto
        canSetBeagle = caps.canSetGDMBeagle
        photoMaxBytes = caps.gdmPhotoMaxBytes
        base = caps.gdmPath
        if (!enabled) { groups = emptyList(); unreadTotal = 0; openId = null; return }
        refreshList()
    }

    fun close() { scope.cancel() }

    /** My own user id: from any group I am in, else what the chat learned. */
    val myUserId: String?
        get() = (openGroup?.let(GDMLogic::me) ?: groups.firstNotNullOfOrNull { GDMLogic.me(it.group) })?.userId ?: fallbackMe()

    fun group(id: Long): GDMGroup? = openGroup?.takeIf { it.id == id } ?: groups.firstOrNull { it.group.id == id }?.group

    // MARK: open / close (DMStore drives these)

    fun open(id: Long) {
        if (openId == id) return
        openId = id
        openGroup = groups.firstOrNull { it.group.id == id }?.group
        rows = emptyList()
        threadLoaded = false
        canSendHere = true
        error = null
        actionError = null
        lastReadSent = 0
        loadThread(id)
    }

    fun closeGroup() {
        threadJob?.cancel()
        openId = null
        openGroup = null
        rows = emptyList()
        visibleGroupId = null
    }

    fun setScreenVisible(id: Long, visible: Boolean) {
        visibleGroupId = if (visible) id else visibleGroupId.takeIf { it != id }
        if (visible) markReadSoon(id)
    }

    // MARK: loading

    fun refreshList() {
        if (demo || !enabled) return
        listJob?.cancel()
        listJob = scope.launch {
            runCatching { api.gdmGroups(base) }.onSuccess { r ->
                groups = GDMLogic.freshSummaries(r.groups, Instant.now(), ttlHours)
                unreadTotal = r.groupUnreadCount
                listLoaded = true
                openId?.let { id -> r.groups.firstOrNull { it.group.id == id }?.group?.let { openGroup = it } }
            }.onFailure { e ->
                // Not for me any more (404): nothing of it shows.
                if (e is ApiError.Http && e.status == 404) { groups = emptyList(); unreadTotal = 0 }
            }
        }
    }

    private fun loadThread(id: Long) {
        threadJob?.cancel()
        if (demo) {
            rows = GDMLogic.fresh(demoThreads[id].orEmpty().map { GRow(it) }, Instant.now(), ttlHours)
            threadLoaded = true
            return
        }
        threadJob = scope.launch {
            try {
                val r = api.gdmThread(id, base)
                if (openId != id) return@launch
                val local = rows.filter { it.message.id < 0 }
                var next = r.messages.map { GRow(it) }
                local.forEach { l -> if (next.none { it.message.clientId != null && it.message.clientId == l.message.clientId }) next = next + l }
                rows = GDMLogic.fresh(next, Instant.now(), ttlHours)
                canSendHere = r.canSend
                r.group?.let { g -> openGroup = g; groups = groups.map { if (it.group.id == g.id) it.copy(group = g) else it } }
                threadLoaded = true
                if (visibleGroupId == id) markReadSoon(id)
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: ApiError.Http) {
                if (e.status == 404) { dropped(id); return@launch }
                error = e.serverMessage ?: "読み込めませんでした"
                if (e.status == 403) canSendHere = false
                threadLoaded = true
            } catch (_: Exception) {
                error = "読み込めませんでした"
                threadLoaded = true
            }
        }
    }

    fun prune() {
        val now = Instant.now()
        rows = GDMLogic.fresh(rows, now, ttlHours)
        groups = GDMLogic.freshSummaries(groups, now, ttlHours)
    }

    // MARK: stream

    /** `ready` (every (re)connect): the ready event has no group total, so the list is read again. */
    fun onReady() {
        if (!enabled) return
        refreshList()
        openId?.let(::loadThread)
    }

    fun apply(data: String) {
        if (!enabled) return
        val e = runCatching { ApiJson.decodeFromString<GDMEvent>(data) }.getOrNull() ?: return
        when (e.action) {
            "create" -> e.message?.let { m -> received(if (m.groupId == 0L && e.groupId != null) m.copy(groupId = e.groupId) else m, e.groupUnreadCount) }
            "read" -> {
                val id = e.groupId ?: return
                groups = GDMLogic.markRead(groups, id, e.lastReadId ?: 0)
                e.groupUnreadCount?.let { unreadTotal = it }
            }
            "group" -> e.group?.let { g ->
                groups = GDMLogic.applyGroup(groups, g)
                if (openId == g.id) openGroup = g
            }
            "removed" -> e.groupId?.let(::dropped)
        }
    }

    private fun received(m: GMessage, total: Int?) {
        val id = m.groupId
        val viewing = visibleGroupId == id
        val counts = GDMLogic.countsAsUnread(groups, m, viewing)
        val next = GDMLogic.upsert(groups, m, viewing)
        if (next == null) {
            // A group this device does not know yet (added elsewhere, or the list is stale).
            refreshList()
        } else {
            groups = next
        }
        if (openId == id) rows = GDMLogic.reconcile(rows, m)
        when {
            total != null && !viewing -> unreadTotal = total
            next != null && counts -> unreadTotal += 1
        }
        if (viewing && !m.isAuthor) markReadSoon(id)
    }

    /** I am no longer in that group: it goes from here. */
    private fun dropped(id: Long) {
        val before = groups.firstOrNull { it.group.id == id }?.unreadCount ?: 0
        groups = GDMLogic.remove(groups, id)
        unreadTotal = (unreadTotal - before).coerceAtLeast(0)
        if (openId == id) closeGroup()
        onRemoved(id)
    }

    // MARK: sending

    fun send(raw: String, restore: (String) -> Unit) {
        val id = openId ?: return
        val body = raw.trim().take(maxBody)
        if (body.isEmpty() || !canSendCap || !canSendHere) return
        val clientId = UUID.randomUUID().toString()
        tempSeq += 1
        val me = GDMLogic.me(openGroup)
        val pending = GMessage(id = -tempSeq, groupId = id, fromId = me?.userId ?: myUserId, fromName = me?.name, fromAvatar = me?.avatar,
            body = body, createdAt = Instant.now().toString(), isAuthor = true, clientId = clientId)
        error = null
        rows = rows + GRow(pending, SendState.PENDING)
        post(id, pending, restore)
    }

    fun retry(row: GRow) {
        val id = openId ?: return
        if (row.message.id >= 0) return
        setState(row.message.clientId, SendState.PENDING)
        post(id, row.message) { }
    }

    fun discard(row: GRow) {
        rows = rows.filterNot { it.message.id < 0 && it.message.clientId == row.message.clientId }
    }

    private fun post(id: Long, pending: GMessage, restore: (String) -> Unit) {
        val clientId = pending.clientId ?: return
        if (demo) {
            val stored = pending.copy(id = (demoThreads.values.flatten().maxOfOrNull { it.id } ?: 0L) + rows.size + 1)
            demoThreads[id] = demoThreads[id].orEmpty() + stored
            rows = GDMLogic.reconcile(rows, stored)
            GDMLogic.upsert(groups, stored, viewing = true)?.let { groups = it }
            return
        }
        scope.launch {
            try {
                val m = api.gdmSend(id, pending.body, clientId, base)
                if (openId == id) rows = GDMLogic.reconcile(rows, m)
                GDMLogic.upsert(groups, m, viewing = true)?.let { groups = it }
            } catch (e: ApiError) {
                if (e is ApiError.Http && e.serverMessage != null) error = e.serverMessage
                if (e is ApiError.Http && e.status == 404) { dropped(id); return@launch }
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

    private fun markReadSoon(id: Long) {
        if (openId != id) return
        val upTo = GDMLogic.latestStoredId(rows)
        val before = groups.firstOrNull { it.group.id == id }?.unreadCount ?: 0
        groups = GDMLogic.markRead(groups, id, Long.MAX_VALUE)
        unreadTotal = (unreadTotal - before).coerceAtLeast(0)
        if (demo || upTo <= 0 || upTo <= lastReadSent) return
        readJob?.cancel()
        readJob = scope.launch {
            delay(600)
            runCatching { api.gdmMarkRead(id, upTo, base) }.onSuccess { r ->
                lastReadSent = upTo
                r.groupUnreadCount?.let { unreadTotal = it }
            }
        }
    }

    // MARK: members screen / create / add

    private fun action(block: suspend () -> Unit) {
        if (busy) return
        busy = true
        actionError = null
        scope.launch {
            try {
                block()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: ApiError.Http) {
                actionError = e.serverMessage ?: "できませんでした（${e.status}）"
            } catch (_: Exception) {
                actionError = "通信できませんでした。もう一度お試しください"
            } finally {
                busy = false
            }
        }
    }

    /** A new group with [memberIds] (besides me) and an optional name; [done] opens it. */
    fun create(memberIds: List<String>, name: String, done: (Long) -> Unit) {
        val ids = memberIds.distinct()
        if (ids.isEmpty() || !canSendCap) return
        val n = GDMLogic.cleanName(name, maxName)
        if (demo) {
            val id = (groups.maxOfOrNull { it.group.id } ?: 0L) + 1
            val g = GDMGroup(id, n.ifEmpty { null }, n.ifEmpty { ids.take(3).joinToString("、") }, members = listOf(GMember("me", "ドリキン", isCreator = true, isMe = true)) + ids.map { GMember(it, it) },
                memberCount = ids.size + 1, isCreator = true, createdAt = Instant.now().toString())
            groups = GDMLogic.applyGroup(groups, g)
            done(id)
            return
        }
        action {
            val g = api.gdmCreate(ids, n.ifEmpty { null }, base)
            groups = GDMLogic.applyGroup(groups, g)
            done(g.id)
        }
    }

    fun addMembers(id: Long, userIds: List<String>, done: () -> Unit) {
        val ids = userIds.distinct()
        if (ids.isEmpty()) return
        if (demo) {
            group(id)?.let { g -> updated(g.copy(members = g.members + ids.map { GMember(it, it) }, memberCount = g.count + ids.size)) }
            done(); return
        }
        action { updated(api.gdmAddMembers(id, ids, base)); done() }
    }

    fun rename(id: Long, name: String, done: () -> Unit = {}) {
        val n = GDMLogic.cleanName(name, maxName)
        if (demo) { group(id)?.let { updated(it.copy(name = n.ifEmpty { null }, title = n.ifEmpty { it.title })) }; done(); return }
        action { updated(api.gdmRename(id, n, base)); done() }
    }

    fun setMuted(id: Long, muted: Boolean) {
        if (demo) { group(id)?.let { updated(it.copy(muted = muted)) }; return }
        action { updated(api.gdmSetMuted(id, muted, base)) }
    }

    /** 🐶 let @ビーグル answer in the group (any member; the server tells everyone). */
    fun setBeagle(id: Long, on: Boolean) {
        if (!canSetBeagle) return
        if (demo) { group(id)?.let { updated(it.copy(beagle = on)) }; return }
        action { updated(api.gdmSetBeagle(id, on, base)) }
    }

    /** 👥 set / replace the group photo (any member). [jpeg] is already resized on the phone. */
    fun setPhoto(id: Long, jpeg: ByteArray) {
        if (!canSetPhoto) return
        GDMLogic.photoSizeError(jpeg.size, photoMaxBytes)?.let { actionError = it; return }
        if (demo) { actionError = "デモでは写真を変えられません"; return }
        action { updated(api.gdmSetPhoto(id, jpeg, base)) }
    }

    fun removePhoto(id: Long) {
        if (!canSetPhoto) return
        if (demo) { group(id)?.let { updated(it.copy(photo = null)) }; return }
        action { updated(api.gdmRemovePhoto(id, base)) }
    }

    /** The creator removes someone else. */
    fun removeMember(id: Long, userId: String) {
        if (demo) { group(id)?.let { g -> updated(g.copy(members = g.members.filterNot { it.userId == userId }, memberCount = g.count - 1)) }; return }
        action {
            api.gdmRemoveMember(id, userId, base)
            group(id)?.let { g -> updated(g.copy(members = g.members.filterNot { it.userId == userId }, memberCount = (g.count - 1).coerceAtLeast(0))) }
        }
    }

    /** I leave: the group goes from here (the server tells my other devices with `removed`). */
    fun leave(id: Long) {
        val me = GDMLogic.me(group(id))?.userId ?: myUserId
        if (me == null) { actionError = "自分のアカウントが確かめられませんでした。少し待ってからお試しください"; return }
        if (demo) { dropped(id); return }
        action {
            try {
                api.gdmRemoveMember(id, me, base)
            } catch (e: ApiError.Http) {
                if (e.status != 404) throw e
            }
            dropped(id)
        }
    }

    private fun updated(g: GDMGroup) {
        groups = GDMLogic.applyGroup(groups, g)
        if (openId == g.id) openGroup = g
    }

    // MARK: demo

    private val demoThreads = HashMap<Long, List<GMessage>>()

    /** Debug only: one group among the demo chat's people (two unread), offline. */
    fun loadDemo() {
        demo = true
        enabled = true
        canSendCap = true
        canSetPhoto = true
        canSetBeagle = true
        val now = Instant.now()
        fun at(minAgo: Long) = now.minusSeconds(minAgo * 60).toString()
        val members = listOf(GMember("me", "ドリキン", isCreator = true, isMe = true), GMember("mazzo", "mazzo"), GMember("takuto", "takuto"), GMember("coban", "coban"))
        val g = GDMGroup(1, "配信の相談", "配信の相談", members, members.size, isCreator = true, createdAt = at(200))
        var id = 100L
        fun m(from: GMember?, body: String, minAgo: Long) = GMessage(++id, 1, if (from == null) "system" else "text", from?.userId, from?.name, null,
            body, at(minAgo), isAuthor = from?.isMe == true)
        demoThreads[1] = listOf(
            m(null, "ドリキンさんがグループを作りました", 200),
            m(members[0], "来週の配信、ゲストどうしましょう", 120),
            m(members[1], "takuto さんどうですか", 30),
            m(members[2], "いいですよ！", 8),
        )
        groups = listOf(GroupSummary(g, demoThreads[1]!!.last(), 2))
        unreadTotal = 2
        listLoaded = true
    }
}
