import SwiftUI

/// The menu-bar panel: chat or timeline, switched at the top (⌘1 / ⌘2).
/// The same timeline views as the iPhone / iPad app (native/shared).
struct MainPanelView: View {
    @Bindable var store: ChatStore
    let timeline: TimelineStore
    @Bindable var pin: PinState
    let onClose: () -> Void
    let onSignOut: () -> Void

    private var tab: MainTab {
        get { pin.tab }
        nonmutating set { pin.tab = newValue }
    }

    init(store: ChatStore, timeline: TimelineStore, pin: PinState, onClose: @escaping () -> Void,
         onSignOut: @escaping () -> Void, initialTab: MainTab = .chat) {
        self.store = store
        self.timeline = timeline
        self.pin = pin
        self.onClose = onClose
        self.onSignOut = onSignOut
        pin.tab = initialTab
    }

    var body: some View {
        Group {
            switch pin.tab {
            case .chat:
                ChatView(store: store, pin: pin, onClose: onClose, onSignOut: onSignOut, tabPicker: AnyView(picker))
            case .timeline:
                TimelineScreen(timeline: timeline, capabilities: store.capabilities, tabPicker: AnyView(picker), onReconnect: onSignOut)
                    .background(.regularMaterial)
            case .jukebox:
                JukeboxScreen(jukebox: store.jukebox, path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox", tabPicker: AnyView(picker))
                    .background(.regularMaterial)
            }
        }
        // Playing on: the record under every tab (not on the jukebox itself).
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if pin.tab != .jukebox {
                JukeboxMiniPlayer(jukebox: store.jukebox) { tab = .jukebox }
            }
        }
        .environment(\.jukebox, jukeboxOn ? store.jukebox : nil)
        .task(id: jukeboxOn) { if jukeboxOn { await store.jukebox.load(path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox") } }
        .onChange(of: jukeboxOn) { _, on in if !on && tab == .jukebox { tab = .chat } }
        // ⌃⌥B / the menu-bar icon always comes back to the chat input.
        .onChange(of: pin.focusRequest) { _, _ in tab = .chat }
        .onChange(of: timeline.openThread) { _, id in if id != nil { tab = .timeline } }
        .background {
            Button("") { tab = .chat }.keyboardShortcut("1", modifiers: .command).hidden()
            Button("") { tab = .timeline }.keyboardShortcut("2", modifiers: .command).hidden()
            if jukeboxOn { Button("") { tab = .jukebox }.keyboardShortcut("3", modifiers: .command).hidden() }
        }
    }

    private var jukeboxOn: Bool { store.capabilities?.jukeboxEnabled ?? false }

    private var picker: some View {
        Picker("表示", selection: $pin.tab) {
            Text(store.unreadCount > 0 ? "チャット ●" : "チャット").tag(MainTab.chat)
            Text("タイムライン").tag(MainTab.timeline)
            if jukeboxOn { Text("ジュークボックス").tag(MainTab.jukebox) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .fixedSize()
        .help(jukeboxOn ? "チャット（⌘1）／タイムライン（⌘2）／ジュークボックス（⌘3）" : "チャット（⌘1）／タイムライン（⌘2）")
    }
}
