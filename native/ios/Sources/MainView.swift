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
            }
    }

    private var jukeboxOn: Bool { store.capabilities?.jukeboxEnabled ?? false }
    private var jukeboxPath: String { store.capabilities?.jukeboxPath ?? "/api/agent/jukebox" }

    @ViewBuilder private var layout: some View {
        if hSize == .regular {
            HStack(spacing: 0) {
                LeftColumn(store: store, timeline: timeline, pager: pager, jukeboxOn: jukeboxOn, onSignOut: onSignOut)
                    .frame(minWidth: 320, idealWidth: 420, maxWidth: 480)
                Divider()
                ChatScreen(store: store, onSignOut: onSignOut)
            }
        } else {
            let picker = PagePicker(store: store, pager: pager, jukeboxOn: jukeboxOn)
            TabView(selection: $pager.tab) {
                TimelineScreen(timeline: timeline, capabilities: store.capabilities, tabPicker: picker, onReconnect: onSignOut)
                    .tag(MainTab.timeline)
                ChatScreen(store: store, onSignOut: onSignOut, tabPicker: picker)
                    .tag(MainTab.chat)
                if jukeboxOn {
                    JukeboxScreen(jukebox: store.jukebox, path: jukeboxPath, tabPicker: picker)
                        .tag(MainTab.jukebox)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            // The jukebox page appears once the server says it is on (after launch). Paged
            // TabView is a collection view underneath: a page inserted mid-layout tripped
            // UIKit's item-count assertion and the app crashed at launch (0.2.16–0.2.20).
            // A different set of pages is a new TabView instead of an update.
            .id(jukeboxOn)
            .ignoresSafeArea(.container, edges: .bottom)
        }
    }
}

/// iPad: the left column switches between the timeline and the jukebox.
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
        } else {
            TimelineScreen(timeline: timeline, capabilities: store.capabilities, tabPicker: jukeboxOn ? picker : nil, onReconnect: onSignOut)
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
        if paged {
            let page = pager.settledTab
            visibility.set(timeline: page == .timeline && active, chat: page == .chat && active,
                           jukebox: page == .jukebox && active, room: page == .chat && active)
        } else {
            let left = pager.leftTab
            visibility.set(timeline: left == .timeline && active, chat: active,
                           jukebox: left == .jukebox && active, room: active)
        }
        if store.isVisible != visibility.chat { store.isVisible = visibility.chat }
        if visibility.timeline { timeline.startPolling() } else { timeline.stopPolling() }
    }

    var body: some View {
        Color.clear
            .onAppear { updateVisibility() }
            .onChange(of: pager.settledTab) { _, _ in updateVisibility() }
            .onChange(of: pager.leftTab) { _, _ in updateVisibility() }
            .onChange(of: scenePhase) { _, _ in updateVisibility() }
            .onChange(of: paged) { _, _ in updateVisibility() }
            .onChange(of: jukeboxOn) { _, on in
                if !on { if pager.tab == .jukebox { pager.tab = .chat }; pager.leftTab = .timeline }
            }
            .onChange(of: timeline.openThread) { _, id in
                guard id != nil else { return }
                // iPad: a notification opening a thread brings the timeline back to the left column.
                if paged { pager.tab = .timeline } else { pager.leftTab = .timeline }
            }
            .onChange(of: pager.tab) { _, t in
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

/// 📰 タイムライン ・ 💬 チャット ・ 📻 プレイヤー — the same order and marks in every app
/// (drikin 2026-10-20). Plain Text segments (a segmented picker is a UISegmentedControl).
/// Its own view: it reads the page and the unread count, so only it redraws when they change.
/// Unread is a dot over the 💬 segment, not "💬●": a label that changed width re-laid out
/// the navigation bar of every page.
struct PagePicker: View, @MainActor Equatable {
    let store: ChatStore
    let pager: PagerState
    let jukeboxOn: Bool
    /// iPad: the left column's 📰 / 📻 switch.
    var leftColumn = false

    static func == (a: Self, b: Self) -> Bool {
        a.store === b.store && a.pager === b.pager && a.jukeboxOn == b.jukeboxOn && a.leftColumn == b.leftColumn
    }

    var body: some View {
        if leftColumn {
            Picker("表示", selection: Binding(get: { pager.leftTab }, set: { v in withAnimation(.easeOut(duration: 0.2)) { pager.leftTab = v } })) {
                Text("📰").tag(MainTab.timeline)
                Text("📻").tag(MainTab.jukebox)
            }
            .pickerStyle(.segmented)
            .frame(width: 130)
        } else {
            let width: CGFloat = jukeboxOn ? 180 : 130
            Picker("表示", selection: Binding(get: { pager.tab }, set: { v in withAnimation(.easeOut(duration: 0.2)) { pager.tab = v } })) {
                Text("📰").tag(MainTab.timeline)
                Text("💬").tag(MainTab.chat)
                if jukeboxOn { Text("📻").tag(MainTab.jukebox) }
            }
            .pickerStyle(.segmented)
            .frame(width: width)
            .overlay(alignment: .topLeading) { UnreadDot(store: store, x: width / (jukeboxOn ? 3 : 2) * 2 - 12) }
            .id(jukeboxOn) // a new control for a different number of segments, not an update
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
