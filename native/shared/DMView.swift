import SwiftUI

// ✉️ 簡易 DM — the screens (state: DMStore.swift). iPhone shows DMScreen in a sheet,
// the Mac over the chat in its panel. Text goes through Font.app (TextScale).

/// ✉️ The member to DM from a chat message (others' messages with an author id; not B-guru's notes).
@MainActor func dmTarget(_ m: ChatMessage) -> DMPeer? {
    guard !m.isAuthor, !m.isNotice, m.kind == nil, m.id > 0, let id = m.authorId, !id.isEmpty else { return nil }
    return DMPeer(userId: id, name: m.authorName, avatar: m.avatar)
}

/// ✉️ with the unread count: opens the DM list (only when DM is on).
struct DMBadgeButton: View {
    let dm: DMStore

    var body: some View {
        if dm.enabled {
            Button { dm.openList() } label: {
                Image(systemName: "envelope")
                    .font(.app(.body))
                    .overlay(alignment: .topTrailing) {
                        if dm.unreadCount > 0 {
                            Text(dm.unreadCount > 99 ? "99+" : "\(dm.unreadCount)")
                                .font(.app(.caption2, weight: .bold))
                                .foregroundStyle(.white)
                                .padding(.horizontal, 4).padding(.vertical, 1)
                                .background(Capsule().fill(Color.red))
                                .offset(x: 9, y: -8)
                                .fixedSize()
                        }
                    }
            }
            .buttonStyle(.borderless)
            .help("DM（24 時間で消えます）")
            .accessibilityLabel(dm.unreadCount > 0 ? "DM、未読 \(dm.unreadCount) 件" : "DM")
        }
    }
}

/// The list or one conversation, whichever is open.
struct DMScreen: View {
    @Bindable var dm: DMStore

    var body: some View {
        VStack(spacing: 0) {
            switch dm.route {
            case let .thread(peer):
                DMThreadView(dm: dm, peer: peer)
                    .id(peer.userId)
            default:
                DMListView(dm: dm)
            }
        }
        #if os(macOS)
        .background(.regularMaterial)
        #endif
    }
}

private struct DMHeader<Leading: View>: View {
    let title: String
    let onBack: () -> Void
    let onClose: () -> Void
    @ViewBuilder var leading: Leading

    var body: some View {
        HStack(spacing: 8) {
            Button(action: onBack) { Image(systemName: "chevron.left").font(.app(.body, weight: .semibold)) }
                .buttonStyle(.borderless)
                .accessibilityLabel("戻る")
                .keyboardShortcut(.cancelAction)
            leading
            Text(title).font(.app(.headline)).lineLimit(1)
            Spacer()
            Button(action: onClose) { Image(systemName: "xmark").font(.app(.callout)) }
                .buttonStyle(.borderless)
                .accessibilityLabel("閉じる")
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }
}

struct DMListView: View {
    let dm: DMStore

    var body: some View {
        VStack(spacing: 0) {
            DMHeader(title: "DM", onBack: dm.close, onClose: dm.close) { EmptyView() }
            Divider()
            if dm.conversations.isEmpty {
                VStack(spacing: 8) {
                    Spacer()
                    Image(systemName: "envelope").font(.app(size: 30)).foregroundStyle(.secondary)
                    Text("DM はまだありません").font(.app(.callout)).foregroundStyle(.secondary)
                    Text("チャットで名前やアイコンを押すと「DM を送る」が出ます").font(.app(.caption)).foregroundStyle(.tertiary)
                        .multilineTextAlignment(.center)
                    Spacer()
                }
                .padding()
                .frame(maxWidth: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(dm.conversations) { c in
                            Button { dm.open(c.peer) } label: { row(c) }
                                .buttonStyle(.plain)
                            Divider().padding(.leading, 56)
                        }
                    }
                }
            }
            Text("DM は 24 時間で消えます").font(.app(.caption2)).foregroundStyle(.tertiary).padding(.vertical, 6)
        }
    }

    private func row(_ c: DMConversation) -> some View {
        HStack(spacing: 10) {
            AvatarView(url: c.peer.avatar, name: c.peer.displayName, size: 36)
            VStack(alignment: .leading, spacing: 2) {
                HStack {
                    Text(c.peer.displayName).font(.app(.callout, weight: c.unreadCount > 0 ? .bold : .medium)).lineLimit(1)
                    Spacer()
                    Text(MessageRow.time(c.lastMessage.createdAt)).font(.app(.caption2)).foregroundStyle(.tertiary).monospacedDigit()
                }
                HStack {
                    Text((c.lastMessage.isAuthor ? "あなた: " : "") + c.lastMessage.body)
                        .font(.app(.caption)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    if c.unreadCount > 0 {
                        Text("\(c.unreadCount)").font(.app(.caption2, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Color.red))
                    }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct DMThreadView: View {
    @Bindable var dm: DMStore
    let peer: DMPeer
    @State private var draft = ""
    /// Bumped on every send: a fresh text field drops uncommitted Japanese IME / dictation text that
    /// otherwise stayed in the box after sending now and then (drikin 2026-10-24; the chat's composer
    /// had the same fix).
    @State private var fieldGeneration = 0
    /// What was just sent, to swallow a late echo of it (dictation finalising after Send).
    @State private var justSent: (text: String, at: Date)?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 0) {
            DMHeader(title: peer.displayName, onBack: dm.openList, onClose: dm.close) {
                AvatarView(url: peer.avatar, name: peer.displayName, size: 26)
            }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        if dm.thread.isEmpty {
                            Text(dm.loading ? "読み込み中…" : "\(peer.displayName) さんとの DM（24 時間で消えます）")
                                .font(.app(.callout)).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, 40)
                        }
                        ForEach(dm.thread, id: \.stableId) { m in
                            DMBubble(m: m, onRetry: { dm.retry(m) }, onDiscard: { dm.discard(m) })
                        }
                        Color.clear.frame(height: 1).id("dm-bottom")
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: dm.thread.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("dm-bottom", anchor: .bottom) }
                }
                .onAppear { proxy.scrollTo("dm-bottom", anchor: .bottom) }
            }
            if let e = dm.error {
                Text(e).font(.app(.caption)).foregroundStyle(.red).padding(.horizontal, 12).padding(.bottom, 4)
            }
            Divider()
            composer
        }
    }

    @ViewBuilder private var composer: some View {
        if dm.canSend && dm.peerCanReceive {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .bottom, spacing: 8) {
                    TextField("\(peer.displayName) さんへ", text: $draft, axis: .vertical)
                        .font(.app(.body))
                        .lineLimit(1...6)
                        .textFieldStyle(.plain)
                        .focused($focused)
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 16).fill(Color.primary.opacity(0.06)))
                        .onSubmit(send)
                        .id(fieldGeneration)
                        .onChange(of: draft) { old, new in
                            if isLateEcho(old: old, new: new) { draft = "" }
                        }
                        .accessibilityLabel("DM の本文")
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill").font(.app(size: 26))
                            .foregroundStyle(canSendDraft ? Color.accentGreen : Color.secondary)
                    }
                    .buttonStyle(.borderless)
                    .disabled(!canSendDraft)
                    .accessibilityLabel("送信")
                }
                HStack {
                    Text("DM は 24 時間で消えます").font(.app(.caption2)).foregroundStyle(.tertiary)
                    Spacer()
                    if draft.count > dm.maxBody - 100 {
                        Text("\(draft.count)/\(dm.maxBody)").font(.app(.caption2))
                            .foregroundStyle(draft.count > dm.maxBody ? .red : .secondary).monospacedDigit()
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        } else {
            Text("この人にはまだ DM を送れません").font(.app(.caption)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity).padding(12)
        }
    }

    private var canSendDraft: Bool {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && t.count <= dm.maxBody
    }

    private func send() {
        guard canSendDraft else { return }
        let text = draft
        dm.send(text)
        justSent = (text, Date())
        draft = ""
        fieldGeneration += 1 // new field: the old one's marked text / dictation goes away
        DispatchQueue.main.async {
            focused = true // the keyboard stays up on the new field
            if draft == text { draft = "" }
        }
    }

    /// Dictation can deliver its final text a moment after Send: the sent message (or part of it)
    /// reappears in the empty box at once.
    private func isLateEcho(old: String, new: String) -> Bool {
        guard let s = justSent, Date().timeIntervalSince(s.at) < 2, old.isEmpty else { return false }
        let v = new.trimmingCharacters(in: .whitespacesAndNewlines)
        return v.count >= 2 && s.text.contains(v)
    }
}

private extension DMMessage {
    /// Stays the same when the pending bubble becomes the stored message (no flicker).
    var stableId: String { clientId ?? "id-\(id)" }
}

private struct DMBubble: View {
    let m: DMMessage
    let onRetry: () -> Void
    let onDiscard: () -> Void

    var body: some View {
        HStack {
            if m.isAuthor { Spacer(minLength: 40) }
            VStack(alignment: m.isAuthor ? .trailing : .leading, spacing: 2) {
                Text(MessageRow.attributed(m.body))
                    .font(.app(.body))
                    #if os(macOS)
                    .textSelection(.enabled)
                    #endif
                    .padding(.horizontal, 10).padding(.vertical, 6)
                    .background(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(m.isAuthor ? Color.accentGreen.opacity(0.14) : Color.primary.opacity(0.06))
                    )
                    .contextMenu {
                        Button("テキストをコピー", systemImage: "doc.on.doc") { Platform.copy(m.body) }
                    }
                if m.failed {
                    HStack(spacing: 6) {
                        Text("送信できませんでした").font(.app(.caption)).foregroundStyle(.red)
                        Button("再送", action: onRetry).linkButton().font(.app(.caption))
                        Button("取り消す", action: onDiscard).linkButton().font(.app(.caption)).tint(.secondary)
                    }
                } else {
                    Text(MessageRow.time(m.createdAt)).font(.app(.caption2)).foregroundStyle(.tertiary).monospacedDigit()
                }
            }
            .opacity(m.pending ? 0.6 : 1)
            if !m.isAuthor { Spacer(minLength: 40) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(m.isAuthor ? "自分" : "相手")、\(m.body)\(m.failed ? "、送信失敗" : "")")
    }
}
