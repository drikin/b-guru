package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 📝 ネタ帳タブ (2026-11-14): where the WebView's navigations go, when to enter again, the capability. */
class NetaTabTest {
    private val host = "bsm.backspace.fm"
    private fun route(u: String) = NetaTabLogic.route(u, host)

    @Test fun reenterIsCaught() {
        assertEquals(NetaTabLogic.Route.REENTER, route("bguru-neta://reenter"))
        assertEquals(NetaTabLogic.Route.BLOCK, route("bguru-neta://other"))
    }

    @Test fun ourHostStaysOthersGoOutside() {
        assertEquals(NetaTabLogic.Route.INSIDE, route("https://bsm.backspace.fm/neta/app"))
        assertEquals(NetaTabLogic.Route.EXTERNAL, route("http://bsm.backspace.fm/neta/app")) // not https: not ours
        assertEquals(NetaTabLogic.Route.EXTERNAL, route("https://neta.backspace.fm/t/1"))
        assertEquals(NetaTabLogic.Route.EXTERNAL, route("https://bsm.backspace.fm.evil.example/"))
        assertEquals(NetaTabLogic.Route.EXTERNAL, route("mailto:a@b.example"))
        assertEquals(NetaTabLogic.Route.BLOCK, route("intent://x#Intent;end"))
        assertEquals(NetaTabLogic.Route.BLOCK, route("javascript:alert(1)"))
        assertEquals(NetaTabLogic.Route.BLOCK, route("file:///etc/hosts"))
    }

    @Test fun enterAgainOnlyAfterSixHoursAway() {
        val h = 60L * 60 * 1000
        assertFalse(NetaTabLogic.staleAfterBackground(0, 100 * h))
        assertFalse(NetaTabLogic.staleAfterBackground(10 * h, 15 * h))
        assertTrue(NetaTabLogic.staleAfterBackground(10 * h, 16 * h))
    }

    @Test fun tabPathFromCapabilities() {
        fun caps(neta: String) = ApiJson.decodeFromString<Capabilities>("""{"features":{"neta":$neta}}""")
        assertEquals("/neta/app/enter", caps("""{"enabled":true,"tab":"/neta/app/enter"}""").netaTab)
        assertNull(caps("""{"enabled":true}""").netaTab)
        assertNull(caps("""{"tab":"https://evil.example/x"}""").netaTab)
        assertNull(caps("""{"tab":"//evil.example/x"}""").netaTab)
        assertNull(caps("""{"tab":"/api/agent/me"}""").netaTab) // only a ネタ帳 path
        assertNull(caps("""{"tab":"/neta/../api/agent/me"}""").netaTab)
        assertNull(caps("""{"tab":"/neta/app\\enter"}""").netaTab)
    }

    // 📜 台本タブ（1 番右 — オーナー「アプリは1番右のタブに追加」2026-11-14）: its own entrance, the same checks as 📝.
    @Test fun scriptTabPathFromCapabilities() {
        fun caps(neta: String) = ApiJson.decodeFromString<Capabilities>("""{"features":{"neta":$neta}}""")
        val both = caps("""{"enabled":true,"tab":"/neta/app/enter","scriptTab":"/neta/app/enter?to=script"}""")
        assertEquals("/neta/app/enter?to=script", both.scriptTab)
        assertEquals("/neta/app/enter", both.netaTab)
        // A token without the script entrance (not a paid member): 📝 only.
        val netaOnly = caps("""{"enabled":true,"tab":"/neta/app/enter"}""")
        assertNull(netaOnly.scriptTab)
        assertEquals("/neta/app/enter", netaOnly.netaTab)
        assertNull(caps("""{"scriptTab":"https://evil.example/x"}""").scriptTab)
        assertNull(caps("""{"scriptTab":"//evil.example/x"}""").scriptTab)
        assertNull(caps("""{"scriptTab":"/neta/../api/agent/me"}""").scriptTab)
        assertNull(caps("""{"scriptTab":"/api/agent/me"}""").scriptTab)
        assertNull(ApiJson.decodeFromString<Capabilities>("""{}""").scriptTab)
    }

    @Test fun urlInfoPathFromCapabilities() {
        fun caps(neta: String) = ApiJson.decodeFromString<Capabilities>("""{"features":{"neta":$neta}}""")
        assertEquals("/api/agent/neta/urlinfo", caps("""{"enabled":true,"urlinfo":"/api/agent/neta/urlinfo"}""").netaUrlInfoPath)
        assertNull(caps("""{"enabled":true}""").netaUrlInfoPath)
        assertNull(caps("""{"urlinfo":"https://evil.example/x"}""").netaUrlInfoPath)
        assertNull(caps("""{"urlinfo":"/api/../x"}""").netaUrlInfoPath)
    }

    @Test fun urlInfoReplyDecodes() {
        val r = ApiJson.decodeFromString<NetaUrlInfo>(
            """{"apiVersion":"x","url":"https://t.co/a","finalUrl":"https://example.com/","title":"題名","description":"一言","note":"n"}"""
        )
        assertEquals("題名", r.title)
        assertEquals("一言", r.description)
        assertEquals("https://example.com/", r.finalUrl)
        assertEquals("n", r.note)
    }
}
