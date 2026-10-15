import SwiftUI

/// The chat on iPhone / iPad. Works in iPad Split View and Slide Over (put the
/// chat beside Safari or a video) because the layout is a single column.
struct ChatScreen: View {
    @Bindable var store: ChatStore
    let onSignOut: () -> Void

    @Environment(\.scenePhase) private var scenePhase
    @State private var draft = ""
    @State private var notifyAll = PushCenter.shared.notifyMode == "all"
    @State private var quietHours = PushCenter.shared.quietHours
    @State private var editingId: Int?
    @FocusState private var composerFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                messages
                Divider()
                composer
            }
            .navigationTitle("B-guru チャット")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) { status }
                ToolbarItem(placement: .topBarTrailing) { menu }
            }
        }
        .onChange(of: scenePhase, initial: true) { _, phase in
            store.isVisible = phase == .active
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
                        MessageRow(
                            row: row,
                            showHeader: prev == nil || prev?.authorId != row.message.authorId || row.message.isAuthor != prev?.isAuthor,
                            canReact: store.capabilities?.canReact ?? false,
                            canEdit: store.capabilities?.canEdit ?? false,
                            onReact: { store.toggleReaction(row.message.id, emoji: $0) },
                            onEdit: { beginEdit(row.message) },
                            onRetry: { store.retry(row) },
                            onDiscard: { store.discard(row) },
                            highlighted: store.highlightId == row.message.id,
                            editing: editingId == row.message.id
                        )
                        .id(row.id)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                // Big iPad screens: keep a readable column, centred. In Split View /
                // Slide Over the window is narrower than this and it simply fills it.
                .frame(maxWidth: 760)
                .frame(maxWidth: .infinity)
            }
            .defaultScrollAnchor(.bottom)
            .keepsBottomOnResize()
            .scrollDismissesKeyboard(.interactively)
            // A LazyVStack only estimates the height of rows it hasn't drawn, so the
            // bottom anchor can land short after the first load (seen on iPad as a
            // blank area with the newest messages below the fold). Jump once more
            // after the first list has been laid out.
            .onChange(of: store.hasLoaded) { _, loaded in
                guard loaded else { return }
                proxy.scrollTo("bottom", anchor: .bottom)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { proxy.scrollTo("bottom", anchor: .bottom) }
            }
            .onChange(of: store.rows.last?.id) { _, _ in
                withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("bottom", anchor: .bottom) }
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
            if editingId != nil {
                HStack {
                    Text("メッセージを編集中").font(.caption).foregroundStyle(Color.accentGreen)
                    Spacer()
                    Button("キャンセル") { cancelEdit() }.font(.caption)
                }
            }
            HStack(alignment: .bottom, spacing: 8) {
                TextField(editingId == nil ? "メッセージ" : "編集内容", text: $draft, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($composerFocused)
                    .padding(.vertical, 8)
                    .padding(.horizontal, 12)
                    .background(RoundedRectangle(cornerRadius: 18).fill(Color(.secondarySystemBackground)))
                    // Hardware keyboard (iPad): Return sends, Shift+Return is a newline.
                    // The on-screen keyboard's return key still inserts a newline.
                    .onKeyPress(keys: [.return], phases: .down) { press in
                        if press.modifiers.contains(.shift) { return .ignored }
                        submit()
                        return .handled
                    }
                    .onKeyPress(.upArrow) {
                        guard draft.isEmpty, editingId == nil, let m = store.lastOwnMessage,
                              store.capabilities?.canEdit ?? false else { return .ignored }
                        beginEdit(m)
                        return .handled
                    }
                    .onKeyPress(.escape) {
                        guard editingId != nil else { return .ignored }
                        cancelEdit()
                        return .handled
                    }
                    .onChange(of: draft) { _, v in
                        let limit = store.capabilities?.maxBody ?? 1000
                        if v.count > limit { draft = String(v.prefix(limit)) }
                    }
                Button(action: submit) {
                    Image(systemName: editingId == nil ? "arrow.up.circle.fill" : "checkmark.circle.fill")
                        .font(.system(size: 30))
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !(store.capabilities?.canSend ?? true))
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
        let text = draft
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        if let id = editingId {
            editingId = nil
            draft = ""
            Task { _ = await store.edit(id, body: text) }
        } else {
            draft = "" // the bubble is already on screen
            store.send(text, restore: { body in if draft.isEmpty { draft = body } })
        }
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
