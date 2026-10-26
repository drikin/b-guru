package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 端末をまたぐ連携: which notifications a read_sync cancels, the voice_handoff push, never a plain notification. */
class DeviceSyncTest {
    private fun sig(vararg kv: Pair<String, String>) = ReadSync.parse(mapOf("kind" to "read_sync") + kv)!!

    // What Push posts, with its extras.
    private val mention5 = ReadSync.Shown(105, Push.CH_MENTION, "chat_mention", 5)
    private val mention9 = ReadSync.Shown(109, Push.CH_MENTION, "chat_mention", 9)
    private val newMessages7 = ReadSync.Shown(1, Push.CH_CHAT, "chat_new", 7)
    private val dmMazzo = ReadSync.Shown(DMLogic.notificationId("u-mazzo"), Push.CH_DM, "dm", 40, "u-mazzo")
    private val dmTakuto = ReadSync.Shown(DMLogic.notificationId("u-takuto"), Push.CH_DM, "dm", 41, "u-takuto")
    private val reply42 = ReadSync.Shown(1_000_042, Push.CH_REPLY, "reply", 42)
    private val reply43 = ReadSync.Shown(1_000_043, Push.CH_REPLY, "reply", 43)
    private val timeline42 = ReadSync.Shown(3_000_042, "timeline", "timeline_new", 42)
    private val shogi7 = ReadSync.Shown(4_000_007, Push.CH_SHOGI, "shogi_turn", 7)
    private val offkai3 = ReadSync.Shown(5_000_003, Push.CH_OFFKAI, "offkai_start", 3)
    /** The voice call's own notification (VoiceService, id 7001 — in the mention id range, another channel). */
    private val voiceService = ReadSync.Shown(7001, "voice", null)
    private val all = listOf(mention5, mention9, newMessages7, dmMazzo, dmTakuto, reply42, reply43, timeline42, shogi7, offkai3, voiceService)

    private fun cancel(s: ReadSync.Signal, shown: List<ReadSync.Shown> = all) = ReadSync.toCancel(s, shown, 1).toSet()

    @Test fun parsesTheFcmStrings() {
        val s = sig("scope" to "dm", "peer_id" to "u-mazzo", "up_to" to "40")
        assertEquals("dm", s.scope)
        assertEquals("u-mazzo", s.peerId)
        assertEquals(40L, s.upTo)
        assertNull(ReadSync.parse(mapOf("kind" to "chat_new", "scope" to "chat")))
        assertNull(ReadSync.parse(mapOf("kind" to "read_sync")))
        assertNull(sig("scope" to "reply", "post_id" to "x").postId)
    }

    @Test fun chatCancelsMentionsUpToTheCursorAndTheRollingOne() {
        assertEquals(setOf(105, 1), cancel(sig("scope" to "chat", "up_to" to "7")))
        assertEquals(setOf(105, 109, 1), cancel(sig("scope" to "chat", "up_to" to "9")))
        // A newer 「新着メッセージ」 than what was read stays.
        assertEquals(setOf(105), cancel(sig("scope" to "chat", "up_to" to "6")))
        assertEquals(emptySet<Int>(), cancel(sig("scope" to "chat")))
    }

    @Test fun chatWorksForNotificationsWithoutExtras() {
        // Posted before this version: the id says the message (id − 100); the rolling one counts as read.
        val old = listOf(ReadSync.Shown(105, Push.CH_MENTION), ReadSync.Shown(109, Push.CH_MENTION), ReadSync.Shown(1, Push.CH_CHAT), voiceService)
        assertEquals(setOf(105, 1), cancel(sig("scope" to "chat", "up_to" to "7"), old))
    }

    @Test fun dmCancelsThatPersonOnly() {
        assertEquals(setOf(dmMazzo.id), cancel(sig("scope" to "dm", "peer_id" to "u-mazzo", "up_to" to "40")))
        // A DM newer than what was read stays.
        assertEquals(emptySet<Int>(), cancel(sig("scope" to "dm", "peer_id" to "u-mazzo", "up_to" to "39")))
        // Without extras: the per-person id.
        val old = listOf(ReadSync.Shown(DMLogic.notificationId("u-mazzo"), Push.CH_DM), ReadSync.Shown(DMLogic.notificationId("u-takuto"), Push.CH_DM))
        assertEquals(setOf(DMLogic.notificationId("u-mazzo")), cancel(sig("scope" to "dm", "peer_id" to "u-mazzo", "up_to" to "1"), old))
        assertEquals(emptySet<Int>(), cancel(sig("scope" to "dm", "up_to" to "40")))
    }

    @Test fun replyAndReplyAll() {
        assertEquals(setOf(1_000_042), cancel(sig("scope" to "reply", "post_id" to "42")))
        // Every reply, never the timeline's own (same post id, another channel).
        assertEquals(setOf(1_000_042, 1_000_043), cancel(sig("scope" to "reply_all")))
        assertEquals(setOf(1_000_043), cancel(sig("scope" to "reply", "post_id" to "43"), listOf(ReadSync.Shown(1_000_043, Push.CH_REPLY))))
    }

    @Test fun shogiAndOffkaiByTheirIds() {
        assertEquals(setOf(4_000_007), cancel(sig("scope" to "shogi", "game_id" to "7")))
        assertEquals(emptySet<Int>(), cancel(sig("scope" to "shogi", "game_id" to "8")))
        assertEquals(setOf(5_000_003), cancel(sig("scope" to "offkai", "event_id" to "3")))
        // A DM whose per-person id happens to be 5_000_003 is on the DM channel: not an オフ会.
        assertEquals(emptySet<Int>(), cancel(sig("scope" to "offkai", "event_id" to "3"), listOf(ReadSync.Shown(5_000_003, Push.CH_DM, "dm", 1, "u-x"))))
    }

    @Test fun unknownScopeCancelsNothing() {
        assertEquals(emptySet<Int>(), cancel(sig("scope" to "watch", "up_to" to "999")))
    }

    @Test fun onlyKnownKindsAreShown() {
        listOf("chat_mention", "chat_new", "reply", "timeline_new", "shogi_offer", "shogi_turn", "offkai_start", "dm").forEach { assertTrue(it, PushContent.isKnown(it)) }
        // read_sync / voice_handoff have their own handling; a future kind shows nothing.
        listOf("read_sync", "voice_handoff", "something_new", "").forEach { assertFalse(it, PushContent.isKnown(it)) }
    }

    @Test fun handoffPush() {
        assertEquals(VoiceHandoff.Target.OFFKAI, VoiceHandoff.target("offkai"))
        assertEquals(VoiceHandoff.Target.VOICE, VoiceHandoff.target("voice"))
        assertEquals(VoiceHandoff.Target.ROOM, VoiceHandoff.target(" Room "))
        assertNull(VoiceHandoff.target("watch"))
        assertNull(VoiceHandoff.target(null))
        // FCM data are strings: both spellings.
        assertTrue(VoiceHandoff.mic("1"))
        assertTrue(VoiceHandoff.mic("true"))
        assertTrue(VoiceHandoff.mic("TRUE"))
        assertFalse(VoiceHandoff.mic("0"))
        assertFalse(VoiceHandoff.mic("false"))
        assertFalse(VoiceHandoff.mic(null))
        assertEquals("🎧 音声をこの端末で続ける", VoiceHandoff.TITLE)
        assertTrue(VoiceHandoff.text(VoiceHandoff.Target.OFFKAI, false).startsWith("🍻"))
        assertTrue(VoiceHandoff.text(VoiceHandoff.Target.ROOM, true).contains("マイクオン"))
        assertTrue(VoiceHandoff.text(VoiceHandoff.Target.VOICE, false).contains("マイクオフ"))
    }
}
