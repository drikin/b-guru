import Foundation

/// 五撮 Vol.1（ドリキンフィルター第 1 弾）を端末の中でかける（drikin 2026-11-03: チャットのカメラで撮った写真に、
/// かけるかどうかを選んで）。正本は西田カメラの dk5090 側（~/Dev/promptcam/server/promptcam_gateway.py の
/// `gosatsu_stats` / `gosatsu_plan` / `gosatsu_filter`、ffmpeg のフィルタ）で、ここはそれを同じ計算で写したもの。
/// 段ごとに ffmpeg と同じところで 8 bit に丸めるので、粒子の乱数以外はほぼ同じ画素になる（Mac の単体テストで照合）。
///
/// 1. 写真ごとの土台合わせ（`plan`）: 黒白・彩度・最細部を測って、どのカメラでも同じ土台へ。
/// 2. 共通の味つけ（`render`）: 色、3 段の解像感（ノイズは上げず強い輪郭は頭打ち＝縁取りなし）、
///    ハレーション、半分の大きさの粒子、軽い周辺減光。モノクロはモノクロのまま。
///
/// 画像は RGBA 8 bit（4 byte / 画素、アルファは無視して 255 で返す）。長辺 2048 px までを想定（送るときの大きさ）。
enum Gosatsu {
    struct Plan: Equatable {
        var levels: (lo: Double, loOut: Double, hi: Double, hiOut: Double)
        var sat: Double
        var mono: Bool
        var dark: Bool
        var bright: Bool
        var fine: Double
        var texture: Double
        var local: Double

        static func == (a: Plan, b: Plan) -> Bool {
            a.levels == b.levels && a.sat == b.sat && a.mono == b.mono && a.dark == b.dark && a.bright == b.bright
                && a.fine == b.fine && a.texture == b.texture && a.local == b.local
        }
    }

    struct Stats {
        var yLow: Double, yHigh: Double, yAvg: Double, satAvg: Double, fine: Double, mid: Double
    }

    /// 五撮をかけた RGBA を返す。`seed` は粒子の乱数（同じ seed なら同じ粒子）。
    static func apply(rgba: [UInt8], width: Int, height: Int, seed: UInt64 = .random(in: 0...UInt64.max)) -> [UInt8] {
        let img = Planes(rgba: rgba, width: width, height: height)
        return render(img, plan: plan(stats(img)), seed: seed).rgba()
    }

    // MARK: 1. 測る・土台を決める

    /// ffmpeg signalstats（yuvj444p = フルレンジ）と同じ量: YLOW / YHIGH は 10 / 90 パーセンタイル、SATAVG は
    /// 色差の長さの平均。FINE / MID は灰色の画像と sigma 0.8 / 3 でぼかしたものとの差の平均。
    static func stats(_ img: Planes) -> Stats {
        let n = img.count
        var hist = [Int](repeating: 0, count: 256)
        var ySum = 0.0, satSum = 0.0
        var gray = [UInt8](repeating: 0, count: n)
        for i in 0..<n {
            let r = Double(img.r[i]), g = Double(img.g[i]), b = Double(img.b[i])
            let y = min(max((0.299 * r + 0.587 * g + 0.114 * b).rounded(), 0), 255)
            let u = (-0.168736 * r - 0.331264 * g + 0.5 * b).rounded()
            let v = (0.5 * r - 0.418688 * g - 0.081312 * b).rounded()
            hist[Int(y)] += 1
            ySum += y
            satSum += (u * u + v * v).squareRoot().rounded(.down)  // signalstats は 8 bit に切り捨てて数える
            gray[i] = UInt8(y)
        }
        func percentile(_ p: Int) -> Double {
            let target = Int((Double(n) * Double(p) / 100).rounded())
            var acc = 0
            for j in 0..<256 {
                acc += hist[j]
                if acc >= target { return Double(j) }
            }
            return 255
        }
        func detail(_ sigma: Float) -> Double {
            let blurred = gblur8(gray, width: img.width, height: img.height, sigma: sigma)
            var s = 0
            for i in 0..<n { s += abs(Int(gray[i]) - Int(blurred[i])) }
            return Double(s) / Double(max(n, 1))
        }
        return Stats(yLow: percentile(10), yHigh: percentile(90), yAvg: ySum / Double(max(n, 1)),
                     satAvg: satSum / Double(max(n, 1)), fine: detail(0.8), mid: detail(3))
    }

    /// `gosatsu_plan` と同じ（数値もそのまま）。
    static func plan(_ st: Stats) -> Plan {
        let lo = st.yLow, hi = st.yHigh
        var loOut = lo > 20 ? lo - min(0.7 * (lo - 20), 12) : lo
        var hiOut = hi < 205 ? hi + 0.5 * (205 - hi) : hi
        if hi > lo, (hiOut - loOut) / (hi - lo) > 1.4 {
            let mid = (loOut + hiOut) / 2, half = (hi - lo) * 1.4 / 2
            loOut = mid - half
            hiOut = mid + half
        }
        let mono = st.satAvg < 1.5
        var sat = mono ? 1.0 : min(max((13 / max(st.satAvg, 1)).squareRoot(), 0.85), 1.12)
        if st.satAvg > 25 { sat = min(sat, 0.92) }
        let lack = min(max((0.30 - st.fine / max(st.mid, 0.01)) / 0.15, 0), 1)
        let spread = hiOut - loOut
        func r(_ v: Double, _ p: Double) -> Double { (v * p).rounded() / p }
        return Plan(levels: (r(lo, 10), r(max(loOut, 0), 10), r(hi, 10), r(min(hiOut, 250), 10)),
                    sat: r(sat, 1000), mono: mono, dark: st.yAvg < 95, bright: hi > 245,
                    fine: r(0.6 * lack, 1000), texture: 0.5,
                    local: r(0.22 + 0.12 * min(max((150 - spread) / 80, 0), 1), 1000))
    }

    // MARK: 2. 味つけ（`gosatsu_filter` の ffmpeg の流れの順に）

    /// `grain: false` は照合用（粒子は乱数なので ffmpeg と画素では比べられない）。
    static func render(_ src: Planes, plan p: Plan, seed: UInt64, grain withGrain: Bool = true) -> Planes {
        let n = src.count, w = src.width, h = src.height

        // [base] curves（土台の黒白）→ curves（共通のトーン）
        var points: [(Double, Double)] = [(0, 0)]
        for (x, y) in [(p.levels.lo / 255, p.levels.loOut / 255), (p.levels.hi / 255, p.levels.hiOut / 255), (1.0, 1.0)]
        where x - points[points.count - 1].0 >= 0.01 {
            points.append((x, y))
        }
        if points[points.count - 1].0 < 1 { points[points.count - 1] = (1, 1) }
        points = points.map { ((($0.0 * 10000).rounded() / 10000), (($0.1 * 10000).rounded() / 10000)) }
        let toe: [(Double, Double)] = p.dark ? [(0.06, 0.055), (0.25, 0.24), (0.5, 0.51)] : [(0.06, 0.045), (0.25, 0.225), (0.5, 0.5)]
        let look: [(Double, Double)] = [(0, 0)] + toe + [(0.75, 0.785), p.bright ? (0.92, 0.92) : (0.92, 0.925), (1, 0.975)]
        let base = curveLUT(points), lookLUT = curveLUT(look)
        var img = src
        for i in 0..<n {
            img.r[i] = lookLUT[Int(base[Int(img.r[i])])]
            img.g[i] = lookLUT[Int(base[Int(img.g[i])])]
            img.b[i] = lookLUT[Int(base[Int(img.b[i])])]
        }

        if !p.mono {
            colorBalance(&img)
            hueSaturation(&img, saturation: -0.15, colors: .green)
            hueSaturation(&img, saturation: 0.06, colors: [.red, .yellow])
        }

        // hue=s（yuv444p、テレビの範囲）→ 3 段の解像感（輝度だけ）→ gbrp
        var yuv = YUV(img)
        let c = Int32((65536 * p.sat * 0.96).rounded())
        for i in 0..<n {
            yuv.u[i] = UInt8(clamping: (c * (Int32(yuv.u[i]) - 128) + (1 << 15) + (128 << 16)) >> 16)
            yuv.v[i] = UInt8(clamping: (c * (Int32(yuv.v[i]) - 128) + (1 << 15) + (128 << 16)) >> 16)
        }
        for (sigma, k, core, cap) in [(Float(1.0), p.fine, 1.0, 5.0), (3.5, p.texture, 0.6, 9.0), (28, p.local, 0, 14)] where k != 0 {
            let b = gblur8(yuv.y, width: w, height: h, sigma: sigma)
            for i in 0..<n {
                let a = Double(yuv.y[i]), d = a - Double(b[i])
                let lift = k * (d > 0 ? 1 : d < 0 ? -1 : 0) * min(max(abs(d) - core, 0), cap)
                yuv.y[i] = UInt8(min(max(a + lift, 0), 255))
            }
        }
        var g1 = yuv.rgb()

        // [hl] いちばん明るい光だけ → ぼかす → 赤み（モノクロは中立のまま）→ screen 0.18
        let hlLUT = curveLUT([(0, 0), (0.85, 0), (1, 1)])
        var halo = Planes(width: w, height: h)
        for i in 0..<n {
            halo.r[i] = hlLUT[Int(src.r[i])]
            halo.g[i] = hlLUT[Int(src.g[i])]
            halo.b[i] = hlLUT[Int(src.b[i])]
        }
        halo.r = gblur8(halo.r, width: w, height: h, sigma: 10)
        halo.g = gblur8(halo.g, width: w, height: h, sigma: 10)
        halo.b = gblur8(halo.b, width: w, height: h, sigma: 10)
        if !p.mono {
            for i in 0..<n {
                halo.g[i] = UInt8(min(Double(halo.g[i]) * 0.35 + 0.5, 255))  // colorchannelmixer gg=0.35
                halo.b[i] = UInt8(min(Double(halo.b[i]) * 0.1 + 0.5, 255))   // bb=0.1
            }
        }
        for i in 0..<n {
            g1.r[i] = blendScreen(g1.r[i], halo.r[i], 0.18)
            g1.g[i] = blendScreen(g1.g[i], halo.g[i], 0.18)
            g1.b[i] = blendScreen(g1.b[i], halo.b[i], 0.18)
        }

        // 粒子: 半分の大きさで作り（携帯の画面で縮めても残る）、overlay で中間調にいちばん多く。
        let grain = grainPlane(width: w, height: h, seed: seed)
        let opacity = withGrain ? (p.dark ? 0.5 : 0.68) : 0
        for i in 0..<n where withGrain {
            g1.r[i] = blendOverlay(g1.r[i], grain[i], opacity)
            g1.g[i] = blendOverlay(g1.g[i], grain[i], opacity)
            g1.b[i] = blendOverlay(g1.b[i], grain[i], opacity)
        }

        // vignette=angle=PI/14（yuv444p: 輝度は掛け算、色差は 127 を中心に）
        var out = YUV(g1)
        let x0 = Double(w / 2), y0 = Double(h / 2)
        let dmax = (Double(w) / 2 * Double(w) / 2 + Double(h) / 2 * Double(h) / 2).squareRoot()
        let angle = Double.pi / 14
        var colFactor = [Double](repeating: 0, count: w)
        for y in 0..<h {
            let yy = Double(Int(Double(y) - y0))
            for x in 0..<w {
                let xx = Double(Int(Double(x) - x0))
                let dn = (xx * xx + yy * yy).squareRoot() / dmax
                let cs = cos(angle * dn)
                colFactor[x] = dn > 1 ? 0 : cs * cs * cs * cs
            }
            let row = y * w
            for x in 0..<w {
                let f = colFactor[x], i = row + x
                out.y[i] = UInt8(min(max(f * Double(out.y[i]) + 0.5, 0), 255))
                out.u[i] = UInt8(min(max(f * (Double(out.u[i]) - 127) + 127 + 0.5, 0), 255))
                out.v[i] = UInt8(min(max(f * (Double(out.v[i]) - 127) + 127 + 0.5, 0), 255))
            }
        }
        return out.rgb()
    }

    // MARK: ffmpeg のフィルタを同じ計算で

    /// curves（自然 3 次スプライン、8 bit の表）。vf_curves.c の interpolate と同じ（端の切り捨てまで）。
    static func curveLUT(_ pts: [(Double, Double)]) -> [UInt8] {
        let scale = 255.0
        func clip(_ v: Double) -> UInt8 { UInt8(min(max(Int(v), 0), 255)) }  // av_clip_uint8((int)v)
        let n = pts.count
        var lut = [UInt8](repeating: 0, count: 256)
        if n == 1 { return lut.map { _ in clip(pts[0].1 * scale) } }
        var h = [Double](repeating: 0, count: n - 1)
        for i in 0..<(n - 1) { h[i] = pts[i + 1].0 - pts[i].0 }
        var r = [Double](repeating: 0, count: n)
        for i in 1..<max(n - 1, 1) where n > 2 {
            r[i] = 6 * ((pts[i + 1].1 - pts[i].1) / h[i] - (pts[i].1 - pts[i - 1].1) / h[i - 1])
        }
        var bd = [Double](repeating: 0, count: n), md = [Double](repeating: 0, count: n), ad = [Double](repeating: 0, count: n)
        md[0] = 1
        md[n - 1] = 1
        for i in 1..<max(n - 1, 1) where n > 2 {
            bd[i] = h[i - 1]
            md[i] = 2 * (h[i - 1] + h[i])
            ad[i] = h[i]
        }
        for i in 1..<n {
            let den = md[i] - bd[i] * ad[i - 1]
            let k = den != 0 ? 1 / den : 1
            ad[i] *= k
            r[i] = (r[i] - bd[i] * r[i - 1]) * k
        }
        for i in stride(from: n - 2, through: 0, by: -1) { r[i] -= ad[i] * r[i + 1] }
        for i in 0..<Int(pts[0].0 * scale) { lut[i] = clip(pts[0].1 * scale) }
        for i in 0..<(n - 1) {
            let yc = pts[i].1, yn = pts[i + 1].1
            let a = yc
            let b = (yn - yc) / h[i] - h[i] * r[i] / 2 - h[i] * (r[i + 1] - r[i]) / 6
            let c = r[i] / 2
            let d = (r[i + 1] - r[i]) / (6 * h[i])
            let xs = Int(pts[i].0 * scale), xe = Int(pts[i + 1].0 * scale)
            guard xs <= xe else { continue }
            for x in xs...xe {
                let xx = Double(x - xs) / scale
                lut[x] = clip((a + b * xx + c * xx * xx + d * xx * xx * xx) * scale)
            }
        }
        for i in Int(pts[n - 1].0 * scale)..<256 { lut[i] = clip(pts[n - 1].1 * scale) }
        return lut
    }

    /// colorbalance=rs=-0.02:bs=0.025:rm=0.012:bm=-0.006:rh=0.025:gh=0.008:bh=-0.012（vf_colorbalance.c と同じ）。
    static func colorBalance(_ img: inout Planes) {
        func comp(_ v: Float, _ l: Float, _ s: Float, _ m: Float, _ hi: Float) -> Float {
            let a: Float = 4, b: Float = 0.333, scale: Float = 0.7
            let s2 = s * min(max((b - l) * a + 0.5, 0), 1) * scale
            let m2 = m * min(max((l - b) * a + 0.5, 0), 1) * min(max((1 - l - b) * a + 0.5, 0), 1) * scale
            let h2 = hi * min(max((l + b - 1) * a + 0.5, 0), 1) * scale
            return min(max(v + s2 + m2 + h2, 0), 1)
        }
        for i in 0..<img.count {
            let r = Float(img.r[i]) / 255, g = Float(img.g[i]) / 255, b = Float(img.b[i]) / 255
            let l = max(r, g, b) + min(r, g, b)
            img.r[i] = UInt8((comp(r, l, -0.02, 0.012, 0.025) * 255).rounded())
            img.g[i] = UInt8((comp(g, l, 0, 0, 0.008) * 255).rounded())
            img.b[i] = UInt8((comp(b, l, 0.025, -0.006, -0.012) * 255).rounded())
        }
    }

    struct HueColors: OptionSet {
        let rawValue: Int
        static let red = HueColors(rawValue: 1 << 0), yellow = HueColors(rawValue: 1 << 1)
        static let green = HueColors(rawValue: 1 << 2)
    }

    /// huesaturation=saturation=…:colors=…:strength=1（vf_huesaturation.c の 8 bit の整数計算と同じ）。
    static func hueSaturation(_ img: inout Planes, saturation: Float, colors: HueColors) {
        let s = 1 + saturation, t = 1 - s
        let wr: Float = 0.333, wg: Float = 0.334, wb: Float = 0.333
        // m[row][col]: r' = r*m[0][0] + g*m[1][0] + b*m[2][0]（get_triplet の並び）
        let m: [[Int64]] = [[t * wr + s, t * wr, t * wr], [t * wg, t * wg + s, t * wg], [t * wb, t * wb, t * wb + s]]
            .map { $0.map { Int64(($0 * 65536).rounded()) } }
        for i in 0..<img.count {
            let ir = Int(img.r[i]), ig = Int(img.g[i]), ib = Int(img.b[i])
            let mn = min(ir, ig, ib), mx = max(ir, ig, ib)
            var hit = false
            var f = 0
            if colors.contains(.red) {
                hit = hit || ir == mx
                f = max(f, ir - max(ig, ib))
            }
            if colors.contains(.yellow) {
                hit = hit || ib == mn
                f = max(f, min(ir, ig) - ib)
            }
            if colors.contains(.green) {
                hit = hit || ig == mx
                f = max(f, ig - max(ir, ib))
            }
            guard hit else { continue }
            f = min(f, 255)
            let nr = Int((Int64(ir) * m[0][0] + Int64(ig) * m[1][0] + Int64(ib) * m[2][0]) >> 16)
            let ng = Int((Int64(ir) * m[0][1] + Int64(ig) * m[1][1] + Int64(ib) * m[2][1]) >> 16)
            let nb = Int((Int64(ir) * m[0][2] + Int64(ig) * m[1][2] + Int64(ib) * m[2][2]) >> 16)
            // FAST_DIV255。Swift の >> は * より先に計算されるので括弧が要る。
            func lerp(_ v0: Int, _ v1: Int) -> UInt8 { UInt8(clamping: v0 + (((((v1 - v0) * f) + 128) * 257) >> 16)) }
            img.r[i] = lerp(ir, nr)
            img.g[i] = lerp(ig, ng)
            img.b[i] = lerp(ib, nb)
        }
    }

    /// gblur（1 段の再帰フィルタ、vf_gblur.c と同じ）。8 bit で返す（lrintf）。
    static func gblur8(_ plane: [UInt8], width w: Int, height h: Int, sigma: Float) -> [UInt8] {
        let lambda = Double(sigma * sigma) / 2
        let dnu = (1 + 2 * lambda - (1 + 4 * lambda).squareRoot()) / (2 * lambda)
        let post = Float(dnu / lambda) * Float(dnu / lambda)
        let bscale = Float(1 / (1 - dnu)), nu = Float(dnu)
        var buf = plane.map(Float.init)
        buf.withUnsafeMutableBufferPointer { p in
            for y in 0..<h {
                let row = y * w
                p[row] *= bscale
                for x in 1..<w { p[row + x] += nu * p[row + x - 1] }
                p[row + w - 1] *= bscale
                var x = w - 1
                while x > 0 { p[row + x - 1] += nu * p[row + x]; x -= 1 }
            }
            for x in 0..<w { p[x] *= bscale }
            for y in 1..<h {
                let row = y * w, prev = row - w
                for x in 0..<w { p[row + x] += nu * p[prev + x] }
            }
            let last = (h - 1) * w
            for x in 0..<w { p[last + x] *= bscale }
            var y = h - 1
            while y > 0 {
                let row = y * w, up = row - w
                for x in 0..<w { p[up + x] += nu * p[row + x] }
                y -= 1
            }
        }
        return buf.map { UInt8(min(max(($0 * post).rounded(), 0), 255)) }
    }

    static func blendScreen(_ a: UInt8, _ b: UInt8, _ opacity: Double) -> UInt8 {
        let ai = Int(a), bi = Int(b)
        let e = 255 - (255 - ai) * (255 - bi) / 255
        return UInt8(min(max(Double(ai) + Double(e - ai) * opacity, 0), 255))
    }

    static func blendOverlay(_ a: UInt8, _ b: UInt8, _ opacity: Double) -> UInt8 {
        let ai = Int(a), bi = Int(b)
        let e = ai < 128 ? 2 * (ai * bi / 255) : 255 - 2 * ((255 - ai) * (255 - bi) / 255)
        return UInt8(min(max(Double(ai) + Double(e - ai) * opacity, 0), 255))
    }

    /// 灰色 128 にむらのない乱数（-17〜16、色ごと）→ sigma 0.45 → 灰色（輝度）を半分の大きさで作り、
    /// 双 3 次で元の大きさへ（noise=alls=34:allf=u、gblur、hue=s=0、scale2ref=flags=bicubic）。
    static func grainPlane(width w: Int, height h: Int, seed: UInt64) -> [UInt8] {
        let gw = max(2, (w / 4) * 2), gh = max(2, (h / 4) * 2)
        var rng = SplitMix64(seed: seed)
        func noise() -> [UInt8] { (0..<(gw * gh)).map { _ in UInt8(128 + Int(rng.next() % 34) - 17) } }
        let nr = gblur8(noise(), width: gw, height: gh, sigma: 0.45)
        let ng = gblur8(noise(), width: gw, height: gh, sigma: 0.45)
        let nb = gblur8(noise(), width: gw, height: gh, sigma: 0.45)
        var small = [Float](repeating: 128, count: gw * gh)
        for i in 0..<(gw * gh) {
            // hue=s=0 は yuv444p で色差を消す: 灰色 = テレビの範囲の Y をフルに戻したもの
            let y = (16 + 219 * (0.299 * Float(nr[i]) + 0.587 * Float(ng[i]) + 0.114 * Float(nb[i])) / 255).rounded()
            small[i] = min(max((y - 16) * 255 / 219, 0), 255)
        }
        return bicubicResize(small, from: (gw, gh), to: (w, h))
    }

    /// swscale の bicubic（B=0, C=0.6）に近い 3 次補間。
    static func bicubicResize(_ src: [Float], from: (Int, Int), to: (Int, Int)) -> [UInt8] {
        let (sw, sh) = from, (dw, dh) = to
        func kernel(_ x: Float) -> Float {
            let a: Float = -0.6, t = abs(x)
            if t <= 1 { return (a + 2) * t * t * t - (a + 3) * t * t + 1 }
            if t < 2 { return a * t * t * t - 5 * a * t * t + 8 * a * t - 4 * a }
            return 0
        }
        func taps(_ n: Int, _ sn: Int) -> [(Int, [Float])] {
            (0..<n).map { d in
                let sx = (Float(d) + 0.5) * Float(sn) / Float(n) - 0.5
                let x0 = Int(sx.rounded(.down))
                var ws = (0..<4).map { kernel(sx - Float(x0 - 1 + $0)) }
                let sum = ws.reduce(0, +)
                ws = ws.map { $0 / sum }
                return (x0 - 1, ws)
            }
        }
        let tx = taps(dw, sw), ty = taps(dh, sh)
        var tmp = [Float](repeating: 0, count: dw * sh)
        for y in 0..<sh {
            for x in 0..<dw {
                let (x0, ws) = tx[x]
                var v: Float = 0
                for k in 0..<4 { v += ws[k] * src[y * sw + min(max(x0 + k, 0), sw - 1)] }
                tmp[y * dw + x] = v
            }
        }
        var out = [UInt8](repeating: 128, count: dw * dh)
        for y in 0..<dh {
            let (y0, ws) = ty[y]
            for x in 0..<dw {
                var v: Float = 0
                for k in 0..<4 { v += ws[k] * tmp[min(max(y0 + k, 0), sh - 1) * dw + x] }
                out[y * dw + x] = UInt8(min(max(v.rounded(), 0), 255))
            }
        }
        return out
    }

    // MARK: 画素の入れ物

    struct Planes {
        let width: Int, height: Int
        var r: [UInt8], g: [UInt8], b: [UInt8]
        var count: Int { width * height }

        init(width: Int, height: Int) {
            self.width = width
            self.height = height
            r = [UInt8](repeating: 0, count: width * height)
            g = r
            b = r
        }

        init(rgba: [UInt8], width: Int, height: Int) {
            self.init(width: width, height: height)
            for i in 0..<(width * height) {
                r[i] = rgba[i * 4]
                g[i] = rgba[i * 4 + 1]
                b[i] = rgba[i * 4 + 2]
            }
        }

        func rgba() -> [UInt8] {
            var out = [UInt8](repeating: 255, count: count * 4)
            for i in 0..<count {
                out[i * 4] = r[i]
                out[i * 4 + 1] = g[i]
                out[i * 4 + 2] = b[i]
            }
            return out
        }
    }

    /// yuv444p（BT.601、テレビの範囲）。ffmpeg の gbrp ⇄ yuv444p と ±1 で同じ（確かめ済み）。
    struct YUV {
        let width: Int, height: Int
        var y: [UInt8], u: [UInt8], v: [UInt8]

        init(_ p: Planes) {
            width = p.width
            height = p.height
            let n = p.count
            y = [UInt8](repeating: 0, count: n)
            u = y
            v = y
            for i in 0..<n {
                let r = Float(p.r[i]), g = Float(p.g[i]), b = Float(p.b[i])
                y[i] = UInt8(min(max((16 + 219 * (0.299 * r + 0.587 * g + 0.114 * b) / 255).rounded(), 0), 255))
                u[i] = UInt8(min(max((128 + 224 * (-0.168736 * r - 0.331264 * g + 0.5 * b) / 255).rounded(), 0), 255))
                v[i] = UInt8(min(max((128 + 224 * (0.5 * r - 0.418688 * g - 0.081312 * b) / 255).rounded(), 0), 255))
            }
        }

        func rgb() -> Planes {
            var p = Planes(width: width, height: height)
            for i in 0..<(width * height) {
                let c = (Float(y[i]) - 16) * 255 / 219
                let d = (Float(u[i]) - 128) * 255 / 224, e = (Float(v[i]) - 128) * 255 / 224
                p.r[i] = UInt8(min(max((c + 1.402 * e).rounded(), 0), 255))
                p.g[i] = UInt8(min(max((c - 0.344136 * d - 0.714136 * e).rounded(), 0), 255))
                p.b[i] = UInt8(min(max((c + 1.772 * d).rounded(), 0), 255))
            }
            return p
        }
    }

    struct SplitMix64 {
        var state: UInt64
        init(seed: UInt64) { state = seed }
        mutating func next() -> UInt64 {
            state &+= 0x9E37_79B9_7F4A_7C15
            var z = state
            z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
            z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
            return z ^ (z >> 31)
        }
    }
}

#if canImport(ImageIO)
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

extension Gosatsu {
    /// 撮った写真（JPEG / HEIC）に五撮をかけて JPEG で返す。送るときと同じ長辺 2048 px・EXIF の回転を当てた
    /// うえで、写真の色空間（iPhone なら Display P3）のまま画素の値を扱う（dk5090 の ffmpeg と同じ。sRGB に
    /// 直すと彩度の測り方がずれる）。位置情報などのメタデータは付けない。
    static func jpeg(from data: Data, maxSide: Int = 2048, quality: Double = 0.95,
                     seed: UInt64 = .random(in: 0...UInt64.max)) -> Data? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceShouldCacheImmediately: true,
                  kCGImageSourceThumbnailMaxPixelSize: maxSide,
              ] as CFDictionary)
        else { return nil }
        let w = cg.width, h = cg.height
        let space = cg.colorSpace.flatMap { $0.model == .rgb ? $0 : nil } ?? CGColorSpace(name: CGColorSpace.sRGB)!
        let info = CGImageAlphaInfo.noneSkipLast.rawValue
        var rgba = [UInt8](repeating: 0, count: w * h * 4)
        let drawn = rgba.withUnsafeMutableBytes { buf -> Bool in
            guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                      space: space, bitmapInfo: info) else { return false }
            ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
            return true
        }
        guard drawn else { return nil }
        var out = apply(rgba: rgba, width: w, height: h, seed: seed)
        let image = out.withUnsafeMutableBytes { buf -> CGImage? in
            CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                      space: space, bitmapInfo: info)?.makeImage()
        }
        let result = NSMutableData()
        guard let image,
              let dest = CGImageDestinationCreateWithData(result, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
        CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        return CGImageDestinationFinalize(dest) ? result as Data : nil
    }
}
#endif
