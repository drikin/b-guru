import SwiftUI
import PhotosUI

/// The chat on iPhone / iPad. Works in iPad Split View and Slide Over (put the
/// chat beside Safari or a video) because the layout is a single column.
struct ChatScreen: View {
    @Bindable var store: ChatStore
    let onSignOut: () -> Void
    /// iPhone: the chat / timeline switch shown in place of the title.
    var tabPicker: AnyView? = nil
    /// iPhone: false while the timeline page is showing (the chat is not being read).
    var onScreen = true

    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var notifyAll = PushCenter.shared.notifyMode == "all"
    @State private var quietHours = PushCenter.shared.quietHours
    @State private var editingId: Int?
    /// Photos attached to the next message (up to 4).
    @State private var photos = PostDraft(maxImages: 4)
    @State private var viewing: ImageViewerItem?
    @State private var atBottom = true
    @State private var newBelow = 0
    @State private var composerFocused = false
    /// Bumped on every send: a fresh text field drops any uncommitted dictation /
    /// IME text that would otherwise stay in (or come back into) the composer.
    @State private var composerGeneration = 0
    /// What was just sent, to swallow a late echo of it (dictation finalising after Send).
    @State private var justSent: (text: String, at: Date)?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if store.room.enabled {
                    // The club room: テキスト｜ルーム (the ルーム tab shows who is in the voice) replaces the voice bar.
                    // Centred under the timeline｜chat switch.
                    RoomModePicker(room: store.room)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 12).padding(.vertical, 6)
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
            .imageViewer($viewing)
            .navigationTitle("B-guru チャット")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let tabPicker { ToolbarItem(placement: .principal) { tabPicker } }
                ToolbarItem(placement: .topBarLeading) { status }
                ToolbarItem(placement: .topBarTrailing) { menu }
            }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            store.isVisible = phase == .active && onScreen
        }
        .onChange(of: onScreen) { _, on in
            store.isVisible = scenePhase == .active && on
        }
        // 「チャットに引用」 from the timeline: add it to the draft, caret at the end.
        .onChange(of: store.pendingQuote, initial: true) { _, q in
            guard let q else { return }
            draft = draft.isEmpty ? q : draft + "\n" + q
            store.pendingQuote = nil
            DispatchQueue.main.async { composerFocused = true }
        }
    }

    // MARK: Toolbar

    @ViewBuilder private var status: some View {
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
            }
            Button("B-guru をブラウザで開く", systemImage: "safari") { Platform.open(APIClient.baseURL) }
            Button("ログアウト", systemImage: "rectangle.portrait.and.arrow.right", role: .destructive, action: onSignOut)
        } label: {
            Image(systemName: "ellipsis.circle")
        }
        .accessibilityLabel("メニュー")
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
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                // Big iPad screens: keep a readable column, centred. In Split View /
                // Slide Over the window is narrower than this and it simply fills it.
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .chatScrolling(store: store, proxy: proxy, atBottom: $atBottom, newBelow: $newBelow)
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
            .onChange(of: composerFocused) { _, focused in
                // Keyboard up → keep the latest message visible above it.
                if focused { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .refreshable { await store.reload() }
        }
    }

    // MARK: Composer

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
                    Button("キャンセル") { cancelEdit() }.font(.caption)
                }
            }
            if editingId == nil {
                DraftImages(draft: photos)
                if let e = photos.error { Text(e).font(.caption).foregroundStyle(.red) }
            }
            HStack(alignment: .bottom, spacing: 8) {
                if editingId == nil, store.capabilities?.canSendChatImages == true {
                    PhotosPicker(selection: $photos.picks, maxSelectionCount: max(1, photos.maxImages - photos.images.count), matching: .images) {
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
                // Hardware keyboard (iPad): Return sends, Shift+Return is a newline, and the
                // Return that confirms a Japanese conversion only confirms it (see
                // ComposerTextView). The on-screen keyboard's return key inserts a newline.
                ComposerTextView(
                    text: $draft,
                    isFocused: $composerFocused,
                    placeholder: editingId == nil ? "メッセージ" : "編集内容",
                    onSubmit: submit,
                    onUpArrowWhenEmpty: {
                        guard editingId == nil, let m = store.lastOwnMessage, store.capabilities?.canEdit ?? false else { return false }
                        beginEdit(m)
                        return true
                    },
                    onEscape: {
                        guard editingId != nil else { return false }
                        cancelEdit()
                        return true
                    }
                )
                    .padding(.vertical, 8)
                    .padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color(.secondarySystemBackground)))
                    .contentShape(Rectangle())
                    .onTapGesture { composerFocused = true }
                    .onChange(of: draft) { old, v in
                        if isLateEcho(old: old, new: v) { draft = ""; return }
                        let limit = store.capabilities?.maxBody ?? 1000
                        if v.count > limit { draft = String(v.prefix(limit)) }
                    }
                Button(action: submit) {
                    Image(systemName: editingId == nil ? "arrow.up.circle.fill" : "checkmark.circle.fill")
                        .font(.system(size: 30))
                }
                .disabled((draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && (editingId != nil || photos.images.isEmpty)) || !(store.capabilities?.canSend ?? true))
                .accessibilityLabel(editingId == nil ? "送信" : "保存")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .background(.bar)
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
            clearComposer(sent: text)
            Task { _ = await store.edit(id, body: text) }
        } else {
            clearComposer(sent: text)
            store.send(text, photos: photos.takePhotos(), restore: { body in if draft.isEmpty { draft = body } })
        }
    }

    /// Empty the composer after a send — also when dictation or the Japanese IME
    /// still holds uncommitted text, which used to stay in the field.
    private func clearComposer(sent text: String) {
        justSent = (text, Date())
        draft = ""
        composerGeneration += 1        // new field: the old one's marked text / dictation goes away
        DispatchQueue.main.async {
            composerFocused = true     // keep the keyboard up on the new field
            if draft == text { draft = "" }
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
