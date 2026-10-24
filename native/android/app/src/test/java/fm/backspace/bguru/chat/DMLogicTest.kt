package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class DMLogicTest {
    private val now = Instant.parse("2026-10-24T12:00:00Z")
    private fun ago(hours: Long) = now.minusSeconds(hours * 3600).toString()
    private fun msg(id: Long, peer: String = "u1", mine: Boolean = false, clientId: String? = null, createdAt: String = ago(1), body: String = "b") =
        DMMessage(id, fromId = if (mine) "me" else peer, toId = if (mine) peer else "me", peerId = peer, body = body,
            createdAt = createdAt, isAuthor = mine, clientId = clientId)

    @Test fun reconcileReplacesMyPendingBubbleKeepingItsKey() {
        val pending = DMRow(msg(-1, mine = true, clientId = "c1"), SendState.PENDING)
        val out = DMLogic.reconcile(listOf(DMRow(msg(5)), pending), msg(10, mine = true, clientId = "c1"))
        assertEquals(listOf(5L, 10L), out.map { it.message.id })
        assertEquals("c1", out[1].key)
        assertEquals(SendState.SENT, out[1].state)
    }

    @Test fun reconcileTwiceIsOneBubble() {
        // The POST reply and the stream's create both arrive.
        val pending = DMRow(msg(-1, mine = true, clientId = "c1"), SendState.PENDING)
        val once = DMLogic.reconcile(listOf(pending), msg(10, mine = true, clientId = "c1"))
        val twice = DMLogic.reconcile(once, msg(10, mine = true, clientId = "c1"))
        assertEquals(1, twice.size)
        assertEquals(10L, twice[0].message.id)
    }

    @Test fun reconcileNeverMergesTheirMessageIntoMine() {
        val pending = DMRow(msg(-1, mine = true, clientId = "c1"), SendState.PENDING)
        val out = DMLogic.reconcile(listOf(pending), msg(11, mine = false, clientId = "c1"))
        assertEquals(2, out.size)
        assertEquals(SendState.PENDING, out[0].state)
    }

    @Test fun olderThan24HoursIsHiddenButPendingStays() {
        val rows = listOf(
            DMRow(msg(1, createdAt = ago(25))),
            DMRow(msg(2, createdAt = ago(23))),
            DMRow(msg(-1, mine = true, clientId = "c", createdAt = ago(30)), SendState.FAILED),
        )
        assertEquals(listOf(2L, -1L), DMLogic.fresh(rows, now, 24).map { it.message.id })
        assertTrue(DMLogic.isFresh("not a time", now, 24))
        assertFalse(DMLogic.isFresh(ago(24), now, 24))
        val convs = listOf(DMConversation(DMPeer("a"), msg(1, "a", createdAt = ago(25))), DMConversation(DMPeer("b"), msg(2, "b")))
        assertEquals(listOf("b"), DMLogic.freshConversations(convs, now, 24).map { it.peer.userId })
    }

    @Test fun upsertMovesToTopAndCountsUnread() {
        val list = listOf(
            DMConversation(DMPeer("a", "A"), msg(1, "a"), 0),
            DMConversation(DMPeer("b", "B"), msg(2, "b"), 1),
        )
        val out = DMLogic.upsert(list, DMPeer("a", "A"), msg(3, "a"), viewing = false)
        assertEquals(listOf("a", "b"), out.map { it.peer.userId })
        assertEquals(1, out[0].unreadCount)
        assertEquals(3L, out[0].lastMessage.id)
        assertEquals(2, DMLogic.totalUnread(out))
        // On screen: read at once.
        assertEquals(0, DMLogic.upsert(list, null, msg(4, "b"), viewing = true).first().unreadCount)
        // Mine (sent here or on another device): the conversation is read up to it.
        assertEquals(0, DMLogic.upsert(list, null, msg(5, "b", mine = true), viewing = false).first().unreadCount)
        // A new person.
        val fresh = DMLogic.upsert(list, DMPeer("c", "C"), msg(6, "c"), viewing = false)
        assertEquals("C", fresh.first().peer.name)
        assertEquals(1, fresh.first().unreadCount)
        // The same message again (POST reply + stream) does not count twice.
        assertEquals(out, DMLogic.upsert(out, DMPeer("a", "A"), msg(3, "a"), viewing = false))
    }

    @Test fun markReadClearsUpToTheMark() {
        val list = listOf(DMConversation(DMPeer("a"), msg(10, "a"), 3), DMConversation(DMPeer("b"), msg(20, "b"), 2))
        val out = DMLogic.markRead(list, "a", 10)
        assertEquals(0, out[0].unreadCount)
        assertEquals(2, out[1].unreadCount)
        // A mark older than the last message leaves it unread.
        assertEquals(2, DMLogic.markRead(list, "b", 19)[1].unreadCount)
    }

    @Test fun latestStoredIdIgnoresPending() {
        assertEquals(0L, DMLogic.latestStoredId(emptyList()))
        assertEquals(0L, DMLogic.latestStoredId(listOf(DMRow(msg(-2, mine = true, clientId = "x")))))
        assertEquals(7L, DMLogic.latestStoredId(listOf(DMRow(msg(7)), DMRow(msg(-1, mine = true, clientId = "x")))))
    }

    @Test fun notificationTexts() {
        assertEquals("mazzoさんからの DM", DMLogic.notificationTitle("mazzo"))
        assertEquals("会員さんからの DM", DMLogic.notificationTitle(null))
        assertEquals("会員さんからの DM", DMLogic.notificationTitle("  "))
        assertEquals("やあ", DMLogic.notificationText("やあ"))
        val long = DMLogic.notificationText("あ".repeat(300))
        assertEquals("あ".repeat(240) + "…", long)
        assertEquals("あ".repeat(240), DMLogic.notificationText("あ".repeat(240)))
        assertEquals("B-guru DM" to "DM が届きました", PushContent.dmContent("mazzo", null))
        assertEquals("mazzoさんからの DM" to "こんにちは", PushContent.dmContent("mazzo", "こんにちは"))
        assertEquals("B-guru DM", PushContent.defaultTitle("dm"))
        assertEquals("DM が届きました", PushContent.defaultText("dm"))
        assertEquals("DM が届きました", PushContent.publicText("dm"))
        // Older kinds keep their texts.
        assertEquals("B-guru チャット", PushContent.defaultTitle("chat_new"))
    }

    @Test fun notificationIdIsPerPeerAndApartFromOthers() {
        assertEquals(DMLogic.notificationId("u1"), DMLogic.notificationId("u1"))
        assertNotEquals(DMLogic.notificationId("u1"), DMLogic.notificationId("u2"))
        val id = DMLogic.notificationId("some-opaque-id")
        assertTrue(id in 5_000_000 until 6_000_000)
    }

    @Test fun previewMarksMine() {
        assertEquals("あなた: また\nあとで".replace('\n', ' '), DMLogic.preview(msg(1, mine = true, body = "また\nあとで")))
        assertEquals("こんにちは", DMLogic.preview(msg(1, body = " こんにちは ")))
    }

    @Test fun dmPeerOnlyForOthersRealMessages() {
        val m = ChatMessage(5, authorId = "uid-1", authorName = "mazzo", body = "hi")
        assertEquals(DMPeer("uid-1", "mazzo"), m.dmPeer(true))
        assertNull(m.dmPeer(false))
        assertNull(m.copy(isAuthor = true).dmPeer(true))
        assertNull(m.copy(kind = "notice").dmPeer(true))
        assertNull(m.copy(kind = "shogi", shogiGameId = 3).dmPeer(true))
        assertNull(m.copy(authorId = null).dmPeer(true))
        assertNull(m.copy(id = -1).dmPeer(true))
    }

    @Test fun decodesWireShapes() {
        val ev = ApiJson.decodeFromString<DMEvent>(
            """{"action":"create","message":{"id":3,"from_id":"a","to_id":"me","peer_id":"a","body":"x","created_at":"2026-10-24T11:00:00Z","is_author":false},"peer":{"user_id":"a","name":"A","avatar":null},"unread_count":4}"""
        )
        assertEquals("a", ev.message?.peerId)
        assertEquals("A", ev.peer?.name)
        assertEquals(4, ev.unreadCount)
        val read = ApiJson.decodeFromString<DMEvent>("""{"action":"read","peer_id":"a","last_read_id":3,"unread_count":0}""")
        assertEquals(3L, read.lastReadId)
        val ready = ApiJson.decodeFromString<DMReadyEvent>("""{"online":3,"dm":{"unread_count":2}}""")
        assertEquals(2, ready.dm?.unreadCount)
        val caps = ApiJson.decodeFromString<Capabilities>(
            """{"features":{"dm":{"enabled":true,"path":"/api/agent/dm","send":true,"max_body":1000,"ttl_hours":24,"rate_limit_per_hour":60,"stream_event":"dm"}}}"""
        )
        assertTrue(caps.dmEnabled && caps.canSendDM)
        assertEquals(1000, caps.dmMaxBody)
        assertFalse(ApiJson.decodeFromString<Capabilities>("""{"features":{}}""").dmEnabled)
        assertFalse(ApiJson.decodeFromString<Capabilities>("""{"features":{"dm":{"enabled":false}}}""").dmEnabled)
    }
}
