package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

class LogicTest {
    private fun msg(id: Long, clientId: String? = null, isAuthor: Boolean = false, body: String = "b") =
        ChatMessage(id = id, body = body, isAuthor = isAuthor, clientId = clientId)

    @Test fun mentionTokenAndQuery() {
        assertEquals("@mazzo ", Mention.token("mazzo"))
        assertEquals("@[NORIO TAKAHASHI] ", Mention.token("NORIO TAKAHASHI"))
        assertEquals(3 to "ma", Mention.activeQuery("hi @ma"))
        assertNull(Mention.activeQuery("mail@ma"))      // not after whitespace
        assertNull(Mention.activeQuery("@mazzo done")) // already finished
        assertEquals("hi @mazzo ", Mention.complete("hi @ma", "mazzo"))
    }

    @Test fun mentionCandidatesPrefixFirstThenRecent() {
        val members = listOf("takuto", "mutaku", "taro").map { MentionMember(it, it) }
        val r = Mention.candidates(members, "ta", recent = listOf("taro"))
        assertEquals(listOf("taro", "takuto", "mutaku"), r.map { it.name })
    }

    @Test fun reconcileReplacesOwnPendingRowKeepingItsKey() {
        val pending = ChatRow(msg(-1, clientId = "c1", isAuthor = true), SendState.PENDING)
        val stored = msg(10, clientId = "c1", isAuthor = true)
        val out = ChatStore.reconcile(listOf(pending), stored)
        assertEquals(1, out.size)
        assertEquals(10L, out[0].message.id)
        assertEquals("c1", out[0].key)
        assertEquals(SendState.SENT, out[0].state)
    }

    @Test fun reconcileNeverMergesSomeoneElsesMessage() {
        val pending = ChatRow(msg(-1, clientId = "c1", isAuthor = true), SendState.PENDING)
        val other = msg(11, clientId = "c1", isAuthor = false)
        assertEquals(2, ChatStore.reconcile(listOf(pending), other).size)
    }

    @Test fun reconcileTwiceIsIdempotent() {
        val pending = ChatRow(msg(-1, clientId = "c1", isAuthor = true), SendState.PENDING)
        val stored = msg(10, clientId = "c1", isAuthor = true)
        val once = ChatStore.reconcile(listOf(pending), stored)
        assertEquals(once.map { it.message.id }, ChatStore.reconcile(once, stored).map { it.message.id })
    }

    @Test fun reactionToggle() {
        val a = ChatStore.toggled(emptyList(), "❤️")
        assertEquals(listOf(Reaction("❤️", 1, mine = true)), a)
        assertEquals(emptyList<Reaction>(), ChatStore.toggled(a, "❤️"))
        assertEquals(listOf(Reaction("❤️", 3, mine = true)), ChatStore.toggled(listOf(Reaction("❤️", 2)), "❤️"))
    }

    @Test fun decodesSnakeCaseAndIgnoresUnknownFields() {
        val m = ApiJson.decodeFromString<ChatMessage>(
            """{"id":5,"author_id":"u1","author_name":"mazzo","body":"hi","created_at":"2026-10-16T00:00:00Z","is_author":false,"mentions_me":true,"future_field":1}"""
        )
        assertEquals("mazzo", m.authorName)
        assertEquals(true, m.mentionsMe)
        val caps = ApiJson.decodeFromString<Capabilities>("""{"apiVersion":1,"features":{"chat":{"send":true,"edit_own":true,"max_body":1000}}}""")
        assertEquals(true, caps.canEdit)
        assertEquals(false, caps.canReact)
    }
}

class TimelineLogicTest {
    @Test fun mergeKeepsMineAndSetsToggled() {
        val prev = listOf(Reaction("❤️", 2, mine = true), Reaction("👍", 1, mine = false))
        val r = PostReactionToggle(added = true, reactions = listOf(PostReactionToggle.Count("❤️", 2), PostReactionToggle.Count("👍", 2)))
        val out = TimelineStore.merge(r, prev, "👍")
        assertEquals(listOf(true, true), out.map { it.mine })
        assertEquals(listOf(2, 2), out.map { it.count })
    }

    @Test fun relativeTimes() {
        val now = java.time.Instant.parse("2026-10-17T12:00:00Z")
        assertEquals("たった今", relativeTime("2026-10-17T11:59:30Z", now))
        assertEquals("5分前", relativeTime("2026-10-17T11:55:00Z", now))
        assertEquals("3時間前", relativeTime("2026-10-17T09:00:00Z", now))
        assertEquals("", relativeTime("not a date", now))
    }

    @Test fun decodesPostWithIncludes() {
        val p = ApiJson.decodeFromString<Post>(
            """{"id":9,"author_name":"mazzo","author_avatar":"/api/avatar/x","is_author":false,"reply_count":2,"text":"hi","images":["/api/media/a.jpg"],"created_at":"2026-10-17T00:00:00Z","club":"pet","reactions":[{"emoji":"❤️","count":1,"mine":true,"reactors":[]}],"unread":true}"""
        )
        assertEquals(true, p.unread)
        assertEquals(listOf("/api/media/a.jpg"), p.images)
        val caps = ApiJson.decodeFromString<Capabilities>("""{"features":{"posts":{"read":true,"publish":false,"max_images":5}}}""")
        assertEquals(false, caps.canPublish)
        assertEquals(true, caps.hasTimeline)
    }
}
