import AppKit

/// 画面の隅でパネルを開閉する（決め方は HotCornerLogic）。設定で隅を選んだときだけ見張る（既定は使わない）。
/// - マウスの移動の知らせ（ほかのアプリが前でも。マウスは入力監視の許可がいらない）で、隅に入ったかだけを見る。
///   止まっているあいだは何も動かない（定期的には起きない）。
/// - 隅で HotCornerLogic.dwell 秒止まったら開閉（隅の近くにいるあいだだけ 0.1 秒ごとに位置を見る）。ボタンを押している（ドラッグ）・前のアプリがフルスクリーンのときは開かない。
/// - 開いたら隅を出るまで次は開かない。
@MainActor
final class HotCorner {
    private let action: () -> Void
    private var monitors: [Any] = []
    private var dwellTimer: Timer?
    private var armed = true

    var corner: HotCornerLogic.Corner = .off {
        didSet { if corner != oldValue { restart() } }
    }

    init(action: @escaping () -> Void) {
        self.action = action
    }

    private func restart() {
        stop()
        guard corner != .off else { return }
        armed = true
        if let g = NSEvent.addGlobalMonitorForEvents(matching: .mouseMoved, handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.moved() }
        }) { monitors.append(g) }
        if let l = NSEvent.addLocalMonitorForEvents(matching: .mouseMoved, handler: { [weak self] e in
            MainActor.assumeIsolated { self?.moved() }
            return e
        }) { monitors.append(l) }
        // 隅でクリックした（左上のアップルメニュー・隠したメニューバーを出すなど）ときは開かない。隅を出るまで次も開かない。
        let downs: NSEvent.EventTypeMask = [.leftMouseDown, .rightMouseDown, .otherMouseDown]
        if let g = NSEvent.addGlobalMonitorForEvents(matching: downs, handler: { [weak self] _ in
            MainActor.assumeIsolated { self?.pressed() }
        }) { monitors.append(g) }
        if let l = NSEvent.addLocalMonitorForEvents(matching: downs, handler: { [weak self] e in
            MainActor.assumeIsolated { self?.pressed() }
            return e
        }) { monitors.append(l) }
    }

    private func pressed() {
        guard HotCornerLogic.screenIndex(at: NSEvent.mouseLocation, corner: corner, screens: screens, within: HotCornerLogic.leave) != nil
        else { return }
        stopWatching()
        armed = false
    }

    private func stop() {
        monitors.forEach(NSEvent.removeMonitor)
        monitors = []
        dwellTimer?.invalidate()
        dwellTimer = nil
    }

    private var screens: [CGRect] { NSScreen.screens.map(\.frame) }

    /// 隅の近く（HotCornerLogic.leave 以内）に来たら、移動の知らせだけに頼らず実際の位置を 0.1 秒ごとに確かめる
    /// （隅へ押し付けた最後の移動の知らせが届かないことがある。実機で確認）。近くを離れたら止める。
    private func moved() {
        let p = NSEvent.mouseLocation
        if !armed {
            if HotCornerLogic.hasLeft(p, corner: corner, screens: screens) { armed = true }
            return
        }
        if HotCornerLogic.hasLeft(p, corner: corner, screens: screens) {
            stopWatching()
        } else if dwellTimer == nil {
            enteredAt = nil
            let t = Timer(timeInterval: 0.1, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.tick() }
            }
            t.tolerance = 0.02
            RunLoop.main.add(t, forMode: .common)
            dwellTimer = t
            tick()
        }
    }

    /// 隅にいはじめた時刻（近くにいるあいだだけ使う）。
    private var enteredAt: Date?

    private func stopWatching() {
        dwellTimer?.invalidate()
        dwellTimer = nil
        enteredAt = nil
    }

    private func tick() {
        let p = NSEvent.mouseLocation
        guard armed, !HotCornerLogic.hasLeft(p, corner: corner, screens: screens) else { stopWatching(); return }
        guard let i = HotCornerLogic.screenIndex(at: p, corner: corner, screens: screens),
              NSEvent.pressedMouseButtons == 0 else { enteredAt = nil; return }
        guard let since = enteredAt else { enteredAt = Date(); return }
        guard Date().timeIntervalSince(since) >= HotCornerLogic.dwell else { return }
        stopWatching()
        armed = false
        if Self.frontmostIsFullScreen(on: NSScreen.screens[i]) {
            StatusBarDiag.note("画面の隅: フルスクリーンなので開かない")
            return
        }
        StatusBarDiag.note("画面の隅（\(corner.label)）でパネルを開閉")
        action()
    }

    /// 前のアプリ（自分以外）が、その画面いっぱいの窓を出しているか（フルスクリーンの動画・ゲーム・発表）。
    /// 窓の位置・大きさと持ち主だけを見る（名前は読まないので、画面収録の許可はいらない）。ノッチのある画面では、
    /// フルスクリーンの窓がカメラの下から始まることがあるので、上はノッチの分だけ低くてもよい。
    private static func frontmostIsFullScreen(on screen: NSScreen) -> Bool {
        guard let app = NSWorkspace.shared.frontmostApplication, app.processIdentifier != getpid(),
              let num = screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber,
              let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]
        else { return false }
        let display = CGDisplayBounds(CGDirectDisplayID(num.uint32Value)) // 窓と同じ座標（左上が原点）
        let notch = screen.safeAreaInsets.top
        return list.contains { w in
            guard (w[kCGWindowOwnerPID as String] as? pid_t) == app.processIdentifier,
                  (w[kCGWindowLayer as String] as? Int) == 0,
                  let d = w[kCGWindowBounds as String] as? NSDictionary,
                  let b = CGRect(dictionaryRepresentation: d) else { return false }
            return abs(b.minX - display.minX) < 1 && abs(b.width - display.width) < 1
                && abs(b.maxY - display.maxY) < 1 && b.height >= display.height - notch - 1
        }
    }
}
