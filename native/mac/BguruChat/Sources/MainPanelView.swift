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
        store.showChat = { [weak pin] in pin?.tab = .chat }
    }

    /// What can be seen (the tab shown, the panel open), for the views inside the tabs.
    @State private var visibility = ScreenVisibility()

    var body: some View {
        // All tabs stay built; switching only shows one and hides the others (instant,
        // and each keeps its scroll place — drikin 2026-10-19「さらにチューニング」).
        // This body never reads the tab: each slot reads it itself, so a switch (or the
        // panel coming and going) re-runs only the slots, not this view and its modifiers.
        ZStack {
            // Each tab in an Equatable wrapper: rebuilding the tabs with a fresh picker /
            // closures redrew every row of all three (measured).
            TabSlot(pin: pin, tab: .chat) {
                ChatTab(store: store, pin: pin, onClose: onClose, onSignOut: onSignOut).equatable()
            }
            TabSlot(pin: pin, tab: .timeline) {
                TimelineTab(store: store, timeline: timeline, pin: pin, onSignOut: onSignOut).equatable()
            }
            if jukeboxOn {
                JukeboxSlot(store: store, pin: pin)
            }
            // 「ネタ帳に送る」 inside the panel (a sheet bigger than the panel drew wrongly).
            if let post = store.netaPost {
                Color.black.opacity(0.35).ignoresSafeArea()
                    .onTapGesture { store.netaPost = nil }
                    .zIndex(2) // above the shown tab (zIndex 1)
                NetaSheet(post: post, store: store) { store.netaPost = nil }
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                    .shadow(radius: 12)
                    .padding(16)
                    .id(post.id)
                    .zIndex(3)
            }
        }
        // No mini player under the chat and the timeline (drikin 2026-10-20): the jukebox
        // tab, the media keys and Control Center play and pause.
        .environment(\.jukebox, jukeboxOn ? store.jukebox : nil)
        // 「チャットに引用」 / 「ネタ帳に送る」 / a post's link in the chat: closures made once
        // (store.showChat, set in init, shows the chat).
        .environment(\.quoteToChat, store.quoteToChat)
        .environment(\.sendToNeta, store.sendToNeta)
        .environment(\.openURL, timeline.postLinkAction)
        .environment(\.screenVisibility, visibility)
        .task(id: jukeboxOn) { if jukeboxOn { await store.jukebox.load(path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox") } }
        .background(PanelTabWatcher(store: store, timeline: timeline, pin: pin, visibility: visibility, jukeboxOn: jukeboxOn))
        .background {
            Button("") { tab = .timeline }.keyboardShortcut("1", modifiers: .command).hidden()
            Button("") { tab = .chat }.keyboardShortcut("2", modifiers: .command).hidden()
            if jukeboxOn { Button("") { tab = .jukebox }.keyboardShortcut("3", modifiers: .command).hidden() }
        }
    }

    private var jukeboxOn: Bool { store.capabilities?.jukeboxEnabled ?? false }

}

/// One tab of the panel: shown or kept hidden, from the tab it reads itself.
private struct TabSlot<Content: View>: View {
    let pin: PinState
    let tab: MainTab
    @ViewBuilder let content: Content

    var body: some View {
        content.shown(pin.tab == tab)
    }
}

/// The jukebox: built the first time it is opened, then kept like the others.
private struct JukeboxSlot: View {
    let store: ChatStore
    let pin: PinState
    @State private var built = false

    var body: some View {
        let on = pin.tab == .jukebox
        if built || on {
            JukeboxTab(store: store, pin: pin)
                .equatable()
                .shown(on)
                .onAppear { built = true }
        }
    }
}

/// What follows the tab and the stores' requests to switch, kept out of the panel's body.
private struct PanelTabWatcher: View {
    let store: ChatStore
    let timeline: TimelineStore
    let pin: PinState
    let visibility: ScreenVisibility
    let jukeboxOn: Bool

    /// The tab shown, while the panel can be seen: the timeline's read marks and polling,
    /// the room's map and the record's turning follow this.
    private func updateVisibility() {
        let seen = pin.windowVisible
        visibility.set(timeline: seen && pin.tab == .timeline, chat: seen && pin.tab == .chat,
                       jukebox: seen && pin.tab == .jukebox, room: seen && pin.tab == .chat)
        // Every minute only while the timeline can be seen (the tab stays built when hidden,
        // so appearing / disappearing said nothing about that).
        if visibility.timeline { timeline.startPolling() } else { timeline.stopPolling() }
    }

    @State private var restoredChatScreen = false

    private var chatScreen: String {
        if store.minigame.enabled && store.minigame.open { return "minigame" }
        if store.shogi.enabled && store.shogi.open { return "shogi" }
        return store.room.enabled && store.room.mode == .room ? "room" : "text"
    }

    private func restoreChatScreen() {
        guard !restoredChatScreen else { return }
        switch PanelMemory.savedChatScreen {
        case "shogi":
            // Wait for the server's answer on whether ☗ is on for this member.
            if store.shogi.enabled { if !store.shogi.open { store.shogi.show() } } else if store.capabilities == nil { return }
        case "minigame":
            if store.minigame.enabled { if !store.minigame.open { store.minigame.show() } } else if store.capabilities == nil { return }
        default: break
        }
        restoredChatScreen = true
    }

    var body: some View {
        Color.clear
            .onAppear { updateVisibility() }
            .onChange(of: pin.windowVisible) { _, _ in updateVisibility() }
            .onChange(of: jukeboxOn) { _, on in if !on && pin.tab == .jukebox { pin.tab = .chat } }
            .onChange(of: pin.tab) { _, t in
                updateVisibility()
                if t == .jukebox { pin.wantsHeight?(780) }
            }
            // The panel opens on the tab it was left on (PanelMemory); the chat's input gets
            // the caret only when the chat is the tab shown (ChatPanel.focusComposer).
            .onChange(of: store.capabilities) { _, caps in
                restoreChatScreen()
                // Remembered on the jukebox, but the jukebox is not on for this member (any more).
                if pin.tab == .jukebox, caps != nil, !(caps?.jukeboxEnabled ?? false) { pin.tab = .chat }
            }
            // Inside the chat: ☗ / 🎮 open again where they were left (the room follows the
            // server: entering it shows you to everyone, so it is never entered by itself).
            .onChange(of: chatScreen, initial: true) { _, s in if restoredChatScreen { PanelMemory.saveChatScreen(s) } }
            .onChange(of: store.shogi.enabled, initial: true) { _, _ in restoreChatScreen() }
            .onChange(of: store.minigame.enabled, initial: true) { _, _ in restoreChatScreen() }
            .onChange(of: timeline.openThread) { _, id in if id != nil { pin.tab = .timeline } }
    }
}

/// The switch shown at the top of every tab (shared screens take it as their picker).
typealias MainTabPicker = PanelTabSwitch

/// The switch at the top of every tab: チャット｜タイムライン（｜📻）. Reads the tab and the
/// unread count itself, so only it redraws when they change.
struct PanelTabSwitch: View {
    let store: ChatStore
    @Bindable var pin: PinState

    private var jukeboxOn: Bool { store.capabilities?.jukeboxEnabled ?? false }

    var body: some View {
        // 📰 タイムライン ・ 💬 チャット ・ 📻 プレイヤー — the same order and marks in every app
        // (drikin 2026-10-20); segments sized to their marks (the system control made them
        // all as wide as the widest and widened the panel).
        PanelTabs(selection: $pin.tab, items: [
            (.timeline, "📰", "タイムライン（⌘1）"),
            (.chat, store.unreadCount > 0 ? "💬●" : "💬", "チャット（⌘2）"),
        ] + (jukeboxOn ? [(.jukebox, "📻", "プレイヤー（⌘3）")] : []))
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
                 tabPicker: PanelTabSwitch(store: store, pin: pin))
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
                       tabPicker: PanelTabSwitch(store: store, pin: pin), onReconnect: onSignOut)
            .background(.regularMaterial)
    }
}

private struct JukeboxTab: View, @MainActor Equatable {
    let store: ChatStore
    let pin: PinState
    static func == (a: Self, b: Self) -> Bool { a.store === b.store && a.pin === b.pin }
    var body: some View {
        JukeboxScreen(jukebox: store.jukebox, path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox",
                      tabPicker: PanelTabSwitch(store: store, pin: pin))
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
