package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** 声の選び方 (docs/offkai-spec.md「声の選び方」): 日本語・端末内・入っている声を品質 → 遅れの順に、おもちゃの声は自動で選ばない。 */
class OffkaiVoicesTest {
    private fun v(name: String, quality: Int = 300, latency: Int = 300, language: String = "ja", network: Boolean = false, notInstalled: Boolean = false) =
        TtsVoice(name, language, quality, latency, network, notInstalled)

    @Test fun onlyJapaneseLocalInstalled() {
        val all = listOf(
            v("en-us-x-sfg-local", quality = 500, language = "en"),
            v("ja-jp-x-htm-network", quality = 500, network = true),
            v("ja-jp-x-jad-local", quality = 500, notInstalled = true),
            v("ja-jp-x-jab-local", quality = 400),
        )
        assertEquals(listOf("ja-jp-x-jab-local"), OffkaiVoices.choices(all).map { it.name })
        assertEquals("ja-jp-x-jab-local", OffkaiVoices.auto(all)?.name)
    }

    @Test fun qualityThenLatencyThenName() {
        val all = listOf(
            v("c", quality = 300, latency = 100),
            v("b", quality = 400, latency = 300),
            v("a", quality = 400, latency = 300),
            v("d", quality = 400, latency = 200),
            v("e", quality = 500, latency = 500),
        )
        assertEquals(listOf("e", "d", "a", "b", "c"), OffkaiVoices.choices(all).map { it.name })
        assertEquals("e", OffkaiVoices.auto(all)?.name)
    }

    @Test fun noveltySkippedByAutoButListed() {
        val all = listOf(v("Grandma (日本語)", quality = 500), v("Bad News", quality = 500), v("ja-jp-x-jac-local", quality = 300))
        assertEquals("ja-jp-x-jac-local", OffkaiVoices.auto(all)?.name)
        assertEquals(3, OffkaiVoices.choices(all).size)
        assertTrue(OffkaiVoices.isNovelty("Rocko"))
        assertFalse(OffkaiVoices.isNovelty("ja-jp-x-jab-local"))
        assertFalse(OffkaiVoices.isNovelty("Kyoko"))
        assertNull(OffkaiVoices.auto(listOf(v("Eddy"))))
    }

    @Test fun savedVoiceOrAuto() {
        val all = listOf(v("best", quality = 500), v("plain", quality = 300), v("Sandy", quality = 300))
        assertEquals("plain", OffkaiVoices.pick(all, "plain")?.name)
        assertEquals("Sandy", OffkaiVoices.pick(all, "Sandy")?.name) // 選べば おもちゃの声も使う
        assertEquals("best", OffkaiVoices.pick(all, "")?.name)
        assertEquals("best", OffkaiVoices.pick(all, null)?.name)
        assertEquals("best", OffkaiVoices.pick(all, "gone")?.name) // 消えたら自動
        assertEquals("best", OffkaiVoices.pick(all + v("net", network = true), "net")?.name) // 使えない声も自動
        assertTrue(OffkaiVoices.isAvailable(all, "plain"))
        assertFalse(OffkaiVoices.isAvailable(all, "gone"))
        assertFalse(OffkaiVoices.isAvailable(all, ""))
        assertNull(OffkaiVoices.pick(emptyList(), "x"))
    }

    @Test fun installHintAndMark() {
        assertTrue(OffkaiVoices.needsInstallHint(listOf(v("a", quality = 300), v("b", quality = 200))))
        assertTrue(OffkaiVoices.needsInstallHint(emptyList()))
        assertTrue(OffkaiVoices.needsInstallHint(listOf(v("net", quality = 500, network = true))))
        assertFalse(OffkaiVoices.needsInstallHint(listOf(v("a", quality = 300), v("b", quality = 400))))
        assertEquals("★", OffkaiVoices.mark(v("a", quality = 500)))
        assertEquals("★", OffkaiVoices.mark(v("a", quality = 400)))
        assertEquals("", OffkaiVoices.mark(v("a", quality = 300)))
    }
}
