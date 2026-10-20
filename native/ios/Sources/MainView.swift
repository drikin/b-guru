import SwiftUI

/// iPhone (compact): chat and timeline side by side as pages — swipe left/right or
/// use the switch at the top. iPad (regular): both at once, timeline left, chat right.
struct MainView: View {
    let store: ChatStore
    let timeline: TimelineStore
    let onSignOut: () -> Void

    @Environment(\.horizontalSizeClass) private var hSize
    @State private var tab: MainTab = .chat

    @State private var leftTab: MainTab = .timeline

    var body: some View {
        // No mini player under the timeline and the chat (drikin 2026-10-20: not needed —
        // the jukebox tab, the lock screen and Control Center play and pause).
        layout
            .environment(\.jukebox, jukeboxOn ? store.jukebox : nil)
            .task(id: jukeboxOn) { if jukeboxOn { await store.jukebox.load(path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox") } }
            .onChange(of: jukeboxOn) { _, on in
                if !on { if tab == .jukebox { tab = .chat }; leftTab = .timeline }
            }
            // iPad: a notification opening a thread brings the timeline back to the left column.
            .onChange(of: timeline.openThread) { _, id in if id != nil { leftTab = .timeline } }
    }

    private var jukeboxOn: Bool { store.capabilities?.jukeboxEnabled ?? false }

    @ViewBuilder private var layout: some View {
        if hSize == .regular {
            HStack(spacing: 0) {
                Group {
                    if leftTab == .jukebox && jukeboxOn {
                        JukeboxScreen(jukebox: store.jukebox, path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox", tabPicker: AnyView(leftPicker))
                    } else {
                        timelineScreen(picker: jukeboxOn ? AnyView(leftPicker) : nil)
                    }
                }
                .frame(minWidth: 320, idealWidth: 420, maxWidth: 480)
                Divider()
                ChatScreen(store: store, onSignOut: onSignOut)
            }
        } else {
            TabView(selection: $tab) {
                timelineScreen(picker: AnyView(picker))
                    .environment(\.timelineOnScreen, tab == .timeline)
                    .tag(MainTab.timeline)
                ChatScreen(store: store, onSignOut: onSignOut, tabPicker: AnyView(picker), onScreen: tab == .chat).tag(MainTab.chat)
                if jukeboxOn {
                    JukeboxScreen(jukebox: store.jukebox, path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox", tabPicker: AnyView(picker))
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
            .onChange(of: timeline.openThread) { _, id in if id != nil { tab = .timeline } }
            // Switching pages hides the keyboard (it used to stay up over the timeline).
            .onChange(of: tab) { _, _ in Keyboard.dismiss() }
        }
    }

    private func timelineScreen(picker: AnyView?) -> some View {
        TimelineScreen(timeline: timeline, capabilities: store.capabilities, tabPicker: picker, onReconnect: onSignOut)
    }

    /// iPad: the left column switches between the timeline and the jukebox.
    private var leftPicker: some View {
        Picker("表示", selection: $leftTab.animation(.easeOut(duration: 0.2))) {
            Text("タイムライン").tag(MainTab.timeline)
            Text("📻 ジュークボックス").tag(MainTab.jukebox)
        }
        .pickerStyle(.segmented)
        .frame(width: 260)
    }

    private var picker: some View {
        Picker("表示", selection: $tab.animation(.easeOut(duration: 0.2))) {
            Text("タイムライン").tag(MainTab.timeline)
            Text(store.unreadCount > 0 ? "チャット ●" : "チャット").tag(MainTab.chat)
            // Plain Text only: a segmented picker becomes a UISegmentedControl, which takes a
            // string or an image per segment — a modified Text (accessibilityLabel) made UIKit
            // throw during layout and the app crashed at launch (0.2.16–0.2.17).
            if jukeboxOn { Text("📻").tag(MainTab.jukebox) }
        }
        .pickerStyle(.segmented)
        .frame(width: jukeboxOn ? 280 : 240)
        .id(jukeboxOn) // a new control for a different number of segments, not an update
    }
}
