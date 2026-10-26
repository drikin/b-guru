import Foundation

/// ☕ スリープさせない（docs/mac-keep-awake-spec.md）の決め方だけ。IOKit・画面・アプリには触らない（テストで確かめる）。
///
/// - 手動（切るまで／終わりの時刻）と自動（🍻・通話・📺・選んだアプリ・電源・外部ディスプレイ）のどれかが当てはまれば入る。
/// - 電池で動いていて残りが設定の値以下になったら、手動・自動とも止める（手動は取り消す）。
///   電源につながるか、残りが値より 5% 以上戻るまでは入れない（行ったり来たりしないように）。
/// - 電池の無い Mac（デスクトップ）では電池の決まりは何もしない。
/// - 「画面も消さない」は、入っているあいだ（手動でも自動でも）画面の消灯も止める。
enum KeepAwakeLogic {
    /// 電池が戻ったとみなす幅（設定の値 + これ以上で、また入れる）。
    static let hysteresis = 5
    /// 電池の値の選択肢（%）。
    static let thresholds = [10, 15, 20, 30, 40, 50]
    static let defaultThreshold = 20
    /// 手動の長さの選択肢（分。nil = 切るまで）。
    static let durations: [Int?] = [nil, 30, 60, 120, 240]

    /// 手動の入れ方。`until` が nil なら切るまで。
    struct Manual: Equatable {
        var until: Date?
    }

    /// 自動の設定（オン・オフ）。
    struct AutoFlags: Equatable {
        var call = true      // 🍻・ボイスルーム・部室の音声
        var watch = true     // 📺 の再生
        var apps = false     // 選んだアプリが動いている
        var power = false    // 電源につながっている
        var display = false  // 外部ディスプレイがある
    }

    /// いまの様子（自動の条件）。
    struct Conditions: Equatable {
        /// 入っている音声（「🍻 の音声」「ボイスルーム」「部室の音声」）。nil = 入っていない。
        var call: String?
        var watchPlaying = false
        /// 選んだアプリのうち、いま動いているものの名前。
        var runningApps: [String] = []
        var externalDisplay = false
    }

    /// 電池。`hasBattery` が false（デスクトップ）なら電池の決まりは使わない。
    struct Battery: Equatable {
        var hasBattery: Bool
        var onAC: Bool
        var percent: Int
        static let desktop = Battery(hasBattery: false, onAC: true, percent: 100)
    }

    struct Input {
        var manual: Manual?
        var keepDisplay = false
        var auto = AutoFlags()
        var conditions = Conditions()
        var battery = Battery.desktop
        var threshold = KeepAwakeLogic.defaultThreshold
        /// 前回までに電池で止めたか（戻るまでは入れない）。
        var batteryLow = false
        var now = Date()
        var timeZone = TimeZone.current
    }

    struct Decision: Equatable {
        /// PreventUserIdleSystemSleep を持つか。
        var holdSystem = false
        /// PreventUserIdleDisplaySleep も持つか。
        var holdDisplay = false
        /// 入っている理由（ツールチップ・アクセシビリティ・assertion の名前に出す）。
        var reasons: [String] = []
        /// 手動を取り消す（時間が来た・電池で止めた）。
        var clearManual = false
        /// 時間が来て手動を終えた（知らせを 1 回）。
        var manualExpired = false
        /// 電池で止めている（次の Input.batteryLow に渡す）。
        var batteryLow = false
        /// いま電池で止めた（知らせを 1 回。何も当てはまっていなかったときは知らせない）。
        var stoppedByBattery = false
    }

    /// 手動の理由の文字（「切るまで」「15:30 まで」）。
    static func manualLabel(_ m: Manual, timeZone: TimeZone = .current) -> String {
        guard let until = m.until else { return "切るまで" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "ja_JP")
        f.timeZone = timeZone
        f.dateFormat = "H:mm"
        return "\(f.string(from: until)) まで"
    }

    /// 電池が少ないか（前回止めていれば、値 + 5% まで戻るまで少ないまま）。
    static func isBatteryLow(_ b: Battery, threshold: Int, wasLow: Bool) -> Bool {
        guard b.hasBattery, !b.onAC else { return false }
        return wasLow ? b.percent < threshold + hysteresis : b.percent <= threshold
    }

    static func decide(_ input: Input) -> Decision {
        var d = Decision()
        var manual = input.manual
        // 時間が来た手動は終える
        if let m = manual, let until = m.until, input.now >= until {
            manual = nil
            d.clearManual = true
            d.manualExpired = true
        }
        // 自動の理由
        var autoReasons: [String] = []
        let a = input.auto, c = input.conditions
        if a.call, let call = c.call { autoReasons.append(call) }
        if a.watch, c.watchPlaying { autoReasons.append("📺 の再生") }
        if a.apps { autoReasons += c.runningApps.map { "\($0) が動いている" } }
        if a.power, input.battery.onAC { autoReasons.append("電源につながっている") }
        if a.display, c.externalDisplay { autoReasons.append("外部ディスプレイ") }
        let wants = manual != nil || !autoReasons.isEmpty
        // 電池
        d.batteryLow = isBatteryLow(input.battery, threshold: input.threshold, wasLow: input.batteryLow)
        if d.batteryLow {
            if manual != nil { d.clearManual = true }
            d.stoppedByBattery = !input.batteryLow && wants
            return d
        }
        guard wants else { return d }
        if let manual { d.reasons.append(manualLabel(manual, timeZone: input.timeZone)) }
        d.reasons += autoReasons
        d.holdSystem = true
        d.holdDisplay = input.keepDisplay
        return d
    }

    /// ツールチップ・アクセシビリティの説明（「スリープさせない（15:30 まで・🍻 の音声）」）。入っていなければ nil。
    static func summary(_ d: Decision) -> String? {
        guard d.holdSystem else { return nil }
        return "スリープさせない（\(d.reasons.joined(separator: "・"))）\(d.holdDisplay ? "・画面も" : "")"
    }

    /// 手動の長さの文字（メニュー）。
    static func durationLabel(_ minutes: Int?) -> String {
        guard let m = minutes else { return "切るまで" }
        return m < 60 ? "\(m) 分" : "\(m / 60) 時間"
    }
}
