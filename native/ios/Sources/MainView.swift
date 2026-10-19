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
        layout
            // Playing on: the record under every screen (not on the jukebox itself).
            .safeAreaInset(edge: .bottom, spacing: 0) {
                if (hSize == .regular ? leftTab : tab) != .jukebox {
                    JukeboxMiniPlayer(jukebox: store.jukebox) {
                        if hSize == .regular { leftTab = .jukebox } else { tab = .jukebox }
                    }
                }
            }
            .environment(\.jukebox, jukeboxOn ? store.jukebox : nil)
            .task(id: jukeboxOn) { if jukeboxOn { await store.jukebox.load(path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox") } }
            .onChange(of: jukeboxOn) { _, on in
                if !on { if tab == .jukebox { tab = .chat }; leftTab = .timeline }
            }
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
            Text("ジュークボックス").tag(MainTab.jukebox)
        }
        .pickerStyle(.segmented)
        .frame(width: 240)
    }

    private var picker: some View {
        Picker("表示", selection: $tab.animation(.easeOut(duration: 0.2))) {
            Text("タイムライン").tag(MainTab.timeline)
            Text(store.unreadCount > 0 ? "チャット ●" : "チャット").tag(MainTab.chat)
            if jukeboxOn { Text("ジュークボックス").tag(MainTab.jukebox) }
        }
        .pickerStyle(.segmented)
        .frame(width: jukeboxOn ? 300 : 240)
    }
}
