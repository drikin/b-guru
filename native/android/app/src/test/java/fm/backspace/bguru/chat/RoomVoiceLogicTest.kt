package fm.backspace.bguru.chat

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/** 部室・ボイスの小さな決まりごと（Web の src/lib/__tests__/room-logic.test.ts「頭の上の名前」と同じ例）。 */
class RoomVoiceLogicTest {
    private fun short(s: String) = RoomVoiceLogic.shortRoomName(s)

    @Test fun 短い名前はそのまま長い名前は幅12で切る() {
        assertEquals("Ken", short("Ken"))
        assertEquals("ドリキン", short("ドリキン"))
        assertEquals("yatakaharu…", short("yatakaharu（グルペット）"))
        assertEquals("KOJI SHIGEM…", short("KOJI SHIGEMURA（しげ）"))
        assertEquals("散財王ドリ…", short("散財王ドリキン様"))
        assertEquals("a b", short("  a\n b "))
    }

    @Test fun 空白は全角もまとめる() {
        assertEquals("あ い", short("あ　　い"))
        assertEquals("abcdefghijkl", short("abcdefghijkl")) // ちょうど幅 12
        assertEquals("abcdefghijk…", short("abcdefghijklm"))
    }

    @Test fun 絵文字を途中で切らない() {
        val family = "👨‍👩‍👧‍👦"
        val flag = "🇯🇵"
        // 幅 2 × 6 = 12 はそのまま
        assertEquals(family.repeat(6), short(family.repeat(6)))
        // 超えたら幅 11 まで = 5 つ + …（ZWJ の途中・国旗の半分で切らない）
        assertEquals(family.repeat(5) + "…", short(family.repeat(7)))
        assertEquals(flag.repeat(5) + "…", short(flag.repeat(7)))
        assertEquals("abcdefghi$flag…", short("abcdefghi$flag$flag")) // 9 + 2 = 11 までは入る
        assertEquals("abcdefghij…", short("abcdefghij$family$family")) // 10 + 2 > 11 なので丸ごと入れない
    }

    @Test fun 音量は1を覚えない() {
        var g = RoomVoiceLogic.withGain(emptyMap(), "a", 0.5f)
        assertEquals(0.5f, g["a"]!!, 0f)
        g = RoomVoiceLogic.withGain(g, "b", 0f)
        assertEquals(0f, g["b"]!!, 0f)
        g = RoomVoiceLogic.withGain(g, "a", 1f)
        assertTrue("a" !in g)
        g = RoomVoiceLogic.withGain(g, "c", 1.7f)
        assertTrue("c" !in g)
        assertEquals(0.3f, RoomVoiceLogic.withGain(emptyMap(), "d", 0.30001f)["d"]!!, 0f)
    }

    @Test fun 音量を端末に覚えて読み戻す() {
        val g = mapOf("a" to 0.4f, "b" to 0f)
        assertEquals(g, RoomVoiceLogic.parseGains(RoomVoiceLogic.encodeGains(g)))
        assertEquals(emptyMap<String, Float>(), RoomVoiceLogic.parseGains(null))
        assertEquals(emptyMap<String, Float>(), RoomVoiceLogic.parseGains("こわれた"))
        assertEquals(mapOf("ok" to 0.2f), RoomVoiceLogic.parseGains("""{"ok":0.2,"big":3,"neg":-1,"s":"x"}"""))
    }

    @Test fun 部室の音量は距離かける自分の音量() {
        assertEquals(0.25, RoomVoiceLogic.playVolume(0.5, 0.5f), 1e-9)
        assertEquals(0.0, RoomVoiceLogic.playVolume(0.0, 1f), 1e-9)
        assertEquals(0.7, RoomVoiceLogic.playVolume(null, 0.7f), 1e-6) // 部室でないボイスルーム
    }

    @Test fun 効果音は短く自分のほうが大きい() {
        val rate = 24_000
        val mine = RoomVoiceLogic.sfxPcm(goingIn = true, mine = true, rate = rate)
        val other = RoomVoiceLogic.sfxPcm(goingIn = false, mine = false, rate = rate)
        assertEquals((0.27 * rate).toInt(), mine.size)
        val peakMine = mine.maxOf { abs(it.toInt()) } / 32767.0
        val peakOther = other.maxOf { abs(it.toInt()) } / 32767.0
        assertTrue(peakMine in 0.10..0.2)
        assertTrue(peakOther in 0.04..0.1)
        assertEquals(0, mine.first().toInt())
        assertTrue(abs(mine.last().toInt()) < 50) // 最後は静か（プツッと鳴らない）
    }
}
