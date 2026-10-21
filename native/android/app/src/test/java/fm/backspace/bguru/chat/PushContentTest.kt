package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class PushContentTest {
    @Test fun timelineTitleUsesAuthorOrFallback() {
        assertEquals("mazzo が投稿しました", PushContent.timelineTitle("mazzo"))
        assertEquals("mazzo が投稿しました", PushContent.timelineTitle("  mazzo "))
        assertEquals("B-guru タイムライン", PushContent.timelineTitle(null))
        assertEquals("B-guru タイムライン", PushContent.timelineTitle(" "))
    }

    @Test fun timelineTextIsTrimmedToTheStart() {
        assertEquals("こんにちは", PushContent.timelineText(" こんにちは\n"))
        assertEquals("新しい投稿があります", PushContent.timelineText(""))
        assertEquals("新しい投稿があります", PushContent.timelineText(null))
        val long = "あ".repeat(300)
        val out = PushContent.timelineText(long)
        assertEquals(PushContent.TIMELINE_TEXT_MAX + 1, out.length)
        assertTrue(out.endsWith("…"))
        assertEquals("あ".repeat(240), PushContent.timelineText("あ".repeat(240)))
    }

    @Test fun defaultsPerKind() {
        assertEquals("B-guru タイムライン", PushContent.defaultTitle("timeline_new"))
        assertEquals("新しい投稿があります", PushContent.defaultText("timeline_new"))
        assertEquals("新しい投稿があります", PushContent.publicText("timeline_new"))
        assertEquals("B-guru", PushContent.defaultTitle("reply"))
        assertEquals("B-guru チャット", PushContent.defaultTitle("chat_new"))
        assertEquals("新着メッセージがあります", PushContent.defaultText("chat_new"))
        assertEquals("あなたの投稿に返信がありました", PushContent.defaultText("reply"))
    }

    @Test fun tapOpensThreadForPosts() {
        assertTrue(PushContent.opensThread("timeline_new"))
        assertTrue(PushContent.opensThread("reply"))
        assertFalse(PushContent.opensThread("chat_new"))
        assertFalse(PushContent.opensThread("chat_mention"))
    }

    @Test fun notificationIdsArePerPostAndDistinct() {
        assertEquals(1, PushContent.notificationId("chat_new", 5, null, 1))
        assertEquals(105, PushContent.notificationId("chat_mention", 5, null, 1))
        assertEquals(1_000_042, PushContent.notificationId("reply", null, 42, 1))
        assertEquals(3_000_042, PushContent.notificationId("timeline_new", null, 42, 1))
        assertTrue(PushContent.notificationId("timeline_new", null, 42, 1) != PushContent.notificationId("timeline_new", null, 43, 1))
    }

    @Test fun registrationSignatureChangesWithAnyInput() {
        val base = PushContent.registrationSignature("fcm", "all", true, false, "tok")
        assertEquals(base, PushContent.registrationSignature("fcm", "all", true, false, "tok"))
        assertTrue(base != PushContent.registrationSignature("fcm2", "all", true, false, "tok"))
        assertTrue(base != PushContent.registrationSignature("fcm", "mentions", true, false, "tok"))
        assertTrue(base != PushContent.registrationSignature("fcm", "all", false, false, "tok"))
        assertTrue(base != PushContent.registrationSignature("fcm", "all", true, true, "tok"))
        assertTrue(base != PushContent.registrationSignature("fcm", "all", true, false, "tok2"))
        // notify_shogi is part of it (devices register again once to say they take ☗ 将棋 pushes).
        assertTrue(base != PushContent.registrationSignature("fcm", "all", true, false, "tok", shogi = false))
        assertFalse(base.contains("fcm") || base.contains("tok"))
    }

    @Test fun shogiPushes() {
        assertTrue(PushContent.isShogi("shogi_offer"))
        assertTrue(PushContent.isShogi("shogi_turn"))
        assertFalse(PushContent.isShogi("chat_new"))
        assertEquals("☗ 将棋", PushContent.defaultTitle("shogi_offer"))
        assertEquals("対局の申し込みが届きました", PushContent.shogiText("shogi_offer", null))
        assertEquals("あなたの番です", PushContent.shogiText("shogi_turn", null))
        assertEquals("将棋の通知があります", PushContent.publicText("shogi_turn"))
        val g = ShogiGame(7, "offered", "slow", creator = ShogiPlayer("a", "mazzo"))
        assertEquals("mazzo さんから対局の申し込み（🐢ゆっくり）", PushContent.shogiText("shogi_offer", g))
        // One notification per game: the offer and the turn replace each other.
        assertEquals(PushContent.notificationId("shogi_offer", null, 7, 1), PushContent.notificationId("shogi_turn", null, 7, 1))
        assertTrue(PushContent.notificationId("shogi_turn", null, 7, 1) != PushContent.notificationId("timeline_new", null, 7, 1))
    }
}
