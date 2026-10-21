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

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if store.room.enabled || store.shogi.enabled {
                    // The club room: テキスト｜ルーム (the ルーム tab shows who is in the voice) replaces the voice bar.
                    // ☗ 将棋 is a third choice (テキスト｜☗ 将棋 without the room). Centred under the
                    // timeline｜chat switch.
                    RoomModePicker(room: store.room, shogi: store.shogi)
                        .frame(maxWidth: .infinity)
                        .padding(.horizontal, 12).padding(.vertical, store.shogi.open ? 3 : 6)
                    if store.shogi.enabled && store.shogi.open {
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
                Divider()
                ChatComposerBar(store: store, composer: composer)
            }
            // The column's height, for how big ☗ 将棋's board may get (half of it).
            .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { store.shogi.setAreaHeight($0) }
            .imageViewer($viewing)
            .navigationTitle("B-guru チャット")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if let tabPicker { ToolbarItem(placement: .principal) { tabPicker } }
                ToolbarItem(placement: .topBarLeading) { ChatStatus(store: store) }
                ToolbarItem(placement: .topBarTrailing) { menu }
            }
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
                            onOpenImage: { i in viewing = ImageViewerItem(images: row.message.images ?? [], index: i) }
                        )
                        .equatable()
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
            .onChange(of: composer.focused) { _, focused in
                // Keyboard up → keep the latest message visible above it.
                if focused { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .refreshable { await store.reload() }
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
