import AppKit
import IOKit.ps
import IOKit.pwr_mgt
import Observation
import UserNotifications

/// ☕ スリープさせない（docs/mac-keep-awake-spec.md）。決め方は KeepAwakeLogic、ここは様子を集めて assertion を持つ・外すだけ。
///
/// - 持つのは「放っておいたときのスリープ」を止める assertion だけ（PreventUserIdleSystemSleep、画面も消さないときは
///   PreventUserIdleDisplaySleep）。ふたを閉じる・スリープを選ぶ・電源ボタンでは普通に眠る。サンドボックスのまま、追加の許可なし。
/// - 様子が変わったときだけ決め直す（定期的には起きない）: 設定と 🍻・通話・📺 は Observation、電池は IOPS の知らせ、
///   アプリは NSWorkspace の起動・終了、画面は画面の構成の変更、手動の終わりはその時刻のタイマー。
/// - 手動は覚えない（アプリを終了したら必ず止める。次に起動しても入らない）。設定は手元だけ（UserDefaults）。
@MainActor
@Observable
final class KeepAwake {
    static let shared = KeepAwake()

    /// 手動（nil = 入れていない）。
    private(set) var manual: KeepAwakeLogic.Manual?
    /// 最後に決めた結果。
    private(set) var decision = KeepAwakeLogic.Decision()
    /// いま動いているアプリ（⋯ の設定で選ぶ。Dock に出る普通のアプリだけ、名前順）。
    private(set) var runningApps: [(id: String, name: String)] = []
    /// 電池の無い Mac では電池の設定を出さない。
    private(set) var hasBattery = false

    /// 入っているか・理由が変わった（ビーグルの印・説明を描き直す）。
    @ObservationIgnored var onChange: (() -> Void)?
    /// 🍻・通話・📺 の様子を見るチャット（ログインしていなければ nil）。
    @ObservationIgnored var store: ChatStore? {
        didSet { if store !== oldValue { observe(); update() } }
    }

    @ObservationIgnored private let settings = AppSettings.shared
    @ObservationIgnored private var systemAssertion: IOPMAssertionID?
    @ObservationIgnored private var displayAssertion: IOPMAssertionID?
    @ObservationIgnored private var assertionDetails = ""
    @ObservationIgnored private var endTimer: Timer?
    @ObservationIgnored private var powerSource: CFRunLoopSource?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []
    @ObservationIgnored private var observeGen = 0
    @ObservationIgnored private var started = false

    var isActive: Bool { decision.holdSystem }
    var summary: String? { KeepAwakeLogic.summary(decision) }

    private init() {}

    /// 見張りを始める（アプリの起動時に 1 回）。
    func start() {
        guard !started else { return }
        started = true
        // 電池・電源の変化（残りの % が変わったときも来る）。登録した run loop（メイン）で呼ばれる。
        if let src = IOPSNotificationCreateRunLoopSource({ _ in
            MainActor.assumeIsolated { KeepAwake.shared.update() }
        }, nil)?.takeRetainedValue() {
            CFRunLoopAddSource(CFRunLoopGetMain(), src, .defaultMode)
            powerSource = src
        }
        let ws = NSWorkspace.shared.notificationCenter
        for n in [NSWorkspace.didLaunchApplicationNotification, NSWorkspace.didTerminateApplicationNotification] {
            observers.append(ws.addObserver(forName: n, object: nil, queue: .main) { _ in
                MainActor.assumeIsolated { KeepAwake.shared.appsChanged() }
            })
        }
        observers.append(NotificationCenter.default.addObserver(forName: NSApplication.didChangeScreenParametersNotification,
                                                                object: nil, queue: .main) { _ in
            MainActor.assumeIsolated { KeepAwake.shared.update() }
        })
        refreshRunningApps()
        observe()
        update()
    }

    // MARK: - 手動

    /// 手動で入れる（minutes: nil = 切るまで）。
    func startManual(minutes: Int?) {
        manual = KeepAwakeLogic.Manual(until: minutes.map { Date().addingTimeInterval(TimeInterval($0) * 60) })
        StatusBarDiag.note("スリープさせない: 手動 \(KeepAwakeLogic.durationLabel(minutes))")
        update()
    }

    /// 手動を止める（自動の条件が当てはまっていれば、そちらで入ったまま）。
    func stopManual() {
        guard manual != nil else { return }
        manual = nil
        StatusBarDiag.note("スリープさせない: 手動を止めた")
        update()
    }

    /// アプリの終了：必ず外す。
    func shutdown() {
        endTimer?.invalidate()
        endTimer = nil
        manual = nil
        setAssertion(&systemAssertion, type: "PreventUserIdleSystemSleep", on: false, name: "")
        setAssertion(&displayAssertion, type: "PreventUserIdleDisplaySleep", on: false, name: "")
    }

    // MARK: - 決め直す

    func update() {
        guard started else { return }
        var input = KeepAwakeLogic.Input()
        input.manual = manual
        input.keepDisplay = settings.keepAwakeDisplay
        input.auto = KeepAwakeLogic.AutoFlags(call: settings.keepAwakeAutoCall, watch: settings.keepAwakeAutoWatch,
                                              apps: settings.keepAwakeAutoApps, power: settings.keepAwakeAutoPower,
                                              display: settings.keepAwakeAutoDisplay)
        input.conditions = conditions()
        input.battery = Self.battery()
        input.threshold = settings.keepAwakeBatteryThreshold
        input.batteryLow = decision.batteryLow
        hasBattery = input.battery.hasBattery
        let d = KeepAwakeLogic.decide(input)
        if d.clearManual { manual = nil }
        if d.manualExpired { notify("スリープさせない を終えました", id: "keepawake-end") }
        if d.stoppedByBattery {
            notify("電池が少ないので、普通のスリープに戻しました", id: "keepawake-battery")
            StatusBarDiag.note("スリープさせない: 電池 \(input.battery.percent)% で止めた")
        }
        apply(d)
        scheduleEnd()
        if d != decision {
            decision = d
            #if DEBUG
            NSLog("[keepawake] %@", KeepAwakeLogic.summary(d) ?? "入っていない\(d.batteryLow ? "（電池が少ない）" : "")")
            #endif
            onChange?()
        }
    }

    /// 自動の条件（いまの様子）。
    private func conditions() -> KeepAwakeLogic.Conditions {
        var c = KeepAwakeLogic.Conditions()
        if let store {
            if store.offkai.audio != .off {
                c.call = "🍻 の音声"
            } else if store.voice.inRoom {
                c.call = store.room.mode == .room ? "部室の音声" : "ボイスルーム"
            }
            c.watchPlaying = store.watch.playing
        }
        if settings.keepAwakeAutoApps, !settings.keepAwakeApps.isEmpty {
            let chosen = Set(settings.keepAwakeApps)
            var seen = Set<String>()
            for app in NSWorkspace.shared.runningApplications {
                guard let id = app.bundleIdentifier, chosen.contains(id), seen.insert(id).inserted else { continue }
                c.runningApps.append(app.localizedName ?? id)
            }
            c.runningApps.sort()
        }
        if settings.keepAwakeAutoDisplay {
            c.externalDisplay = NSScreen.screens.contains { s in
                guard let n = s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber else { return false }
                return CGDisplayIsBuiltin(CGDirectDisplayID(n.uint32Value)) == 0
            }
        }
        return c
    }

    /// 設定と 🍻・通話・📺 の様子を見る（変わったら決め直す。古い見張りは世代で無視する）。
    private func observe() {
        observeGen += 1
        let gen = observeGen
        let store = self.store
        withObservationTracking {
            _ = settings.keepAwakeDisplay
            _ = settings.keepAwakeAutoCall
            _ = settings.keepAwakeAutoWatch
            _ = settings.keepAwakeAutoApps
            _ = settings.keepAwakeApps
            _ = settings.keepAwakeAutoPower
            _ = settings.keepAwakeAutoDisplay
            _ = settings.keepAwakeBatteryThreshold
            if let store {
                _ = store.offkai.audio
                _ = store.voice.phase
                _ = store.room.mode
                _ = store.watch.playing
            }
        } onChange: {
            Task { @MainActor in
                let k = KeepAwake.shared
                guard gen == k.observeGen else { return }
                k.observe()
                k.update()
            }
        }
    }

    private func appsChanged() {
        refreshRunningApps()
        if settings.keepAwakeAutoApps { update() }
    }

    private func refreshRunningApps() {
        let own = Bundle.main.bundleIdentifier
        var list: [(id: String, name: String)] = []
        var seen = Set<String>()
        for app in NSWorkspace.shared.runningApplications where app.activationPolicy == .regular {
            guard let id = app.bundleIdentifier, id != own, seen.insert(id).inserted else { continue }
            list.append((id, app.localizedName ?? id))
        }
        list.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
        if list.map(\.id) != runningApps.map(\.id) { runningApps = list }
    }

    /// 選んだアプリの名前（動いていなければ bundle id から探す）。
    func appName(_ id: String) -> String {
        if let n = runningApps.first(where: { $0.id == id })?.name { return n }
        if let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: id) {
            return FileManager.default.displayName(atPath: url.path).replacingOccurrences(of: ".app", with: "")
        }
        return id
    }

    func toggleApp(_ id: String) {
        if let i = settings.keepAwakeApps.firstIndex(of: id) {
            settings.keepAwakeApps.remove(at: i)
        } else {
            settings.keepAwakeApps.append(id)
            settings.keepAwakeAutoApps = true // 選んだら自動もオンに（選んだのに効かない、を避ける）
        }
    }

    // MARK: - assertion

    /// 名前は ASCII だけ（pmset -g assertions は日本語の名前を "" と出す。2026-10-26 実機）。理由（日本語）は Details に入れる。
    private func apply(_ d: KeepAwakeLogic.Decision) {
        let details = d.reasons.joined(separator: "・")
        setAssertion(&systemAssertion, type: "PreventUserIdleSystemSleep", on: d.holdSystem,
                     name: "B-guru Chat: prevent idle sleep", details: details)
        setAssertion(&displayAssertion, type: "PreventUserIdleDisplaySleep", on: d.holdSystem && d.holdDisplay,
                     name: "B-guru Chat: prevent display sleep", details: details)
        assertionDetails = details
    }

    private func setAssertion(_ id: inout IOPMAssertionID?, type: String, on: Bool, name: String, details: String = "") {
        if on {
            if let current = id {
                // 理由が変わったら Details だけ替える
                if details != assertionDetails { IOPMAssertionSetProperty(current, kIOPMAssertionDetailsKey as CFString, details as CFString) }
                return
            }
            var newId = IOPMAssertionID(0)
            let r = IOPMAssertionCreateWithName(type as CFString, IOPMAssertionLevel(kIOPMAssertionLevelOn), name as CFString, &newId)
            if r == kIOReturnSuccess {
                id = newId
                IOPMAssertionSetProperty(newId, kIOPMAssertionDetailsKey as CFString, details as CFString)
            } else {
                StatusBarDiag.note("スリープさせない: assertion を作れなかった（\(type) \(r)）")
            }
        } else if let current = id {
            IOPMAssertionRelease(current)
            id = nil
        }
    }

    /// 手動の終わりの時刻に 1 回だけ起きる。
    private func scheduleEnd() {
        let until = manual?.until
        if let t = endTimer, t.isValid, t.fireDate == until { return }
        endTimer?.invalidate()
        endTimer = nil
        guard let until else { return }
        let t = Timer(fire: until, interval: 0, repeats: false) { _ in
            MainActor.assumeIsolated { KeepAwake.shared.update() }
        }
        t.tolerance = 1
        RunLoop.main.add(t, forMode: .common)
        endTimer = t
    }

    // MARK: - 電池

    /// 電池の様子（IOPSCopyPowerSourcesInfo）。内蔵の電池が無ければデスクトップ扱い。
    static func battery() -> KeepAwakeLogic.Battery {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return .desktop }
        let providing = IOPSGetProvidingPowerSourceType(info)?.takeUnretainedValue() as String?
        for ps in list {
            guard let d = IOPSGetPowerSourceDescription(info, ps)?.takeUnretainedValue() as? [String: Any],
                  d[kIOPSTypeKey] as? String == kIOPSInternalBatteryType,
                  d[kIOPSIsPresentKey] as? Bool ?? true else { continue }
            let cur = (d[kIOPSCurrentCapacityKey] as? NSNumber)?.doubleValue ?? 0
            let max = (d[kIOPSMaxCapacityKey] as? NSNumber)?.doubleValue ?? 100
            let percent = max > 0 ? Int((cur / max * 100).rounded()) : 100
            let onAC = (d[kIOPSPowerSourceStateKey] as? String).map { $0 == kIOPSACPowerValue } ?? (providing == kIOPSACPowerValue)
            return KeepAwakeLogic.Battery(hasBattery: true, onAC: onAC, percent: percent)
        }
        return .desktop
    }

    // MARK: - 知らせ

    private func notify(_ body: String, id: String) {
        let content = UNMutableNotificationContent()
        content.title = "☕ スリープさせない"
        content.body = body
        content.threadIdentifier = "keepawake"
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: content, trigger: nil))
    }
}
