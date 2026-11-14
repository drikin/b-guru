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
    }
}
