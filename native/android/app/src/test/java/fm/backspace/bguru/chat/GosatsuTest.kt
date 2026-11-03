package fm.backspace.bguru.chat

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import java.io.File
import javax.imageio.ImageIO
import kotlin.math.abs

class GosatsuTest {
    // MARK: ffmpeg との照合（写真は repo に入れない。なければ飛ばす）

    /** `<name>.png` と ffmpeg の正解（粒子なし）`<name>_ref.png` のあるフォルダ。環境変数 GOSATSU_DIR で変えられる。 */
    private val dir = File(System.getenv("GOSATSU_DIR") ?: "/private/tmp/claude-501/-Users-koh-Dev-b-guru/70d91b90-9e65-4ded-8ddc-a85f4f2bbb18/scratchpad/port/png")

    private fun load(f: File): Triple<IntArray, Int, Int> {
        val img = ImageIO.read(f)
        // getRGB は TYPE_3BYTE_BGR / INT_RGB では値をそのまま返す（色空間を変えない）
        return Triple(img.getRGB(0, 0, img.width, img.height, null, 0, img.width), img.width, img.height)
    }

    @Test fun matchesFfmpegOnPhotos() {
        val names = listOf("q31", "ip1", "zc7", "ip0").filter { File(dir, "$it.png").exists() && File(dir, "${it}_ref.png").exists() }
        assumeTrue("照合用の写真がない（$dir）", names.isNotEmpty())
        for (name in names) {
            val (src, w, h) = load(File(dir, "$name.png"))
            val (ref, rw, rh) = load(File(dir, "${name}_ref.png"))
            assertEquals(w to h, rw to rh)
            val t = System.nanoTime()
            val img = Gosatsu.Planes.fromArgb(src, w, h)
            val plan = Gosatsu.plan(Gosatsu.stats(img))
            val out = Gosatsu.render(img, plan, seed = 7, grain = false).argb()
            val ms = (System.nanoTime() - t) / 1_000_000
            val diffs = IntArray(256)
            var sum = 0L
            for (i in out.indices) for (s in intArrayOf(16, 8, 0)) {
                val d = abs(((out[i] shr s) and 0xFF) - ((ref[i] shr s) and 0xFF))
                diffs[d]++
                sum += d
            }
            val total = out.size * 3L
            val mean = sum.toDouble() / total
            var acc = 0L
            var p99 = 0
            while (acc + diffs[p99] < total * 0.99) { acc += diffs[p99]; p99++ }
            val maxD = diffs.indices.last { diffs[it] > 0 }
            println("gosatsu $name ${w}x$h: mean %.2f p99 $p99 max $maxD (${ms} ms) $plan".format(mean))
            System.getenv("GOSATSU_OUT")?.let { o ->
                val bi = java.awt.image.BufferedImage(w, h, java.awt.image.BufferedImage.TYPE_INT_RGB)
                bi.setRGB(0, 0, w, h, out, 0, w)
                ImageIO.write(bi, "png", File(o, "${name}_kt.png"))
            }
            assertTrue("$name mean $mean", mean <= 1.0)
            assertTrue("$name p99 $p99", p99 <= 5)
        }
    }

    // MARK: 写真なしで

    private fun gray(w: Int, h: Int, f: (Int, Int) -> Int) = IntArray(w * h) {
        val v = f(it % w, it / w)
        (0xFF shl 24) or (v shl 16) or (v shl 8) or v
    }

    @Test fun monoStaysMonoAndSizeIsKept() {
        val w = 322
        val h = 242 // 4 の倍数でない（粒子は半分の大きさで作る）
        val src = gray(w, h) { x, y -> (x * 255 / w + y) % 256 }
        val out = Gosatsu.apply(src, w, h, seed = 5)
        assertEquals(w * h, out.size)
        for (c in out) {
            val r = (c shr 16) and 0xFF
            val g = (c shr 8) and 0xFF
            val b = c and 0xFF
            assertTrue("色がついた $r $g $b", abs(r - g) <= 1 && abs(g - b) <= 1)
        }
    }

    @Test fun colourPhotoKeepsSize() {
        val w = 97
        val h = 61
        val src = IntArray(w * h) { (0xFF shl 24) or ((it * 7 % 256) shl 16) or ((it * 3 % 256) shl 8) or (it % 256) }
        assertEquals(w * h, Gosatsu.apply(src, w, h, seed = 1).size)
    }

    /** 携帯の強いシャープは強い輪郭に沿って細い明暗の線を描く。五撮は描かない（promptcam の
     *  test_no_outline_on_a_hard_edge と同じ測り方: 輪郭から 2 px と 10 px の段差）。 */
    @Test fun noOutlineOnAHardEdge() {
        val w = 640
        val h = 480
        val src = gray(w, h) { x, _ -> if (x < w / 2) 60 else 190 }
        val plan = Gosatsu.plan(Gosatsu.Stats(yLow = 60.0, yHigh = 190.0, yAvg = 125.0, satAvg = 0.0, fine = 0.2, mid = 1.0)).copy(dark = false)
        val gosatsu = Gosatsu.render(Gosatsu.Planes.fromArgb(src, w, h), plan, seed = 1, grain = false).argb()
        val phone = unsharp(src, w, h)
        fun outline(img: IntArray): Double {
            fun y(x0: Int): Double {
                var s = 0.0
                for (y in 190 until 290) for (x in x0 until x0 + 2) s += ((img[y * w + x] shr 8) and 0xFF)
                return s / 200
            }
            return maxOf(abs(y(318) - y(310)), abs(y(322) - y(330)))
        }
        assertTrue("phone ${outline(phone)}", outline(phone) > 20) // 測りが線を見つけられること
        assertTrue("gosatsu ${outline(gosatsu)}", outline(gosatsu) < 8)
    }

    /** ffmpeg の unsharp=5:5:1.5 に近いもの（5×5 の平均との差を 1.5 倍）。 */
    private fun unsharp(src: IntArray, w: Int, h: Int): IntArray = IntArray(w * h) { i ->
        val x = i % w
        val y = i / w
        var s = 0
        for (dy in -2..2) for (dx in -2..2) {
            val xx = (x + dx).coerceIn(0, w - 1)
            val yy = (y + dy).coerceIn(0, h - 1)
            s += src[yy * w + xx] and 0xFF
        }
        val a = src[i] and 0xFF
        val v = (a + 1.5 * (a - s / 25.0)).toInt().coerceIn(0, 255)
        (0xFF shl 24) or (v shl 16) or (v shl 8) or v
    }

    /** ffmpeg curves=all='…' を 256×1 の灰色の階段にかけた値（ffmpeg 9.0 で書き出したもの）。 */
    @Test fun curveLUTMatchesFfmpeg() {
        fun hex(s: String) = ByteArray(s.length / 2) { s.substring(it * 2, it * 2 + 2).toInt(16).toByte() }
        val look = listOf(0.0 to 0.0, 0.06 to 0.045, 0.25 to 0.225, 0.5 to 0.5, 0.75 to 0.785, 0.92 to 0.925, 1.0 to 0.975)
        assertArrayEquals(hex(LOOK), Gosatsu.curveLUT(look))
        assertArrayEquals(hex(HIGHLIGHT), Gosatsu.curveLUT(listOf(0.0 to 0.0, 0.85 to 0.0, 1.0 to 1.0)))
        assertArrayEquals(hex(BASE), Gosatsu.curveLUT(listOf(0.0 to 0.0, 0.1255 to 0.098, 0.7843 to 0.85, 1.0 to 1.0)))
    }

    @Test fun grainIsRepeatableWithTheSameSeed() {
        assertArrayEquals(Gosatsu.grainPlane(50, 30, 9), Gosatsu.grainPlane(50, 30, 9))
    }

    private companion object {
        const val LOOK = "00000102020304050506070808090a0b0c0d0d0e0f10111212131415161718191a1b1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334353637393a3b3c3d3e3f4041424344454748494a4b4c4d4e4f5051525354565758595a5b5c5d5e5f6162636465666768696b6c6d6e6f7071737475767778797b7c7d7e7f80818384858687888a8b8c8d8e9091929394969798999a9b9d9e9fa0a1a3a4a5a6a7a8aaabacadaeafb0b2b3b4b5b6b7b8b9babcbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcdcecfd0d1d2d3d4d5d6d6d7d8d9dadbdcdcdddedfe0e0e1e2e3e3e4e5e6e6e7e8e8e9eaeaebecededeeefeff0f1f1f2f2f3f4f4f5f5f6f7f7f8f8"
        const val HIGHLIGHT = "00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000050b11171d23292f353c42494f565c636970777e858c9299a0a7aeb5bcc4cbd2d9e0e7eef6fdff"
        const val BASE = "00000102020304050506070808090a0b0b0c0d0e0f0f1011121313141516171818191a1b1c1d1e1f202122232425262728292a2b2c2d2e2f3031323334363738393a3b3c3d3f4041424344464748494a4c4d4e4f50525354555758595a5c5d5e5f61626364666768696b6c6d6e70717274757677797a7b7c7e7f80828384858788898a8c8d8e8f91929394969798999b9c9d9ea0a1a2a3a4a6a7a8a9aaabadaeafb0b1b2b4b5b6b7b8b9babbbdbebfc0c1c2c3c4c5c6c7c8c9cacbcccdcecfd0d1d2d3d4d5d6d6d8d9dadbdcdcdddedfe0e1e1e2e3e4e4e5e6e7e7e8e9e9eaebebecedeeeeeff0f0f1f1f2f3f3f4f5f5f6f7f7f8f8f9fafafbfbfcfdfdfefeff"
    }
}
