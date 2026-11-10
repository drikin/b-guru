package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/** 🌐 パブリック DM と 🗄 アーカイブ (docs/group-dm-spec.md). */
class GDMPublicTest {
    private fun group(id: Long, public: Boolean = false, member: Boolean = true, archived: Boolean = false, creator: Boolean = true) =
        GDMGroup(id, "g$id", "g$id", listOf(GMember("me", "わたし", isCreator = creator, isMe = true), GMember("u1", "mazzo")), 2,
            isCreator = creator, createdAt = "2026-11-09T01:00:00Z", isPublic = public, isMember = member, archived = archived)
    private fun msg(id: Long, group: Long) = GMessage(id, group, body = "b", createdAt = "2026-11-09T02:00:00Z")
    private fun s(g: GDMGroup, unread: Int = 0, last: GMessage? = null) = GroupSummary(g, last, unread)

    @Test fun decodesTheNewFields() {
        val json = """{"apiVersion":1,
            "groups":[{"group":{"id":1,"title":"a","members":[],"is_public":true,"is_member":true,"archived":false,"archived_at":null},"last_message":null,"unread_count":2}],
            "public_groups":[{"group":{"id":2,"title":"b","members":[],"is_public":true,"is_member":false,"archived":false,"archived_at":null},"last_message":null,"unread_count":0,"is_new":true}],
            "archived_groups":[{"group":{"id":3,"title":"c","members":[],"is_public":true,"is_member":true,"archived":true,"archived_at":"2026-11-09T03:00:00.000Z"},"last_message":null,"unread_count":0}],
            "group_unread_count":2}"""
        val r = ApiJson.decodeFromString<GDMListResponse>(json)
        assertTrue(r.groups.single().group.isPublic)
        assertTrue(r.groups.single().group.isMember)
        val p = r.publicGroups.single()
        assertTrue(p.isNew); assertFalse(p.group.isMember)
        val a = r.archivedGroups.single().group
        assertTrue(a.archived); assertEquals("2026-11-09T03:00:00.000Z", a.archivedAt)
    }

    @Test fun olderServersSendNoneOfThem() {
        val r = ApiJson.decodeFromString<GDMListResponse>("""{"groups":[{"group":{"id":1,"title":"a","members":[]},"unread_count":1}],"group_unread_count":1}""")
        val g = r.groups.single().group
        assertFalse(g.isPublic); assertTrue(g.isMember); assertFalse(g.archived); assertEquals(null, g.archivedAt)
        assertFalse(r.groups.single().isNew)
        assertTrue(r.publicGroups.isEmpty()); assertTrue(r.archivedGroups.isEmpty())
        val l = GDMLogic.lists(r)
        assertEquals(listOf(1L), l.groups.map { it.group.id })
        assertEquals(GDMComposerMode.NORMAL, GDMLogic.composerMode(g))
        assertEquals("👥", GDMLogic.mark(g))
    }

    @Test fun capabilitiesGateThePublicAndArchiveControls() {
        val on = ApiJson.decodeFromString<Capabilities>("""{"features":{"dm":{"enabled":true},"gdm":{"enabled":true,"send":true,"public":true,"archive":true,"public_max_members":500}}}""")
        assertTrue(on.gdmPublic); assertTrue(on.gdmArchive); assertEquals(500, on.gdmPublicMaxMembers)
        val old = ApiJson.decodeFromString<Capabilities>("""{"features":{"dm":{"enabled":true},"gdm":{"enabled":true,"send":true}}}""")
        assertFalse(old.gdmPublic); assertFalse(old.gdmArchive); assertEquals(1000, old.gdmPublicMaxMembers)
        val off = ApiJson.decodeFromString<Capabilities>("""{"features":{"dm":{"enabled":true},"gdm":{"enabled":false,"public":true,"archive":true}}}""")
        assertFalse(off.gdmPublic); assertFalse(off.gdmArchive)
    }

    @Test fun listsPutEachGroupOnceWhereItsFlagsSay() {
        val r = GDMListResponse(
            groups = listOf(s(group(1)), s(group(2, public = true)), s(group(9, public = true, archived = true), unread = 3)),
            publicGroups = listOf(s(group(3, public = true, member = false), unread = 4), s(group(2, public = true))),
            archivedGroups = listOf(s(group(4, public = true, archived = true)), s(group(5, public = true, member = false, archived = true))),
        )
        val l = GDMLogic.lists(r)
        assertEquals(listOf(1L, 2L), l.groups.map { it.group.id })
        assertEquals(listOf(3L), l.publicGroups.map { it.group.id })
        assertEquals(0, l.publicGroups.single().unreadCount)
        assertEquals(listOf(9L, 4L, 5L), l.archivedGroups.map { it.group.id })
        assertTrue(l.archivedGroups.all { it.unreadCount == 0 })
    }

    @Test fun placeMovesAGroupBetweenSectionsKeepingItsLastMessage() {
        val last = msg(50, 2)
        val start = GDMLists(listOf(s(group(1)), s(group(2, public = true), unread = 2, last = last)), listOf(s(group(3, public = true, member = false))), emptyList())

        // Archived (a `group` event or my PATCH): out of mine, into アーカイブ, no unread.
        val archived = GDMLogic.place(start, group(2, public = true, archived = true))
        assertEquals(listOf(1L), archived.groups.map { it.group.id })
        assertEquals(listOf(2L), archived.archivedGroups.map { it.group.id })
        assertEquals(last, archived.archivedGroups.single().lastMessage)
        assertEquals(0, archived.archivedGroups.single().unreadCount)

        // Brought back: mine again.
        val back = GDMLogic.place(archived, group(2, public = true))
        assertEquals(setOf(1L, 2L), back.groups.map { it.group.id }.toSet())
        assertTrue(back.archivedGroups.isEmpty())

        // Joined: from パブリック DM to mine.
        val joined = GDMLogic.place(start, group(3, public = true))
        assertEquals(setOf(1L, 2L, 3L), joined.groups.map { it.group.id }.toSet())
        assertTrue(joined.publicGroups.isEmpty())

        // is_member false: out of mine, under パブリック DM.
        val left = GDMLogic.place(start, group(2, public = true, member = false))
        assertEquals(listOf(1L), left.groups.map { it.group.id })
        assertEquals(setOf(2L, 3L), left.publicGroups.map { it.group.id }.toSet())

        // A private group I am not in (never sent; just in case): gone everywhere.
        val gone = GDMLogic.place(start, group(1, member = false))
        assertEquals(listOf(2L), gone.groups.map { it.group.id })

        // A plain update of mine stays in place with its unread (what older servers always send).
        val renamed = GDMLogic.place(start, group(2, public = true).copy(title = "新しい名前"))
        assertEquals(listOf(1L, 2L), renamed.groups.map { it.group.id })
        assertEquals("新しい名前", renamed.groups[1].group.title)
        assertEquals(2, renamed.groups[1].unreadCount)
    }

    @Test fun composerModeAndWhatTheMembersScreenOffers() {
        val mine = group(1, public = true)
        val notJoined = group(2, public = true, member = false)
        val archived = group(3, public = true, archived = true)
        val archivedNotJoined = group(4, public = true, member = false, archived = true)
        val private = group(5)
        assertEquals(GDMComposerMode.NORMAL, GDMLogic.composerMode(mine))
        assertEquals(GDMComposerMode.JOIN, GDMLogic.composerMode(notJoined))
        assertEquals(GDMComposerMode.ARCHIVED, GDMLogic.composerMode(archived))
        assertEquals(GDMComposerMode.ARCHIVED, GDMLogic.composerMode(archivedNotJoined))
        assertEquals(GDMComposerMode.NORMAL, GDMLogic.composerMode(private))
        assertEquals(GDMComposerMode.NORMAL, GDMLogic.composerMode(null))

        assertTrue(GDMLogic.canChangeSettings(mine))
        assertFalse(GDMLogic.canChangeSettings(notJoined))
        assertFalse(GDMLogic.canChangeSettings(archived))
        assertTrue(GDMLogic.canChangeSettings(private))

        assertTrue(GDMLogic.canArchive(mine)); assertTrue(GDMLogic.canArchive(archived))
        assertFalse(GDMLogic.canArchive(notJoined)); assertFalse(GDMLogic.canArchive(private))

        // 外す: never in a public DM, even for its creator.
        val other = mine.members.first { !it.isMe }
        assertFalse(GDMLogic.canRemove(mine, other))
        assertTrue(GDMLogic.canRemove(private, other))

        assertEquals("🌐", GDMLogic.mark(mine)); assertEquals("👥", GDMLogic.mark(private))
    }

    @Test fun makingAPublicDMNeedsANameButNobodyElse() {
        assertTrue(GDMLogic.canCreate(public = true, name = "雑談", picked = 0, maxName = 40))
        assertFalse(GDMLogic.canCreate(public = true, name = "  ", picked = 3, maxName = 40))
        assertFalse(GDMLogic.canCreate(public = false, name = "雑談", picked = 0, maxName = 40))
        assertTrue(GDMLogic.canCreate(public = false, name = "", picked = 1, maxName = 40))
    }
}
