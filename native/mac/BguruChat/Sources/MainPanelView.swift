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

    /// The jukebox is built the first time it is opened, then kept like the others.
    @State private var jukeboxBuilt = false

    var body: some View {
        // All tabs stay built; switching only shows one and hides the others (instant,
        // and each keeps its scroll place — drikin 2026-10-19「さらにチューニング」).
        ZStack {
            // Each tab in an Equatable wrapper: switching re-runs this body, and rebuilding
            // the tabs with a fresh picker / closures redrew every row of all three (measured).
            ChatTab(store: store, pin: pin, onClose: onClose, onSignOut: onSignOut)
                .equatable()
                .shown(pin.tab == .chat)
            TimelineTab(store: store, timeline: timeline, pin: pin, onSignOut: onSignOut)
                .equatable()
                .environment(\.timelineOnScreen, pin.tab == .timeline)
                .shown(pin.tab == .timeline)
            if jukeboxOn && (jukeboxBuilt || pin.tab == .jukebox) {
                JukeboxTab(store: store, pin: pin)
                    .equatable()
                    .environment(\.jukeboxOnScreen, pin.tab == .jukebox)
                    .shown(pin.tab == .jukebox)
                    .onAppear { jukeboxBuilt = true }
            }
        }
        // No mini player under the chat and the timeline (drikin 2026-10-20): the jukebox
        // tab, the media keys and Control Center play and pause.
        .environment(\.jukebox, jukeboxOn ? store.jukebox : nil)
        .task(id: jukeboxOn) { if jukeboxOn { await store.jukebox.load(path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox") } }
        .onChange(of: jukeboxOn) { _, on in if !on && tab == .jukebox { tab = .chat } }
        .onChange(of: pin.tab) { _, t in if t == .jukebox { pin.wantsHeight?(780) } }
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

}

/// The switch at the top of every tab: チャット｜タイムライン（｜📻）. Reads the tab and the
/// unread count itself, so only it redraws when they change.
struct PanelTabSwitch: View {
    let store: ChatStore
    @Bindable var pin: PinState

    private var jukeboxOn: Bool { store.capabilities?.jukeboxEnabled ?? false }

    var body: some View {
        if jukeboxOn {
            // Three tabs: segments sized to their words (the system control makes them all
            // as wide as the widest and widened the panel). A radio (📻, drikin 2026-10-19) keeps it
            // narrow and stays apart from the chat's own 💬｜🏠 (text｜room) switch.
            PanelTabs(selection: $pin.tab, items: [
                (.chat, store.unreadCount > 0 ? "チャット ●" : "チャット", "チャット（⌘1）"),
                (.timeline, "タイムライン", "タイムライン（⌘2）"),
                (.jukebox, "📻", "ジュークボックス（⌘3）"),
            ])
        } else {
            Picker("表示", selection: $pin.tab) {
                Text(store.unreadCount > 0 ? "チャット ●" : "チャット").tag(MainTab.chat)
                Text("タイムライン").tag(MainTab.timeline)
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .fixedSize()
            .help("チャット（⌘1）／タイムライン（⌘2）")
        }
    }
}

/// The tabs, rebuilt only when what they show changes (Equatable by identity).
private struct ChatTab: View, @MainActor Equatable {
    let store: ChatStore
    let pin: PinState
    let onClose: () -> Void
    let onSignOut: () -> Void
    static func == (a: Self, b: Self) -> Bool { a.store === b.store && a.pin === b.pin }
    var body: some View {
        ChatView(store: store, pin: pin, onClose: onClose, onSignOut: onSignOut,
                 tabPicker: AnyView(PanelTabSwitch(store: store, pin: pin)))
    }
}

private struct TimelineTab: View, @MainActor Equatable {
    let store: ChatStore
    let timeline: TimelineStore
    let pin: PinState
    let onSignOut: () -> Void
    static func == (a: Self, b: Self) -> Bool { a.store === b.store && a.timeline === b.timeline && a.pin === b.pin }
    var body: some View {
        TimelineScreen(timeline: timeline, capabilities: store.capabilities,
                       tabPicker: AnyView(PanelTabSwitch(store: store, pin: pin)), onReconnect: onSignOut)
            .background(.regularMaterial)
    }
}

private struct JukeboxTab: View, @MainActor Equatable {
    let store: ChatStore
    let pin: PinState
    static func == (a: Self, b: Self) -> Bool { a.store === b.store && a.pin === b.pin }
    var body: some View {
        JukeboxScreen(jukebox: store.jukebox, path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox",
                      tabPicker: AnyView(PanelTabSwitch(store: store, pin: pin)))
            .background(.regularMaterial)
    }
}

/// A segmented switch whose segments are as wide as their labels.
private struct PanelTabs: View {
    @Binding var selection: MainTab
    let items: [(MainTab, String, String)]

    var body: some View {
        HStack(spacing: 2) {
            ForEach(items, id: \.0) { tab, label, help in
                let on = selection == tab
                Button { selection = tab } label: {
                    Text(label)
                        .font(.system(size: 12, weight: on ? .semibold : .regular))
                        .foregroundStyle(on ? Color.white : Color.primary)
                        .padding(.horizontal, 10)
                        .frame(height: 20)
                        .background(RoundedRectangle(cornerRadius: 5).fill(on ? Color.accentColor : Color.clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help(help)
                .accessibilityLabel(help)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.07)))
        .fixedSize()
    }
}

private extension View {
    /// On screen, or kept built but invisible and untouchable. Not .disabled: that
    /// reached every row and redrew them all on each switch (measured). The chat drops
    /// the keyboard itself, and the timeline's shortcuts check that it is showing.
    func shown(_ on: Bool) -> some View {
        opacity(on ? 1 : 0)
            .allowsHitTesting(on)
            .accessibilityHidden(!on)
            .zIndex(on ? 1 : 0)
    }
}
