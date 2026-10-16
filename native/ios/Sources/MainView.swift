import SwiftUI

enum MainTab: Hashable { case timeline, chat }

/// iPhone (compact): chat and timeline side by side as pages — swipe left/right or
/// use the switch at the top. iPad (regular): both at once, timeline left, chat right.
struct MainView: View {
    let store: ChatStore
    let timeline: TimelineStore
    let onSignOut: () -> Void

    @Environment(\.horizontalSizeClass) private var hSize
    @State private var tab: MainTab = .chat

    var body: some View {
        if hSize == .regular {
            HStack(spacing: 0) {
                timelineScreen(picker: nil)
                    .frame(minWidth: 320, idealWidth: 420, maxWidth: 480)
                Divider()
                ChatScreen(store: store, onSignOut: onSignOut)
            }
        } else {
            TabView(selection: $tab) {
                timelineScreen(picker: AnyView(picker)).tag(MainTab.timeline)
                ChatScreen(store: store, onSignOut: onSignOut, tabPicker: AnyView(picker)).tag(MainTab.chat)
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea(.container, edges: .bottom)
            .onChange(of: timeline.openThread) { _, id in if id != nil { tab = .timeline } }
        }
    }

    private func timelineScreen(picker: AnyView?) -> some View {
        TimelineScreen(timeline: timeline, capabilities: store.capabilities, tabPicker: picker, onReconnect: onSignOut)
    }

    private var picker: some View {
        Picker("表示", selection: $tab.animation(.easeOut(duration: 0.2))) {
            Text(timeline.unreadCount > 0 ? "タイムライン ●" : "タイムライン").tag(MainTab.timeline)
            Text(store.unreadCount > 0 ? "チャット ●" : "チャット").tag(MainTab.chat)
        }
        .pickerStyle(.segmented)
        .frame(width: 240)
    }
}
