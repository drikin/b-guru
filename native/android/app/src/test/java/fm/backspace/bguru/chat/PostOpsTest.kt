package fm.backspace.bguru.chat

import kotlinx.coroutines.Dispatchers
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** What is shown at once (bookmark, ☆, vote, club, reaction, pin) goes back when the server says no,
 *  and the server's words are shown (TimelineStore with a fake API that fails). */
class PostOpsTest {
    /** Every call fails with `error`; `calls` records what was asked. */
    private class FakeOps(val error: Exception? = ApiError.Http(403, "forbidden", "この操作はできません")) : PostOpsApi {
        val calls = mutableListOf<String>()
        private fun <T> answer(name: String, ok: T): T { calls += name; error?.let { throw it }; return ok }
        override suspend fun toggleBookmark(postId: Long) = answer("toggleBookmark", true)
        override suspend fun setBookmark(postId: Long, on: Boolean) = answer("setBookmark:$on", on)
        override suspend fun setFavorite(userId: String, on: Boolean) = answer("setFavorite:$on", on)
        override suspend fun togglePin(id: Long) = answer("togglePin", true)
        override suspend fun setClub(id: Long, key: String?) = answer("setClub", key)
        override suspend fun vote(id: Long, optionId: Long): PostPoll? = answer("vote", null)
        override suspend fun togglePostReaction(id: Long, emoji: String) = answer("react", PostReactionToggle(true, listOf(PostReactionToggle.Count(emoji, 1))))
    }

    private val poll = PostPoll("どれ？", "2999-01-01T00:00:00Z", totalVotes = 1, voterCount = 1, myVote = 1,
        options = listOf(PostPoll.Option(1, "A", 1, 100), PostPoll.Option(2, "B", 0, 0), PostPoll.Option(3, "C", 0, 0)))
    private val a = Post(1, authorId = "u1", authorName = "mazzo", text = "a", poll = poll, club = "pet", reactions = listOf(Reaction("❤️", 1)))
    private val b = Post(2, authorId = "u1", authorName = "mazzo", text = "b")
    private val mine = Post(3, authorId = "me", isAuthor = true, text = "mine", club = "pet")

    private fun store(fake: PostOpsApi): TimelineStore {
        val s = TimelineStore(ApiClient("test"), fake, Dispatchers.Unconfined)
        s.testPosts(listOf(a, b, mine))
        return s
    }

    @Test fun bookmarkGoesBackOnFailure() {
        val fake = FakeOps()
        val s = store(fake)
        s.toggleBookmark(a)
        assertEquals(listOf("toggleBookmark"), fake.calls)
        assertEquals(false, s.posts[0].bookmarkedByMe) // back to not bookmarked
        assertEquals("この操作はできません", s.toast?.text) // the server's words, no undo
        assertNull(s.toast?.undo)
    }

    @Test fun bookmarkUsesTheIdempotentFormWhenOffered() {
        val fake = FakeOps(error = null)
        val s = store(fake)
        s.capabilities = ApiJson.decodeFromString("""{"features":{"posts":{"bookmarks":true,"bookmarks_set":true}}}""")
        s.toggleBookmark(a)
        assertEquals(listOf("setBookmark:true"), fake.calls)
        assertEquals(true, s.posts[0].bookmarkedByMe)
        assertEquals("ブックマークに保存しました（タップで取り消し）", s.toast?.text)
        // Tapping the toast takes it back (and sends that too).
        s.toast!!.undo!!()
        assertEquals(false, s.posts[0].bookmarkedByMe)
        assertEquals(listOf("setBookmark:true", "setBookmark:false"), fake.calls)
    }

    @Test fun favoriteGoesBackForEveryPostOfThePerson() {
        val s = store(FakeOps(ApiError.Http(429, "rate_limited", "上限です")))
        s.toggleFavorite(a)
        assertTrue(s.posts.filter { it.authorId == "u1" }.all { it.favoriteByMe == false })
        assertEquals("少し時間をおいてから試してください", s.toast?.text)
    }

    @Test fun voteGoesBack() {
        val s = store(FakeOps(ApiError.Http(403, "forbidden", "投票は終了しました")))
        s.vote(a, 2)
        assertEquals(poll, s.posts[0].poll)
        assertEquals("投票は終了しました", s.toast?.text)
    }

    @Test fun clubGoesBack() {
        val s = store(FakeOps())
        s.setClub(mine, "apple")
        assertEquals("pet", s.posts[2].club)
    }

    @Test fun reactionGoesBack() {
        val s = store(FakeOps(ApiError.Transport("offline")))
        s.react(a, "🎉")
        assertEquals(listOf(Reaction("❤️", 1)), s.posts[0].reactions)
    }

    @Test fun pinStaysOffOnFailure() {
        val s = store(FakeOps())
        s.togglePin(mine)
        assertNull(s.posts[2].pinnedAt)
        assertEquals("この操作はできません", s.toast?.text)
    }

    @Test fun anOpenThreadHearsTheRollbackToo() {
        val s = store(FakeOps())
        var seen: Post? = a
        s.listen { id, f -> if (id == a.id || id == -1L) seen = seen?.let(f) }
        s.toggleBookmark(a)
        assertEquals(false, seen?.bookmarkedByMe)
    }
}
