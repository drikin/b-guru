import SwiftUI
import PhotosUI

/// The chat on iPhone / iPad. Works in iPad Split View and Slide Over (put the
/// chat beside Safari or a video) because the layout is a single column.
struct ChatScreen: View {
    @Bindable var store: ChatStore
    let onSignOut: () -> Void
    /// iPhone: the chat / timeline switch shown in place of the title.
    var tabPicker: PagePicker? = nil

    @State private var notifyAll = PushCenter.shared.notifyMode == "all"
    @State private var quietHours = PushCenter.shared.quietHours
    @State private var notifyTimeline = PushCenter.shared.notifyTimeline
    /// The draft, the message being edited and the attached photos. The list, the composer
    /// and the status each read only their part, so typing or a presence change does not
    /// re-run this view and every row.
    @State private var composer = ChatComposerModel()
    @State private var viewing: ImageViewerItem?

    /// テキスト｜ルーム｜☗｜🎮｜🍻 and 📺 beside it.
    private func modeRow(compact: Bool) -> some View {
        HStack(spacing: 8) {
            if store.room.enabled || store.shogi.enabled || store.minigame.enabled || store.offkai.enabled {
                RoomModePicker(room: store.room, shogi: store.shogi, minigame: store.minigame, offkai: store.offkai, compact: compact)
            }
            if store.watch.enabled { WatchToggleButton(watch: store.watch) }
        }
    }

    /// チャットの上に重ねる形 is on for this member and something can sit over the chat.
    private var overlayOn: Bool { store.overlay.enabled && store.overlay.anyAvailable }

    /// A chip: the keyboard goes down and that one comes back, expanded.
    private func chipTapped(_ id: ActivityID) {
        composer.focused = false
        store.overlay.expand(id)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if overlayOn {
                    // チャットの上に重ねる形 (docs/chat-overlay-spec.md): the row is switches only; the features sit
                    // over the messages (ChatOverlayLayer below), the chat keeps its full height.
                    OverlaySwitchRow(overlay: store.overlay, onChip: chipTapped)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 8)
                    Divider()
                    if !store.room.enabled { VoiceBar(voice: store.voice) }
                } else if store.room.enabled || store.shogi.enabled || store.minigame.enabled || store.watch.enabled || store.offkai.enabled {
                    // The club room: テキスト｜ルーム (the ルーム tab shows who is in the voice) replaces the voice bar.
                    // ☗ 将棋 is a third choice (テキスト｜☗ 将棋 without the room). Centred under the
                    // timeline｜chat switch. 📺 sits beside it (the player stays open whatever the chat shows).
                    // Never wider than the screen: the full labels, else the short ones (💬 / 🏠), else it scrolls
                    // sideways (a fixed-size row wider than the iPhone pushed the whole chat wider — 2026-10-25).
                    ViewThatFits(in: .horizontal) {
                        modeRow(compact: false)
                        modeRow(compact: true)
                        ScrollView(.horizontal, showsIndicators: false) { modeRow(compact: true) }
                    }
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 12).padding(.vertical, store.shogi.open || store.minigame.open || store.offkai.open ? 3 : 6)
                    if store.watch.open && store.watch.mode == .docked {
                        // 📺 above the chat (the same player moves to the floating window and back).
                        WatchDockView(watch: store.watch)
                        Divider()
                    }
                    if store.offkai.enabled && store.offkai.open {
                        // 🍻 above the chat: the event (or the archive), about half the column, the chat below.
                        OffkaiArea(store: store, composer: composer)
                        Divider()
                    } else if store.minigame.enabled && store.minigame.open {
                        // 🎮 above the chat: the game's own height (≤ ~45 %), the chat below.
                        MinigameScreen(minigame: store.minigame)
                            .frame(maxWidth: 760)
                            .frame(maxWidth: .infinity)
                        Divider()
                    } else if store.shogi.enabled && store.shogi.open {
                        ShogiArea(store: store, composer: composer)
                        Divider()
                    } else if store.room.enabled && store.room.mode == .room {
                        RoomView(room: store.room)
                            .padding(.horizontal, 8)
                            .containerRelativeFrame(.vertical) { h, _ in h * 0.5 }
                    }
                    if !store.room.enabled { VoiceBar(voice: store.voice) }
                } else {
                    VoiceBar(voice: store.voice)
                }
                ChatMessageList(store: store, composer: composer, viewing: $viewing)
                    .environment(\.shogi, store.shogi.enabled ? store.shogi : nil)
                    .overlay {
                        if overlayOn { ChatOverlayLayer(store: store, onChip: chipTapped) }
                    }
                Divider()
                ChatComposerBar(store: store, composer: composer)
            }
            // The column's height, for how big ☗ 将棋's board may get (half of it).
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
                store.shogi.setAreaHeight($0)
                store.minigame.setAreaHeight($0)
                store.watch.setAreaHeight($0)
                store.offkai.setAreaHeight($0)
            }
            // ☗ / 🎮 opening moves a docked 📺 to the floating window (MainView draws it over every page;
            // two above the chat would leave no room for the chat).
            .onChange(of: store.shogi.open || store.minigame.open || store.offkai.open) { _, busy in
                guard !store.overlay.enabled else { return } // the overlay places 📺 itself
                if busy && store.watch.open && store.watch.mode == .docked { store.watch.setMode(.floating) }
            }
            // The overlay: typing shrinks every window to a chip (the keyboard takes half the screen); they come
            // back when the focus goes or the message is sent (the box empties), and shrink again on the next letter.
            .onChange(of: composer.focused, initial: true) { _, focused in store.overlay.typing = focused }
            .onChange(of: composer.draft.isEmpty) { wasEmpty, isEmpty in
                guard composer.focused else { return }
                if isEmpty && !wasEmpty { store.overlay.typing = false } else if !isEmpty { store.overlay.typing = true }
            }
            #if DEBUG
            // BGURU_DEMO_OVERLAY_TYPING=1: the composer takes the focus (the screenshot of the typing state).
            .task {
                guard ProcessInfo.processInfo.environment["BGURU_DEMO_OVERLAY_TYPING"] != nil else { return }
                try? await Task.sleep(for: .seconds(1.2))
                composer.draft = "そのレンズ何ですか？"
                composer.focused = true
            }
            #endif
            .imageViewer($viewing)
            .navigationTitle("B-guru チャット")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let tabPicker { ToolbarItem(placement: .principal) { tabPicker } }
                ToolbarItem(placement: .topBarLeading) {
                    HStack(spacing: 12) {
                        ChatStatus(store: store)
                        ChatReadAloudButton(store: store).font(.subheadline) // 🔈 読み上げ（この端末だけ、既定はオフ）
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    HStack(spacing: 14) {
                        DMBadgeButton(dm: store.dm) // ✉️ 簡易 DM（未読の数つき）
                        menu
                    }
                }
            }
        }
        // ✉️ 簡易 DM: the list / a conversation over the chat.
        .sheet(isPresented: Binding(get: { store.dm.route != nil }, set: { if !$0 { store.dm.close() } })) {
            DMScreen(dm: store.dm)
                .presentationDetents([.large])
                .modifier(DMSceneVisibility(dm: store.dm))
        }
    }

    // MARK: Toolbar

    private var menu: some View {
        Menu {
            Section("通知") {
                Picker("通知", selection: $notifyAll) {
                    Text("新着すべて").tag(true)
                    Text("メンションだけ").tag(false)
                }
                .onChange(of: notifyAll) { _, all in PushCenter.shared.notifyMode = all ? "all" : "mentions" }
                Toggle("静かな時間（0:00〜7:00）", isOn: $quietHours)
                    .onChange(of: quietHours) { _, on in PushCenter.shared.quietHours = on }
                Toggle("タイムラインの新着", isOn: $notifyTimeline)
                    .onChange(of: notifyTimeline) { _, on in PushCenter.shared.notifyTimeline = on }
            }
            ChatVoiceMenu()
            Button("B-guru をブラウザで開く", systemImage: "safari") { Platform.open(APIClient.baseURL) }
            Button("ログアウト", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive, action: onSignOut)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("メニュー")
    }

}

/// Connecting / offline, or how many are online (the toolbar's left).
private struct ChatStatus: View {
    let store: ChatStore

    var body: some View {
        if store.connection != .live {
            Text(store.connection == .offline ? "オフライン" : "接続中…")
                .font(.caption).foregroundStyle(.secondary)
        } else if store.onlineCount > 0 {
            HStack(spacing: 3) {
                Circle().fill(.green).frame(width: 6, height: 6)
                Text("\(store.onlineCount)").font(.caption).foregroundStyle(.secondary).monospacedDigit()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("オンライン \(store.onlineCount) 人")
        }
    }
}

/// The messages. Reads the rows and which one is being edited — not the draft.
private struct ChatMessageList: View {
    let store: ChatStore
    let composer: ChatComposerModel
    @Binding var viewing: ImageViewerItem?
    @State private var atBottom = true
    @State private var newBelow = 0
    @State private var list = ListScrollHandle()
    /// iOS 17 only: flipped when the chat page comes back on screen (see KeepsPlaceAcrossPages).
    @State private var relayout = false

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if store.rows.isEmpty {
                        Text(store.hasLoaded ? "今日はまだ静かだわん" : "読み込み中…")
                            .font(.callout).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    let canReact = store.capabilities?.canReact ?? false
                    let canEdit = store.capabilities?.canEdit ?? false
                    let editingId = composer.editingId
                    ForEach(Array(store.rows.enumerated()), id: \.element.id) { idx, row in
                        let prev = idx > 0 ? store.rows[idx - 1].message : nil
                        if store.unreadMarkerId == row.message.id { UnreadDivider() }
                        MessageRow(
                            row: row,
                            showHeader: prev == nil || prev?.authorId != row.message.authorId || row.message.isAuthor != prev?.isAuthor,
                            canReact: canReact,
                            canEdit: canEdit,
                            onReact: { store.toggleReaction(row.message.id, emoji: $0) },
                            onEdit: { composer.beginEdit(row.message) },
                            onRetry: { store.retry(row) },
                            onDiscard: { store.discard(row) },
                            onReplyMention: row.message.authorName.map { name in { composer.replyTo(name) } },
                            highlighted: store.highlightId == row.message.id,
                            editing: editingId == row.message.id,
                            localImages: row.message.clientId.flatMap { store.outgoingPhotos[$0]?.previews } ?? [],
                            onOpenImage: { i in viewing = ImageViewerItem(images: row.message.images ?? [], index: i) },
                            onDM: store.dm.enabled ? dmTarget(row.message).map { peer in { store.dm.open(peer) } } : nil
                        )
                        .equatable()
                        .id(row.id)
                    }
                    ChatBottomSentinel(atBottom: $atBottom)
                }
                .listScrollHandle(list)
                .padding(.horizontal, 12)
                .padding(.vertical, relayout ? 8.25 : 8)
                .scrollTargetLayout()
                // Big iPad screens: keep a readable column, centred. In Split View /
                // Slide Over the window is narrower than this and it simply fills it.
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .modifier(KeepsPlaceAcrossPages(proxy: proxy, atBottom: atBottom, relayout: $relayout))
            .opensAtBottom()
            .chatScrolling(store: store, proxy: proxy, atBottom: $atBottom, newBelow: $newBelow, list: list)
            .scrollDismissesKeyboard(.interactively)
            .dismissesKeyboardOnTap()
            // A LazyVStack only estimates the height of rows it hasn't drawn, so the
            // bottom anchor can land short after the first load (seen on iPad as a
            // blank area with the newest messages below the fold). Jump once more
            // after the first list has been laid out.
            .onChange(of: store.hasLoaded) { _, loaded in
                guard loaded, store.unreadMarkerId == nil else { return } // else it opens at the unread line
                proxy.scrollTo("bottom", anchor: .bottom)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: store.scrollTarget) { _, target in
                // A notification tap: jump to that message (highlighted by the store).
                guard let target, let row = store.rows.first(where: { $0.message.id == target }) else { return }
                DispatchQueue.main.async {
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(row.id, anchor: .center) }
                    store.scrollTarget = nil
                }
            }
            .onChange(of: composer.focused) { _, focused in
                store.minigame.inputFocused = focused // typing pauses the game
                // Keyboard up → keep the latest message visible above it.
                if focused { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .refreshable { await store.reload() }
        }
    }
}

/// The iPhone's pages sit side by side in a horizontal scroll view. Swiped off to the timeline, the
/// chat's lazy list drops its rows; swiped back, it estimates their heights again — a picture's row
/// guessed wrong moved the place you were reading, often onto rows not drawn yet: the chat looked
/// blank until you scrolled (drikin 2026-10-24「タイムラインとのスワイプ切り替えでよく出る」). So the
/// top message on screen is remembered while the page shows, and the list goes back to it when the
/// page comes back (that scroll also has it draw its rows). At the bottom, ChatScrolling follows the
/// newest instead. iOS 17 (no visibility callbacks): an invisible quarter-point change of the padding
/// when the page has settled makes the list lay out and draw again.
private struct KeepsPlaceAcrossPages: ViewModifier {
    let proxy: ScrollViewProxy
    let atBottom: Bool
    @Binding var relayout: Bool
    @Environment(\.screenVisibility) private var visibility
    @State private var shown = true
    @State private var topRow: String?
    /// Left at the bottom: back to the newest (what came in meanwhile is below, so `atBottom` went false).
    @State private var leftAtBottom = false

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content
                .onScrollTargetVisibilityChange(idType: String.self, threshold: 0.05) { ids in
                    guard shown, let first = ids.first(where: { $0 != "bottom" }) else { return }
                    if topRow != first { topRow = first }
                }
                .onScrollVisibilityChange(threshold: 0.3) { visible in
                    shown = visible
                    if !visible { leftAtBottom = atBottom; return }
                    if leftAtBottom || atBottom {
                        proxy.scrollTo("bottom", anchor: .bottom)
                    } else if let topRow {
                        proxy.scrollTo(topRow, anchor: .top)
                    }
                }
        } else {
            content.onChange(of: visibility?.chat ?? true) { _, on in if on { relayout.toggle() } }
        }
    }
}

/// The message box, its mention suggestions, photos and the send button.
private struct ChatComposerBar: View {
    let store: ChatStore
    @Bindable var composer: ChatComposerModel
    /// Bumped on every send: a fresh text field drops any uncommitted dictation /
    /// IME text that would otherwise stay in (or come back into) the composer.
    @State private var composerGeneration = 0
    /// What was just sent, to swallow a late echo of it (dictation finalising after Send).
    @State private var justSent: (text: String, at: Date)?

    private var photos: PostDraft { composer.photos }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            let matches = mentionMatches
            if !matches.isEmpty {
                MentionSuggestions(members: matches, onPick: pickMention)
                    .transition(.opacity)
            }
            if composer.editingId != nil {
                HStack {
                    Text("メッセージを編集中").font(.caption).foregroundStyle(Color.accentGreen)
                    Spacer()
                    Button("キャンセル") { composer.cancelEdit() }.font(.caption)
                }
            }
            if store.beagleThinking { BeagleThinkingLine() }
            if composer.editingId == nil {
                DraftImages(draft: photos)
                if let e = photos.error { Text(e).font(.caption).foregroundStyle(.red) }
            }
            HStack(alignment: .bottom, spacing: 8) {
                if composer.editingId == nil, store.capabilities?.canSendChatImages == true {
                    PhotosPicker(selection: Bindable(photos).picks, maxSelectionCount: max(1, photos.maxImages - photos.images.count), matching: .images) {
                        Image(systemName: "photo").font(.system(size: 22))
                            .frame(width: 30, height: 36)
                    }
                    .disabled(photos.images.count >= photos.maxImages)
                    .accessibilityLabel("写真を付ける")
                    CameraButton(draft: photos) {
                        Image(systemName: "camera").font(.system(size: 21))
                            .frame(width: 30, height: 36)
                    }
                }
                if composer.editingId == nil, store.canAskBeagle {
                    BeagleCallButton(composer: composer, size: 21, height: 36)
                }
                // Hardware keyboard (iPad): Return sends, Shift+Return is a newline, and the
                // Return that confirms a Japanese conversion only confirms it (see
                // ComposerTextView). The on-screen keyboard's return key inserts a newline.
                ComposerTextView(
                    text: $composer.draft,
                    isFocused: $composer.focused,
                    placeholder: composer.editingId == nil ? "メッセージ" : "編集内容",
                    onSubmit: submit,
                    onUpArrowWhenEmpty: {
                        guard composer.editingId == nil, let m = store.lastOwnMessage, store.capabilities?.canEdit ?? false else { return false }
                        composer.beginEdit(m)
                        return true
                    },
                    onEscape: {
                        guard composer.editingId != nil else { return false }
                        composer.cancelEdit()
                        return true
                    }
                )
                    .padding(.vertical, 8)
                    .padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color(.secondarySystemBackground)))
                    .contentShape(Rectangle())
                    .onTapGesture { composer.focused = true }
                    .onChange(of: composer.draft) { old, v in
                        if isLateEcho(old: old, new: v) { composer.draft = ""; return }
                        let limit = store.capabilities?.maxBody ?? 1000
                        if v.count > limit { composer.draft = String(v.prefix(limit)) }
                    }
                Button(action: submit) {
                    Image(systemName: composer.editingId == nil ? "arrow.up.circle.fill" : "checkmark.circle.fill")
                        .font(.system(size: 30))
                }
                .disabled((composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (composer.editingId != nil || photos.images.isEmpty)) || !(store.capabilities?.canSend ?? true))
                .accessibilityLabel(composer.editingId == nil ? "送信" : "保存")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .background(.bar)
        // 「チャットに引用」 from the timeline: add it to the draft, caret at the end.
        .onChange(of: store.pendingQuote, initial: true) { _, q in
            guard let q else { return }
            composer.draft = composer.draft.isEmpty ? q : composer.draft + "\n" + q
            store.pendingQuote = nil
            DispatchQueue.main.async { composer.focused = true }
        }
    }

    private func submit() {
        if let first = mentionMatches.first {
            pickMention(first) // Return with suggestions open = complete, not send
            return
        }
        let text = composer.draft
        let hasPhotos = composer.editingId == nil && !photos.images.isEmpty
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPhotos else { return }
        if let id = composer.editingId {
            composer.editingId = nil
            clearComposer(sent: text)
            Task { _ = await store.edit(id, body: text) }
        } else {
            clearComposer(sent: text)
            let composer = composer
            store.send(text, photos: photos.takePhotos(), restore: { body in if composer.draft.isEmpty { composer.draft = body } })
        }
    }

    /// Empty the composer after a send — also when dictation or the Japanese IME
    /// still holds uncommitted text, which used to stay in the field.
    private func clearComposer(sent text: String) {
        justSent = (text, Date())
        composer.draft = ""
        composerGeneration += 1        // new field: the old one's marked text / dictation goes away
        let composer = composer
        DispatchQueue.main.async {
            composer.focused = true     // keep the keyboard up on the new field
            if composer.draft == text { composer.draft = "" }
        }
    }

    /// Dictation can deliver its final text a moment after Send: the whole sent
    /// message (or part of it) reappears in the empty composer at once.
    private func isLateEcho(old: String, new: String) -> Bool {
        guard let s = justSent, Date().timeIntervalSince(s.at) < 2, old.isEmpty else { return false }
        let v = new.trimmingCharacters(in: .whitespacesAndNewlines)
        return v.count >= 2 && s.text.contains(v)
    }

    // MARK: @mention

    private var mentionMatches: [MentionMember] {
        guard composer.editingId == nil, let q = Mention.activeQuery(in: composer.draft) else { return [] }
        return Mention.candidates(store.members, query: q.query, recent: store.recentAuthors)
    }

    private func pickMention(_ m: MentionMember) {
        composer.draft = Mention.complete(composer.draft, with: m.name)
        composer.focused = true
    }
}

/// ☗ 将棋 above the chat. While typing (the keyboard takes half the screen) the board folds to
/// one line, so the message box and the latest messages stay in view.
private struct ShogiArea: View {
    let store: ChatStore
    let composer: ChatComposerModel

    var body: some View {
        if composer.focused {
            ShogiFoldedBar(shogi: store.shogi) { composer.focused = false }
        } else {
            ShogiScreen(shogi: store.shogi)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
        }
    }
}

/// 🍻 above the chat; folded to one line while typing (the keyboard leaves little room).
private struct OffkaiArea: View {
    let store: ChatStore
    let composer: ChatComposerModel

    var body: some View {
        if composer.focused {
            OffkaiFoldedBar(offkai: store.offkai) { composer.focused = false }
        } else {
            OffkaiScreen(offkai: store.offkai)
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
        }
    }
}

/// Read marks only while the app is in front.
private struct DMSceneVisibility: ViewModifier {
    let dm: DMStore
    @Environment(\.scenePhase) private var phase
    func body(content: Content) -> some View {
        content.onChange(of: phase, initial: true) { _, p in dm.appVisible = p == .active }
    }
}
