package fm.backspace.bguru.chat

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** 「ネタ帳に送る」: which URLs a post can send, and the result text. */
class NetaTest {
    @Test fun previewFirstThenTextInOrder() {
        assertEquals(
            listOf("https://card.example/a", "https://x.example/1", "http://y.example/2"),
            netaCandidates("見て https://x.example/1 と http://y.example/2", "https://card.example/a"),
        )
    }

    @Test fun trailingPunctuationIsDropped() {
        assertEquals(listOf("https://a.example/p"), netaCandidates("これ https://a.example/p。", null))
        assertEquals(listOf("https://a.example/p"), netaCandidates("(https://a.example/p)」", null))
        assertEquals(listOf("https://a.example/q"), netaCandidates("「https://a.example/q」『x』", null))
        assertEquals(listOf("https://a.example/r"), netaCandidates("see https://a.example/r!?, ok", null))
        assertEquals(listOf("https://a.example/s"), netaCandidates("[t](https://a.example/s)", null))
        assertEquals(listOf("https://a.example/t"), netaCandidates("https://a.example/t、https://a.example/t】", null))
    }

    @Test fun bguruItselfIsExcluded() {
        assertEquals(emptyList<String>(), netaCandidates("https://bsm.backspace.fm/#/post/42 https://BSM.backspace.fm", null))
        assertEquals(emptyList<String>(), netaCandidates("", "https://bsm.backspace.fm/#/post/1"))
        assertEquals(listOf("https://neta.backspace.fm/x"), netaCandidates("https://bsm.backspace.fm https://neta.backspace.fm/x", null))
    }

    @Test fun japaneseAfterUrlIsNotPartOfIt() {
        assertEquals(listOf("https://a.example/p"), netaCandidates("https://a.example/p、これ（https://a.example/p）", null))
        assertEquals(listOf("https://a.example/"), netaCandidates("https://A.example です https://a.example/", null))
    }

    @Test fun duplicatesOnce() {
        assertEquals(listOf("https://a.example/p"), netaCandidates("https://a.example/p https://a.example/p。", "https://a.example/p"))
    }

    @Test fun nothingToSend() {
        assertEquals(emptyList<String>(), netaCandidates("リンクなし", null))
        assertEquals(emptyList<String>(), netaCandidates("ftp://a.example/x mailto:a@b.c", "  "))
        assertEquals(emptyList<String>(), netaCandidates("https://", null))
        assertEquals(emptyList<String>(), netaCandidates("https://user:pw@a.example/x", null))
    }

    @Test fun resultTexts() {
        assertEquals(true to "ネタ帳に送りました",
            netaResultMessage(201, NetaResponse(ok = true, topicId = JsonPrimitive(5), site = "https://neta.backspace.fm")))
        assertEquals(false to "今週のネタ帳には mazzo さんが「記事」として投稿済みです",
            netaResultMessage(409, NetaResponse(ok = false, code = "duplicate", error = "x",
                existing = NetaResponse.NetaExisting(title = "記事", submitter = "mazzo"))))
        assertEquals(false to "1 時間に送れるのは 20 件までです",
            netaResultMessage(429, NetaResponse(ok = false, code = "rate_limited", error = "1 時間に送れるのは 20 件までです")))
        val (ok, text) = netaResultMessage(502, null)
        assertEquals(false, ok); assertTrue(text.contains("502"))
    }

    @Test fun replyParsesCamelCaseTopicId() {
        val r = ApiJson.decodeFromString<NetaResponse>("""{"apiVersion":3,"ok":true,"topicId":12,"site":"https://neta.backspace.fm"}""")
        assertEquals(true, r.ok); assertEquals("https://neta.backspace.fm", r.site)
        val d = ApiJson.decodeFromString<NetaResponse>("""{"ok":false,"code":"duplicate","error":"e","existing":{"title":"T","submitter":"S"}}""")
        assertEquals("S", d.existing?.submitter)
    }
}
