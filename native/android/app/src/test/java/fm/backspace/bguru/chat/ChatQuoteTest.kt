package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** 「チャットに引用」: the text put into the chat composer. */
class ChatQuoteTest {
    private val link = "https://bsm.backspace.fm/#/post/42"

    @Test fun shortText() {
        assertEquals("📝 takuto さんの投稿「うちの猫です」\n$link\n", quoteText("takuto", "うちの猫です", false, link))
    }

    @Test fun firstNonEmptyLineWithSpacesCollapsed() {
        assertEquals("📝 a さんの投稿「一行目 です」\n$link\n", quoteText("a", "\n  \n  一行目   です \n二行目", false, link))
        assertEquals("📝 a さんの投稿「a b c」\n$link\n", quoteText("a", "a\tb　c", false, link))
    }

    @Test fun fortyCharactersExactlyIsNotCut() {
        val t = "あ".repeat(40)
        assertEquals("📝 a さんの投稿「$t」\n$link\n", quoteText("a", t, false, link))
    }

    @Test fun longTextIsCutAtFortyWithEllipsis() {
        val t = "あ".repeat(39) + "いう"
        assertEquals("📝 a さんの投稿「${"あ".repeat(39)}い…」\n$link\n", quoteText("a", t, false, link))
    }

    @Test fun emojiIsNeverCutInHalf() {
        // 39 letters, then emoji (two UTF-16 units each): the 40th code point is the whole 😺.
        val t = "x".repeat(39) + "😺😺😺"
        assertEquals("📝 a さんの投稿「${"x".repeat(39)}😺…」\n$link\n", quoteText("a", t, false, link))
        // All emoji: 40 of them kept, then …
        val e = "🐈".repeat(45)
        assertEquals("📝 a さんの投稿「${"🐈".repeat(40)}…」\n$link\n", quoteText("a", e, false, link))
        // 40 emoji is 80 UTF-16 units, but not cut.
        val forty = "🐈".repeat(40)
        assertEquals("📝 a さんの投稿「$forty」\n$link\n", quoteText("a", forty, false, link))
    }

    @Test fun noTextWithImagesSaysPhoto() {
        assertEquals("📝 a さんの投稿「写真」\n$link\n", quoteText("a", "", true, link))
        assertEquals("📝 a さんの投稿「写真」\n$link\n", quoteText("a", " \n ", true, link))
    }

    @Test fun noTextNoImagesHasNoExcerpt() {
        assertEquals("📝 a さんの投稿\n$link\n", quoteText("a", "", false, link))
    }

    @Test fun noMention() {
        val q = quoteText("ドリキン", "見て", false, link)
        assertEquals(false, q.contains("@"))
    }

    @Test fun atInTheExcerptBecomesFullWidth() {
        assertEquals("📝 a さんの投稿「長崎らしいものを食す旅に出た ＠住吉商店街」\n$link\n",
            quoteText("a", "長崎らしいものを食す旅に出た @住吉商店街", false, link))
        assertEquals("📝 a さんの投稿「＠[ドリキン] ＠takuto 見て」\n$link\n", quoteText("a", "@[ドリキン] @takuto 見て", false, link))
    }

    @Test fun markdownMarksAreDropped() {
        assertEquals("📝 ビーグル さんの投稿「🐾 ビーグル更新情報（10/14〜10/19）」\n$link\n",
            quoteText("ビーグル", "## 🐾 ビーグル更新情報（10/14〜10/19）\n\n今週は", false, link))
        assertEquals("太字 と code", excerptLine("- **太字** と `code`"))
        assertEquals("見出し", excerptLine("###### 見出し"))
        assertEquals("引用", excerptLine("> 引用"))
        assertEquals("項目", excerptLine("* 項目"))
        assertEquals("項目", excerptLine("+ 項目"))
        assertEquals("番号", excerptLine("1. 番号"))
        assertEquals("番号", excerptLine("12. 番号"))
        assertEquals("消し 下線", excerptLine("~~消し~~ __下線__"))
        assertEquals("#タグ", excerptLine("#タグ"))          // not a heading (no space)
        assertEquals("＠住吉 太字", excerptLine("@住吉 **太字**"))
        // A line of marks only: the next line is quoted.
        assertEquals("📝 a さんの投稿「本文」\n$link\n", quoteText("a", "**\n本文", false, link))
    }

    @Test fun permalinkOfAReplyIsItsThread() {
        assertEquals("${Net.BASE}/#/post/7", ChatQuote.permalink(Post(9, parentId = 7, text = "", createdAt = "")))
        assertEquals("${Net.BASE}/#/post/9", ChatQuote.permalink(Post(9, text = "", createdAt = "")))
    }

    @Test fun appendKeepsTheDraft() {
        assertEquals("q\n", appendQuote("", "q\n"))
        assertEquals("hello\nq\n", appendQuote("hello", "q\n"))
        assertEquals("hello\nq\n", appendQuote("hello\n", "q\n"))
    }

    @Test fun postLinks() {
        assertEquals(123L, postIdFromUrl("https://bsm.backspace.fm/#/post/123"))
        assertEquals(5L, postIdFromUrl("${Net.BASE}/#/post/5"))
        assertNull(postIdFromUrl("https://bsm.backspace.fm/#/chat"))
        assertNull(postIdFromUrl("https://example.com/#/post/1"))
        assertNull(postIdFromUrl("https://bsm.backspace.fm.evil.com/#/post/1"))
        assertNull(postIdFromUrl("https://bsm.backspace.fm/#/post/1x"))
    }

    @Test fun quoteIsAboutThePostNotTheArticle() {
        val link = "https://bsm.backspace.fm/#/post/8729"
        assertEquals("📝 NORIO さんの投稿「ソニー、ウォークマン最新モデル」\n$link\n",
            quoteText("NORIO", "https://share.google/zFOWugfJDxbbvwVRe", false, link, "ソニー、ウォークマン最新モデル"))
        assertEquals("📝 Kenta さんの投稿「これは試す価値ありそうだな」\n$link\n",
            quoteText("Kenta", "これは試す価値ありそうだな https://l.smartnews.com/m-8lgVyveg/bL5jK9", false, link))
        assertEquals("📝 a さんの投稿「リンク」\n$link\n", quoteText("a", "https://example.com/x", false, link))
    }
}
