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
    /// 一覧を開く前に（iPhone: チャットのページへ。DM の一覧はチャットの上に出る）。
    var beforeOpen: (() -> Void)? = nil

    var body: some View {
        if dm.enabled {
            Button { beforeOpen?(); dm.openList() } label: {
                Image(systemName: "envelope")
                    .font(.app(.body))
                    .overlay(alignment: .topTrailing) {
                        if dm.totalUnread > 0 {
                            Text(dm.totalUnread > 99 ? "99+" : "\(dm.totalUnread)")
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
            .help("DM（30 日で消えます）")
            .accessibilityLabel(dm.totalUnread > 0 ? "DM、未読 \(dm.totalUnread) 件" : "DM")
        }
    }
}

/// How the DM screens sit: over the chat (closable), as a tab of their own (the Mac: no ✕), or
/// pushed in the iPhone / iPad tab's NavigationStack (the bar shows the title and the buttons, back is the system's).
enum DMPresentation { case overlay, tab, navigation }

extension EnvironmentValues {
    @Entry var dmPresentation: DMPresentation = .overlay
}

/// The list or one conversation, whichever is open. Mac: the ✉️ tab (`tabPicker` in the list's header;
/// nothing open = the list).
struct DMScreen: View {
    @Bindable var dm: DMStore
    var tabPicker: AnyView? = nil

    var body: some View {
        VStack(spacing: 0) {
            DMRouteView(dm: dm, route: dm.route ?? .list, tabPicker: tabPicker)
        }
        #if os(macOS)
        .background(.regularMaterial)
        #endif
    }
}

/// One DM screen for a route (the Mac's tab / overlay, and each page of the iPhone's navigation path).
struct DMRouteView: View {
    let dm: DMStore
    let route: DMRoute
    var tabPicker: AnyView? = nil

    var body: some View {
        switch route {
        case let .thread(peer):
            DMThreadView(dm: dm, peer: peer)
                .id(peer.userId)
        case let .group(id):
            GDMThreadView(dm: dm, groups: dm.groups, groupId: id)
                .id("g-\(id)")
        case let .groupMembers(id):
            GDMMembersView(dm: dm, groups: dm.groups, groupId: id)
                .id("gm-\(id)")
        case .newGroup:
            GDMNewGroupView(dm: dm, groups: dm.groups)
        case .list:
            DMListView(dm: dm, tabPicker: tabPicker)
        }
    }
}

#if os(iOS)
/// ✉️ as a page of its own (iPhone: after 💬; iPad: the left column): the list, and a conversation pushed
/// over it (back = the list). The navigation path follows the store's route both ways, so a name in the
/// chat or a notification (DMStore.open) shows that conversation here.
struct DMTabScreen: View {
    let dm: DMStore
    let tabPicker: AnyView

    var body: some View {
        // Read here (in body), so a change of route redraws the stack.
        let path = DMRoute.path(for: dm.route)
        NavigationStack(path: Binding(get: { path }, set: { dm.route = DMRoute.route(for: $0) })) {
            DMListView(dm: dm, tabPicker: tabPicker)
                .navigationDestination(for: DMRoute.self) { r in
                    DMRouteView(dm: dm, route: r)
                        .environment(\.dmPresentation, .navigation)
                }
        }
    }
}
#endif

struct DMHeader<Leading: View, Trailing: View>: View {
    let title: String
    let onBack: () -> Void
    let onClose: () -> Void
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing
    @Environment(\.dmPresentation) private var presentation

    var body: some View {
        #if os(iOS)
        if presentation == .navigation {
            // In the tab's NavigationStack: the system bar (back = swipe or ‹), this header takes no room.
            Color.clear.frame(height: 0)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) {
                        HStack(spacing: 8) {
                            leading
                            Text(title).font(.app(.headline)).lineLimit(1)
                        }
                    }
                    ToolbarItem(placement: .topBarTrailing) { trailing }
                }
        } else {
            bar
        }
        #else
        bar
        #endif
    }

    private var bar: some View {
        HStack(spacing: 8) {
            Button(action: onBack) { Image(systemName: "chevron.left").font(.app(.body, weight: .semibold)) }
                .buttonStyle(.borderless)
                .accessibilityLabel("戻る")
                .keyboardShortcut(.cancelAction)
            leading
            Text(title).font(.app(.headline)).lineLimit(1)
            Spacer()
            trailing
            if presentation == .overlay {
                Button(action: onClose) { Image(systemName: "xmark").font(.app(.callout)) }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("閉じる")
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }
}

extension DMHeader where Trailing == EmptyView {
    init(title: String, onBack: @escaping () -> Void, onClose: @escaping () -> Void, @ViewBuilder leading: () -> Leading) {
        self.init(title: title, onBack: onBack, onClose: onClose, leading: leading, trailing: { EmptyView() })
    }
}

/// One line of the DM list: a 1:1 conversation or a 👥 group, newest first together.
enum DMListEntry: Identifiable {
    case one(DMConversation)
    case group(GDMSummary)

    var id: String {
        switch self {
        case let .one(c): return "u-\(c.peer.userId)"
        case let .group(s): return "g-\(s.group.id)"
        }
    }

    var at: String? {
        switch self {
        case let .one(c): return c.lastMessage.createdAt
        case let .group(s): return GDMLogic.activity(s)
        }
    }

    @MainActor static func merged(_ dm: DMStore) -> [DMListEntry] {
        let groups = dm.groups.enabled ? dm.groups.summaries.map(DMListEntry.group) : []
        return GDMLogic.newestFirst(dm.conversations.map(DMListEntry.one) + groups, at: \.at)
    }
}

struct DMListView: View {
    let dm: DMStore
    /// ✉️ as a tab: the app's switch takes the header's place (iPhone / iPad: in the navigation bar).
    var tabPicker: AnyView? = nil
    /// 「＋ 新規 DM」 is open.
    @State private var newDM = false

    @ViewBuilder private var headerButtons: some View {
        if dm.canSend {
            // ＋ 新規 DM: a name (completed) → that person's conversation (オーナー 2026-11-08).
            Button { newDM = true } label: {
                Label("新規 DM", systemImage: "square.and.pencil").font(.app(.callout))
            }
            .buttonStyle(.borderless)
            .help("新しい DM を書く（名前で探す）")
            .accessibilityLabel("新規 DM")
        }
        if dm.groups.enabled, dm.groups.canSend {
            // 👥 グループ DM: pick members (and a name) → a new group.
            Button { dm.route = .newGroup } label: {
                Label("グループ", systemImage: "plus").font(.app(.callout))
            }
            .buttonStyle(.borderless)
            .help("グループ DM を作る")
            .accessibilityLabel("グループ DM を作る")
        }
    }

    var body: some View {
        main
            #if os(iOS)
            .sheet(isPresented: $newDM) {
                DMNewChatView(dm: dm) { newDM = false }
                    .presentationDetents([.medium, .large])
            }
            #else
            .overlay {
                if newDM {
                    Color.black.opacity(0.3).onTapGesture { newDM = false }
                    DMNewChatView(dm: dm) { newDM = false }
                        .frame(maxWidth: 420, maxHeight: 460)
                        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))
                        .shadow(radius: 12)
                        .padding(16)
                }
            }
            #endif
    }

    @ViewBuilder private var main: some View {
        if let tabPicker {
            #if os(iOS)
            content
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .principal) { tabPicker }
                    ToolbarItem(placement: .topBarTrailing) { HStack(spacing: 12) { headerButtons } }
                }
            #else
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    tabPicker
                    Spacer()
                    headerButtons
                }
                .padding(.horizontal, 12).padding(.vertical, 8)
                Divider()
                content
            }
            #endif
        } else {
            VStack(spacing: 0) {
                DMHeader(title: "DM", onBack: dm.close, onClose: dm.close) { EmptyView() } trailing: { headerButtons }
                Divider()
                content
            }
        }
    }

    private var content: some View {
        VStack(spacing: 0) {
            let entries = DMListEntry.merged(dm)
            if entries.isEmpty {
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
                        ForEach(entries) { e in
                            switch e {
                            case let .one(c):
                                Button { dm.route = .thread(c.peer) } label: { row(c) }
                                    .buttonStyle(.plain)
                            case let .group(s):
                                Button { dm.route = .group(s.group.id) } label: { GDMListRow(s: s) }
                                    .buttonStyle(.plain)
                            }
                            Divider().padding(.leading, 56)
                        }
                    }
                }
            }
            Text("DM は 30 日で消えます").font(.app(.caption2)).foregroundStyle(.tertiary).padding(.vertical, 6)
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
                    Text((c.lastMessage.isAuthor ? "あなた: " : "") + c.lastMessage.shownBody)
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
    /// What was just sent, to swallow a late echo of it (dictation finalising after Send).
    @State private var justSent: (text: String, at: Date)?
    @State private var focused = false
    /// 📷 Photos for the next message (the chat's tray; up to features.dm.max_images).
    @State private var photos: PostDraft
    /// A photo opened full screen.
    @State private var viewing: ImageViewerItem?

    init(dm: DMStore, peer: DMPeer) {
        _dm = Bindable(dm)
        self.peer = peer
        _photos = State(initialValue: PostDraft(maxImages: max(1, dm.maxImages)))
    }

    var body: some View {
        VStack(spacing: 0) {
            DMHeader(title: shown.displayName, onBack: dm.showList, onClose: dm.close) {
                AvatarView(url: shown.avatar, name: shown.displayName, size: 26)
            }
            Divider()
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 6) {
                        if dm.thread.isEmpty {
                            Text(dm.loading ? "読み込み中…" : "\(peer.displayName) さんとの DM（30 日で消えます）")
                                .font(.app(.callout)).foregroundStyle(.secondary)
                                .frame(maxWidth: .infinity).padding(.top, 40)
                        }
                        ForEach(dm.thread, id: \.stableId) { m in
                            DMBubble(m: m, localImages: m.clientId.flatMap { dm.outgoingPhotos[$0]?.previews } ?? [],
                                     onOpenImage: { i in viewing = ImageViewerItem(images: m.images, index: i) },
                                     onRetry: { dm.retry(m) }, onDiscard: { dm.discard(m) })
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
        .imageViewer($viewing)
        .dmPhotoInput(photos, enabled: canAttach)
    }

    /// The person as the store last said (the name and face come in after loading).
    private var shown: DMPeer { dm.openPeer?.userId == peer.userId ? dm.openPeer! : peer }

    /// 📷 Photos can go with the next message.
    private var canAttach: Bool { dm.canSendImages && dm.canSend && dm.peerCanReceive }

    @ViewBuilder private var composer: some View {
        if dm.canSend && dm.peerCanReceive {
            VStack(alignment: .leading, spacing: 4) {
                if canAttach { DMDraftTray(draft: photos) }
                HStack(alignment: .bottom, spacing: 8) {
                    if canAttach { DMAttachButtons(draft: photos) }
                    // The chat's text box (iOS: ComposerTextView): clearing it after a send drops leftover
                    // IME / dictation text in place, without making a new field — a new field each send
                    // made the keyboard go down and come back up (drikin 2026-10-24).
                    PostTextInput(text: $draft, isFocused: $focused, placeholder: "\(peer.displayName) さんへ",
                                  onSubmit: send, onPasteImage: canAttach ? { photos.add(imageData: $0) } : nil)
                        .font(.app(.body))
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(RoundedRectangle(cornerRadius: 16).fill(Color.primary.opacity(0.06)))
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
                    Text("DM は 30 日で消えます").font(.app(.caption2)).foregroundStyle(.tertiary)
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
        return (!t.isEmpty || (canAttach && !photos.images.isEmpty)) && t.count <= dm.maxBody
    }

    private func send() {
        guard canSendDraft else { return }
        let text = draft
        dm.send(text, photos: canAttach ? photos.takePhotos() : nil)
        justSent = (text, Date())
        draft = "" // the text box drops leftover marked text itself (see above)
        DispatchQueue.main.async {
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
    /// Previews of photos still being sent (the stored message has their URLs instead).
    var localImages: [PlatformImage] = []
    /// Tap on a photo: open it full screen (index into `m.images`).
    var onOpenImage: ((Int) -> Void)? = nil
    let onRetry: () -> Void
    let onDiscard: () -> Void

    private var hasPhotos: Bool { !m.images.isEmpty || !localImages.isEmpty }

    var body: some View {
        HStack {
            if m.isAuthor { Spacer(minLength: 40) }
            VStack(alignment: m.isAuthor ? .trailing : .leading, spacing: 2) {
                if hasPhotos {
                    // 📷 the chat's photo grid (one big, or two columns), tap = full screen.
                    ChatPhotos(paths: m.images, local: m.images.isEmpty ? localImages : [], onOpen: onOpenImage)
                        .padding(.bottom, m.body.isEmpty ? 0 : 2)
                }
                if !m.body.isEmpty || !hasPhotos {
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
        .accessibilityLabel("\(m.isAuthor ? "自分" : "相手")、\(m.body)\(m.images.isEmpty ? "" : "、写真 \(m.images.count) 枚")\(m.failed ? "、送信失敗" : "")")
    }
}

/// 「＋ 新規 DM」: a name (completed from the members, the group picker's rule — never everyone up front) →
/// that person's conversation. iPhone / iPad: a sheet; Mac: laid over the list (a sheet bigger than the panel drew wrongly).
struct DMNewChatView: View {
    let dm: DMStore
    let onClose: () -> Void
    @State private var query = ""
    @FocusState private var focused: Bool

    var body: some View {
        let groups = dm.groups
        let list = GDMLogic.newDMList(groups.directory, id: \.userId, name: \.name, me: groups.myUserId(),
                                      peerIds: groups.peerIds, query: query)
        VStack(spacing: 0) {
            HStack {
                Text("新規 DM").font(.app(.headline))
                Spacer()
                Button("キャンセル", action: onClose).buttonStyle(.borderless).font(.app(.callout))
                    .keyboardShortcut(.cancelAction)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            TextField("名前を入れて探す", text: $query)
                .textFieldStyle(.roundedBorder)
                .font(.app(.callout))
                .focused($focused)
                .autocorrectionDisabled()
                #if os(iOS)
                .textInputAutocapitalization(.never)
                #endif
                .padding(.horizontal, 12).padding(.bottom, 6)
                .accessibilityLabel("DM する相手を名前で探す")
            Divider()
            ScrollView {
                LazyVStack(spacing: 0) {
                    if list.isEmpty {
                        Text(query.trimmingCharacters(in: .whitespaces).isEmpty ? "名前を入れて探してください"
                             : groups.directory.isEmpty ? "読み込み中…" : "見つかりません")
                            .font(.app(.caption)).foregroundStyle(.secondary).padding()
                    } else if query.trimmingCharacters(in: .whitespaces).isEmpty {
                        Text("DM したことのある人").font(.app(.caption)).foregroundStyle(.secondary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 2)
                    }
                    ForEach(list, id: \.userId) { m in
                        Button {
                            onClose()
                            dm.route = .thread(DMPeer(userId: m.userId, name: m.name, avatar: m.avatar))
                        } label: {
                            HStack(spacing: 10) {
                                AvatarView(url: m.avatar, name: m.name, size: 28)
                                Text(m.name).font(.app(.callout)).lineLimit(1)
                                Spacer()
                                Image(systemName: "chevron.right").font(.app(.caption)).foregroundStyle(.tertiary)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("\(m.name) さんに DM")
                        Divider().padding(.leading, 50)
                    }
                }
            }
        }
        .task { await groups.loadDirectory() }
        .onAppear { focused = true }
    }
}
