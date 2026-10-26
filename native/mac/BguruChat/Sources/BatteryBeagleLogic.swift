import Foundation

/// 🔋 ビーグルで電池の残量を見せる（docs/mac-battery-beagle-spec.md）の決め方だけ。IOKit・絵には触らない（テストで確かめる）。
///
/// - 体の塗りは残量ぶん下から満ちる（100% で全部、0% で輪郭だけ）。塗りの高さは体の縦を `steps` 段に分けた段の数。
///   0% と 100% のときだけ 0 段・全段にし、1〜99% は 1〜steps-1 段に収める（少しでも残っていれば足元が塗られ、満充電の手前は満ちきらない）。
/// - 充電中は ⚡ の印、20% 以下（または macOS の低電力の目安）はしょんぼりの姿勢。
/// - 描き直すのは 1% 変わったとき・充電の状態（電源・充電中・低電力の目安）が変わったときだけ。残り時間だけの変化では描き直さない。
enum BatteryBeagleLogic {
    /// これ以下でしょんぼり（%）。
    static let lowPercent = 20

    /// 電池の様子（IOPSCopyPowerSourcesInfo の内蔵の電池）。
    struct Status: Equatable {
        var percent: Int
        /// 電源につながっている（Power Source State が AC Power）。
        var onAC: Bool
        /// 充電中（Is Charging）。電源につながっていても、満充電・充電の最適化で止まっているときは false。
        var isCharging: Bool
        /// 空になるまでの分（Time to Empty）。nil = 計算中・分からない。
        var minutesToEmpty: Int?
        /// 満充電までの分（Time to Full Charge）。nil = 計算中・分からない。
        var minutesToFull: Int?
        /// macOS の低電力の目安（IOPSGetBatteryWarningLevel が early / final）。
        var lowWarning = false
    }

    /// 絵の決まり（BeagleIcon が描く。キャッシュの鍵にも使う）。
    struct Look: Hashable {
        /// 塗る段の数（0 = 輪郭だけ、steps = 全部）。
        var fillSteps: Int
        var steps: Int
        /// ⚡ の印。
        var charging: Bool
        /// しょんぼり（頭としっぽを下げる）。
        var droopy: Bool

        var key: String { "\(fillSteps)/\(steps)\(charging ? "c" : "")\(droopy ? "d" : "")" }
    }

    /// 残量（%）→ 塗る段の数。
    static func fillSteps(percent: Int, steps: Int) -> Int {
        guard steps > 0 else { return 0 }
        if percent <= 0 { return 0 }
        if percent >= 100 { return steps }
        let s = Int((Double(percent) * Double(steps) / 100).rounded())
        return min(max(s, 1), steps - 1)
    }

    static func isDroopy(_ s: Status) -> Bool {
        s.percent <= lowPercent || s.lowWarning
    }

    static func look(_ s: Status, steps: Int) -> Look {
        Look(fillSteps: fillSteps(percent: s.percent, steps: steps), steps: steps, charging: s.isCharging, droopy: isDroopy(s))
    }

    /// 描き直すか（見せ始め・やめる・1% の変化・充電の状態の変化）。残り時間だけの変化では描き直さない。
    static func needsRedraw(old: Status?, new: Status?) -> Bool {
        guard let old, let new else { return (old == nil) != (new == nil) }
        return old.percent != new.percent || old.onAC != new.onAC || old.isCharging != new.isCharging || old.lowWarning != new.lowWarning
    }

    /// 細かい値（ツールチップ・アクセシビリティ・右クリックのメニューの先頭の行）。
    /// 「🔋 82%・残り 4:10」「⚡ 充電中 82%・満充電まで 0:40」「電源につながっています 100%」。時間が分からないときは % だけ。
    static func detail(_ s: Status) -> String {
        if s.isCharging {
            return "⚡ 充電中 \(s.percent)%" + (s.minutesToFull.flatMap(clock).map { "・満充電まで \($0)" } ?? "")
        }
        if s.onAC { return "電源につながっています \(s.percent)%" }
        return "🔋 \(s.percent)%" + (s.minutesToEmpty.flatMap(clock).map { "・残り \($0)" } ?? "")
    }

    /// 分 → 「4:10」「0:40」。0 以下（計算中の -1 など）は nil。
    static func clock(_ minutes: Int) -> String? {
        guard minutes > 0 else { return nil }
        return String(format: "%d:%02d", minutes / 60, minutes % 60)
    }
}
