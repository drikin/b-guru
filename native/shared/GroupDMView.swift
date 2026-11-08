import SwiftUI
import PhotosUI
import UniformTypeIdentifiers

// 👥 グループ DM — the screens (state: GroupDMStore.swift). Shown inside DMScreen (iPhone: the DM sheet;
// Mac: over the chat), with the same header, bubbles and words as the 1:1 DM (DMView.swift).

/// A group's line in the DM list: 👥, its title, the last message and the unread count.
struct GDMListRow: View {
    let s: GDMSummary

    var body: some View {
        HStack(spacing: 10) {
            GDMGroupPhoto(path: s.group.photoPath, size: 36)
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
    /// 📷 Photos for the next message (the chat's tray; the 1:1 DM's limits).
    @State private var photos: PostDraft
    /// A photo opened full screen.
    @State private var viewing: ImageViewerItem?
    /// ✏️ My message open in the composer for editing (the chat's ChatComposerModel.editingId).
    @State private var editingId: Int?

    init(dm: DMStore, groups: GroupDMStore, groupId: Int) {
        self.dm = dm
        _groups = Bindable(groups)
        self.groupId = groupId
        _photos = State(initialValue: PostDraft(maxImages: max(1, groups.maxImages)))
    }

    private var title: String { (groups.group ?? groups.summary(groupId)?.group)?.displayTitle ?? "グループ" }

    var body: some View {
        VStack(spacing: 0) {
            DMHeader(title: title, onBack: dm.showList, onClose: dm.close) {
                GDMGroupPhoto(path: (groups.group ?? groups.summary(groupId)?.group)?.photoPath, size: 26, plain: true)
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
                                          localImages: m.clientId.flatMap { groups.outgoingPhotos[$0]?.previews } ?? [],
                                          mentionsMe: !m.isAuthor && GDMLogic.mentions(m.body, name: myName),
                                          canReact: groups.canReact, canEdit: groups.canEdit && m.canBeEdited,
                                          editing: editingId == m.id,
                                          onOpenImage: { i in viewing = ImageViewerItem(images: m.images, index: i) },
                                          onReact: { groups.toggleReaction(m.id, emoji: $0) }, onEdit: { beginEdit(m) },
                                          onReply: canReply(m) ? { replyTo(m.senderName) } : nil,
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
        .imageViewer($viewing)
        .dmPhotoInput(photos, enabled: canAttach)
    }

    /// 📷 Photos can go with the next message (not while editing: photos stay as they are).
    private var canAttach: Bool { groups.canSendImages && groups.canSend && groups.groupCanSend && editingId == nil }

    /// My name in this group (whose @mentions get the chat's yellow).
    private var myName: String? { groups.group?.me?.name }

    /// The message being edited (nil when it is gone).
    private var editingMessage: GDMMessage? { editingId.flatMap { id in groups.thread.first { $0.id == id } } }

    /// ↩️ Others' stored messages, ビーグル's too (@ビーグル asks it again), not system lines.
    private func canReply(_ m: GDMMessage) -> Bool { groups.canSend && groups.groupCanSend && !m.isAuthor && m.isStored && !m.isSystem }

    /// ↩️ The chat's reply: `@名前 ` at the start of the composer (keeps what was typed).
    private func replyTo(_ name: String) {
        let token = Mention.token(name)
        if editingId != nil { editingId = nil; draft = "" }
        if !draft.hasPrefix(token) { draft = token + draft.trimmingCharacters(in: .whitespaces) }
        focused = true
    }

    private func beginEdit(_ m: GDMMessage) {
        editingId = m.id
        draft = m.body
        focused = true
    }

    private func cancelEdit() {
        editingId = nil
        draft = ""
    }

    @ViewBuilder private var composer: some View {
        if groups.canSend && groups.groupCanSend {
            VStack(alignment: .leading, spacing: 4) {
                if editingId != nil { DMEditingBar(onCancel: cancelEdit) }
                if canAttach { DMDraftTray(draft: photos) }
                HStack(alignment: .bottom, spacing: 8) {
                    if canAttach { DMAttachButtons(draft: photos) }
                    PostTextInput(text: $draft, isFocused: $focused, placeholder: editingId != nil ? "編集内容" : (groups.summary(groups.openId ?? -1)?.group.beagle == true) ? "\(title) へ（@ビーグル で質問・要約）" : "\(title) へ",
                                  onSubmit: send, onPasteImage: canAttach ? { photos.add(imageData: $0) } : nil)
                        .font(.app(.body))
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 16).fill(Color.primary.opacity(0.06)))
                        .onChange(of: draft) { old, new in
                            if isLateEcho(old: old, new: new) { draft = "" }
                        }
                        .accessibilityLabel("グループ DM の本文")
                    Button(action: send) {
                        Image(systemName: editingId == nil ? "arrow.up.circle.fill" : "checkmark.circle.fill").font(.app(size: 26))
                            .foregroundStyle(canSendDraft ? Color.accentGreen : Color.secondary)
                    }
                    .buttonStyle(.borderless)
                    .disabled(!canSendDraft)
                    .accessibilityLabel(editingId == nil ? "送信" : "保存")
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
        if editingId != nil {
            guard let m = editingMessage else { return false }
            return DMLogic.editedBody(draft, hasPhotos: !m.images.isEmpty, maxBody: groups.maxBody) != nil
        }
        let t = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        return (!t.isEmpty || (canAttach && !photos.images.isEmpty)) && t.count <= groups.maxBody
    }

    private func send() {
        guard canSendDraft else { return }
        let text = draft
        if let id = editingId {
            // ✏️ Save (the chat's: the composer clears at once, the bubble changes optimistically).
            editingId = nil
            draft = ""
            Task { _ = await groups.edit(id, body: text) }
            return
        }
        groups.send(text, photos: canAttach ? photos.takePhotos() : nil)
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
    /// Previews of photos still being sent (the stored message has their URLs instead).
    var localImages: [PlatformImage] = []
    /// It names me (@): the chat's yellow bubble.
    var mentionsMe = false
    var canReact = false
    /// ✏️ offered (my own text, and the server lets group DMs be edited).
    var canEdit = false
    var editing = false
    /// Tap on a photo: open it full screen (index into `m.images`).
    var onOpenImage: ((Int) -> Void)? = nil
    var onReact: (String) -> Void = { _ in }
    var onEdit: () -> Void = {}
    /// ↩️ `@名前 ` into the composer (others' messages).
    var onReply: (() -> Void)? = nil
    let onRetry: () -> Void
    let onDiscard: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            if !m.isAuthor {
                Group {
                    if showsSender {
                        if m.isBeagle == true {
                            Text("🐶").font(.system(size: 15)).frame(width: 26, height: 26)
                                .background(Circle().fill(Color.yellow.opacity(0.25)))
                                .accessibilityLabel("ビーグル")
                        } else {
                            AvatarView(url: m.fromAvatar, name: m.senderName, size: 26)
                        }
                    }
                    else { Color.clear.frame(width: 26, height: 1) }
                }
                .padding(.top, showsSender ? 16 : 0)
            }
            VStack(alignment: m.isAuthor ? .trailing : .leading, spacing: 2) {
                if showsSender {
                    Text(m.senderName).font(.app(.caption, weight: .medium)).foregroundStyle(.secondary).lineLimit(1)
                }
                DMMessageContent(mine: m.isAuthor, text: m.body, images: m.images, localImages: localImages,
                                 stored: m.isStored, mentionsMe: mentionsMe, editing: editing,
                                 reactions: m.reactions, canReact: canReact && m.canBeReacted, canEdit: canEdit,
                                 authorName: m.isAuthor ? "自分" : m.senderName,
                                 onOpenImage: onOpenImage, onReact: onReact, onEdit: onEdit, onReply: onReply)
                if m.failed {
                    HStack(spacing: 6) {
                        Text("送信できませんでした").font(.app(.caption)).foregroundStyle(.red)
                        Button("再送", action: onRetry).linkButton().font(.app(.caption))
                        Button("取り消す", action: onDiscard).linkButton().font(.app(.caption)).tint(.secondary)
                    }
                } else {
                    DMTimeLine(createdAt: m.createdAt, edited: m.edited)
                }
            }
            .opacity(m.pending ? 0.6 : 1)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "❤️ を付ける") { if canReact && m.canBeReacted { onReact("❤️") } }
        .accessibilityAction(named: "編集") { if canEdit && m.canBeEdited { onEdit() } }
        .accessibilityAction(named: "返信") { onReply?() }
        .accessibilityLabel("\(m.isAuthor ? "自分" : m.senderName)、\(m.body)\(m.images.isEmpty ? "" : "、写真 \(m.images.count) 枚")\(mentionsMe ? "、あなたへのメンション" : "")\(m.edited ? "、編集済み" : "")\(m.failed ? "、送信失敗" : "")")
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
        let list = GDMLogic.pickerList(groups.directory, id: \.userId, name: \.name, excluding: excluding,
                                       peerIds: groups.peerIds, selected: selected, query: query)
        VStack(spacing: 0) {
            TextField("名前を入れて探す", text: $query)
                .textFieldStyle(.roundedBorder)
                .font(.app(.callout))
                .padding(.horizontal, 12).padding(.vertical, 6)
                .accessibilityLabel("メンバーを名前で探す")
            if list.isEmpty {
                Text(query.trimmingCharacters(in: .whitespaces).isEmpty ? "名前を入れて探してください"
                     : groups.directory.isEmpty ? "読み込み中…" : "見つかりません")
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
            DMHeader(title: "新しいグループ", onBack: dm.showList, onClose: dm.close) {
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
                GDMGroupPhoto(path: group?.photoPath, size: 26, plain: true)
            }
            Divider()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    if let e = groups.error {
                        Text(e).font(.app(.caption)).foregroundStyle(.red)
                    }
                    photoSection
                    if groups.canSend { nameSection }
                    if groups.canSend { muteSection }
                    if groups.canSend && groups.beagleAvailable { beagleSection }
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

    /// The group's photo: large, and (features.gdm.photo) 「写真を設定／写真を変える」 and 「外す」 — anyone in it may.
    private var photoSection: some View {
        HStack(spacing: 12) {
            GDMGroupPhoto(path: group?.photoPath, size: 64)
            if groups.photoEditable {
                VStack(alignment: .leading, spacing: 6) {
                    GDMPhotoPickButton(title: GDMLogic.photoButtonTitle(hasPhoto: group?.photoPath != nil),
                                       disabled: groups.busy) { data in
                        Task { await groups.setPhoto(data) }
                    } onUnreadable: {
                        groups.error = "画像を読み込めませんでした（別の写真で試してください）"
                    }
                    if group?.photoPath != nil {
                        Button(role: .destructive) { Task { await groups.removePhoto() } } label: {
                            Label("外す", systemImage: "trash").font(.app(.callout))
                        }
                        .buttonStyle(.borderless)
                        .foregroundStyle(.red)
                        .disabled(groups.busy)
                        .accessibilityLabel("グループの写真を外す")
                    }
                }
            }
            if groups.busy { ProgressView().controlSize(.small) }
            Spacer()
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

    private var beagleSection: some View {
        VStack(alignment: .leading, spacing: 4) {
            Toggle(isOn: Binding(get: { group?.beagle ?? false }, set: { v in Task { await groups.setBeagle(v) } })) {
                Text("🐶 ビーグルを呼べるようにする").font(.app(.callout))
            }
            .disabled(groups.busy)
            Text("@ビーグル で質問・要約できます。答えはメンバー全員に見えます。入る前の流れも、新しく入った人に要約で伝えます。切り替えるとグループに知らせます。")
                .font(.app(.caption)).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
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

/// The group's face: its photo in a circle, or 👥 when it has none or it cannot be read.
/// The photo is our server's `/api/gdm/:gid/photo?v=…`: MediaCache reads it with the member's Bearer
/// and keeps it (memory and disk) until `?v=` changes.
struct GDMGroupPhoto: View {
    let path: String?
    let size: CGFloat
    /// No circle behind 👥 (the headers, as before).
    var plain = false
    @State private var image: PlatformImage?
    @State private var loadedPath: String?

    /// Small faces at the avatar size, the members screen's larger one at 600 (the server's file is 512).
    private var pixels: Int { size <= 40 ? AvatarCache.pixels : 600 }
    private var showing: Bool { image != nil && loadedPath == path && path != nil }

    var body: some View {
        ZStack {
            if let image, showing {
                Image(platformImage: image).resizable().scaledToFill()
                    .frame(width: size, height: size)
                    .clipShape(Circle())
            } else if plain {
                Text("👥").font(.app(.body))
            } else {
                Circle().fill(Color.primary.opacity(0.06))
                Text("👥").font(.app(size: size * 0.55))
            }
        }
        .frame(width: showing || !plain ? size : nil, height: showing || !plain ? size : nil)
        .accessibilityHidden(true)
        .task(id: path) {
            guard let path else { image = nil; loadedPath = nil; return }
            if let hit = MediaCache.shared.cached(path, maxPixel: pixels) { image = hit; loadedPath = path; return }
            let img = await MediaCache.shared.image(for: path, maxPixel: pixels)
            guard !Task.isCancelled else { return }
            image = img
            loadedPath = img == nil ? nil : path
        }
    }
}

/// 「写真を設定」: iPhone / iPad — the photo library (PhotosPicker); Mac — a file (NSOpenPanel: JPEG・PNG・HEIC・WebP).
/// Hands back the picked image's bytes as they are (the store shrinks them).
private struct GDMPhotoPickButton: View {
    let title: String
    let disabled: Bool
    let onPicked: (Data) -> Void
    let onUnreadable: () -> Void
    #if os(iOS)
    @State private var pick: PhotosPickerItem?
    #endif

    var body: some View {
        #if os(iOS)
        PhotosPicker(selection: $pick, matching: .images) {
            Label(title, systemImage: "photo.on.rectangle").font(.app(.callout))
        }
        .buttonStyle(.borderless)
        .disabled(disabled)
        .accessibilityLabel("グループの\(title)")
        .onChange(of: pick) { _, item in
            guard let item else { return }
            pick = nil
            Task {
                if let data = await Self.load(item) { onPicked(data) } else { onUnreadable() }
            }
        }
        #else
        Button {
            Task {
                guard let url = await Self.choose() else { return }
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                if let data = try? Data(contentsOf: url), !data.isEmpty { onPicked(data) } else { onUnreadable() }
            }
        } label: {
            Label(title + "…", systemImage: "photo.on.rectangle").font(.app(.callout))
        }
        .buttonStyle(.borderless)
        .disabled(disabled)
        .accessibilityLabel("グループの\(title)")
        #endif
    }

    #if os(iOS)
    /// The photo's bytes (an original only in iCloud comes as a file).
    private static func load(_ item: PhotosPickerItem) async -> Data? {
        if let d = try? await item.loadTransferable(type: Data.self), !d.isEmpty { return d }
        if let file = try? await item.loadTransferable(type: PickedImageFile.self) {
            defer { try? FileManager.default.removeItem(at: file.url) }
            if let d = try? Data(contentsOf: file.url), !d.isEmpty { return d }
        }
        return nil
    }
    #else
    private static func choose() async -> URL? {
        let panel = NSOpenPanel()
        panel.title = "グループの写真"
        panel.prompt = "選ぶ"
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = false
        panel.allowedContentTypes = [.jpeg, .png, .heic, .webP]
        NSApp.activate()
        return await withCheckedContinuation { (c: CheckedContinuation<URL?, Never>) in
            panel.begin { r in c.resume(returning: r == .OK ? panel.url : nil) }
        }
    }
    #endif
}
