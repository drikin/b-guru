package fm.backspace.bguru.chat

import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue

/** 「チャットに引用」 (drikin 2026-10-20): a timeline post's link, put into the chat composer.
 *  The post's menu sets [pending]; MainScreen shows the chat and ChatScreen takes it into
 *  the draft once (and clears it). */
object ChatQuote {
    var pending by mutableStateOf<String?>(null)

    fun permalink(post: Post): String = "${Net.BASE}/#/post/${post.parentId ?: post.id}"

    fun forPost(post: Post): String =
        quoteText(post.authorName ?: "", post.text, post.images.isNotEmpty(), permalink(post), post.urlPreview?.title)
}

private const val EXCERPT_MAX = 40

/** `📝 {name} さんの投稿「{excerpt}」\n{permalink}\n` — no @, so nobody is notified.
 *  The excerpt is the first non-empty line, spaces collapsed, at most 40 characters
 *  (code points: an emoji is never cut in half) with … when cut; no text → 「写真」 when
 *  the post has images, else no 「…」 at all. Every @ in the excerpt becomes ＠ and
 *  Markdown marks are dropped ([excerptLine]). */
fun quoteText(authorName: String, text: String, hasImages: Boolean, permalink: String, linkTitle: String? = null): String {
    // URLs are taken out first: the quote is about the post, not the article it links to
    // (drikin 2026-10-20). A link-only post: the article's title from its link card.
    val line = text.lineSequence().map(::excerptLine).firstOrNull { it.isNotEmpty() }
        ?: linkTitle?.let(::excerptLine)?.takeIf { it.isNotEmpty() }
    val excerpt = when {
        line != null -> {
            val count = line.codePointCount(0, line.length)
            if (count <= EXCERPT_MAX) line
            else line.substring(0, line.offsetByCodePoints(0, EXCERPT_MAX)) + "…"
        }
        hasImages -> "写真"
        URL_RE.containsMatchIn(text) -> "リンク"
        else -> null
    }
    val name = authorName.ifBlank { "だれか" } // same as the Apple app and the web
    val head = if (excerpt != null) "📝 $name さんの投稿「$excerpt」" else "📝 $name さんの投稿"
    return "$head\n$permalink\n"
}

private val SPACES_RE = Regex("""[\s\u00A0\u3000]+""")
private val MD_LEAD_RE = Regex("""^(#{1,6} |> |- |\* |\+ |\d+\. )""")

/** One line of a post as quoted: spaces collapsed, @ → ＠ (a mention in the quote must not
 *  notify that member again), Markdown marks dropped (a leading heading / quote / list mark,
 *  every ** __ ~~ `), trimmed. */
private val URL_RE = Regex("""https?://\S+""")

internal fun excerptLine(raw: String): String {
    val line = URL_RE.replace(raw, " ").trim().split(SPACES_RE).joinToString(" ").replace('@', '＠')
    return MD_LEAD_RE.replace(line, "")
        .replace("**", "").replace("__", "").replace("~~", "").replace("`", "")
        .trim()
}

/** The quote after what is already in the draft (on a new line). */
fun appendQuote(draft: String, quote: String): String = when {
    draft.isEmpty() -> quote
    draft.endsWith("\n") -> draft + quote
    else -> draft + "\n" + quote
}

private val POST_LINK_RE = Regex("""^https://bsm\.backspace\.fm/#/post/(\d+)/?$""")

/** The post id of a B-guru post link (`https://bsm.backspace.fm/#/post/<id>`), else null. */
fun postIdFromUrl(url: String): Long? {
    val base = Regex.escape(Net.BASE)
    val m = POST_LINK_RE.find(url) ?: Regex("^$base/#/post/(\\d+)/?$").find(url) ?: return null
    return m.groupValues[1].toLongOrNull()
}
