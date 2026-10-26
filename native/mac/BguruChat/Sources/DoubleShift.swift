import AppKit
import Carbon.HIToolbox

/// 右 ⇧ の 2 回押しの判定だけ（時刻を外から渡す。AppKit に触らないので単体で試せる）。
/// 1 回 =「右 ⇧ を押して、ほかのキー・修飾キーなしで、すぐ離す」。1 回目を離してから `interval` 以内に 2 回目を押し、
/// それもすぐ離したら成立（2 回目を離したときに true）。長押し・あいだにほかのキー・左 ⇧・⌘ など・クリックは数え直し。
struct DoubleTapDetector {
    enum Input: Equatable {
        /// 右 ⇧ を押した（`alone`: ほかの修飾キーが押されていない）。
        case rightShiftDown(alone: Bool)
        case rightShiftUp
        /// それ以外のキー・修飾キー（左 ⇧ も）・クリック。
        case other
    }

    /// 1 回目を離してから 2 回目を押すまで。
    var interval: TimeInterval = 0.35
    /// 1 回の押している長さの上限（これより長いと長押し＝数えない）。
    var maxHold: TimeInterval = 0.35

    private enum State {
        case idle
        case firstDown(at: TimeInterval)
        case firstUp(at: TimeInterval)
        case secondDown(at: TimeInterval)
    }
    private var state: State = .idle

    /// 2 回押しが成立したら true（そのあとは最初から数え直す）。
    mutating func handle(_ input: Input, at t: TimeInterval) -> Bool {
        switch (input, state) {
        case (.other, _):
            state = .idle
        case (.rightShiftDown(let alone), .firstUp(let up)):
            state = alone && t - up <= interval ? .secondDown(at: t) : (alone ? .firstDown(at: t) : .idle)
        case (.rightShiftDown(let alone), _):
            state = alone ? .firstDown(at: t) : .idle
        case (.rightShiftUp, .firstDown(let down)):
            state = t - down <= maxHold ? .firstUp(at: t) : .idle
        case (.rightShiftUp, .secondDown(let down)):
            state = .idle
            return t - down <= maxHold
        case (.rightShiftUp, _):
            state = .idle
        }
        return false
    }
}

/// 右 ⇧ を素早く 2 回押すとパネルを開閉する（設定、既定はオン）。
/// アプリが前のとき（パネルにキー入力があるとき）は許可なしで効く。ほかのアプリが前のときは NSEvent のグローバル監視で、
/// macOS の「入力監視」（またはアクセシビリティ）の許可が要る（キー系のイベントは許可がないと届かない）。
/// パスワード欄などで Secure Input が入っているあいだは何もしない。
@MainActor
final class RightShiftDoubleTap {
    /// 右 ⇧ の keyCode（左は 56）。
    private static let rightShiftKeyCode: UInt16 = 60
    /// NX_DEVICERSHIFTKEYMASK（modifierFlags の機種依存の下位ビット：右 ⇧ が押されている）。
    private static let rightShiftDeviceMask: UInt = 0x04

    private let action: () -> Void
    private var detector = DoubleTapDetector()
    private var localMonitor: Any?
    private var globalMonitor: Any?
    /// 許可がまだのあいだ、許可されたらグローバル監視を付け直すための見回り。
    private var permissionTimer: Timer?
    /// アプリの中で成立したとき（許可がまだなら、ほかのアプリでも使うための案内を 1 回だけ出す）。
    var onLocalTrigger: (() -> Void)?

    var enabled = false {
        didSet { guard enabled != oldValue else { return }; enabled ? start() : stop() }
    }

    init(action: @escaping () -> Void) { self.action = action }

    /// ほかのアプリが前のときも届くか（入力監視かアクセシビリティの許可）。
    static var canMonitorGlobally: Bool { CGPreflightListenEventAccess() || AXIsProcessTrusted() }

    /// 入力監視の許可を求める（初回は macOS の確認が出て、システム設定の一覧に載る）。
    static func requestGlobalAccess() {
        if !CGRequestListenEventAccess() {
            NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent")!)
        }
    }

    private static let watched: NSEvent.EventTypeMask = [.flagsChanged, .keyDown, .leftMouseDown, .rightMouseDown, .otherMouseDown]

    private func start() {
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: Self.watched) { [weak self] e in
            MainActor.assumeIsolated { self?.handle(e, local: true) }
            return e
        }
        installGlobal()
        if !Self.canMonitorGlobally {
            permissionTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, Self.canMonitorGlobally else { return }
                    self.permissionTimer?.invalidate(); self.permissionTimer = nil
                    self.installGlobal() // 許可前に付けた監視には届かないことがあるので付け直す
                }
            }
        }
    }

    private func installGlobal() {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: Self.watched) { [weak self] e in
            MainActor.assumeIsolated { self?.handle(e, local: false) }
        }
    }

    private func stop() {
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        localMonitor = nil; globalMonitor = nil
        permissionTimer?.invalidate(); permissionTimer = nil
        detector = DoubleTapDetector()
    }

    private func handle(_ e: NSEvent, local: Bool) {
        // パスワード入力中など：キー入力を覗かない約束なので、数えもしない。
        if IsSecureEventInputEnabled() { detector = DoubleTapDetector(); return }
        let input: DoubleTapDetector.Input
        if e.type == .flagsChanged && e.keyCode == Self.rightShiftKeyCode {
            if e.modifierFlags.rawValue & Self.rightShiftDeviceMask != 0 {
                let others: NSEvent.ModifierFlags = [.command, .option, .control, .function, .capsLock]
                // 左 ⇧ も押したままなら ⇧ 以外のビットは無くても「ひとりで」ではない（機種依存ビット 0x02 = 左 ⇧）。
                let alone = e.modifierFlags.intersection(others).isEmpty && e.modifierFlags.rawValue & 0x02 == 0
                input = .rightShiftDown(alone: alone)
            } else {
                input = .rightShiftUp
            }
        } else {
            input = .other
        }
        if detector.handle(input, at: e.timestamp) {
            action()
            if local { onLocalTrigger?() }
        }
    }
}

#if DEBUG
extension DoubleTapDetector {
    /// 開発のみ（-doubleShiftSelfTest）：判定の単体テスト。失敗があれば false。
    static func selfTest() -> Bool {
        var ok = true
        func run(_ name: String, _ steps: [(Input, TimeInterval)], fires want: [Bool]) {
            var d = DoubleTapDetector()
            let got = steps.map { d.handle($0.0, at: $0.1) }
            print("[double-shift-test] \(got == want ? "ok  " : "FAIL") \(name)\(got == want ? "" : " got=\(got)")")
            if got != want { ok = false }
        }
        let dn = Input.rightShiftDown(alone: true), up = Input.rightShiftUp
        run("素早く 2 回で成立", [(dn, 0), (up, 0.08), (dn, 0.25), (up, 0.32)], fires: [false, false, false, true])
        run("1 回だけでは何もしない", [(dn, 0), (up, 0.08)], fires: [false, false])
        run("間があきすぎ（0.35 秒より後）", [(dn, 0), (up, 0.08), (dn, 0.5), (up, 0.56)], fires: [false, false, false, false])
        run("間があきすぎた 2 回目を 1 回目として数え直す", [(dn, 0), (up, 0.08), (dn, 0.5), (up, 0.56), (dn, 0.7), (up, 0.76)],
            fires: [false, false, false, false, false, true])
        run("1 回目の長押しは数えない", [(dn, 0), (up, 0.6), (dn, 0.7), (up, 0.76)], fires: [false, false, false, false])
        run("2 回目の長押しは数えない", [(dn, 0), (up, 0.08), (dn, 0.2), (up, 0.9)], fires: [false, false, false, false])
        run("あいだにほかのキー（右 ⇧ で大文字を打った）", [(dn, 0), (.other, 0.05), (up, 0.1), (dn, 0.2), (up, 0.26)],
            fires: [false, false, false, false, false])
        run("離したあとほかのキー", [(dn, 0), (up, 0.08), (.other, 0.15), (dn, 0.2), (up, 0.26)], fires: [false, false, false, false, false])
        run("⌘ などと一緒の右 ⇧ は数えない", [(.rightShiftDown(alone: false), 0), (up, 0.08), (dn, 0.2), (up, 0.26)],
            fires: [false, false, false, false])
        run("2 回目が ⌘ と一緒", [(dn, 0), (up, 0.08), (.rightShiftDown(alone: false), 0.2), (up, 0.26)], fires: [false, false, false, false])
        run("3 回目は次の 1 回目", [(dn, 0), (up, 0.05), (dn, 0.15), (up, 0.2), (dn, 0.3), (up, 0.35)],
            fires: [false, false, false, true, false, false])
        run("4 回で 2 回成立", [(dn, 0), (up, 0.05), (dn, 0.15), (up, 0.2), (dn, 0.3), (up, 0.35), (dn, 0.45), (up, 0.5)],
            fires: [false, false, false, true, false, false, false, true])
        run("押していないのに離した（取りこぼし）は数え直し", [(up, 0), (dn, 0.1), (up, 0.15)], fires: [false, false, false])
        run("0.34 秒あいても成立", [(dn, 0), (up, 0.05), (dn, 0.39), (up, 0.45)], fires: [false, false, false, true])
        return ok
    }
}
#endif
