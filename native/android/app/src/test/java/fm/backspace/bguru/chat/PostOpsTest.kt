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
        override suspend fun hiddenClubs(path: String) = answer("hiddenClubs", setOf("car"))
        override suspend fun setClubHidden(path: String, club: String, hidden: Boolean) = answer("setClubHidden:$club:$hidden", hidden)
        override suspend fun setAllClubsHidden(path: String, hidden: Boolean) =
            answer("setAllClubsHidden:$hidden", if (hidden) setOf("apple", "car", "__unset__") else emptySet())
        override suspend fun mutedWords(path: String) = answer("mutedWords", MutedWordsResponse(listOf("ネタバレ"), 50, 40, listOf(MutedUser("u9", "うるさい人", "/api/avatar/x"))))
        override suspend fun setUserMuted(path: String, userId: String, muted: Boolean) = answer("setUserMuted:${ApiClient.mutedUserPath(path, userId)}:$muted", muted)
        override suspend fun setMutedWords(path: String, words: List<String>) = answer("setMutedWords:${words.joinToString(",")}", words.map { it.lowercase() })
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

    private fun clubStore(fake: PostOpsApi): TimelineStore {
        val s = store(fake)
        s.testClubs(mapOf("apple" to "リンゴ部", "car" to "クルマ部"))
        s.capabilities = ApiJson.decodeFromString("""{"features":{"posts":{"club_visibility":"/api/agent/clubs/visibility"}}}""")
        return s
    }

    // 部活の表示（2026-10-28）
    @Test fun clubVisibilityLoadsAndSaves() {
        val fake = FakeOps(error = null)
        val s = clubStore(fake)
        s.loadHiddenClubs()
        assertEquals(setOf("car"), s.hiddenClubs)
        assertEquals(listOf("apple" to "リンゴ部", "car" to "クルマ部", "__unset__" to "未設定"), s.clubVisibilityRows())
        s.setClubHidden("apple", true)
        s.setClubHidden("car", false)
        assertEquals(setOf("apple"), s.hiddenClubs)
        assertEquals(listOf("hiddenClubs", "setClubHidden:apple:true", "setClubHidden:car:false"), fake.calls)
        assertNull(s.clubVisibilityError)
    }

    // 全部 ON・全部 OFF（2026-11-08）
    @Test fun clubVisibilityAllOnAndOff() {
        val fake = FakeOps(error = null)
        val s = clubStore(fake)
        s.loadHiddenClubs()
        s.setAllClubsHidden(true)
        assertEquals(setOf("apple", "car", "__unset__"), s.hiddenClubs)
        s.setAllClubsHidden(false)
        assertEquals(emptySet<String>(), s.hiddenClubs)
        assertEquals(listOf("hiddenClubs", "setAllClubsHidden:true", "setAllClubsHidden:false"), fake.calls)
        assertEquals(false, s.clubVisibilityBusy)
    }

    @Test fun clubVisibilityGoesBackOnFailure() {
        val ok = FakeOps(error = null)
        val s = clubStore(ok)
        s.loadHiddenClubs()
        val bad = FakeOps()
        val s2 = clubStore(bad)
        s2.loadHiddenClubs()
        assertNull(s2.hiddenClubs) // could not read: no switches to flip
        assertEquals("この操作はできません", s2.clubVisibilityError)
        assertEquals(setOf("car"), s.hiddenClubs)
    }

    @Test fun clubVisibilityNeedsTheServer() {
        val fake = FakeOps(error = null)
        val s = store(fake) // an older server: no club_visibility
        s.loadHiddenClubs()
        assertNull(s.hiddenClubs)
        assertEquals(emptyList<String>(), fake.calls)
    }

    // NG ワード（2026-10-29）
    private fun mutedStore(fake: PostOpsApi): TimelineStore {
        val s = store(fake)
        s.capabilities = ApiJson.decodeFromString("""{"features":{"posts":{"muted_words":"/api/agent/muted-words"}}}""")
        return s
    }

    @Test fun mutedWordsLoadAddAndRemove() {
        val fake = FakeOps(error = null)
        val s = mutedStore(fake)
        s.loadMutedWords()
        assertEquals(listOf("ネタバレ"), s.mutedWords)
        assertTrue(kotlinx.coroutines.runBlocking { s.addMutedWord("  ABC ") })
        assertEquals(listOf("ネタバレ", "abc"), s.mutedWords) // the server's form
        assertTrue(!kotlinx.coroutines.runBlocking { s.addMutedWord("   ") }) // nothing to add
        s.removeMutedWord("ネタバレ")
        assertEquals(listOf("abc"), s.mutedWords)
        assertEquals(listOf("mutedWords", "setMutedWords:ネタバレ,ABC", "setMutedWords:abc"), fake.calls)
        assertNull(s.mutedWordsError)
    }

    @Test fun mutedWordsKeepTheListOnFailure() {
        val ok = FakeOps(error = null)
        val s = mutedStore(ok)
        s.loadMutedWords()
        val bad = FakeOps()
        val s2 = mutedStore(bad)
        s2.loadMutedWords()
        assertNull(s2.mutedWords) // could not read: nothing to change
        assertEquals("この操作はできません", s2.mutedWordsError)
        assertEquals(listOf("ネタバレ"), s.mutedWords)
    }

    @Test fun mutedWordsNeedTheServer() {
        val fake = FakeOps(error = null)
        val s = store(fake) // an older server: no muted_words
        s.loadMutedWords()
        assertNull(s.mutedWords)
        assertEquals(emptyList<String>(), fake.calls)
    }

    // 人のミュート（2026-11-25）
    private fun muteStore(fake: PostOpsApi): TimelineStore {
        val s = store(fake)
        s.capabilities = ApiJson.decodeFromString("""{"features":{"posts":{"muted_words":"/api/agent/muted-words","muted_users":"/api/agent/users/:id/mute"}}}""")
        return s
    }

    @Test fun mutedUsersDecode() {
        val r = ApiJson.decodeFromString<MutedWordsResponse>("""{"apiVersion":1,"words":["a"],"max":50,"maxLength":40,"users":[{"user_id":"u9","name":"うるさい人","avatar":null}]}""")
        assertEquals(listOf(MutedUser("u9", "うるさい人", null)), r.users)
        // an older server: no users
        assertEquals(emptyList<MutedUser>(), ApiJson.decodeFromString<MutedWordsResponse>("""{"words":[]}""").users)
        val other = ApiJson.decodeFromString<MemberProfileResponse>("""{"profile":{"user_id":"u9","is_self":false,"muted":true,"name":"x"}}""").profile
        assertEquals(true, other.muted)
        val old = ApiJson.decodeFromString<MemberProfileResponse>("""{"profile":{"user_id":"u9","is_self":false,"name":"x"}}""").profile
        assertNull(old.muted) // no button
        val caps = ApiJson.decodeFromString<Capabilities>("""{"features":{"posts":{"muted_users":"/api/agent/users/:id/mute"}}}""")
        assertEquals("/api/agent/users/:id/mute", caps.mutedUsersPath)
        assertNull(ApiJson.decodeFromString<Capabilities>("""{"features":{"posts":{"muted_users":null}}}""").mutedUsersPath)
        assertNull(ApiJson.decodeFromString<Capabilities>("""{"features":{"posts":{"muted_users":"https://evil.example/:id"}}}""").mutedUsersPath)
        assertEquals("/api/agent/users/a%20b%2Fc/mute", ApiClient.mutedUserPath("/api/agent/users/:id/mute", "a b/c"))
    }

    @Test fun mutedUsersLoadMuteAndUnmute() {
        val fake = FakeOps(error = null)
        val s = muteStore(fake)
        assertTrue(s.canMuteUsers)
        s.loadMutedWords()
        assertEquals(listOf("u9"), s.mutedUsers.map { it.userId })
        assertEquals(true, kotlinx.coroutines.runBlocking { s.setUserMuted("u1", true, "mazzo") })
        s.unmuteUser(s.mutedUsers.first())
        assertEquals(emptyList<MutedUser>(), s.mutedUsers)
        assertEquals(listOf("mutedWords", "setUserMuted:/api/agent/users/u1/mute:true", "setUserMuted:/api/agent/users/u9/mute:false"), fake.calls)
        assertNull(s.mutedWordsError)
        assertEquals(false, s.mutedWordsBusy)
    }

    @Test fun mutedUsersKeepTheListOnFailure() {
        val ok = FakeOps(error = null)
        val s = muteStore(ok)
        s.loadMutedWords()
        val bad = FakeOps(error = ApiError.Http(400, null, "自分はミュートできません"))
        val s2 = muteStore(bad)
        assertNull(kotlinx.coroutines.runBlocking { s2.setUserMuted("me", true) })
        assertEquals("自分はミュートできません", s2.mutedWordsError) // the server's words
        assertEquals(false, s2.mutedWordsBusy)
        assertEquals(listOf("u9"), s.mutedUsers.map { it.userId })
    }

    @Test fun mutedUsersNeedTheServer() {
        val fake = FakeOps(error = null)
        val s = mutedStore(fake) // NG ワードだけのサーバ: no muted_users
        assertTrue(!s.canMuteUsers)
        assertNull(kotlinx.coroutines.runBlocking { s.setUserMuted("u1", true) })
        s.unmuteUser(MutedUser("u9"))
        assertEquals(emptyList<String>(), fake.calls)
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
