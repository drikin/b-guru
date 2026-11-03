package fm.backspace.bguru.chat

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/** 五撮 Vol.1（ドリキンフィルター第 1 弾）を端末の中でかける（drikin 2026-11-03: チャットのカメラで撮った写真に、
 *  かけるかどうかを選んで）。正本は西田カメラの dk5090 側（~/Dev/promptcam/server/promptcam_gateway.py の
 *  `gosatsu_stats` / `gosatsu_plan` / `gosatsu_filter`、ffmpeg のフィルタ）で、ここは native/shared/Gosatsu.swift を
 *  1 行ずつ写したもの（丸め・切り捨ての場所まで同じ）。Android のクラスは使わない（JVM の単体テストで ffmpeg と照合）。
 *
 *  1. 写真ごとの土台合わせ（`plan`）: 黒白・彩度・最細部を測って、どのカメラでも同じ土台へ。
 *  2. 共通の味つけ（`render`）: 色、3 段の解像感（ノイズは上げず強い輪郭は頭打ち＝縁取りなし）、
 *     ハレーション、半分の大きさの粒子、軽い周辺減光。モノクロはモノクロのまま。
 *
 *  画素は写真そのものの色空間の値のまま（Display P3 なら P3 のまま。sRGB に直すと彩度の測りがずれる）。
 *  長辺 2048 px までを想定（送るときの大きさ）。 */
object Gosatsu {
    data class Plan(
        val lo: Double, val loOut: Double, val hi: Double, val hiOut: Double,
        val sat: Double,
        val mono: Boolean,
        val dark: Boolean,
        val bright: Boolean,
        val fine: Double,
        val texture: Double,
        val local: Double,
    )

    data class Stats(val yLow: Double, val yHigh: Double, val yAvg: Double, val satAvg: Double, val fine: Double, val mid: Double)

    /** 五撮をかけた ARGB（0xAARRGGBB、アルファは 255 で返す）。`seed` は粒子の乱数（同じ seed なら同じ粒子）。 */
    fun apply(argb: IntArray, width: Int, height: Int, seed: Long = kotlin.random.Random.nextLong()): IntArray {
        val img = Planes.fromArgb(argb, width, height)
        return render(img, plan(stats(img)), seed).argb()
    }

    /** 同じ、RGBA の byte 並び（Android の Bitmap.copyPixelsToBuffer の ARGB_8888 = R, G, B, A の順）。 */
    fun applyRgba(rgba: ByteArray, width: Int, height: Int, seed: Long = kotlin.random.Random.nextLong()): ByteArray {
        val img = Planes.fromRgba(rgba, width, height)
        return render(img, plan(stats(img)), seed).rgba()
    }

    // MARK: 1. 測る・土台を決める

    /** ffmpeg signalstats（yuvj444p = フルレンジ）と同じ量: YLOW / YHIGH は 10 / 90 パーセンタイル、SATAVG は
     *  色差の長さの平均。FINE / MID は灰色の画像と sigma 0.8 / 3 でぼかしたものとの差の平均。 */
    fun stats(img: Planes): Stats {
        val n = img.count
        val hist = IntArray(256)
        var ySum = 0.0
        var satSum = 0.0
        val gray = ByteArray(n)
        for (i in 0 until n) {
            val r = u8(img.r[i]).toDouble(); val g = u8(img.g[i]).toDouble(); val b = u8(img.b[i]).toDouble()
            val y = min(max(round(0.299 * r + 0.587 * g + 0.114 * b), 0.0), 255.0)
            val u = round(-0.168736 * r - 0.331264 * g + 0.5 * b)
            val v = round(0.5 * r - 0.418688 * g - 0.081312 * b)
            hist[y.toInt()]++
            ySum += y
            satSum += floor(sqrt(u * u + v * v)) // signalstats は 8 bit に切り捨てて数える
            gray[i] = y.toInt().toByte()
        }
        fun percentile(p: Int): Double {
            val target = round(n.toDouble() * p.toDouble() / 100).toInt()
            var acc = 0
            for (j in 0 until 256) {
                acc += hist[j]
                if (acc >= target) return j.toDouble()
            }
            return 255.0
        }
        fun detail(sigma: Float): Double {
            val blurred = gblur8(gray, img.width, img.height, sigma)
            var s = 0L
            for (i in 0 until n) s += abs(u8(gray[i]) - u8(blurred[i]))
            return s.toDouble() / max(n, 1).toDouble()
        }
        return Stats(percentile(10), percentile(90), ySum / max(n, 1), satSum / max(n, 1), detail(0.8f), detail(3f))
    }

    /** `gosatsu_plan` と同じ（数値もそのまま）。 */
    fun plan(st: Stats): Plan {
        val lo = st.yLow
        val hi = st.yHigh
        var loOut = if (lo > 20) lo - min(0.7 * (lo - 20), 12.0) else lo
        var hiOut = if (hi < 205) hi + 0.5 * (205 - hi) else hi
        if (hi > lo && (hiOut - loOut) / (hi - lo) > 1.4) {
            val mid = (loOut + hiOut) / 2
            val half = (hi - lo) * 1.4 / 2
            loOut = mid - half
            hiOut = mid + half
        }
        val mono = st.satAvg < 1.5
        var sat = if (mono) 1.0 else min(max(sqrt(13 / max(st.satAvg, 1.0)), 0.85), 1.12)
        if (st.satAvg > 25) sat = min(sat, 0.92)
        val lack = min(max((0.30 - st.fine / max(st.mid, 0.01)) / 0.15, 0.0), 1.0)
        val spread = hiOut - loOut
        fun r(v: Double, p: Double) = round(v * p) / p
        return Plan(
            lo = r(lo, 10.0), loOut = r(max(loOut, 0.0), 10.0), hi = r(hi, 10.0), hiOut = r(min(hiOut, 250.0), 10.0),
            sat = r(sat, 1000.0), mono = mono, dark = st.yAvg < 95, bright = hi > 245,
            fine = r(0.6 * lack, 1000.0), texture = 0.5,
            local = r(0.22 + 0.12 * min(max((150 - spread) / 80, 0.0), 1.0), 1000.0),
        )
    }

    // MARK: 2. 味つけ（`gosatsu_filter` の ffmpeg の流れの順に）

    /** `grain = false` は照合用（粒子は乱数なので ffmpeg と画素では比べられない）。 */
    fun render(src: Planes, p: Plan, seed: Long, grain: Boolean = true): Planes {
        val n = src.count
        val w = src.width
        val h = src.height

        // [base] curves（土台の黒白）→ curves（共通のトーン）
        val points = mutableListOf(0.0 to 0.0)
        for ((x, y) in listOf(p.lo / 255 to p.loOut / 255, p.hi / 255 to p.hiOut / 255, 1.0 to 1.0)) {
            if (x - points.last().first >= 0.01) points.add(x to y)
        }
        if (points.last().first < 1) points[points.size - 1] = 1.0 to 1.0
        val basePts = points.map { (round(it.first * 10000) / 10000) to (round(it.second * 10000) / 10000) }
        val toe = if (p.dark) listOf(0.06 to 0.055, 0.25 to 0.24, 0.5 to 0.51) else listOf(0.06 to 0.045, 0.25 to 0.225, 0.5 to 0.5)
        val look = listOf(0.0 to 0.0) + toe + listOf(0.75 to 0.785, if (p.bright) 0.92 to 0.92 else 0.92 to 0.925, 1.0 to 0.975)
        val base = curveLUT(basePts)
        val lookLUT = curveLUT(look)
        val tone = ByteArray(256) { lookLUT[u8(base[it])] }
        val img = Planes(w, h)
        for (i in 0 until n) {
            img.r[i] = tone[u8(src.r[i])]
            img.g[i] = tone[u8(src.g[i])]
            img.b[i] = tone[u8(src.b[i])]
        }

        if (!p.mono) {
            colorBalance(img)
            hueSaturation(img, -0.15f, GREEN)
            hueSaturation(img, 0.06f, RED or YELLOW)
        }

        // hue=s（yuv444p、テレビの範囲）→ 3 段の解像感（輝度だけ）→ gbrp
        val yuv = YUV.of(img)
        val c = round(65536 * p.sat * 0.96).toInt()
        for (i in 0 until n) {
            yuv.u[i] = clampByte((c * (u8(yuv.u[i]) - 128) + (1 shl 15) + (128 shl 16)) shr 16)
            yuv.v[i] = clampByte((c * (u8(yuv.v[i]) - 128) + (1 shl 15) + (128 shl 16)) shr 16)
        }
        val stages = listOf(Stage(1.0f, p.fine, 1.0, 5.0), Stage(3.5f, p.texture, 0.6, 9.0), Stage(28f, p.local, 0.0, 14.0))
        for ((sigma, k, core, cap) in stages) {
            if (k == 0.0) continue
            val b = gblur8(yuv.y, w, h, sigma)
            for (i in 0 until n) {
                val a = u8(yuv.y[i]).toDouble()
                val d = a - u8(b[i]).toDouble()
                val sign = if (d > 0) 1.0 else if (d < 0) -1.0 else 0.0
                val lift = k * sign * min(max(abs(d) - core, 0.0), cap)
                yuv.y[i] = min(max(a + lift, 0.0), 255.0).toInt().toByte()
            }
        }
        val g1 = yuv.rgb()

        // [hl] いちばん明るい光だけ → ぼかす → 赤み（モノクロは中立のまま）→ screen 0.18
        val hlLUT = curveLUT(listOf(0.0 to 0.0, 0.85 to 0.0, 1.0 to 1.0))
        val halo = Planes(w, h)
        for (i in 0 until n) {
            halo.r[i] = hlLUT[u8(src.r[i])]
            halo.g[i] = hlLUT[u8(src.g[i])]
            halo.b[i] = hlLUT[u8(src.b[i])]
        }
        val hr = gblur8(halo.r, w, h, 10f)
        val hg = gblur8(halo.g, w, h, 10f)
        val hb = gblur8(halo.b, w, h, 10f)
        if (!p.mono) {
            for (i in 0 until n) {
                hg[i] = min(u8(hg[i]) * 0.35 + 0.5, 255.0).toInt().toByte() // colorchannelmixer gg=0.35
                hb[i] = min(u8(hb[i]) * 0.1 + 0.5, 255.0).toInt().toByte()  // bb=0.1
            }
        }
        for (i in 0 until n) {
            g1.r[i] = blendScreen(u8(g1.r[i]), u8(hr[i]), 0.18)
            g1.g[i] = blendScreen(u8(g1.g[i]), u8(hg[i]), 0.18)
            g1.b[i] = blendScreen(u8(g1.b[i]), u8(hb[i]), 0.18)
        }

        // 粒子: 半分の大きさで作り（携帯の画面で縮めても残る）、overlay で中間調にいちばん多く。
        if (grain) {
            val gr = grainPlane(w, h, seed)
            val opacity = if (p.dark) 0.5 else 0.68
            for (i in 0 until n) {
                val q = u8(gr[i])
                g1.r[i] = blendOverlay(u8(g1.r[i]), q, opacity)
                g1.g[i] = blendOverlay(u8(g1.g[i]), q, opacity)
                g1.b[i] = blendOverlay(u8(g1.b[i]), q, opacity)
            }
        }

        // vignette=angle=PI/14（yuv444p: 輝度は掛け算、色差は 127 を中心に）
        val out = YUV.of(g1)
        val x0 = (w / 2).toDouble()
        val y0 = (h / 2).toDouble()
        val dmax = sqrt(w.toDouble() / 2 * w.toDouble() / 2 + h.toDouble() / 2 * h.toDouble() / 2)
        val angle = Math.PI / 14
        val colFactor = DoubleArray(w)
        for (y in 0 until h) {
            val yy = (y.toDouble() - y0).toInt().toDouble()
            for (x in 0 until w) {
                val xx = (x.toDouble() - x0).toInt().toDouble()
                val dn = sqrt(xx * xx + yy * yy) / dmax
                val cs = cos(angle * dn)
                colFactor[x] = if (dn > 1) 0.0 else cs * cs * cs * cs
            }
            val row = y * w
            for (x in 0 until w) {
                val f = colFactor[x]
                val i = row + x
                out.y[i] = min(max(f * u8(out.y[i]) + 0.5, 0.0), 255.0).toInt().toByte()
                out.u[i] = min(max(f * (u8(out.u[i]) - 127.0) + 127 + 0.5, 0.0), 255.0).toInt().toByte()
                out.v[i] = min(max(f * (u8(out.v[i]) - 127.0) + 127 + 0.5, 0.0), 255.0).toInt().toByte()
            }
        }
        return out.rgb()
    }

    private data class Stage(val sigma: Float, val k: Double, val core: Double, val cap: Double)

    // MARK: ffmpeg のフィルタを同じ計算で

    /** curves（自然 3 次スプライン、8 bit の表）。vf_curves.c の interpolate と同じ（端の切り捨てまで）。 */
    fun curveLUT(pts: List<Pair<Double, Double>>): ByteArray {
        val scale = 255.0
        fun clip(v: Double): Byte = min(max(v.toInt(), 0), 255).toByte() // av_clip_uint8((int)v)
        val n = pts.size
        val lut = ByteArray(256)
        if (n == 1) return ByteArray(256) { clip(pts[0].second * scale) }
        val h = DoubleArray(n - 1) { pts[it + 1].first - pts[it].first }
        val r = DoubleArray(n)
        for (i in 1 until n - 1) {
            r[i] = 6 * ((pts[i + 1].second - pts[i].second) / h[i] - (pts[i].second - pts[i - 1].second) / h[i - 1])
        }
        val bd = DoubleArray(n)
        val md = DoubleArray(n)
        val ad = DoubleArray(n)
        md[0] = 1.0
        md[n - 1] = 1.0
        for (i in 1 until n - 1) {
            bd[i] = h[i - 1]
            md[i] = 2 * (h[i - 1] + h[i])
            ad[i] = h[i]
        }
        for (i in 1 until n) {
            val den = md[i] - bd[i] * ad[i - 1]
            val k = if (den != 0.0) 1 / den else 1.0
            ad[i] *= k
            r[i] = (r[i] - bd[i] * r[i - 1]) * k
        }
        for (i in n - 2 downTo 0) r[i] -= ad[i] * r[i + 1]
        for (i in 0 until (pts[0].first * scale).toInt()) lut[i] = clip(pts[0].second * scale)
        for (i in 0 until n - 1) {
            val yc = pts[i].second
            val yn = pts[i + 1].second
            val a = yc
            val b = (yn - yc) / h[i] - h[i] * r[i] / 2 - h[i] * (r[i + 1] - r[i]) / 6
            val c = r[i] / 2
            val d = (r[i + 1] - r[i]) / (6 * h[i])
            val xs = (pts[i].first * scale).toInt()
            val xe = (pts[i + 1].first * scale).toInt()
            if (xs > xe) continue
            for (x in xs..xe) {
                val xx = (x - xs).toDouble() / scale
                lut[x] = clip((a + b * xx + c * xx * xx + d * xx * xx * xx) * scale)
            }
        }
        for (i in (pts[n - 1].first * scale).toInt() until 256) lut[i] = clip(pts[n - 1].second * scale)
        return lut
    }

    /** colorbalance=rs=-0.02:bs=0.025:rm=0.012:bm=-0.006:rh=0.025:gh=0.008:bh=-0.012（vf_colorbalance.c と同じ）。 */
    fun colorBalance(img: Planes) {
        fun comp(v: Float, l: Float, s: Float, m: Float, hi: Float): Float {
            val a = 4f
            val b = 0.333f
            val scale = 0.7f
            val s2 = s * min(max((b - l) * a + 0.5f, 0f), 1f) * scale
            val m2 = m * min(max((l - b) * a + 0.5f, 0f), 1f) * min(max((1 - l - b) * a + 0.5f, 0f), 1f) * scale
            val h2 = hi * min(max((l + b - 1) * a + 0.5f, 0f), 1f) * scale
            return min(max(v + s2 + m2 + h2, 0f), 1f)
        }
        for (i in 0 until img.count) {
            val r = u8(img.r[i]).toFloat() / 255
            val g = u8(img.g[i]).toFloat() / 255
            val b = u8(img.b[i]).toFloat() / 255
            val l = max(max(r, g), b) + min(min(r, g), b)
            img.r[i] = round(comp(r, l, -0.02f, 0.012f, 0.025f) * 255).toInt().toByte()
            img.g[i] = round(comp(g, l, 0f, 0f, 0.008f) * 255).toInt().toByte()
            img.b[i] = round(comp(b, l, 0.025f, -0.006f, -0.012f) * 255).toInt().toByte()
        }
    }

    const val RED = 1 shl 0
    const val YELLOW = 1 shl 1
    const val GREEN = 1 shl 2

    /** huesaturation=saturation=…:colors=…:strength=1（vf_huesaturation.c の 8 bit の整数計算と同じ）。 */
    fun hueSaturation(img: Planes, saturation: Float, colors: Int) {
        val s = 1 + saturation
        val t = 1 - s
        val wr = 0.333f
        val wg = 0.334f
        val wb = 0.333f
        // m[row][col]: r' = r*m[0][0] + g*m[1][0] + b*m[2][0]（get_triplet の並び）
        val m = arrayOf(
            floatArrayOf(t * wr + s, t * wr, t * wr),
            floatArrayOf(t * wg, t * wg + s, t * wg),
            floatArrayOf(t * wb, t * wb, t * wb + s),
        ).map { row -> LongArray(3) { round(row[it] * 65536).toLong() } }
        for (i in 0 until img.count) {
            val ir = u8(img.r[i])
            val ig = u8(img.g[i])
            val ib = u8(img.b[i])
            val mn = min(min(ir, ig), ib)
            val mx = max(max(ir, ig), ib)
            var hit = false
            var f = 0
            if (colors and RED != 0) {
                hit = hit || ir == mx
                f = max(f, ir - max(ig, ib))
            }
            if (colors and YELLOW != 0) {
                hit = hit || ib == mn
                f = max(f, min(ir, ig) - ib)
            }
            if (colors and GREEN != 0) {
                hit = hit || ig == mx
                f = max(f, ig - max(ir, ib))
            }
            if (!hit) continue
            f = min(f, 255)
            val nr = ((ir * m[0][0] + ig * m[1][0] + ib * m[2][0]) shr 16).toInt()
            val ng = ((ir * m[0][1] + ig * m[1][1] + ib * m[2][1]) shr 16).toInt()
            val nb = ((ir * m[0][2] + ig * m[1][2] + ib * m[2][2]) shr 16).toInt()
            // FAST_DIV255: ((x + 128) * 257) >> 16
            fun lerp(v0: Int, v1: Int): Byte = clampByte(v0 + ((((v1 - v0) * f) + 128) * 257 shr 16))
            img.r[i] = lerp(ir, nr)
            img.g[i] = lerp(ig, ng)
            img.b[i] = lerp(ib, nb)
        }
    }

    /** gblur（1 段の再帰フィルタ、vf_gblur.c と同じ）。8 bit で返す（lrintf）。行ごと・列ごとに独立なので
     *  帯に分けて並列に回す（画素ごとの計算の順は同じ＝結果は同じ）。 */
    fun gblur8(plane: ByteArray, w: Int, h: Int, sigma: Float): ByteArray {
        val lambda = (sigma * sigma).toDouble() / 2
        val dnu = (1 + 2 * lambda - sqrt(1 + 4 * lambda)) / (2 * lambda)
        val post = (dnu / lambda).toFloat() * (dnu / lambda).toFloat()
        val bscale = (1 / (1 - dnu)).toFloat()
        val nu = dnu.toFloat()
        val p = FloatArray(plane.size)
        bands(h) { y0, y1 ->
            for (y in y0 until y1) {
                val row = y * w
                for (x in 0 until w) p[row + x] = u8(plane[row + x]).toFloat()
                p[row] *= bscale
                for (x in 1 until w) p[row + x] += nu * p[row + x - 1]
                p[row + w - 1] *= bscale
                var x = w - 1
                while (x > 0) { p[row + x - 1] += nu * p[row + x]; x -= 1 }
            }
        }
        bands(w) { x0, x1 ->
            for (x in x0 until x1) p[x] *= bscale
            for (y in 1 until h) {
                val row = y * w
                val prev = row - w
                for (x in x0 until x1) p[row + x] += nu * p[prev + x]
            }
            val last = (h - 1) * w
            for (x in x0 until x1) p[last + x] *= bscale
            var y = h - 1
            while (y > 0) {
                val row = y * w
                val up = row - w
                for (x in x0 until x1) p[up + x] += nu * p[row + x]
                y -= 1
            }
        }
        val out = ByteArray(p.size)
        bands(h) { y0, y1 -> for (i in y0 * w until y1 * w) out[i] = min(max(round(p[i] * post), 0f), 255f).toInt().toByte() }
        return out
    }

    /** 0 until n を CPU の数の帯に分けて並列に（小さいときはそのまま）。 */
    private inline fun bands(n: Int, crossinline body: (Int, Int) -> Unit) {
        val k = min(Runtime.getRuntime().availableProcessors(), max(1, n / 64))
        if (k <= 1) { body(0, n); return }
        java.util.stream.IntStream.range(0, k).parallel().forEach { j -> body(n * j / k, n * (j + 1) / k) }
    }

    fun blendScreen(a: Int, b: Int, opacity: Double): Byte {
        val e = 255 - (255 - a) * (255 - b) / 255
        return min(max(a + (e - a) * opacity, 0.0), 255.0).toInt().toByte()
    }

    fun blendOverlay(a: Int, b: Int, opacity: Double): Byte {
        val e = if (a < 128) 2 * (a * b / 255) else 255 - 2 * ((255 - a) * (255 - b) / 255)
        return min(max(a + (e - a) * opacity, 0.0), 255.0).toInt().toByte()
    }

    /** 灰色 128 にむらのない乱数（-17〜16、色ごと）→ sigma 0.45 → 灰色（輝度）を半分の大きさで作り、
     *  双 3 次で元の大きさへ（noise=alls=34:allf=u、gblur、hue=s=0、scale2ref=flags=bicubic）。 */
    fun grainPlane(w: Int, h: Int, seed: Long): ByteArray {
        val gw = max(2, (w / 4) * 2)
        val gh = max(2, (h / 4) * 2)
        val rng = SplitMix64(seed.toULong())
        fun noise() = ByteArray(gw * gh) { (128 + (rng.next() % 34uL).toInt() - 17).toByte() }
        val nr = gblur8(noise(), gw, gh, 0.45f)
        val ng = gblur8(noise(), gw, gh, 0.45f)
        val nb = gblur8(noise(), gw, gh, 0.45f)
        val small = FloatArray(gw * gh)
        for (i in 0 until gw * gh) {
            // hue=s=0 は yuv444p で色差を消す: 灰色 = テレビの範囲の Y をフルに戻したもの
            val y = round(16 + 219 * (0.299f * u8(nr[i]) + 0.587f * u8(ng[i]) + 0.114f * u8(nb[i])) / 255)
            small[i] = min(max((y - 16) * 255 / 219, 0f), 255f)
        }
        return bicubicResize(small, gw, gh, w, h)
    }

    /** swscale の bicubic（B=0, C=0.6）に近い 3 次補間。 */
    fun bicubicResize(src: FloatArray, sw: Int, sh: Int, dw: Int, dh: Int): ByteArray {
        fun kernel(x: Float): Float {
            val a = -0.6f
            val t = abs(x)
            if (t <= 1) return (a + 2) * t * t * t - (a + 3) * t * t + 1
            if (t < 2) return a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a
            return 0f
        }
        class Taps(val start: Int, val ws: FloatArray)
        fun taps(n: Int, sn: Int) = Array(n) { d ->
            val sx = (d.toFloat() + 0.5f) * sn.toFloat() / n.toFloat() - 0.5f
            val x0 = floor(sx).toInt()
            val ws = FloatArray(4) { kernel(sx - (x0 - 1 + it).toFloat()) }
            val sum = ws[0] + ws[1] + ws[2] + ws[3]
            for (k in 0 until 4) ws[k] = ws[k] / sum
            Taps(x0 - 1, ws)
        }
        val tx = taps(dw, sw)
        val ty = taps(dh, sh)
        val tmp = FloatArray(dw * sh)
        for (y in 0 until sh) {
            for (x in 0 until dw) {
                val t = tx[x]
                var v = 0f
                for (k in 0 until 4) v += t.ws[k] * src[y * sw + min(max(t.start + k, 0), sw - 1)]
                tmp[y * dw + x] = v
            }
        }
        val out = ByteArray(dw * dh)
        for (y in 0 until dh) {
            val t = ty[y]
            for (x in 0 until dw) {
                var v = 0f
                for (k in 0 until 4) v += t.ws[k] * tmp[min(max(t.start + k, 0), sh - 1) * dw + x]
                out[y * dw + x] = min(max(round(v), 0f), 255f).toInt().toByte()
            }
        }
        return out
    }

    // MARK: 画素の入れ物

    /** 8 bit の R / G / B の面（byte は 0〜255 を符号なしで読む）。 */
    class Planes(val width: Int, val height: Int) {
        val count get() = width * height
        val r = ByteArray(width * height)
        val g = ByteArray(width * height)
        val b = ByteArray(width * height)

        fun argb(): IntArray = IntArray(count) {
            (0xFF shl 24) or (u8(r[it]) shl 16) or (u8(g[it]) shl 8) or u8(b[it])
        }

        fun rgba(): ByteArray {
            val out = ByteArray(count * 4)
            for (i in 0 until count) {
                out[i * 4] = r[i]
                out[i * 4 + 1] = g[i]
                out[i * 4 + 2] = b[i]
                out[i * 4 + 3] = -1
            }
            return out
        }

        companion object {
            fun fromArgb(argb: IntArray, width: Int, height: Int) = Planes(width, height).apply {
                for (i in 0 until width * height) {
                    val c = argb[i]
                    r[i] = (c shr 16).toByte()
                    g[i] = (c shr 8).toByte()
                    b[i] = c.toByte()
                }
            }

            fun fromRgba(rgba: ByteArray, width: Int, height: Int) = Planes(width, height).apply {
                for (i in 0 until width * height) {
                    r[i] = rgba[i * 4]
                    g[i] = rgba[i * 4 + 1]
                    b[i] = rgba[i * 4 + 2]
                }
            }
        }
    }

    /** yuv444p（BT.601、テレビの範囲）。ffmpeg の gbrp ⇄ yuv444p と ±1 で同じ（確かめ済み）。 */
    class YUV private constructor(val width: Int, val height: Int) {
        val y = ByteArray(width * height)
        val u = ByteArray(width * height)
        val v = ByteArray(width * height)

        fun rgb(): Planes {
            val p = Planes(width, height)
            for (i in 0 until width * height) {
                val c = (u8(y[i]).toFloat() - 16) * 255 / 219
                val d = (u8(u[i]).toFloat() - 128) * 255 / 224
                val e = (u8(v[i]).toFloat() - 128) * 255 / 224
                p.r[i] = clampF(c + 1.402f * e)
                p.g[i] = clampF(c - 0.344136f * d - 0.714136f * e)
                p.b[i] = clampF(c + 1.772f * d)
            }
            return p
        }

        companion object {
            fun of(p: Planes) = YUV(p.width, p.height).apply {
                for (i in 0 until p.count) {
                    val r = u8(p.r[i]).toFloat()
                    val g = u8(p.g[i]).toFloat()
                    val b = u8(p.b[i]).toFloat()
                    y[i] = clampF(16 + 219 * (0.299f * r + 0.587f * g + 0.114f * b) / 255)
                    u[i] = clampF(128 + 224 * (-0.168736f * r - 0.331264f * g + 0.5f * b) / 255)
                    v[i] = clampF(128 + 224 * (0.5f * r - 0.418688f * g - 0.081312f * b) / 255)
                }
            }
        }
    }

    class SplitMix64(private var state: ULong) {
        fun next(): ULong {
            state += 0x9E3779B97F4A7C15uL
            var z = state
            z = (z xor (z shr 30)) * 0xBF58476D1CE4E5B9uL
            z = (z xor (z shr 27)) * 0x94D049BB133111EBuL
            return z xor (z shr 31)
        }
    }

    // MARK: 丸め（Swift の rounded() = 0.5 は 0 から遠い方へ。Kotlin の round() は偶数丸めなので使わない）

    private fun u8(b: Byte) = b.toInt() and 0xFF

    private fun round(x: Double): Double {
        val a = abs(x)
        val f = floor(a)
        val r = if (a - f >= 0.5) f + 1 else f
        return if (x < 0) -r else r
    }

    private fun round(x: Float): Float {
        val a = abs(x)
        val f = floor(a)
        val r = if (a - f >= 0.5f) f + 1 else f
        return if (x < 0) -r else r
    }

    private fun clampByte(v: Int): Byte = min(max(v, 0), 255).toByte()

    private fun clampF(v: Float): Byte = min(max(round(v), 0f), 255f).toInt().toByte()
}
