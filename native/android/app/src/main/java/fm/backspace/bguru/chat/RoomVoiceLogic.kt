package fm.backspace.bguru.chat

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlin.math.exp
import kotlin.math.ln
import kotlin.math.roundToInt
import kotlin.math.sin

/** 部室・ボイスの小さな決まりごと（純粋な関数なのでユニットテストする）。Web の src/lib/room-logic.ts・voice-client.ts と同じ。 */
internal object RoomVoiceLogic {
    /** 頭の上の名前の幅（全角 6 字ぶん。半角 ASCII は 1、それ以外は 2）。 */
    const val ROOM_NAME_WIDTH = 12

    /** JS の \s と同じ空白（Java の \s は全角の空白などを含まない）。 */
    private val SPACES = Regex("[\\s\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff]+")

    /** 書記素（見た目の 1 文字）に分ける。家族の絵文字（ZWJ）や国旗を途中で切らない。 */
    fun graphemes(s: String): List<String> {
        val it = java.text.BreakIterator.getCharacterInstance()
        it.setText(s)
        val out = ArrayList<String>()
        var start = it.first()
        var end = it.next()
        while (end != java.text.BreakIterator.DONE) {
            out.add(s.substring(start, end))
            start = end
            end = it.next()
        }
        return out
    }

    /** 頭の上の名前（shortRoomName と同じ）: 空白・改行は 1 つの空白にまとめ、幅 12 を超えたら幅 11 までで切って「…」。
     *  書記素ごとに数える（半角 ASCII 1 字は幅 1、それ以外は幅 2）。 */
    fun shortRoomName(name: String, width: Int = ROOM_NAME_WIDTH): String {
        val t = name.replace(SPACES, " ").trim()
        val gs = graphemes(t)
        fun w(g: String) = if (g.length == 1 && g[0].code in 0x20..0x7e) 1 else 2
        if (gs.sumOf { w(it) } <= width) return t
        val out = StringBuilder()
        var used = 0
        for (g in gs) {
            if (used + w(g) > width - 1) break
            out.append(g)
            used += w(g)
        }
        return out.toString().trimEnd() + "…"
    }

    // ---- 相手ごとの音量（自分だけ、0…1、無ければ 1）----

    /** 端末に覚えた JSON（user id → 数）を読む。0…1 の数だけ使う。 */
    fun parseGains(json: String?): Map<String, Float> {
        if (json.isNullOrBlank()) return emptyMap()
        val o = runCatching { ApiJson.parseToJsonElement(json).jsonObject }.getOrNull() ?: return emptyMap()
        val out = HashMap<String, Float>()
        for ((k, v) in o) {
            val d = runCatching { v.jsonPrimitive.doubleOrNull }.getOrNull() ?: continue
            if (d in 0.0..1.0) out[k] = d.toFloat()
        }
        return out
    }

    fun encodeGains(gains: Map<String, Float>): String =
        JsonObject(gains.mapValues { JsonPrimitive(it.value) }).toString()

    /** その人の音量を変えたあとの一覧。0…1 に収め 0.01 刻みに丸める。1 は覚えない（いつもの大きさ）。 */
    fun withGain(gains: Map<String, Float>, id: String, gain: Float): Map<String, Float> {
        val g = ((gain.coerceIn(0f, 1f) * 100).roundToInt() / 100f)
        return if (g >= 1f) gains - id else gains + (id to g)
    }

    /** 部室の音量 = 距離の音量 × 自分で決めた音量。部室でないボイスルームは自分で決めた音量だけ（near = null）。 */
    fun playVolume(near: Double?, gain: Float): Double = ((near ?: 1.0).coerceIn(0.0, 1.0) * gain.coerceIn(0f, 1f))

    // ---- 出入りの効果音（その場で作る短いサイン波。音の素材は使わない）----

    /** ほかの人の出入りは 1.2 秒に 1 回まで。 */
    const val SFX_GAP_MS = 1200L

    /** Web の playVoiceSfx と同じ: in は 660→990Hz（上がる）、out は 740→494Hz（下がる）。各 0.16 秒、2 音目は 0.09 秒あと。
     *  自分の出入りは少し大きく（0.12、ほかの人は 0.06）。16bit モノラルの PCM。 */
    fun sfxPcm(goingIn: Boolean, mine: Boolean, rate: Int = 24_000): ShortArray {
        val notes = if (goingIn) doubleArrayOf(660.0, 990.0) else doubleArrayOf(740.0, 494.0)
        val peak = if (mine) 0.12 else 0.06
        val total = ((0.09 + 0.18) * rate).toInt()
        val buf = DoubleArray(total)
        val attack = 0.01
        val decayEnd = 0.16
        // 0.01 秒で peak まで上げ、0.16 秒で 0.0001 まで指数で下げる（Web の linearRamp → exponentialRamp）
        val k = ln(peak / 0.0001) / (decayEnd - attack)
        notes.forEachIndexed { i, f ->
            val start = (i * 0.09 * rate).toInt()
            val len = (0.18 * rate).toInt()
            for (n in 0 until len) {
                val t = n.toDouble() / rate
                val env = when {
                    t < attack -> peak * t / attack
                    t < decayEnd -> peak * exp(-k * (t - attack))
                    else -> 0.0
                }
                val j = start + n
                if (j < total) buf[j] += env * sin(2 * Math.PI * f * t)
            }
        }
        return ShortArray(total) { (buf[it].coerceIn(-1.0, 1.0) * 32767).roundToInt().toShort() }
    }
}
