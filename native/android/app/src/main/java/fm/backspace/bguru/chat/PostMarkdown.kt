package fm.backspace.bguru.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** A post's text with its Markdown drawn, like the web timeline (src/lib/md.ts: GFM,
 *  line breaks kept) and the Apple apps (native/shared/PostMarkdown.swift). Headings,
 *  lists, quotes, rules and code blocks are blocks; bold, italic, `code`, ~~strike~~
 *  and [links](…) inside them. Bare URLs stay tappable; members' @mentions are marked
 *  like the web's (only names of members — TimelineRules.mentionTokens). Text with
 *  no Markdown in it is drawn exactly as before. */
@Composable
fun PostText(text: String, mentions: Set<String> = emptySet()) {
    val blocks = remember(text) { PostMarkdown.cached(text) }
    val single = blocks.singleOrNull() as? PostMarkdown.Block.Paragraph
    if (single != null) {
        MentionText(single.text, mentions, fontSize = 16.sp)
        return
    }
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        blocks.forEach { b ->
            when (b) {
                is PostMarkdown.Block.Paragraph -> MentionText(b.text, mentions, fontSize = 16.sp)
                is PostMarkdown.Block.Heading -> MentionText(
                    b.text, mentions,
                    fontSize = when (b.level) { 1 -> 20.sp; 2 -> 18.sp; else -> 16.sp },
                    fontWeight = FontWeight.Bold,
                    modifier = Modifier.padding(top = 2.dp),
                )
                is PostMarkdown.Block.Item -> Row(Modifier.padding(start = (b.indent * 16 + 2).dp), horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(b.marker, fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant)
                    MentionText(b.text, mentions, fontSize = 16.sp)
                }
                is PostMarkdown.Block.Quote -> Row(Modifier.height(IntrinsicSize.Min)) {
                    Box(Modifier.width(3.dp).fillMaxHeight().background(MaterialTheme.colorScheme.outlineVariant, RoundedCornerShape(2.dp)))
                    MentionText(b.text, mentions, fontSize = 16.sp, color = MaterialTheme.colorScheme.onSurfaceVariant, modifier = Modifier.padding(start = 8.dp))
                }
                is PostMarkdown.Block.Code -> Text(
                    b.text,
                    fontFamily = FontFamily.Monospace,
                    fontSize = 14.sp,
                    modifier = Modifier.fillMaxWidth()
                        .background(MaterialTheme.colorScheme.onSurface.copy(alpha = 0.06f), RoundedCornerShape(6.dp))
                        .padding(8.dp),
                )
                PostMarkdown.Block.Rule -> HorizontalDivider(Modifier.padding(vertical = 4.dp))
            }
        }
    }
}

/** Text with the members' @mentions drawn like the web's (globals.css `a[href^="#mention-"]`):
 *  green, semi-bold, on a light green rounded patch; `@[Full Name]` shows as "@Full Name". Only
 *  tokens in `mentions` (members' names — TimelineRules) are marked; any other "@…" stays text. */
@Composable
private fun MentionText(
    text: AnnotatedString,
    mentions: Set<String>,
    modifier: Modifier = Modifier,
    fontSize: androidx.compose.ui.unit.TextUnit = 16.sp,
    fontWeight: FontWeight? = null,
    color: Color = Color.Unspecified,
) {
    val dark = androidx.compose.foundation.isSystemInDarkTheme()
    val fg = if (dark) Color(0xFF4ADE80) else Color(0xFF15803D)
    val patch = if (dark) Color(0xFF13241A) else Color(0xFFF0FDF4)
    val marked = remember(text, mentions, fg) { PostMarkdown.markMentions(text, mentions, fg) }
    if (marked === text) {
        Text(text, modifier, fontSize = fontSize, fontWeight = fontWeight, color = color)
        return
    }
    var layout by remember { mutableStateOf<androidx.compose.ui.text.TextLayoutResult?>(null) }
    val ranges = remember(marked) { marked.getStringAnnotations(PostMarkdown.MENTION_TAG, 0, marked.length) }
    Text(
        marked,
        modifier.drawBehind {
            val l = layout ?: return@drawBehind
            val padX = 3.dp.toPx()
            val r = androidx.compose.ui.geometry.CornerRadius(4.dp.toPx())
            ranges.forEach { a ->
                val first = l.getLineForOffset(a.start)
                val last = l.getLineForOffset(maxOf(a.start, a.end - 1))
                for (line in first..last) {
                    val left = if (line == first) l.getHorizontalPosition(a.start, true) else l.getLineLeft(line)
                    val right = if (line == last) l.getHorizontalPosition(a.end, true) else l.getLineRight(line)
                    drawRoundRect(patch, androidx.compose.ui.geometry.Offset(minOf(left, right) - padX, l.getLineTop(line) + 1f),
                        androidx.compose.ui.geometry.Size(kotlin.math.abs(right - left) + padX * 2, l.getLineBottom(line) - l.getLineTop(line) - 2f), r)
                }
            }
        },
        fontSize = fontSize, fontWeight = fontWeight, color = color,
        onTextLayout = { layout = it },
    )
}

object PostMarkdown {
    const val MENTION_TAG = "mention"

    /** `text` with each member mention (a token in `mentions`) replaced by its label, styled and
     *  tagged [MENTION_TAG]. The same instance when there is none. */
    fun markMentions(text: AnnotatedString, mentions: Set<String>, color: Color): AnnotatedString {
        val ranges = TimelineRules.mentionRanges(text.text, mentions)
        if (ranges.isEmpty()) return text
        return buildAnnotatedString {
            var at = 0
            ranges.forEach { r ->
                append(text.subSequence(at, r.first))
                val label = TimelineRules.mentionLabel(text.text.substring(r.first, r.last + 1))
                pushStringAnnotation(MENTION_TAG, label)
                withStyle(SpanStyle(color = color, fontWeight = FontWeight.SemiBold)) { append(label) }
                pop()
                at = r.last + 1
            }
            append(text.subSequence(at, text.length))
        }
    }

    sealed interface Block {
        data class Paragraph(val text: AnnotatedString) : Block
        data class Heading(val level: Int, val text: AnnotatedString) : Block
        /** A list item: nesting level, "•" or "1.", text. */
        data class Item(val indent: Int, val marker: String, val text: AnnotatedString) : Block
        data class Quote(val text: AnnotatedString) : Block
        data class Code(val text: String) : Block
        data object Rule : Block
    }

    private val HINT = Regex("""(^|\n)[ \t]*(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|```|(-{3,}|\*{3,}|_{3,})[ \t]*(\n|$))|\*\*|__|~~|`|\[[^\]\n]+]\([^)\s]+\)|(^|[\s(])[*_][^\s*_]""")
    private val HEADING = Regex("""^[ \t]*(#{1,6})[ \t]+(.*?)[ \t#]*$""")
    private val RULE = Regex("""^[ \t]*(-[ \t]*){3,}$|^[ \t]*(\*[ \t]*){3,}$|^[ \t]*(_[ \t]*){3,}$""")
    private val ITEM = Regex("""^([ \t]*)([-*+]|\d{1,3}[.)])[ \t]+(.*)$""")
    private val LINK = Regex("""^\[([^\]\n]+)]\(([^)\s]+)\)""")
    private val URL_RE = Regex("""https?://[^\s<>"]+""")
    private val linkStyle = TextLinkStyles(SpanStyle(color = AccentGreen, textDecoration = TextDecoration.Underline))

    fun looksLikeMarkdown(s: String) = HINT.containsMatchIn(s)

    /** Plain text with its URLs tappable. @mentions are not coloured here: only members' are
     *  marked, by [markMentions] (the chat's `linkified` colours every "@…"). */
    private fun urlsOnly(s: String): AnnotatedString = buildAnnotatedString {
        append(s)
        URL_RE.findAll(s).forEach {
            val url = it.value.trimEnd('.', ',', ')', '」', '。')
            addLink(LinkAnnotation.Url(url, linkStyle), it.range.first, it.range.first + url.length)
        }
    }

    fun blocks(s: String): List<Block> = if (!looksLikeMarkdown(s)) listOf(Block.Paragraph(urlsOnly(s))) else parse(s)

    /** Parsed posts by text: the timeline parses them when they arrive ([warm], off the
     *  main thread), so a row coming on screen while scrolling only looks them up. */
    private val parsed = android.util.LruCache<String, List<Block>>(400)

    fun cached(s: String): List<Block> = parsed.get(s) ?: blocks(s).also { parsed.put(s, it) }

    /** Any thread. */
    fun warm(texts: List<String>) { texts.forEach { if (parsed.get(it) == null) parsed.put(it, blocks(it)) } }

    fun parse(s: String): List<Block> {
        val out = mutableListOf<Block>()
        val para = mutableListOf<String>()
        val quote = mutableListOf<String>()
        fun flushPara() { if (para.isNotEmpty()) { out += Block.Paragraph(inline(para.joinToString("\n"))); para.clear() } }
        fun flushQuote() { if (quote.isNotEmpty()) { out += Block.Quote(inline(quote.joinToString("\n"))); quote.clear() } }
        fun flush() { flushPara(); flushQuote() }
        val lines = s.replace("\r\n", "\n").split("\n")
        var i = 0
        while (i < lines.size) {
            val line = lines[i]
            val trimmed = line.trim()
            if (trimmed.startsWith("```")) {
                flush()
                val code = mutableListOf<String>()
                i++
                while (i < lines.size && !lines[i].trim().startsWith("```")) { code += lines[i]; i++ }
                out += Block.Code(code.joinToString("\n"))
                i++
                continue
            }
            val h = HEADING.find(line)
            val it = ITEM.find(line)
            when {
                trimmed.isEmpty() -> flush()
                h != null -> { flush(); out += Block.Heading(h.groupValues[1].length, inline(h.groupValues[2])) }
                RULE.matches(line) -> { flush(); out += Block.Rule }
                it != null -> {
                    flush()
                    val indent = it.groupValues[1].replace("\t", "  ").length / 2
                    val m = it.groupValues[2]
                    val marker = if (m.first().isDigit()) m.replace(")", ".") else "•"
                    out += Block.Item(minOf(indent, 4), marker, inline(it.groupValues[3]))
                }
                trimmed.startsWith(">") -> { flushPara(); quote += trimmed.drop(1).trim() }
                else -> { flushQuote(); para += line }
            }
            i++
        }
        flush()
        return out.ifEmpty { listOf(Block.Paragraph(urlsOnly(s))) }
    }

    /** Bold / italic / code / strike / links inside a block, then bare URLs and @mentions. */
    fun inline(s: String): AnnotatedString {
        val base = buildAnnotatedString { appendInline(s) }
        return buildAnnotatedString {
            append(base)
            val t = base.text
            URL_RE.findAll(t).forEach {
                val url = it.value.trimEnd('.', ',', ')', '」', '。')
                val end = it.range.first + url.length
                if (base.getLinkAnnotations(it.range.first, end).isEmpty()) addLink(LinkAnnotation.Url(url, linkStyle), it.range.first, end)
            }
        }
    }

    private fun AnnotatedString.Builder.appendInline(s: String) {
        var i = 0
        while (i < s.length) {
            val c = s[i]
            if (c == '`') {
                val j = s.indexOf('`', i + 1)
                if (j > i + 1) {
                    withStyle(SpanStyle(fontFamily = FontFamily.Monospace, background = Color.Gray.copy(alpha = 0.15f))) { append(s.substring(i + 1, j)) }
                    i = j + 1; continue
                }
            }
            if (s.startsWith("**", i) || s.startsWith("__", i) || s.startsWith("~~", i)) {
                val d = s.substring(i, i + 2)
                val j = s.indexOf(d, i + 2)
                if (j > i + 2 && (d != "__" || i == 0 || !s[i - 1].isLetterOrDigit())) {
                    val style = if (d == "~~") SpanStyle(textDecoration = TextDecoration.LineThrough) else SpanStyle(fontWeight = FontWeight.Bold)
                    withStyle(style) { appendInline(s.substring(i + 2, j)) }
                    i = j + 2; continue
                }
            }
            if ((c == '*' || c == '_') && i + 1 < s.length && !s[i + 1].isWhitespace() && (c == '*' || i == 0 || !s[i - 1].isLetterOrDigit())) {
                var j = s.indexOf(c, i + 1)
                while (j > 0 && (s[j - 1].isWhitespace() || (c == '_' && j + 1 < s.length && s[j + 1].isLetterOrDigit()))) j = s.indexOf(c, j + 1)
                if (j > i + 1) {
                    withStyle(SpanStyle(fontStyle = FontStyle.Italic)) { appendInline(s.substring(i + 1, j)) }
                    i = j + 1; continue
                }
            }
            if (c == '[') {
                val m = LINK.find(s.substring(i))
                if (m != null) {
                    val url = m.groupValues[2]
                    if (url.startsWith("http://") || url.startsWith("https://")) {
                        withLink(LinkAnnotation.Url(url, linkStyle)) { appendInline(m.groupValues[1]) }
                    } else {
                        appendInline(m.groupValues[1])
                    }
                    i += m.value.length; continue
                }
            }
            append(c)
            i++
        }
    }
}
