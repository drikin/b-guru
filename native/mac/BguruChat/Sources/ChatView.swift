import AppKit
import SwiftUI

struct ChatView: View {
    @Bindable var store: ChatStore
    @Bindable var pin: PinState
    let onClose: () -> Void
    let onSignOut: () -> Void
    /// The chat / timeline switch shown in place of the title.
    var tabPicker: AnyView? = nil

    @Bindable private var settings = AppSettings.shared
    @State private var draft: String

    init(store: ChatStore, pin: PinState, onClose: @escaping () -> Void, onSignOut: @escaping () -> Void,
         initialDraft: String = "", tabPicker: AnyView? = nil) {
        self.tabPicker = tabPicker
        self.store = store
        self.pin = pin
        self.onClose = onClose
        self.onSignOut = onSignOut
        _draft = State(initialValue: initialDraft)
    }
    @State private var editingId: Int?
    /// Photos attached to the next message (up to 4): file picker, drag & drop, ⌘V.
    @State private var photos = PostDraft(maxImages: 4)
    @State private var viewing: ImageViewerItem?
    @State private var atBottom = true
    @State private var newBelow = 0
    @State private var importing = false
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            if store.room.enabled {
                // The club room (its テキスト｜ルーム sits in the header) replaces the voice bar.
                if store.room.mode == .room {
                    RoomView(room: store.room)
                        .padding(.horizontal, 8)
                        .containerRelativeFrame(.vertical) { h, _ in h * 0.5 }
                }
            } else {
                VoiceBar(voice: store.voice)
            }
            messages
            Divider()
            composer
        }
        .background(.regularMaterial)
        .imageViewer($viewing)
        #if DEBUG
        // -demoViewer: open the picture viewer at once (UI checks).
        .onAppear {
            if CommandLine.arguments.contains("-demoViewer") {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1) {
                    viewing = ImageViewerItem(images: ["https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png"], index: 0)
                }
            }
        }
        #endif
        .fileImporter(isPresented: $importing, allowedContentTypes: [.image], allowsMultipleSelection: true) { result in
            if case let .success(urls) = result { photos.add(fileURLs: urls) }
        }
        .dropDestination(for: URL.self) { urls, _ in
            guard store.capabilities?.canSendChatImages == true, editingId == nil else { return false }
            photos.add(fileURLs: urls)
            return true
        }
        // ⌘V of an image (a screenshot): sent here by the panel (ChatPanel.sendEvent),
        // because the text field would otherwise swallow the paste.
        .onReceive(NotificationCenter.default.publisher(for: .chatPasteImage)) { note in
            guard store.capabilities?.canSendChatImages == true, editingId == nil, let data = note.object as? Data else { return }
            photos.add(imageData: data)
        }
        .onAppear { composerFocused = true }
        .onChange(of: pin.focusRequest) { _, _ in
            // Re-assert even if SwiftUI believes it is already focused.
            composerFocused = false
            DispatchQueue.main.async { composerFocused = true }
        }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            if let tabPicker {
                tabPicker
                if store.room.enabled { RoomModeIcons(room: store.room) }
            } else {
                Image(systemName: store.unreadCount > 0 ? "dog.fill" : "dog")
                    .foregroundStyle(Color.accentGreen)
                Text("B-guru チャット").font(.headline)
            }
            if store.connection != .live {
                Text(store.connection == .offline ? "オフライン" : "接続中…")
                    .font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if store.onlineCount > 0 {
                Label("\(store.onlineCount)", systemImage: "circle.fill")
                    .labelStyle(OnlineLabelStyle())
                    .fixedSize()
                    .help("いま B-guru を開いている人")
                    .accessibilityLabel("オンライン \(store.onlineCount) 人")
            }
            Button {
                pin.pinned.toggle()
            } label: {
                Image(systemName: pin.pinned ? "pin.fill" : "pin")
            }
            .buttonStyle(.borderless)
            .help(pin.pinned ? "固定を解除（他をクリックすると隠れる）" : "最前面に固定（配信中に横に置いておく）")
            .accessibilityLabel(pin.pinned ? "固定を解除" : "最前面に固定")
            Menu {
                Picker("通知", selection: $settings.notifyMode) {
                    ForEach(AppSettings.NotifyMode.allCases) { Text($0.label).tag($0) }
                }
                Toggle("静かな時間（0:00〜7:00）は新着を通知しない", isOn: $settings.quietHours)
                Toggle("Dock にも表示（未読バッジ）", isOn: $settings.showInDock)
                Divider()
                Button("B-guru をブラウザで開く") { NSWorkspace.shared.open(APIClient.baseURL) }
                Button("アップデートを確認…") { Updater.shared.checkNow() }
                    .disabled(!Updater.shared.canCheck)
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

    // MARK: Messages

    private var messages: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 6) {
                    if store.rows.isEmpty {
                        Text(store.hasLoaded ? "今日はまだ静かだわん" : "読み込み中…")
                            .font(.callout).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(Array(store.rows.enumerated()), id: \.element.id) { idx, row in
                        let prev = idx > 0 ? store.rows[idx - 1].message : nil
                        if store.unreadMarkerId == row.message.id { UnreadDivider() }
                        MessageRow(
                            row: row,
                            showHeader: prev == nil || prev?.authorId != row.message.authorId || row.message.isAuthor != prev?.isAuthor,
                            canReact: store.capabilities?.canReact ?? false,
                            canEdit: store.capabilities?.canEdit ?? false,
                            onReact: { store.toggleReaction(row.message.id, emoji: $0) },
                            onEdit: { beginEdit(row.message) },
                            onRetry: { store.retry(row) },
                            onDiscard: { store.discard(row) },
                            onReplyMention: row.message.authorName.map { name in { replyTo(name) } },
                            highlighted: store.highlightId == row.message.id,
                            editing: editingId == row.message.id,
                            localImages: row.message.clientId.flatMap { store.outgoingPhotos[$0]?.previews } ?? [],
                            onOpenImage: { i in viewing = ImageViewerItem(images: row.message.images ?? [], index: i) }
                        )
                        .id(row.id)
                    }
                    ChatBottomSentinel(atBottom: $atBottom)
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .chatScrolling(store: store, proxy: proxy, atBottom: $atBottom, newBelow: $newBelow)
            // Reacting to / editing the LAST message makes its row taller (chips
            // appear under the bubble). Without this the new chips land below the
            // viewport and the list looks like it jumped (drikin 2026-10-15).
            .onChange(of: lastRowSignature) { _, _ in
                guard store.scrollTarget == nil, atBottom else { return }
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

    // MARK: Composer

    /// One line of the message field; the photo and send buttons match it.
    static let composerHeight: CGFloat = 32

    private var composer: some View {
        VStack(alignment: .leading, spacing: 4) {
            let matches = mentionMatches
            if !matches.isEmpty {
                MentionSuggestions(members: matches, onPick: pickMention)
                    .transition(.opacity)
            }
            if editingId != nil {
                HStack {
                    Text("メッセージを編集中").font(.caption).foregroundStyle(Color.accentGreen)
                    Spacer()
                    Button("キャンセル  Esc") { cancelEdit() }.buttonStyle(.borderless).font(.caption)
                }
            }
            if editingId == nil {
                DraftImages(draft: photos)
                if let e = photos.error { Text(e).font(.caption).foregroundStyle(.red) }
            }
            HStack(alignment: .bottom, spacing: 8) {
                // [📷] [message … 😊] [send], one height, bottoms aligned (a long draft grows upwards).
                if editingId == nil, store.capabilities?.canSendChatImages == true {
                    Button { importing = true } label: {
                        Image(systemName: "photo").font(.system(size: 15))
                            .frame(width: 26, height: Self.composerHeight)
                            .contentShape(Rectangle())
                    }
                        .buttonStyle(.borderless)
                        .disabled(photos.images.count >= photos.maxImages)
                        .help("写真を付ける（ドラッグ＆ドロップ・⌘V でも）")
                        .accessibilityLabel("写真を付ける")
                }
                TextField(editingId == nil ? "メッセージ（Enter 送信・⇧Enter 改行）" : "編集内容（Enter 保存）",
                          text: $draft, axis: .vertical)
                    .textFieldStyle(.plain)
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    // Enter sends, ⇧Enter is a newline (shared with the timeline's composers).
                    .returnSends(submit)
                    .onKeyPress(.upArrow) {
                        // Slack-style: ↑ in an empty composer edits your last message.
                        guard !TextComposition.isActive, draft.isEmpty, editingId == nil, let m = store.lastOwnMessage,
                              store.capabilities?.canEdit ?? false else { return .ignored }
                        beginEdit(m)
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        // Esc during a Japanese conversion cancels the conversion, not the panel.
                        if TextComposition.isActive { return .ignored }
                        if editingId != nil { cancelEdit(); return .handled }
                        onClose()
                        return .handled
                    }
                    .onChange(of: draft) { _, v in
                        let limit = store.capabilities?.maxBody ?? 1000
                        if v.count > limit { draft = String(v.prefix(limit)) }
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
                            Image(systemName: "face.smiling").font(.system(size: 14))
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
                let canSubmit = !((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (editingId != nil || photos.images.isEmpty)) || !(store.capabilities?.canSend ?? true))
                Button(action: submit) {
                    Image(systemName: editingId == nil ? "paperplane.fill" : "checkmark")
                        .font(.system(size: 14, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 40, height: Self.composerHeight)
                        .background(RoundedRectangle(cornerRadius: 9).fill(Color.accentGreen.opacity(canSubmit ? 1 : 0.4)))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (editingId != nil || photos.images.isEmpty)) || !(store.capabilities?.canSend ?? true))
                .accessibilityLabel(editingId == nil ? "送信" : "保存")
            }
        }
        .padding(10)
    }

    private func submit() {
        if let first = mentionMatches.first {
            pickMention(first) // Return with suggestions open = complete, not send
            return
        }
        let text = draft
        let hasPhotos = editingId == nil && !photos.images.isEmpty
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || hasPhotos else { return }
        if let id = editingId {
            editingId = nil
            draft = ""
            Task { _ = await store.edit(id, body: text) }
        } else {
            draft = "" // the bubble is already on screen; clear at once
            store.send(text, photos: photos.takePhotos(), restore: { body in if draft.isEmpty { draft = body } })
        }
        composerFocused = true
    }

    // MARK: @mention

    private var mentionMatches: [MentionMember] {
        guard editingId == nil, let q = Mention.activeQuery(in: draft) else { return [] }
        return Mention.candidates(store.members, query: q.query, recent: store.recentAuthors)
    }

    private func pickMention(_ m: MentionMember) {
        draft = Mention.complete(draft, with: m.name)
        composerFocused = true
    }

    /// Reply to someone: `@name ` at the start of the composer (keeps what was typed).
    private func replyTo(_ name: String) {
        let token = Mention.token(name)
        if !draft.hasPrefix(token) {
            draft = token + draft.trimmingCharacters(in: .whitespaces)
        }
        editingId = nil
        composerFocused = true
    }

    private func beginEdit(_ m: ChatMessage) {
        editingId = m.id
        draft = m.displayBody
        composerFocused = true
    }

    private func cancelEdit() {
        editingId = nil
        draft = ""
    }
}

private struct OnlineLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) {
            configuration.icon.font(.system(size: 6)).foregroundStyle(.green)
            configuration.title.font(.caption).foregroundStyle(.secondary).monospacedDigit()
        }
    }
}




extension Notification.Name {
    /// ⌘V with an image on the pasteboard while the chat is open (object: image Data).
    static let chatPasteImage = Notification.Name("fm.backspace.bguru.chatPasteImage")
}
