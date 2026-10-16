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
