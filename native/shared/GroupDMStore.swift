import Foundation
import Observation

// 👥 グループ DM — the state (data and pure parts: GroupDMLogic.swift; screens: GroupDMView.swift).
// Lives inside DMStore (`dm.groups`): the same sheet / overlay, the same ✉️ badge (1:1 + groups).
// Off unless capabilities' features.gdm.enabled (GROUP_DM_ENABLED on the server); old servers say nothing → off.

extension APIClient {
    func gdmList(path: String) async throws -> GDMListResponse {
        try await send(request("GET", path))
    }

    /// `isPublic`: 🌐 a public group (needs a name; `memberIds` may be empty). Sent only when true (older servers).
    func gdmCreate(path: String, name: String?, memberIds: [String], isPublic: Bool = false) async throws -> GDMGroup {
        struct R: Decodable { var group: GDMGroup }
        var body: [String: Any] = ["member_ids": memberIds]
        if let name { body["name"] = name }
        if isPublic { body["public"] = true }
        let r: R = try await send(request("POST", path, json: body))
        return r.group
    }

    func gdmThread(path: String, groupId: Int) async throws -> GDMThreadResponse {
        try await send(request("GET", "\(path)/\(groupId)"))
    }

    func gdmSend(path: String, groupId: Int, body: String, clientId: String, images: [String] = []) async throws -> GDMMessage {
        struct R: Decodable { var message: GDMMessage }
        var json: [String: Any] = ["body": body, "client_id": clientId]
        if !images.isEmpty { json["images"] = images }
        let r: R = try await send(request("POST", "\(path)/\(groupId)/messages", json: json))
        return r.message
    }

    /// ✏️ PATCH {path}/messages/:id { body } → { message } (my own text only).
    func gdmEdit(path: String, id: Int, body: String) async throws -> GDMMessage {
        struct R: Decodable { var message: GDMMessage }
        let r: R = try await send(request("PATCH", "\(path)/messages/\(id)", json: ["body": body]))
        return r.message
    }

    /// 😀 POST {path}/messages/:id/reactions { emoji } → { added, reactions }.
    func gdmReact(path: String, id: Int, emoji: String) async throws -> [Reaction] {
        let r: DMReactionResponse = try await send(request("POST", "\(path)/messages/\(id)/reactions", json: ["emoji": emoji]))
        return r.reactions
    }

    /// The group's unread and all my groups' unread after reading up to `id`.
    func gdmRead(path: String, groupId: Int, upTo id: Int) async throws -> (unread: Int?, total: Int?) {
        struct R: Decodable { var unreadCount: Int?; var groupUnreadCount: Int? }
        let r: R = try await send(request("POST", "\(path)/\(groupId)/read", json: ["last_read_id": id]))
        return (r.unreadCount, r.groupUnreadCount)
    }

    /// `name`: NSNull clears it. `muted`: my own notifications of it.
    func gdmPatch(path: String, groupId: Int, _ body: [String: Any]) async throws -> GDMGroup {
        struct R: Decodable { var group: GDMGroup }
        let r: R = try await send(request("PATCH", "\(path)/\(groupId)", json: body))
        return r.group
    }

    /// 🌐 POST {path}/:gid/join {} → { group } (a public group: anyone may).
    func gdmJoin(path: String, groupId: Int) async throws -> GDMGroup {
        struct R: Decodable { var group: GDMGroup }
        let r: R = try await send(request("POST", "\(path)/\(groupId)/join", json: [String: Any]()))
        return r.group
    }

    func gdmAddMembers(path: String, groupId: Int, userIds: [String]) async throws -> GDMGroup {
        struct R: Decodable { var group: GDMGroup }
        let r: R = try await send(request("POST", "\(path)/\(groupId)/members", json: ["user_ids": userIds]))
        return r.group
    }

    /// The group's photo: one JPEG (already shrunk) as multipart `photo` → the group with its new `photo`.
    func gdmSetPhoto(path: String, groupId: Int, jpeg: Data) async throws -> GDMGroup {
        struct R: Decodable { var group: GDMGroup }
        let boundary = "bguru-\(UUID().uuidString)"
        var req = request("POST", "\(path)/\(groupId)/photo")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = GDMLogic.photoMultipart(jpeg, boundary: boundary)
        req.timeoutInterval = 120
        let r: R = try await send(req)
        return r.group
    }

    func gdmRemovePhoto(path: String, groupId: Int) async throws -> GDMGroup {
        struct R: Decodable { var group: GDMGroup }
        let r: R = try await send(request("DELETE", "\(path)/\(groupId)/photo"))
        return r.group
    }

    /// Myself: leave. Someone else: remove them (only its maker may).
    func gdmRemoveMember(path: String, groupId: Int, userId: String) async throws {
        struct R: Decodable { var ok: Bool? }
        let _: R = try await send(request("DELETE", "\(path)/\(groupId)/members/\(userId)"))
    }
}

@MainActor
@Observable
final class GroupDMStore {
    private(set) var enabled = false
    private(set) var canSend = false
    private(set) var maxBody = 1000
    private(set) var maxName = 40
    private(set) var maxMembers = 100
    /// The group's photo may be set / removed here (features.gdm.photo; old servers say nothing → only shown).
    private(set) var photoEditable = false
    private(set) var beagleAvailable = false
    /// 🌐 Public groups (features.gdm.public): the list's part, joining, making one. Older servers → off.
    private(set) var publicAvailable = false
    /// 🗄 Archive (features.gdm.archive): the list's folded part, 「アーカイブする／戻す」. Older servers → off.
    private(set) var archiveAvailable = false
    /// The member limit of a public group (features.gdm.public_max_members).
    private(set) var maxPublicMembers = 1000
    private(set) var maxPhotoBytes = 15 * 1024 * 1024
    /// 📷 Photos in messages (the 1:1 DM's features.dm.max_images / upload_path; set by DMStore).
    private(set) var canSendImages = false
    private(set) var maxImages = 4
    /// ✏️ My own text may be edited / 😀 messages reacted to (features.gdm.edit / .reactions; older servers → off).
    private(set) var canEdit = false
    private(set) var canReact = false
    private var uploadPath = "/api/agent/dm/upload"
    /// Photos of messages still being sent, by clientId (previews for the bubble; kept for a retry).
    private(set) var outgoingPhotos: [String: OutgoingPhotos] = [:]
    /// My groups, newest first.
    private(set) var summaries: [GDMSummary] = []
    /// 🌐 Public groups I have not joined (the list's 「パブリック DM」).
    private(set) var publicSummaries: [GDMSummary] = []
    /// 🗄 Archived public groups (the list's folded 「アーカイブ」).
    private(set) var archivedSummaries: [GDMSummary] = []
    /// All my groups' unread (`group_unread_count`; added to the 1:1 count for the ✉️ badge).
    private(set) var unreadCount = 0
    /// The group open now (its conversation or its members screen); set by DMStore's route.
    private(set) var openId: Int?
    /// The open group's conversation is what is on screen (not its members screen).
    private(set) var threadOnScreen = false
    /// The open group (members, name, mute), as the server last said.
    private(set) var group: GDMGroup?
    /// The open group's messages (oldest first).
    private(set) var thread: [GDMMessage] = []
    private(set) var groupCanSend = true
    private(set) var loading = false
    /// A member change on its way (the members screen's buttons wait).
    private(set) var busy = false
    var error: String?
    /// The app is in front (iPhone: active scene; Mac: panel on screen) — read marks only then.
    var appVisible = true {
        didSet {
            if appVisible, !oldValue {
                markSeen()
                if threadOnScreen, let id = openId { onShowing?(id) }
            }
        }
    }
    /// Members to pick from (the chat's @mention list, GET /api/agent/members).
    private(set) var directory: [MentionMember] = []
    /// My 1:1 DM partners: the only people the picker shows before a name is typed.
    private(set) var peerIds: Set<String> = []

    /// That group's conversation came on screen (the iPhone removes its notifications).
    @ObservationIgnored var onShowing: ((Int) -> Void)?
    /// Someone's message arrived in a group that is not on screen and not muted (the Mac posts a notification).
    @ObservationIgnored var onIncoming: ((GDMMessage, GDMGroup) -> Void)?
    /// The open group is gone for me (I left, was removed, it was deleted): DMStore goes back to the list.
    @ObservationIgnored var onOpenRemoved: (() -> Void)?
    /// The chat's member list, when it has one (saves a request).
    @ObservationIgnored var chatMembers: () -> [MentionMember] = { [] }
    /// The people I have 1:1 DMs with (mixed into the choices, no repeats — as on the web).
    @ObservationIgnored var dmPeers: () -> [MentionMember] = { [] }
    /// My own user id when the chat knows it (left out of the choices when making a group).
    @ObservationIgnored var myUserId: () -> String? = { nil }

    private let api: APIClient
    private var path = "/api/agent/gdm"
    private var demo = false
    private var tempSeq = 0
    private var readTask: Task<Void, Never>?
    private var pruneTask: Task<Void, Never>?

    init(api: APIClient) {
        self.api = api
    }

    /// That group's conversation is on screen now (its notification would only repeat it).
    func isShowing(groupId: Int) -> Bool { appVisible && threadOnScreen && openId == groupId }

    func summary(_ id: Int) -> GDMSummary? { summaries.first { $0.group.id == id } }

    /// Any group the list knows (mine, 🌐 public, 🗄 archived).
    func knownGroup(_ id: Int) -> GDMGroup? {
        (summaries.first { $0.id == id } ?? publicSummaries.first { $0.id == id } ?? archivedSummaries.first { $0.id == id })?.group
    }

    /// What the open conversation shows in its composer's place.
    var composerMode: GDMComposerMode {
        GDMLogic.composerMode(group ?? openId.flatMap(knownGroup), canSend: canSend, groupCanSend: groupCanSend)
    }

    /// The member limit for this group (public ones have their own).
    func memberLimit(_ g: GDMGroup?) -> Int { g?.isPublicDM == true ? maxPublicMembers : maxMembers }

    private var sections: GDMListSections {
        get { GDMListSections(mine: summaries, publicGroups: publicSummaries, archived: archivedSummaries) }
        set {
            if newValue.mine != summaries { summaries = newValue.mine }
            if newValue.publicGroups != publicSummaries { publicSummaries = newValue.publicGroups }
            if newValue.archived != archivedSummaries { archivedSummaries = newValue.archived }
        }
    }

    func configure(_ f: Capabilities.GDMFeatures?, dmOn: Bool) {
        let on = dmOn && (f?.enabled ?? false)
        let wasOn = enabled
        enabled = on
        canSend = on && (f?.send ?? false)
        maxBody = f?.maxBody ?? 1000
        maxName = f?.maxName ?? 40
        maxMembers = f?.maxMembers ?? 100
        photoEditable = canSend && (f?.photo ?? false)
        beagleAvailable = canSend && (f?.beagle ?? false)
        canEdit = canSend && (f?.edit ?? false)
        canReact = canSend && (f?.reactions ?? false)
        publicAvailable = on && (f?.public ?? false)
        archiveAvailable = on && (f?.archive ?? false)
        if let n = f?.publicMaxMembers, n > 0 { maxPublicMembers = n }
        if let b = f?.photoMaxBytes, b > 0 { maxPhotoBytes = b }
        if let h = f?.ttlHours, h > 0 { GDMLogic.ttl = TimeInterval(h) * 3600 }
        if let p = f?.path, p.hasPrefix("/api/") { path = p }
        if !on { summaries = []; publicSummaries = []; archivedSummaries = []; unreadCount = 0; thread = []; group = nil }
        if on, !wasOn {
            Task { await reload() }
            startPruning()
        }
        if !on { pruneTask?.cancel() }
    }

    /// 📷 From the 1:1 DM's capabilities (the same upload and limits for groups).
    func configurePhotos(on: Bool, max: Int, uploadPath: String) {
        canSendImages = on && canSend
        maxImages = max
        self.uploadPath = uploadPath
    }

    func reload() async {
        guard enabled, !demo else { return }
        if let r = try? await api.gdmList(path: path) {
            var next = GDMLogic.sections(r)
            if !publicAvailable { next.publicGroups = [] }
            if !archiveAvailable { next.archived = [] }
            sections = next
            // Archived groups are never counted (the server leaves them out of group_unread_count too).
            unreadCount = r.groupUnreadCount ?? next.mine.reduce(0) { $0 + $1.unreadCount }
        }
    }

    // MARK: Opening (DMStore's route)

    /// `thread`: its conversation is on screen (false: its members screen).
    func show(_ id: Int, thread onScreen: Bool) {
        let changed = openId != id
        openId = id
        threadOnScreen = onScreen
        if changed {
            group = knownGroup(id)
            // Until it is read: no composer for a public group I am not in, or an archived one.
            groupCanSend = group.map(GDMLogic.belongsInMyList) ?? true
            thread = []
            error = nil
            Task { await load(id) }
        } else if onScreen {
            markSeen()
        }
        if onScreen, appVisible { onShowing?(id) }
    }

    func hide() {
        openId = nil
        threadOnScreen = false
        group = nil
        thread = []
        error = nil
    }

    private func load(_ id: Int) async {
        if demo {
            thread = GDMLogic.pruned(demoThreads[id] ?? [])
            group = knownGroup(id)
            markSeen()
            return
        }
        loading = true
        defer { loading = false }
        do {
            let r = try await api.gdmThread(path: path, groupId: id)
            guard openId == id else { return }
            thread = GDMLogic.pruned(r.messages)
            groupCanSend = r.canSend ?? true
            applyGroup(r.group, reload: false)
            markSeen()
        } catch let APIError.http(status, _, message) {
            if status == 404 { drop(id) ; return }
            error = message ?? "読み込めませんでした"
        } catch {
            self.error = "読み込めませんでした"
        }
    }

    /// Pull to refresh / 「読み直す」: the open group again (a public group I am not in gets no stream events).
    func refreshOpen() async {
        guard let id = openId else { return }
        await load(id)
    }

    /// The open conversation is read to its end (the badge at once, the server a moment later).
    private func markSeen() {
        guard appVisible, threadOnScreen, let id = openId else { return }
        if let i = summaries.firstIndex(where: { $0.group.id == id }), summaries[i].unreadCount > 0 {
            unreadCount = max(0, unreadCount - summaries[i].unreadCount)
            summaries[i].unreadCount = 0
        }
        // Not in it (a public group I only read): nothing to mark.
        guard !demo, group?.joined != false, let last = thread.last(where: { $0.id > 0 }) else { return }
        readTask?.cancel()
        readTask = Task { [api, path] in
            try? await Task.sleep(for: .milliseconds(400))
            guard !Task.isCancelled else { return }
            if let r = try? await api.gdmRead(path: path, groupId: id, upTo: last.id), let n = r.total { self.unreadCount = n }
        }
    }

    // MARK: Sending

    /// Optimistic: the bubble shows at once (with the photos' previews); photos are made small and uploaded first.
    func send(_ text: String, photos: OutgoingPhotos? = nil) {
        guard canSend, groupCanSend, composerMode == .write, let id = openId else { return }
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let photos = canSendImages ? photos : nil
        guard !body.isEmpty || photos != nil, body.count <= maxBody else { return }
        tempSeq += 1
        let me = group?.me
        let temp = GDMMessage(id: -tempSeq, groupId: id, kind: "text", fromId: me?.userId, fromName: me?.name, fromAvatar: me?.avatar,
                              body: body, createdAt: ISO8601DateFormatter().string(from: Date()), isAuthor: true,
                              clientId: UUID().uuidString, pending: true)
        if let photos, let cid = temp.clientId { outgoingPhotos[cid] = photos }
        thread.append(temp)
        error = nil
        deliver(temp)
    }

    func retry(_ m: GDMMessage) {
        guard let i = thread.firstIndex(where: { $0.clientId == m.clientId && $0.id < 0 }) else { return }
        thread[i].failed = false
        thread[i].pending = true
        deliver(thread[i])
    }

    func discard(_ m: GDMMessage) {
        thread.removeAll { $0.id < 0 && $0.clientId == m.clientId }
        if let cid = m.clientId { outgoingPhotos[cid] = nil }
    }

    private func deliver(_ temp: GDMMessage) {
        Task {
            let photos = temp.clientId.flatMap { outgoingPhotos[$0] }
            if demo {
                try? await Task.sleep(for: .milliseconds(250))
                var stored = temp
                stored.id = 20_000 + tempSeq
                stored.pending = false
                #if DEBUG
                stored.images = photos.map(OutgoingPhotos.debugCachedPaths) ?? []
                #endif
                applyCreate(stored, total: nil)
                if let cid = temp.clientId { outgoingPhotos[cid] = nil }
                return
            }
            do {
                let urls = try await photos?.uploaded(api: api, path: uploadPath) ?? []
                let m = try await api.gdmSend(path: path, groupId: temp.groupId, body: temp.body, clientId: temp.clientId ?? "", images: urls)
                applyCreate(m, total: nil)
                if let cid = temp.clientId { outgoingPhotos[cid] = nil }
            } catch {
                if let i = thread.firstIndex(where: { $0.clientId == temp.clientId && $0.id < 0 }) {
                    thread[i].pending = false
                    thread[i].failed = true
                }
                self.error = Self.message(error, or: "送れませんでした")
            }
        }
    }

    // MARK: Editing and reactions (the chat's: ChatStore.edit / toggleReaction)

    /// ✏️ Optimistic: the bubble changes at once; the server's answer replaces it, a refusal (e.g. a question
    /// ビーグル answered) puts it back with the server's words.
    func edit(_ id: Int, body: String) async -> Bool {
        guard canEdit, let i = thread.firstIndex(where: { $0.id == id && $0.canBeEdited }),
              let text = DMLogic.editedBody(body, hasPhotos: !thread[i].images.isEmpty, maxBody: maxBody) else { return false }
        let old = thread[i]
        guard text != old.body else { return true }
        thread[i].body = text
        thread[i].edited = true
        error = nil
        if demo { summaries = GDMLogic.summaries(summaries, edited: thread[i]); return true }
        do {
            let m = try await api.gdmEdit(path: path, id: id, body: text)
            applyEdit(m)
            return true
        } catch {
            if let j = thread.firstIndex(where: { $0.id == id }) { thread[j] = old }
            self.error = Self.message(error, or: "編集できませんでした")
            return false
        }
    }

    /// 😀 Optimistic toggle; the server's chips replace the guess, a failure puts the old ones back.
    func toggleReaction(_ id: Int, emoji: String) {
        guard canReact, let i = thread.firstIndex(where: { $0.id == id && $0.canBeReacted }) else { return }
        let old = thread[i].reactions
        thread[i].reactions = ReactionLogic.toggled(old, emoji: emoji)
        if demo { return }
        Task {
            do {
                let r = try await api.gdmReact(path: path, id: id, emoji: emoji)
                thread = GDMLogic.settingReactions(thread, id: id, r)
            } catch {
                thread = GDMLogic.settingReactions(thread, id: id, old)
            }
        }
    }

    private func applyEdit(_ m: GDMMessage) {
        if openId == m.groupId { thread = GDMLogic.applyingEdit(thread, m) }
        summaries = GDMLogic.summaries(summaries, edited: m)
    }

    // MARK: Making and changing groups

    /// The members to pick from: the chat's list (or read once here), and my 1:1 DM partners, without repeats.
    /// ビーグル (the list's first, a system member) is left out by `GDMLogic.candidates`.
    func loadDirectory() async {
        var list = chatMembers()
        if list.isEmpty, !demo {
            if directory.isEmpty, let m = try? await api.members() { list = m } else { list = directory }
        }
        var seen = Set(list.map(\.userId))
        peerIds = Set(dmPeers().map(\.userId))
        for p in dmPeers() where !seen.contains(p.userId) {
            list.append(p)
            seen.insert(p.userId)
        }
        directory = list
    }

    /// POST /gdm. The new group (nil and `error` set when the server said no — its words as they are).
    /// `isPublic`: 🌐 a public group — a name is needed, members are not.
    func create(name: String, memberIds: [String], isPublic: Bool = false) async -> GDMGroup? {
        let isPublic = isPublic && publicAvailable
        guard canSend, GDMLogic.canCreate(isPublic: isPublic, name: name, memberCount: memberIds.count), !busy else { return nil }
        busy = true
        error = nil
        defer { busy = false }
        let clean = GDMLogic.cleanName(name, max: maxName)
        if demo {
            let picked = directory.filter { memberIds.contains($0.userId) }
            let members = [GDMMember(userId: "me", name: "ドリキン", avatar: nil, isCreator: true, isMe: true)]
                + picked.map { GDMMember(userId: $0.userId, name: $0.name, avatar: $0.avatar, isCreator: false, isMe: false) }
            let id = (summaries.map(\.group.id).max() ?? 0) + 1
            let g = GDMGroup(id: id, name: clean, title: clean ?? picked.map(\.name).prefix(3).joined(separator: "、"),
                             members: members, memberCount: members.count, isCreator: true, muted: false,
                             createdAt: ISO8601DateFormatter().string(from: Date()),
                             isPublic: isPublic ? true : nil, isMember: isPublic ? true : nil, archived: isPublic ? false : nil)
            summaries = GDMLogic.summaries(summaries, updating: g)
            return g
        }
        do {
            let g = try await api.gdmCreate(path: path, name: clean, memberIds: memberIds, isPublic: isPublic)
            summaries = GDMLogic.summaries(summaries, updating: g)
            return g
        } catch {
            self.error = Self.message(error, or: "グループを作れませんでした")
            return nil
        }
    }

    func rename(_ name: String) async {
        guard let id = openId else { return }
        let clean = GDMLogic.cleanName(name, max: maxName)
        await change(id, demoChange: { g in g.name = clean; if let clean { g.title = clean } }) { [api, path] in
            try await api.gdmPatch(path: path, groupId: id, ["name": clean ?? NSNull()])
        }
    }

    func setMuted(_ muted: Bool) async {
        guard let id = openId else { return }
        await change(id, demoChange: { $0.muted = muted }) { [api, path] in
            try await api.gdmPatch(path: path, groupId: id, ["muted": muted])
        }
    }

    func setBeagle(_ on: Bool) async {
        guard let id = openId else { return }
        await change(id, demoChange: { $0.beagle = on }) { [api, path] in
            try await api.gdmPatch(path: path, groupId: id, ["beagle": on])
        }
    }

    func add(_ userIds: [String]) async -> Bool {
        guard let id = openId, !userIds.isEmpty else { return false }
        let picked = directory.filter { userIds.contains($0.userId) }
        return await change(id, demoChange: { g in
            g.members += picked.map { GDMMember(userId: $0.userId, name: $0.name, avatar: $0.avatar, isCreator: false, isMe: false) }
            g.memberCount = g.members.count
        }) { [api, path] in
            try await api.gdmAddMembers(path: path, groupId: id, userIds: userIds)
        }
    }

    /// The group's photo from a picked image's bytes: shrunk on the device (long side ≤ 1024px, EXIF rotation
    /// applied, no metadata) to a JPEG, then sent. Anyone in the group may (the server checks).
    func setPhoto(_ original: Data) async {
        guard let id = openId, photoEditable, !busy else { return }
        let jpeg = await Task.detached(priority: .userInitiated) {
            PostDraft.uploadJPEG(original, maxSide: GDMLogic.photoMaxSide, quality: 0.85)
        }.value
        guard let jpeg else { error = "この画像は使えません（画像として読めませんでした）"; return }
        if let tooBig = GDMLogic.photoTooBig(jpeg.count, max: maxPhotoBytes) { error = tooBig; return }
        #if DEBUG
        let demoPath = demo ? debugPhotoPath(jpeg) : nil
        #else
        let demoPath: String? = nil
        #endif
        await change(id, demoChange: { $0.photo = demoPath }, fallback: "写真を変えられませんでした") { [api, path] in
            try await api.gdmSetPhoto(path: path, groupId: id, jpeg: jpeg)
        }
    }

    func removePhoto() async {
        guard let id = openId, photoEditable else { return }
        await change(id, demoChange: { $0.photo = nil }, fallback: "写真を外せませんでした") { [api, path] in
            try await api.gdmRemovePhoto(path: path, groupId: id)
        }
    }

    /// 🌐 Join the open public group: into my list, then its conversation again (now writable, with notifications).
    func join() async {
        guard let id = openId, canSend, publicAvailable, !busy else { return }
        busy = true
        error = nil
        if demo {
            if var g = group { g.isMember = true; g.members.append(GDMMember(userId: "me", name: "ドリキン", avatar: nil, isCreator: false, isMe: true)); g.memberCount = g.members.count; applyGroup(g) }
            groupCanSend = true
            busy = false
            return
        }
        do {
            let g = try await api.gdmJoin(path: path, groupId: id)
            applyGroup(g, reload: false)
            busy = false
            if openId == id { await load(id) }
        } catch {
            busy = false
            self.error = Self.message(error, or: "参加できませんでした")
        }
    }

    /// 🗄 Archive / un-archive the open public group (anyone in it), then the list and the conversation again.
    func setArchived(_ archived: Bool) async {
        guard let id = openId, archiveAvailable else { return }
        let ok = await change(id, demoChange: { g in
            g.archived = archived
            g.archivedAt = archived ? ISO8601DateFormatter().string(from: Date()) : nil
        }, fallback: archived ? "アーカイブできませんでした" : "アーカイブから戻せませんでした") { [api, path] in
            try await api.gdmPatch(path: path, groupId: id, ["archived": archived])
        }
        guard ok, !demo else { return }
        await reload()
        if openId == id { await load(id) }
    }

    /// Someone else out (only its maker sees the button; the server checks too).
    func remove(_ userId: String) async {
        guard let id = openId, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        if demo {
            if var g = group { g.members.removeAll { $0.userId == userId }; g.memberCount = g.members.count; applyGroup(g) }
            return
        }
        do {
            try await api.gdmRemoveMember(path: path, groupId: id, userId: userId)
            if let r = try? await api.gdmThread(path: path, groupId: id) { applyGroup(r.group) }
        } catch {
            self.error = Self.message(error, or: "外せませんでした")
        }
    }

    /// I leave: the group goes from this device at once.
    func leave() async {
        guard let id = openId, !busy else { return }
        busy = true
        error = nil
        defer { busy = false }
        let wasPublic = group?.isPublicDM == true
        if !demo {
            guard let me = group?.me else { error = "抜けられませんでした（もう一度開いてください）"; return }
            do {
                try await api.gdmRemoveMember(path: path, groupId: id, userId: me.userId)
            } catch {
                self.error = Self.message(error, or: "抜けられませんでした")
                return
            }
        }
        drop(id)
        // 🌐 It is still there for anyone: back under 「パブリック DM」.
        if wasPublic, !demo { Task { await reload() } }
    }

    @discardableResult
    private func change(_ id: Int, demoChange: (inout GDMGroup) -> Void, fallback: String = "変えられませんでした",
                        _ call: @escaping @Sendable () async throws -> GDMGroup) async -> Bool {
        guard !busy else { return false }
        busy = true
        error = nil
        defer { busy = false }
        if demo {
            if var g = group { demoChange(&g); applyGroup(g) }
            return true
        }
        do {
            applyGroup(try await call())
            return true
        } catch {
            self.error = Self.message(error, or: fallback)
            return false
        }
    }

    /// A group as the server now says: in the list part it belongs to (mine, 🌐 public, 🗄 archived).
    /// Out of my list (archived, or I am not in it): its unread off the badge, no composer, and (`reload`) the list again.
    private func applyGroup(_ g: GDMGroup, reload again: Bool = true) {
        let old = summary(g.id)
        let r = GDMLogic.placing(g, in: sections)
        sections = r.sections
        if r.leftMine, let old { unreadCount = max(0, unreadCount - old.unreadCount) }
        if openId == g.id {
            group = g
            if !GDMLogic.belongsInMyList(g) { groupCanSend = false }
        }
        if r.leftMine, again, !demo { Task { await reload() } }
    }

    /// Gone for me: off the list (and its unread off the badge), and closed if open.
    private func drop(_ id: Int) {
        if let s = summary(id) { unreadCount = max(0, unreadCount - s.unreadCount) }
        summaries.removeAll { $0.group.id == id }
        if openId == id { onOpenRemoved?() }
    }

    private static func message(_ error: Error, or fallback: String) -> String {
        if case let APIError.http(_, _, message) = error { return message ?? fallback }
        return fallback
    }

    // MARK: Stream

    /// `ready` (after a (re)connect): read the list again, and the open group (anything missed).
    func applyReady() {
        guard enabled, !demo else { return }
        Task {
            await reload()
            if let id = openId { await load(id) }
        }
    }

    /// Stream event "gdm": create / read / group / removed / edit / reaction (the last two: no push, no unread change).
    func apply(_ data: Data) {
        guard enabled, let e = GDMEvent.decode(data) else { return }
        switch e.action {
        case "create":
            if let m = e.message { applyCreate(m, total: e.groupUnreadCount) }
        case "read":
            if let id = e.groupId, let i = summaries.firstIndex(where: { $0.group.id == id }) {
                summaries[i].unreadCount = e.unreadCount ?? 0
            }
            if let n = e.groupUnreadCount { unreadCount = n }
        case "group":
            if let g = e.group { applyGroup(g) }
        case "removed":
            if let id = e.groupId { drop(id) }
        case "edit":
            if let m = e.message { applyEdit(m) }
        case "reaction":
            if let id = e.messageId, let rs = e.reactions, let g = e.groupId, openId == g {
                thread = GDMLogic.settingReactions(thread, id: id, rs)
            }
        default:
            break
        }
    }

    private func applyCreate(_ m: GDMMessage, total: Int?) {
        let viewing = isShowing(groupId: m.groupId)
        if openId == m.groupId { thread = GDMLogic.reconcile(thread, with: m) }
        let known = summary(m.groupId)?.lastMessage?.id == m.id
        guard let next = GDMLogic.summaries(summaries, after: m, viewing: viewing) else {
            // A group this device does not know yet (made elsewhere, or I was just added): the list again.
            Task { await reload() }
            return
        }
        summaries = next
        guard !m.isAuthor, !known else { return }
        if viewing { markSeen(); return }
        if let total { unreadCount = total } else if !m.isSystem { unreadCount += 1 }
        if !m.isSystem, let g = summary(m.groupId)?.group, g.muted != true { onIncoming?(m, g) }
    }

    private func startPruning() {
        pruneTask?.cancel()
        pruneTask = Task { [weak self] in
            while !Task.isCancelled {
                // Loose, like the 1:1 DM: a minute or so late is fine.
                // Every 10 minutes (it was every minute, all day, parsing every date): the ttl is
                // 30 days and the server drops them too, so nothing is ever due to the minute.
                try? await Task.sleep(for: .seconds(600), tolerance: .seconds(120))
                guard let self else { return }
                let t = GDMLogic.pruned(self.thread)
                if t.count != self.thread.count { self.thread = t }
                let s = GDMLogic.prunedSummaries(self.summaries)
                if s != self.summaries { self.summaries = s }
            }
        }
    }

    // MARK: Demo

    private var demoThreads: [Int: [GDMMessage]] = [:]

    #if DEBUG
    /// Offline demo: two groups (one unread), nothing is sent.
    func debugLoadDemo() {
        demo = true
        enabled = true
        canSend = true
        photoEditable = true
        beagleAvailable = true
        canSendImages = true
        canEdit = true
        canReact = true
        publicAvailable = true
        archiveAvailable = true
        func at(_ minutesAgo: Double) -> String { ISO8601DateFormatter().string(from: Date().addingTimeInterval(-minutesAgo * 60)) }
        func mem(_ id: String, creator: Bool = false, me: Bool = false) -> GDMMember {
            GDMMember(userId: id, name: me ? "ドリキン" : id, avatar: nil, isCreator: creator, isMe: me)
        }
        func m(_ id: Int, _ g: Int, _ from: String?, _ body: String, _ ago: Double) -> GDMMessage {
            GDMMessage(id: id, groupId: g, kind: from == nil ? "system" : "text", fromId: from, fromName: from,
                       fromAvatar: nil, body: body, createdAt: at(ago), isAuthor: from == "me", clientId: nil)
        }
        let g1 = GDMGroup(id: 1, name: "週末の撮影", photo: TimelineDemoMedia.picture("gdm-photo-1", 512, 512, hue: 0.55), title: "週末の撮影", members: [mem("mazzo", creator: true), mem("me", me: true), mem("takuto")],
                          memberCount: 3, isCreator: false, muted: false, createdAt: at(200))
        let g2 = GDMGroup(id: 2, name: nil, title: "coban、りとる", members: [mem("me", creator: true, me: true), mem("coban"), mem("りとる")],
                          memberCount: 3, isCreator: true, muted: true, createdAt: at(900))
        demoThreads = [
            1: [m(1, 1, nil, "mazzo さんがグループを作りました", 200),
                m(2, 1, "mazzo", "土曜の朝、晴れたら行きましょう", 30),
                m(3, 1, "me", "いいですね！ レンズ何持っていきます？", 25),
                {
                    // 😀 リアクションと @ メンション（自分宛ては黄色）
                    var p = m(4, 1, "takuto", "@ドリキン 35mm だけで行きます", 4)
                    p.reactions = [Reaction(emoji: "👍", count: 2, mine: true, reactors: ["ドリキン", "mazzo"])]
                    return p
                }(),
                {
                    // 📷 写真だけの発言（本文なし）: 一覧は「takuto: 📷 写真」
                    var p = m(8, 1, "takuto", "", 3)
                    p.images = [TimelineDemoMedia.picture("gdm-msg-1", 1280, 960, hue: 0.1), TimelineDemoMedia.picture("gdm-msg-2", 960, 1280, hue: 0.7)]
                    return p
                }()],
            2: [m(5, 2, nil, "ドリキン さんが coban さんを追加しました", 900),
                m(6, 2, "coban", "昨日はありがとうございました", 600)],
        ]
        // 🌐 A public group I have not joined (new) and 🗄 an archived one.
        let g3 = GDMGroup(id: 3, name: "雑談ひろば", title: "雑談ひろば", members: [mem("mazzo", creator: true), mem("coban")],
                          memberCount: 2, isCreator: false, muted: false, createdAt: at(120),
                          isPublic: true, isMember: false, archived: false)
        let g4 = GDMGroup(id: 4, name: "オフ会の相談", title: "オフ会の相談", members: [mem("me", me: true), mem("takuto", creator: true)],
                          memberCount: 2, isCreator: false, muted: false, createdAt: at(3000),
                          isPublic: true, isMember: true, archived: true, archivedAt: at(60))
        demoThreads[3] = [m(30, 3, nil, "mazzo さんがパブリック DM を作りました", 120), m(31, 3, "coban", "誰でもどうぞ〜", 50)]
        demoThreads[4] = [m(40, 4, "takuto", "日程決まりました、ありがとうございました", 70),
                          m(41, 4, nil, "takuto さんがアーカイブしました", 60)]
        summaries = [GDMSummary(group: g1, lastMessage: demoThreads[1]?.last, unreadCount: 1),
                     GDMSummary(group: g2, lastMessage: demoThreads[2]?.last, unreadCount: 0)]
        publicSummaries = [GDMSummary(group: g3, lastMessage: demoThreads[3]?.last, unreadCount: 0, isNew: true)]
        archivedSummaries = [GDMSummary(group: g4, lastMessage: demoThreads[4]?.last, unreadCount: 0)]
        unreadCount = 1
    }

    /// Demo: the picked photo goes straight into the image cache under a made-up path (nothing is sent).
    private func debugPhotoPath(_ jpeg: Data) -> String? {
        guard let cg = MediaCache.decode(jpeg, maxPixel: 600) else { return nil }
        let path = "selftest-media/gdm-photo-\(UUID().uuidString).jpg"
        MediaCache.shared.debugInsert(PlatformImage.decoded(cg), for: path)
        return path
    }
    #endif
}
