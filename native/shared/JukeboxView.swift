import MediaPlayer
import SwiftUI

/// The jukebox tab: a turntable with the record playing, the controls, today's picks and
/// the record shelf (docs/jukebox-client-spec.md; the look follows the UI prototype).
struct JukeboxScreen: View {
    let jukebox: JukeboxStore
    let path: String
    var tabPicker: MainTabPicker? = nil

    @State private var query = ""
    @State private var year: String?
    @State private var series = "すべて"
    @State private var shown = 80

    static let seriesChoices = ["すべて", "本編", "BSM", "B-side", "DANBO-side", "TechnoEdge-side", "Z-side", "その他"]

    var body: some View {
        #if os(iOS)
        NavigationStack {
            content
                .navigationTitle("ジュークボックス")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { if let tabPicker { ToolbarItem(placement: .principal) { tabPicker } } }
        }
        #else
        VStack(spacing: 0) {
            HStack {
                if let tabPicker { tabPicker }
                Spacer()
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
            Divider()
            content
        }
        #endif
    }

    private var content: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                Turntable(jukebox: jukebox)
                NowPlayingCard(jukebox: jukebox)
                picks
                shelf
            }
            .padding(.horizontal, 14)
            .padding(.vertical, 12)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .scrollDismissesKeyboard(.immediately)
        .task { await jukebox.load(path: path) }
        .pullToRefresh { await jukebox.load(path: path, force: true) }
    }

    // MARK: Today's picks

    private var picks: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("きょうの 1 枚").font(.subheadline).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                PickCard(title: "🎲 シャッフル", subtitle: "\(jukebox.episodes.count) 枚からランダムに") { jukebox.playRandom() }
                if let e = jukebox.todayEpisode, let n = jukebox.today?.yearsAgo {
                    PickCard(title: "📅 \(n) 年前の今ごろ", subtitle: e.title) { jukebox.play(e) }
                }
            }
        }
    }

    // MARK: The shelf

    private var years: [String] { jukebox.years }

    private static let mainSeries = Set(seriesChoices.dropFirst().dropLast())

    private var filtered: [Episode] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        if year == nil && series == "すべて" && q.isEmpty { return jukebox.episodes }
        let main = Self.mainSeries
        return jukebox.episodes.filter { e in
            (year == nil || e.year == year)
                && (series == "すべて" || (series == "その他" ? !main.contains(e.series) : e.series == series))
                && (q.isEmpty || jukebox.matches(e, query: q))
        }
    }

    private var shelf: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("レコード棚").font(.subheadline).foregroundStyle(.secondary)
            TextField("タイトルや内容で探す（例：WWDC、ゲスト名）", text: $query)
                .textFieldStyle(.roundedBorder)
                .onChange(of: query) { _, q in if !q.isEmpty { year = nil }; shown = 80 }
            Chips(items: ["すべて"] + years, selected: year ?? "すべて") { y in year = y == "すべて" ? nil : y; shown = 80 }
            Chips(items: Self.seriesChoices, selected: series) { s in series = s; shown = 80 }
            let list = filtered
            if jukebox.episodes.isEmpty {
                Text(jukebox.loadFailed ? "読み込めませんでした。引っ張って再読み込み" : "読み込み中…")
                    .font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 30)
            } else if list.isEmpty {
                Text("見つかりませんでした").font(.callout).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 30)
            }
            LazyVStack(spacing: 0) {
                ForEach(list.prefix(shown)) { e in
                    EpisodeRow(episode: e, isCurrent: jukebox.current?.id == e.id, jukebox: jukebox)
                    Divider()
                }
                if list.count > shown {
                    Button("さらに表示（残り \(list.count - shown) 枚）") { shown += 200 }
                        .buttonStyle(.borderless)
                        .font(.footnote)
                        .padding(.vertical, 10)
                }
            }
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.03)))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.08)))
            .clipShape(RoundedRectangle(cornerRadius: 12))
        }
    }
}

// MARK: - Turntable

/// Label colours by year (the prototype's HUE table).
enum RecordColors {
    private static let hue: [String: Double] = [
        "2014": 4, "2015": 28, "2016": 46, "2017": 88, "2018": 150, "2019": 178, "2020": 200,
        "2021": 222, "2022": 258, "2023": 290, "2024": 322, "2025": 345, "2026": 12,
    ]
    static func label(_ year: String) -> Color {
        Color(hue: (hue[year] ?? 140) / 360, saturation: 0.62, brightness: 0.62)
    }
    /// The same colour for Core Graphics drawing.
    static func labelCG(_ year: String) -> CGColor {
        #if os(iOS)
        UIColor(hue: (hue[year] ?? 140) / 360, saturation: 0.62, brightness: 0.62, alpha: 1).cgColor
        #else
        NSColor(hue: (hue[year] ?? 140) / 360, saturation: 0.62, brightness: 0.62, alpha: 1).cgColor
        #endif
    }
}

/// The record itself: grooves, a sheen and the label. `angle` turns it.
/// Equatable: the turntable turns it from outside, so it is not redrawn every frame.
struct RecordDisc: View, Equatable {
    let episode: Episode?
    var angle: Double = 0
    var showText = true
    var showSheen = true

    var body: some View {
        GeometryReader { g in
            let side = min(g.size.width, g.size.height)
            ZStack {
                Canvas { ctx, size in
                    let r = min(size.width, size.height) / 2
                    let c = CGPoint(x: size.width / 2, y: size.height / 2)
                    ctx.fill(Path(ellipseIn: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2)), with: .color(Color(white: 0.07)))
                    var groove = r * 0.97
                    var i = 0
                    while groove > r * 0.36 {
                        let rect = CGRect(x: c.x - groove, y: c.y - groove, width: groove * 2, height: groove * 2)
                        ctx.stroke(Path(ellipseIn: rect), with: .color(Color(white: i % 2 == 0 ? 0.13 : 0.09)), lineWidth: max(0.5, r / 140))
                        groove -= max(1.2, r / 70)
                        i += 1
                    }
                }
                Circle()
                    .fill(RecordColors.label(episode?.year ?? "2026"))
                    .frame(width: side * 0.34, height: side * 0.34)
                    .overlay {
                        if showText, let e = episode {
                            // Above and below the spindle hole, never over it.
                            VStack(spacing: 0) {
                                Text("BACKSPACE.FM").font(.system(size: max(5, side * 0.02), weight: .medium)).tracking(1).opacity(0.75)
                                Text(e.label).font(.system(size: max(8, side * 0.05), weight: .bold, design: .monospaced))
                                    .minimumScaleFactor(0.6).lineLimit(1)
                                Spacer().frame(height: side * 0.045)
                                Text(e.year).font(.system(size: max(5, side * 0.026))).tracking(2).opacity(0.85)
                            }
                            .padding(.horizontal, side * 0.03)
                            .offset(y: -side * 0.012)
                            .foregroundStyle(.white)
                        }
                    }
                    .overlay(Circle().fill(Color.black.opacity(0.85)).frame(width: side * 0.02, height: side * 0.02))
            }
            .rotationEffect(.degrees(angle))
            .overlay {
                if showSheen { RecordSheen() }
            }
            .frame(width: side, height: side)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .aspectRatio(1, contentMode: .fit)
    }
}

/// The light on the record: it does not turn with it.
struct RecordSheen: View {
    var body: some View {
                Circle().fill(AngularGradient(
                    colors: [.white.opacity(0), .white.opacity(0.09), .white.opacity(0), .white.opacity(0), .white.opacity(0.07), .white.opacity(0)],
                    center: .center, startAngle: .degrees(20), endAngle: .degrees(380)))
                    .allowsHitTesting(false)
    }
}

struct Turntable: View {
    let jukebox: JukeboxStore
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.screenVisibility) private var visibility
    private var onScreen: Bool { visibility?.jukebox ?? true }
    #if os(iOS)
    @Environment(\.scenePhase) private var scenePhase
    #endif

    static let secondsPerTurn = 1.8 // 33⅓ rpm
    #if os(macOS)
    private static let maxSide: CGFloat = 250 // the panel is small: leave room for the controls
    #else
    private static let maxSide: CGFloat = 420
    #endif

    private var spinning: Bool {
        #if os(iOS)
        let active = scenePhase == .active
        #else
        let active = true
        #endif
        return jukebox.isPlaying && !reduceMotion && onScreen && active
    }

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18)
                .fill(LinearGradient(colors: [Color(red: 0.66, green: 0.47, blue: 0.31), Color(red: 0.49, green: 0.33, blue: 0.2)],
                                     startPoint: .topLeading, endPoint: .bottomTrailing))
                .shadow(color: .black.opacity(0.18), radius: 10, y: 6)
            RoundedRectangle(cornerRadius: 14)
                .fill(Color(red: 0.23, green: 0.16, blue: 0.12))
                .padding(16)
            GeometryReader { g in
                let side = min(g.size.width, g.size.height)
                ZStack {
                    Circle().fill(Color(white: 0.16)).padding(side * 0.06)
                        .shadow(color: .black.opacity(0.45), radius: 6, y: 4)
                    // Core Animation turns the record (the render server does it): no view
                    // update per frame. A TimelineView redrew it every frame, also while the
                    // Mac panel was closed (≈ 6 % CPU while a record played).
                    SpinningRecord(disc: RecordDisc(episode: jukebox.current, showSheen: false), spinning: spinning)
                        .overlay { RecordSheen() }
                        .padding(side * 0.085)
                    Tonearm(down: jukebox.isPlaying)
                        .frame(width: side * 0.44, height: side * 0.7)
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topTrailing)
                        .padding(side * 0.02)
                    HStack(spacing: 6) {
                        Circle().fill(jukebox.isPlaying ? Color.green : Color(red: 0.33, green: 0.25, blue: 0.18))
                            .frame(width: 7, height: 7)
                            .shadow(color: jukebox.isPlaying ? .green : .clear, radius: 4)
                        Text("33⅓").font(.system(size: 10, design: .monospaced)).foregroundStyle(Color(white: 0.9).opacity(0.85))
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    .padding(side * 0.05)
                }
            }
            .padding(30)
        }
        .aspectRatio(1, contentMode: .fit)
        .frame(maxWidth: Self.maxSide)
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(jukebox.current.map { "ターンテーブル：\($0.title)" } ?? "ターンテーブル")
    }
}

/// The record in its own hosting view, turned by a Core Animation rotation on that view's
/// layer. Stopping keeps the angle it stopped at, so starting again does not jump.
private struct SpinningRecord {
    let disc: RecordDisc
    let spinning: Bool
}

@MainActor
private enum Spin {
    static let key = "bguru.spin"

    /// Starts or stops turning `layer` (about its centre).
    static func set(_ layer: CALayer?, spinning: Bool) {
        guard let layer else { return }
        let running = layer.animation(forKey: key) != nil
        if spinning {
            guard !running else { return }
            let from = (layer.value(forKeyPath: "transform.rotation.z") as? Double) ?? 0
            let a = CABasicAnimation(keyPath: "transform.rotation.z")
            a.fromValue = from
            a.toValue = from + 2 * .pi
            a.duration = Turntable.secondsPerTurn
            a.repeatCount = .infinity
            a.isRemovedOnCompletion = false
            layer.add(a, forKey: key)
        } else {
            guard running else { return }
            let now = (layer.presentation()?.value(forKeyPath: "transform.rotation.z") as? Double) ?? 0
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            layer.setValue(now, forKeyPath: "transform.rotation.z")
            layer.removeAnimation(forKey: key)
            CATransaction.commit()
        }
    }
}

#if os(iOS)
extension SpinningRecord: UIViewRepresentable {
    func makeUIView(context: Context) -> SpinnerView { SpinnerView(disc: disc) }
    func updateUIView(_ view: SpinnerView, context: Context) {
        if view.host.rootView != disc { view.host.rootView = disc }
        view.wantsSpin = spinning
    }
}

final class SpinnerView: UIView {
    let host: UIHostingController<RecordDisc>
    var wantsSpin = false { didSet { if wantsSpin != oldValue { apply() } } }

    init(disc: RecordDisc) {
        host = UIHostingController(rootView: disc)
        super.init(frame: .zero)
        host.view.backgroundColor = .clear
        host.safeAreaRegions = []
        host.view.isUserInteractionEnabled = false
        addSubview(host.view)
        isUserInteractionEnabled = false
        accessibilityElementsHidden = true
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layoutSubviews() {
        super.layoutSubviews()
        // bounds + center (not frame): the view is rotated.
        host.view.bounds = CGRect(origin: .zero, size: bounds.size)
        host.view.center = CGPoint(x: bounds.midX, y: bounds.midY)
    }

    /// UIKit drops a layer's animations when it leaves the window (a page scrolled away):
    /// stop first, keeping the angle, and start again from there when it is back.
    override func willMove(toWindow newWindow: UIWindow?) {
        if newWindow == nil { Spin.set(host.view.layer, spinning: false) }
        super.willMove(toWindow: newWindow)
    }

    override func didMoveToWindow() {
        super.didMoveToWindow()
        host.view.layer.removeAnimation(forKey: Spin.key)
        apply()
    }

    private func apply() { Spin.set(window == nil ? nil : host.view.layer, spinning: wantsSpin) }
}
#else
extension SpinningRecord: NSViewRepresentable {
    func makeNSView(context: Context) -> SpinnerView { SpinnerView(disc: disc) }
    func updateNSView(_ view: SpinnerView, context: Context) {
        if view.host.rootView != disc { view.host.rootView = disc }
        view.wantsSpin = spinning
    }
}

final class SpinnerView: NSView {
    let host: NSHostingView<RecordDisc>
    var wantsSpin = false { didSet { if wantsSpin != oldValue { apply() } } }

    init(disc: RecordDisc) {
        host = NSHostingView(rootView: disc)
        super.init(frame: .zero)
        wantsLayer = true
        host.wantsLayer = true
        host.sizingOptions = []
        addSubview(host)
        setAccessibilityElement(false)
        host.setAccessibilityElement(false)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func layout() {
        super.layout()
        host.frame = bounds
        centreAnchor()
    }

    /// AppKit backs a view with a layer anchored at its corner: turn it about its centre.
    private func centreAnchor() {
        guard let l = host.layer else { return }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        l.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        l.position = CGPoint(x: host.frame.midX, y: host.frame.midY)
        CATransaction.commit()
    }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        apply()
    }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    private func apply() {
        centreAnchor()
        Spin.set(window == nil ? nil : host.layer, spinning: wantsSpin)
    }
}
#endif

/// The tonearm: up at rest, down on the record while playing.
struct Tonearm: View {
    let down: Bool

    var body: some View {
        GeometryReader { g in
            let w = g.size.width, h = g.size.height
            let pivot = CGPoint(x: w * 0.82, y: h * 0.12)
            ZStack {
                Path { p in
                    p.move(to: pivot)
                    p.addLine(to: CGPoint(x: w * 0.7, y: h * 0.75))
                    p.addLine(to: CGPoint(x: w * 0.52, y: h * 0.91))
                }
                .stroke(Color(white: 0.86), style: StrokeStyle(lineWidth: max(3, w * 0.05), lineCap: .round, lineJoin: .round))
                RoundedRectangle(cornerRadius: 3)
                    .fill(Color(white: 0.17))
                    .frame(width: w * 0.22, height: h * 0.08)
                    .rotationEffect(.degrees(-35))
                    .position(x: w * 0.51, y: h * 0.91)
                Circle().fill(Color(white: 0.8)).frame(width: w * 0.26, height: w * 0.26).position(pivot)
                Circle().fill(Color(white: 0.4)).frame(width: w * 0.12, height: w * 0.12).position(pivot)
            }
            .rotationEffect(.degrees(down ? 2 : -24), anchor: UnitPoint(x: 0.82, y: 0.12))
            .animation(.timingCurve(0.5, 0.1, 0.2, 1, duration: 0.9), value: down)
        }
        .allowsHitTesting(false)
    }
}

// MARK: - Now playing

struct NowPlayingCard: View {
    let jukebox: JukeboxStore

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let e = jukebox.current {
                Text(e.title).font(.headline).fixedSize(horizontal: false, vertical: true)
                HStack(spacing: 10) {
                    Text(e.dateText).monospacedDigit()
                    if let d = e.durationSec { Text(JukeboxFormat.time(Double(d))).monospacedDigit() }
                    Text(e.series)
                }
                .font(.caption).foregroundStyle(.secondary)
                if !e.summary.isEmpty {
                    Text(e.summary).font(.footnote).foregroundStyle(.secondary).lineLimit(3)
                }
                ProgressSlider(jukebox: jukebox, duration: Double(e.durationSec ?? 0))
                controls
            } else {
                Text("レコードを選んでください").font(.headline)
                Text("下の棚から 1 枚選ぶか、🎲 シャッフルでどうぞ。").font(.footnote).foregroundStyle(.secondary)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(Color.primary.opacity(0.08)))
    }

    private var controls: some View {
        HStack(spacing: 14) {
            RoundButton(text: "⟲15", label: "15 秒戻る") { jukebox.skip(-15) }
            Button { jukebox.toggle() } label: {
                ZStack {
                    Circle().fill(Color.accentGreen)
                    if jukebox.isBuffering && jukebox.isPlaying {
                        ProgressView().controlSize(.small).tint(.white)
                    } else {
                        Image(systemName: jukebox.isPlaying ? "pause.fill" : "play.fill").font(.system(size: 20, weight: .bold)).foregroundStyle(.white)
                    }
                }
                .frame(width: 54, height: 54)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(jukebox.isPlaying ? "一時停止" : "再生")
            RoundButton(text: "30⟳", label: "30 秒進む") { jukebox.skip(30) }
            RoundButton(text: JukeboxFormat.rate(jukebox.rate), label: "再生速度") { jukebox.cycleRate() }
            Menu {
                Button("15 分") { jukebox.setSleep(minutes: 15) }
                Button("30 分") { jukebox.setSleep(minutes: 30) }
                Button("60 分") { jukebox.setSleep(minutes: 60) }
                Button("この回の終わりまで") { jukebox.setSleepAtEnd() }
                if jukebox.sleepAt != nil || jukebox.sleepAtEnd { Button("タイマーを止める", role: .destructive) { jukebox.setSleep(minutes: nil) } }
            } label: {
                Image(systemName: jukebox.sleepAt != nil || jukebox.sleepAtEnd ? "moon.zzz.fill" : "moon.zzz")
                    .frame(width: 40, height: 40)
                    .background(Circle().fill(Color.primary.opacity(0.07)))
            }
            .menuStyle(.button)
            .buttonStyle(.plain)
            .fixedSize()
            .accessibilityLabel("スリープタイマー")
        }
        .frame(maxWidth: .infinity)
    }
}

private struct ProgressSlider: View {
    let jukebox: JukeboxStore
    let duration: Double
    @State private var dragging: Double?
    @State private var editing = false

    var body: some View {
        VStack(spacing: 4) {
            Slider(value: Binding(
                get: { dragging ?? jukebox.position },
                // A drag shows where it will land and seeks on release; VoiceOver and the
                // arrow keys (no drag) seek at once.
                set: { v in if editing { dragging = v } else { jukebox.seek(to: v) } }
            ), in: 0...max(duration, jukebox.position + 1, 1)) { isEditing in
                editing = isEditing
                if !isEditing, let d = dragging { jukebox.seek(to: d); dragging = nil }
            }
            .tint(.accentGreen)
            .accessibilityLabel("再生位置")
            HStack {
                Text(JukeboxFormat.time(dragging ?? jukebox.position))
                Spacer()
                Text(JukeboxFormat.time(duration))
            }
            .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
        }
    }
}

private struct RoundButton: View {
    let text: String
    let label: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(text).font(.footnote.weight(.medium)).monospacedDigit()
                .frame(minWidth: 40, minHeight: 40)
                .padding(.horizontal, 4)
                .background(Capsule().fill(Color.primary.opacity(0.07)))
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

private struct PickCard: View {
    let title: String
    let subtitle: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.subheadline.bold())
                Text(subtitle).font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(10)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color.primary.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Color.primary.opacity(0.08)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

private struct Chips: View {
    let items: [String]
    let selected: String
    let onPick: (String) -> Void
    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 6) {
                ForEach(items, id: \.self) { s in
                    Button { onPick(s) } label: {
                        Text(s).font(.caption.weight(s == selected ? .bold : .regular))
                            .padding(.horizontal, 11).padding(.vertical, 6)
                            .foregroundStyle(s == selected ? Color(white: 0.98) : Color.primary)
                            .background(Capsule().fill(s == selected ? Color.primary : Color.primary.opacity(0.07)))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }
}

/// One record on the shelf. Reads how far it was listened to itself: the playing record's
/// bar moves every 10 s, and only its row redraws for that.
private struct EpisodeRow: View {
    let episode: Episode
    let isCurrent: Bool
    let jukebox: JukeboxStore

    var body: some View {
        let fraction = jukebox.fraction(episode, isCurrent: isCurrent)
        Button { jukebox.play(episode) } label: {
            HStack(spacing: 10) {
                MiniDisc(year: episode.year, size: 30)
                VStack(alignment: .leading, spacing: 3) {
                    Text(episode.title).font(.subheadline).lineLimit(2).multilineTextAlignment(.leading)
                    HStack(spacing: 8) {
                        Text(episode.dateText)
                        if let f = fraction, f >= 0.97 {
                            Text("✓ 聴いた")
                        } else if let d = episode.durationSec {
                            Text(JukeboxFormat.time(Double(d)))
                        }
                        if episode.series != "本編" { Text(episode.series) }
                    }
                    .font(.caption2.monospacedDigit()).foregroundStyle(.secondary)
                    if let f = fraction, f > 0, f < 0.97 {
                        ProgressView(value: f).tint(.accentGreen).scaleEffect(x: 1, y: 0.6)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(isCurrent ? Color.accentGreen.opacity(0.12) : Color.clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("再生します")
    }
}

struct MiniDisc: View {
    let year: String?
    let size: CGFloat
    var body: some View {
        ZStack {
            Circle().fill(Color(white: 0.1))
            Circle().stroke(Color(white: 0.17), lineWidth: 1).padding(size * 0.12)
            Circle().stroke(Color(white: 0.17), lineWidth: 1).padding(size * 0.22)
            Circle().fill(RecordColors.label(year ?? "2026")).frame(width: size * 0.36, height: size * 0.36)
        }
        .frame(width: size, height: size)
    }
}

extension EnvironmentValues {
    /// The jukebox when it is on for this member (timeline posts with an episode's
    /// audio play it here instead of saying "Web で再生").
    @Entry var jukebox: JukeboxStore? = nil
}

// MARK: - Mini player (under every tab)

struct JukeboxMiniPlayer: View {
    let jukebox: JukeboxStore
    let onOpen: () -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if let e = jukebox.current {
            HStack(spacing: 10) {
                Button(action: onOpen) {
                    HStack(spacing: 10) {
                        TimelineView(.animation(paused: !jukebox.isPlaying || reduceMotion)) { tl in
                            MiniDisc(year: e.year, size: 34)
                                .rotationEffect(.degrees(jukebox.isPlaying && !reduceMotion
                                    ? tl.date.timeIntervalSinceReferenceDate.truncatingRemainder(dividingBy: 1.8) / 1.8 * 360 : 0))
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(e.title).font(.caption).lineLimit(1)
                            Text(jukebox.notice ?? (jukebox.pausedForVoice ? "ボイスに入ったので一時停止中" : "\(e.dateText) ・ \(JukeboxFormat.time(jukebox.position))"))
                                .font(.caption2).foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if jukebox.pausedForVoice && !jukebox.voiceBusy() {
                    Button("続きを再生") { jukebox.resume() }
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.borderless)
                }
                Button { jukebox.toggle() } label: {
                    Image(systemName: jukebox.isPlaying ? "pause.fill" : "play.fill")
                        .font(.system(size: 14, weight: .bold)).foregroundStyle(.white)
                        .frame(width: 34, height: 34)
                        .background(Circle().fill(Color.accentGreen))
                }
                .buttonStyle(.plain)
                .accessibilityLabel(jukebox.isPlaying ? "一時停止" : "再生")
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .background(.bar)
            .overlay(alignment: .top) { Divider() }
        }
    }
}

// MARK: - Formatting, artwork

enum JukeboxFormat {
    static func time(_ s: Double) -> String {
        let t = Int(max(0, s.isFinite ? s : 0))
        let h = t / 3600, m = (t % 3600) / 60, sec = t % 60
        return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
    }
    static func rate(_ r: Float) -> String {
        r == r.rounded() ? String(format: "%.1f×", r) : String(format: "%g×", r)
    }
}

/// The lock screen / Control Center picture: the record with its label.
@MainActor
enum RecordArtwork {
    /// Drawn with Core Graphics, with no text. It used SwiftUI's ImageRenderer, and on the
    /// Mac rendering text that way could leave the app's shared glyph cache upside down —
    /// chat text then showed with every character flipped (reported 2026-10-19).
    static func make(for e: Episode) -> MPMediaItemArtwork? {
        let side = 600
        guard let ctx = CGContext(data: nil, width: side, height: side, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        let full = CGRect(x: 0, y: 0, width: side, height: side)
        ctx.setFillColor(CGColor(srgbRed: 0.23, green: 0.16, blue: 0.12, alpha: 1))
        ctx.fill(full)
        let c = CGPoint(x: full.midX, y: full.midY)
        let r = CGFloat(side) * 0.44
        ctx.setFillColor(CGColor(gray: 0.07, alpha: 1))
        ctx.fillEllipse(in: CGRect(x: c.x - r, y: c.y - r, width: r * 2, height: r * 2))
        var groove = r * 0.97
        var i = 0
        ctx.setLineWidth(1.2)
        while groove > r * 0.36 {
            ctx.setStrokeColor(CGColor(gray: i % 2 == 0 ? 0.13 : 0.09, alpha: 1))
            ctx.strokeEllipse(in: CGRect(x: c.x - groove, y: c.y - groove, width: groove * 2, height: groove * 2))
            groove -= 6
            i += 1
        }
        let lr = r * 0.34
        ctx.setFillColor(RecordColors.labelCG(e.year))
        ctx.fillEllipse(in: CGRect(x: c.x - lr, y: c.y - lr, width: lr * 2, height: lr * 2))
        ctx.setFillColor(CGColor(gray: 0.05, alpha: 0.9))
        ctx.fillEllipse(in: CGRect(x: c.x - 7, y: c.y - 7, width: 14, height: 14))
        guard let cg = ctx.makeImage() else { return nil }
        #if os(iOS)
        let img = UIImage(cgImage: cg)
        #else
        let img = NSImage(cgImage: cg, size: NSSize(width: side, height: side))
        #endif
        return artwork(img)
    }

    /// MediaPlayer asks for the picture on its own queue: the closure must not be
    /// tied to the main actor (it was, and that crashed on the first play).
    private nonisolated static func artwork(_ img: PlatformImage) -> MPMediaItemArtwork {
        nonisolated(unsafe) let image = img
        return MPMediaItemArtwork(boundsSize: image.size) { @Sendable _ in image }
    }
}
