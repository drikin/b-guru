package fm.backspace.bguru.chat

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 部活で絞り込む（リュー 2026-11-09「タイムラインからさらに左側にスワイプすると部活一覧が出るようにしても良いかも」
 *  → オーナー「全アプリに作る」）: the list of one club, the clubs offered, and pages for an older choice dropped. */
class ClubFilterTest {
    private val clubs = linkedMapOf("pet" to "ペット部", "apple" to "リンゴ部", "car" to "クルマ部")
    private val pet = Post(1, authorName = "mazzo", text = "犬", club = "pet")
    private val apple = Post(2, authorName = "takuto", text = "林檎", club = "apple")
    private val car = Post(3, authorName = "coban", text = "車", club = "car")

    private class Ops(val hidden: Set<String>) : PostOpsApi {
        override suspend fun toggleBookmark(postId: Long) = true
        override suspend fun setBookmark(postId: Long, on: Boolean) = on
        override suspend fun setFavorite(userId: String, on: Boolean) = on
        override suspend fun togglePin(id: Long) = true
        override suspend fun setClub(id: Long, key: String?) = key
        override suspend fun hiddenClubs(path: String) = hidden
        override suspend fun setClubHidden(path: String, club: String, hidden: Boolean) = hidden
        override suspend fun setAllClubsHidden(path: String, hidden: Boolean) = emptySet<String>()
        override suspend fun mutedWords(path: String) = MutedWordsResponse(emptyList(), 50, 40)
        override suspend fun setMutedWords(path: String, words: List<String>) = words
        override suspend fun vote(id: Long, optionId: Long): PostPoll? = null
        override suspend fun togglePostReaction(id: Long, emoji: String) = PostReactionToggle(true, emptyList())
        var order = listOf<String>()
        var failSave = false
        val saved = mutableListOf<List<String>>()
        override suspend fun clubOrder(path: String) = order
        override suspend fun setClubOrder(path: String, order: List<String>): List<String> {
            if (failSave) throw ApiError.Http(500, null, null)
            saved += order; this.order = order; return order
        }
        override suspend fun clubUnread(path: String) = mapOf("pet" to 2, "car" to 7, "__unset__" to 4, "apple" to 0)
    }

    private fun store(hidden: Set<String> = emptySet()): TimelineStore {
        val s = TimelineStore(ApiClient("test"), Ops(hidden), Dispatchers.Unconfined)
        s.testClubs(clubs)
        s.capabilities = ApiJson.decodeFromString("""{"features":{"posts":{"club_visibility":"/api/agent/clubs/visibility"}}}""")
        return s
    }

    private fun waitFor(what: () -> Boolean) {
        val until = System.currentTimeMillis() + 3000
        while (!what() && System.currentTimeMillis() < until) Thread.sleep(5)
        assertTrue("timed out", what())
    }

    @Test fun visibleClubsKeepTheServersOrderWithoutHiddenOnes() {
        assertEquals(listOf("pet" to "ペット部", "apple" to "リンゴ部", "car" to "クルマ部"), ClubFilterRules.visible(clubs, emptySet()))
        assertEquals(listOf("pet" to "ペット部", "car" to "クルマ部"), ClubFilterRules.visible(clubs, setOf("apple", "__unset__")))
    }

    @Test fun aHiddenPickGoesBackToAll() {
        assertEquals("pet", ClubFilterRules.keep("pet", setOf("apple")))
        assertNull(ClubFilterRules.keep("pet", setOf("pet")))
        assertNull(ClubFilterRules.keep(null, setOf("pet")))
    }

    @Test fun postsQueryAsksForOneClub() {
        assertEquals(mapOf("limit" to "30", "include" to "reactions,read,display"), ApiClient.postsQuery(null, 30, null))
        assertEquals(mapOf("limit" to "30", "include" to "reactions,read,display", "club" to "pet"), ApiClient.postsQuery(null, 30, "pet"))
        assertEquals(mapOf("limit" to "30", "include" to "reactions,read,display", "cursor" to "c2", "club" to "pet"), ApiClient.postsQuery("c2", 30, "pet"))
    }

    @Test fun pickingAClubStartsTheListOverAndDropsTheOlderPage() {
        val s = store()
        val firstAll = CompletableDeferred<PostListResponse>()
        val calls = java.util.Collections.synchronizedList(mutableListOf<Pair<String?, String?>>())
        s.testFetch { cursor, club ->
            calls += cursor to club
            when {
                club == null && cursor == null && calls.size == 1 -> firstAll.await() // still on its way
                club == "pet" && cursor == null -> PostListResponse(listOf(pet), nextCursor = "c2")
                else -> PostListResponse(emptyList())
            }
        }
        s.testPosts(listOf(pet, apple, car))
        s.refreshAsync() // all clubs, waiting
        s.setClubFilter("pet")
        assertEquals("pet", s.clubFilter)
        assertEquals("ペット部", s.clubFilterName)
        waitFor { s.hasLoaded }
        assertEquals(listOf(pet), s.posts)
        // The page of all clubs arrives late: not shown.
        firstAll.complete(PostListResponse(listOf(pet, apple, car), nextCursor = "old"))
        Thread.sleep(50)
        assertEquals(listOf(pet), s.posts)
        // The next page asks for the same club.
        s.loadMore()
        waitFor { !s.loadingMore }
        assertEquals("c2" to "pet", calls.last())
        assertEquals(listOf<Pair<String?, String?>>(null to null, null to "pet", "c2" to "pet"), calls.toList())
    }

    @Test fun backToAllFetchesWithoutAClub() {
        val s = store()
        val calls = java.util.Collections.synchronizedList(mutableListOf<String?>())
        s.testFetch { _, club -> calls += club; PostListResponse(if (club == null) listOf(pet, apple) else listOf(apple)) }
        s.setClubFilter("apple")
        waitFor { s.hasLoaded }
        s.setClubFilter("apple") // the same: nothing
        s.setClubFilter(null)
        waitFor { s.hasLoaded && s.posts.size == 2 }
        assertNull(s.clubFilter)
        assertNull(s.clubFilterName)
        assertEquals(listOf("apple", null), calls.toList())
    }

    @Test fun theHiddenClubsLeaveTheListAndAHiddenPickGoesBackToAll() {
        val s = store(hidden = setOf("apple"))
        val all = listOf(pet, apple, car)
        s.testFetch { _, club -> PostListResponse(ClubFilterRules.demoPosts(all, club)) }
        s.setClubFilter("car")
        waitFor { s.hasLoaded }
        assertEquals(listOf(car), s.posts)
        kotlinx.coroutines.runBlocking { s.loadHiddenClubKeys() }
        assertEquals(listOf("pet" to "ペット部", "car" to "クルマ部"), s.visibleClubs)
        assertEquals("car", s.clubFilter) // not hidden: kept
        s.testHiddenClubKeys(setOf("apple", "car"))
        assertNull(s.clubFilter)
        waitFor { s.hasLoaded }
        assertEquals(all, s.posts)
        assertFalse(s.visibleClubs.any { it.first == "car" })
    }

    // 未読数と並べ替え（オーナー 2026-11-09「未読数も出してほしい。未読の数でソーティング、自分でカスタマイズした順番か未読順かで選べるように」）

    private val listed = listOf("pet" to "ペット部", "apple" to "リンゴ部", "car" to "クルマ部")
    private fun keys(l: List<Pair<String, String>>) = l.map { it.first }

    @Test fun customOrderPutsTheSavedKeysFirstThenTheCatalog() {
        assertEquals(listOf("pet", "apple", "car"), keys(ClubFilterRules.customOrder(listed, emptyList())))
        assertEquals(listOf("car", "pet", "apple"), keys(ClubFilterRules.customOrder(listed, listOf("car", "pet", "apple"))))
        // Only some saved, unknown / hidden ones skipped, duplicates once.
        assertEquals(listOf("car", "pet", "apple"), keys(ClubFilterRules.customOrder(listed, listOf("gone", "car", "car"))))
        assertEquals(listOf("apple", "pet", "car"), keys(ClubFilterRules.customOrder(listed, listOf("apple"))))
        // The names come along.
        assertEquals("クルマ部", ClubFilterRules.customOrder(listed, listOf("car")).first().second)
    }

    @Test fun unreadOrderIsMostUnreadFirstWithTiesInTheCustomOrder() {
        val unread = mapOf("apple" to 3, "car" to 3, "pet" to 1)
        assertEquals(listOf("apple", "car", "pet"), keys(ClubFilterRules.sorted(listed, emptyList(), unread, ClubSort.UNREAD)))
        assertEquals(listOf("car", "apple", "pet"), keys(ClubFilterRules.sorted(listed, listOf("car"), unread, ClubSort.UNREAD)))
        // None unread: the custom order.
        assertEquals(listOf("car", "pet", "apple"), keys(ClubFilterRules.sorted(listed, listOf("car"), emptyMap(), ClubSort.UNREAD)))
        // 自分の順番 ignores the counts.
        assertEquals(listOf("pet", "apple", "car"), keys(ClubFilterRules.sorted(listed, emptyList(), unread, ClubSort.CUSTOM)))
    }

    @Test fun theTotalCountsOnlyTheListedClubsAndTheBadgeStopsAt99() {
        assertEquals(10, ClubFilterRules.total(listed.filter { it.first != "apple" }, mapOf("pet" to 3, "apple" to 50, "car" to 7, "__unset__" to 9)))
        assertEquals(0, ClubFilterRules.total(listed, emptyMap()))
        assertNull(ClubFilterRules.badge(0))
        assertEquals("1", ClubFilterRules.badge(1))
        assertEquals("99", ClubFilterRules.badge(99))
        assertEquals("99+", ClubFilterRules.badge(100))
    }

    @Test fun movingUpAndDownStopsAtTheEnds() {
        val k = listOf("a", "b", "c")
        assertEquals(listOf("b", "a", "c"), ClubFilterRules.move(k, 1, -1))
        assertEquals(listOf("a", "c", "b"), ClubFilterRules.move(k, 1, 1))
        assertEquals(k, ClubFilterRules.move(k, 0, -1))
        assertEquals(k, ClubFilterRules.move(k, 2, 1))
        assertEquals(k, ClubFilterRules.move(k, 5, -1))
    }

    @Test fun theSavedOrderKeepsTheHiddenClubsAfterTheArrangedOnes() {
        assertEquals(listOf("car", "pet", "apple"), ClubFilterRules.orderToSave(listOf("car", "pet"), listOf("apple", "pet")))
        assertEquals(listOf("car", "pet"), ClubFilterRules.orderToSave(listOf("car", "pet", "car"), emptyList()))
    }

    private fun storeWithOrder(ops: Ops): TimelineStore {
        val s = TimelineStore(ApiClient("test"), ops, Dispatchers.Unconfined)
        s.testClubs(clubs)
        s.capabilities = ApiJson.decodeFromString("""{"features":{"posts":{"club_visibility":"/api/agent/clubs/visibility","club_order":"/api/agent/clubs/order","club_unread":"/api/agent/clubs/unread"}}}""")
        return s
    }

    @Test fun anOlderServerHasNoCountsAndNoArranging() {
        val s = store()
        assertFalse(s.canClubUnread)
        assertFalse(s.canClubOrder)
        kotlinx.coroutines.runBlocking { s.loadClubUnread() }
        assertTrue(s.clubUnread.isEmpty())
        s.setClubSortMode(ClubSort.UNREAD)
        assertEquals(listOf("pet", "apple", "car"), keys(s.sortedClubs)) // no counts: never by unread
    }

    @Test fun theStoreReadsTheCountsAndTheOrderAndSortsByUnread() {
        val ops = Ops(hidden = setOf("apple")).apply { order = listOf("car") }
        val s = storeWithOrder(ops)
        var savedMode: ClubSort? = null
        s.onClubSortChanged = { savedMode = it }
        kotlinx.coroutines.runBlocking { s.loadHiddenClubKeys(); s.loadClubUnread() }
        assertEquals(mapOf("pet" to 2, "car" to 7), s.clubUnread) // 未設定 and 0 dropped
        assertEquals(listOf("car"), s.clubOrder)
        assertEquals(listOf("car", "pet"), keys(s.sortedClubs)) // apple hidden
        assertEquals(9, s.clubUnreadTotal)
        s.setClubSortMode(ClubSort.UNREAD)
        assertEquals(ClubSort.UNREAD, savedMode)
        assertEquals(listOf("car", "pet"), keys(s.sortedClubs))
    }

    @Test fun savingTheOrderShowsItAtOnceAndPutsItBackWhenTheServerSaysNo() {
        val ops = Ops(hidden = setOf("apple")).apply { order = listOf("apple", "car") }
        val s = storeWithOrder(ops)
        kotlinx.coroutines.runBlocking { s.loadHiddenClubKeys() }
        s.saveClubOrder(listOf("pet", "car"))
        waitFor { !s.clubOrderSaving }
        assertEquals(listOf("pet", "car", "apple"), ops.saved.last()) // the hidden one keeps a place
        assertEquals(listOf("pet", "car"), keys(s.sortedClubs))
        ops.failSave = true
        s.saveClubOrder(listOf("car", "pet"))
        waitFor { !s.clubOrderSaving }
        assertEquals(listOf("pet", "car", "apple"), s.clubOrder)
        assertTrue(s.clubOrderError != null)
    }
}
