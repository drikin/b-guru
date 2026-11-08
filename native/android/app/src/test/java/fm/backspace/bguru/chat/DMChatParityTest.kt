package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** ✉️👥 DM をチャットと同じに (docs/dm-chat-parity-spec.md): ✏️ edit, 😀 reactions, ↩️ reply, @ mentions. */
class DMChatParityTest {
    private fun dm(id: Long, mine: Boolean = false, body: String = "b", images: List<String> = emptyList(), reactions: List<Reaction> = emptyList()) =
        DMMessage(id, peerId = "u1", body = body, isAuthor = mine, images = images, reactions = reactions)
    private fun gm(id: Long, mine: Boolean = false, kind: String = "text", beagle: Boolean = false, name: String? = "mazzo", body: String = "b") =
        GMessage(id, groupId = 1, kind = kind, fromId = if (mine) "me" else "u1", fromName = name, body = body, isAuthor = mine, isBeagle = beagle)

    // MARK: wire

    @Test fun oldServerDtosDecodeWithDefaults() {
        val d = ApiJson.decodeFromString<DMMessage>("""{"id":1,"body":"hi"}""")
        assertFalse(d.edited); assertNull(d.editedAt); assertEquals(emptyList<Reaction>(), d.reactions)
        val g = ApiJson.decodeFromString<GMessage>("""{"id":1,"body":"hi"}""")
        assertFalse(g.edited); assertNull(g.editedAt); assertEquals(emptyList<Reaction>(), g.reactions)
    }

    @Test fun newDtosDecodeEditAndReactions() {
        val d = ApiJson.decodeFromString<DMMessage>(
            """{"id":1,"body":"hi","edited":true,"edited_at":"2026-11-08T01:00:00Z","reactions":[{"emoji":":parrot:","count":2,"mine":true,"reactors":["a","b"]}]}""")
        assertTrue(d.edited)
        assertEquals("2026-11-08T01:00:00Z", d.editedAt)
        assertEquals(Reaction(":parrot:", 2, true, listOf("a", "b")), d.reactions.single())
    }

    @Test fun streamEventsDecode() {
        val e = ApiJson.decodeFromString<DMEvent>("""{"action":"reaction","peer_id":"u1","message_id":7,"reactions":[{"emoji":"👍","count":1,"mine":false,"reactors":["x"]}]}""")
        assertEquals(7L, e.messageId); assertEquals("👍", e.reactions!!.single().emoji)
        val g = ApiJson.decodeFromString<GDMEvent>("""{"action":"edit","group_id":3,"message":{"id":9,"group_id":3,"body":"new","edited":true}}""")
        assertEquals("new", g.message!!.body); assertTrue(g.message!!.edited)
    }

    @Test fun capabilitiesGateEditAndReactions() {
        assertFalse(Capabilities().canEditDM)
        // An older server (no edit / reactions keys): hidden.
        val old = ApiJson.decodeFromString<Capabilities>("""{"features":{"dm":{"enabled":true,"send":true},"gdm":{"enabled":true,"send":true}}}""")
        assertFalse(old.canEditDM); assertFalse(old.canReactDM); assertFalse(old.canEditGDM); assertFalse(old.canReactGDM)
        val new = ApiJson.decodeFromString<Capabilities>(
            """{"features":{"dm":{"enabled":true,"send":true,"edit":true,"reactions":true},"gdm":{"enabled":true,"send":true,"edit":true,"reactions":true}}}""")
        assertTrue(new.canEditDM); assertTrue(new.canReactDM); assertTrue(new.canEditGDM); assertTrue(new.canReactGDM)
        // A token without the chat scope (send false) cannot write either.
        val readOnly = ApiJson.decodeFromString<Capabilities>("""{"features":{"dm":{"enabled":true,"send":false,"edit":true,"reactions":true}}}""")
        assertFalse(readOnly.canEditDM); assertFalse(readOnly.canReactDM)
    }

    // MARK: applying edits / reactions

    @Test fun editReplacesTheBubbleKeepingItsKeyAndState() {
        val rows = listOf(DMRow(dm(1)), DMRow(dm(2, mine = true).copy(clientId = "c2")))
        val out = DMLogic.applyEdit(rows, dm(2, mine = true, body = "fixed").copy(edited = true))
        assertEquals("fixed", out[1].message.body)
        assertTrue(out[1].message.edited)
        assertEquals("c2", out[1].key)
        assertEquals("c2", out[1].message.clientId)
        assertEquals(rows[0], out[0])
    }

    @Test fun editOfAMessageNotOnScreenChangesNothing() {
        val rows = listOf(DMRow(dm(1)))
        assertEquals(rows, DMLogic.applyEdit(rows, dm(99, body = "x")))
        val g = listOf(GRow(gm(1)))
        assertEquals(g, GDMLogic.applyEdit(g, gm(99, body = "x")))
    }

    @Test fun reactionEventReplacesOnlyThatMessagesChips() {
        val r = listOf(Reaction("👍", 2, true, listOf("a", "me")))
        val rows = listOf(DMRow(dm(1)), DMRow(dm(2)))
        val out = DMLogic.applyReactions(rows, 2, r)
        assertEquals(emptyList<Reaction>(), out[0].message.reactions)
        assertEquals(r, out[1].message.reactions)
        val g = GDMLogic.applyReactions(listOf(GRow(gm(5))), 5, r)
        assertEquals(r, g[0].message.reactions)
    }

    @Test fun listPreviewFollowsAnEditOfTheLastMessage() {
        val list = listOf(DMConversation(DMPeer("u1"), dm(3, body = "old")), DMConversation(DMPeer("u2"), dm(4, body = "keep")))
        val out = DMLogic.editConversation(list, dm(3, body = "new").copy(edited = true))
        assertEquals("new", out[0].lastMessage.body)
        assertEquals("keep", out[1].lastMessage.body)
        val groups = listOf(GroupSummary(GDMGroup(1), gm(8, body = "old")), GroupSummary(GDMGroup(2), null))
        val g = GDMLogic.editSummaries(groups, gm(8, body = "new"))
        assertEquals("new", g[0].lastMessage!!.body)
        assertNull(g[1].lastMessage)
    }

    @Test fun optimisticToggleAndRollback() {
        val start = listOf(Reaction("👍", 1, mine = false))
        val on = ChatStore.toggled(start, "👍")
        assertEquals(Reaction("👍", 2, mine = true), on.single())
        val off = ChatStore.toggled(on, "👍")
        assertEquals(start, off)
        val added = ChatStore.toggled(emptyList(), ":parrot:")
        assertEquals(Reaction(":parrot:", 1, mine = true), added.single())
        assertEquals(emptyList<Reaction>(), ChatStore.toggled(added, ":parrot:"))
        // Rollback = putting the old list back on the row.
        val rows = DMLogic.applyReactions(listOf(DMRow(dm(1, reactions = start))), 1, on)
        assertEquals(start, DMLogic.applyReactions(rows, 1, start)[0].message.reactions)
    }

    // MARK: who may do what

    @Test fun dmEditOnlyMyStoredMessages() {
        assertTrue(DMLogic.canEdit(DMRow(dm(1, mine = true))))
        assertFalse(DMLogic.canEdit(DMRow(dm(1, mine = false))))
        assertFalse(DMLogic.canEdit(DMRow(dm(-1, mine = true), SendState.PENDING)))
        assertFalse(DMLogic.canEdit(DMRow(dm(1, mine = true), SendState.FAILED)))
    }

    @Test fun anEditMayEmptyTheTextOnlyWithPhotos() {
        assertTrue(DMLogic.canSaveEdit("x", false))
        assertFalse(DMLogic.canSaveEdit("  ", false))
        assertTrue(DMLogic.canSaveEdit("", true))
    }

    @Test fun groupRules() {
        assertTrue(GDMLogic.canEdit(GRow(gm(1, mine = true))))
        assertFalse(GDMLogic.canEdit(GRow(gm(1, mine = false))))
        assertFalse(GDMLogic.canEdit(GRow(gm(1, mine = true, kind = "system"))))
        assertFalse(GDMLogic.canEdit(GRow(gm(1, mine = true, beagle = true))))
        // Reactions: not on system lines; Beagle's answers yes.
        assertTrue(GDMLogic.canReact(GRow(gm(1, beagle = true))))
        assertFalse(GDMLogic.canReact(GRow(gm(1, kind = "system", name = null))))
        assertFalse(GDMLogic.canReact(GRow(gm(-1, mine = true), SendState.PENDING)))
        // 返信: someone else's message, not Beagle's, not a system line.
        assertTrue(GDMLogic.canReply(GRow(gm(1))))
        assertFalse(GDMLogic.canReply(GRow(gm(1, mine = true))))
        assertFalse(GDMLogic.canReply(GRow(gm(1, beagle = true))))
        assertFalse(GDMLogic.canReply(GRow(gm(1, kind = "system", name = null))))
    }

    @Test fun mentionsMe() {
        assertTrue(GDMLogic.mentionsMe("@ドリキン さん見ました？", "ドリキン"))
        assertTrue(GDMLogic.mentionsMe("見た @ドリキン", "ドリキン"))
        assertTrue(GDMLogic.mentionsMe("@[Drikin Aoki] hi", "Drikin Aoki"))
        assertTrue(GDMLogic.mentionsMe("@drikin hi", "Drikin"))
        assertFalse(GDMLogic.mentionsMe("@ドリキンさん", "ドリキン")) // another name (the chat's @-token runs to a space)
        assertFalse(GDMLogic.mentionsMe("mail@ドリキン", "ドリキン"))
        assertFalse(GDMLogic.mentionsMe("@mazzo", "ドリキン"))
        assertFalse(GDMLogic.mentionsMe("@ドリキン", null))
    }

    // MARK: the stores in demo (offline: a network call would need the Main dispatcher and fail here)

    @Test fun dmStoreAppliesStreamEditAndReactionAndTogglesOffline() {
        val s = DMStore(ApiClient("test"))
        s.loadDemo()
        s.openConversation(DMPeer("mazzo", "mazzo"))
        val target = s.rows.first { !it.message.isAuthor }.message
        s.apply("""{"action":"edit","message":{"id":${target.id},"peer_id":"mazzo","body":"直しました","edited":true}}""")
        assertEquals("直しました", s.rows.first { it.message.id == target.id }.message.body)
        assertTrue(s.rows.first { it.message.id == target.id }.message.edited)
        s.apply("""{"action":"reaction","peer_id":"mazzo","message_id":${target.id},"reactions":[{"emoji":"🎉","count":1,"mine":false,"reactors":["mazzo"]}]}""")
        assertEquals("🎉", s.rows.first { it.message.id == target.id }.message.reactions.single().emoji)
        s.toggleReaction(target.id, "🎉")
        assertEquals(Reaction("🎉", 2, mine = true, reactors = listOf("mazzo")), s.rows.first { it.message.id == target.id }.message.reactions.single())
        // Unknown actions are ignored.
        s.apply("""{"action":"something_new","message_id":1}""")
        // ✏️ my own message, offline.
        val mine = s.rows.last { it.message.isAuthor && it.message.id > 0 }.message
        s.edit(mine.id, "  タイポ修正  ")
        assertEquals("タイポ修正", s.rows.first { it.message.id == mine.id }.message.body)
        assertTrue(s.rows.first { it.message.id == mine.id }.message.edited)
        // Someone else's message cannot be edited.
        s.edit(target.id, "乗っ取り")
        assertEquals("直しました", s.rows.first { it.message.id == target.id }.message.body)
    }

    @Test fun groupStoreAppliesStreamEditAndReactionAndTogglesOffline() {
        val s = DMStore(ApiClient("test"))
        s.loadDemo()
        s.openGroup(1)
        val g = s.groups
        val theirs = g.rows.first { !it.message.isAuthor && !it.message.isSystem }.message
        g.apply("""{"action":"reaction","group_id":1,"message_id":${theirs.id},"reactions":[{"emoji":"👍","count":3,"mine":false,"reactors":["a","b","c"]}]}""")
        assertEquals(3, g.rows.first { it.message.id == theirs.id }.message.reactions.single().count)
        g.toggleReaction(theirs.id, "👍")
        assertTrue(g.rows.first { it.message.id == theirs.id }.message.reactions.single().mine)
        g.apply("""{"action":"edit","group_id":1,"message":{"id":${theirs.id},"group_id":1,"body":"edited","edited":true}}""")
        assertEquals("edited", g.rows.first { it.message.id == theirs.id }.message.body)
        // System lines take no reactions.
        val sys = g.rows.first { it.message.isSystem }.message
        g.toggleReaction(sys.id, "👍")
        assertEquals(emptyList<Reaction>(), g.rows.first { it.message.id == sys.id }.message.reactions)
        val mine = g.rows.first { it.message.isAuthor }.message
        g.edit(mine.id, "直した")
        assertEquals("直した", g.rows.first { it.message.id == mine.id }.message.body)
    }
}
