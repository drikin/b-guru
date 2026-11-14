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
            // ✉️ DM: a tab of its own right after the chat (the list and a conversation, the whole panel).
            // オーナー 2026-11-08「アプリ版のDMを素直にチャットの右のタブに移動」
            if store.dm.enabled {
                TabSlot(pin: pin, tab: .dm) {
                    DMTab(store: store, pin: pin).equatable()
                }
            }
            SplitDivider(pin: pin)
            // 📝 ネタ帳: between ✉️ and 📻, the whole panel (the app is for members only, so no
            // guest view; オーナー 2026-11-14「DM とプレイヤーの間のタブにネタ帳を実装する」).
            if let path = netaPath {
                NetaSlot(store: store, pin: pin, path: path)
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
            // カスタム絵文字の登録（ピッカーの「＋ 登録」）もパネルの上に。registering はこの中だけが読む。
            EmojiRegisterOverlay().zIndex(4)
        }
        // No mini player under the chat and the timeline (drikin 2026-10-20): the jukebox
        // tab, the media keys and Control Center play and pause.
        .environment(\.jukebox, jukeboxOn ? store.jukebox : nil)
        // 「チャットに引用」 / 「ネタ帳に送る」 / a post's link in the chat: closures made once
        // (store.showChat, set in init, shows the chat).
        .environment(\.quoteToChat, store.quoteToChat)
        .environment(\.watch, store.watch.enabled ? store.watch : nil)
        .environment(\.sendToNeta, store.sendToNeta)
        .environment(\.openURL, timeline.postLinkAction)
        .environment(\.screenVisibility, visibility)
        .task(id: jukeboxOn) { if jukeboxOn { await store.jukebox.load(path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox") } }
        .background(PanelTabWatcher(store: store, timeline: timeline, pin: pin, visibility: visibility, jukeboxOn: jukeboxOn))
        .background {
            Button("") { tab = .timeline }.keyboardShortcut("1", modifiers: .command).hidden()
            Button("") { tab = .chat }.keyboardShortcut("2", modifiers: .command).hidden()
            if store.dm.enabled { Button("") { tab = .dm }.keyboardShortcut("3", modifiers: .command).hidden() }
            if jukeboxOn { Button("") { tab = .jukebox }.keyboardShortcut("4", modifiers: .command).hidden() }
            // 📝 is ⌘5: ⌘4 stays the player it has been since 2026-10-20 (no renumbering).
            if netaPath != nil { Button("") { tab = .neta }.keyboardShortcut("5", modifiers: .command).hidden() }
            // The text size (老眼対策): ⌘+ (also ⌘= / ⌘; on a JIS keyboard, where + is ⇧;), ⌘−, ⌘0.
            Button("") { TextScale.shared.larger() }.keyboardShortcut("+", modifiers: .command).hidden()
            Button("") { TextScale.shared.larger() }.keyboardShortcut("=", modifiers: .command).hidden()
            Button("") { TextScale.shared.larger() }.keyboardShortcut(";", modifiers: .command).hidden()
            Button("") { TextScale.shared.smaller() }.keyboardShortcut("-", modifiers: .command).hidden()
            Button("") { TextScale.shared.reset() }.keyboardShortcut("0", modifiers: .command).hidden()
        }
        // Text without a style of its own (and the input fields) at the app's text size too.
        .font(.app(.body))
    }

    private var jukeboxOn: Bool { store.capabilities?.jukeboxEnabled ?? false }
    /// 📝 the entrance path (only app-issued tokens get it).
    private var netaPath: String? { store.capabilities?.netaTabPath }

}

/// One tab of the panel: shown or kept hidden, from the tab it reads itself. Side by side
/// (PinState.split) the timeline takes the left and the chat the right; the same views move,
/// they are not built again (each keeps its scroll place).
private struct TabSlot<Content: View>: View {
    let pin: PinState
    let tab: MainTab
    @ViewBuilder let content: Content

    var body: some View {
        let side = pin.sideBySide
        let on = tab == .chat ? pin.chatShown : tab == .timeline ? pin.timelineShown : pin.tab == tab
        let width = !side ? nil : tab == .chat ? SplitLayout.chatWidth(pin.width) : pin.width - SplitLayout.chatWidth(pin.width) - 1
        content
            .frame(width: width)
            .frame(maxWidth: .infinity, alignment: tab == .chat ? .trailing : .leading)
            .shown(on)
    }
}

/// How the panel is shared side by side.
enum SplitLayout {
    /// The chat's part: a little under half, between 360 and 520.
    static func chatWidth(_ panel: CGFloat) -> CGFloat { min(520, max(360, (panel * 0.45).rounded())) }
}

/// The line between the timeline and the chat, side by side.
private struct SplitDivider: View {
    let pin: PinState
    var body: some View {
        if pin.sideBySide {
            Rectangle().fill(Color(nsColor: .separatorColor))
                .frame(width: 1)
                .frame(maxWidth: .infinity, alignment: .trailing)
                .padding(.trailing, SplitLayout.chatWidth(pin.width))
                .allowsHitTesting(false)
                .zIndex(2)
        }
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

/// 📝 ネタ帳: the web page is built the first time the tab is opened, then kept (its place and
/// login survive tab switches; NetaTabWeb re-enters after 6 hours).
private struct NetaSlot: View {
    let store: ChatStore
    let pin: PinState
    let path: String
    @State private var built = false

    var body: some View {
        let on = pin.tab == .neta
        if built || on {
            NetaTab(store: store, pin: pin, path: path)
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
        visibility.set(timeline: seen && pin.timelineShown, chat: seen && pin.chatShown,
                       jukebox: seen && pin.tab == .jukebox, room: seen && pin.chatShown)
        // ✉️ read marks (and no notification for what is on screen) only while the DM tab shows.
        let dmShown = seen && pin.tab == .dm
        if store.dm.appVisible != dmShown { store.dm.appVisible = dmShown }
        if dmShown, store.dm.route == nil { store.dm.showList() }
        // Every minute only while the timeline can be seen (the tab stays built when hidden,
        // so appearing / disappearing said nothing about that).
        // Web 版のタイムラインのときは Web が自分で新着を取る。
        if visibility.timeline && !AppSettings.shared.webTimeline { timeline.startPolling() } else { timeline.stopPolling() }
    }

    @State private var restoredChatScreen = false

    private var chatScreen: String {
        if store.offkai.enabled && store.offkai.open { return "offkai" }
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
        case "offkai":
            if store.offkai.enabled { if !store.offkai.open { store.offkai.show() } } else if store.capabilities == nil { return }
        default: break
        }
        restoredChatScreen = true
    }

    var body: some View {
        Color.clear
            .onAppear { updateVisibility() }
            .onChange(of: pin.windowVisible) { _, seen in
                updateVisibility()
                // 📝 back on screen after a long while: NetaTabWeb enters again (6 h; the login lasts 12 h).
                if seen && pin.tab == .neta { NetaTabWeb.shared.shown() }
            }
            .onChange(of: pin.split) { _, _ in updateVisibility() }
            .onChange(of: jukeboxOn) { _, on in if !on && pin.tab == .jukebox { pin.tab = .chat } }
            // A name in the chat, a notification, …: DMStore.open → the ✉️ tab shows it.
            .onChange(of: store.dm.openRequest, initial: true) { _, n in if n > 0 { pin.tab = .dm } }
            // A chat notification (ChatStore.reveal): the chat tab, then the list goes to the message.
            .onChange(of: store.revealRequest, initial: true) { _, n in if n > 0 { pin.tab = .chat } }
            .onChange(of: pin.tab) { _, t in
                updateVisibility()
                if t == .jukebox { pin.wantsHeight?(780) }
                if t == .neta { NetaTabWeb.shared.shown() }
            }
            // The panel opens on the tab it was left on (PanelMemory); the chat's input gets
            // the caret only when the chat is the tab shown (ChatPanel.focusComposer).
            .onChange(of: store.capabilities) { _, caps in
                restoreChatScreen()
                // Remembered on the jukebox, but the jukebox is not on for this member (any more).
                if pin.tab == .jukebox, caps != nil, !(caps?.jukeboxEnabled ?? false) { pin.tab = .chat }
                // Remembered on ✉️, but DM is not on for this member.
                if pin.tab == .dm, caps != nil, !(caps?.features?.dm?.enabled ?? false) { pin.tab = .chat }
                // Remembered on 📝, but this token has no ネタ帳 tab (an older token / server).
                if pin.tab == .neta, caps != nil, caps?.netaTabPath == nil { pin.tab = .chat }
            }
            // Inside the chat: ☗ / 🎮 open again where they were left (the room follows the
            // server: entering it shows you to everyone, so it is never entered by itself).
            .onChange(of: chatScreen, initial: true) { _, s in if restoredChatScreen { PanelMemory.saveChatScreen(s) } }
            .onChange(of: store.shogi.enabled, initial: true) { _, _ in restoreChatScreen() }
            .onChange(of: store.minigame.enabled, initial: true) { _, _ in restoreChatScreen() }
            .onChange(of: timeline.openThread, initial: true) { _, id in
                guard let id else { return }
                pin.tab = .timeline
                // Web 版のタイムラインでは Web の #/post/<id> で開く（ネイティブの画面は作っていない）。
                if AppSettings.shared.webTimeline {
                    WebTimeline.shared.open(post: id)
                    timeline.openThread = nil
                }
            }
            .onChange(of: AppSettings.shared.webTimeline) { _, _ in updateVisibility() }
            .onAppear {
                WebTimeline.shared.onOpenChat = { [weak pin, weak store] mention, game in
                    pin?.tab = .chat
                    if let mention { store?.pendingQuote = mention }
                    if let game, store?.shogi.enabled == true { store?.shogi.openGame(game) }
                }
            }
    }
}

/// The switch shown at the top of every tab (shared screens take it as their picker).
typealias MainTabPicker = PanelTabSwitch

/// The switch at the top of every tab: チャット｜タイムライン（｜📻）. Reads the tab and the
/// unread count itself, so only it redraws when they change.
struct PanelTabSwitch: View {
    let store: ChatStore
    @Bindable var pin: PinState
    /// The tab this switch sits on.
    var pane: MainTab = .chat

    private var jukeboxOn: Bool { store.capabilities?.jukeboxEnabled ?? false }

    var body: some View {
        if pin.split {
            // Side by side: one switch (over the chat) — 📰💬 both, or 📻.
            if pane != .timeline {
                PanelTabs(selection: Binding(get: { pin.tab == .jukebox || pin.tab == .dm || pin.tab == .neta ? pin.tab : .chat }, set: { pin.tab = $0 }), items: [
                    (.chat, store.unreadCount > 0 ? "📰💬●" : "📰💬", "タイムラインとチャット（⌘1 / ⌘2）"),
                ] + dmItem + netaItem + jukeboxItem)
            }
        } else {
            tabs
        }
    }

    /// ✉️ with the unread count (1:1 and groups together) when DM is on.
    private var dmItem: [(MainTab, String, String)] {
        let dm = store.dm
        guard dm.enabled else { return [] }
        let n = dm.totalUnread
        return [(.dm, n > 0 ? "✉️ \(n > 99 ? "99+" : "\(n)")" : "✉️", n > 0 ? "DM、未読 \(n) 件（⌘3）" : "DM（⌘3）")]
    }

    private var jukeboxItem: [(MainTab, String, String)] { jukeboxOn ? [(.jukebox, "📻", "プレイヤー（⌘4）")] : [] }

    /// 📝 ネタ帳 between ✉️ and 📻, when the server gives this token the tab.
    private var netaItem: [(MainTab, String, String)] { store.capabilities?.netaTabPath != nil ? [(.neta, "📝", "ネタ帳（⌘5）")] : [] }

    private var tabs: some View {
        // 📰 タイムライン ・ 💬 チャット ・ ✉️ DM ・ 📝 ネタ帳 ・ 📻 プレイヤー — the same order and marks in every app
        // (drikin 2026-10-20); segments sized to their marks (the system control made them
        // all as wide as the widest and widened the panel).
        PanelTabs(selection: $pin.tab, items: [
            (.timeline, "📰", "タイムライン（⌘1）"),
            (.chat, store.unreadCount > 0 ? "💬●" : "💬", "チャット（⌘2）"),
        ] + dmItem + netaItem + jukeboxItem)
    }
}

/// ✉️ DM: the list and a conversation, the whole panel (no ✕: it is a tab; ← / ‹ go back to the list).
private struct DMTab: View, @MainActor Equatable {
    let store: ChatStore
    let pin: PinState
    static func == (a: Self, b: Self) -> Bool { a.store === b.store && a.pin === b.pin }
    var body: some View {
        DMScreen(dm: store.dm, tabPicker: AnyView(PanelTabSwitch(store: store, pin: pin, pane: .dm)))
            .environment(\.dmPresentation, .tab)
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
        if AppSettings.shared.webTimeline {
            WebTimelineScreen(tabPicker: PanelTabSwitch(store: store, pin: pin, pane: .timeline))
                .background(.regularMaterial)
                // ネイティブの一覧は出さないが、新着の知らせ・ビーグルの材料に一度だけ読む。
                .task { if timeline.posts.isEmpty { await timeline.refresh() } }
        } else {
            TimelineScreen(timeline: timeline, capabilities: store.capabilities,
                           tabPicker: PanelTabSwitch(store: store, pin: pin, pane: .timeline), onReconnect: onSignOut)
                .background(.regularMaterial)
        }
    }
}

private struct JukeboxTab: View, @MainActor Equatable {
    let store: ChatStore
    let pin: PinState
    static func == (a: Self, b: Self) -> Bool { a.store === b.store && a.pin === b.pin }
    var body: some View {
        JukeboxScreen(jukebox: store.jukebox, path: store.capabilities?.jukeboxPath ?? "/api/agent/jukebox",
                      tabPicker: PanelTabSwitch(store: store, pin: pin, pane: .jukebox))
            .background(.regularMaterial)
    }
}

/// 📝 ネタ帳: the tab switch on top, the page (/neta/app, its own views and light/dark) below.
private struct NetaTab: View, @MainActor Equatable {
    let store: ChatStore
    let pin: PinState
    let path: String
    static func == (a: Self, b: Self) -> Bool { a.store === b.store && a.pin === b.pin && a.path == b.path }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                PanelTabSwitch(store: store, pin: pin, pane: .neta)
                Spacer()
                // No ⌘R here: the hidden tabs stay built and the web timeline's ↻ already has it.
                Button { NetaTabWeb.shared.reload() } label: { Image(systemName: "arrow.clockwise") }
                    .buttonStyle(.borderless)
                    .help("再読み込み")
            }
            .padding(.horizontal, 12)
            .padding(.top, 10)
            .padding(.bottom, 8)
            Divider()
            NetaTabView(path: path)
        }
        .background(.regularMaterial)
        // The page follows the app's text size (⌘+ / ⌘− / ⌘0), like the web timeline.
        .onChange(of: TextScale.shared.scale) { _, s in NetaTabWeb.shared.setZoom(s) }
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
                        .font(.app(size: 12, weight: on ? .semibold : .regular))
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
