package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 🍻 チャットの読み上げ: what is read, the words, the 2-minute drop. */
class OffkaiReadAloudTest {
    private fun msg(body: String, name: String? = "mazzo", images: List<String> = emptyList(), kind: String? = null, mine: Boolean = false, id: Long = 10) =
        ChatMessage(id = id, authorId = "u1", authorName = name, body = body, isAuthor = mine, images = images, kind = kind)

    @Test fun whatIsRead() {
        assertTrue(OffkaiReadAloud.shouldRead(msg("こんばんは"), alreadyShown = false))
        assertFalse(OffkaiReadAloud.shouldRead(msg("答えです", kind = "beagle_ai"), alreadyShown = false))
        assertFalse(OffkaiReadAloud.shouldRead(msg("こんばんは", mine = true), alreadyShown = false)) // mine
        assertFalse(OffkaiReadAloud.shouldRead(msg("こんばんは"), alreadyShown = true)) // on screen already
        assertFalse(OffkaiReadAloud.shouldRead(msg("mazzo が部室に入りました", kind = "notice"), alreadyShown = false))
        assertFalse(OffkaiReadAloud.shouldRead(msg("☗ 対局", kind = "shogi"), alreadyShown = false))
        assertFalse(OffkaiReadAloud.shouldRead(msg("x", kind = "some_card"), alreadyShown = false)) // unknown cards
        assertFalse(OffkaiReadAloud.shouldRead(msg("x", id = -1), alreadyShown = false)) // not stored
    }

    @Test fun words() {
        assertEquals("mazzoさん、こんばんは", OffkaiReadAloud.speech(msg("こんばんは")))
        assertEquals("こんばんは", OffkaiReadAloud.speech(msg("こんばんは", name = " ")))
        assertEquals("mazzoさん、これ見て リンク", OffkaiReadAloud.speech(msg("これ見て https://example.com/a?b=c")))
        assertEquals("mazzoさん、リンク と リンク", OffkaiReadAloud.speech(msg("HTTP://a.jp\nと\n\nhttps://b.jp/x")))
        assertEquals("mazzoさんが写真を送りました", OffkaiReadAloud.speech(msg(ChatMessage.PHOTO_PLACEHOLDER, images = listOf("/api/media/a.jpg"))))
        assertEquals("mazzoさんが写真を送りました", OffkaiReadAloud.speech(msg("", images = listOf("/api/media/a.jpg"))))
        assertEquals("mazzoさん、乾杯", OffkaiReadAloud.speech(msg("乾杯", images = listOf("/api/media/a.jpg")))) // photo + text: the text
        assertEquals("写真が送られました", OffkaiReadAloud.speech(msg("", name = null, images = listOf("/api/media/a.jpg"))))
        assertNull(OffkaiReadAloud.speech(msg("   ")))
    }

    @Test fun urlsNewlinesAndPhotos() {
        // Japanese right after a URL is not swallowed (ASCII non-space only).
        assertEquals("mazzoさん、リンクを見て", OffkaiReadAloud.speech(msg("https://example.com/a?b=cを見て")))
        assertEquals("mazzoさん、ここ リンク、どう？", OffkaiReadAloud.speech(msg("ここ https://x.jp/p#q、どう？")))
        // Newlines fold into one space.
        assertEquals("mazzoさん、一行目 二行目 三行目", OffkaiReadAloud.speech(msg("一行目\n二行目\r\n\n  三行目\n")))
        // Photo + text: the text (URL rule applies too).
        assertEquals("mazzoさん、二軒目 リンク", OffkaiReadAloud.speech(msg("二軒目\nhttps://maps.example/x", images = listOf("/api/media/a.jpg", "/api/media/b.jpg"))))
    }

    @Test fun watchdog() {
        assertEquals(5_000L + 3 * 200L, OffkaiReadAloud.watchdogMs("あいう"))
        assertEquals(5_000L + 200L, OffkaiReadAloud.watchdogMs("🍻"))
    }

    @Test fun longBodiesAreCut() {
        val eighty = "あ".repeat(80)
        assertEquals(eighty, OffkaiReadAloud.body(eighty))
        assertEquals(eighty + "、以下略", OffkaiReadAloud.body(eighty + "い"))
        // A space at the cut is not left before 「、以下略」.
        assertEquals("あ".repeat(79) + "、以下略", OffkaiReadAloud.body("あ".repeat(79) + " いいい"))
        // Whole characters: an emoji (two UTF-16 units) is never split.
        val emojis = "🍻".repeat(81)
        assertEquals("🍻".repeat(80) + "、以下略", OffkaiReadAloud.body(emojis))
    }

    @Test fun staleOnesAreDropped() {
        val q = ArrayDeque(listOf(0L, 50_000L, 130_000L))
        // At 170 s: the first two waited 2 minutes or more.
        assertEquals(130_000L, OffkaiReadAloud.nextFresh(q, 170_000L) { it })
        assertTrue(q.isEmpty())
        val q2 = ArrayDeque(listOf(0L))
        assertNull(OffkaiReadAloud.nextFresh(q2, OffkaiReadAloud.STALE_MS) { it })
        assertEquals(5L, OffkaiReadAloud.nextFresh(ArrayDeque(listOf(5L, 6L)), 10L) { it })
    }
}
