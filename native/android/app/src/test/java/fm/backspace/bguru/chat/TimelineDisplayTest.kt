package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlinx.serialization.Serializable
import java.io.File

/** The web's display rules (TimelineRules), and that the server's `display` wins when present. */
class TimelineDisplayTest {
    @Test fun foldsOver500Units() {
        assertNull(TimelineRules.foldPoint("あ".repeat(500)))
        assertEquals(500, TimelineRules.foldPoint("あ".repeat(501)))
        assertNull(TimelineRules.foldPoint(""))
    }

    @Test fun foldCountsUtf16LikeJs() {
        // 🐶 is 2 UTF-16 units (JS length 2): 250 dogs = 500 units → not folded; 251 → folded at 500.
        assertNull(TimelineRules.foldPoint("🐶".repeat(250)))
        assertEquals(500, TimelineRules.foldPoint("🐶".repeat(251)))
        // The 500th unit is the first half of an emoji: cut at 499.
        assertEquals(499, TimelineRules.foldPoint("a" + "🐶".repeat(250)))
    }

    @Test fun reactionsByCountThenUtf16() {
        val rs = listOf(Reaction("😂", 2), Reaction("👍", 5), Reaction("❤️", 5), Reaction("🎉", 1), Reaction("🙏", 3))
        assertEquals(listOf("❤️", "👍", "🙏", "😂", "🎉"), TimelineRules.orderReactions(rs).map { it.emoji })
        // UTF-16 units, not code points: U+1F600 (0xD83D…) sorts before U+FFFD.
        assertEquals(listOf("😀", "\uFFFD"), TimelineRules.orderReactions(listOf(Reaction("\uFFFD", 1), Reaction("😀", 1))).map { it.emoji })
        assertEquals(listOf(":drikin:", "🎉"), TimelineRules.orderReactions(listOf(Reaction("🎉", 2), Reaction(":drikin:", 2))).map { it.emoji })
        // Straight after a tap the held reactions are sorted by the rule, whatever display said.
        val p = Post(1, reactions = listOf(Reaction("👍", 9), Reaction("❤️", 3), Reaction("😂", 1)), display = PostDisplay(reactionsOrder = listOf("😂", "❤️", "👍")))
        assertEquals(listOf("👍", "❤️", "😂"), TimelineRules.resolve(p, emptySet()).reactions.map { it.emoji })
    }

    @Test fun reactorsCappedAt12WithOthers() {
        val names = (1..12).map { "u$it" }
        val r = TimelineRules.reactors(Reaction("❤️", 15, reactors = names))
        assertEquals(12, r.names.size)
        assertEquals(3, r.others)
        assertEquals(0, TimelineRules.reactors(Reaction("❤️", 2, reactors = listOf("a", "b"))).others)
        assertEquals(12, TimelineRules.reactors(Reaction("❤️", 20, reactors = (1..20).map { "u$it" })).names.size)
    }

    @Test fun mentionsOnlyMembers() {
        val members = setOf("mazzo", "norio takahashi")
        val text = "@mazzo さん @[NORIO TAKAHASHI] さん @nobody @MAZZO と @mazzo、 @mazzo\u3000全角空白"
        val found = TimelineRules.findMentions(text, members)
        // "@mazzo、" is one token "mazzo、" on the web too: not a member name → not marked.
        // JS \s includes U+3000, so "@mazzo　" ends at the ideographic space.
        assertEquals(listOf("mazzo", "NORIO TAKAHASHI", "MAZZO", "mazzo"), found.map { it.name })
        val tokens = found.map { text.substring(it.start, it.end) }.toSet()
        assertEquals(found.size, TimelineRules.mentionRanges(text, tokens).size)
        assertEquals("@NORIO TAKAHASHI", TimelineRules.mentionLabel("@[NORIO TAKAHASHI]"))
        assertTrue(TimelineRules.findMentions(text, emptySet()).isEmpty())
    }

    @Test fun imageColumnsAndSizes() {
        assertEquals(listOf(0, 1, 2, 3, 3, 3), (0..5).map(TimelineRules::imageColumns))
        assertEquals(360f to 180f, TimelineRules.singleImageSize(500f, 2f))
        assertEquals(300f to 150f, TimelineRules.singleImageSize(300f, 2f))
        // Phone screenshot (9:19.5): capped at 480 tall and narrower, never cut.
        val (w, h) = TimelineRules.singleImageSize(360f, 9f / 19.5f)
        assertEquals(480f, h, 0.01f)
        assertEquals(480f * 9f / 19.5f, w, 0.01f)
        assertEquals(100f, TimelineRules.gridCellHeight(100f, 1f), 0.01f)
        assertEquals(200f, TimelineRules.gridCellHeight(100f, 0.2f), 0.01f)
    }

    @Test fun gifIsAnimated() {
        assertTrue(TimelineRules.isAnimated("/api/media/x.GIF?w=640"))
        assertFalse(TimelineRules.isAnimated("/api/media/gif.jpg"))
    }

    // MARK: the shared examples (docs/timeline-spec.md §9)

    private fun fixture(name: String): File {
        var dir: File? = File(".").absoluteFile
        while (dir != null) {
            val f = File(dir, "src/lib/__tests__/fixtures/timeline/$name")
            if (f.isFile) return f
            dir = dir.parentFile
        }
        error("fixture $name not found above ${File(".").absolutePath}")
    }

    @Serializable private data class Ctx(val memberNames: List<String> = emptyList(), val clubs: Map<String, String> = emptyMap())
    @Serializable private data class Posts(val context: Ctx, val posts: List<Post>)
    @Serializable private data class Expected(val displays: Map<String, PostDisplay>)

    private val posts by lazy { ApiJson.decodeFromString<Posts>(fixture("posts.json").readText()) }
    private val expected by lazy { ApiJson.decodeFromString<Expected>(fixture("expected.json").readText()).displays }
    private val names get() = posts.context.memberNames.map { it.lowercase() }.toSet()

    /** Without `display` (an older server) the app works out exactly what the server would send. */
    @Test fun localComputeMatchesSharedExamples() {
        assertTrue(posts.posts.size >= 20)
        val misses = posts.posts.mapNotNull { p ->
            val want = expected[p.id.toString()] ?: return@mapNotNull "${p.id}: no expected display"
            val got = TimelineRules.compute(p, names) { posts.context.clubs[it] }
            if (got == want) null else "${p.id}:\n  want $want\n  got  $got"
        }
        assertTrue(misses.joinToString("\n"), misses.isEmpty())
    }

    /** With the server's `display`, what is drawn follows it. */
    @Test fun drawsTheServersDisplay() {
        for (p0 in posts.posts) {
            val d = expected[p0.id.toString()] ?: continue
            val p = p0.copy(display = d)
            val plan = TimelineRules.resolve(p, emptySet()) // no member names here: the server's ranges are used
            if (d.fold) assertEquals("${p.id}", p.text.substring(0, d.foldAt!!), plan.folded) else assertNull(plan.folded)
            assertEquals("${p.id}", d.reactionsOrder, plan.reactions.map { it.emoji })
            assertEquals("${p.id}", d.mentionRanges.map { p.text.substring(it.start, it.end) }.toSet(), plan.mentionTokens)
            assertEquals("${p.id}", d.linkCard?.kind, plan.linkCard?.first?.kind)
            assertEquals("${p.id}", d.clubLabel, plan.clubLabel)
        }
        val p17 = posts.posts.first { it.id == 9017L }
        val r = expected["9017"]!!.mentionRanges.first { it.start == 11 }
        assertEquals("@[Taro Yamada]", p17.text.substring(r.start, r.end))
        assertEquals(499, expected["9004"]!!.foldAt)
    }

    @Test fun displayDecodesAndOldServerHasNone() {
        val json = """{"posts":[{"id":5,"text":"t","display":{"version":1,"fold":true,"fold_at":10,"reactions_order":["❤️"],"reactors_more":{"❤️":2},"image_columns":2,"link_card_url":"u","link_card":{"kind":"youtube","url":"u","video_id":"v","image_aspect":"16:9","image_max_width":480},"mention_ranges":[{"start":0,"end":1,"name":"t"}],"user_links":[],"club_label":"雑談","club_unset":false,"future":1}}]}"""
        val d = ApiJson.decodeFromString<PostListResponse>(json).posts[0].display!!
        assertEquals(10, d.foldAt)
        assertEquals(mapOf("❤️" to 2), d.reactorsMore)
        assertEquals("v", d.linkCard?.videoId)
        assertEquals(480, d.linkCard?.imageMaxWidth)
        assertNull(ApiJson.decodeFromString<PostListResponse>("""{"posts":[{"id":5}]}""").posts[0].display)
    }

    /** url_preview is camelCase inside (the web's object); the snake_case naming must not hide it. */
    @Test fun urlPreviewCamelCaseInside() {
        val p = ApiJson.decodeFromString<UrlPreview>("""{"url":"u","siteName":"S","videoId":"v","spotify":{"embedUrl":"e","height":352}}""")
        assertEquals("S", p.siteName)
        assertEquals("v", p.videoId)
        assertEquals("e", p.spotify?.embedUrl)
    }

    /** One malformed display must not lose the page: that post's display is null (decided here). */
    @Test fun malformedDisplayIsDropped() {
        val json = """{"posts":[{"id":1,"text":"a","display":{"fold":true,"fold_at":"abc"}},{"id":2,"display":"x"},{"id":3,"display":null},{"id":4,"display":{"fold":false,"reactions_order":[1]}},{"id":5,"display":{"fold":false}}]}"""
        val ps = ApiJson.decodeFromString<PostListResponse>(json).posts
        assertEquals(listOf(1L, 2L, 3L, 4L, 5L), ps.map { it.id })
        assertEquals(listOf(null, null, null, null), ps.take(4).map { it.display })
        assertEquals(false, ps[4].display?.fold)
        // "500" as a string is read as 500 (ApiJson is lenient) — also fine.
        assertEquals(500, ApiJson.decodeFromString<PostListResponse>("""{"posts":[{"id":1,"display":{"fold":true,"fold_at":"500"}}]}""").posts[0].display?.foldAt)
    }

    @Test fun foldAtOutOfRangeIsClamped() {
        val t = "x".repeat(600)
        // Nothing before the fold (0 or less): not folded, the whole text shows.
        assertNull(TimelineRules.resolve(Post(1, text = t, display = PostDisplay(fold = true, foldAt = -5)), emptySet()).folded)
        assertNull(TimelineRules.resolve(Post(1, text = t, display = PostDisplay(fold = true, foldAt = 0)), emptySet()).folded)
        assertNull(TimelineRules.resolve(Post(1, text = t, display = PostDisplay(fold = true, foldAt = 99999)), emptySet()).folded)
        // A server cutting inside an emoji: the lone half is not drawn.
        val e = "a" + "🐶".repeat(300)
        assertEquals(499, TimelineRules.resolve(Post(1, text = e, display = PostDisplay(fold = true, foldAt = 500)), emptySet()).folded!!.length)
    }

    @Test fun linkCardKinds() {
        assertEquals("link", TimelineRules.linkCardOf(UrlPreview("https://y/", videoId = ""))?.kind)
        assertEquals("youtube", TimelineRules.linkCardOf(UrlPreview("https://y/", videoId = "v"))?.kind)
        assertEquals(152, TimelineRules.linkCardOf(UrlPreview("https://s/", spotify = SpotifyEmbed("e", 0)))?.embedHeight)
        assertEquals(352, TimelineRules.linkCardOf(UrlPreview("https://s/", spotify = SpotifyEmbed("e", 352)))?.embedHeight)
        assertNull(TimelineRules.linkCardOf(UrlPreview("")))
    }
}
