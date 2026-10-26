import Foundation
import Observation

/// User preferences (UserDefaults). Changed from the panel's ⋯ menu.
@MainActor
@Observable
final class AppSettings {
    static let shared = AppSettings()

    enum NotifyMode: String, CaseIterable, Identifiable {
        case all, mentions
        var id: String { rawValue }
        var label: String {
            switch self {
            case .all: return "新着すべて（まとめて通知）"
            case .mentions: return "自分へのメンションだけ"
            }
        }
    }

    var notifyMode: NotifyMode {
        didSet { UserDefaults.standard.set(notifyMode.rawValue, forKey: "notifyMode") }
    }
    /// 0:00–7:00 (local): new-message notifications are held, mentions arrive silently.
    var quietHours: Bool {
        didSet { UserDefaults.standard.set(quietHours, forKey: "quietHours") }
    }
    /// Also notify new timeline posts (comments not included). Off until turned on.
    var notifyTimeline: Bool {
        didSet { UserDefaults.standard.set(notifyTimeline, forKey: "notifyTimeline") }
    }
    /// Show the app in the Dock too, with an unread badge on its icon.
    var showInDock: Bool {
        didSet {
            UserDefaults.standard.set(showInDock, forKey: "showInDock")
            onDockChange?(showInDock)
        }
    }
    @ObservationIgnored var onDockChange: ((Bool) -> Void)?
    /// 試験的：ほかのステータスバーアイコンを畳む（ビーグルを ⌥＋クリック、または区切りのクリックで出し入れ）。既定は切。
    var collapseStatusItems: Bool {
        didSet {
            guard collapseStatusItems != oldValue else { return }
            UserDefaults.standard.set(collapseStatusItems, forKey: "collapseOtherStatusItems")
            onCollapseChange?(collapseStatusItems)
        }
    }
    @ObservationIgnored var onCollapseChange: ((Bool) -> Void)?
    /// 試験機能の中の設定：ビーグルにカーソルを乗せて少し止めたら出す。既定はオン。
    var collapseRevealOnHover: Bool {
        didSet {
            guard collapseRevealOnHover != oldValue else { return }
            UserDefaults.standard.set(collapseRevealOnHover, forKey: "collapseRevealOnHover")
            onCollapseHoverChange?(collapseRevealOnHover)
        }
    }
    @ObservationIgnored var onCollapseHoverChange: ((Bool) -> Void)?
    /// メニューバーにティッカーを流す（新着・メンション・ビーグルのお知らせをビーグルの左に 1 行ずつ）。既定は切。
    var menuBarTicker: Bool {
        didSet {
            guard menuBarTicker != oldValue else { return }
            UserDefaults.standard.set(menuBarTicker, forKey: "menuBarTicker")
            onTickerChange?()
        }
    }
    /// ティッカーに名前だけ出す（チャットの本文を出さない。配信中など）。
    var menuBarTickerNamesOnly: Bool {
        didSet {
            guard menuBarTickerNamesOnly != oldValue else { return }
            UserDefaults.standard.set(menuBarTickerNamesOnly, forKey: "menuBarTickerNamesOnly")
            onTickerChange?()
        }
    }
    @ObservationIgnored var onTickerChange: (() -> Void)?
    /// 新着・メンション・ビーグルのお知らせで、メニューバーのビーグルが吠える（絵が口を開け閉めする）。既定はオン。
    var menuBarBark: Bool {
        didSet {
            guard menuBarBark != oldValue else { return }
            UserDefaults.standard.set(menuBarBark, forKey: "menuBarBark")
            onBarkChange?(menuBarBark)
        }
    }
    @ObservationIgnored var onBarkChange: ((Bool) -> Void)?
    /// Mac の CPU・GPU の負荷に合わせて、メニューバーのビーグルが走る。既定は切。
    var menuBarRunner: Bool {
        didSet {
            guard menuBarRunner != oldValue else { return }
            UserDefaults.standard.set(menuBarRunner, forKey: "menuBarRunner")
            onRunnerChange?(menuBarRunner)
        }
    }
    @ObservationIgnored var onRunnerChange: ((Bool) -> Void)?
    /// 🔋 ビーグルで電池の残量を見せる（体の塗りが残量、⚡ 充電中、20% 以下でしょんぼり）。既定は切。電池の無い Mac では出さない。
    var menuBarBattery: Bool {
        didSet {
            guard menuBarBattery != oldValue else { return }
            UserDefaults.standard.set(menuBarBattery, forKey: "menuBarBattery")
            onBatteryChange?(menuBarBattery)
        }
    }
    @ObservationIgnored var onBatteryChange: ((Bool) -> Void)?
    /// アシスタント（試験的）：裏のウインドウの変化を端末内 AI が見て知らせる。既定は切。
    var assistant: Bool {
        didSet { guard assistant != oldValue else { return }; UserDefaults.standard.set(assistant, forKey: "assistant"); onAssistantChange?() }
    }
    var assistantAutoFront: Bool {
        didSet { guard assistantAutoFront != oldValue else { return }; UserDefaults.standard.set(assistantAutoFront, forKey: "assistantAutoFront"); onAssistantChange?() }
    }
    var assistantPaused: Bool {
        didSet { guard assistantPaused != oldValue else { return }; UserDefaults.standard.set(assistantPaused, forKey: "assistantPaused"); onAssistantChange?() }
    }
    var assistantInterest: String {
        didSet { guard assistantInterest != oldValue else { return }; UserDefaults.standard.set(assistantInterest, forKey: "assistantInterest"); onAssistantChange?() }
    }
    var assistantExcluded: [String] {
        didSet { guard assistantExcluded != oldValue else { return }; UserDefaults.standard.set(assistantExcluded, forKey: "assistantExcluded"); onAssistantChange?() }
    }
    @ObservationIgnored var onAssistantChange: (() -> Void)?
    /// 走る速さに GPU の負荷も使う（既定は切 = CPU だけ）。
    var menuBarRunnerGPU: Bool {
        didSet {
            guard menuBarRunnerGPU != oldValue else { return }
            UserDefaults.standard.set(menuBarRunnerGPU, forKey: "menuBarRunnerGPU")
            onRunnerChange?(menuBarRunner)
        }
    }
    /// 端末内 AI がタイムラインのおすすめをティッカーで教える（この Mac の中だけで動く）。既定は切。
    var aiTimelinePicks: Bool {
        didSet {
            guard aiTimelinePicks != oldValue else { return }
            UserDefaults.standard.set(aiTimelinePicks, forKey: "aiTimelinePicks")
            onAIPicksChange?(aiTimelinePicks)
        }
    }
    @ObservationIgnored var onAIPicksChange: ((Bool) -> Void)?
    /// 右 ⇧ を素早く 2 回押すとパネルを開閉する（ほかのアプリが前でも。それには入力監視の許可が要る）。既定はオン。
    var rightShiftDoubleTap: Bool {
        didSet {
            guard rightShiftDoubleTap != oldValue else { return }
            UserDefaults.standard.set(rightShiftDoubleTap, forKey: "rightShiftDoubleTap")
            onRightShiftChange?(rightShiftDoubleTap)
        }
    }
    @ObservationIgnored var onRightShiftChange: ((Bool) -> Void)?
    // ☕ スリープさせない（KeepAwake が Observation で見る。設定は手元だけ）。
    /// 入っているあいだ画面も消さない。既定は切。
    var keepAwakeDisplay: Bool {
        didSet { guard keepAwakeDisplay != oldValue else { return }; UserDefaults.standard.set(keepAwakeDisplay, forKey: "keepAwakeDisplay") }
    }
    /// 自動：🍻・ボイスルーム・部室の音声に入っているあいだ。既定はオン。
    var keepAwakeAutoCall: Bool {
        didSet { guard keepAwakeAutoCall != oldValue else { return }; UserDefaults.standard.set(keepAwakeAutoCall, forKey: "keepAwakeAutoCall") }
    }
    /// 自動：📺 を再生しているあいだ。既定はオン。
    var keepAwakeAutoWatch: Bool {
        didSet { guard keepAwakeAutoWatch != oldValue else { return }; UserDefaults.standard.set(keepAwakeAutoWatch, forKey: "keepAwakeAutoWatch") }
    }
    /// 自動：選んだアプリ（bundle id）が動いているあいだ。既定は切。
    var keepAwakeAutoApps: Bool {
        didSet { guard keepAwakeAutoApps != oldValue else { return }; UserDefaults.standard.set(keepAwakeAutoApps, forKey: "keepAwakeAutoApps") }
    }
    var keepAwakeApps: [String] {
        didSet { guard keepAwakeApps != oldValue else { return }; UserDefaults.standard.set(keepAwakeApps, forKey: "keepAwakeApps") }
    }
    /// 自動：電源につながっているあいだ。既定は切。
    var keepAwakeAutoPower: Bool {
        didSet { guard keepAwakeAutoPower != oldValue else { return }; UserDefaults.standard.set(keepAwakeAutoPower, forKey: "keepAwakeAutoPower") }
    }
    /// 自動：外部ディスプレイがあるあいだ。既定は切。
    var keepAwakeAutoDisplay: Bool {
        didSet { guard keepAwakeAutoDisplay != oldValue else { return }; UserDefaults.standard.set(keepAwakeAutoDisplay, forKey: "keepAwakeAutoDisplay") }
    }
    /// 電池で動いていて残りがこの値（%）以下になったら止める。既定は 20。
    var keepAwakeBatteryThreshold: Int {
        didSet { guard keepAwakeBatteryThreshold != oldValue else { return }; UserDefaults.standard.set(keepAwakeBatteryThreshold, forKey: "keepAwakeBatteryThreshold") }
    }

    static let quietStartHour = 0
    static let quietEndHour = 7

    private init() {
        let d = UserDefaults.standard
        notifyMode = NotifyMode(rawValue: d.string(forKey: "notifyMode") ?? "") ?? .all
        quietHours = d.object(forKey: "quietHours") as? Bool ?? true
        showInDock = d.bool(forKey: "showInDock")
        notifyTimeline = d.bool(forKey: "notifyTimeline")
        collapseStatusItems = d.bool(forKey: "collapseOtherStatusItems")
        collapseRevealOnHover = d.object(forKey: "collapseRevealOnHover") as? Bool ?? true
        menuBarTicker = d.bool(forKey: "menuBarTicker")
        menuBarTickerNamesOnly = d.bool(forKey: "menuBarTickerNamesOnly")
        menuBarBark = d.object(forKey: "menuBarBark") as? Bool ?? true
        menuBarRunner = d.bool(forKey: "menuBarRunner")
        menuBarBattery = d.bool(forKey: "menuBarBattery")
        assistant = d.bool(forKey: "assistant")
        assistantAutoFront = d.bool(forKey: "assistantAutoFront")
        assistantPaused = d.bool(forKey: "assistantPaused")
        assistantInterest = d.string(forKey: "assistantInterest") ?? Assistant.defaultInterest
        assistantExcluded = d.stringArray(forKey: "assistantExcluded") ?? Assistant.defaultExcluded
        menuBarRunnerGPU = d.bool(forKey: "menuBarRunnerGPU")
        aiTimelinePicks = d.bool(forKey: "aiTimelinePicks")
        rightShiftDoubleTap = d.object(forKey: "rightShiftDoubleTap") as? Bool ?? true
        keepAwakeDisplay = d.bool(forKey: "keepAwakeDisplay")
        keepAwakeAutoCall = d.object(forKey: "keepAwakeAutoCall") as? Bool ?? true
        keepAwakeAutoWatch = d.object(forKey: "keepAwakeAutoWatch") as? Bool ?? true
        keepAwakeAutoApps = d.bool(forKey: "keepAwakeAutoApps")
        keepAwakeApps = d.stringArray(forKey: "keepAwakeApps") ?? []
        keepAwakeAutoPower = d.bool(forKey: "keepAwakeAutoPower")
        keepAwakeAutoDisplay = d.bool(forKey: "keepAwakeAutoDisplay")
        keepAwakeBatteryThreshold = d.object(forKey: "keepAwakeBatteryThreshold") as? Int ?? KeepAwakeLogic.defaultThreshold
    }

    func isQuietNow(_ date: Date = Date()) -> Bool {
        guard quietHours else { return false }
        let h = Calendar.current.component(.hour, from: date)
        return h >= Self.quietStartHour && h < Self.quietEndHour
    }
}
