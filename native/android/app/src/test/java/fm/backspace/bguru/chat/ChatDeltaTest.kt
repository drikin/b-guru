package fm.backspace.bguru.chat

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class ChatDeltaTest {
    private fun m(id: Long, sig: String? = "s$id", body: String = "m$id", createdAt: String = "2026-11-25T00:00:00Z") =
        ChatMessage(id, body = body, createdAt = createdAt, sig = sig)

    @Test fun unchangedRowsAreKeptAndNewOnesAppended() {
        val cached = listOf(m(1), m(2), m(3))
        val plan = ChatDelta.plan(cached, mapOf(1L to "s1", 2L to "s2", 3L to "s3"), listOf(m(4), m(5)), after = 3)
        assertEquals(emptyList<Long>(), plan.reread)
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L), ChatDelta.merge(plan, emptyList()).map { it.id })
    }

    @Test fun missingFromWindowIsDropped() {
        val plan = ChatDelta.plan(listOf(m(1), m(2), m(3)), mapOf(1L to "s1", 3L to "s3"), emptyList(), after = 3)
        assertEquals(listOf(1L, 3L), ChatDelta.merge(plan, emptyList()).map { it.id })
    }

    @Test fun changedSigOrNullSigIsReread() {
        val cached = listOf(m(1), m(2, sig = null), m(3))
        val plan = ChatDelta.plan(cached, mapOf(1L to "s1", 2L to "s2", 3L to "x3"), emptyList(), after = 3)
        assertEquals(listOf(2L, 3L), plan.reread)
        val merged = ChatDelta.merge(plan, listOf(m(2, body = "edited"), m(3, sig = "x3", body = "reacted")))
        assertEquals(listOf("m1", "edited", "reacted"), merged.map { it.body })
    }

    @Test fun rereadNotReturnedMeansGone() {
        val plan = ChatDelta.plan(listOf(m(1), m(2)), mapOf(1L to "s1", 2L to "zz"), emptyList(), after = 2)
        assertEquals(listOf(1L), ChatDelta.merge(plan, emptyList()).map { it.id })
    }

    @Test fun windowIdWeDoNotHaveIsRead() {
        val plan = ChatDelta.plan(listOf(m(1), m(3)), mapOf(1L to "s1", 2L to "s2", 3L to "s3"), emptyList(), after = 3)
        assertEquals(listOf(2L), plan.reread)
        assertEquals(listOf(1L, 2L, 3L), ChatDelta.merge(plan, listOf(m(2))).map { it.id })
    }

    @Test fun fullWindowDropsRowsBelowIt() {
        val window = (101L..300L).associateWith { "s$it" }
        val cached = (50L..300L).map { m(it) }
        val plan = ChatDelta.plan(cached, window, emptyList(), after = 300)
        assertTrue(plan.kept.all { it.id >= 101 })
        assertTrue(plan.reread.isEmpty())
    }

    @Test fun mergeKeepsTheNewestHundred() {
        val cached = (1L..90L).map { m(it) }
        val plan = ChatDelta.plan(cached, cached.associate { it.id to it.sig }, (91L..130L).map { m(it) }, after = 90)
        val merged = ChatDelta.merge(plan, emptyList())
        assertEquals(ChatDelta.KEEP, merged.size)
        assertEquals(31L, merged.first().id)
        assertEquals(130L, merged.last().id)
    }

    @Test fun newerAtOrBelowAfterIsIgnored() {
        val plan = ChatDelta.plan(listOf(m(5)), mapOf(5L to "s5"), listOf(m(5, body = "dup"), m(6)), after = 5)
        assertEquals(listOf("m5", "m6"), ChatDelta.merge(plan, emptyList()).map { it.body })
    }

    @Test fun freshDropsOlderThanADayAndPendingRows() {
        val now = java.time.Instant.parse("2026-11-25T12:00:00Z").toEpochMilli()
        val list = listOf(
            m(1, createdAt = "2026-11-24T11:00:00Z"), // 25 h
            m(2, createdAt = "2026-11-24T13:00:00.000Z"), // 23 h
            m(-3, createdAt = "2026-11-25T11:00:00Z"), // pending
            m(4, createdAt = "garbled"), // kept: the resync checks it
        )
        assertEquals(listOf(2L, 4L), ChatDelta.fresh(list, now).map { it.id })
    }

    @Test fun parseWindowSkipsMalformedPairs() {
        val w = listOf(
            JsonArray(listOf(JsonPrimitive(7), JsonPrimitive("abc"))),
            JsonArray(listOf(JsonPrimitive("x"))),
            JsonArray(listOf(JsonPrimitive(8), JsonNull)),
        )
        assertEquals(mapOf(7L to "abc", 8L to null), ChatDelta.parseWindow(w))
    }

    @Test fun deltaResponseDecodes() {
        val r = ApiJson.decodeFromString<ChatDeltaResponse>(
            """{"unread_count":2,"latest_id":9,"last_read_id":7,"messages":[{"id":9,"body":"hi","sig":"abcdef012345"}],"more":false,"window":[[7,"aaa"],[8,"bbb"]]}"""
        )
        assertEquals("abcdef012345", r.messages.single().sig)
        assertEquals(mapOf(7L to "aaa", 8L to "bbb"), ChatDelta.parseWindow(r.window!!))
    }

    @Test fun cacheFileRoundTrips() {
        val f = ChatCacheFile(latestId = 3, messages = listOf(m(3, body = "x").copy(reactions = listOf(Reaction("❤️", 2, mine = true)))))
        val back = ApiJson.decodeFromString<ChatCacheFile>(ApiJson.encodeToString(ChatCacheFile.serializer(), f))
        assertEquals(f, back)
    }
}
