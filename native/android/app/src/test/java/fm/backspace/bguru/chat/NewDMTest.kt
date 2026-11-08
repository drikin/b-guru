package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** ＋ 新規 DM: the name field's candidates (the member total stays private). */
class NewDMTest {
    private val members = listOf(
        MentionMember("me", "ドリキン"),
        MentionMember("mazzo", "mazzo"),
        MentionMember("takuto", "takuto"),
        MentionMember("coban", "coban"),
        MentionMember("beagle", "ビーグル"),
    ) + (1..20).map { MentionMember("u$it", "taro$it") }
    private val peers = listOf(DMPeer("mazzo", "mazzo"), DMPeer("old", "昔の人"))

    @Test fun nothingTypedShowsOnlyMyDMPartners() {
        assertEquals(listOf("mazzo", "old"), DMLogic.newDMCandidates(members, peers, "me", "").map { it.userId })
        assertEquals(emptyList<String>(), DMLogic.newDMCandidates(members, emptyList(), "me", "  ").map { it.userId })
    }

    @Test fun typingFindsMembersByNameNeverMeNorBeagle() {
        assertEquals(listOf("coban"), DMLogic.newDMCandidates(members, peers, "me", "COB").map { it.userId })
        assertEquals(listOf("old"), DMLogic.newDMCandidates(members, peers, "me", "昔").map { it.userId })
        assertTrue(DMLogic.newDMCandidates(members, peers, "me", "ドリ").isEmpty())
        assertTrue(DMLogic.newDMCandidates(members, peers, "me", "ビーグル").isEmpty())
    }

    @Test fun matchesAreCapped() {
        assertEquals(GDMLogic.PICKER_LIMIT, DMLogic.newDMCandidates(members, peers, "me", "taro").size)
    }
}
