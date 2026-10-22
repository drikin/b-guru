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
        menuBarRunnerGPU = d.bool(forKey: "menuBarRunnerGPU")
        aiTimelinePicks = d.bool(forKey: "aiTimelinePicks")
    }

    func isQuietNow(_ date: Date = Date()) -> Bool {
        guard quietHours else { return false }
        let h = Calendar.current.component(.hour, from: date)
        return h >= Self.quietStartHour && h < Self.quietEndHour
    }
}
