import Foundation

/// Mirrors `AgentChatMessageDto` in src/lib/agent-chat.ts (the server is the
/// source of truth). Unknown fields are ignored; missing optional ones default,
/// so the web can add fields without breaking this app.
struct ChatMessage: Codable, Equatable, Sendable {
    var id: Int
    var authorId: String?
    var authorName: String?
    var avatar: String?
    var body: String
    var createdAt: String
    var edited: Bool
    var editedAt: String?
    var isAuthor: Bool
    var mentionsMe: Bool
    var clientId: String?
    var reactions: [Reaction]?
    /// Attached photos (/api/media/chat-…).
    var images: [String]? = nil
    /// "notice": a quiet one-line note from B-guru (who came into / left the room).
    var kind: String? = nil
    /// kind "shogi": the ☗ 将棋 game this card is about (docs/shogi-spec.md「チャットの対局中カード」).
    var shogiGameId: Int? = nil

    var isNotice: Bool { kind == "notice" }
    /// The game card: drawn as a small board when this app has ☗ 将棋 on (else the body as text).
    var isShogiCard: Bool { kind == "shogi" && shogiGameId != nil }

    /// The server gives a photo-only message the body "📷 写真" (for apps that predate
    /// photos and for notifications); this app shows the photos instead.
    var displayBody: String {
        (images?.isEmpty == false && body == "📷 写真") ? "" : body
    }
}

struct Reaction: Codable, Equatable, Sendable, Hashable {
    var emoji: String
    var count: Int
    var mine: Bool
    var reactors: [String]
}

enum SendState: Equatable, Sendable {
    case sent, pending, failed
}

/// A row in the chat list. `key` is stable across the pending → stored swap
/// (clientId when we sent it, otherwise the server id) so SwiftUI never
/// remounts the bubble — no flicker when a send is confirmed.
struct ChatRow: Identifiable, Equatable, Sendable {
    var message: ChatMessage
    var state: SendState = .sent
    var key: String

    var id: String { key }

    init(_ message: ChatMessage, state: SendState = .sent) {
        self.message = message
        self.state = state
        self.key = message.clientId ?? "id-\(message.id)"
    }
}

struct ChatListResponse: Decodable, Sendable {
    var unreadCount: Int
    var latestId: Int
    /// The member's read cursor (servers before 2026-10-19 omit it).
    var lastReadId: Int?
    var messages: [ChatMessage]
}

struct ChatSendResponse: Decodable, Sendable {
    var message: ChatMessage
}

struct ReactionToggleResponse: Decodable, Sendable {
    var added: Bool
    var reactions: [Reaction]
}

struct ReadResponse: Decodable, Sendable {
    var unreadCount: Int
    var latestId: Int
}

struct SummaryResponse: Decodable, Sendable {
    struct Chat: Decodable, Sendable { var unreadCount: Int; var latestId: Int }
    var chat: Chat
    var onlineCount: Int
}

/// GET /api/agent/capabilities. Every field optional: a feature the server does
/// not report is treated as absent and its UI is hidden.
struct Capabilities: Decodable, Sendable, Equatable {
    struct ChatFeatures: Decodable, Sendable, Equatable {
        var read: Bool?
        var send: Bool?
        var editOwn: Bool?
        var reactions: Bool?
        var markRead: Bool?
        var maxBody: Int?
        var ttlHours: Int?
        var images: Bool?
        var imageUpload: String?
        var maxImages: Int?
        var imageMaxSide: Int?
    }
    struct PostFeatures: Decodable, Sendable, Equatable {
        var read: Bool?
        var publish: Bool?
        var upload: Bool?
        var reactions: Bool?
        var markRead: Bool?
        var maxImages: Int?
        // 段階 3「操作」(docs/timeline-spec.md §10–§11). Absent (older servers) = not offered.
        var edit: Bool?
        var delete: Bool?
        var editTextOnly: Bool?
        var whisper: Bool?
        var video: Bool?
        var audio: Bool?
        var maxMediaMb: Int?
        var poll: Bool?
        var pollVote: Bool?
        var pollEdit: Bool?
        var pin: Bool?
        var pinnedList: Bool?
        var bookmarks: Bool?
        /// `bookmarks_set`: POST /api/agent/bookmarks takes `{ post_id, bookmarked }` (sets it, idempotent).
        var bookmarksSet: Bool?
        var favorites: Bool?
        var customEmojiList: String?
        var clubSelect: Bool?
        var clubChange: Bool?
        var mentions: String?
    }
    struct RoomFeatures: Decodable, Sendable, Equatable {
        var enabled: Bool?
        var path: String?
    }
    struct VoiceFeatures: Decodable, Sendable, Equatable {
        var enabled: Bool?
        var join: Bool?
        var admin: Bool?
        var maxParticipants: Int?
        var maxSpeakers: Int?
    }
    struct JukeboxFeatures: Decodable, Sendable, Equatable {
        var enabled: Bool?
        var path: String?
    }
    /// 「ネタ帳に送る」: a post's article into BS ネタ帳 (docs/neta-client-spec.md).
    struct NetaFeatures: Decodable, Sendable, Equatable {
        var enabled: Bool?
        var path: String?
        var site: String?
    }
    /// 🎮 散財ダッシュ (docs/minigame-spec.md). Absent or enabled:false → nothing of it shows.
    struct MinigameFeatures: Decodable, Sendable, Equatable {
        var enabled: Bool?
        var path: String?
        var gameUrl: String?
        var bridgeVersion: Int?
        var engineVersion: Int?
        /// This token may play (has the "chat" scope).
        var play: Bool?
    }
    /// ☗ 将棋 (docs/shogi-spec.md). Absent or enabled:false → nothing of it shows.
    struct ShogiFeatures: Decodable, Sendable, Equatable {
        struct TimeControl: Decodable, Sendable, Equatable {
            var mode: String
            var label: String?
            var initialMs: Int?
            var byoyomiMs: Int?
        }
        var enabled: Bool?
        var path: String?
        var boardUrl: String?
        var bridgeVersion: Int?
        /// This token may play (has the "chat" scope).
        var play: Bool?
        /// 「🐶 ビーグルと対局（練習）」: POST games { mode, opponent: "beagle" } (docs/shogi-spec.md「ビーグル戦」).
        var beagle: Bool?
        /// ビーグルの実況: stream `shogi_commentary`, GET games/{id} `commentary` → the band under the board.
        var commentary: Bool?
        var timeControls: [TimeControl]?
    }
    struct Features: Decodable, Sendable, Equatable {
        var chat: ChatFeatures?
        var posts: PostFeatures?
        var voice: VoiceFeatures?
        var room: RoomFeatures?
        var jukebox: JukeboxFeatures?
        var neta: NetaFeatures?
        var shogi: ShogiFeatures?
        var minigame: MinigameFeatures?
    }
    var apiVersion: Int
    var scopes: [String]?
    var features: Features?

    var canSend: Bool { features?.chat?.send ?? false }
    /// Photos in the chat (servers from before them say nothing → off).
    var canSendChatImages: Bool { features?.chat?.images ?? false }
    var maxChatImages: Int { features?.chat?.maxImages ?? 4 }
    var chatImageMaxSide: Int { features?.chat?.imageMaxSide ?? 1280 }
    var canEdit: Bool { features?.chat?.editOwn ?? false }
    var canReact: Bool { features?.chat?.reactions ?? false }
    var canMarkRead: Bool { features?.chat?.markRead ?? false }
    var maxBody: Int { features?.chat?.maxBody ?? 1000 }
    /// Timeline is available on this server.
    var hasTimeline: Bool { features?.posts?.read ?? false }
    /// Posting needs the "write" scope — tokens from before the timeline must reconnect once.
    var canPublish: Bool { features?.posts?.publish ?? false }
    var canReactPosts: Bool { features?.posts?.reactions ?? false }
    var maxImages: Int { features?.posts?.maxImages ?? 5 }
    /// Voice room is on for this member (server configured + in the rollout).
    var voiceEnabled: Bool { features?.voice?.enabled ?? false }
    /// The club room (8-bit room view + proximity voice) is on for this member.
    var roomEnabled: Bool { features?.room?.enabled ?? false }
    /// The jukebox (past backspace.fm episodes) is on for this member.
    var jukeboxEnabled: Bool { features?.jukebox?.enabled ?? false }
    /// Only paths on our own server (the request carries the token).
    var jukeboxPath: String {
        if let p = features?.jukebox?.path, p.hasPrefix("/api/") { return p }
        return "/api/agent/jukebox"
    }
    var netaEnabled: Bool { features?.neta?.enabled ?? false }
    /// ☗ 将棋 is on for this member, and this app speaks the board's bridge (version 1).
    /// 🎮 is on for this member, and this app speaks the game's bridge (version 1).
    var minigameEnabled: Bool {
        guard features?.minigame?.enabled == true else { return false }
        return (features?.minigame?.bridgeVersion ?? 1) == 1
    }
    var shogiEnabled: Bool {
        guard features?.shogi?.enabled == true else { return false }
        return (features?.shogi?.bridgeVersion ?? 1) == 1
    }
    var netaPath: String {
        if let p = features?.neta?.path, p.hasPrefix("/api/") { return p }
        return "/api/agent/neta"
    }
    /// This token may join (has the "voice" scope — older tokens must sign in again).
    var canJoinVoice: Bool { features?.voice?.join ?? false }
    var isVoiceAdmin: Bool { features?.voice?.admin ?? false }
    var voiceMaxSpeakers: Int { features?.voice?.maxSpeakers ?? 10 }
}

// MARK: - Voice room

/// Who is in the voice room, as the server sees it (GET /api/agent/voice and
/// the stream's `voice` event). Shown to people who have not joined.
struct VoiceRoomInfo: Codable, Equatable, Sendable {
    struct Member: Codable, Equatable, Sendable, Identifiable {
        var userId: String
        var name: String?
        var avatar: String?
        var id: String { userId }
    }
    var active: Bool
    var openedBy: String?
    var startedAt: String?
    var participants: [Member]
}

struct VoiceStateResponse: Decodable, Sendable {
    var enabled: Bool
    var room: VoiceRoomInfo?
}

struct VoiceTokenResponse: Decodable, Sendable {
    var url: String
    var token: String
    var room: String
    var identity: String
}

struct TokenIssueResponse: Decodable, Sendable {
    var token: String
    var expiresAt: String?
}

struct APIErrorBody: Decodable, Sendable {
    var error: String?
    var code: String?
}

// MARK: - Timeline (posts)

/// Mirrors `agentPostDto` in src/app/api/agent/posts/route.ts (+ include=reactions,read).
struct Post: Codable, Identifiable, Equatable, Sendable {
    var id: Int
    var authorId: String?
    var authorName: String?
    var authorAvatar: String?
    var isAuthor: Bool?
    var parentId: Int?
    var replyCount: Int?
    var text: String
    var images: [String]?
    var videoUrl: String?
    var audioUrl: String?
    var createdAt: String
    var lastActivityAt: String?
    var club: String?
    var reactions: [Reaction]?
    var unread: Bool?
    /// Root posts: replies by others this member has not read yet.
    var unreadReplies: Int?
    /// The page a link in the post points to (title / image), filled in by the server.
    var urlPreview: UrlPreview?
    /// The server's display decisions (`include=display`); nil from servers without them.
    /// Read through `TimelineRules`, which falls back to the same rules worked out here.
    @LenientDisplay var display: PostDisplayHints? = nil
    /// While pinned (24 h, the author's own root post).
    var pinnedAt: String?
    var clubManual: Bool?
    /// 📊 投票 (nil: none; a shape the app cannot read is dropped, not the post).
    @LenientPoll var poll: PostPoll? = nil
    /// The member bookmarked this post (🔖 filled) / favourites its author (☆ filled).
    var bookmarkedByMe: Bool?
    var favoriteByMe: Bool?

    /// The post is just one link that has a preview: show the card, not the bare URL.
    var isBareLink: Bool {
        guard urlPreview != nil else { return false }
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return !t.isEmpty && !t.contains(where: \.isWhitespace) && (t.hasPrefix("http://") || t.hasPrefix("https://"))
    }

    var mine: Bool { isAuthor ?? false }
}

struct PostListResponse: Decodable, Sendable {
    var posts: [Post]
    var nextCursor: String?
}

struct ThreadResponse: Decodable, Sendable {
    var post: Post
    var replies: [Post]
}

struct PublishResponse: Decodable, Sendable {
    var post: Post
}

struct UploadResponse: Decodable, Sendable {
    var urls: [String]
}

/// `poll` on a post (the web's PostPoll — its keys are camelCase on the wire too).
struct PostPoll: Codable, Equatable, Sendable {
    struct Option: Codable, Equatable, Sendable, Identifiable {
        var id: Int
        var label: String
        var votes: Int?
        var pct: Double?
    }
    var question: String?
    var endsAt: String?
    var closed: Bool?
    /// The author may edit the answers (within an hour of posting).
    var editable: Bool?
    var totalVotes: Int?
    var voterCount: Int?
    var myVote: Int?
    var options: [Option]
}

/// A `poll` the app cannot read is dropped (the post still shows), like `display`.
@propertyWrapper
struct LenientPoll: Codable, Equatable, Sendable {
    var wrappedValue: PostPoll?
    init(wrappedValue: PostPoll?) { self.wrappedValue = wrappedValue }
    init(from decoder: Decoder) throws { wrappedValue = try? PostPoll(from: decoder) }
    func encode(to encoder: Encoder) throws { try wrappedValue.encode(to: encoder) }
}

extension KeyedDecodingContainer {
    func decode(_ type: LenientPoll.Type, forKey key: Key) throws -> LenientPoll {
        (try? decodeIfPresent(type, forKey: key)) ?? LenientPoll(wrappedValue: nil)
    }
}

/// POST /api/agent/reactions answers without `mine`; the app fills it in.
struct PostReactionToggleResponse: Decodable, Sendable {
    struct R: Decodable, Sendable { var emoji: String; var count: Int }
    var added: Bool
    var reactions: [R]
}

struct ClubInfo: Decodable, Sendable, Hashable {
    var key: String
    var name: String
    var category: String? = nil
}


// MARK: - Club room (ルーム)

/// GET /api/agent/room — see docs/room-client-spec.md.
struct RoomMapInfo: Codable, Equatable, Sendable {
    struct Zone: Codable, Equatable, Sendable {
        var kind: String
        var name: String
        var x: Int, y: Int, w: Int, h: Int
        func contains(_ px: Int, _ py: Int) -> Bool { px >= x && px < x + w && py >= y && py < y + h }
    }
    struct Spot: Codable, Equatable, Sendable { var x: Int; var y: Int }
    struct Label: Codable, Equatable, Sendable { var name: String; var x: Int; var y: Int }
    var w: Int
    var h: Int
    var tiles: [String]
    var zones: [Zone]
    var door: Spot
    var seats: [Spot]
    var labels: [Label]
    var hearRadius: Int
}

struct RoomMember: Codable, Equatable, Sendable, Identifiable {
    var userId: String
    var name: String
    var avatar: String?
    var x: Int
    var y: Int
    var mode: String   // "room" | "text"
    var listening: Bool
    var mic: Bool
    var away: Bool
    var id: String { userId }
    var inRoom: Bool { mode == "room" }
}

struct RoomResponse: Decodable, Sendable {
    var map: RoomMapInfo
    var members: [RoomMember]
    var me: String
    var reactions: [String]?
}

struct RoomActionResponse: Decodable, Sendable {
    var ok: Bool?
    var member: RoomMember?
    var from: RoomMapInfo.Spot?
    var to: RoomMapInfo.Spot?
    var error: String?
}


/// Link preview (posts.url_preview — same object the web uses).
struct UrlPreview: Codable, Equatable, Sendable {
    var url: String
    var title: String?
    var description: String?
    var image: String?
    var siteName: String?
    /// YouTube video id (a play mark goes over the image).
    var videoId: String?
    /// Spotify: the web embeds its player (`embedUrl`, `height`); the app shows the card.
    struct Spotify: Codable, Equatable, Sendable { var embedUrl: String?; var height: Int?; var kind: String? }
    var spotify: Spotify? = nil

    /// The preview image through our server (/api/img) — the third-party site never
    /// sees the member, and the server caches it.
    var proxiedImage: String? {
        guard let image, image.hasPrefix("http") else { return image }
        var c = URLComponents(url: APIClient.baseURL.appendingPathComponent("/api/img"), resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "u", value: image)]
        return c?.url?.absoluteString
    }
}

// MARK: - Jukebox (docs/jukebox-client-spec.md)

/// One past episode of backspace.fm (GET /api/agent/jukebox).
struct Episode: Codable, Equatable, Sendable, Identifiable {
    /// The feed's guid: tells episodes apart and keys the saved position.
    var id: String
    var title: String
    var publishedAt: String
    /// Play exactly this URL (it goes through download counters; never cache where it leads).
    var audioUrl: String
    var durationSec: Int?
    var series: String
    var number: Int?
    var summary: String
    var webUrl: String?

    var year: String { String(publishedAt.prefix(4)) }
    /// "2019.10.20" in Japan. Worked out once per date (the shelf asked again for every row
    /// on every redraw; JukeboxStore fills this when the archive comes in).
    var dateText: String {
        if let hit = Episode.dateTexts.object(forKey: publishedAt as NSString) { return hit as String }
        let t: String
        if let d = Episode.isoParser.date(from: publishedAt) ?? ISO8601DateFormatter().date(from: publishedAt) {
            t = Episode.dayFormatter.string(from: d)
        } else {
            t = String(publishedAt.prefix(10)).replacingOccurrences(of: "-", with: ".")
        }
        Episode.dateTexts.setObject(t as NSString, forKey: publishedAt as NSString)
        return t
    }
    /// NSCache is safe to use from any thread (the archive is prepared off the main thread).
    nonisolated(unsafe) private static let dateTexts: NSCache<NSString, NSString> = {
        let c = NSCache<NSString, NSString>()
        c.countLimit = 5000
        return c
    }()
    /// "#313" / "ep666" / "特別回" for the record's label.
    var label: String {
        guard let number else { return "特別回" }
        if title.range(of: #"ep\s?\d"#, options: [.regularExpression, .caseInsensitive]) != nil { return "ep\(number)" }
        return "#" + String(format: "%03d", number)
    }

    nonisolated(unsafe) private static let isoParser: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let dayFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Tokyo")
        f.dateFormat = "yyyy.MM.dd"
        return f
    }()
}

struct JukeboxResponse: Codable, Sendable {
    struct Today: Codable, Sendable, Equatable {
        var id: String
        var yearsAgo: Int
        var postId: Int?
    }
    var episodes: [Episode]
    var today: Today?
}

// MARK: - BS ネタ帳 (docs/neta-client-spec.md)

enum NetaLinks {
    /// The article URLs a post points to: its link card first, then URLs in the text
    /// (trailing punctuation off). Never B-guru itself. No duplicates.
    static func candidates(text: String, previewURL: String?) -> [String] {
        var out: [String] = []
        func add(_ raw: String) {
            var s = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            while let last = s.last, "。、)）」』】,.!?！？".contains(last) { s.removeLast() }
            guard let u = URL(string: s), let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
                  let host = u.host?.lowercased(), host != "bsm.backspace.fm", u.user == nil else { return }
            if !out.contains(s) { out.append(s) }
        }
        if let p = previewURL { add(p) }
        // Japanese text runs straight on after a URL: its brackets and 、。 end it (same as the web).
        let re = try? NSRegularExpression(pattern: #"https?://[^\s<>"'　「」『』【】（）、。]+"#)
        for m in re?.matches(in: text, range: NSRange(text.startIndex..., in: text)) ?? [] {
            if let r = Range(m.range, in: text) { add(String(text[r])) }
        }
        return out
    }
}

enum NetaOutcome: Equatable, Sendable {
    case sent
    case duplicate(title: String, submitter: String)
    case failed(String)
}
