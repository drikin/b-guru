import SwiftUI
import Observation
import UniformTypeIdentifiers

// 段階 3「操作」: what a member can do to a timeline post, as on the web
// (docs/timeline-spec.md §10 the UI and wording, §11 the API). Every operation is offered only
// when the server says so in `capabilities.features.posts` (older servers say nothing → hidden).

// MARK: - API

/// POST /api/agent/publish.
struct PublishBody: Sendable {
    var text: String
    var images: [String] = []
    var parentId: Int? = nil
    /// うなる: a reply that does not lift the thread or notify (replies only).
    var whisper = false
    var videoUrl: String? = nil
    var audioUrl: String? = nil
    var poll: PollInput? = nil
    /// A club chosen by hand (root posts only; nil = the server's AI picks one).
    var club: String? = nil

    struct PollInput: Sendable, Equatable {
        var question: String
        var options: [String]
        var durationHours: Int
    }

    var json: [String: Any] {
        var j: [String: Any] = ["text": text, "images": images]
        if let parentId { j["parent_id"] = parentId }
        if whisper { j["whisper"] = true }
        if let videoUrl { j["video_url"] = videoUrl }
        if let audioUrl { j["audio_url"] = audioUrl }
        if let poll { j["poll"] = ["question": poll.question, "options": poll.options, "duration_hours": poll.durationHours] }
        if let club { j["club"] = club }
        return j
    }
}

/// A list of posts other than the timeline (§11 `posts?pinned=1` / `bm=1` / `fav=1`).
enum PostListKind: String, Identifiable, CaseIterable, Sendable {
    case pinned, bookmarks, favorites
    var id: String { rawValue }
    var title: String {
        switch self {
        case .pinned: return "ピン留め"
        case .bookmarks: return "ブックマーク"
        case .favorites: return "お気に入りの人"
        }
    }
    var systemImage: String {
        switch self {
        case .pinned: return "pin"
        case .bookmarks: return "bookmark"
        case .favorites: return "star"
        }
    }
    var query: URLQueryItem {
        switch self {
        case .pinned: return .init(name: "pinned", value: "1")
        case .bookmarks: return .init(name: "bm", value: "1")
        case .favorites: return .init(name: "fav", value: "1")
        }
    }
    var empty: String {
        switch self {
        case .pinned: return "ピンはありません。自分の投稿の右上にあるピンアイコンから、その投稿を24時間ピン留めできます。"
        case .bookmarks: return "ブックマークはありません。投稿のメニューの「ブックマークに保存」で、あとで読む投稿をここに集められます。"
        case .favorites: return "お気に入りの人の投稿はありません。投稿のメニューの「お気に入りに追加」で、その人の投稿をここに集められます。"
        }
    }
}

struct CustomEmojiInfo: Decodable, Sendable { var id: Int?; var name: String; var imageUrl: String }

extension APIClient {
    /// Sends `req`; the offline demo (token "demo") answers from DemoPostServer instead, so
    /// nothing reaches any server.
    func perform<T: Decodable>(_ req: URLRequest, as: T.Type = T.self) async throws -> T {
        #if DEBUG
        if token == "demo" {
            let (status, data) = await DemoPostServer.shared.handle(req)
            guard (200..<300).contains(status) else {
                let body = try? decoder.decode(APIErrorBody.self, from: data)
                if status == 401 { throw APIError.unauthorized(code: body?.code) }
                throw APIError.http(status: status, code: body?.code, message: body?.error)
            }
            do { return try decoder.decode(T.self, from: data) } catch { throw APIError.transport("decode: \(error)") }
        }
        #endif
        return try await send(req)
    }

    private func get(_ path: String, query: [URLQueryItem]) -> URLRequest {
        var req = request("GET", path)
        var comps = URLComponents(url: APIClient.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false)!
        comps.queryItems = query
        req.url = comps.url
        return req
    }

    func publish(_ body: PublishBody) async throws -> Post {
        let r: PublishResponse = try await perform(request("POST", "/api/agent/publish", json: body.json))
        return r.post
    }

    /// The pinned posts / bookmarks / favourites' posts, as the timeline (reactions, read, display).
    func postList(_ kind: PostListKind, cursor: String? = nil) async throws -> PostListResponse {
        var q: [URLQueryItem] = [kind.query, .init(name: "limit", value: "30"), .init(name: "include", value: "reactions,read,display")]
        if let cursor { q.append(.init(name: "cursor", value: cursor)) }
        return try await perform(get("/api/agent/posts", query: q))
    }

    /// PATCH /api/agent/posts/:id. `images` nil = leave them; `audio`: nil = leave it,
    /// .some(nil) = take it off, .some(url) = attach. A text-only key sends the text alone.
    func editPost(id: Int, text: String, images: [String]?, audio: String??) async throws {
        struct R: Decodable {}
        var j: [String: Any] = ["text": text]
        if let images { j["images"] = images }
        if let audio { j["audio_url"] = audio ?? NSNull() }
        let _: R = try await perform(request("PATCH", "/api/agent/posts/\(id)", json: j))
    }

    func deletePost(id: Int) async throws {
        struct R: Decodable {}
        let _: R = try await perform(request("DELETE", "/api/agent/posts/\(id)"))
    }

    /// Pin / unpin (a toggle). Returns whether it is pinned now.
    func togglePin(id: Int) async throws -> Bool {
        struct R: Decodable { var pinned: Bool }
        return try await perform(request("POST", "/api/agent/posts/\(id)/pin", json: [:]), as: R.self).pinned
    }

    func setClub(id: Int, club: String?) async throws {
        struct R: Decodable {}
        let _: R = try await perform(request("PATCH", "/api/agent/posts/\(id)/club", json: ["club": club ?? NSNull()]))
    }

    func vote(postId: Int, optionId: Int) async throws -> PostPoll {
        struct R: Decodable { var poll: PostPoll }
        return try await perform(request("POST", "/api/agent/posts/\(postId)/poll/vote", json: ["option_id": optionId]), as: R.self).poll
    }

    /// Who voted for what (only the poll's author may ask; others get 403).
    func pollVoters(postId: Int) async throws -> [PollVoterGroup] {
        struct R: Decodable { var options: [PollVoterGroup] }
        return try await perform(request("GET", "/api/agent/posts/\(postId)/poll/voters"), as: R.self).options
    }

    /// The answers in this order; id nil = a new one.
    func editPoll(postId: Int, options: [(id: Int?, label: String)]) async throws -> PostPoll {
        struct R: Decodable { var poll: PostPoll }
        let opts: [[String: Any]] = options.map { ["id": $0.id ?? NSNull(), "label": $0.label] }
        return try await perform(request("PUT", "/api/agent/posts/\(postId)/poll", json: ["options": opts]), as: R.self).poll
    }

    /// A toggle. Returns whether it is bookmarked now.
    func toggleBookmark(postId: Int) async throws -> Bool {
        struct R: Decodable { var bookmarked: Bool }
        return try await perform(request("POST", "/api/agent/bookmarks", json: ["post_id": postId]), as: R.self).bookmarked
    }

    /// The idempotent form (`{ post_id, bookmarked }`, when capabilities say the server has it).
    func setBookmark(postId: Int, on: Bool) async throws -> Bool {
        struct R: Decodable { var bookmarked: Bool }
        return try await perform(request("POST", "/api/agent/bookmarks", json: ["post_id": postId, "bookmarked": on]), as: R.self).bookmarked
    }

    func setFavorite(userId: String, on: Bool) async throws {
        struct R: Decodable { var favorited: Bool }
        _ = try await perform(request(on ? "POST" : "DELETE", "/api/agent/favorites", json: ["user_id": userId]), as: R.self)
    }

    func customEmojis(path: String) async throws -> [CustomEmojiInfo] {
        struct R: Decodable { var emojis: [CustomEmojiInfo] }
        return try await perform(request("GET", path.hasPrefix("/api/") ? path : "/api/agent/emojis"), as: R.self).emojis
    }

    /// カスタム絵文字の登録（capabilities `custom_emoji_register`）。誰でも（オーナー 2026-10-27）。
    func registerCustomEmoji(path: String, name: String, image: CustomEmojiRules.Prepared) async throws -> CustomEmojiInfo {
        struct R: Decodable { var emoji: CustomEmojiInfo }
        let boundary = "bguru-\(UUID().uuidString)"
        var req = request("POST", path.hasPrefix("/api/") ? path : "/api/agent/emojis")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = CustomEmojiRules.multipartBody(name: name, image: image, boundary: boundary)
        #if DEBUG
        if token == "demo" { req.setValue(name, forHTTPHeaderField: "X-Demo-Emoji") }
        #endif
        return try await perform(req, as: R.self).emoji
    }

    /// カスタム絵文字の削除（capabilities `custom_emoji_delete`、"{id}" を置き換える）。その絵文字のリアクションも消える。
    func deleteCustomEmoji(path: String, id: Int) async throws {
        struct R: Decodable { var ok: Bool? }
        let p = path.hasPrefix("/api/") ? path.replacingOccurrences(of: "{id}", with: String(id)) : "/api/agent/emojis/\(id)"
        _ = try await perform(request("DELETE", p), as: R.self)
    }

    /// A video or a sound file (§11: one per upload, 100 MB). Streams the file from disk into
    /// a multipart body on disk (a 100 MB file is never held in memory). Returns its /api/media/… URL.
    func uploadMedia(file: URL, kind: MediaKind) async throws -> String {
        let boundary = "bguru-\(UUID().uuidString)"
        let tmp = FileManager.default.temporaryDirectory.appendingPathComponent("upload-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: tmp) }
        do {
            FileManager.default.createFile(atPath: tmp.path, contents: nil)
            let out = try FileHandle(forWritingTo: tmp)
            defer { try? out.close() }
            let name = file.lastPathComponent.replacingOccurrences(of: "\"", with: "")
            try out.write(contentsOf: Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(kind.rawValue)\"; filename=\"\(name)\"\r\nContent-Type: \(kind.mime(for: file))\r\n\r\n".utf8))
            let input = try FileHandle(forReadingFrom: file)
            defer { try? input.close() }
            while let chunk = try input.read(upToCount: 1 << 20), !chunk.isEmpty { try out.write(contentsOf: chunk) }
            try out.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
        } catch {
            throw APIError.transport("ファイルを読めませんでした")
        }
        var req = request("POST", "/api/agent/upload")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.timeoutInterval = 600
        struct R: Decodable { var videoUrl: String?; var audioUrl: String? }
        #if DEBUG
        if token == "demo" {
            req.setValue(kind.rawValue, forHTTPHeaderField: "X-Demo-Media")
            let r: R = try await perform(req)
            return r.videoUrl ?? r.audioUrl ?? ""
        }
        #endif
        let data: Data, resp: URLResponse
        do { (data, resp) = try await session.upload(for: req, fromFile: tmp) } catch {
            throw APIError.transport(error.localizedDescription)
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let body = try? decoder.decode(APIErrorBody.self, from: data)
            if status == 401 { throw APIError.unauthorized(code: body?.code) }
            throw APIError.http(status: status, code: body?.code, message: body?.error)
        }
        guard let r = try? decoder.decode(R.self, from: data), let url = r.videoUrl ?? r.audioUrl else {
            throw APIError.transport("アップロードの返事を読めませんでした")
        }
        return url
    }
}

/// Video or sound for a post (the web's formats, §11).
enum MediaKind: String, Sendable {
    case video, audio

    static let videoTypes: [String: String] = ["mp4": "video/mp4", "m4v": "video/mp4", "mov": "video/quicktime", "webm": "video/webm"]
    static let audioTypes: [String: String] = ["mp3": "audio/mpeg", "m4a": "audio/mp4", "aac": "audio/aac", "wav": "audio/wav",
                                               "ogg": "audio/ogg", "opus": "audio/ogg", "webm": "audio/webm", "flac": "audio/flac"]

    func mime(for file: URL) -> String {
        let ext = file.pathExtension.lowercased()
        return (self == .video ? Self.videoTypes : Self.audioTypes)[ext] ?? (self == .video ? "video/mp4" : "audio/mpeg")
    }

    var label: String { self == .video ? "動画" : "音声" }
    /// What the file picker offers.
    var contentTypes: [UTType] { self == .video ? [.movie, .mpeg4Movie, .quickTimeMovie] : [.audio] }

    /// Nil when the file can be sent; otherwise why not (the server's wording).
    func problem(with file: URL, maxMB: Int) -> String? {
        let ext = file.pathExtension.lowercased()
        let known = self == .video ? Self.videoTypes : Self.audioTypes
        if known[ext] == nil {
            return self == .video ? "非対応の動画形式です（mp4・mov・webm）" : "非対応の音声形式です（mp3・m4a・aac・wav・ogg・opus・webm・flac）"
        }
        let size = (try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        if size > maxMB * 1_048_576 { return "\(label)は\(maxMB)MBまでです" }
        return nil
    }
}

/// A video / sound file picked for a post, copied into this app's temporary folder.
struct PickedMedia: Equatable {
    let kind: MediaKind
    let file: URL
    var name: String { file.lastPathComponent }
    var sizeText: String { ByteCountFormatter.string(fromByteCount: Int64((try? file.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0), countStyle: .file) }

    /// Removes the temporary copy (its own picked-<UUID> folder).
    func discard() {
        let dir = file.deletingLastPathComponent()
        if dir.lastPathComponent.hasPrefix("picked-") { try? FileManager.default.removeItem(at: dir) }
    }

    /// Copies a picked file (security-scoped on the Mac) to a temporary place we own.
    static func copy(_ url: URL, kind: MediaKind) -> PickedMedia? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("picked-\(UUID().uuidString)")
        let dst = dir.appendingPathComponent(url.lastPathComponent)
        do {
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            try FileManager.default.copyItem(at: url, to: dst)
            return PickedMedia(kind: kind, file: dst)
        } catch { return nil }
    }
}

/// A picked video received as a file (PhotosPicker on iPhone / iPad).
struct PickedMovieFile: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let dir = FileManager.default.temporaryDirectory.appendingPathComponent("picked-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let dst = dir.appendingPathComponent(received.file.lastPathComponent)
            try FileManager.default.copyItem(at: received.file, to: dst)
            return PickedMovieFile(url: dst)
        }
    }
}

// MARK: - The operations

/// One change made here to a post, for every screen that shows it (the timeline list and
/// an open thread keep their own copies).
struct PostChange: Equatable {
    enum Kind: Equatable {
        /// Only these fields of the post changed (a failure puts back only them, not the
        /// whole post as it was — other changes meanwhile stay).
        case fields(id: Int, PostFields)
        case deleted(id: Int, parentId: Int?)
        /// ☆ is per person: every post by this author.
        case favorite(authorId: String, on: Bool)
        /// One pin per member: pinning one unpins the others.
        case unpinnedOthers(except: Int)
    }
    let seq: Int
    let kind: Kind
}

/// The parts of a post an operation changes. Nil = left as it is.
struct PostFields: Equatable {
    var bookmarked: Bool? = nil
    var poll: PostPoll? = nil
    /// .some(nil) = unpinned.
    var pinnedAt: String?? = nil
    /// .some(nil) = ラベルなし. The label to show with it (the server's was for the old club).
    var club: String?? = nil
    var clubLabel: String? = nil
    var text: String? = nil
    var images: [String]? = nil
    var audioUrl: String?? = nil

    /// Applies these fields to `p`.
    func apply(to p: inout Post) {
        if let bookmarked { p.bookmarkedByMe = bookmarked }
        if let poll { p.poll = poll }
        if let pinnedAt { p.pinnedAt = pinnedAt }
        if let club {
            p.club = club
            p.clubManual = true
            p.display?.clubLabel = clubLabel
            p.display?.clubUnset = false
        }
        if let text {
            p.text = text
            // The server's display (fold, mentions, card) was for the old text: the app's own
            // rules until the next fetch brings a new one.
            p.display = nil
        }
        if let images { p.images = images }
        if let audioUrl { p.audioUrl = audioUrl }
    }
}

extension PostChange.Kind {
    /// This change applied to a post a screen holds (nil = it is not about this post).
    func applied(to p: Post) -> Post? {
        switch self {
        case let .fields(id, f):
            guard p.id == id else { return nil }
            var q = p
            f.apply(to: &q)
            return q
        case let .favorite(author, on):
            guard p.authorId == author, p.favoriteByMe != on else { return nil }
            var q = p
            q.favoriteByMe = on
            return q
        case let .unpinnedOthers(except):
            guard p.mine, p.id != except, p.pinnedAt != nil else { return nil }
            var q = p
            q.pinnedAt = nil
            return q
        case .deleted: return nil
        }
    }
}

/// The toast's way to undo, by platform (§10.2).
enum UndoHint {
    #if os(macOS)
    static let suffix = "（クリックで取り消し）"
    #else
    static let suffix = "（タップで取り消し）"
    #endif
}

/// 「…（タップで取り消し）」 and errors, at the bottom of the timeline for 5 s.
struct ActionToast: Identifiable, Equatable {
    let id = UUID()
    let text: String
    var isError = false
    let undo: (@MainActor () -> Void)?
    static func == (a: Self, b: Self) -> Bool { a.id == b.id }
}

/// The emoji picker for a post (from its menu): what to do with the one picked.
struct ReactionPickRequest: Identifiable {
    let id = UUID()
    let postId: Int
    let onPick: (String) -> Void
}

/// The timeline's post operations, shared by the list, a thread and the pinned / bookmark
/// lists. Owned by the TimelineStore; handed down the environment (`postActions`).
@MainActor
@Observable
final class PostActionsModel {
    @ObservationIgnored weak var timeline: TimelineStore?
    @ObservationIgnored let api: APIClient
    /// The server's `features.posts` (set by the screen from the capabilities).
    var features: Capabilities.PostFeatures?

    // What is open (presented by TimelineScreen: a sheet on iPhone / iPad, laid over the Mac panel).
    var editing: Post?
    var deleting: Post?
    var pollEditing: Post?
    /// 「投票した人」 (my own poll).
    var pollVoters: Post?
    var picker: ReactionPickRequest?
    var list: PostListKind?
    var composing = false
    private(set) var toast: ActionToast?
    private(set) var lastChange: PostChange?
    /// Members for @mention completion (loaded when a composer first needs them).
    private(set) var members: [MentionMember] = []
    @ObservationIgnored private var membersLoading = false
    @ObservationIgnored private var seq = 0
    @ObservationIgnored private var toastTask: Task<Void, Never>?

    init(api: APIClient) { self.api = api }

    // MARK: What may be offered (§10.2: only what features.posts says)

    var canBookmark: Bool { features?.bookmarks == true }
    func canFavorite(_ p: Post) -> Bool { features?.favorites == true && !p.mine && !(p.authorId ?? "").isEmpty }
    func canPin(_ p: Post) -> Bool { features?.pin == true && p.mine && p.parentId == nil && p.id > 0 }
    func canEdit(_ p: Post) -> Bool { p.mine && p.id > 0 && (features?.edit == true || features?.editTextOnly == true) }
    /// My post, a key that may post but not edit (signed in before the operations): say how.
    func needsReloginToEdit(_ p: Post) -> Bool {
        p.mine && p.id > 0 && features?.publish == true && features?.edit != true && features?.editTextOnly != true
    }
    /// An external agent's key (write): the text only.
    var editTextOnly: Bool { features?.edit != true && features?.editTextOnly == true }
    /// Not with a key that must sign in again to edit (§10.2: the explanation replaces both).
    func canDelete(_ p: Post) -> Bool { p.mine && p.id > 0 && features?.delete == true && !needsReloginToEdit(p) }
    var canVote: Bool { features?.pollVote == true }
    func canEditPoll(_ p: Post) -> Bool {
        guard features?.pollEdit == true, p.mine, let poll = p.poll, poll.editable == true else { return false }
        return Self.withinPollEditWindow(p.createdAt)
    }
    func canChangeClub(_ p: Post) -> Bool { features?.clubChange == true && p.mine && p.parentId == nil && p.id > 0 }
    var canPickClub: Bool { features?.clubSelect == true }
    var canWhisper: Bool { features?.whisper == true }
    var canPoll: Bool { features?.poll == true }
    var canVideo: Bool { features?.video == true }
    var canAudio: Bool { features?.audio == true }
    var maxMediaMB: Int { features?.maxMediaMb ?? 100 }
    var canMention: Bool { features?.mentions != nil }
    var customEmojiPath: String? { features?.customEmojiList }
    var lists: [PostListKind] {
        PostListKind.allCases.filter {
            switch $0 {
            case .pinned: return features?.pinnedList == true
            case .bookmarks: return canBookmark
            case .favorites: return features?.favorites == true
            }
        }
    }

    /// The web's window for editing a poll's answers: an hour after posting.
    static func withinPollEditWindow(_ createdAt: String, now: Date = Date()) -> Bool {
        guard let d = parseDate(createdAt) else { return false }
        return now.timeIntervalSince(d) < 3600
    }

    static func parseDate(_ s: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f.date(from: s) ?? ISO8601DateFormatter().date(from: s)
    }

    /// Pinned now: a pin lasts 24 hours.
    static func isPinned(_ p: Post, now: Date = Date()) -> Bool {
        guard let s = p.pinnedAt, let d = parseDate(s) else { return false }
        return now.timeIntervalSince(d) < 24 * 3600
    }

    // MARK: Errors (§10.2: the server's `error` as it is; `code` picks the wording)

    static func message(_ error: Error, fallback: String) -> String {
        guard let e = error as? APIError else { return fallback }
        switch e {
        case let .http(_, code, message):
            if code == "rate_limited" { return "少し時間をおいてから試してください" }
            if code == "token_expired" || code == "unauthorized" { return "ログインが切れました。再接続してください" }
            return message ?? fallback
        case .unauthorized: return "ログインが切れました。再接続してください"
        case .transport: return "通信できませんでした。もう一度お試しください"
        }
    }

    // MARK: Toast

    func show(_ text: String, isError: Bool = false, undo: (@MainActor () -> Void)? = nil) {
        toast = ActionToast(text: text, isError: isError, undo: undo)
        toastTask?.cancel()
        toastTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(5))
            guard !Task.isCancelled else { return }
            self?.toast = nil
        }
    }

    func tapToast() {
        let undo = toast?.undo
        dismissToast()
        undo?()
    }

    func dismissToast() {
        toastTask?.cancel()
        toast = nil
    }

    // MARK: Changes

    private func publish(_ kind: PostChange.Kind) {
        seq += 1
        lastChange = PostChange(seq: seq, kind: kind)
        timeline?.apply(kind)
    }

    private func change(_ id: Int, _ f: PostFields) { publish(.fields(id: id, f)) }

    // MARK: 🔖 ブックマーク（楽観表示・トーストで取り消し）

    /// Sets it (the server's idempotent form when it offers one; otherwise its toggle).
    func toggleBookmark(_ post: Post, undoing: Bool = false) {
        let was = post.bookmarkedByMe == true
        setBookmark(post, on: !was, toast: !undoing)
    }

    private func setBookmark(_ post: Post, on: Bool, toast: Bool) {
        change(post.id, PostFields(bookmarked: on))
        if toast {
            show((on ? "ブックマークに保存しました" : "ブックマークから外しました") + UndoHint.suffix) { [weak self] in
                self?.setBookmark(post, on: !on, toast: false)
            }
        }
        let idempotent = features?.bookmarksSet == true
        Task {
            do {
                let now = idempotent ? try await api.setBookmark(postId: post.id, on: on) : try await api.toggleBookmark(postId: post.id)
                if now != on { change(post.id, PostFields(bookmarked: now)) } // the server's state wins
            } catch {
                change(post.id, PostFields(bookmarked: !on))
                show(Self.message(error, fallback: "ブックマークできませんでした"), isError: true)
            }
        }
    }

    // MARK: ☆ お気に入り（人）

    func toggleFavorite(_ post: Post, undoing: Bool = false) {
        guard let author = post.authorId, !author.isEmpty else { return }
        let was = post.favoriteByMe == true
        let name = post.authorName ?? ""
        publish(.favorite(authorId: author, on: !was))
        if !undoing {
            show((was ? "\(name) をお気に入りから外しました" : "\(name) をお気に入りに追加しました") + UndoHint.suffix) { [weak self] in
                var p = post
                p.favoriteByMe = !was
                self?.toggleFavorite(p, undoing: true)
            }
        }
        Task {
            do {
                try await api.setFavorite(userId: author, on: !was)
            } catch {
                publish(.favorite(authorId: author, on: was))
                show(Self.message(error, fallback: "お気に入りを変えられませんでした"), isError: true)
            }
        }
    }

    // MARK: 📌 ピン（24 時間・1 人 1 件）

    func togglePin(_ post: Post) {
        Task {
            do {
                let pinned = try await api.togglePin(id: post.id)
                if pinned { publish(.unpinnedOthers(except: post.id)) }
                change(post.id, PostFields(pinnedAt: .some(pinned ? ISO8601DateFormatter().string(from: Date()) : nil)))
                show(pinned ? "ピン留めしました（24時間）" : "ピンを外しました")
            } catch {
                show(Self.message(error, fallback: "ピンを変えられませんでした"), isError: true)
            }
        }
    }

    // MARK: 部活の付け替え

    func setClub(_ post: Post, key: String?) {
        Task {
            do {
                try await api.setClub(id: post.id, club: key)
                change(post.id, PostFields(club: .some(key), clubLabel: key.flatMap { timeline?.clubs[$0] }))
            } catch {
                show(Self.message(error, fallback: "部活動ラベルの更新に失敗しました"), isError: true)
            }
        }
    }

    // MARK: 📊 投票

    func vote(_ post: Post, option: Int) {
        guard let before = post.poll, before.myVote != option else { return }
        // At once on screen (the web's 1 vote: moving it from one answer to another).
        change(post.id, PostFields(poll: Self.voted(before, option: option)))
        Task {
            do {
                let server = try await api.vote(postId: post.id, optionId: option)
                change(post.id, PostFields(poll: server))
            } catch {
                change(post.id, PostFields(poll: before)) // only the poll goes back
                show(Self.message(error, fallback: "投票できませんでした"), isError: true)
            }
        }
    }

    /// The poll as it will be once this vote counts (moves my vote, recounts the shares).
    static func voted(_ poll: PostPoll, option: Int) -> PostPoll {
        var p = poll
        let had = p.myVote
        p.options = p.options.map { o in
            var o = o
            if o.id == had { o.votes = max(0, (o.votes ?? 0) - 1) }
            if o.id == option { o.votes = (o.votes ?? 0) + 1 }
            return o
        }
        let total = p.options.reduce(0) { $0 + ($1.votes ?? 0) }
        p.totalVotes = total
        p.voterCount = total
        p.options = p.options.map { o in var o = o; o.pct = total > 0 ? (Double(o.votes ?? 0) / Double(total) * 100).rounded() : 0; return o }
        p.myVote = option
        return p
    }

    func savePoll(_ post: Post, options: [(id: Int?, label: String)]) async -> String? {
        do {
            let poll = try await api.editPoll(postId: post.id, options: options)
            change(post.id, PostFields(poll: poll))
            return nil
        } catch {
            return Self.message(error, fallback: "アンケートを保存できませんでした")
        }
    }

    // MARK: ✏️ 編集・🗑 削除

    /// nil = saved; otherwise the error to show in the dialog.
    func saveEdit(_ post: Post, text: String, images: [String]?, audio: String??) async -> String? {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            try await api.editPost(id: post.id, text: t, images: images, audio: audio)
            change(post.id, PostFields(text: t, images: images, audioUrl: audio))
            return nil
        } catch {
            return Self.message(error, fallback: "保存できませんでした")
        }
    }

    func delete(_ post: Post) async -> String? {
        do {
            try await api.deletePost(id: post.id)
            publish(.deleted(id: post.id, parentId: post.parentId))
            return nil
        } catch {
            return Self.message(error, fallback: "削除できませんでした")
        }
    }

    // MARK: Members and emoji

    func loadMembers() {
        guard members.isEmpty, !membersLoading else { return }
        membersLoading = true
        Task {
            defer { membersLoading = false }
            if let m = try? await api.members() {
                members = m
                MemberDirectory.shared.set(m)
            }
        }
    }

    /// The @mention being typed at the end of `text`, matched against the members.
    func mentionMatches(_ text: String) -> [MentionMember] {
        guard canMention, let q = Mention.activeQuery(in: text) else { return [] }
        return Mention.candidates(members, query: q.query, recent: [])
    }

    func loadEmojis() {
        guard let path = customEmojiPath else { return }
        Task { await EmojiCatalog.shared.load(api: api, path: path) }
    }
}

extension EnvironmentValues {
    /// The timeline's post operations (nil: none, e.g. the self-test's pictures).
    @Entry var postActions: PostActionsModel? = nil
}

// MARK: - Offline demo (DEBUG): answers like the server, sends nothing anywhere

#if DEBUG
@MainActor
final class DemoPostServer {
    static let shared = DemoPostServer()
    weak var timeline: TimelineStore?
    private var bookmarks = Set<Int>()
    private var favorites = Set<String>()
    private var polls: [Int: PostPoll] = [:]
    private var nextId = 50_000
    /// `-demoActionFail` / BGURU_DEMO_ACTION_FAIL=1: every change fails like a busy server (429).
    var failChanges = CommandLine.arguments.contains("-demoActionFail") || ProcessInfo.processInfo.environment["BGURU_DEMO_ACTION_FAIL"] == "1"

    static let clubs: [(String, String, String)] = [("chat", "雑談", "general"), ("pet", "ペット部", "hobby"), ("apple", "リンゴ部", "tech"),
                                                    ("improve", "機能改善", "general"), ("car", "クルマ部", "hobby"), ("camera", "カメラ部", "hobby")]
    static let emojis = ["beagle", "sanzai", "wan"]
    /// デモで登録・削除したあとの一覧（id, name）。
    private var demoEmojis: [(Int, String)] = DemoPostServer.emojis.enumerated().map { ($0.offset + 1, $0.element) }

    private func json(_ obj: Any, _ status: Int = 200) -> (Int, Data) {
        var o = obj as? [String: Any] ?? [:]
        if (200..<300).contains(status) { o["apiVersion"] = 1 }
        return (status, (try? JSONSerialization.data(withJSONObject: o)) ?? Data("{}".utf8))
    }

    private func post(_ id: Int) -> Post? { timeline?.posts.first { $0.id == id } }

    /// What the demo's posts start with.
    func seed(_ posts: [Post]) {
        bookmarks = Set(posts.filter { $0.bookmarkedByMe == true }.map(\.id))
    }

    private func pollJSON(_ p: PostPoll) -> [String: Any] {
        let enc = JSONEncoder()
        guard let d = try? enc.encode(p), let o = try? JSONSerialization.jsonObject(with: d) else { return [:] }
        return o as? [String: Any] ?? [:]
    }

    func handle(_ req: URLRequest) async -> (Int, Data) {
        try? await Task.sleep(for: .milliseconds(250)) // a moment, as over the network
        let method = req.httpMethod ?? "GET"
        let path = req.url?.path ?? ""
        let query = URLComponents(url: req.url ?? URL(string: "x:")!, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let body = req.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) } as? [String: Any] ?? [:]
        let parts = path.split(separator: "/").map(String.init) // api, agent, posts, 7, pin
        if failChanges && method != "GET" {
            return json(["error": "投稿の操作の上限（1時間に60回）に達しました", "code": "rate_limited"], 429)
        }
        switch (method, parts.dropFirst(2).first ?? "") {
        case ("GET", "members"):
            return json(["members": TimelineDemoMedia.members.map { ["user_id": $0, "name": $0, "avatar": NSNull()] }])
        case ("GET", "clubs"):
            return json(["clubs": Self.clubs.map { ["key": $0.0, "name": $0.1, "category": $0.2] }])
        case ("GET", "emojis"):
            return json(["emojis": demoEmojis.map { ["id": $0.0, "name": $0.1, "image_url": TimelineDemoMedia.picture("emoji-\($0.1)", 96, 96, hue: CGFloat($0.0) * 0.3)] }])
        case ("POST", "emojis"):
            let name = req.value(forHTTPHeaderField: "X-Demo-Emoji") ?? ""
            if demoEmojis.contains(where: { $0.1 == name }) { return json(["error": "その名前は既に使われています", "code": "name_taken"], 409) }
            let id = (demoEmojis.map(\.0).max() ?? 0) + 1
            demoEmojis.append((id, name))
            return json(["emoji": ["id": id, "name": name, "image_url": TimelineDemoMedia.picture("emoji-\(name)", 96, 96, hue: CGFloat(id) * 0.3)]], 201)
        case ("DELETE", "emojis"):
            let id = Int(parts.last ?? "") ?? 0
            guard demoEmojis.contains(where: { $0.0 == id }) else { return json(["error": "絵文字が見つかりません", "code": "not_found"], 404) }
            demoEmojis.removeAll { $0.0 == id }
            return json(["ok": true])
        case ("GET", "posts") where parts.count > 5 && parts[5] == "voters": // …/posts/7/poll/voters
            let id = Int(parts[3]) ?? 0
            guard let poll = polls[id] ?? post(id)?.poll else { return json(["error": "投票が見つかりません", "code": "not_found"], 404) }
            let names = ["mazzo", "takuto", "coban", "りとる", "NORIO TAKAHASHI"]
            var n = 0
            let options: [[String: Any]] = poll.options.map { o in
                let voters: [[String: Any]] = (0..<(o.votes ?? 0)).map { _ in
                    defer { n += 1 }
                    return ["user_id": "demo\(n)", "name": names[n % names.count], "avatar": ""]
                }
                return ["id": o.id, "label": o.label, "voters": voters]
            }
            return json(["ok": true, "options": options])
        case ("GET", "posts"):
            let all = timeline?.posts ?? []
            let list: [Post]
            if query.contains(where: { $0.name == "pinned" }) {
                list = all.filter { PostActionsModel.isPinned($0) }
            } else if query.contains(where: { $0.name == "bm" }) {
                list = all.filter { $0.bookmarkedByMe == true }
            } else {
                list = all.filter { $0.favoriteByMe == true }
            }
            let enc = JSONEncoder()
            enc.keyEncodingStrategy = .convertToSnakeCase
            let posts = (try? JSONSerialization.jsonObject(with: enc.encode(list))) ?? []
            return json(["posts": posts, "next_cursor": NSNull()])
        case ("POST", "bookmarks"):
            // Its own record (the screen has already changed the post: optimistic).
            let id = body["post_id"] as? Int ?? 0
            let on = body["bookmarked"] as? Bool ?? !bookmarks.contains(id)
            if on { bookmarks.insert(id) } else { bookmarks.remove(id) }
            return json(["bookmarked": on])
        case (_, "favorites"):
            let uid = body["user_id"] as? String ?? ""
            if method == "POST" { favorites.insert(uid) } else { favorites.remove(uid) }
            return json(["favorited": method == "POST"])
        case ("POST", "reactions"):
            // The screen toggled it already (optimistic): answer with the counts as they now show.
            let id = body["post_id"] as? Int ?? 0
            let emoji = body["emoji"] as? String ?? ""
            let shown = post(id)?.reactions ?? ChatStore.toggled([], emoji: emoji)
            let added = shown.first { $0.emoji == emoji }?.mine ?? false
            return json(["added": added, "reactions": shown.map { ["emoji": $0.emoji, "count": $0.count] }])
        case ("POST", "upload"), ("POST", "chat"):
            if let kind = req.value(forHTTPHeaderField: "X-Demo-Media") {
                return json(kind == "video" ? ["video_url": TimelineDemoMedia.video] : ["audio_url": TimelineDemoMedia.audio], 201)
            }
            return json(["urls": ["/api/media/demo-upload-\(Int.random(in: 1000...9999)).jpg"]], 201)
        case ("POST", "publish"):
            nextId += 1
            let text = body["text"] as? String ?? ""
            var p = Post(id: nextId, authorId: "me", authorName: "ドリキン", isAuthor: true, parentId: body["parent_id"] as? Int,
                         replyCount: 0, text: text, images: body["images"] as? [String], videoUrl: body["video_url"] as? String,
                         audioUrl: body["audio_url"] as? String, createdAt: ISO8601DateFormatter().string(from: Date()),
                         club: body["club"] as? String ?? "chat")
            p.clubManual = body["club"] != nil
            if let poll = body["poll"] as? [String: Any], let opts = poll["options"] as? [String] {
                let hours = poll["duration_hours"] as? Int ?? 24
                p.poll = PostPoll(question: poll["question"] as? String, endsAt: ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(hours) * 3600)),
                                  closed: false, editable: true, totalVotes: 0, voterCount: 0, myVote: nil,
                                  options: opts.enumerated().map { .init(id: nextId * 10 + $0.offset, label: $0.element, votes: 0, pct: 0) })
            }
            let enc = JSONEncoder()
            enc.keyEncodingStrategy = .convertToSnakeCase
            var obj = (try? JSONSerialization.jsonObject(with: enc.encode(p))) as? [String: Any] ?? [:]
            if let poll = p.poll { obj["poll"] = pollJSON(poll) }
            return json(["post": obj], 201)
        case (_, "posts"):
            let id = parts.count > 3 ? Int(parts[3]) ?? 0 : 0
            let sub = parts.count > 4 ? parts[4] : ""
            switch (method, sub) {
            case ("PATCH", ""): return json(["updated": true])
            case ("DELETE", ""): return json(["deleted": true])
            case ("POST", "pin"): return json(["ok": true, "pinned": !(post(id).map { PostActionsModel.isPinned($0) } ?? false)])
            case ("PATCH", "club"): return json(["ok": true, "club": body["club"] ?? NSNull()])
            case ("POST", "poll"): // …/poll/vote
                guard var poll = polls[id] ?? post(id)?.poll else { return json(["error": "投票が見つかりません", "code": "not_found"], 404) }
                if poll.closed == true { return json(["error": "投票は終了しました", "code": "forbidden"], 403) }
                poll = PostActionsModel.voted(poll, option: body["option_id"] as? Int ?? 0)
                polls[id] = poll
                return json(["ok": true, "poll": pollJSON(poll)])
            case ("PUT", "poll"):
                guard var poll = polls[id] ?? post(id)?.poll else { return json(["error": "投票が見つかりません", "code": "not_found"], 404) }
                let opts = body["options"] as? [[String: Any]] ?? []
                let labels = opts.map { ($0["label"] as? String ?? "").trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
                if labels.count < 3 { return json(["error": "回答は3個以上必要です", "code": "invalid_request"], 400) }
                let kept = Set(opts.compactMap { $0["id"] as? Int })
                if poll.options.contains(where: { ($0.votes ?? 0) > 0 && !kept.contains($0.id) }) {
                    return json(["error": "投票が付いた回答は削除できません", "code": "invalid_request"], 400)
                }
                var n = 0
                poll.options = opts.compactMap { o in
                    let label = (o["label"] as? String ?? "").trimmingCharacters(in: .whitespaces)
                    guard !label.isEmpty else { return nil }
                    n += 1
                    if let oid = o["id"] as? Int, let old = poll.options.first(where: { $0.id == oid }) { var x = old; x.label = label; return x }
                    return .init(id: id * 100 + 50 + n, label: label, votes: 0, pct: 0)
                }
                polls[id] = poll
                return json(["ok": true, "poll": pollJSON(poll)])
            default: break
            }
        default: break
        }
        return json(["error": "見つかりません（デモ）", "code": "not_found"], 404)
    }
}
#endif
