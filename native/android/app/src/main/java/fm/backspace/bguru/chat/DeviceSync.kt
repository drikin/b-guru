package fm.backspace.bguru.chat

/*
 * 端末をまたぐ連携 (docs/device-sync-spec.md) — the pure parts, unit-tested in DeviceSyncTest.
 * - read_sync: read on another device → the notifications for it go here too (never shown itself).
 * - voice_handoff: 「スマホで続ける」 on the Mac / Web → a notification here; a tap joins the audio on this phone,
 *   and the other device is cut off by LiveKit with DUPLICATE_IDENTITY (same identity = user id).
 */

/** read_sync: which of the notifications on screen to cancel. */
object ReadSync {
    const val KIND = "read_sync"

    /** What each of our notifications carries (Notification extras), so a later read_sync can match it. */
    const val EXTRA_KIND = "bguru_kind"
    const val EXTRA_ID = "bguru_id"
    const val EXTRA_PEER = "bguru_peer"

    /** The push body (FCM data strings): `{ kind: "read_sync", scope, up_to?, peer_id?, post_id?, game_id?, event_id? }`. */
    data class Signal(
        val scope: String,
        val upTo: Long? = null,
        val peerId: String? = null,
        val postId: Long? = null,
        val gameId: Long? = null,
        val eventId: Long? = null,
    )

    fun parse(data: Map<String, String>): Signal? {
        if (data["kind"] != KIND) return null
        val scope = data["scope"]?.trim()?.ifEmpty { null } ?: return null
        return Signal(
            scope = scope,
            upTo = data["up_to"]?.toLongOrNull(),
            peerId = data["peer_id"]?.trim()?.ifEmpty { null },
            postId = data["post_id"]?.toLongOrNull(),
            gameId = data["game_id"]?.toLongOrNull(),
            eventId = data["event_id"]?.toLongOrNull(),
        )
    }

    /**
     * One notification on screen: its id, channel, and what [Push] put in its extras — `kind`, `id` (the chat
     * message for chat_mention / chat_new, the DM for dm, the post / game / event otherwise) and `peer` (DMs).
     * Notifications posted before this version have no extras: the channel and the id tell the kind then
     * (PushContent.notificationId / DMLogic.notificationId), and anything that is not ours (the voice service,
     * the jukebox) is on another channel and never matches.
     */
    data class Shown(val id: Int, val channel: String?, val kind: String? = null, val itemId: Long? = null, val peerId: String? = null)

    /** The notification ids to cancel for [s]. Unknown scopes cancel nothing. */
    fun toCancel(s: Signal, shown: List<Shown>, newMessagesId: Int): List<Int> = shown.filter { n ->
        when (s.scope) {
            // Mentions up to the read cursor, and the rolling 「新着メッセージ」 when its message is read too
            // (unknown message — posted by an older version — counts as read: it is older than any new one).
            "chat" -> {
                val upTo = s.upTo ?: return@filter false
                when {
                    n.channel == Push.CH_MENTION -> {
                        val m = n.itemId ?: (n.id - 100L).takeIf { n.kind == null && n.id >= 100 }
                        m != null && m <= upTo
                    }
                    n.channel == Push.CH_CHAT && n.id == newMessagesId -> n.itemId == null || n.itemId <= upTo
                    else -> false
                }
            }
            // That person's DM notification, unless a newer DM came after what was read.
            "dm" -> {
                val peer = s.peerId ?: return@filter false
                n.channel == Push.CH_DM && (n.peerId?.let { it == peer } ?: (n.id == DMLogic.notificationId(peer))) &&
                    (s.upTo == null || n.itemId == null || n.itemId <= s.upTo)
            }
            "reply" -> {
                val post = s.postId ?: return@filter false
                n.channel == Push.CH_REPLY && isReply(n) && postOf(n, 1_000_000) == post
            }
            "reply_all" -> n.channel == Push.CH_REPLY && isReply(n)
            "shogi" -> {
                val game = s.gameId ?: return@filter false
                n.channel == Push.CH_SHOGI && postOf(n, 4_000_000) == game
            }
            "offkai" -> {
                val event = s.eventId ?: return@filter false
                n.channel == Push.CH_OFFKAI && postOf(n, 5_000_000) == event
            }
            else -> false
        }
    }.map { it.id }

    /** The reply channel holds only "reply" (ids 1_000_000 + post); older versions put other kinds there too. */
    private fun isReply(n: Shown) = if (n.kind != null) n.kind == "reply" else n.id in 1_000_000 until 2_000_000

    private fun postOf(n: Shown, base: Int): Long? = n.itemId ?: (n.id.toLong() - base).takeIf { n.kind == null && it >= 0 }
}

/** voice_handoff: 「🎧 音声をこの端末で続ける」. */
object VoiceHandoff {
    const val KIND = "voice_handoff"
    const val TITLE = "🎧 音声をこの端末で続ける"
    /** Shown instead of 「接続が切れました」 when the same member joined on another device (DUPLICATE_IDENTITY). */
    const val CONTINUED_ELSEWHERE = "別の端末で続けています"
    /** The server's collapse key voice-handoff: one at a time. */
    const val NOTIFICATION_ID = 7_000_000
    /** The server forgets it after 5 minutes: the notification goes then too. */
    const val EXPIRES_MS = 5L * 60 * 1000

    enum class Target(val key: String) { OFFKAI("offkai"), VOICE("voice"), ROOM("room") }

    fun target(key: String?): Target? = Target.entries.firstOrNull { it.key == key?.trim()?.lowercase() }

    /** FCM data are strings: "1" / "true" (any case) is on, anything else off. */
    fun mic(value: String?): Boolean = value?.trim()?.lowercase().let { it == "1" || it == "true" }

    fun text(t: Target, mic: Boolean): String = when (t) {
        Target.OFFKAI -> "🍻 オフ会の音声をこのスマホで続けます。タップして切り替え"
        Target.VOICE -> "ボイスルームの音声をこのスマホで続けます（マイク${if (mic) "オン" else "オフ"}）。タップして切り替え"
        Target.ROOM -> "🏠 部室の音声をこのスマホで続けます（マイク${if (mic) "オン" else "オフ"}）。タップして切り替え"
    }
}
