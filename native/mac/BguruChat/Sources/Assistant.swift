import AppKit
import Carbon.HIToolbox
import CoreGraphics
import Foundation
import Observation
import ScreenCaptureKit
import Vision
#if canImport(FoundationModels)
import FoundationModels
#endif

/// アシスタント（試験的、Mac だけ、既定は切、サーバーの capabilities `features.mac_assistant` が true のときだけ出す）：
/// 裏のアプリのウインドウを巡回して見張り、変化があれば端末内 AI が「知るべき変化か」を判断し、意味があればビーグルが吠えて知らせる。
///
/// - 見張るもの：画面に出ているふつうのアプリのウインドウすべて（ScreenCaptureKit。画面収録の許可が要る）。ほかのウインドウの後ろに
///   隠れているウインドウも読む（desktopIndependentWindow）。除くもの：前面のアプリ・B-guru 自身・システムの部品・小さすぎるウインドウ・
///   除外リストのアプリ・プライベートブラウズらしい題（`shouldWatch`、単体テストあり）。最小化・別のスペースのウインドウは撮れない。
/// - 巡回：1 ウインドウずつ小さく撮って前と比べ、全体をおよそ 4 秒（窓が 10 個を超えると窓の数 × 0.4 秒）で一巡。変化した窓は寄り道して
///   見直し、1 秒落ち着いたら窓全体を読み直して、前と今の行を回数つきで比べる。持つのは比べる用の小さい灰色と今見えている行だけ。
///   一巡した後に新しく出たウインドウ（ダイアログ・承認依頼など）は、全体を読んで判定に回す。大きさが変わったら判定せず基準を作り直す。
/// - 判断：Foundation Models（macOS 26+）。1 ウインドウ最短 10 秒に 1 回、全体で 1 時間に 120 回まで。
/// - オフ・一時停止・画面のロック・ユーザーの切り替え・スリープでは止まり、処理中の 1 件も知らせない（世代番号）。一時停止中は絵を捨てる。
/// - プライバシー：画像も文字も Mac の外に出さない。保存するのは「違う」の例（画面の文字の一部、1 件 60 字まで・最大 10 件）と件数だけ
///   （Application Support/Assistant、オフで消す）。statusbar.log・開発用の記録にほかのアプリの題や文字は書かない。
@MainActor
final class Assistant {
    static let shared = Assistant()

    struct Example: Codable { var app: String; var title: String; var summary: String; var at: Date }
    struct Memory: Codable {
        var wrong: [Example] = []
        var notified: [Date] = []
        var wrongAt: [Date] = []
        var rightAt: [Date] = []
    }
    struct Notice: Identifiable {
        let id = UUID()
        var app: String; var title: String; var summary: String; var reason: String
        var pid: pid_t; var bundleID: String; var bundleURL: URL?; var at = Date()
        /// AI ではなくアプリの決まり（強い手がかりの語・持ち主の名前）で知らせたもの。自動で前に出さず、理由は決まった文。
        var byRule = false
    }

    static let defaultInterest = "自分宛てのメッセージ、完了・エラー・承認待ちなど対応が必要なこと"
    nonisolated static let defaultExcluded = ["com.1password.1password", "com.agilebits.onepassword7", "com.bitwarden.desktop",
                                  "com.apple.keychainaccess", "com.apple.Passwords", "com.apple.systempreferences", "com.apple.SystemSettings"]
    nonisolated static let systemBundles: Set<String> = ["com.apple.dock", "com.apple.controlcenter", "com.apple.notificationcenterui", "com.apple.Spotlight",
                                             "com.apple.systemuiserver", "com.apple.WindowManager", "com.apple.loginwindow",
                                             "com.apple.screencaptureui", "com.apple.wallpaper", "com.apple.TextInputMenuAgent"]
    nonisolated static let privateTitleHints = ["プライベートブラウズ", "Private Browsing", "InPrivate", "Incognito", "シークレット", "プライベート ウインドウ"]
    /// 自動で前に出さないアプリ（ブラウザ：ページの文字で誘導されうる。知らせるだけ）。
    nonisolated static let browsers: Set<String> = ["com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.canary",
                                        "com.microsoft.edgemac", "company.thebrowser.Browser", "org.mozilla.firefox", "com.brave.Browser",
                                        "com.operasoftware.Opera", "com.vivaldi.Vivaldi", "app.zen-browser.zen"]
    /// 会議・画面共有のアプリ（前面なら共有中らしい）と配信のアプリ（起動していれば配信中らしい）。
    nonisolated static let meetingApps: Set<String> = ["us.zoom.xos", "com.microsoft.teams", "com.microsoft.teams2", "com.apple.ScreenSharing",
                                           "com.apple.FaceTime", "com.hnc.Discord", "com.tinyspeck.slackmacgap", "com.cisco.webexmeetingsapp"]
    nonisolated static let streamingApps: Set<String> = ["com.obsproject.obs-studio", "com.streamlabs.slobs", "com.ecamm.EcammLive", "com.ecamm.ecamm-live"]

    // 設定（App が入れる）
    var enabled = false { didSet { if enabled != oldValue { enabled ? start() : stop() } } }
    var paused = false { didSet { if paused && !oldValue { dropImages() } } }
    var autoFront = false
    var interest = defaultInterest
    var excluded: [String] = defaultExcluded
    var ownerNames: () -> [String] = { [NSFullUserName(), NSUserName()].filter { !$0.isEmpty } }
    var blockedReason: () -> String? = { nil }
    /// 知らせを届ける（App：パネルのヘッダー・ティッカー・静かな時間は保留）。
    var deliver: ((Notice) -> Void)?
    #if DEBUG
    var testOwnWindowsOnly = false
    #endif

    private(set) var memory = Memory()
    /// 最近の知らせ（「違う」「合ってた」を選べる、最大 5 件）。
    private(set) var recent: [Notice] = []
    private(set) var permissionMissing = false
    private var loop: Task<Void, Never>?
    private var runID = 0
    private var windows: [CGWindowID: WatchState] = [:]
    private var order: [CGWindowID] = []
    private var cursor = 0
    private var priorityTurn = false
    private var lastListAt = Date.distantPast
    private var firstCycleDone = false
    private var visitsSinceList = 0
    private var lastAutoFront = Date.distantPast
    private var sleeping = false
    private var observers: [NSObjectProtocol] = []
    /// 今の世代の間に見たウインドウ（絞り込む前の全部。前面のアプリ・最小化・別のスペースの窓も）。「新しい窓」はここに初めて出たものだけ。
    private var seenIDs: Set<CGWindowID> = []
    /// 止めた古いループ（すぐオンに戻したとき、その終わりを待つ）。
    private var oldLoop: Task<Void, Never>?
    private var lastStatusNote = Date.distantPast
    #if DEBUG
    var debugForceKind: String?
    #endif

    final class WatchState {
        var window: SCWindow
        var baseline: Gray?
        /// 今見えている行（窓全体を文字認識したもの）。変化のたびに窓全体を読み直して置き換える。
        var lines: [String]?
        /// 行を読んだときの小さい絵の大きさ（ロック解除などで小さい絵だけ撮り直すとき、大きさが同じなら行はそのまま使う）。
        var linesSize: (w: Int, h: Int)?
        /// AI を呼ぶ間隔を待つあいだに出た行（足し合わせて、明けたらまとめて判定する）。
        var heldAdded: [String] = []
        var lastReadAt = Date.distantPast
        var last: Gray?
        var pendingSince: Date?
        var changingSince: Date?
        var lastAI = Date.distantPast
        var lastVisit = Date.distantPast
        var isNew = false        // 一巡した後に新しく出たウインドウ
        var deferredNoted = false
        /// 判定（AI）を待っているところ。待つあいだも見回りは止めない（同じ窓の新しい行は保留に足す）。
        var judging = false
        init(_ w: SCWindow) { window = w }
    }

    /// 比べる用の小さい絵（灰色の画素の並び）。
    struct Gray: Sendable { var w: Int, h: Int, px: [UInt8] }

    static var directory: URL { HangWatch.directory.deletingLastPathComponent().appendingPathComponent("Assistant", isDirectory: true) }
    static var fileURL: URL { directory.appendingPathComponent("memory.json") }

    private init() {
        if let d = try? Data(contentsOf: Self.fileURL), let m = try? JSONDecoder().decode(Memory.self, from: d) { memory = m }
    }

    static func availability() -> (ok: Bool, reason: String?) {
        let ai = AIPicks.availability()
        return ai.ok ? (true, nil) : (false, ai.reason)
    }

    // MARK: - 開発用の記録（テスト用の窓を見ているときだけ。ほかのアプリの題・文字を OS のログに残さない）

    private func dlog(_ s: @autoclosure () -> String) {
        #if DEBUG
        if testOwnWindowsOnly { NSLog("[assistant] %@", s()) }
        #endif
    }

    // MARK: - 始める・止める

    private func start() {
        runID += 1
        let myRun = runID
        let old = loop ?? oldLoop // オフのすぐ後にオンにしても、古いループの終わりを待つ
        old?.cancel()
        seenIDs.removeAll()
        #if DEBUG
        let own = testOwnWindowsOnly
        #else
        let own = false
        #endif
        if !own {
            if !CGPreflightScreenCaptureAccess() {
                permissionMissing = true
                _ = CGRequestScreenCaptureAccess()
                StatusBarDiag.note("アシスタント: 画面収録の許可がまだ")
            } else {
                permissionMissing = false
            }
        }
        let ws = NSWorkspace.shared.notificationCenter
        let pause: [Notification.Name] = [NSWorkspace.willSleepNotification, NSWorkspace.screensDidSleepNotification, NSWorkspace.sessionDidResignActiveNotification]
        let resume: [Notification.Name] = [NSWorkspace.didWakeNotification, NSWorkspace.screensDidWakeNotification, NSWorkspace.sessionDidBecomeActiveNotification]
        for n in pause {
            observers.append(ws.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.sleeping = true }
            })
        }
        for n in resume {
            // 戻ったら小さい絵だけ撮り直す（行は残す。大きさが変わった窓だけ読み直す）
            observers.append(ws.addObserver(forName: n, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.sleeping = false; self?.rebaselineSmall() }
            })
        }
        // 画面のロック（共有の通知）
        let dnc = DistributedNotificationCenter.default()
        observers.append(dnc.addObserver(forName: Notification.Name("com.apple.screenIsLocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.sleeping = true }
        })
        observers.append(dnc.addObserver(forName: Notification.Name("com.apple.screenIsUnlocked"), object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.sleeping = false; self?.rebaselineSmall() }
        })
        observers.append(ws.addObserver(forName: NSWorkspace.didActivateApplicationNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.lastListAt = .distantPast }
        })
        StatusBarDiag.note(paused ? "アシスタント: オン（一時停止中）" : "アシスタント: 見張りを始めた")
        loop = Task { [weak self] in
            await old?.value // 古いループが終わるのを待つ
            await MainActor.run { if self?.oldLoop == old { self?.oldLoop = nil } }
            while !Task.isCancelled {
                guard let self, self.runID == myRun else { return }
                let wait = await self.tick(myRun)
                try? await Task.sleep(for: .seconds(wait))
            }
        }
    }

    private func stop() {
        runID += 1
        loop?.cancel()
        oldLoop = loop
        loop = nil
        for o in observers {
            NSWorkspace.shared.notificationCenter.removeObserver(o)
            DistributedNotificationCenter.default().removeObserver(o)
        }
        observers.removeAll()
        dropImages()
        order.removeAll()
        firstCycleDone = false
        StatusBarDiag.note("アシスタント: 見張りを止めた")
    }

    /// 小さい絵だけ撮り直す（行は残す）。ロック解除・スリープからの復帰。
    private func rebaselineSmall() {
        for st in windows.values {
            st.baseline = nil
            st.last = nil
            st.pendingSince = nil
            st.changingSince = nil
            st.isNew = false
        }
    }

    private func dropImages() {
        windows.removeAll()
        firstCycleDone = false
        visitsSinceList = 0
    }

    /// まだ続けてよいか（オフ・一時停止・止めた後の古い処理は知らせない）。
    private func alive(_ run: Int) -> Bool { enabled && !paused && !sleeping && !Task.isCancelled && runID == run }

    func eraseMemory() {
        memory = Memory()
        recent.removeAll()
        try? FileManager.default.removeItem(at: Self.directory)
    }

    private func save() {
        try? FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
        try? JSONEncoder().encode(memory).write(to: Self.fileURL, options: .atomic)
    }

    // MARK: - 絞り込み（純粋な関数、単体テストあり）

    struct Candidate {
        var bundleID: String; var appName: String; var pid: pid_t; var layer: Int
        var width: CGFloat; var height: CGFloat; var title: String; var onScreen: Bool
    }

    /// 見張るか：前面のアプリ・自分・システムの部品・除外リスト・プライベートの題・小さすぎる・画面にない・ふつうの層でない、は見張らない。
    nonisolated static func shouldWatch(_ c: Candidate, me: pid_t, front: pid_t?, excluded: [String]) -> Bool {
        guard c.onScreen, c.layer == 0, c.width >= 240, c.height >= 140 else { return false }
        if c.pid == me || c.pid == front { return false }
        if systemBundles.contains(c.bundleID) || excluded.contains(c.bundleID) || excluded.contains(c.appName) { return false }
        if privateTitleHints.contains(where: { c.title.localizedCaseInsensitiveContains($0) }) { return false }
        return true
    }

    // MARK: - 巡回

    private func tick(_ run: Int) async -> Double {
        guard alive(run) else { return 2 }
        if Date().timeIntervalSince(lastListAt) > 5 { await refreshList(run) }
        guard alive(run), !order.isEmpty else { return 2 }
        let now = Date()
        let id: CGWindowID
        priorityTurn.toggle()
        // 変化しかけの窓は、落ち着いたかを早めに見に行く。ただし点滅し続ける窓（3 秒以上変わり続け）は除き、
        // 寄り道は一巡の時間に数えない（ほかの窓の見回りが遅れないように）
        let candidates = order.filter { wid in
            guard let w = windows[wid], let p = w.pendingSince else { return false }
            if let c = w.changingSince, now.timeIntervalSince(c) > 3 { return false }
            return now.timeIntervalSince(p) >= 1.0 && now.timeIntervalSince(w.lastVisit) >= 0.5
        }
        if priorityTurn, let p = candidates.min(by: { (windows[$0]?.lastVisit ?? .distantPast) < (windows[$1]?.lastVisit ?? .distantPast) }) {
            if let st = windows[p] { await visit(st, run) }
            return 0.3
        } else {
            cursor = (cursor + 1) % order.count
            id = order[cursor]
            visitsSinceList += 1
            if visitsSinceList >= order.count { firstCycleDone = true }
        }
        if let st = windows[id] { await visit(st, run) }
        if Date().timeIntervalSince(lastStatusNote) > 600 {
            lastStatusNote = Date()
            StatusBarDiag.note("アシスタント: 見張り \(order.count) 個・この世代で見た窓 \(seenIDs.count) 個")
        }
        // 一巡をおよそ 4 秒に（窓が少なければ 1 回 1.5 秒、多ければ 0.4 秒まで縮め、それ以上の窓は一巡が伸びる）
        return min(1.5, max(0.4, 4.0 / Double(order.count)))
    }

    private func refreshList(_ run: Int) async {
        lastListAt = Date()
        #if DEBUG
        if testOwnWindowsOnly {
            var list: [SCWindow] = []
            var all: [SCWindow] = []
            if #available(macOS 14.4, *), let c = try? await SCShareableContent.currentProcess {
                all = c.windows
                list = c.windows.filter { ($0.title ?? "").hasPrefix("アシスタントのテスト") && $0.isOnScreen }
            }
            guard alive(run) else { return }
            apply(list, all: all)
            return
        }
        #endif
        guard CGPreflightScreenCaptureAccess() else { permissionMissing = true; apply([], all: []); return }
        permissionMissing = false
        // 画面に無い窓（最小化・別のスペース）も一覧に入れる：見張りはしないが「見たことがある」に数える
        guard let c = try? await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) else { apply([], all: []); return }
        guard alive(run) else { return }
        let front = NSWorkspace.shared.frontmostApplication?.processIdentifier
        let me = ProcessInfo.processInfo.processIdentifier
        let ex = excluded
        apply(all: c.windows, c.windows.filter { w in
            guard let app = w.owningApplication else { return false }
            return Self.shouldWatch(Candidate(bundleID: app.bundleIdentifier, appName: app.applicationName, pid: app.processID,
                                              layer: w.windowLayer, width: w.frame.width, height: w.frame.height,
                                              title: w.title ?? "", onScreen: w.isOnScreen), me: me, front: front, excluded: ex)
        })
    }

    private func apply(all: [SCWindow], _ list: [SCWindow]) { apply(list, all: all) }

    private func apply(_ list: [SCWindow], all: [SCWindow]) {
        var next: [CGWindowID: WatchState] = [:]
        for w in list where w.frame.width >= 1 {
            if let st = windows[w.windowID] {
                st.window = w
                next[w.windowID] = st
            } else {
                let st = WatchState(w)
                // 新しい窓：一巡した後に、この世代で初めて見た窓だけ（前面だった・最小化していた窓が戻っただけは除く）
                st.isNew = firstCycleDone && !seenIDs.contains(w.windowID)
                next[w.windowID] = st
            }
        }
        if next.count != windows.count { dlog("見張るウインドウ \(next.count) 個") }
        windows = next
        seenIDs.formUnion(all.map(\.windowID))
        seenIDs.formUnion(list.map(\.windowID))
        order = list.filter { $0.frame.width >= 1 }.map(\.windowID)
        if cursor >= order.count { cursor = 0 }
        visitsSinceList = 0
    }

    /// 窓全体を読む（今見えている行）。
    private func readWhole(_ st: WatchState, _ run: Int) async -> [String]? {
        // 幅 2048 画素まで（Retina で幅 1024pt までの窓はそのままの細かさ。それより広い窓だけ縮める）
        guard let full = await capture(st.window, maxWidth: 2048), alive(run) else { return nil }
        let lines = await Self.ocr(full, crop: CGRect(x: 0, y: 0, width: full.width, height: full.height))
        guard alive(run) else { return nil }
        return lines
    }

    /// 行ごとの回数の差（多重集合の差）で、前に無かった行（増えた行）だけを返す。読み取りのゆれは、そろえた形が一致するか
    /// 2 文字ずつの重なりが 7 割以上なら「同じ行」とみなして吸収する。
    nonisolated static func addedLines(before: [String], after: [String]) -> [String] {
        var pool = before.map { normalize($0) }
        var out: [String] = []
        for line in after {
            let n = normalize(line)
            if n.isEmpty { continue }
            if let i = pool.firstIndex(of: n) ?? pool.firstIndex(where: { sameLineWobble($0, n) }) {
                pool.remove(at: i)
            } else {
                out.append(line)
            }
        }
        return out
    }

    /// 読み取りのゆれとして同じ行とみなすか（そろえた形どうし）。完了・失敗などの手がかりの語の組が違えば、状態が切り替わったので別の行
    /// （「すべて成功しました（42件）」→「3件失敗しました（42件）」）。組が同じで 2 文字ずつの重なりが 7 割以上なら同じ行。
    nonisolated static func sameLineWobble(_ x: String, _ y: String) -> Bool {
        guard evidenceWords(x) == evidenceWords(y) else { return false }
        return bigramOverlap(x, y) >= 0.7
    }

    nonisolated static func bigramOverlap(_ x: String, _ y: String) -> Double {
        func grams(_ s: String) -> Set<String> {
            let c = Array(s)
            return c.count < 2 ? [s] : Set((0..<(c.count - 1)).map { String(c[$0...$0 + 1]) })
        }
        let g1 = grams(x), g2 = grams(y)
        return Double(g1.intersection(g2).count) / Double(max(1, g1.union(g2).count))
    }

    private func visit(_ st: WatchState, _ run: Int) async {
        st.lastVisit = Date()
        guard let shot = await capture(st.window, maxWidth: 192), alive(run) else { return }
        let small = await Self.toGray(shot)
        guard let small, alive(run) else { return }
        guard let base = st.baseline else {
            st.baseline = small
            // ロック解除・復帰で小さい絵だけ撮り直したとき：大きさが同じなら行はそのまま使う
            if st.lines != nil, let sz = st.linesSize, sz.w == small.w, sz.h == small.h, !st.isNew { return }
            // 基準を作る：窓全体を 1 回読む。新しく出た窓は、読んだ文字を判定へ
            let isNew = st.isNew
            st.isNew = false
            guard let lines = await readWhole(st, run) else { return }
            st.lines = lines
            st.linesSize = (small.w, small.h)
            if isNew { startJudge(st, lines, run: run, newWindow: true) }
            return
        }
        guard base.w == small.w, base.h == small.h else {
            // 大きさが変わった（画面の構成・Retina 間の移動など）：判定せず基準を作り直す
            st.baseline = small
            st.pendingSince = nil
            st.changingSince = nil
            if let lines = await readWhole(st, run) { st.lines = lines; st.linesSize = (small.w, small.h) }
            return
        }
        // 保留していた行があり、間隔が明けたら、まとめて判定する
        if !st.heldAdded.isEmpty, aiWaitReason(st) == nil, st.pendingSince == nil {
            let held = st.heldAdded
            st.heldAdded = []
            st.deferredNoted = false
            startJudge(st, held, run: run, newWindow: false)
            return
        }
        let d = Self.diff(base, small)
        if !d.significant {
            st.pendingSince = nil
            st.changingSince = nil
            st.last = small
            return
        }
        if st.pendingSince == nil {
            st.pendingSince = Date()
            st.last = small
            return
        }
        if let last = st.last, !Self.diff(last, small).significant, Date().timeIntervalSince(st.pendingSince ?? Date()) >= 1 {
            // 範囲は「変化が起きたか」の判定にだけ使う。読むときは窓全体を読み直し、前の全体の行と行ごとの回数の差で比べる
            _ = d
            let waiting = aiWaitReason(st)
            // 読むのは 1 窓 5 秒に 1 回まで（それより早い変化は、基準を変えずに次の機会に読む）
            if Date().timeIntervalSince(st.lastReadAt) < 5 { st.last = small; dlog("\(st.window.title ?? "") 読む間隔待ち"); return }
            st.pendingSince = nil
            st.changingSince = nil
            st.baseline = small
            st.lastReadAt = Date()
            guard let before = st.lines else {
                if let lines = await readWhole(st, run) { st.lines = lines; st.linesSize = (small.w, small.h) } // 前の行が無い：判定せず、次の変化から
                return
            }
            guard let lines = await readWhole(st, run) else { dlog("処理中の 1 件を捨てた（読んだ後）"); return }
            st.lines = lines // 持つのは今見えている行だけ
            st.linesSize = (small.w, small.h)
            // 新しく出た行を足し合わせる（AI の間隔待ちのあいだに出て消えた行も取りこぼさない）
            // 行どうしの照合（2 文字の組の比較）はメインスレッドの外で
            let newLines = await Task.detached(priority: .utility) { Self.addedLines(before: before, after: lines) }.value
            guard alive(run) else { return }
            for l in newLines where !st.heldAdded.contains(l) { st.heldAdded.append(l) }
            dlog("\(st.window.title ?? "") 読んだ（保留 \(st.heldAdded.count) 行、間隔待ち \(waiting ?? "なし")）")
            if st.heldAdded.count > 40 { st.heldAdded.removeFirst(st.heldAdded.count - 40) }
            if let waiting {
                if !st.deferredNoted { StatusBarDiag.note("アシスタント: \(st.window.owningApplication?.applicationName ?? "アプリ") 変化（\(waiting)、保留）") }
                st.deferredNoted = true
                return
            }
            st.deferredNoted = false
            let added = st.heldAdded
            st.heldAdded = []
            startJudge(st, added, run: run, newWindow: false)
        } else if let last = st.last, !Self.diff(last, small).significant {
            // 落ち着いているが、最初に気づいてからまだ 1 秒たっていない：待つだけ（気づいた時刻は戻さない）
            return
        } else {
            st.last = small
            if let first = st.changingSince, Date().timeIntervalSince(first) > 20 {
                st.baseline = small
                st.pendingSince = nil
                st.changingSince = nil
                return
            }
            if st.changingSince == nil { st.changingSince = st.pendingSince }
            st.pendingSince = Date()
        }
    }

    /// AI を呼べない理由（1 ウインドウ最短 10 秒に 1 回。待つ間の変化は保留に足して、明けたらまとめて判定する）。呼べるなら nil。
    /// 知らせの件数・頻度の上限は設けない（オーナー決定 2026-10-22：本当の変化なら何件でも知らせる。絞るのは精度だけ）。
    private func aiWaitReason(_ st: WatchState) -> String? {
        let now = Date()
        if st.judging { return "判定中" }
        if now.timeIntervalSince(st.lastAI) < 10 { return "10 秒待ち" }
        return nil
    }

    /// 判定を始める（待たない。AI の 1〜2 秒のあいだも、ほかの窓と同じ窓の見回りを続ける）。
    private func startJudge(_ st: WatchState, _ lines: [String], run: Int, newWindow: Bool) {
        st.judging = true
        Task { [weak self] in
            await self?.judgeLines(st, lines, run: run, newWindow: newWindow)
            st.judging = false
        }
    }

    private func judgeLines(_ st: WatchState, _ candidates: [String], run: Int, newWindow: Bool) async {
        let app = st.window.owningApplication?.applicationName ?? "アプリ"
        let title = st.window.title ?? ""
        let now = Date()
        // 新しい窓の判定のとき（ふつうの変化は呼ぶ前に確かめ済み）。判定中の印はこの判定自身のもの
        if Date().timeIntervalSince(st.lastAI) < 10 { return }
        let meaningfulLine: (String) -> Bool = { line in
            line.unicodeScalars.contains { CharacterSet.letters.contains($0) && !"APMapm".unicodeScalars.contains($0) }
        }
        // ウインドウの題（題の部分が写っていることがある）と同じ・一部の行は数えない
        let titleN = Self.normalize(title)
        let notTitle: (String) -> Bool = { line in let n = Self.normalize(line); return n.isEmpty || titleN.isEmpty || !(titleN.contains(n) || n.contains(titleN)) }
        let added = candidates.filter { meaningfulLine($0) && notTitle($0) }
        // 新しく出た意味のある文字が無い（消えただけ・短い状態語に戻っただけ）は判定に回さない
        let addedChars = added.reduce(0) { $0 + Self.normalize($1).count }
        guard !added.isEmpty, addedChars > 4 else {
            StatusBarDiag.note("アシスタント: \(app) 変化（新しく出た文字なし）")
            return
        }
        // 「違う」と言われた変化と同じ（同じアプリ・正規化した文字が一致かよく似ている）は、AI に渡す前に見送る
        let summary = AIPicks.short(added.joined(separator: " "), 60)
        if memory.wrong.contains(where: { $0.app == app && Self.similar($0.summary, summary) }) {
            StatusBarDiag.note("アシスタント: \(app) 変化（「違う」と同じなので見送り）")
            dlog("「違う」と同じなので見送り: \(summary)")
            return
        }
        st.lastAI = now
        let t0 = Date()
        let result = await judge(app: app, title: title, added: added, newWindow: newWindow)
        let sec = Date().timeIntervalSince(t0)
        guard let result else { return }
        guard alive(run) else { dlog("処理中の 1 件を捨てた（オフ・一時停止）"); return } // オフ・一時停止になっていたら知らせない
        StatusBarDiag.note(String(format: "アシスタント: %@ 判定 %@（%.1f 秒）", app, result.meaningful ? "意味あり" : "意味なし", sec))
        dlog("\(title)\(newWindow ? "（新しい窓）" : "") +\(added.joined(separator: " / ")) → \(result.meaningful ? "意味あり" : "意味なし")\(result.byRule ? "（決まり）" : "") [\(result.kind)] \(result.reason) \(String(format: "%.1f 秒", sec))")
        guard result.meaningful else { return }
        let pid = st.window.owningApplication?.processID ?? 0
        let bid = st.window.owningApplication?.bundleIdentifier ?? ""
        let notice = Notice(app: app, title: AIPicks.short(title, 40), summary: summary,
                            reason: result.reason, pid: pid, bundleID: bid, bundleURL: NSRunningApplication(processIdentifier: pid)?.bundleURL,
                            byRule: result.byRule)
        recent.insert(notice, at: 0)
        if recent.count > 5 { recent.removeLast(recent.count - 5) }
        memory.notified.append(Date())
        trimStats()
        save()
        deliver?(notice)
        // 決まりで知らせたもの（AI は「関係ない」と言った）は自動で前に出さない
        if autoFront, !notice.byRule { maybeAutoFront(notice) }
    }

    /// 最近の知らせからこのアプリの分を除く（「このアプリは知らせない」のあと）。
    func forgetRecent(app: String) { recent.removeAll { $0.app == app } }

    // MARK: - 知らせの文（「名前だけ」・共有中・配信中はアプリ名だけ。AI の推測の印つき）

    func tickerText(_ n: Notice, namesOnly: Bool) -> String {
        if namesOnly || Self.sharingOrStreamingLikely() { return "🐶 \(AIPicks.short(n.app, 14))：変化がありました（推測）" }
        return "🐶 \(AIPicks.short(n.app, 14))：\(AIPicks.short(n.reason, 30))（推測）"
    }

    /// 画面共有・配信中らしいか（判定できる範囲：会議アプリが前面、配信アプリが起動している）。
    static func sharingOrStreamingLikely() -> Bool {
        if meetingApps.contains(NSWorkspace.shared.frontmostApplication?.bundleIdentifier ?? "") { return true }
        return NSWorkspace.shared.runningApplications.contains { streamingApps.contains($0.bundleIdentifier ?? "") }
    }

    // MARK: - 前に出す

    func bringToFront(_ n: Notice) {
        if let url = n.bundleURL {
            let c = NSWorkspace.OpenConfiguration()
            c.activates = true
            NSWorkspace.shared.openApplication(at: url, configuration: c) { _, _ in }
        } else {
            NSRunningApplication(processIdentifier: n.pid)?.activate()
        }
    }

    /// 自動で前に出してよいか（理由つき）。画面の文字で誘導されないよう、人が離れているときだけ・ブラウザは出さない。
    func autoFrontBlockReason(_ n: Notice) -> String? {
        let kinds: [CGEventType] = [.keyDown, .mouseMoved, .leftMouseDown, .rightMouseDown, .scrollWheel, .leftMouseDragged]
        let idle = kinds.map { CGEventSource.secondsSinceLastEventType(.combinedSessionState, eventType: $0) }.min() ?? 0
        if idle < 30 { return "操作中（無操作 30 秒未満）" }
        if IsSecureEventInputEnabled() { return "パスワード入力中" }
        if Self.browsers.contains(n.bundleID) { return "ブラウザ" }
        if Self.sharingOrStreamingLikely() { return "画面共有・配信中" }
        if let b = blockedReason() { return b }
        if Date().timeIntervalSince(lastAutoFront) < 60 { return "60 秒以内に出した" }
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == n.pid { return "使っている" }
        return nil
    }

    private func maybeAutoFront(_ n: Notice) {
        if let why = autoFrontBlockReason(n) {
            StatusBarDiag.note("アシスタント: 自動で出さない（\(why)）")
            return
        }
        lastAutoFront = Date()
        StatusBarDiag.note("アシスタント: 自動で前に出した（\(n.app)）")
        bringToFront(n)
    }

    // MARK: - 学ぶ

    func markWrong(_ id: UUID? = nil) {
        guard let i = id.flatMap({ id in recent.firstIndex { $0.id == id } }) ?? (recent.isEmpty ? nil : 0) else { return }
        let n = recent.remove(at: i)
        memory.wrong.append(Example(app: n.app, title: n.title, summary: n.summary, at: Date()))
        if memory.wrong.count > 10 { memory.wrong.removeFirst(memory.wrong.count - 10) }
        memory.wrongAt.append(Date())
        trimStats()
        save()
        StatusBarDiag.note("アシスタント: 「違う」を覚えた（\(n.app)）")
    }

    func markRight(_ id: UUID? = nil) {
        guard let i = id.flatMap({ id in recent.firstIndex { $0.id == id } }) ?? (recent.isEmpty ? nil : 0) else { return }
        let n = recent.remove(at: i)
        memory.rightAt.append(Date())
        trimStats()
        save()
        StatusBarDiag.note("アシスタント: 「合ってた」（\(n.app)）")
    }

    private func trimStats() {
        let week = Date().addingTimeInterval(-7 * 86400)
        memory.notified.removeAll { $0 < week }
        memory.wrongAt.removeAll { $0 < week }
        memory.rightAt.removeAll { $0 < week }
    }

    var weekSummary: String {
        let n = memory.notified.count, w = memory.wrongAt.count, r = memory.rightAt.count
        return n == 0 ? "この 1 週間：まだ知らせていません" : "この 1 週間：知らせた \(n) 件・違う \(w) 件・合ってた \(r) 件"
    }

    var watchingCount: Int { order.count }
    var lineCount: Int { windows.values.reduce(0) { $0 + ($1.lines?.count ?? 0) } }
    var seenCount: Int { seenIDs.count }

    // MARK: - 撮る・比べる・読む

    private func capture(_ w: SCWindow, maxWidth: Int) async -> CGImage? {
        let filter = SCContentFilter(desktopIndependentWindow: w)
        let cfg = SCStreamConfiguration()
        var scale = CGFloat(filter.pointPixelScale)
        var rect = filter.contentRect
        if rect.width < 1 || rect.height < 1 { rect = w.frame }
        if scale <= 0 { scale = NSScreen.main?.backingScaleFactor ?? 2 }
        let pw = rect.width * scale, ph = rect.height * scale
        guard pw > 0, ph > 0 else { return nil }
        let k = min(1, CGFloat(maxWidth) / pw)
        cfg.width = max(1, Int(pw * k))
        cfg.height = max(1, Int(ph * k))
        cfg.showsCursor = false
        cfg.ignoreShadowsSingleWindow = true
        return try? await SCScreenshotManager.captureImage(contentFilter: filter, configuration: cfg)
    }

    /// 灰色の画素の並びへ（メインスレッドの外で）。
    nonisolated static func toGray(_ img: CGImage) async -> Gray? {
        await Task.detached(priority: .utility) { () -> Gray? in
            let w = img.width, h = img.height
            var px = [UInt8](repeating: 0, count: w * h)
            let ok = px.withUnsafeMutableBytes { buf -> Bool in
                guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w,
                                          space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
                ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
                return true
            }
            return ok ? Gray(w: w, h: h, px: px) : nil
        }.value
    }

    nonisolated static func diff(_ a: Gray, _ b: Gray) -> (significant: Bool, box: CGRect) {
        guard a.w == b.w, a.h == b.h else { return (true, CGRect(x: 0, y: 0, width: b.w, height: b.h)) }
        var n = 0, minX = Int.max, minY = Int.max, maxX = -1, maxY = -1
        for y in 0..<a.h {
            let row = y * a.w
            for x in 0..<a.w where abs(Int(a.px[row + x]) - Int(b.px[row + x])) > 28 {
                n += 1
                if x < minX { minX = x }; if x > maxX { maxX = x }
                if y < minY { minY = y }; if y > maxY { maxY = y }
            }
        }
        let limit = max(60, a.w * a.h * 3 / 1000)
        guard n >= limit else { return (false, .zero) }
        return (true, CGRect(x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1))
    }

    nonisolated static func ocr(_ image: CGImage?, crop: CGRect) async -> [String] {
        guard let image, let part = image.cropping(to: crop) else { return [] }
        return await Task.detached(priority: .utility) {
            let req = VNRecognizeTextRequest()
            req.recognitionLevel = .accurate
            req.recognitionLanguages = ["ja-JP", "en-US"]
            req.usesLanguageCorrection = true
            try? VNImageRequestHandler(cgImage: part).perform([req])
            return (req.results ?? []).compactMap { $0.topCandidates(1).first?.string }
                .map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        }.value
    }

    // MARK: - 持ち主宛てか（名前の一致を厳しく）

    /// 文字に持ち主の名前・呼び名が「語として」出ているか、@ があるか。2 文字の名前は前後が区切り（空白・記号・さん等）のときだけ、
    /// 3 文字以上は語の境界（前が文字でない、後ろが文字でないか敬称）で一致させる。
    nonisolated static func addressesOwner(_ raw: String, names: [String], broadcast: Bool = true) -> Bool {
        let text = raw.precomposedStringWithCompatibilityMapping // 全角の＠・英字をそろえる
        // @ は宛先が持ち主の名前か、@everyone / @here / @channel のときだけ（broadcast が false なら一斉宛ては数えない）
        let tokens = ownerNameTokens(names)
        for m in mentions(text) {
            let low = m.lowercased()
            if broadcastNames.contains(low) { if broadcast { return true } else { continue } }
            if tokens.contains(where: { mentionMatchesOwner(low, $0) }) { return true }
        }
        let honorifics = ["さん", "様", "さま", "くん", "君", "ちゃん", "氏", "殿"]
        let candidates = names.flatMap { [$0] + $0.split(separator: " ").map(String.init) }.filter { $0.count >= 2 }
        func isWordChar(_ c: Character) -> Bool { c.isLetter || c.isNumber }
        for name in candidates {
            var search = text.startIndex..<text.endIndex
            while let r = text.range(of: name, options: [.caseInsensitive], range: search) {
                let beforeOK = r.lowerBound == text.startIndex || !isWordChar(text[text.index(before: r.lowerBound)])
                let rest = text[r.upperBound...]
                let afterOK = rest.isEmpty || !isWordChar(rest.first!) || honorifics.contains(where: { rest.hasPrefix($0) })
                if beforeOK && afterOK { return true }
                search = r.upperBound..<text.endIndex
            }
        }
        return false
    }

    /// @ の後ろの名前（全角はそろえてから）。
    nonisolated static func mentions(_ text: String) -> [String] {
        let t = text.precomposedStringWithCompatibilityMapping
        var out: [String] = []
        var i = t.startIndex
        while let r = t.range(of: "@", range: i..<t.endIndex) {
            // 文字認識で @ の後ろに空白が入ることがある（「@ tanaka」）
            let rest = t[r.upperBound...].drop { $0 == " " }.prefix { $0.isLetter || $0.isNumber || $0 == "_" || $0 == "." || $0 == "-" }
            if !rest.isEmpty { out.append(String(rest)) }
            i = r.upperBound
        }
        return out
    }

    nonisolated static let broadcastNames: Set<String> = ["everyone", "here", "channel", "all"]

    /// @ の後ろの名前（小文字）が持ち主の名前か。文字認識で空白が消えて後ろの文とつながる（「@ドリキン明日の…」）ので名前で始まれば、
    /// 3 字以上の名前は 1 文字の読み違い（「@koh」→「@kon」）も持ち主とみなす。
    nonisolated static func mentionMatchesOwner(_ mention: String, _ owner: String) -> Bool {
        if mention == owner || mention.hasPrefix(owner) { return true }
        let o = Array(owner), m = Array(mention)
        guard o.count >= 3, m.count >= o.count else { return false }
        var diff = 0
        for k in 0..<o.count where m[k] != o[k] { diff += 1 }
        return diff <= 1
    }

    /// @ の後ろの名前の読み取りが確かでないか（英字の名前の直後に空白なしで日本語が続く「@konこのPR」、または英字が 2 字以下）。
    nonisolated static func mentionUncertain(_ mention: String) -> Bool {
        let ascii = mention.prefix { $0.isASCII }
        if ascii.isEmpty { return false }
        return ascii.count < mention.count || ascii.count <= 2
    }

    /// 持ち主の名前と、空白で区切ったその部分（2 文字以上、小文字）。
    nonisolated static func ownerNameTokens(_ names: [String]) -> [String] {
        var out: [String] = []
        for n in names {
            let parts: [String] = [n] + n.split(separator: " ").map(String.init)
            for p in parts where p.count >= 2 { out.append(p.lowercased()) }
        }
        return out
    }

    /// ほかの人が宛先と明示されているか（@ほかの名前、「〇〇さん」など。〇〇が持ち主でない）。
    nonisolated static func addressesOther(_ raw: String, names: [String]) -> Bool {
        let text = raw.precomposedStringWithCompatibilityMapping
        let mine: [String] = ownerNameTokens(names)
        for m in mentions(text) {
            let low = m.lowercased()
            if broadcastNames.contains(low) { continue }
            if mine.contains(where: { mentionMatchesOwner(low, $0) }) { continue }
            // 読み取りが確かでない名前は「ほかの人宛て」として見送らない
            if mentionUncertain(low) { continue }
            return true
        }
        for h in ["さん", "様", "さま", "くん", "ちゃん", "氏"] {
            var i = text.startIndex
            while let r = text.range(of: h, range: i..<text.endIndex) {
                let who = String(text[..<r.lowerBound].reversed().prefix { !$0.isWhitespace && !"、。,.!！?？「」『』()（）:：".contains($0) }.reversed())
                if !who.isEmpty, !mine.contains(where: { who.lowercased().hasSuffix($0) }) { return true }
                i = r.upperBound
            }
        }
        return false
    }

    /// 比べる用に文字をそろえる（全角・半角、数字・空白・記号を除く）。
    nonisolated static func normalize(_ s: String) -> String {
        String(s.precomposedStringWithCompatibilityMapping.lowercased().unicodeScalars
            .filter { CharacterSet.letters.contains($0) }.map(Character.init))
    }

    /// 同じ変化か（数字を除いて一致、または 2 文字ずつの重なりが 8 割以上）。
    nonisolated static func similar(_ a: String, _ b: String) -> Bool {
        let x = normalize(a), y = normalize(b)
        if x.isEmpty || y.isEmpty { return false }
        if x == y || x.contains(y) || y.contains(x) { return true }
        func grams(_ s: String) -> Set<String> {
            let c = Array(s)
            return c.count < 2 ? [s] : Set((0..<(c.count - 1)).map { String(c[$0...$0 + 1]) })
        }
        let g1 = grams(x), g2 = grams(y)
        return Double(g1.intersection(g2).count) / Double(max(1, g1.union(g2).count)) >= 0.8
    }

    /// 「関係ない」と書いてあるのに意味ありになっているか。
    nonisolated static func reasonContradicts(_ reason: String) -> Bool {
        ["関係ない", "関係なし", "関連なし", "関連がない", "無関係", "不要", "意味なし", "意味のない", "対象外", "該当しない"].contains { reason.contains($0) }
    }

    /// 理由が空疎（何が起きたかを書いていない：「新しい文字が出た」「題に文字追加」など）か。
    nonisolated static func reasonIsEmpty(_ reason: String) -> Bool {
        let vacuous = ["新しい文字", "新文字", "文字が出た", "文字が追加", "文字追加", "表示が変わ", "新しいメッセージが表示", "メッセージが表示された",
                       "メッセージが追加", "題に", "ウインドウに新しい"]
        return vacuous.contains { reason.contains($0) } || normalize(reason).count < 4
    }

    /// 進み具合らしい文字か（「処理中」「〜中です」「45%」「更新」「残り」）。
    nonisolated static func looksLikeProgress(_ text: String) -> Bool {
        let t = text.precomposedStringWithCompatibilityMapping
        return ["中です", "中…", "中...", "%", "更新", "残り", "処理中", "進行中", "読み込み中"].contains { t.contains($0) }
    }

    nonisolated static let strongJa = ["完了", "終わりました", "終了しました", "済みました", "成功", "失敗", "できませんでした", "エラー", "問題が発生",
                                       "クラッシュ", "中断しました", "警告", "承認", "許可が必要", "入力してください"]
    nonisolated static let strongEn = ["succeeded", "success", "failed", "failure", "error", "completed", "complete", "finished", "done",
                                       "crashed", "aborted", "exception", "approval", "approve"]
    /// 否定（「0 errors」「no errors」「エラーなし」「エラー 0 件」「失敗 0 件」）。手がかりの語を探す前に取り除く。
    nonisolated static let negations: [NSRegularExpression] = [
        #"\b(no|zero|0|o)\s+(errors?|failures?|failed|warnings?)\b"#, // 文字認識で 0 が O になることがある
        #"\b(errors?|failures?|failed|warnings?)\s*[:=]?\s*(0|o|none|zero)\b"#,
        #"(エラー|失敗|警告)\s*[:：は]?\s*(なし|無し|ありません|ゼロ|0\s*件|0)"#,
        #"(エラー|失敗|警告)の?(ない|無い)"#,
    ].compactMap { try? NSRegularExpression(pattern: $0, options: [.caseInsensitive]) }
    nonisolated static let strongEnRegex = try? NSRegularExpression(pattern: "\\b(" + strongEn.joined(separator: "|") + ")\\b", options: [.caseInsensitive])

    /// 文字に出ている強い手がかりの語の組（完了・成功・失敗・エラー・承認など。「お願い」のような弱いものは入れない）。
    /// 英語は単語の切れ目で一致させ（incomplete・autocomplete・successfully・errors に当てない）、否定は除く。
    nonisolated static func evidenceWords(_ text: String) -> Set<String> {
        var t = text.precomposedStringWithCompatibilityMapping.lowercased()
        for r in negations {
            t = r.stringByReplacingMatches(in: t, range: NSRange(t.startIndex..., in: t), withTemplate: " ")
        }
        var out = Set(strongJa.filter { t.contains($0) })
        if let re = strongEnRegex {
            for m in re.matches(in: t, range: NSRange(t.startIndex..., in: t)) {
                if let r = Range(m.range, in: t) { out.insert(String(t[r])) }
            }
        }
        return out
    }

    nonisolated static func hasStrongEvidence(_ text: String) -> Bool { !evidenceWords(text).isEmpty }

    /// 上書きの根拠になる強い手がかり：40 字以内の短い行にあるときだけ（長い文・記事の中の語は使わない）。
    nonisolated static func strongEvidenceInShortLine(_ lines: [String]) -> Bool {
        lines.contains { $0.count <= 40 && hasStrongEvidence($0) }
    }

    /// AI の「関係ない」をアプリの決まりで上書きしてよい種類（広告・おすすめ、天気・ニュースは上書きしない）。
    /// 試験で「Build succeeded」に AI が選んだのは「完了」か「意味のない表示の変化」だけだったので、許すのはこの 1 種類だけ。
    nonisolated static let overridableKinds: Set<String> = ["意味のない表示の変化"]

    /// 見出しの語で一般の情報（ニュース・速報・運勢・占い・天気・広告・おすすめ）と分かる文字か。新しく出た行がすべてそうなら、
    /// その中の「完了」「エラー」は持ち主の作業ではないので知らせない（AI が完了やエラーを選んでも）。
    nonisolated static let generalInfoHeads = ["ニュース", "速報", "運勢", "占い", "天気", "広告", "おすすめ", "PR:", "セール", "クーポン",
                                               "ランキング", "今日のヒント", "breaking", "news", "sponsored", "ad:"]
    /// 広告・おすすめらしい語があるか（上書きでは、名前があっても「ドリキンさん限定クーポン」を知らせない）。
    nonisolated static func looksLikeAd(_ text: String) -> Bool {
        let t = text.precomposedStringWithCompatibilityMapping.lowercased()
        return ["クーポン", "セール", "限定", "%オフ", "% オフ", "割引", "おすすめ", "広告", "キャンペーン", "sale", "coupon", "sponsored"].contains { t.contains($0) }
    }

    nonisolated static func looksLikeGeneralInfo(_ lines: [String]) -> Bool {
        let ls = lines.map { $0.precomposedStringWithCompatibilityMapping.lowercased().trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard !ls.isEmpty else { return false }
        return ls.allSatisfy { l in generalInfoHeads.contains { h in l.hasPrefix(h.lowercased()) || l.prefix(12).contains(h.lowercased() + ":") } }
    }

    /// 文字そのものに、対応が要りそうな手がかり（完了・失敗・承認・依頼など）があるか。
    nonisolated static func hasActionEvidence(_ text: String) -> Bool {
        if hasStrongEvidence(text) { return true }
        let t = text.precomposedStringWithCompatibilityMapping.lowercased()
        if ["許可", "確認", "お願い", "必要です"].contains(where: { t.contains($0) }) { return true }
        return t.range(of: #"\b(done|required)\b"#, options: .regularExpression) != nil
    }

    // MARK: - 判断

    struct Judgement { var meaningful: Bool; var reason: String; var urgency: Int; var kind = ""; var byRule = false }

    static let instructions = """
    あなたは Mac の持ち主のアシスタントです。裏にあるアプリのウインドウに新しい文字が出ました。
    その文字が、持ち主の「知りたいこと」に当たるかを判断します。まず何が起きたかを日本語 30 字以内で書き、変化の種類を 1 つ選んでください。
    広告・おすすめ・クーポン、天気やニュース、時刻や進み具合（〜中、％）は持ち主に関係ありません。
    「〇〇さん」の〇〇が持ち主の名前・呼び名でなければ、持ち主宛てではありません。
    ニュース・速報・運勢・占いの中に出てくる「完了」「エラー」は、持ち主の作業の完了やエラーではありません（天気やニュースを選ぶ）。
    「違う」と言われた例に似た変化は、関係のない種類を選んでください。
    """

    private func judge(app: String, title: String, added: [String], newWindow: Bool) async -> Judgement? {
        #if canImport(FoundationModels)
        if #available(macOS 26, *) {
            let wrong = memory.wrong.suffix(10).map { "・\($0.app)「\($0.title)」：\($0.summary)" }.joined(separator: "\n")
            let prompt = """
            知りたいこと：\(AIPicks.short(interest, 120))
            持ち主の名前・呼び名：\(ownerNames().joined(separator: "、"))
            アプリ：\(app)
            ウインドウの題：\(AIPicks.short(title, 60))
            \(newWindow ? "新しく開いたウインドウの文字" : "新しく出た文字")：\(AIPicks.short(added.joined(separator: " / "), 300))
            「違う」と言われた例：
            \(wrong.isEmpty ? "なし" : wrong)
            """
            do {
                let s = LanguageModelSession(instructions: Self.instructions)
                let r = try await s.respond(to: prompt, generating: AssistantJudgement.self,
                                            options: GenerationOptions(temperature: 0, maximumResponseTokens: 200))
                var kindValue = r.content.kind
                #if DEBUG
                // 開発のみ（awForceKind:<種類>）：次の 1 回だけ AI の種類を差し替え、アプリ側の決まりを通しで確かめる
                if let forced = debugForceKind, let k = AssistantChangeKind.named(forced) { kindValue = k; debugForceKind = nil }
                #endif
                var meaningful = kindValue.meaningful
                let text = added.joined(separator: " ")
                var reason = AIPicks.cleanNote(r.content.reason)
                // 持ち主宛て：名前か @ があるときだけ。依頼・承認：ほかの人が宛先と明示されていれば見送る
                if kindValue == .持ち主宛てのメッセージ, !Self.addressesOwner(text, names: ownerNames()) { meaningful = false }
                if kindValue == .承認や確認の依頼 || kindValue == .持ち主宛てのメッセージ,
                   Self.addressesOther(text, names: ownerNames()), !Self.addressesOwner(text, names: ownerNames()) { meaningful = false }
                // 理由が種類と矛盾（「関係ない」と書いてある）なら知らせない。理由が空疎なら AI を信じず、
                // 文字そのものに完了・失敗・承認・依頼などの手がかりがあるときだけ知らせる（理由は文字で置き換える）
                if meaningful, Self.reasonContradicts(reason) { meaningful = false }
                // 小さいモデルの揺れの受け止め（最小限）：AI が上書きしてよい種類（意味のない表示の変化・時刻や進み具合）を選んだときだけ、
                // ほかの人宛てでなく、持ち主の名前（一斉宛ての @ は数えない）か、40 字以内の短い行に完了・失敗などの強い手がかりがあれば知らせる。
                // 広告・おすすめ、天気・ニュースは上書きしない。上書きした知らせは印を付け、理由は画面の文字でなく決まった文
                let kindName = "\(kindValue)"
                var byRule = false
                let ownerNoBroadcast = Self.addressesOwner(text, names: ownerNames(), broadcast: false)
                if !meaningful, Self.overridableKinds.contains(kindName), !Self.looksLikeAd(text),
                   (!Self.addressesOther(text, names: ownerNames()) || ownerNoBroadcast) {
                    if ownerNoBroadcast {
                        meaningful = true; byRule = true; reason = "あなた宛てらしい文字が出ました"
                    } else if Self.strongEvidenceInShortLine(added) {
                        meaningful = true; byRule = true; reason = "完了・失敗などの文字が出ました"
                    }
                }
                // 進み具合（「〜中です」「45%」「更新」）だけの文字は、完了・失敗などの強い手がかりが無ければ知らせない
                if meaningful, Self.looksLikeProgress(text), !Self.hasStrongEvidence(text), !Self.addressesOwner(text, names: ownerNames()) { meaningful = false }
                // AI が「完了」「エラーや失敗」を選んでも、文字に完了・失敗などの語が無ければ（否定の「0 errors」「エラーなし」は除いたうえで）知らせない
                if meaningful, kindValue == .完了 || kindValue == .エラーや失敗, !Self.hasStrongEvidence(text) { meaningful = false }
                // 見出しで一般の情報と分かる文字（ニュース・速報・運勢など）は、AI が完了・エラーを選んでも知らせない
                if meaningful, Self.looksLikeGeneralInfo(added) { meaningful = false; byRule = false }
                if meaningful, !byRule, Self.reasonIsEmpty(reason) {
                    meaningful = Self.hasActionEvidence(text) || Self.addressesOwner(text, names: ownerNames())
                    reason = AIPicks.short(text, 30)
                }
                return Judgement(meaningful: meaningful, reason: reason, urgency: min(2, max(0, r.content.urgency)), kind: kindName, byRule: byRule)
            } catch {
                StatusBarDiag.note("アシスタント: \(app) 判定に失敗（\(AIPicks.reason(error))）")
                return nil
            }
        }
        #endif
        return nil
    }

    #if DEBUG
    /// 開発のみ（-assistantSelfTest）：絞り込みと持ち主宛ての判定の単体テスト。失敗があれば false。
    nonisolated static func selfTest() -> Bool {
        var ok = true
        func check(_ name: String, _ got: Bool, _ want: Bool) {
            print("[assistant-test] \(got == want ? "ok  " : "FAIL") \(name)")
            if got != want { ok = false }
        }
        let base = Candidate(bundleID: "com.example.app", appName: "Example", pid: 100, layer: 0, width: 800, height: 600, title: "書類", onScreen: true)
        check("ふつうのウインドウは見張る", shouldWatch(base, me: 1, front: 2, excluded: defaultExcluded), true)
        var c = base; c.pid = 2
        check("前面のアプリは見張らない", shouldWatch(c, me: 1, front: 2, excluded: defaultExcluded), false)
        c = base; c.pid = 1
        check("自分は見張らない", shouldWatch(c, me: 1, front: 2, excluded: defaultExcluded), false)
        c = base; c.bundleID = "com.1password.1password"
        check("除外リストは見張らない", shouldWatch(c, me: 1, front: 2, excluded: defaultExcluded), false)
        c = base; c.appName = "銀行アプリ"
        check("アプリ名で足した除外", shouldWatch(c, me: 1, front: 2, excluded: defaultExcluded + ["銀行アプリ"]), false)
        c = base; c.bundleID = "com.apple.dock"
        check("システムの部品は見張らない", shouldWatch(c, me: 1, front: 2, excluded: []), false)
        c = base; c.title = "Google - プライベートブラウズ"
        check("プライベートの題は見張らない", shouldWatch(c, me: 1, front: 2, excluded: []), false)
        c = base; c.width = 200
        check("小さすぎるウインドウは見張らない", shouldWatch(c, me: 1, front: 2, excluded: []), false)
        c = base; c.layer = 25
        check("ふつうの層でないものは見張らない", shouldWatch(c, me: 1, front: 2, excluded: []), false)
        c = base; c.onScreen = false
        check("画面にないものは見張らない", shouldWatch(c, me: 1, front: 2, excluded: []), false)
        let names = ["ドリキン", "Kohichi Aoki", "koh"]
        check("名前＋さん", addressesOwner("ドリキンさん、レビューをお願いします", names: names), true)
        check("名前 さん（空白）", addressesOwner("ドリキン さん、確認を", names: names), true)
        check("ほかの人", addressesOwner("コバンさん、ランチどうする？", names: names), false)
        check("名前の一部（koh が kohai に）", addressesOwner("kohai の件です", names: names), false)
        check("姓だけ（語として）", addressesOwner("Aoki, please review", names: names), true)
        check("名前が別の語の中", addressesOwner("ドリキングの新作", names: names), false)
        check("全角＠ほかの人は持ち主宛てでない", addressesOwner("＠tanaka 明日の会議資料お願いします", names: names), false)
        check("全角＠ほかの人はほかの人宛て", addressesOther("＠tanaka 明日の会議資料お願いします", names: names), true)
        check("@ の後ろに空白（文字認識）", addressesOther("@ tanaka 明日の会議資料お願いします", names: names), true)
        check("〇〇さん（ほかの人）", addressesOther("コバンさん、確認お願いします", names: names), true)
        check("持ち主さんはほかの人ではない", addressesOther("ドリキンさん、確認お願いします", names: names), false)
        check("@everyone は持ち主宛て", addressesOwner("@everyone 集合", names: names), true)
        check("数字だけ違う変化は同じ", similar("ダウンロード完了 report1.pdf", "ダウンロード完了 report2.pdf"), true)
        check("違う変化は別", similar("ダウンロード完了", "エラー：アップロードに失敗"), false)
        check("空疎な理由", reasonIsEmpty("ウインドウ題に新文字出現"), true)
        check("矛盾する理由", reasonContradicts("同期完了の通知、関係ない"), true)
        check("中身のある理由", reasonIsEmpty("ビルドが完了した") || reasonContradicts("ビルドが完了した"), false)
        check("手がかりあり（完了）", hasActionEvidence("レンダリングが終わりました"), true)
        check("手がかりなし（待機中）", hasActionEvidence("待機中"), false)
        check("強い手がかり（Build succeeded）", hasStrongEvidence("Build succeeded"), true)
        check("強い手がかりなし（処理中）", hasStrongEvidence("プロジェクトの状況：処理中です（12:01 更新）"), false)
        check("強い手がかりなし（お願い）", hasStrongEvidence("明日の会議資料お願いします"), false)
        check("@名前が後ろの文とつながっても持ち主宛て", addressesOwner("@ドリキン明日の配信の件、確認お願いします", names: names), true)
        check("@名前が後ろの文とつながってもほかの人ではない", addressesOther("@ドリキン明日の配信の件、確認お願いします", names: names), false)
        check("進み具合", looksLikeProgress("プロジェクトの状況：処理中です（12:01 更新）"), true)
        check("完了は進み具合ではない", looksLikeProgress("ビルドが完了しました"), false)
        check("2 回目の同じ文も増えた行", addedLines(before: ["見出し", "待機中"], after: ["見出し", "Build succeeded"]) == ["Build succeeded"], true)
        check("同じ行が 2 つに増えた", addedLines(before: ["見出し", "承認待ち"], after: ["見出し", "承認待ち", "承認待ち"]) == ["承認待ち"], true)
        check("読み取りのゆれは同じ行", addedLines(before: ["ビルドが完了しました（エラー0件）"], after: ["ビルドが完了しました（エラー 0件)"]).isEmpty, true)
        check("成功→失敗の切り替わりは新しい行（ゆれとして吸収しない）",
              addedLines(before: ["すべて成功しました（42件）"], after: ["3件失敗しました（42件）"]) == ["3件失敗しました（42件）"], true)
        check("autocomplete は手がかりでない", hasStrongEvidence("autocomplete enabled"), false)
        check("incomplete は手がかりでない", hasStrongEvidence("incomplete"), false)
        check("successfully は手がかりでない（語の切れ目）", hasStrongEvidence("saved successfully"), false)
        check("errors は手がかりでない", hasStrongEvidence("3 errors"), false)
        check("0 errors は否定", hasStrongEvidence("Compiled with 0 errors"), false)
        check("O errors（0 の読み違い）も否定", hasStrongEvidence("ログ：Compiled with O errors/ / autocomplete ready"), false)
        check("1 error は手がかり", hasStrongEvidence("Build failed with 1 error"), true)
        check("no errors は否定", hasStrongEvidence("no errors found"), false)
        check("エラーなしは否定", hasStrongEvidence("チェック：エラーなし"), false)
        check("エラー 0 件は否定", hasStrongEvidence("結果：エラー 0 件"), false)
        check("Build succeeded は手がかり", hasStrongEvidence("Build succeeded"), true)
        check("Build failed は手がかり", hasStrongEvidence("Build failed: 1 error"), true)
        check("長い行の手がかりは上書きの根拠にしない",
              strongEvidenceInShortLine(["本日のニュースまとめ：A社の決算発表が完了し、株価は前日比で大きく上昇しました。市場の反応も上々です"]), false)
        check("短い行の手がかりは上書きの根拠", strongEvidenceInShortLine(["Build succeeded"]), true)
        check("@here は一斉宛て（上書きの根拠にしない）", addressesOwner("@here 会議始めます", names: names, broadcast: false), false)
        check("@here は AI が意味ありなら持ち主宛て", addressesOwner("@here 会議始めます", names: names), true)
        check("@kon（1 文字の読み違い）は持ち主", addressesOwner("@konこのPRの承認をお願いします", names: names), true)
        check("@kon はほかの人ではない", addressesOther("@konこのPRの承認をお願いします", names: names), false)
        check("@tanaka はほかの人のまま", addressesOther("@tanaka このPRの承認をお願いします", names: names), true)
        check("読み取りが確かでない @ はほかの人として見送らない", addressesOther("@xyこの件お願いします", names: names), false)
        check("ニュースの完了は一般の情報", looksLikeGeneralInfo(["ニュース：A社の決算発表が完了"]), true)
        check("速報のエラーは一般の情報", looksLikeGeneralInfo(["速報：B社のシステム障害でエラー"]), true)
        check("運勢の完了は一般の情報", looksLikeGeneralInfo(["本日の運勢：仕事運は完了の暗示"]), true)
        check("ビルド完了は一般の情報でない", looksLikeGeneralInfo(["ビルドが完了しました"]), false)
        check("一般の情報とほかの行が混ざれば判定に回す", looksLikeGeneralInfo(["ニュース：新製品", "書き出しが完了しました"]), false)
        check("名前つきのクーポンは広告", looksLikeAd("ドリキンさん限定クーポン"), true)
        check("広告・ニュースは上書きしない", overridableKinds.contains("広告やおすすめ") || overridableKinds.contains("天気やニュースなど一般の情報"), false)
        check("長い行の一部だけ変わっても行ごと（切れ端を作らない）",
              addedLines(before: ["プロジェクト B-guru のビルドが完了しました 12:01"], after: ["プロジェクト B-guru のビルドが完了しました 12:02"]).isEmpty, true)
        return ok
    }
    #endif
}

/// アシスタントの知らせ（パネルのヘッダーに 1 行で出す分）。
@MainActor
@Observable
final class AssistantBanner {
    static let shared = AssistantBanner()
    var current: Assistant.Notice?
    var text = ""
}

#if canImport(FoundationModels)
/// 判断の出力。小さいモデルは「意味あり／なし」の真偽を理由と食い違えることがあった（「セールで対応不要」なのに true）ので、
/// 先に何が起きたかを書かせ、変化の種類を選ばせて、意味ありかどうかはアプリ側で種類から決める。
@available(macOS 26, *)
@Generable
struct AssistantJudgement {
    @Guide(description: "何が起きたか、日本語 30 字以内")
    var reason: String
    @Guide(description: "変化の種類")
    var kind: AssistantChangeKind
    @Guide(description: "急ぎ度。0 = 急がない、1 = 早めに、2 = すぐ", .range(0...2))
    var urgency: Int
}

@available(macOS 26, *)
@Generable
enum AssistantChangeKind {
    // 関係のない種類を先に並べる（意味のある種類が先だと、小さいモデルがそちらを選びがちだった）
    case 広告やおすすめ
    case 時刻や数字や進み具合だけ
    case 天気やニュースなど一般の情報
    case 意味のない表示の変化
    case 完了
    case エラーや失敗
    case 承認や確認の依頼
    case 持ち主宛てのメッセージ
    static func named(_ s: String) -> AssistantChangeKind? {
        let all: [AssistantChangeKind] = [.広告やおすすめ, .時刻や数字や進み具合だけ, .天気やニュースなど一般の情報, .意味のない表示の変化,
                                          .完了, .エラーや失敗, .承認や確認の依頼, .持ち主宛てのメッセージ]
        return all.first { "\($0)" == s }
    }
    var meaningful: Bool {
        switch self {
        case .完了, .エラーや失敗, .承認や確認の依頼, .持ち主宛てのメッセージ: return true
        default: return false
        }
    }
}
#endif

#if DEBUG
/// 開発のみ（-assistantTest）：アシスタントのテスト用の小さな窓を出し（既定 3 つ、`-assistantTestWindows N` で N 個）、分散通知で中身を変える。
@MainActor
final class AssistantTestWindows {
    static let shared = AssistantTestWindows()
    private var windows: [String: (NSWindow, NSTextField, NSTextField, NSTextField)] = [:]
    private var clockTimer: Timer?
    private var blinkTimer: Timer?

    func show(count: Int = 3) {
        let names = count <= 3 ? ["A", "B", "C"] : (0..<count).map { "W\($0)" }
        for (i, name) in names.prefix(count).enumerated() {
            let col = i % 4, row = i / 4
            add(name, frame: NSRect(x: 40 + col * 380, y: 120 + (row % 6) * 40, width: 360, height: 220), text: count <= 3 ? "待機中" : "待機中 \(name)：今日の予定はとくになし")
        }
    }

    private func add(_ name: String, frame: NSRect, text: String) {
        let w = NSWindow(contentRect: frame, styleMask: [.titled, .miniaturizable], backing: .buffered, defer: false)
        w.title = "アシスタントのテスト \(name)"
        w.isReleasedWhenClosed = false
        let big = NSTextField(labelWithString: text)
        big.font = .systemFont(ofSize: 20, weight: .semibold)
        big.frame = NSRect(x: 16, y: 110, width: 330, height: 60)
        big.lineBreakMode = .byWordWrapping
        big.maximumNumberOfLines = 2
        let clock = NSTextField(labelWithString: "")
        clock.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        clock.frame = NSRect(x: 16, y: 16, width: 120, height: 16)
        let blink = NSTextField(labelWithString: "")
        blink.frame = NSRect(x: 330, y: 16, width: 12, height: 16)
        w.contentView?.addSubview(big)
        w.contentView?.addSubview(clock)
        w.contentView?.addSubview(blink)
        w.orderFrontRegardless()
        windows[name] = (w, big, clock, blink)
    }

    func command(_ c: String) {
        // 形式: "aw:<窓>:<命令>[:<文>]"、新しい窓（ダイアログ）: "aw:new:<文>"
        let parts = c.split(separator: ":", maxSplits: 3).map(String.init)
        if parts.count >= 3, parts[1] == "new" {
            add("新\(windows.count)", frame: NSRect(x: 500, y: 500, width: 360, height: 220), text: parts[2...].joined(separator: ":"))
            return
        }
        guard parts.count >= 3, let win = windows[parts[1]] else { return }
        switch parts[2] {
        case "text": win.1.stringValue = parts.count > 3 ? parts[3] : ""
        case "clock":
            clockTimer?.invalidate()
            clockTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
                MainActor.assumeIsolated { win.2.stringValue = DateFormatter.localizedString(from: Date(), dateStyle: .none, timeStyle: .medium) }
            }
        case "blink":
            blinkTimer?.invalidate()
            blinkTimer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in
                MainActor.assumeIsolated { win.3.stringValue = win.3.stringValue.isEmpty ? "▌" : "" }
            }
        case "still":
            clockTimer?.invalidate(); blinkTimer?.invalidate()
        case "mini": win.0.miniaturize(nil)
        case "restore": win.0.deminiaturize(nil); win.0.orderFrontRegardless()
        default: break
        }
    }

    func closeAll() {
        clockTimer?.invalidate(); blinkTimer?.invalidate()
        for (w, _, _, _) in windows.values { w.close() }
        windows.removeAll()
    }
}
#endif

/// アシスタントの設定の入力（右クリックメニューと ⋯ メニューから）。
@MainActor
enum AssistantUI {
    static let consentText = "画面に出ているほかのアプリのウインドウを、この Mac の中の AI が読みます。ほかのウインドウの後ろに隠れているウインドウも読みます。"
        + "画像も文字も Mac の外には出ません。\n\n「違う」と言った知らせは、画面の文字の一部（1 件 60 字まで・最大 10 件）を Mac の中に保存します。"
        + "オフにすると消えます。\n\n前面のアプリ、パスワード管理・システム設定など除外したアプリ、最小化・別のスペースのウインドウは見張りません。"
        + "画面収録の許可が要ります。オフにしたあと、許可はシステム設定 → プライバシーとセキュリティ → 画面収録で外せます。"

    /// オンにする（右クリックメニューと ⋯ メニューの共通の入口）。説明を出し、同意したときだけオンにする。
    static func enable(_ settings: AppSettings) {
        guard !settings.assistant else { return }
        let alert = NSAlert()
        alert.messageText = "アシスタント：ウインドウの変化を知らせる（試験的）"
        alert.informativeText = consentText
        alert.addButton(withTitle: "同意してオンにする")
        alert.addButton(withTitle: "やめる")
        NSApp.activate()
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        settings.assistant = true
    }

    /// オフにする（記録を消し、画面収録の許可はシステム設定で外せると案内する）。
    static func disable(_ settings: AppSettings) {
        guard settings.assistant else { return }
        settings.assistantAutoFront = false // 自動で前に出すも戻す（次にオンにしたとき、知らないうちに前に出ないように）
        settings.assistant = false
        let alert = NSAlert()
        alert.messageText = "アシスタントをオフにしました"
        alert.informativeText = "「違う」の記録は消しました。画面収録の許可は、システム設定 → プライバシーとセキュリティ → 画面収録で外せます。"
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "システム設定を開く")
        NSApp.activate()
        if alert.runModal() == .alertSecondButtonReturn,
           let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture") {
            NSWorkspace.shared.open(url)
        }
    }

    static func editInterest(_ settings: AppSettings) {
        let alert = NSAlert()
        alert.messageText = "知りたいこと"
        alert.informativeText = "どんな変化を知らせてほしいかを書いてください（端末内 AI が判断に使います）。"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 360, height: 60))
        field.stringValue = settings.assistantInterest
        alert.accessoryView = field
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "やめる")
        NSApp.activate()
        if alert.runModal() == .alertFirstButtonReturn {
            let t = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            settings.assistantInterest = t.isEmpty ? Assistant.defaultInterest : t
        }
    }

    static func editExcluded(_ settings: AppSettings) {
        let alert = NSAlert()
        alert.messageText = "除外するアプリ"
        alert.informativeText = "見張らないアプリのバンドル ID かアプリ名を、1 行に 1 つ書いてください（銀行のアプリなど）。"
        let field = NSTextView(frame: NSRect(x: 0, y: 0, width: 360, height: 140))
        field.string = settings.assistantExcluded.joined(separator: "\n")
        field.font = .systemFont(ofSize: 12)
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 360, height: 140))
        scroll.documentView = field
        scroll.hasVerticalScroller = true
        scroll.borderType = .bezelBorder
        alert.accessoryView = scroll
        alert.addButton(withTitle: "保存")
        alert.addButton(withTitle: "既定に戻す")
        alert.addButton(withTitle: "やめる")
        NSApp.activate()
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            settings.assistantExcluded = field.string.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        case .alertSecondButtonReturn:
            settings.assistantExcluded = Assistant.defaultExcluded
        default: break
        }
    }
}
