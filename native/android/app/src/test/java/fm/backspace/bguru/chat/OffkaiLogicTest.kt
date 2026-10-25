package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

/** 🍻 オフ会: old versions dropped, who may end, my photos, the album order, the stream's JSON. */
class OffkaiLogicTest {
    private val mazzo = OffkaiPerson("u-mazzo", "mazzo")
    private fun ev(version: Int, speaker: String? = null, ended: Boolean = false, id: Long = 7) = OffkaiEvent(
        id, version, "渋谷", mazzo, "2026-10-24T10:00:00Z", "2026-10-24T16:00:00Z",
        endedAt = if (ended) "2026-10-24T12:00:00Z" else null,
        speaker = speaker?.let { OffkaiSpeaker(it, it, connected = true) },
    )

    @Test fun olderVersionsAreDropped() {
        assertTrue(OffkaiLogic.isNewer(null, ev(1)))
        assertTrue(OffkaiLogic.isNewer(ev(3), ev(4)))
        assertTrue(OffkaiLogic.isNewer(ev(3), ev(3)))
        assertFalse(OffkaiLogic.isNewer(ev(4), ev(3)))
        // Another event (a new one started): always taken.
        assertTrue(OffkaiLogic.isNewer(ev(9), ev(1, id = 8)))
    }

    @Test fun whoMayEnd() {
        assertTrue(OffkaiLogic.canEnd(ev(1), "u-mazzo", serverSaid = false)) // started it
        assertFalse(OffkaiLogic.canEnd(ev(1, speaker = "u-me"), "u-me", serverSaid = false)) // speaking is not enough (後勝ち)
        assertFalse(OffkaiLogic.canEnd(ev(1, speaker = "u-other"), "u-me", serverSaid = false))
        assertTrue(OffkaiLogic.canEnd(ev(1), "u-me", serverSaid = true)) // admin (GET's can_end)
        assertFalse(OffkaiLogic.canEnd(ev(1), null, serverSaid = false))
        assertFalse(OffkaiLogic.canEnd(ev(1, ended = true), "u-mazzo", serverSaid = true))
    }

    @Test fun myPhotosAndOrder() {
        val p1 = OffkaiPhoto(1, "/api/media/offkai-1.jpg", mazzo)
        val p3 = OffkaiPhoto(3, "/api/media/offkai-3.jpg", OffkaiPerson("u-me"))
        assertTrue(OffkaiLogic.isMine(p3, "u-me")) // the stream's copy says mine = false
        assertFalse(OffkaiLogic.isMine(p1, "u-me"))
        assertTrue(OffkaiLogic.isMine(p1.copy(mine = true), null))
        val list = OffkaiLogic.insert(OffkaiLogic.insert(listOf(p3), p1), p1)
        assertEquals(listOf(1L, 3L), list.map { it.id })
    }

    @Test fun elapsedAndTitle() {
        val start = "2026-10-24T10:00:00Z"
        assertEquals("たった今", OffkaiLogic.elapsed(start, Instant.parse("2026-10-24T10:00:30Z")))
        assertEquals("12分", OffkaiLogic.elapsed(start, Instant.parse("2026-10-24T10:12:00Z")))
        assertEquals("1時間23分", OffkaiLogic.elapsed(start, Instant.parse("2026-10-24T11:23:00Z")))
        assertEquals("渋谷", OffkaiLogic.title(ev(1)))
        assertEquals("mazzoのオフ会", OffkaiLogic.title(ev(1).copy(title = " ")))
    }

    @Test fun streamAndStateJson() {
        val d = ApiJson.decodeFromString<OffkaiStreamData>(
            """{"action":"photo","event_id":7,"photo":{"id":5,"url":"/api/media/offkai-a.jpg","uploader":{"user_id":"u1","name":"a","avatar":""},"caption":"","created_at":"2026-10-24T10:00:00Z","mine":false}}"""
        )
        assertEquals(7L, d.eventId)
        assertEquals("u1", d.photo?.uploader?.userId)
        val s = ApiJson.decodeFromString<OffkaiState>(
            """{"apiVersion":1,"enabled":true,"can":{"start":false,"speak":true,"upload":true},"listeners":3,"archive":[],
               "current":{"id":7,"version":2,"title":"","started_by":{"user_id":"u1","name":null,"avatar":""},"started_at":"2026-10-24T10:00:00Z",
               "ends_at":"2026-10-24T16:00:00Z","ended_at":null,"speaker":{"user_id":"u2","name":"b","avatar":"","connected":false},
               "photo_count":0,"cover":null,"can_end":true}}"""
        )
        assertNotNull(s.current)
        assertEquals(3, s.listeners)
        assertTrue(s.current!!.canEnd)
        assertFalse(s.current?.speaker?.connected ?: true)
        val t = ApiJson.decodeFromString<OffkaiTokenReply>("""{"token":"x","url":"wss://h/livekit","room":"bguru-offkai-7","can_speak":true}""")
        assertTrue(t.canSpeak)
    }

    @Test fun pushWords() {
        assertEquals("🍻 オフ会", PushContent.defaultTitle(PushContent.OFFKAI_START))
        assertEquals("オフ会が始まりました。チャットの 🍻 から聞けます", PushContent.defaultText(PushContent.OFFKAI_START))
        assertEquals(5_000_007, PushContent.notificationId(PushContent.OFFKAI_START, null, 7, 1))
    }
}
