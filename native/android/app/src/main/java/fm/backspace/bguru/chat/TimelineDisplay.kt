package fm.backspace.bguru.chat

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/** How a timeline post is shown — the web's rules, in one place (docs/timeline-spec.md §2–§5).
 *
 *  The server computes these decisions for every app (`include=display`, src/lib/timeline-display.ts
 *  `computePostDisplay`) and sends them as [PostDisplay]. When a post carries `display`, the app
 *  draws exactly that. When it does not (a server from before `display`), [compute] works out the
 *  same [PostDisplay] here with the same rules — checked against the shared examples
 *  (src/lib/__tests__/fixtures/timeline/, TimelineDisplayTest). The screen draws the [DisplayPlan]
 *  made from it and decides nothing itself. Pure Kotlin. */
object TimelineRules {
    /** Web TIMELINE_FOLD_AT: a text longer than this (JS `length` = UTF-16 units, the same as
     *  Kotlin's String.length) shows its first 500 units and 「続きを読む」. */
    const val FOLD_AT = 500
    /** Web REACTOR_LIMIT: the server lists at most 12 names per reaction; the rest is 「他N人」. */
    const val REACTOR_LIMIT = 12
    const val CLUB_UNSET = "__unset__"

    /** Where the text is cut when folded, or null when it is shown whole. 500 — or 499 when the
     *  500th unit is the first half of an emoji (foldPoint in timeline-display.ts). */
    fun foldPoint(text: String, limit: Int = FOLD_AT): Int? {
        if (text.length <= limit) return null
        return if (Character.isHighSurrogate(text[limit - 1])) limit - 1 else limit
    }

    /** Most reactions first; ties by the emoji's UTF-16 units (JS `<`, Kotlin String.compareTo).
     *  The app always sorts the reactions it holds with this (not display.reactions_order). */
    val reactionOrder: Comparator<Reaction> = Comparator { a, b -> if (a.count != b.count) b.count - a.count else a.emoji.compareTo(b.emoji) }

    fun orderReactions(list: List<Reaction>): List<Reaction> = list.sortedWith(reactionOrder)


    /** 「他N人」: how many reacted beyond the names listed (the server lists at most 12). */
    fun reactorsMore(r: Reaction): Int = maxOf(0, r.count - r.reactors.size)

    /** Who reacted, for the long-press list: at most 12 names, then 「他N人」. */
    data class Reactors(val names: List<String>, val others: Int)

    fun reactors(r: Reaction, more: Int? = null): Reactors {
        val names = r.reactors.take(REACTOR_LIMIT)
        return Reactors(names, more ?: maxOf(0, r.count - names.size))
    }

    /** Photo columns: 0 none, 1 one photo (at most 360 wide), 2 two, 3 for three or more. */
    fun imageColumns(count: Int): Int = if (count <= 0) 0 else minOf(count, 3)

    /** JavaScript's `\s` (the web's regexes): ASCII spaces plus the Unicode ones, e.g. U+3000. */
    private const val JS_SPACE = "\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF"
    private val MENTION_BRACKET = Regex("""@\[([^\]]+)]""")
    private val MENTION_WORD = Regex("""@([^$JS_SPACE@<\[]+)""")
    private val USER_LINK = Regex("""(?:https?://bsm\.backspace\.fm)?/?#/user/([^$JS_SPACE<)\]，。、]+)""")

    /** Members' @mentions in `text`, as findMentions in timeline-display.ts: `@[Name With Space]`
     *  first, then `@name` (up to a space, @, < or [) outside those; whole name, any case. */
    fun findMentions(text: String, memberNamesLower: Set<String>): List<MentionRange> {
        if (memberNamesLower.isEmpty() || text.isEmpty()) return emptyList()
        val first = MENTION_BRACKET.findAll(text).filter { it.groupValues[1].lowercase() in memberNamesLower }
            .map { MentionRange(it.range.first, it.range.last + 1, it.groupValues[1]) }.toList()
        val second = MENTION_WORD.findAll(text)
            .filter { m -> first.none { m.range.first >= it.start && m.range.first < it.end } && m.groupValues[1].lowercase() in memberNamesLower }
            .map { MentionRange(it.range.first, it.range.last + 1, it.groupValues[1]) }.toList()
        return (first + second).sortedBy { it.start }
    }

    /** `#/user/<id>` (also with the site's URL in front): a link to that member's profile. */
    fun findUserLinks(text: String): List<UserLink> =
        USER_LINK.findAll(text).map { UserLink(it.range.first, it.range.last + 1, it.groupValues[1]) }.toList()

    /** The link card for a preview: Spotify (the web embeds its player), YouTube (16:9 picture
     *  with ▶, at most 480 wide) or an ordinary card. */
    fun linkCardOf(p: UrlPreview?): LinkCard? {
        if (p == null || p.url.isEmpty()) return null
        p.spotify?.embedUrl?.takeIf { it.isNotEmpty() }?.let { return LinkCard("spotify", p.url, embedUrl = it, embedHeight = p.spotify.height?.takeIf { it > 0 } ?: 152) }
        p.videoId?.takeIf { it.isNotEmpty() }?.let { return LinkCard("youtube", p.url, videoId = it, imageAspect = "16:9", imageMaxWidth = 480) }
        return LinkCard("link", p.url)
    }

    /** The server's `display` for a post, worked out here (computePostDisplay in timeline-display.ts). */
    fun compute(post: Post, memberNamesLower: Set<String>, clubName: (String) -> String?): PostDisplay {
        val foldAt = foldPoint(post.text)
        val reactions = orderReactions(post.reactions.orEmpty())
        val card = linkCardOf(post.urlPreview)
        val club = post.club
        val unset = club == CLUB_UNSET
        val userLinks = findUserLinks(post.text)
        // The web links profiles first: an "@" inside one is not a mention.
        val mentions = findMentions(post.text, memberNamesLower).filter { m -> userLinks.none { m.start < it.end && m.end > it.start } }
        return PostDisplay(
            fold = foldAt != null,
            foldAt = foldAt,
            reactionsOrder = reactions.map { it.emoji },
            reactorsMore = reactions.associate { it.emoji to reactorsMore(it) },
            imageColumns = imageColumns(post.images.size),
            linkCardUrl = card?.url,
            linkCard = card,
            mentionRanges = mentions,
            // The old `#/user/<email>` form is never sent (no emails): plain text in the app.
            userLinks = userLinks.filter { '@' !in it.userId },
            clubLabel = if (club.isNullOrEmpty()) null else if (unset) "未設定" else clubName(club),
            clubUnset = unset,
        )
    }

    /** Everything the screen needs to draw one post: the server's `display`, or the same worked out here. */
    fun resolve(post: Post, memberNamesLower: Set<String>, clubName: (String) -> String? = { null }): DisplayPlan {
        val d = post.display ?: compute(post, memberNamesLower, clubName)
        // fold_at out of range (a broken server) is brought into the text; never cut an emoji in two.
        val folded = d.foldAt?.takeIf { d.fold }?.coerceIn(0, post.text.length)?.takeIf { it in 1 until post.text.length }?.let { at ->
            val cut = if (at > 0 && Character.isHighSurrogate(post.text[at - 1])) at - 1 else at
            post.text.substring(0, cut)
        }
        // The same rule as the server's reactions_order, applied to the reactions held here — so the
        // order is right straight after a tap too (the web re-sorts its optimistic list the same way).
        val reactions = orderReactions(post.reactions.orEmpty())
        // Mentions as the tokens written in the text ("@mazzo", "@[Taro Yamada]"): the renderer marks
        // them in the Markdown-rendered blocks (whose offsets differ from the raw text's).
        val mentions = d.mentionRanges.mapNotNull { r ->
            if (r.start in 0..r.end && r.end <= post.text.length) post.text.substring(r.start, r.end) else null
        }.toSet()
        val preview = post.urlPreview
        val card = d.linkCard?.takeIf { preview != null && it.url == preview.url && d.linkCardUrl == preview.url }
        // "Others N" from the reactions in hand (right after a tap too), like the order.
        return DisplayPlan(folded, reactions, reactions.associate { it.emoji to reactorsMore(it) }, mentions, card?.let { it to preview!! }, d.imageColumns, d.clubLabel, d.clubUnset)
    }

    /** A mention token as it is drawn: "@[Taro Yamada]" → "@Taro Yamada" (the web's link text). */
    fun mentionLabel(token: String): String =
        if (token.startsWith("@[") && token.endsWith("]")) "@" + token.substring(2, token.length - 1) else token

    /** Where each mention token sits in `text` (e.g. a block after Markdown): [start, end). */
    fun mentionRanges(text: String, tokens: Set<String>): List<IntRange> {
        if (tokens.isEmpty() || '@' !in text) return emptyList()
        val out = mutableListOf<IntRange>()
        val bracket = MENTION_BRACKET.findAll(text).filter { it.value in tokens }.map { it.range }.toList()
        out += bracket
        MENTION_WORD.findAll(text).forEach { m -> if (m.value in tokens && bracket.none { m.range.first in it }) out += m.range }
        return out.sortedBy { it.first }
    }

    /** Web: one photo at most 360 px wide (here dp). */
    const val SINGLE_IMAGE_MAX_WIDTH = 360f
    /** Not on the web (it lets a tall photo run as long as it is): a single photo is at most this
     *  tall, so a phone screenshot (9:19.5) does not fill the screen. Narrower instead, never cut. */
    const val SINGLE_IMAGE_MAX_HEIGHT = 480f
    /** In a 2- or 3-column grid a cell is at most this many times as tall as wide; a taller photo
     *  is fitted inside it (bars at the sides), never cut. */
    const val GRID_MAX_TALL = 2f

    /** One photo: its size in dp, from the room available and its width/height ratio. */
    fun singleImageSize(available: Float, ratio: Float): Pair<Float, Float> {
        var w = minOf(available, SINGLE_IMAGE_MAX_WIDTH)
        var h = w / ratio
        if (h > SINGLE_IMAGE_MAX_HEIGHT) { h = SINGLE_IMAGE_MAX_HEIGHT; w = h * ratio }
        return w to h
    }

    /** A grid cell's height for its width and the photo's ratio. */
    fun gridCellHeight(width: Float, ratio: Float): Float = minOf(width / ratio, width * GRID_MAX_TALL)

    /** The GIF is played (others are still photos). */
    fun isAnimated(url: String): Boolean = url.substringBefore('?').substringBefore('#').lowercase().endsWith(".gif")
}

/** The decisions for one post. `folded`: the text shown until 「続きを読む」 (null = whole).
 *  `linkCard`: which card and the preview it shows. */
@androidx.compose.runtime.Immutable
data class DisplayPlan(
    val folded: String?,
    val reactions: List<Reaction>,
    val reactorsMore: Map<String, Int>,
    val mentionTokens: Set<String>,
    val linkCard: Pair<LinkCard, UrlPreview>?,
    val imageColumns: Int,
    val clubLabel: String?,
    val clubUnset: Boolean,
)

/** `display` on a post (`include=display`, docs/timeline-spec.md §2). Snake case on the wire. */
@androidx.compose.runtime.Immutable
@Serializable
data class PostDisplay(
    val version: Int = 1,
    val fold: Boolean = false,
    val foldAt: Int? = null,
    val reactionsOrder: List<String> = emptyList(),
    val reactorsMore: Map<String, Int> = emptyMap(),
    val imageColumns: Int = 0,
    val linkCardUrl: String? = null,
    val linkCard: LinkCard? = null,
    val mentionRanges: List<MentionRange> = emptyList(),
    val userLinks: List<UserLink> = emptyList(),
    val clubLabel: String? = null,
    val clubUnset: Boolean = false,
)

/** `kind`: "spotify" | "youtube" | "link". */
@androidx.compose.runtime.Immutable
@Serializable
data class LinkCard(
    val kind: String,
    val url: String,
    val embedUrl: String? = null,
    val embedHeight: Int? = null,
    val videoId: String? = null,
    val imageAspect: String? = null,
    val imageMaxWidth: Int? = null,
)

@Serializable data class MentionRange(val start: Int, val end: Int, val name: String)
@Serializable data class UserLink(val start: Int, val end: Int, val userId: String)

/** The Spotify player for a link (posts.url_preview.spotify — camelCase inside, like the web's). */
@androidx.compose.runtime.Immutable
@Serializable
data class SpotifyEmbed(
    @kotlinx.serialization.json.JsonNames("embedUrl") val embedUrl: String? = null,
    @SerialName("height") val height: Int? = null,
    @SerialName("kind") val kind: String? = null,
)

/** `display` that can never break a page of posts: a malformed one (wrong types — `"fold_at":"500"`,
 *  `"display":"x"`) decodes as null, and the post is drawn with the rules worked out here. */
object SafePostDisplay : kotlinx.serialization.KSerializer<PostDisplay?> {
    override val descriptor = kotlinx.serialization.descriptors.PrimitiveSerialDescriptor("SafePostDisplay", kotlinx.serialization.descriptors.PrimitiveKind.STRING)

    override fun deserialize(decoder: kotlinx.serialization.encoding.Decoder): PostDisplay? {
        val json = decoder as? kotlinx.serialization.json.JsonDecoder ?: return null
        val el = json.decodeJsonElement()
        if (el !is kotlinx.serialization.json.JsonObject) return null
        return runCatching { json.json.decodeFromJsonElement(PostDisplay.serializer(), el) }.getOrNull()
    }

    override fun serialize(encoder: kotlinx.serialization.encoding.Encoder, value: PostDisplay?) {
        val json = encoder as? kotlinx.serialization.json.JsonEncoder ?: error("JSON only")
        json.encodeJsonElement(if (value == null) kotlinx.serialization.json.JsonNull else json.json.encodeToJsonElement(PostDisplay.serializer(), value))
    }
}
