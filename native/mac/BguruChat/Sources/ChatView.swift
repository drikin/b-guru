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
    @FocusState private var composerFocused: Bool

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider()
            messages
            Divider()
            composer
        }
        .background(.regularMaterial)
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
                            editing: editingId == row.message.id
                        )
                        .id(row.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
            }
            .defaultScrollAnchor(.bottom)
            .keepsBottomOnResize()
            // Reacting to / editing the LAST message makes its row taller (chips
            // appear under the bubble). Without this the new chips land below the
            // viewport and the list looks like it jumped (drikin 2026-10-15).
            .onChange(of: lastRowSignature) { _, _ in
                guard store.scrollTarget == nil else { return }
                proxy.scrollTo("bottom", anchor: .bottom)
            }
            .onChange(of: store.rows.last?.id) { _, _ in
                guard store.scrollTarget == nil else { return }
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
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
            HStack(alignment: .bottom, spacing: 8) {
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
                    .padding(.horizontal, 10)
                    .background(RoundedRectangle(cornerRadius: 9).fill(Color(nsColor: .textBackgroundColor)))
                    .overlay(RoundedRectangle(cornerRadius: 9).strokeBorder(Color.primary.opacity(0.12)))
                Button {
                    composerFocused = true
                    pin.openEmoji?()
                } label: { Image(systemName: "face.smiling") }
                .buttonStyle(.borderless)
                .help("絵文字と記号（⌃⌘Space）")
                .accessibilityLabel("絵文字を入力")
                Button(action: submit) {
                    Image(systemName: editingId == nil ? "paperplane.fill" : "checkmark")
                        .frame(width: 18, height: 18)
                }
                .buttonStyle(.borderedProminent)
                .tint(Color.accentGreen)
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(store.capabilities?.canSend ?? true))
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
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if let id = editingId {
            editingId = nil
            draft = ""
            Task { _ = await store.edit(id, body: text) }
        } else {
            draft = "" // the bubble is already on screen; clear at once
            store.send(text, restore: { body in if draft.isEmpty { draft = body } })
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
        draft = m.body
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


