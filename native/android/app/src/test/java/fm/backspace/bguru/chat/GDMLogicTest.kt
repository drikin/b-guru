package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.time.Instant

class GDMLogicTest {
    private val now = Instant.parse("2026-11-06T12:00:00Z")
    private fun ago(hours: Long) = now.minusSeconds(hours * 3600).toString()
    private fun msg(id: Long, group: Long = 1, mine: Boolean = false, clientId: String? = null, createdAt: String = ago(1),
                    body: String = "b", from: String = "u1", system: Boolean = false) =
        GMessage(id, group, if (system) "system" else "text", if (system) null else if (mine) "me" else from,
            if (system) null else from, null, body, createdAt, isAuthor = mine, clientId = clientId)
    private fun group(id: Long, createdAt: String = ago(100), muted: Boolean = false) =
        GDMGroup(id, null, "g$id", listOf(GMember("me", "わたし", isCreator = true, isMe = true), GMember("u1", "mazzo")), 2, isCreator = true, muted = muted, createdAt = createdAt)
    private fun summary(id: Long, last: GMessage? = null, unread: Int = 0) = GroupSummary(group(id), last, unread)

    @Test fun decodesTheServerJson() {
        val json = """{"apiVersion":1,"groups":[{"group":{"id":3,"name":null,"title":"mazzo、takuto","members":[
            {"user_id":"a","name":"me","avatar":null,"is_creator":true,"is_me":true},{"user_id":"b","name":"mazzo","avatar":"https://x/a.png","is_creator":false,"is_me":false}],
            "member_count":2,"is_creator":true,"muted":false,"created_at":"2026-11-06T01:00:00.000Z"},
            "last_message":{"id":9,"group_id":3,"kind":"system","from_id":null,"from_name":null,"from_avatar":null,"body":"me さんがグループを作りました","created_at":"2026-11-06T01:00:00.000Z","is_author":false},
            "unread_count":0}],"group_unread_count":4}"""
        val r = ApiJson.decodeFromString<GDMListResponse>(json)
        assertEquals(4, r.groupUnreadCount)
        val g = r.groups.single().group
        assertEquals("mazzo、takuto", g.displayTitle)
        assertTrue(g.members[0].isMe)
        assertEquals("a", GDMLogic.me(g)?.userId)
        assertTrue(r.groups.single().lastMessage!!.isSystem)

        val ev = ApiJson.decodeFromString<GDMEvent>("""{"action":"read","group_id":3,"last_read_id":9,"unread_count":0,"group_unread_count":1}""")
        assertEquals(3L, ev.groupId); assertEquals(1, ev.groupUnreadCount)
    }

    @Test fun decodesBeagleAnswerAndSwitch() {
        val m = ApiJson.decodeFromString<GMessage>("""{"id":11,"group_id":3,"kind":"text","from_id":"s","from_name":"ビーグル","from_avatar":null,"body":"まとめだわん","created_at":"2026-11-06T01:00:00.000Z","is_author":false,"is_beagle":true}""")
        assertTrue(m.isBeagle); assertEquals("ビーグル", m.senderName); assertTrue(!m.isSystem)
        val g = ApiJson.decodeFromString<GDMGroupResponse>("""{"group":{"id":3,"title":"t","members":[],"beagle":true}}""").group
        assertTrue(g.beagle)
        val old = ApiJson.decodeFromString<GDMGroupResponse>("""{"group":{"id":3,"title":"t","members":[]}}""").group
        assertTrue(!old.beagle)
    }

    @Test fun reconcileReplacesMyPendingBubbleKeepingItsKey() {
        val pending = GRow(msg(-1, mine = true, clientId = "c1"), SendState.PENDING)
        val once = GDMLogic.reconcile(listOf(GRow(msg(5)), pending), msg(10, mine = true, clientId = "c1"))
        assertEquals(listOf(5L, 10L), once.map { it.message.id })
        assertEquals("c1", once[1].key)
        // The POST reply and the stream's create both arrive: still one bubble.
        assertEquals(2, GDMLogic.reconcile(once, msg(10, mine = true, clientId = "c1")).size)
    }

    @Test fun freshKeepsTheGroupButNotAnOldLastMessage() {
        val rows = listOf(GRow(msg(1, createdAt = ago(31 * 24))), GRow(msg(2)), GRow(msg(-1, mine = true, createdAt = ago(40 * 24)), SendState.FAILED))
        assertEquals(listOf(2L, -1L), GDMLogic.fresh(rows, now, 30 * 24).map { it.message.id })
        val s = GDMLogic.freshSummaries(listOf(summary(1, msg(1, createdAt = ago(31 * 24)), unread = 2)), now, 30 * 24).single()
        assertNull(s.lastMessage)
        assertEquals(0, s.unreadCount)
    }

    @Test fun inboxMixesOneToOneAndGroupsNewestFirst() {
        val dm = DMConversation(DMPeer("p"), DMMessage(1, peerId = "p", body = "x", createdAt = ago(2)))
        val withMsg = summary(1, msg(5, createdAt = ago(1)))
        val empty = GroupSummary(group(2, createdAt = ago(3)))
        val newEmpty = GroupSummary(group(3, createdAt = ago(0)))
        val keys = GDMLogic.mergeInbox(listOf(dm), listOf(empty, withMsg, newEmpty)).map { it.key }
        assertEquals(listOf("gdm-3", "gdm-1", "dm-p", "gdm-2"), keys)
    }

    @Test fun upsertCountsOnlyOthersTextAndUnknownGroupsReload() {
        val list = listOf(summary(1, msg(5)), summary(2, msg(6, group = 2)))
        val a = GDMLogic.upsert(list, msg(7, group = 2), viewing = false)!!
        assertEquals(listOf(2L, 1L), a.map { it.group.id })
        assertEquals(1, a[0].unreadCount)
        assertEquals(1, GDMLogic.upsert(a, msg(8, group = 2, system = true), viewing = false)!![0].unreadCount)
        assertEquals(0, GDMLogic.upsert(a, msg(9, group = 2, mine = true), viewing = false)!![0].unreadCount)
        assertEquals(0, GDMLogic.upsert(a, msg(9, group = 2), viewing = true)!![0].unreadCount)
        // An older / same message changes nothing.
        assertEquals(a, GDMLogic.upsert(a, msg(7, group = 2), viewing = false))
        assertNull(GDMLogic.upsert(list, msg(10, group = 99), viewing = false))

        assertTrue(GDMLogic.countsAsUnread(list, msg(7, group = 2), viewing = false))
        assertFalse(GDMLogic.countsAsUnread(list, msg(7, group = 2, system = true), viewing = false))
        assertFalse(GDMLogic.countsAsUnread(list, msg(6, group = 2), viewing = false))
        assertFalse(GDMLogic.countsAsUnread(list, msg(7, group = 2, mine = true), viewing = false))
    }

    @Test fun markReadApplyGroupRemoveAndTotals() {
        val list = listOf(summary(1, msg(5), 2), summary(2, msg(9, group = 2), 3))
        assertEquals(listOf(0, 3), GDMLogic.markRead(list, 1, 5).map { it.unreadCount })
        assertEquals(listOf(2, 3), GDMLogic.markRead(list, 2, 8).map { it.unreadCount })
        assertEquals(5, GDMLogic.totalUnread(list))
        val renamed = group(1).copy(title = "新しい名前", muted = true)
        assertEquals("新しい名前", GDMLogic.applyGroup(list, renamed)[0].group.title)
        val added = GDMLogic.applyGroup(list, group(7))
        assertEquals(7L, added[0].group.id); assertNull(added[0].lastMessage)
        assertEquals(listOf(2L), GDMLogic.remove(list, 1).map { it.group.id })
    }

    @Test fun previewAndNotificationTexts() {
        assertEquals("まだメッセージはありません", GDMLogic.preview(null))
        assertEquals("あなた: a b", GDMLogic.preview(msg(1, mine = true, body = "a\nb")))
        assertEquals("mazzo: hi", GDMLogic.preview(msg(1, from = "mazzo", body = "hi")))
        assertEquals("A さんが入りました", GDMLogic.preview(msg(1, system = true, body = "A さんが入りました")))
        assertEquals("配信の相談", GDMLogic.notificationTitle("配信の相談"))
        assertEquals(GDMLogic.FALLBACK_TITLE, GDMLogic.notificationTitle(" "))
        assertEquals("mazzo: こんにちは", GDMLogic.notificationText("mazzo", "こんにちは"))
        assertEquals("会員: x", GDMLogic.notificationText(null, "x"))
        assertTrue(GDMLogic.notificationText("a", "y".repeat(300)).endsWith("…"))
        assertEquals(listOf("2", "3", "4", "5", "6"), GDMLogic.notificationLines(listOf("1", "2", "3", "4", "5"), "6"))
        // Its own id range (not the DM 5_000_000…, the handoff 7_000_000).
        assertEquals(8_000_042, GDMLogic.notificationId(42))
    }

    @Test fun pickerExcludesMeBeagleAndMembersAndMixesDMPeers() {
        val members = listOf(MentionMember("sys", "ビーグル", "/icon-192.png"), MentionMember("me", "わたし"), MentionMember("u1", "mazzo"),
            MentionMember("u2", "Takuto"), MentionMember("u3", "NORIO TAKAHASHI"))
        val peers = listOf(DMPeer("u9", "ちい"), DMPeer("u2", "Takuto"))
        val all = GDMLogic.candidates(members, peers)
        assertEquals(listOf("u9", "u2", "sys", "me", "u1", "u3"), all.map { it.userId })
        assertEquals(listOf("u9", "u2", "u3"), GDMLogic.pickable(all, setOf("me", "u1"), "").map { it.userId })
        assertEquals(listOf("u2"), GDMLogic.pickable(all, emptySet(), "taku").map { it.userId })
        assertEquals(listOf("u3"), GDMLogic.pickable(all, emptySet(), "norio taka").map { it.userId })
    }

    @Test fun removeIsForTheCreatorAndNeverMyself() {
        val g = group(1)
        assertTrue(GDMLogic.canRemove(g, g.members[1]))
        assertFalse(GDMLogic.canRemove(g, g.members[0]))
        assertFalse(GDMLogic.canRemove(g.copy(isCreator = false), g.members[1]))
        assertEquals("あいう", GDMLogic.cleanName("  あいうえお ", 3))
        assertEquals("", GDMLogic.cleanName("   ", 40))
    }

    @Test fun capabilitiesGateIt() {
        assertFalse(Capabilities().gdmEnabled)
        val dmOnly = Capabilities(features = Capabilities.Features(dm = Capabilities.DMFeatures(enabled = true)))
        assertFalse(dmOnly.gdmEnabled)
        val both = Capabilities(features = Capabilities.Features(dm = Capabilities.DMFeatures(enabled = true),
            gdm = Capabilities.GDMFeatures(enabled = true, send = true, maxName = 40, ttlHours = 720, path = "https://evil/x")))
        assertTrue(both.gdmEnabled); assertTrue(both.canSendGDM)
        assertEquals("/api/agent/gdm", both.gdmPath)
        assertEquals(720, both.gdmTtlHours)
        // gdm without dm (should not happen): off.
        assertFalse(Capabilities(features = Capabilities.Features(gdm = Capabilities.GDMFeatures(enabled = true))).gdmEnabled)
    }

    @Test fun pickerNeverShowsTheWholeList() {
        val all = (0 until 50).map { MentionMember("u$it", if (it == 0) "ビーグル" else "会員$it", null) }
        assertEquals(listOf("u3", "u7"), GDMLogic.pickerList(all, setOf("u3", "u7"), emptyList(), emptySet(), "").map { it.userId })
        assertTrue(GDMLogic.pickerList(all, emptySet(), emptyList(), emptySet(), " ").isEmpty())
        val typed = GDMLogic.pickerList(all, emptySet(), listOf("u2"), setOf("u1"), "会員")
        assertEquals("u2", typed.first().userId)
        assertEquals(1 + GDMLogic.PICKER_LIMIT, typed.size)
        assertTrue(typed.none { it.userId == "u1" })
        assertTrue(GDMLogic.pickerList(all, emptySet(), emptyList(), emptySet(), "ビーグル").isEmpty())
    }

    @Test fun groupPhoto() {
        val g = ApiJson.decodeFromString<GDMGroupResponse>(
            """{"group":{"id":3,"name":"配信","photo":"/api/gdm/3/photo?v=g3-0123456789abcdef","title":"配信","members":[],"member_count":3,"is_creator":false,"muted":false,"created_at":"2026-11-06T01:00:00.000Z"}}""").group
        assertEquals("/api/gdm/3/photo?v=g3-0123456789abcdef", GDMLogic.photoUrl(g))
        assertEquals("写真を変える", GDMLogic.photoButtonLabel(g))
        // None, blank or not our own server's relative path: 👥 (the token is never sent elsewhere).
        val none = group(1)
        assertNull(none.photo)
        assertNull(GDMLogic.photoUrl(none))
        assertNull(GDMLogic.photoUrl(null))
        assertEquals("写真を設定", GDMLogic.photoButtonLabel(none))
        assertNull(GDMLogic.photoUrl(none.copy(photo = "  ")))
        assertNull(GDMLogic.photoUrl(none.copy(photo = "https://evil.example/x.webp")))
        assertNull(GDMLogic.photoUrl(none.copy(photo = "//evil.example/x.webp")))
        // A `group` event carries the new photo (and its removal).
        val list = listOf(summary(1))
        val withPhoto = GDMLogic.applyGroup(list, none.copy(photo = "/api/gdm/1/photo?v=a"))
        assertEquals("/api/gdm/1/photo?v=a", withPhoto.single().group.photo)
        assertNull(GDMLogic.applyGroup(withPhoto, none).single().group.photo)
    }

    @Test fun groupPhotoSize() {
        assertNull(GDMLogic.photoSizeError(200_000, 15L * 1024 * 1024))
        assertEquals("写真が大きすぎます", GDMLogic.photoSizeError(2_000_001, 2_000_000))
        assertEquals("写真を読み込めませんでした", GDMLogic.photoSizeError(0, 2_000_000))
    }

    @Test fun groupPhotoCapability() {
        fun caps(photo: Boolean?, send: Boolean = true, max: Long? = null) = Capabilities(features = Capabilities.Features(
            dm = Capabilities.DMFeatures(enabled = true),
            gdm = Capabilities.GDMFeatures(enabled = true, send = send, photo = photo, photoMaxBytes = max)))
        assertTrue(caps(true).canSetGDMPhoto)
        assertFalse(caps(null).canSetGDMPhoto)
        assertFalse(caps(false).canSetGDMPhoto)
        assertFalse(caps(true, send = false).canSetGDMPhoto)
        assertEquals(15L * 1024 * 1024, caps(true).gdmPhotoMaxBytes)
        assertEquals(1000L, caps(true, max = 1000).gdmPhotoMaxBytes)
        val decoded = ApiJson.decodeFromString<Capabilities>("""{"features":{"dm":{"enabled":true},"gdm":{"enabled":true,"send":true,"photo":true,"photo_max_bytes":15728640}}}""")
        assertTrue(decoded.canSetGDMPhoto)
        assertEquals(15728640L, decoded.gdmPhotoMaxBytes)
    }
}
