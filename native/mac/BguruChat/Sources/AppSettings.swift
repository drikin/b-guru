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
    /// 試験的：ほかのステータスバーアイコンを畳む（ビーグルを ⌥＋クリック／3 本指タップで出し入れ）。既定は切。
    var collapseStatusItems: Bool {
        didSet {
            guard collapseStatusItems != oldValue else { return }
            UserDefaults.standard.set(collapseStatusItems, forKey: "collapseOtherStatusItems")
            onCollapseChange?(collapseStatusItems)
        }
    }
    @ObservationIgnored var onCollapseChange: ((Bool) -> Void)?

    static let quietStartHour = 0
    static let quietEndHour = 7

    private init() {
        let d = UserDefaults.standard
        notifyMode = NotifyMode(rawValue: d.string(forKey: "notifyMode") ?? "") ?? .all
        quietHours = d.object(forKey: "quietHours") as? Bool ?? true
        showInDock = d.bool(forKey: "showInDock")
        notifyTimeline = d.bool(forKey: "notifyTimeline")
        collapseStatusItems = d.bool(forKey: "collapseOtherStatusItems")
    }

    func isQuietNow(_ date: Date = Date()) -> Bool {
        guard quietHours else { return false }
        let h = Calendar.current.component(.hour, from: date)
        return h >= Self.quietStartHour && h < Self.quietEndHour
    }
}
