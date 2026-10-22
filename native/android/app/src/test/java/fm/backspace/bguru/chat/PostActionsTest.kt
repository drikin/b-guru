package fm.backspace.bguru.chat

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.time.Instant

private typealias I = PostActions.Item

/** 段階 3 (docs/timeline-spec.md §10–§11): which operations show, the poll checks, and the API's shape. */
class PostActionsTest {
    private fun caps(posts: String) = ApiJson.decodeFromString<Capabilities>(
        """{"scopes":["read","post"],"features":{"chat":{"send":true},"posts":{"read":true,"publish":true,"reactions":true,$posts},"neta":{"enabled":true}}}"""
    )

    /** What the server says for an app key (app_issued + post) — src/lib/agent-chat.ts. */
    private val appKey = caps(
        """"edit":true,"delete":true,"edit_text_only":false,"whisper":true,"video":true,"audio":true,"max_media_mb":100,"poll":true,"poll_vote":true,""" +
            """"poll_edit":true,"pin":true,"pinned_list":true,"bookmarks":true,"favorites":true,"custom_emoji_list":"/api/agent/emojis",""" +
            """"club_select":true,"club_change":true,"mentions":"/api/agent/members","display":true,"include":["reactions","read","display"]"""
    )
    /** An outside agent's write key: text-only edit, delete, bookmarks. */
    private val writeKey = caps(""""edit":false,"delete":true,"edit_text_only":true,"bookmarks":true,"favorites":true""")
    /** An outside agent with post only: no edit, no delete (403 on the server). */
    private val postOnlyKey = caps(""""edit":false,"delete":false,"edit_text_only":false,"whisper":true,"pin":true,"bookmarks":true,"favorites":true""")
    /** A server from before 段階 3: none of the new fields. */
    private val oldServer = caps(""""max_images":5""")

    private val mine = Post(1, authorId = "me", authorName = "ドリキン", isAuthor = true, text = "hello")
    private val theirs = Post(2, authorId = "u_mazzo", authorName = "mazzo", text = "見て https://example.com/a")
    private val myReply = Post(3, authorId = "me", isAuthor = true, parentId = 1, text = "返信")

    @Test fun menuFollowsTheWebOrder() {
        assertEquals(listOf(I.BOOKMARK, I.QUOTE, I.REACT, I.PIN, I.CLUB, I.EDIT, I.DELETE, I.COPY, I.WEB),
            PostActions.menu(mine, appKey, chatCanSend = true, hasNetaUrls = false))
        assertEquals(listOf(I.BOOKMARK, I.QUOTE, I.NETA, I.FAVORITE, I.REACT, I.COPY, I.WEB),
            PostActions.menu(theirs, appKey, chatCanSend = true, hasNetaUrls = true))
        // A reply: no pin (root posts only), edit and delete stay.
        assertEquals(listOf(I.BOOKMARK, I.QUOTE, I.REACT, I.EDIT, I.DELETE, I.COPY, I.WEB),
            PostActions.menu(myReply, appKey, chatCanSend = true, hasNetaUrls = false))
    }

    @Test fun oldServerShowsNoNewOperations() {
        assertEquals(listOf(I.QUOTE, I.REACT, I.COPY, I.WEB), PostActions.menu(mine, oldServer, chatCanSend = true, hasNetaUrls = false))
        assertFalse(oldServer.canEditPosts || oldServer.canDeletePosts || oldServer.canPin || oldServer.canBookmark || oldServer.canFavorite)
        assertFalse(oldServer.canWhisper || oldServer.canPostVideo || oldServer.canPostAudio || oldServer.canCreatePoll || oldServer.canVote)
        assertFalse(oldServer.canChangeClub || oldServer.canSelectClub || oldServer.canListPinned)
        assertNull(oldServer.customEmojiPath)
        assertNull(oldServer.mentionsPath)
        assertEquals(100, oldServer.maxMediaMb)
        // No capabilities at all (not loaded yet): only copy / open on the web.
        assertEquals(listOf(I.COPY, I.WEB), PostActions.menu(mine, null, chatCanSend = false, hasNetaUrls = true))
    }

    @Test fun editAndDeleteByKind() {
        assertTrue(appKey.canEditPosts); assertFalse(appKey.editTextOnly); assertTrue(appKey.canDeletePosts)
        assertTrue(writeKey.canEditPosts); assertTrue(writeKey.editTextOnly); assertTrue(writeKey.canDeletePosts)
        assertFalse(postOnlyKey.canEditPosts); assertFalse(postOnlyKey.canDeletePosts)
        val items = PostActions.menu(mine, postOnlyKey, chatCanSend = false, hasNetaUrls = false)
        assertFalse(PostActions.Item.EDIT in items || PostActions.Item.DELETE in items)
        assertTrue(PostActions.Item.PIN in items)
        // post scope but edit false: a line saying to sign in again (not pressable). Not on an old server, nor for a write key.
        assertTrue(PostActions.Item.EDIT_RELOGIN in items && PostActions.isNote(PostActions.Item.EDIT_RELOGIN))
        assertEquals("編集するには一度ログインし直してください", PostActions.label(PostActions.Item.EDIT_RELOGIN, mine, false))
        assertFalse(PostActions.Item.EDIT_RELOGIN in PostActions.menu(mine, oldServer, true, false))
        assertFalse(PostActions.Item.EDIT_RELOGIN in PostActions.menu(mine, writeKey, true, false))
        assertFalse(PostActions.Item.EDIT_RELOGIN in PostActions.menu(theirs, postOnlyKey, true, false))
        // Never on someone else's post.
        assertFalse(PostActions.menu(theirs, appKey, true, false).any { it == PostActions.Item.EDIT || it == PostActions.Item.DELETE || it == PostActions.Item.PIN })
        // No ☆ for a post without an author id, nor for my own.
        assertFalse(PostActions.Item.FAVORITE in PostActions.menu(theirs.copy(authorId = null), appKey, true, false))
    }

    @Test fun clubAndWhisperRules() {
        assertTrue(PostActions.canChangeClub(mine, appKey))
        assertFalse(PostActions.canChangeClub(theirs, appKey))
        assertFalse(PostActions.canChangeClub(myReply, appKey))
        assertFalse(PostActions.canChangeClub(mine, oldServer))
        assertTrue(PostActions.canWhisper(appKey, parentId = 1))
        assertFalse(PostActions.canWhisper(appKey, parentId = null))
        assertFalse(PostActions.canWhisper(oldServer, parentId = 1))
        assertEquals("/api/agent/emojis", appKey.customEmojiPath)
        assertEquals("/api/agent/members", appKey.mentionsPath)
    }

    @Test fun menuWordsMatchTheWeb() {
        val words = listOf(I.BOOKMARK, I.QUOTE, I.NETA, I.FAVORITE, I.REACT, I.PIN, I.CLUB, I.EDIT, I.DELETE, I.COPY, I.WEB).map { PostActions.label(it, theirs, false) }
        assertEquals(listOf("ブックマーク", "チャットに引用", "ネタ帳に送る", "お気に入りに追加", "リアクション", "ピン（24時間）", "部活動を選択", "編集", "削除",
            "テキストをコピー", "Web で開く"), words)
        assertEquals("ブックマークを外す", PostActions.label(I.BOOKMARK, theirs.copy(bookmarkedByMe = true), false))
        assertEquals("お気に入りから外す", PostActions.label(I.FAVORITE, theirs.copy(favoriteByMe = true), false))
        assertEquals("ピンを外す", PostActions.label(I.PIN, mine, true))
        // No space between a number and its unit (「24時間」「5人」).
        assertFalse(words.any { Regex("[0-9] [時人票分枚]").containsMatchIn(it) })
        assertEquals("ブックマークに保存しました（タップで取り消し）", PostActions.bookmarkToast(true))
        assertEquals("ブックマークから外しました（タップで取り消し）", PostActions.bookmarkToast(false))
        assertEquals("mazzo をお気に入りに追加しました（タップで取り消し）", PostActions.favoriteToast("mazzo", true))
        assertEquals("mazzo をお気に入りから外しました（タップで取り消し）", PostActions.favoriteToast("mazzo", false))
        assertEquals("この投稿を削除しますか？この操作は取り消せません。", PostActions.DELETE_BODY)
        assertEquals(5_000L, PostActions.TOAST_MS)
    }

    @Test fun pinLasts24Hours() {
        val now = Instant.parse("2026-10-22T12:00:00Z")
        assertTrue(PostActions.isPinned(mine.copy(pinnedAt = "2026-10-21T12:00:01Z"), now))
        assertFalse(PostActions.isPinned(mine.copy(pinnedAt = "2026-10-21T12:00:00Z"), now))
        assertFalse(PostActions.isPinned(mine, now))
    }

    @Test fun errorWords() {
        assertEquals("少し時間をおいてから試してください", PostActions.errorText(ApiError.Http(429, "rate_limited", "投稿の上限です")))
        assertEquals("ログインが切れました。再接続してください", PostActions.errorText(ApiError.Unauthorized("token_expired")))
        assertEquals("投票は終了しました", PostActions.errorText(ApiError.Http(403, "forbidden", "投票は終了しました")))
        assertEquals("削除に失敗しました", PostActions.errorText(ApiError.Http(500, "server_error", null), "削除に失敗しました"))
    }

    // MARK: polls

    @Test fun pollChecksMatchTheServer() {
        assertNull(PollRules.validate("どれ？", listOf("A", "B", "C"), 24))
        assertEquals("アンケートの質問を入力してください", PollRules.validate("  ", listOf("A", "B", "C"), 24))
        assertEquals("回答は3個以上必要です", PollRules.validate("どれ？", listOf("A", "B", " "), 24))
        assertEquals("回答は最大10個までです", PollRules.validate("どれ？", (1..11).map { "$it" }, 24))
        assertEquals("回答は100文字以内で入力してください", PollRules.validate("どれ？", listOf("A", "B", "x".repeat(101)), 24))
        assertNull(PollRules.validate("どれ？", listOf("A", "B", "x".repeat(100)), 1))
        assertEquals("締切の選択が不正です", PollRules.validate("どれ？", listOf("A", "B", "C"), 2))
        assertEquals("質問は200文字以内で入力してください", PollRules.validate("q".repeat(201), listOf("A", "B", "C"), 6))
        assertEquals(listOf(1, 6, 12, 24), PollRules.DURATIONS)
        assertEquals(listOf("A", "B"), PollRules.cleaned(listOf(" A ", "", "B")))
    }

    private val poll = PostPoll("どれ？", "2026-10-22T15:30:00Z", totalVotes = 3, voterCount = 3, myVote = null, editable = true,
        options = listOf(PostPoll.Option(1, "A", 2, 67), PostPoll.Option(2, "B", 1, 33), PostPoll.Option(3, "C", 0, 0), PostPoll.Option(4, "D", 0, 0)))

    @Test fun votedAnswersCannotBeRemoved() {
        val rows = PollRules.editRows(poll)
        assertFalse(PollRules.canRemove(rows, 0)) // 2 votes
        assertTrue(PollRules.canRemove(rows, 2))
        assertFalse(PollRules.canRemove(rows.take(3), 2)) // never fewer than three
        assertNull(PollRules.validateEdit(poll, rows.filterIndexed { i, _ -> i != 3 }))
        assertEquals("投票が付いた回答は削除できません", PollRules.validateEdit(poll, rows.drop(1)))
        assertTrue(PollRules.canAdd(9)); assertFalse(PollRules.canAdd(10))
    }

    @Test fun pollTimeAndWords() {
        val now = Instant.parse("2026-10-22T12:00:00Z")
        assertEquals("あと3時間30分", PollRules.timeLeft("2026-10-22T15:30:00Z", now))
        assertEquals("あと5時間", PollRules.timeLeft("2026-10-22T17:00:00Z", now))
        assertEquals("あと45分", PollRules.timeLeft("2026-10-22T12:45:30Z", now))
        assertEquals("あと1日0時間", PollRules.timeLeft("2026-10-23T12:00:00Z", now))
        assertEquals("終了", PollRules.timeLeft("2026-10-22T11:59:00Z", now))
        assertFalse(PollRules.isClosed(poll, now))
        assertTrue(PollRules.isClosed(poll, Instant.parse("2026-10-22T15:30:01Z")))
        assertEquals("投票する", PollRules.optionState(poll, 1, closed = false))
        assertEquals("投票済み", PollRules.optionState(poll.copy(myVote = 1), 1, closed = false))
        assertEquals("投票が終了しました", PollRules.optionState(poll, 1, closed = true))
        assertEquals("3人が投票 · 全3票", PollRules.footer(poll, false))
        assertEquals("締め切りました · 全3票", PollRules.footer(poll, true))
        assertEquals("まだ投票はありません · 全0票", PollRules.footer(poll.copy(totalVotes = 0), false))
    }

    @Test fun voteAndChangeVote() {
        val first = PollRules.voted(poll, 3)
        assertEquals(3L, first.myVote); assertEquals(4, first.totalVotes)
        assertEquals(listOf(2, 1, 1, 0), first.options.map { it.votes })
        assertEquals(listOf(50, 25, 25, 0), first.options.map { it.pct })
        // Changing keeps one vote.
        val changed = PollRules.voted(first, 1)
        assertEquals(4, changed.totalVotes)
        assertEquals(listOf(3, 1, 0, 0), changed.options.map { it.votes })
        assertEquals(changed, PollRules.voted(changed, 1))
    }

    // MARK: media

    @Test fun mediaFormatsAndLimit() {
        assertNull(MediaRules.checkVideo("video/mp4", "a.mp4", 10, 100))
        assertNull(MediaRules.checkVideo("video/quicktime", "a.MOV", 10, 100))
        assertNotNull(MediaRules.checkVideo("video/3gpp", "a.3gp", 10, 100))
        assertEquals("動画は100MBまでです", MediaRules.checkVideo("video/mp4", "a.mp4", 100L * 1024 * 1024 + 1, 100))
        assertNull(MediaRules.checkAudio("audio/mp4", "voice.m4a", 10, 100))
        assertNull(MediaRules.checkAudio("application/octet-stream", "voice.opus", 10, 100)) // by its extension, like the web
        // The server does not take audio/opus: an .opus file goes up as audio/ogg.
        assertFalse("audio/opus" in MediaRules.AUDIO_TYPES)
        assertEquals("audio/ogg", MediaRules.uploadType("audio", "audio/opus", "voice.opus"))
        assertNotNull(MediaRules.checkAudio("audio/midi", "a.mid", 10, 100))
        assertEquals("audio/mp4", MediaRules.uploadType("audio", "", "voice.m4a"))
        assertEquals("video/quicktime", MediaRules.uploadType("video", null, "clip.mov"))
        assertEquals("video/webm", MediaRules.uploadType("video", "video/webm", "x"))
    }

    // MARK: the API's shape (§11)

    @Test fun publishBody() {
        val root = ApiClient.publishBody("どれ？", listOf("/api/media/a.jpg"), null,
            PublishExtra(whisper = true, poll = PollInput("どれ？", listOf("A", "B", "C"), 6), club = "pet", videoUrl = "/api/media/v.mp4"))
        assertEquals("どれ？", root["text"]!!.jsonPrimitive.content)
        assertEquals(1, root["images"]!!.jsonArray.size)
        assertFalse("whisper is for replies only", "whisper" in root)
        assertEquals("pet", root["club"]!!.jsonPrimitive.content)
        assertEquals("/api/media/v.mp4", root["video_url"]!!.jsonPrimitive.content)
        val poll = root["poll"]!!.jsonObject
        assertEquals(setOf("question", "options", "duration_hours"), poll.keys)
        assertEquals(6, poll["duration_hours"]!!.jsonPrimitive.content.toInt())
        val reply = ApiClient.publishBody("ok", emptyList(), 9, PublishExtra(whisper = true, club = "pet", audioUrl = "/api/media/s.m4a"))
        assertEquals("true", reply["whisper"]!!.jsonPrimitive.content)
        assertEquals(9L, reply["parent_id"]!!.jsonPrimitive.content.toLong())
        assertFalse("club is for root posts only", "club" in reply)
        assertEquals("/api/media/s.m4a", reply["audio_url"]!!.jsonPrimitive.content)
        // What an older app sent: unchanged.
        assertEquals(setOf("text", "images"), ApiClient.publishBody("x", emptyList(), null).keys)
    }

    @Test fun editAndPollEditBodies() {
        assertEquals(setOf("text"), ApiClient.editBody("t", listOf("/api/media/a.jpg"), AudioChange.Remove, textOnly = true).keys)
        val full = ApiClient.editBody("t", listOf("/api/media/a.jpg"), AudioChange.Remove, textOnly = false)
        assertEquals(JsonNull, full["audio_url"])
        assertEquals(1, full["images"]!!.jsonArray.size)
        assertFalse("audio_url" in ApiClient.editBody("t", null, AudioChange.Keep, false))
        assertFalse("images" in ApiClient.editBody("t", null, AudioChange.Keep, false))
        assertEquals("/api/media/n.mp3", ApiClient.editBody("t", null, AudioChange.Set("/api/media/n.mp3"), false)["audio_url"]!!.jsonPrimitive.content)
        val pe = ApiClient.pollEditBody(listOf(1L to "A", null to "新しい"))
        val opts = pe["options"]!!.jsonArray.map { it as JsonObject }
        assertEquals(1L, opts[0]["id"]!!.jsonPrimitive.content.toLong())
        assertEquals(JsonNull, opts[1]["id"])
        assertEquals("新しい", opts[1]["label"]!!.jsonPrimitive.content)
    }

    @Test fun decodesTheNewPostFields() {
        val p = ApiJson.decodeFromString<Post>(
            """{"id":5,"text":"どれ？","pinned_at":"2026-10-22T00:00:00.000Z","club":"pet","club_manual":true,"bookmarked_by_me":true,"favorite_by_me":false,
               "poll":{"question":"どれ？","endsAt":"2026-10-22T03:00:00.000Z","closed":false,"editable":true,"totalVotes":3,"voterCount":3,"myVote":2,
               "options":[{"id":1,"label":"A","votes":2,"pct":67},{"id":2,"label":"B","votes":1,"pct":33}]}}"""
        )
        assertEquals(true, p.bookmarkedByMe); assertEquals(false, p.favoriteByMe); assertEquals(true, p.clubManual)
        assertEquals("2026-10-22T00:00:00.000Z", p.pinnedAt)
        val poll = p.poll!!
        assertEquals("2026-10-22T03:00:00.000Z", poll.endsAt)
        assertEquals(3, poll.totalVotes); assertEquals(2L, poll.myVote); assertTrue(poll.editable)
        assertEquals(listOf(67, 33), poll.options.map { it.pct })
        // The vote / poll edit answers carry the same poll.
        assertEquals(1L, ApiJson.decodeFromString<PollResponse>("""{"apiVersion":1,"ok":true,"poll":{"question":"q","endsAt":"x","myVote":1,"options":[]}}""").poll!!.myVote)
        assertTrue(ApiJson.decodeFromString<PinResponse>("""{"apiVersion":1,"ok":true,"pinned":true}""").pinned)
        assertEquals("/api/media/v.mp4", ApiJson.decodeFromString<MediaUploadResponse>("""{"video_url":"/api/media/v.mp4"}""").videoUrl)
        assertEquals("/e/x.png", ApiJson.decodeFromString<EmojisResponse>("""{"apiVersion":1,"emojis":[{"id":3,"name":"drikin","image_url":"/e/x.png"}]}""").emojis[0].imageUrl)
        // Older servers: the fields are simply absent.
        val old = ApiJson.decodeFromString<Post>("""{"id":6,"text":"x"}""")
        assertNull(old.poll); assertNull(old.bookmarkedByMe); assertNull(old.pinnedAt)
    }

    /** The shared examples' poll post (posts.json) decodes with its poll. */
    @Test fun fixturePollDecodes() {
        var dir: File? = File(".").absoluteFile
        var f: File? = null
        while (dir != null && f == null) {
            File(dir, "src/lib/__tests__/fixtures/timeline/posts.json").takeIf { it.isFile }?.let { f = it }
            dir = dir.parentFile
        }
        val root = ApiJson.parseToJsonElement(f!!.readText()).jsonObject
        val posts = root["posts"]!!.jsonArray.map { ApiJson.decodeFromJsonElement(Post.serializer(), it) }
        val withPoll = posts.filter { it.poll != null }
        assertTrue(withPoll.isNotEmpty())
        val p = withPoll.first().poll!!
        assertEquals("どれがいい？", p.question)
        assertEquals(3, p.totalVotes)
        assertEquals(listOf("A", "B"), p.options.take(2).map { it.label })
    }
}
