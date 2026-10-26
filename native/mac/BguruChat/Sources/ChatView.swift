import AppKit
import SwiftUI

struct ChatView: View {
    @Bindable var store: ChatStore
    @Bindable var pin: PinState
    let onClose: () -> Void
    let onSignOut: () -> Void
    /// The chat / timeline switch shown in place of the title.
    var tabPicker: PanelTabSwitch? = nil

    /// The draft, the message being edited and the attached photos. The header, the list
    /// and the composer each read only their part: typing re-runs the composer, a presence
    /// change the header — not this view and every row (measured on every keystroke).
    @State private var composer: ChatComposerModel

    init(store: ChatStore, pin: PinState, onClose: @escaping () -> Void, onSignOut: @escaping () -> Void,
         initialDraft: String = "", tabPicker: PanelTabSwitch? = nil) {
        self.tabPicker = tabPicker
        self.store = store
        self.pin = pin
        self.onClose = onClose
        self.onSignOut = onSignOut
        _composer = State(initialValue: ChatComposerModel(draft: initialDraft))
    }
    @State private var viewing: ImageViewerItem?

    /// チャットの上に重ねる形 is on for this member and something can sit over the chat.
    private var overlayOn: Bool { store.overlay.enabled && store.overlay.anyAvailable }

    var body: some View {
        VStack(spacing: 0) {
            ChatHeader(store: store, pin: pin, tabPicker: tabPicker, onSignOut: onSignOut)
            Divider()
            AssistantBannerRow()
            if overlayOn {
                // チャットの上に重ねる形 (docs/chat-overlay-spec.md): the switches sit in the header; the features
                // over the messages (ChatOverlayLayer below). The voice bar stays where it was.
                if !store.room.enabled { VoiceBar(voice: store.voice) }
            } else {
            if store.watch.open && store.watch.mode == .docked {
                // 📺 above the chat (⧉ moves the same player into its own window and back).
                WatchDockView(watch: store.watch)
                Divider()
            }
            if store.offkai.enabled && store.offkai.open {
                // 🍻 オフ会 (its choice sits in the header): the event or the archive above the chat.
                OffkaiScreen(offkai: store.offkai)
                Divider()
                if !store.room.enabled { VoiceBar(voice: store.voice) }
            } else if store.minigame.enabled && store.minigame.open {
                // 🎮 (its choice sits in the header): the game above the chat, at its own height.
                MinigameScreen(minigame: store.minigame)
                Divider()
                if !store.room.enabled { VoiceBar(voice: store.voice) }
            } else if store.shogi.enabled && store.shogi.open {
                // ☗ 将棋 (its choice sits in the header with テキスト｜ルーム): the board above the chat.
                ShogiScreen(shogi: store.shogi)
                Divider()
                if !store.room.enabled { VoiceBar(voice: store.voice) }
            } else if store.room.enabled {
                // The club room (its テキスト｜ルーム sits in the header) replaces the voice bar.
                if store.room.mode == .room {
                    RoomView(room: store.room)
                        .padding(.horizontal, 8)
                        .containerRelativeFrame(.vertical) { h, _ in h * 0.5 }
                }
            } else {
                VoiceBar(voice: store.voice)
            }
            }
            ChatMessageList(store: store, composer: composer, viewing: $viewing)
                .environment(\.shogi, store.shogi.enabled ? store.shogi : nil)
                .overlay {
                    if overlayOn { ChatOverlayLayer(store: store) { store.overlay.expand($0) } }
                }
            Divider()
            ChatComposerBar(store: store, pin: pin, composer: composer, onClose: onClose)
        }
        .background(.regularMaterial)
        // ✉️ 簡易 DM: the list / a conversation over the chat (the header's ✉️, a name in the chat).
        .overlay {
            if store.dm.route != nil {
                DMScreen(dm: store.dm)
                    .transition(.move(edge: .trailing))
            }
        }
        .animation(.easeOut(duration: 0.18), value: store.dm.route == nil)
        .onChange(of: store.isVisible, initial: true) { _, v in store.dm.appVisible = v }
        // The column's height, for how big ☗ 将棋's board may get (half of it).
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: {
            store.shogi.setAreaHeight($0)
            store.minigame.setAreaHeight($0)
            store.watch.setAreaHeight($0)
            store.offkai.setAreaHeight($0)
        }
        // ☗ 将棋 takes up to half the chat (the board shrinks past that): a short panel grows
        // once, so the chat below stays readable.
        .onChange(of: store.shogi.open) { _, open in if open { pin.wantsHeight?(820) } }
        // ☗ / 🎮 opening moves a docked 📺 into its own window (two above the chat leave no room for it).
        .onChange(of: store.shogi.open || store.minigame.open || store.offkai.open) { _, busy in
            guard !store.overlay.enabled else { return } // the overlay places 📺 itself
            if busy && store.watch.open && store.watch.mode == .docked { store.watch.setMode(.floating) }
        }
        .imageViewer($viewing)
        #if DEBUG
        // The orientation tour opens a picture (debugOpenImageViewer, object: its URL).
        .onReceive(NotificationCenter.default.publisher(for: .debugOpenImageViewer)) { note in
            if let url = note.object as? String { viewing = ImageViewerItem(images: [url], index: 0) }
        }
        // -demoViewer: open the picture viewer at once (UI checks).
        .onAppear {
            if CommandLine.arguments.contains("-demoViewer") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    viewing = ImageViewerItem(images: ["https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png"], index: 0)
                }
            }
        }
        #endif
        .dropDestination(for: URL.self) { urls, _ in
            guard store.capabilities?.canSendChatImages == true, composer.editingId == nil else { return false }
            composer.photos.add(fileURLs: urls)
            return true
        }
        // ⌘V of an image (a screenshot): sent here by the panel (ChatPanel.sendEvent),
        // because the text field would otherwise swallow the paste.
        .onReceive(NotificationCenter.default.publisher(for: .chatPasteImage)) { note in
            guard store.capabilities?.canSendChatImages == true, composer.editingId == nil, let data = note.object as? Data else { return }
            composer.photos.add(imageData: data)
        }
    }
}

/// The top row: the tab switch, connection, who is online, pin and the menu.
private struct ChatHeader: View {
    let store: ChatStore
    @Bindable var pin: PinState
    let tabPicker: PanelTabSwitch?
    let onSignOut: () -> Void
    @Bindable private var settings = AppSettings.shared

    var body: some View {
        HStack(spacing: 8) {
            if let tabPicker {
                tabPicker
                if store.overlay.enabled && store.overlay.anyAvailable {
                    // チャットの上に重ねる形: the icons are switches (each puts its feature over the chat).
                    OverlaySwitchRow(overlay: store.overlay, compact: true) { store.overlay.expand($0) }
                        .layoutPriority(-1)
                } else {
                if store.room.enabled || store.shogi.enabled || store.minigame.enabled || store.offkai.enabled {
                    RoomModeIcons(room: store.room, shogi: store.shogi, minigame: store.minigame, offkai: store.offkai)
                }
                if store.watch.enabled { WatchToggleButton(watch: store.watch) }
                }
            } else {
                Image(systemName: store.unreadCount > 0 ? "dog.fill" : "dog")
                    .foregroundStyle(Color.accentGreen)
                Text("B-guru チャット").font(.app(.headline))
            }
            if store.connection != .live {
                Text(store.connection == .offline ? "オフライン" : "接続中…")
                    .font(.app(.caption)).foregroundStyle(.secondary)
            }
            Spacer()
            DMBadgeButton(dm: store.dm) // ✉️ 簡易 DM（未読の数つき）
            if store.onlineCount > 0 {
                Label("\(store.onlineCount)", systemImage: "circle.fill")
                    .labelStyle(OnlineLabelStyle())
                    .fixedSize()
                    .help("いま B-guru を開いている人")
                    .accessibilityLabel("オンライン \(store.onlineCount) 人")
            }
            ChatReadAloudButton(store: store).buttonStyle(.borderless) // 🔈 読み上げ（この Mac だけ、既定はオフ）
            Button {
                pin.pinned.toggle()
            } label: {
                Image(systemName: pin.pinned ? "pin.fill" : "pin")
            }
            .buttonStyle(.borderless)
            .help(pin.pinned ? "固定を解除（他をクリックすると隠れる）" : "最前面に固定（配信中に横に置いておく）")
            .accessibilityLabel(pin.pinned ? "固定を解除" : "最前面に固定")
            Menu {
                // 老眼対策 (drikin 2026-10-24): the whole panel's text, also ⌘+ / ⌘− / ⌘0.
                Menu("文字の大きさ（\(TextScale.shared.percent)%）") {
                    Button("大きく（⌘＋）") { TextScale.shared.larger() }.disabled(!TextScale.shared.canGrow)
                    Button("小さく（⌘−）") { TextScale.shared.smaller() }.disabled(!TextScale.shared.canShrink)
                    Button("標準に戻す（⌘0）") { TextScale.shared.reset() }.disabled(TextScale.shared.scale == 1)
                    Divider()
                    ForEach(TextScale.steps, id: \.self) { s in
                        Toggle("\(Int((s * 100).rounded()))%", isOn: Binding(get: { TextScale.shared.scale == s }, set: { if $0 { TextScale.shared.set(s) } }))
                    }
                }
                Divider()
                Picker("通知", selection: $settings.notifyMode) {
                    ForEach(AppSettings.NotifyMode.allCases) { Text($0.label).tag($0) }
                }
                Toggle("タイムラインの新しい投稿も通知する", isOn: $settings.notifyTimeline)
                Toggle("静かな時間（0:00〜7:00）は新着を通知しない", isOn: $settings.quietHours)
                Toggle("Dock にも表示（未読バッジ）", isOn: $settings.showInDock)
                Toggle("右 ⇧ を 2 回押してパネルを開閉", isOn: $settings.rightShiftDoubleTap)
                if settings.rightShiftDoubleTap && !RightShiftDoubleTap.canMonitorGlobally {
                    Button("　ほかのアプリが前でも使う（入力監視を許可…）") { RightShiftDoubleTap.requestGlobalAccess() }
                }
                // macOS 27 からは出さない（StatusBarCollapser.isSupported）。
                if StatusBarCollapser.isSupported {
                    Toggle("試験的：ほかのステータスバーアイコンを畳む", isOn: $settings.collapseStatusItems)
                    if settings.collapseStatusItems {
                        Toggle("　カーソルを乗せたら出す", isOn: $settings.collapseRevealOnHover)
                    }
                }
                Toggle("新着でビーグルが吠える", isOn: $settings.menuBarBark)
                Toggle("負荷に合わせてビーグルが走る", isOn: $settings.menuBarRunner)
                if settings.menuBarRunner {
                    Toggle("　GPU の負荷も見る", isOn: $settings.menuBarRunnerGPU)
                }
                Toggle("メニューバーにティッカーを流す", isOn: $settings.menuBarTicker)
                // 端末内 AI のおすすめ（使えないときは理由を 1 行）
                let ai = AIPicks.availability()
                Toggle("AI がタイムラインのおすすめを教える（この Mac の中だけで動きます）", isOn: $settings.aiTimelinePicks)
                    .disabled(!ai.ok && !settings.aiTimelinePicks)
                if let reason = ai.reason { Text("　\(reason)") }
                // アシスタント（試験的）：サーバーが features.mac_assistant を true にしたときだけ。オン・オフは説明と同意を通す。
                if store.capabilities?.macAssistantEnabled == true {
                    let asst = Assistant.availability()
                    Toggle("アシスタント：ウインドウの変化を知らせる（試験的）", isOn: Binding(
                        get: { settings.assistant },
                        set: { on in if on { AssistantUI.enable(settings) } else { AssistantUI.disable(settings) } }))
                        .disabled(!asst.ok && !settings.assistant)
                    if let reason = asst.reason { Text("　\(reason)") }
                    if settings.assistant {
                        Menu("　アシスタントの設定") {
                            Text(Assistant.shared.weekSummary)
                            ForEach(Assistant.shared.recent) { n in
                                Menu("\(n.app)：\(AIPicks.short(n.reason, 20))") {
                                    Button("違う（次から知らせない）") { Assistant.shared.markWrong(n.id) }
                                    Button("合ってた") { Assistant.shared.markRight(n.id) }
                                }
                            }
                            Button("知りたいこと…") { AssistantUI.editInterest(settings) }
                            Button("除外するアプリ…") { AssistantUI.editExcluded(settings) }
                            Toggle("自動で前に出す（離席中だけ・ブラウザは除く）", isOn: $settings.assistantAutoFront)
                            Toggle("見張りを一時停止", isOn: $settings.assistantPaused)
                            Text("画面の中身は Mac の中の AI だけが読み、外には出しません")
                        }
                    }
                }
                if settings.menuBarTicker {
                    Toggle("　名前だけ（本文を出さない）", isOn: $settings.menuBarTickerNamesOnly)
                }
                Divider()
                Button("B-guru をブラウザで開く") { NSWorkspace.shared.open(APIClient.baseURL) }
                Button("アップデートを確認…") { Updater.shared.checkNow() }
                    .disabled(!Updater.shared.canCheck)
                // For bug reports: what the app recorded when it stopped responding.
                Button("フリーズの記録を Finder で表示") {
                    let url = FileManager.default.fileExists(atPath: HangWatch.logURL.path) ? HangWatch.logURL : HangWatch.directory
                    try? FileManager.default.createDirectory(at: HangWatch.directory, withIntermediateDirectories: true)
                    NSWorkspace.shared.activateFileViewerSelecting([url])
                }
                Divider()
                Button("ログアウト", action: onSignOut)
                Button("終了") { NSApp.terminate(nil) }
            } label: {
                Image(systemName: "ellipsis.circle")
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 8)
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
    /// While the chat is not on screen (the timeline or the jukebox shows, or the panel is
    /// closed): the rows as they were. The list stays built under the other tabs, and a hidden
    /// lazy list that keeps changing is what froze the panel (see ChatScrolling). What came
    /// in meanwhile shows when the chat does.
    @Environment(\.screenVisibility) private var visibility
    private var onScreen: Bool { visibility?.chat ?? true }
    @State private var frozen: [ChatRow]?
    /// The live rows as soon as the chat shows (not one update later: a message to jump to —
    /// a notification's — must already be in the list when the jump is asked for).
    private var rows: [ChatRow] { onScreen ? store.rows : (frozen ?? store.rows) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if rows.isEmpty {
                        Text(store.hasLoaded ? "今日はまだ静かだわん" : "読み込み中…")
                            .font(.app(.callout)).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    let canReact = store.capabilities?.canReact ?? false
                    let canEdit = store.capabilities?.canEdit ?? false
                    let editingId = composer.editingId
                    let rows = rows
                    ForEach(Array(rows.enumerated()), id: \.element.id) { idx, row in
                        let prev = idx > 0 ? rows[idx - 1].message : nil
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
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .opensAtBottom()
            .chatScrolling(store: store, proxy: proxy, atBottom: $atBottom, newBelow: $newBelow, list: list)
            // Reacting to / editing the LAST message makes its row taller (chips
            // appear under the bubble). Without this the new chips land below the
            // viewport and the list looks like it jumped (drikin 2026-10-15).
            .onChange(of: onScreen, initial: true) { _, on in
                frozen = on ? nil : store.rows
            }
            .onChange(of: lastRowSignature) { _, _ in
                guard store.scrollTarget == nil, atBottom, onScreen else { return }
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onChange(of: store.scrollTarget) { _, target in
                guard let target, let row = store.rows.first(where: { $0.message.id == target }) else { return }
                // Wait one runloop so a freshly opened panel has laid out its rows.
                DispatchQueue.main.async {
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(row.id, anchor: .center) }
                    store.scrollTarget = nil
                }
            }
        }
    }

    /// Changes whenever the last row's height may change (reactions, edits).
    private var lastRowSignature: String {
        guard let m = store.rows.last?.message else { return "" }
        let r = (m.reactions ?? []).map { "\($0.emoji)\($0.count)" }.joined()
        return "\(m.id)|\(m.body.count)|\(m.edited)|\(r)"
    }
}

/// [📷] [message … 😊] [send], the mention suggestions and the photos to send.
private struct ChatComposerBar: View {
    let store: ChatStore
    let pin: PinState
    @Bindable var composer: ChatComposerModel
    let onClose: () -> Void
    @State private var importing = false
    @FocusState private var composerFocused: Bool

    /// One line of the message field; the photo and send buttons match it.
    static let composerHeight: CGFloat = 32

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
                    Text("メッセージを編集中").font(.app(.caption)).foregroundStyle(Color.accentGreen)
                    Spacer()
                    Button("キャンセル  Esc") { composer.cancelEdit() }.buttonStyle(.borderless).font(.app(.caption))
                }
            }
            if store.beagleThinking { BeagleThinkingLine() }
            if composer.editingId == nil {
                DraftImages(draft: photos)
                if let e = photos.error { Text(e).font(.app(.caption)).foregroundStyle(.red) }
            }
            HStack(alignment: .bottom, spacing: 8) {
                // [📷] [message … 😊] [send], one height, bottoms aligned (a long draft grows upwards).
                if composer.editingId == nil, store.capabilities?.canSendChatImages == true {
                    Button { importing = true } label: {
                        Image(systemName: "photo").font(.app(size: 15))
                            .frame(width: 26, height: Self.composerHeight)
                            .contentShape(Rectangle())
                    }
                        .buttonStyle(.borderless)
                        .disabled(photos.images.count >= photos.maxImages)
                        .help("写真を付ける（ドラッグ＆ドロップ・⌘V でも）")
                        .accessibilityLabel("写真を付ける")
                }
                if composer.editingId == nil, store.canAskBeagle {
                    BeagleCallButton(composer: composer, size: 15, height: Self.composerHeight)
                }
                TextField(composer.editingId == nil ? "メッセージ（Enter 送信・⇧Enter 改行）" : "編集内容（Enter 保存）",
                          text: $composer.draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    // Enter sends, ⇧Enter is a newline (shared with the timeline's composers).
                    .returnSends(submit)
                    .onKeyPress(.upArrow) {
                        // Slack-style: ↑ in an empty composer edits your last message.
                        guard !TextComposition.isActive, composer.draft.isEmpty, composer.editingId == nil, let m = store.lastOwnMessage,
                              store.capabilities?.canEdit ?? false else { return .ignored }
                        composer.beginEdit(m)
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        // Esc during a Japanese conversion cancels the conversion, not the panel.
                        if TextComposition.isActive { return .ignored }
                        if ImageViewerOverlay.closeIfOpen() { return .handled }
                        if composer.editingId != nil { composer.cancelEdit(); return .handled }
                        onClose()
                        return .handled
                    }
                    .onChange(of: composer.draft) { _, v in
                        let limit = store.capabilities?.maxBody ?? 1000
                        if v.count > limit { composer.draft = String(v.prefix(limit)) }
                    }
                    .padding(.vertical, 7)
                    .padding(.leading, 10)
                    .padding(.trailing, 28) // room for the emoji button
                    .frame(minHeight: Self.composerHeight)
                    // The emoji button sits inside the field, on the right.
                    .overlay(alignment: .bottomTrailing) {
                        Button {
                            composerFocused = true
                            pin.openEmoji?()
                        } label: {
                            Image(systemName: "face.smiling").font(.app(size: 14))
                                .foregroundStyle(.secondary)
                                .frame(width: 28, height: Self.composerHeight)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.borderless)
                        .help("絵文字と記号（⌃⌘Space）")
                        .accessibilityLabel("絵文字を入力")
                    }
                    .background(RoundedRectangle(cornerRadius: 9).fill(Color(nsColor: .textBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.primary.opacity(0.12)))
                let canSubmit = !((composer.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (composer.editingId != nil || photos.images.isEmpty)) || !(store.capabilities?.canSend ?? true))
                Button(action: submit) {
                    Image(systemName: composer.editingId == nil ? "paperplane.fill" : "checkmark")
                        .font(.app(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: Self.composerHeight)
                        .background(RoundedRectangle(cornerRadius: 9).fill(Color.accentGreen.opacity(canSubmit ? 1 : 0.4)))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(!canSubmit)
                .accessibilityLabel(composer.editingId == nil ? "送信" : "保存")
            }
        }
        .padding(10)
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case let .success(urls) = result { photos.add(fileURLs: urls) }
        }
        .onAppear { composerFocused = true }
        // 🎮 pauses while the message box has the keys (a click on the game takes them back).
        .onChange(of: composerFocused) { _, f in if store.minigame.inputFocused != f { store.minigame.inputFocused = f } }
        // 「チャットに引用」 from the timeline: add it to the draft, caret at the end.
        .onChange(of: store.pendingQuote, initial: true) { _, q in
            guard let q else { return }
            composer.draft = composer.draft.isEmpty ? q : composer.draft + "\n" + q
            store.pendingQuote = nil
            DispatchQueue.main.async {
                composerFocused = true
                // Focusing a text field selects all of it on the Mac: typing would replace
                // the quote. Put the caret after it instead.
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
                    (NSApp.keyWindow?.firstResponder as? NSTextView)?.moveToEndOfDocument(nil)
                }
            }
        }
        // Reply / edit from a row: the caret goes into the message box.
        .onChange(of: composer.focusRequest) { _, _ in composerFocused = true }
        // The tabs stay built: back on the chat, the caret goes back into the message box.
        // A separate little view watches the tab, so the composer itself does not redraw.
        .background(FocusOnChatTab(pin: pin, focused: $composerFocused))
        .onChange(of: pin.focusRequest) { _, _ in
            // Re-assert even if SwiftUI believes it is already focused.
            composerFocused = false
            DispatchQueue.main.async { composerFocused = true }
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
            composer.draft = ""
            Task { _ = await store.edit(id, body: text) }
        } else {
            composer.draft = "" // the bubble is already on screen; clear at once
            let composer = composer
            store.send(text, photos: photos.takePhotos(), restore: { body in if composer.draft.isEmpty { composer.draft = body } })
        }
        composerFocused = true
    }

    // MARK: @mention

    private var mentionMatches: [MentionMember] {
        guard composer.editingId == nil, let q = Mention.activeQuery(in: composer.draft) else { return [] }
        return Mention.candidates(store.members, query: q.query, recent: store.recentAuthors)
    }

    private func pickMention(_ m: MentionMember) {
        composer.draft = Mention.complete(composer.draft, with: m.name)
        composerFocused = true
    }
}

private struct OnlineLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.font(.app(size: 6)).foregroundStyle(.green)
            configuration.title.font(.app(.caption)).foregroundStyle(.secondary).monospacedDigit()
        }
    }
}




extension Notification.Name {
    #if DEBUG
    /// Dev only: open the picture viewer on this URL (the orientation tour).
    static let debugOpenImageViewer = Notification.Name("fm.backspace.bguru.debugOpenImageViewer")
    #endif
    /// ⌘V with an image on the pasteboard while the chat is open (object: image Data).
    static let chatPasteImage = Notification.Name("fm.backspace.bguru.chatPasteImage")
}

/// Puts the caret back into the message box when the chat tab shows again, and takes it
/// out while another tab shows (the hidden composer must not get the typing).
private struct FocusOnChatTab: View {
    let pin: PinState
    var focused: FocusState<Bool>.Binding

    var body: some View {
        Color.clear
            .onChange(of: pin.tab) { _, t in
                if t == .chat {
                    DispatchQueue.main.async { focused.wrappedValue = true }
                } else {
                    focused.wrappedValue = false
                }
            }
    }
}

/// アシスタントの知らせ（パネルが見えているとき、ヘッダーの下に 1 行）。クリックでそのアプリを前に、× で閉じる。
private struct AssistantBannerRow: View {
    @Bindable private var banner = AssistantBanner.shared

    var body: some View {
        if let n = banner.current {
            HStack(spacing: 6) {
                Button {
                    Assistant.shared.bringToFront(n)
                    banner.current = nil
                } label: {
                    Text(banner.text).lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
                }
                .buttonStyle(.plain)
                .help("クリックで \(n.app) を前に出す")
                Button { banner.current = nil } label: { Image(systemName: "xmark.circle.fill") }
                    .buttonStyle(.borderless)
                    .help("閉じる")
            }
            .font(.app(.callout))
            .padding(.horizontal, 12)
            .padding(.vertical, 6)
            .background(Color.accentColor.opacity(0.12))
            Divider()
        }
    }
}
