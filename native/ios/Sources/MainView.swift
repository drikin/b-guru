import SwiftUI

/// The page on screen (iPhone) and the iPad's left column. A class, so that the views that
/// show the pages do not read it in their own body: only the small views that need the
/// page (the switch, each page's "on screen" flag) follow it.
@MainActor
@Observable
final class PagerState {
    var tab: MainTab = .chat
    /// The page that has settled after a switch (the page scroll has finished): what reads
    /// the page (marking read, the record turning, polling) follows this, not `tab`, so the
    /// switch's animation is not also doing that work.
    var settledTab: MainTab = .chat
    var leftTab: MainTab = .timeline
}

/// The switch shown in place of every page's title (shared screens take it as their picker).
typealias MainTabPicker = PagePicker

/// iPhone (compact): chat and timeline side by side as pages — swipe left/right or
/// use the switch at the top. iPad (regular): both at once, timeline left, chat right.
struct MainView: View {
    let store: ChatStore
    let timeline: TimelineStore
    let onSignOut: () -> Void

    @Environment(\.horizontalSizeClass) private var hSize
    @State private var pager = PagerState()
    /// What can be seen (the settled page, the app active), for the views inside.
    @State private var visibility = ScreenVisibility()
    /// How much of the screen a docked software keyboard covers (iPhone pager, iPad columns).
    @State private var keyboard = KeyboardLift()
    /// iPad: the timeline column's width (dragged at the line; kept between launches).
    @AppStorage("ipadTimelineWidth") private var leftWidth: Double = ColumnSplit.defaultWidth

    var body: some View {
        // No mini player under the timeline and the chat (drikin 2026-10-20: not needed —
        // the jukebox tab, the lock screen and Control Center play and pause).
        // This body does not read the page: switching re-runs only the switch and the pages'
        // "on screen" flags, not the three navigation stacks (their bars were all rebuilt on
        // every switch and every unread change).
        layout
            .environment(\.jukebox, jukeboxOn ? store.jukebox : nil)
            // 「チャットに引用」 / 「ネタ帳に送る」 / a post's link in the chat: closures made
            // once (store.showChat, set on appear, shows the chat page).
            .environment(\.quoteToChat, store.quoteToChat)
            .environment(\.watch, store.watch.enabled ? store.watch : nil)
            #if DEBUG
            // Dev only: BGURU_DEMO_NETA_READER=<url> → the 📝 page with the article browser open, over everything
            // (the demo has no 📝 tab; the page itself stays empty without a token).
            .overlay { if ProcessInfo.processInfo.environment["BGURU_DEMO_NETA_READER"] != nil { NetaScreen(path: "/neta/app/enter") } }
            .task {
                if let s = ProcessInfo.processInfo.environment["BGURU_DEMO_NETA_READER"], let u = URL(string: s) {
                    NetaTabWeb.shared.reader.open(u)
                }
            }
            #endif
            // 📺 floating over every page (a 「みんなで見る」 on the timeline opens it here).
            .overlay {
                if store.watch.open && store.watch.mode == .floating {
                    if store.overlay.enabled {
                        // チャットの上に重ねる形: 📺's small window (hidden while typing / another is expanded — a chip
                        // then); ⤢ expands it over the chat; kept off the switch row and the message box.
                        if store.overlay.watchFloats {
                            WatchFloatingView(watch: store.watch, onDock: { [overlay = store.overlay] in overlay.expand(.watch) },
                                              insets: EdgeInsets(top: 96, leading: 0, bottom: 64, trailing: 0), remember: true, smallWidth: OverlayModel.floatingWatchWidth)
                        }
                    } else {
                        WatchFloatingView(watch: store.watch)
                    }
                }
            }
            .environment(\.sendToNeta, store.sendToNeta)
            .sheet(item: Binding(get: { store.netaPost }, set: { store.netaPost = $0 })) { post in
                NetaSheet(post: post, store: store) { store.netaPost = nil }
                    .presentationDetents([.medium, .large])
            }
            .environment(\.openURL, timeline.postLinkAction)
            .task(id: jukeboxOn) { if jukeboxOn { await store.jukebox.load(path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox") } }
            .environment(\.screenVisibility, visibility)
            .background(PagerWatcher(pager: pager, visibility: visibility, store: store, timeline: timeline, jukeboxOn: jukeboxOn, paged: hSize != .regular))
            .onAppear {
                let pager = pager
                store.showChat = { pager.tab = .chat }
                Keyboard.startTracking()
                #if DEBUG
                // BGURU_DEMO_TAB=timeline|jukebox|neta|script: start on that page (the orientation check).
                switch ProcessInfo.processInfo.environment["BGURU_DEMO_TAB"] {
                case "timeline": pager.tab = .timeline; pager.settledTab = .timeline
                case "jukebox": pager.tab = .jukebox; pager.settledTab = .jukebox
                case "neta": pager.tab = .neta; pager.settledTab = .neta
                case "script": pager.tab = .script; pager.settledTab = .script
                default: break
                }
                #endif
            }
    }

    private var jukeboxOn: Bool { store.capabilities?.jukeboxEnabled ?? false }
    private var jukeboxPath: String { store.capabilities?.jukeboxPath ?? "/api/agent/jukebox" }
    /// 📝 ネタ帳のタブの入口（nil = タブなし）。
    private var netaPath: String? { store.capabilities?.netaTabPath }
    /// 📜 台本のタブの入口（nil = タブなし）。
    private var scriptPath: String? { store.capabilities?.scriptTabPath }

    @ViewBuilder private var layout: some View {
        if hSize == .regular {
            // The line between the timeline and the chat can be dragged (drikin 2026-11-24);
            // the width is remembered. Double-tap the line to go back to the usual width.
            GeometryReader { g in
                let width = ColumnSplit.clamp(leftWidth, total: g.size.width)
                HStack(spacing: 0) {
                    LeftColumn(store: store, timeline: timeline, pager: pager, jukeboxOn: jukeboxOn, onSignOut: onSignOut)
                        .frame(width: width)
                    Divider()
                        .overlay { ColumnSplitHandle(width: $leftWidth, current: width, total: g.size.width) }
                        .zIndex(1)
                    ChatScreen(store: store, onSignOut: onSignOut)
                }
            }
            // Our own keyboard avoidance, as on iPhone: only a keyboard docked at the bottom lifts the
            // reply box and the composer (each screen, pageKeyboardAvoidanceOff). SwiftUI's own kept a docked
            // keyboard's height free under the floating keyboard (リュー 2026-11-27: 固定キーボードの幅の余白).
            .environment(keyboard)
            .ignoresSafeArea(.keyboard)
            .background(KeyboardOverlapReader(keyboard: keyboard).ignoresSafeArea(.keyboard))
        } else {
            let picker = PagePicker(store: store, pager: pager, jukeboxOn: jukeboxOn)
            // A paging ScrollView, not TabView(.page): the paged TabView is a UICollectionView
            // that re-lays out and re-uses its cells while a swipe is under way (the keyboard
            // going down as the page changes did it every time), and a page's navigation
            // stack could end up shown in another cell's navigation bar — UIKit then threw
            // "Layout requested for visible navigation bar … when the top item belongs to a
            // different navigation bar" (iOS 27, swiping from the chat with the keyboard up;
            // simulator 10 of 20 swipes). Here the pages are plain views that stay put.
            GeometryReader { g in
                ScrollViewReader { proxy in
                    ScrollView(.horizontal) {
                        HStack(spacing: 0) {
                            // 部活一覧: one more swipe left of the timeline (リュー 2026-11-09「タイムラインから
                            // さらに左側にスワイプすると部活一覧が出るようにしても良いかも」). A pick goes back to it.
                            ClubListPage(timeline: timeline, pager: pager)
                                .frame(width: g.size.width, height: g.size.height)
                                .id(MainTab.clubs)
                            TimelineScreen(timeline: timeline, capabilities: store.capabilities, tabPicker: picker, onReconnect: onSignOut)
                                .frame(width: g.size.width, height: g.size.height)
                                .id(MainTab.timeline)
                            ChatScreen(store: store, onSignOut: onSignOut, tabPicker: picker)
                                .frame(width: g.size.width, height: g.size.height)
                                .id(MainTab.chat)
                            // ✉️ DM: a page of its own right after 💬 (the list, a conversation pushed over it).
                            // オーナー 2026-11-08「アプリ版のDMを素直にチャットの右のタブに移動」
                            if store.dm.enabled {
                                DMTabScreen(dm: store.dm, tabPicker: AnyView(picker))
                                        .frame(width: g.size.width, height: g.size.height)
                                    .id(MainTab.dm)
                            }
                            // 📝 ネタ帳: ✉️ と 📻 の間（オーナー 2026-11-14「DM とプレイヤーの間のタブにネタ帳」）。
                            if let netaPath {
                                NetaScreen(path: netaPath, tabPicker: picker)
                                    .frame(width: g.size.width, height: g.size.height)
                                    .id(MainTab.neta)
                            }
                            if jukeboxOn {
                                JukeboxScreen(jukebox: store.jukebox, path: jukeboxPath, tabPicker: picker)
                                        .frame(width: g.size.width, height: g.size.height)
                                    .id(MainTab.jukebox)
                            }
                            // 📜 台本: いちばん右（オーナー 2026-11-14「アプリは 1 番右のタブに追加」）。
                            if let scriptPath {
                                NetaScreen(path: scriptPath, title: "台本", web: .script, tabPicker: picker)
                                    .frame(width: g.size.width, height: g.size.height)
                                    .id(MainTab.script)
                            }
                        }
                        .scrollTargetLayout()
                        // Inside a thread / a DM conversation the edge swipe is "back" only: the pages stay
                        // (drikin 2026-11-21: both moved — the stack went back and the page changed too).
                        .background { PagerScrollLock(pager: pager, timeline: timeline, dm: store.dm) }
                    }
                    .scrollTargetBehavior(.paging)
                    .scrollIndicators(.hidden)
                    .scrollPosition(id: Binding<MainTab?>(get: { pager.tab }, set: { if let t = $0 { pager.tab = t } }))
                    .onAppear { proxy.scrollTo(pager.tab) }
                }
            }
            .ignoresSafeArea(.container, edges: .bottom)
            // A ScrollView does not move its content out of the keyboard's way: the pages stay
            // full height and each screen lifts its own content (pageKeyboardAvoidanceOff), so the chat
            // composer, a thread's reply box and the record shelf's search stay above it.
            .environment(keyboard)
            .ignoresSafeArea(.keyboard)
            .background(KeyboardOverlapReader(keyboard: keyboard).ignoresSafeArea(.keyboard))
        }
    }
}

/// iPad: the left column switches between the timeline, ✉️ DM and the jukebox (the chat stays on the right).
private struct LeftColumn: View {
    let store: ChatStore
    let timeline: TimelineStore
    let pager: PagerState
    let jukeboxOn: Bool
    let onSignOut: () -> Void

    var body: some View {
        let picker = PagePicker(store: store, pager: pager, jukeboxOn: jukeboxOn, leftColumn: true)
        if pager.leftTab == .jukebox && jukeboxOn {
            JukeboxScreen(jukebox: store.jukebox, path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox", tabPicker: picker)
        } else if pager.leftTab == .dm && store.dm.enabled {
            DMTabScreen(dm: store.dm, tabPicker: AnyView(picker))
        } else if pager.leftTab == .neta, let path = store.capabilities?.netaTabPath {
            NetaScreen(path: path, tabPicker: picker)
        } else if pager.leftTab == .script, let path = store.capabilities?.scriptTabPath {
            NetaScreen(path: path, title: "台本", web: .script, tabPicker: picker)
        } else {
            TimelineScreen(timeline: timeline, capabilities: store.capabilities, tabPicker: jukeboxOn || store.dm.enabled || store.capabilities?.netaTabPath != nil || store.capabilities?.scriptTabPath != nil ? picker : nil, onReconnect: onSignOut)
        }
    }
}

/// What follows the page, kept out of MainView's body.
private struct PagerWatcher: View {
    let pager: PagerState
    let visibility: ScreenVisibility
    let store: ChatStore
    let timeline: TimelineStore
    let jukeboxOn: Bool
    let paged: Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var settle: Task<Void, Never>?

    /// The settled page (iPhone) or the columns (iPad), while the app is active. The chat's
    /// read state and the timeline's polling are set from here, not by the pages: a page
    /// scrolled off screen does not update until it comes back.
    private func updateVisibility() {
        let active = scenePhase == .active
        let dmShown: Bool
        if paged {
            let page = pager.settledTab
            visibility.set(timeline: page == .timeline && active, chat: page == .chat && active,
                           jukebox: page == .jukebox && active, room: page == .chat && active)
            dmShown = page == .dm && active
        } else {
            let left = pager.leftTab
            visibility.set(timeline: left == .timeline && active, chat: active,
                           jukebox: left == .jukebox && active, room: active)
            dmShown = left == .dm && active
        }
        // ✉️ read marks (and 「表示中なら知らせない」) only while the DM page is what is on screen.
        if store.dm.appVisible != dmShown { store.dm.appVisible = dmShown }
        // The page came forward with nothing open: the list (read again).
        if dmShown, store.dm.route == nil { store.dm.showList() }
        if store.isVisible != visibility.chat { store.isVisible = visibility.chat }
        if visibility.timeline { timeline.startPolling() } else { timeline.stopPolling() }
    }

    var body: some View {
        Color.clear
            .onAppear { updateVisibility() }
            .onChange(of: pager.settledTab) { _, _ in updateVisibility() }
            .onChange(of: pager.leftTab) { _, _ in updateVisibility() }
            .onChange(of: scenePhase) { _, phase in
                updateVisibility()
                if phase == .background { store.scenePhaseChanged(background: true); store.watch.setBackground(true) }
                if phase == .active { store.scenePhaseChanged(background: false); store.watch.setBackground(false) }
            }
            .onChange(of: paged) { _, _ in updateVisibility() }
            // チャットの上に重ねる形: off the chat page a floating 📺 shows whatever the chat has expanded.
            .onChange(of: paged ? pager.tab == .chat : true, initial: true) { _, on in store.overlay.chatPageShown = on }
            .onChange(of: jukeboxOn) { _, on in
                if !on { if pager.tab == .jukebox { pager.tab = .chat }; if pager.leftTab == .jukebox { pager.leftTab = .timeline } }
            }
            .onChange(of: store.capabilities?.netaTabPath != nil) { _, on in
                if !on { if pager.tab == .neta { pager.tab = .chat }; if pager.leftTab == .neta { pager.leftTab = .timeline } }
            }
            .onChange(of: store.capabilities?.scriptTabPath != nil) { _, on in
                if !on { if pager.tab == .script { pager.tab = .chat }; if pager.leftTab == .script { pager.leftTab = .timeline } }
            }
            .onChange(of: store.dm.enabled) { _, on in
                if !on { if pager.tab == .dm { pager.tab = .chat }; if pager.leftTab == .dm { pager.leftTab = .timeline } }
            }
            // A name in the chat, a notification, …: DMStore.open → the ✉️ page shows it (also one made
            // before this view was up: a notification that launched the app).
            .onChange(of: store.dm.openRequest, initial: true) { _, n in
                guard n > 0 else { return }
                if paged { pager.tab = .dm } else { pager.leftTab = .dm }
            }
            .onChange(of: timeline.openThreadRequest, initial: true) { _, n in
                guard n > 0 else { return }
                // iPad: a notification opening a thread brings the timeline back to the left column.
                if paged { pager.tab = .timeline } else { pager.leftTab = .timeline }
            }
            // A chat notification (ChatStore.reveal): the 💬 page (the iPad shows the chat beside the list).
            .onChange(of: store.revealRequest, initial: true) { _, n in
                guard n > 0, paged else { return }
                pager.tab = .chat
            }
            .onChange(of: pager.tab) { _, t in
                // 部活一覧: its unread counts again (what was read on the timeline meanwhile).
                if t == .clubs { Task { await timeline.loadClubUnread() } }
                // Switching pages hides the keyboard (it used to stay up over the timeline);
                // only when it is up — resigning the first responder is not free.
                Keyboard.dismissIfShown()
                // Read state, the record and polling follow once the page has settled (the
                // same wait as opening a thread on a page: OpenThreadWhenShown).
                settle?.cancel()
                settle = Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(350))
                    guard !Task.isCancelled, pager.tab == t else { return }
                    pager.settledTab = t
                }
            }
    }
}

/// 📰 タイムライン ・ 💬 チャット ・ ✉️ DM ・ 📝 ネタ帳 ・ 📻 プレイヤー ・ 📜 台本 — the same order and marks in every app
/// (drikin 2026-10-20; ✉️ after 💬 since 2026-11-08; 📝 between ✉️ and 📻 and 📜 the rightmost since 2026-11-14). Plain Text segments (a segmented picker is a UISegmentedControl).
/// Its own view: it reads the page and the unread counts, so only it redraws when they change.
/// Unread is a mark over a segment (a dot on 💬, the count on ✉️), not in the label: a label that
/// changed width re-laid out the navigation bar of every page.
struct PagePicker: View, @MainActor Equatable {
    let store: ChatStore
    let pager: PagerState
    let jukeboxOn: Bool
    /// iPad: the left column's 📰 / ✉️ / 📻 switch.
    var leftColumn = false

    static func == (a: Self, b: Self) -> Bool {
        a.store === b.store && a.pager === b.pager && a.jukeboxOn == b.jukeboxOn && a.leftColumn == b.leftColumn
    }

    /// One segment's width (the marks are one emoji each).
    private static let segment: CGFloat = 52

    var body: some View {
        let dmOn = store.dm.enabled
        let netaOn = store.capabilities?.netaTabPath != nil
        let scriptOn = store.capabilities?.scriptTabPath != nil
        if leftColumn {
            let tabs: [MainTab] = [.timeline] + (dmOn ? [.dm] : []) + (netaOn ? [.neta] : []) + (jukeboxOn ? [.jukebox] : []) + (scriptOn ? [.script] : [])
            let width = Self.segment * CGFloat(tabs.count) + 10
            Picker("表示", selection: Binding(get: { pager.leftTab }, set: { v in withAnimation(.easeOut(duration: 0.2)) { pager.leftTab = v } })) {
                ForEach(tabs, id: \.self) { Text(Self.mark($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(width: width)
            .overlay(alignment: .topLeading) {
                if let i = tabs.firstIndex(of: .dm) { DMCountBadge(dm: store.dm, x: width / CGFloat(tabs.count) * CGFloat(i + 1) - 14) }
            }
            .id(tabs) // a new control for a different number of segments, not an update
        } else {
            let tabs: [MainTab] = [.timeline, .chat] + (dmOn ? [.dm] : []) + (netaOn ? [.neta] : []) + (jukeboxOn ? [.jukebox] : []) + (scriptOn ? [.script] : [])
            let width = Self.segment * CGFloat(tabs.count)
            let step = width / CGFloat(tabs.count)
            Picker("表示", selection: Binding(get: { pager.tab }, set: { v in withAnimation(.easeOut(duration: 0.2)) { pager.tab = v } })) {
                ForEach(tabs, id: \.self) { Text(Self.mark($0)).tag($0) }
            }
            .pickerStyle(.segmented)
            .frame(width: width)
            .overlay(alignment: .topLeading) { UnreadDot(store: store, x: step * 2 - 12) }
            .overlay(alignment: .topLeading) {
                if dmOn { DMCountBadge(dm: store.dm, x: step * 3 - 14) }
            }
            .id(tabs) // a new control for a different number of segments, not an update
        }
    }

    private static func mark(_ t: MainTab) -> String {
        switch t {
        case .timeline: return "📰"
        case .chat: return "💬"
        case .dm: return "✉️"
        case .neta: return "📝"
        case .jukebox: return "📻"
        case .script: return "📜"
        case .clubs: return "🏷"
        }
    }
}

/// iPhone: the club list's page (left of the timeline).
private struct ClubListPage: View {
    let timeline: TimelineStore
    let pager: PagerState

    var body: some View {
        NavigationStack {
            ClubListView(timeline: timeline) {
                withAnimation(.easeOut(duration: 0.25)) { pager.tab = .timeline }
            }
            .navigationTitle("部活")
            .inlineNavigationTitle()
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { withAnimation(.easeOut(duration: 0.25)) { pager.tab = .timeline } } label: {
                        Image(systemName: "chevron.right")
                    }
                    .accessibilityLabel("タイムラインへ")
                }
            }
        }
    }
}

/// The unread mark on the 💬 segment (reads the count itself).
private struct UnreadDot: View {
    let store: ChatStore
    let x: CGFloat
    var body: some View {
        Circle()
            .fill(Color.accentGreen)
            .frame(width: 7, height: 7)
            .offset(x: x, y: 5)
            .opacity(store.unreadCount > 0 ? 1 : 0)
            .allowsHitTesting(false)
            .accessibilityHidden(store.unreadCount == 0)
            .accessibilityLabel("チャットに未読あり")
    }
}

/// ✉️'s unread count (1:1 and groups together) over its segment — what the old ✉️ button showed.
private struct DMCountBadge: View {
    let dm: DMStore
    let x: CGFloat
    var body: some View {
        let n = dm.totalUnread
        Text(n > 99 ? "99+" : "\(n)")
            .font(.system(size: 11, weight: .bold)).monospacedDigit()
            .foregroundStyle(.white)
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(Capsule().fill(Color.red))
            .fixedSize()
            .offset(x: x, y: -6)
            .opacity(n > 0 ? 1 : 0)
            .allowsHitTesting(false)
            .accessibilityHidden(n == 0)
            .accessibilityLabel("DM、未読 \(n) 件")
    }
}

/// Follows the software keyboard's frame (UIKit's keyboard notifications) and turns it into
/// how much of the pager it covers. Moves with the keyboard's own animation.
private struct KeyboardOverlapReader: UIViewRepresentable {
    let keyboard: KeyboardLift

    func makeUIView(context: Context) -> ReaderView {
        let view = ReaderView()
        let keyboard = keyboard
        view.onChange = { height, animated in
            guard keyboard.height != height else { return }
            if animated {
                // The keyboard's curve (UIView.AnimationCurve 7) as a spring.
                withAnimation(.interpolatingSpring(mass: 3, stiffness: 1000, damping: 500)) { keyboard.height = height }
            } else {
                keyboard.height = height
            }
        }
        return view
    }

    func updateUIView(_ uiView: ReaderView, context: Context) {}

    final class ReaderView: UIView {
        var onChange: ((CGFloat, Bool) -> Void)?
        /// The keyboard's last frame, in screen coordinates (nil = hidden).
        private var keyboardFrame: CGRect?

        override init(frame: CGRect) {
            super.init(frame: frame)
            isUserInteractionEnabled = false
            let nc = NotificationCenter.default
            nc.addObserver(self, selector: #selector(keyboardWillChange(_:)), name: UIResponder.keyboardWillChangeFrameNotification, object: nil)
            nc.addObserver(self, selector: #selector(keyboardWillHide(_:)), name: UIResponder.keyboardWillHideNotification, object: nil)
        }

        required init?(coder: NSCoder) { fatalError() }

        @objc private func keyboardWillChange(_ note: Notification) {
            keyboardFrame = (note.userInfo?[UIResponder.keyboardFrameEndUserInfoKey] as? NSValue)?.cgRectValue
            report(animated: ((note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0) > 0)
        }

        @objc private func keyboardWillHide(_ note: Notification) {
            keyboardFrame = nil
            report(animated: ((note.userInfo?[UIResponder.keyboardAnimationDurationUserInfoKey] as? Double) ?? 0) > 0)
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            report(animated: false) // rotation, Split View: the pager's frame changed
        }

        private func report(animated: Bool) {
            guard let window else { return }
            var height: CGFloat = 0
            if let frame = keyboardFrame, !frame.isEmpty {
                let inWindow = window.convert(frame, from: window.screen.coordinateSpace)
                let mine = convert(inWindow, from: window)
                // Only a keyboard docked at the bottom (one that reaches our bottom edge and spans our
                // width) moves the page; the iPad's floating keyboard is a small box over it.
                if mine.maxY >= bounds.maxY - 1, mine.width >= bounds.width - 1 { height = max(0, bounds.maxY - mine.minY) }
            }
            onChange?(height.rounded(), animated)
        }
    }
}


/// Turns the page scroll (the horizontal paging ScrollView it sits in) off while the page on screen
/// has something pushed over its list (a thread, a DM conversation), on again when it is back.
/// Its own view, so only it follows the page and the stacks (not MainView's body with every page).
/// UIKit's own switch: SwiftUI's `.scrollDisabled` is inherited by every scroll view inside the
/// pages, which would also stop the thread and the conversation from scrolling.
private struct PagerScrollLock: View {
    let pager: PagerState
    let timeline: TimelineStore
    let dm: DMStore

    var body: some View {
        let locked: Bool = switch pager.tab {
        case .timeline: timeline.threadShown
        case .dm: dm.enabled && dm.isDeep
        default: false
        }
        PagerScrollSwitch(locked: locked).allowsHitTesting(false)
    }
}

private struct PagerScrollSwitch: UIViewRepresentable {
    let locked: Bool

    final class Marker: UIView {
        var locked = false { didSet { apply() } }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            apply()
        }
        func apply() {
            var v = superview
            while let s = v, !(s is UIScrollView) { v = s.superview }
            guard let pager = v as? UIScrollView, pager.isScrollEnabled == locked else { return }
            pager.isScrollEnabled = !locked
        }
    }

    func makeUIView(context: Context) -> Marker {
        let m = Marker()
        m.isUserInteractionEnabled = false
        m.locked = locked
        return m
    }

    func updateUIView(_ m: Marker, context: Context) {
        if m.locked != locked { m.locked = locked }
    }
}

/// iPad: how wide the timeline column may be next to the chat.
enum ColumnSplit {
    static let defaultWidth: Double = 420
    static let minLeft: Double = 300
    static let minRight: Double = 340

    /// Keeps both columns usable at the current window width (Split View / Stage Manager
    /// windows can be narrow): the timeline at least minLeft, the chat at least minRight.
    static func clamp(_ w: Double, total: Double) -> Double {
        let upper = max(minLeft, total - minRight)
        return min(max(w, minLeft), upper)
    }
}

/// The grab area on the line between the columns: wider than the line so a finger or the
/// pointer finds it, with a small grip in the middle. Drag to resize, double-tap to reset.
private struct ColumnSplitHandle: View {
    @Binding var width: Double
    let current: Double
    let total: Double
    @State private var start: Double?

    var body: some View {
        Color.clear
            .frame(width: 20)
            .contentShape(Rectangle())
            .overlay {
                Capsule()
                    .fill(start == nil ? Color.secondary.opacity(0.35) : Color.accentColor)
                    .frame(width: 5, height: 44)
            }
            .hoverEffect(.highlight)
            .gesture(
                DragGesture(minimumDistance: 2, coordinateSpace: .global)
                    .onChanged { v in
                        let s = start ?? current
                        if start == nil { start = s }
                        width = ColumnSplit.clamp(s + v.translation.width, total: total)
                    }
                    .onEnded { _ in start = nil }
            )
            .onTapGesture(count: 2) {
                withAnimation(.snappy) { width = ColumnSplit.defaultWidth }
            }
            .accessibilityElement()
            .accessibilityLabel("タイムラインとチャットの境界")
            .accessibilityValue("\(Int(current)) ポイント")
            .accessibilityAdjustableAction { dir in
                switch dir {
                case .increment: width = ColumnSplit.clamp(current + 40, total: total)
                case .decrement: width = ColumnSplit.clamp(current - 40, total: total)
                @unknown default: break
                }
            }
    }
}
