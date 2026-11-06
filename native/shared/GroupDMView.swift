import SwiftUI

// 👥 グループ DM — the screens (state: GroupDMStore.swift). Shown inside DMScreen (iPhone: the DM sheet;
// Mac: over the chat), with the same header, bubbles and words as the 1:1 DM (DMView.swift).

/// A group's line in the DM list: 👥, its title, the last message and the unread count.
struct GDMListRow: View {
    let s: GDMSummary

    var body: some View {
        HStack(spacing: 10) {
            Text("👥").font(.app(size: 20)).frame(width: 36, height: 36)
                .background(Circle().fill(Color.primary.opacity(0.06)))
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 4) {
                    Text(s.group.displayTitle).font(.app(.callout, weight: s.unreadCount > 0 ? .bold : .medium)).lineLimit(1)
                    if s.group.muted == true {
                        Image(systemName: "bell.slash").font(.app(.caption2)).foregroundStyle(.tertiary)
                            .accessibilityLabel("通知を切っています")
                    }
                    Spacer()
                    if let at = GDMLogic.activity(s) {
                        Text(MessageRow.time(at)).font(.app(.caption2)).foregroundStyle(.tertiary).monospacedDigit()
                    }
                }
                HStack {
                    Text(GDMLogic.preview(s.lastMessage))
                        .font(.app(.caption)).foregroundStyle(.secondary).lineLimit(1)
                    Spacer()
                    if s.unreadCount > 0 {
                        Text("\(s.unreadCount)").font(.app(.caption2, weight: .bold)).foregroundStyle(.white)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Capsule().fill(Color.red))
                    }
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("グループ \(s.group.displayTitle)\(s.unreadCount > 0 ? "、未読 \(s.unreadCount) 件" : "")")
    }
}

/// A group's conversation.
struct GDMThreadView: View {
    let dm: DMStore
    @Bindable var groups: GroupDMStore
    let groupId: Int
    @State private var draft = ""
    /// What was just sent, to swallow a late echo of it (dictation finalising after Send; as in DMThreadView).
    @State private var justSent: (text: String, at: Date)?
    @State private var focused = false

    private var title: String { (groups.group ?? groups.summary(groupId)?.group)?.displayTitle ?? "グループ" }

    var body: some View {
        VStack(spacing: 0) {
            DMHeader(title: title, onBack: dm.openList, onClose: dm.close) {
                Text("👥").font(.app(.body))
            } trailing: {
                Button { dm.route = .groupMembers(groupId) } label: {
                    HStack(spacing: 3) {
                        Image(systemName: "person.2")
                        if let n = groups.group?.memberCount ?? groups.group?.members.count { Text("\(n)").monospacedDigit() }
                    }
                    .font(.app(.callout))
                }
                .buttonStyle(.borderless)
                .help("メンバー")
                .accessibilityLabel("メンバー")
            }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        if groups.thread.isEmpty {
                            Text(groups.loading ? "読み込み中…" : "\(title) のグループ DM（30 日で消えます）")
                                .font(.app(.callout)).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, 40)
                        }
                        ForEach(Array(groups.thread.enumerated()), id: \.element.stableId) { i, m in
                            if m.isSystem {
                                GDMSystemRow(m: m)
                            } else {
                                let prev = i > 0 ? groups.thread[i - 1] : nil
                                let showsSender = !m.isAuthor && (prev == nil || prev!.isSystem || prev!.fromId != m.fromId)
                                GDMBubble(m: m, showsSender: showsSender,
                                          onRetry: { groups.retry(m) }, onDiscard: { groups.discard(m) })
                            }
                        }
                        Color.clear.frame(height: 1).id("gdm-bottom")
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                }
                .defaultScrollAnchor(.bottom)
                .onChange(of: groups.thread.count) { _, _ in
                    withAnimation(.easeOut(duration: 0.15)) { proxy.scrollTo("gdm-bottom", anchor: .bottom) }
                }
                .onAppear { proxy.scrollTo("gdm-bottom", anchor: .bottom) }
            }
            if let e = groups.error {
                Text(e).font(.app(.caption)).foregroundStyle(.red).padding(.horizontal, 12).padding(.bottom, 4)
            }
            Divider()
            composer
        }
    }

    @ViewBuilder private var composer: some View {
        if groups.canSend && groups.groupCanSend {
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .bottom, spacing: 8) {
                    PostTextInput(text: $draft, isFocused: $focused, placeholder: "\(title) へ", onSubmit: send)
                        .font(.app(.body))
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 16).fill(Color.primary.opacity(0.06)))
                        .onChange(of: draft) { old, new in
                            if isLateEcho(old: old, new: new) { draft = "" }
                        }
                        .accessibilityLabel("グループ DM の本文")
                    Button(action: send) {
                        Image(systemName: "arrow.up.circle.fill").font(.app(size: 26))
                            .foregroundStyle(canSendDraft ? Color.accentGreen : Color.secondary)
                    }
                    .buttonStyle(.borderless)
                    .disabled(!canSendDraft)
                    .accessibilityLabel("送信")
                }
                HStack {
                    Text("DM は 30 日で消えます").font(.app(.caption2)).foregroundStyle(.tertiary)
                    Spacer()
                    if draft.count > groups.maxBody - 100 {
                        Text("\(draft.count)/\(groups.maxBody)").font(.app(.caption2))
                            .foregroundStyle(draft.count > groups.maxBody ? .red : .secondary).monospacedDigit()
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 8)
        } else {
            Text("このグループにはまだ送れません").font(.app(.caption)).foregroundStyle(.secondary)
                .frame(maxWidth: .infinity).padding(12)
        }
    }

    private var canSendDraft: Bool {
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && t.count <= groups.maxBody
    }

    private func send() {
        guard canSendDraft else { return }
        let text = draft
        groups.send(text)
        justSent = (text, Date())
        draft = ""
        DispatchQueue.main.async {
            if draft == text { draft = "" }
        }
    }

    private func isLateEcho(old: String, new: String) -> Bool {
        guard let s = justSent, Date().timeIntervalSince(s.at) < 2, old.isEmpty else { return false }
        let v = new.trimmingCharacters(in: .whitespacesAndNewlines)
        return v.count >= 2 && s.text.contains(v)
    }
}

private extension GDMMessage {
    /// Stays the same when the pending bubble becomes the stored message (no flicker).
    var stableId: String { clientId ?? "id-\(id)" }
}

/// 「A さんが B さんを追加しました」: in the middle, small.
private struct GDMSystemRow: View {
    let m: GDMMessage

    var body: some View {
        Text(m.body)
            .font(.app(.caption2)).foregroundStyle(.secondary)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 10).padding(.vertical, 3)
            .background(Capsule().fill(Color.primary.opacity(0.05)))
            .frame(maxWidth: .infinity)
            .padding(.vertical, 2)
    }
}

private struct GDMBubble: View {
    let m: GDMMessage
    /// The sender's name and face (the first of a run from the same person).
    let showsSender: Bool
    let onRetry: () -> Void
    let onDiscard: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            if m.isAuthor { Spacer(minLength: 40) }
            if !m.isAuthor {
                Group {
                    if showsSender { AvatarView(url: m.fromAvatar, name: m.senderName, size: 26) }
                    else { Color.clear.frame(width: 26, height: 1) }
                }
                .padding(.top, showsSender ? 16 : 0)
            }
            VStack(alignment: m.isAuthor ? .trailing : .leading, spacing: 2) {
                if showsSender {
                    Text(m.senderName).font(.app(.caption, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
                }
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
        .accessibilityLabel("\(m.isAuthor ? "自分" : m.senderName)、\(m.body)\(m.failed ? "、送信失敗" : "")")
    }
}

/// Choose several members (the chat's member list and my 1:1 partners; not me, not those already in, not ビーグル).
struct GDMMemberPicker: View {
    let groups: GroupDMStore
    let excluding: Set<String>
    @Binding var selected: Set<String>
    /// How many more may be chosen (the group's limit).
    let room: Int
    @State private var query = ""

    var body: some View {
        let list = GDMLogic.candidates(groups.directory, id: \.userId, name: \.name, excluding: excluding, query: query)
        VStack(spacing: 0) {
            TextField("名前で探す", text: $query)
                .textFieldStyle(.roundedBorder)
                .font(.app(.callout))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .accessibilityLabel("メンバーを名前で探す")
            if list.isEmpty {
                Text(groups.directory.isEmpty ? "読み込み中…" : "選べる人がいません")
                    .font(.app(.caption)).foregroundStyle(.secondary).padding()
            }
            LazyVStack(spacing: 0) {
                ForEach(list, id: \.userId) { m in
                    let on = selected.contains(m.userId)
                    Button {
                        if on { selected.remove(m.userId) } else if selected.count < room { selected.insert(m.userId) }
                    } label: {
                        HStack(spacing: 10) {
                            AvatarView(url: m.avatar, name: m.name, size: 28)
                            Text(m.name).font(.app(.callout)).lineLimit(1)
                            Spacer()
                            Image(systemName: on ? "checkmark.circle.fill" : "circle")
                                .font(.app(.body))
                                .foregroundStyle(on ? Color.accentGreen : Color.secondary)
                        }
                        .padding(.horizontal, 12).padding(.vertical, 6)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(m.name)
                    .accessibilityAddTraits(on ? .isSelected : [])
                    Divider().padding(.leading, 50)
                }
            }
        }
        .task { await groups.loadDirectory() }
    }
}

/// 「＋ グループ」: members (several) and an optional name → POST /gdm, then the new group opens.
struct GDMNewGroupView: View {
    let dm: DMStore
    @Bindable var groups: GroupDMStore
    @State private var name = ""
    @State private var selected: Set<String> = []

    var body: some View {
        VStack(spacing: 0) {
            DMHeader(title: "新しいグループ", onBack: dm.openList, onClose: dm.close) {
                Text("👥").font(.app(.body))
            } trailing: {
                Button("作る") { create() }
                    .font(.app(.callout, weight: .semibold))
                    .buttonStyle(.borderless)
                    .disabled(selected.isEmpty || groups.busy)
                    .accessibilityLabel("グループを作る")
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 6) {
                    GDMNameField(name: $name, max: groups.maxName, placeholder: "グループの名前（なくても OK）")
                        .padding(.horizontal, 12).padding(.top, 8)
                    Text(selected.isEmpty ? "メンバーを選んでください（1 人以上）" : "\(selected.count) 人を選んでいます")
                        .font(.app(.caption)).foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                    if let e = groups.error {
                        Text(e).font(.app(.caption)).foregroundStyle(.red).padding(.horizontal, 12)
                    }
                    GDMMemberPicker(groups: groups, excluding: Set([groups.myUserId()].compactMap { $0 }),
                                    selected: $selected, room: max(0, groups.maxMembers - 1))
                }
            }
            Text("グループ DM は 30 日で消えます").font(.app(.caption2)).foregroundStyle(.tertiary).padding(.vertical, 6)
        }
        .onAppear { groups.error = nil }
    }

    private func create() {
        let ids = Array(selected)
        Task {
            if let g = await groups.create(name: name, memberIds: ids) { dm.route = .group(g.id) }
        }
    }
}

/// The group's name: up to `max` characters (the count shows near the end).
private struct GDMNameField: View {
    @Binding var name: String
    let max: Int
    let placeholder: String

    var body: some View {
        HStack {
            TextField(placeholder, text: $name)
                .textFieldStyle(.roundedBorder)
                .font(.app(.callout))
                .onChange(of: name) { _, v in if v.count > max { name = String(v.prefix(max)) } }
                .accessibilityLabel("グループの名前")
            if name.count > max - 10 {
                Text("\(name.count)/\(max)").font(.app(.caption2)).foregroundStyle(.secondary).monospacedDigit()
            }
        }
    }
}

/// 「メンバー」: who is in, add, remove (its maker only), leave, rename, 🔕.
struct GDMMembersView: View {
    let dm: DMStore
    @Bindable var groups: GroupDMStore
    let groupId: Int
    @State private var name = ""
    @State private var nameLoaded = false
    @State private var adding = false
    @State private var selected: Set<String> = []
    @State private var confirmLeave = false
    @State private var removing: GDMMember?

    private var group: GDMGroup? { groups.group ?? groups.summary(groupId)?.group }

    var body: some View {
        VStack(spacing: 0) {
            DMHeader(title: "メンバー（\(group?.memberCount ?? group?.members.count ?? 0) 人）",
                     onBack: { dm.route = .group(groupId) }, onClose: dm.close) {
                Text("👥").font(.app(.body))
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let e = groups.error {
                        Text(e).font(.app(.caption)).foregroundStyle(.red)
                    }
                    if groups.canSend { nameSection }
                    if groups.canSend { muteSection }
                    Divider()
                    membersSection
                    if groups.canSend { addSection }
                    Divider()
                    if groups.canSend {
                        Button(role: .destructive) { confirmLeave = true } label: {
                            Label("グループを抜ける", systemImage: "rectangle.portrait.and.arrow.right").font(.app(.callout))
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.red)
                        .disabled(groups.busy)
                        .confirmationDialog("このグループを抜けますか？", isPresented: $confirmLeave, titleVisibility: .visible) {
                            Button("抜ける", role: .destructive) { Task { await groups.leave() } }
                            Button("やめる", role: .cancel) {}
                        } message: {
                            Text("抜けると、このグループの発言は見られなくなります。")
                        }
                    }
                }
                .padding(12)
            }
        }
        .onAppear {
            groups.error = nil
            if !nameLoaded { name = group?.name ?? ""; nameLoaded = true }
        }
        .confirmationDialog("\(removing?.displayName ?? "") さんをグループから外しますか？",
                            isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }),
                            titleVisibility: .visible) {
            Button("外す", role: .destructive) {
                if let m = removing { Task { await groups.remove(m.userId) } }
                removing = nil
            }
            Button("やめる", role: .cancel) { removing = nil }
        }
    }

    private var nameSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("グループの名前").font(.app(.caption, weight: .medium)).foregroundStyle(.secondary)
            HStack(spacing: 8) {
                GDMNameField(name: $name, max: groups.maxName, placeholder: "なし（メンバーの名前を出します）")
                Button("保存") { Task { await groups.rename(name) } }
                    .font(.app(.callout))
                    .buttonStyle(.borderless)
                    .disabled(groups.busy || GDMLogic.cleanName(name, max: groups.maxName) == group?.name)
            }
        }
    }

    private var muteSection: some View {
        Toggle(isOn: Binding(get: { group?.muted ?? false }, set: { v in Task { await groups.setMuted(v) } })) {
            Text("🔕 通知を切る").font(.app(.callout))
        }
        .disabled(groups.busy)
        .accessibilityLabel("このグループの通知を切る")
    }

    private var membersSection: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(group?.members ?? []) { m in
                HStack(spacing: 10) {
                    AvatarView(url: m.avatar, name: m.displayName, size: 30)
                    Text(m.displayName + (m.isMe == true ? "（あなた）" : "")).font(.app(.callout)).lineLimit(1)
                    if m.isCreator == true {
                        Text("作った人").font(.app(.caption2)).foregroundStyle(.secondary)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Capsule().fill(Color.primary.opacity(0.06)))
                    }
                    Spacer()
                    if group?.isCreator == true, m.isMe != true, groups.canSend {
                        Button("外す") { removing = m }
                            .font(.app(.caption))
                            .buttonStyle(.borderless)
                            .foregroundStyle(.red)
                            .disabled(groups.busy)
                            .accessibilityLabel("\(m.displayName) さんを外す")
                    }
                }
                .padding(.vertical, 5)
            }
        }
    }

    @ViewBuilder private var addSection: some View {
        let count = group?.memberCount ?? group?.members.count ?? 0
        if adding {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Text("追加する人を選ぶ").font(.app(.caption, weight: .medium)).foregroundStyle(.secondary)
                    Spacer()
                    Button("やめる") { adding = false; selected = [] }.font(.app(.callout)).buttonStyle(.borderless)
                    Button(selected.isEmpty ? "追加する" : "\(selected.count) 人を追加") {
                        let ids = Array(selected)
                        Task {
                            if await groups.add(ids) { adding = false; selected = [] }
                        }
                    }
                    .font(.app(.callout, weight: .semibold))
                    .buttonStyle(.borderless)
                    .disabled(selected.isEmpty || groups.busy)
                }
                GDMMemberPicker(groups: groups, excluding: Set((group?.members ?? []).map(\.userId) + [groups.myUserId()].compactMap { $0 }),
                                selected: $selected, room: max(0, groups.maxMembers - count))
            }
        } else if count < groups.maxMembers {
            Button { adding = true } label: {
                Label("メンバーを追加", systemImage: "plus").font(.app(.callout))
            }
            .buttonStyle(.borderless)
        }
    }
}
