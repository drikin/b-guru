import SwiftUI

// The timeline's display rules, in one place — the same as the web's.
//
// The server works them out once for every client: `display` on each post with
// `include=display` (docs/timeline-spec.md §2, src/lib/timeline-display.ts). When a server
// does not send it (older servers), the app works out the same answer here with the same
// rules (`TimelineRules.computed`, checked against the shared examples in
// src/lib/__tests__/fixtures/timeline/ by the Mac's `-timelineFixtures` self-test). Every view
// asks `TimelineRules`, never the hints or the numbers directly.

/// `display` on a post (`include=display`). Decoded with snake_case → camelCase. Every
/// field optional: a missing one → the app's own rule; unknown fields are skipped.
struct PostDisplayHints: Codable, Equatable, Sendable {
    struct MentionRange: Codable, Equatable, Sendable { var start: Int; var end: Int; var name: String }
    struct UserLink: Codable, Equatable, Sendable { var start: Int; var end: Int; var userId: String }
    struct LinkCard: Codable, Equatable, Sendable {
        /// "spotify" | "youtube" | "link"
        var kind: String
        var url: String
        var embedUrl: String? = nil
        var embedHeight: Int? = nil
        var videoId: String? = nil
        var imageAspect: String? = nil
        var imageMaxWidth: Int? = nil
    }
    var version: Int?
    /// The body is folded (「続きを読む」).
    var fold: Bool?
    /// While folded, the body up to here (UTF-16 units, JS `length`; 499 when 500 would split an emoji).
    var foldAt: Int?
    /// The reactions' emoji in the order to show them.
    var reactionsOrder: [String]?
    /// Per emoji: N of 「他N人」.
    var reactorsMore: [String: Int]?
    /// 0–3 (1: at most 360 wide).
    var imageColumns: Int?
    /// The link drawn as a card (nil: none).
    var linkCardUrl: String?
    var linkCard: LinkCard?
    /// Where the member @mentions are in `text` (UTF-16 ranges).
    var mentionRanges: [MentionRange]?
    /// `#/user/<id>` links in `text` (the app has no profile screen yet: drawn as text).
    var userLinks: [UserLink]?
    var clubLabel: String?
    var clubUnset: Bool?
}

/// A `display` the app cannot read (a newer server's shape) is dropped, not the whole list:
/// the post is shown with the app's own rules instead.
@propertyWrapper
struct LenientDisplay: Codable, Equatable, Sendable {
    var wrappedValue: PostDisplayHints?
    init(wrappedValue: PostDisplayHints?) { self.wrappedValue = wrappedValue }
    init(from decoder: Decoder) throws { wrappedValue = try? PostDisplayHints(from: decoder) }
    func encode(to encoder: Encoder) throws { try wrappedValue.encode(to: encoder) }
}

extension KeyedDecodingContainer {
    func decode(_ type: LenientDisplay.Type, forKey key: Key) throws -> LenientDisplay {
        (try? decodeIfPresent(type, forKey: key)) ?? LenientDisplay(wrappedValue: nil)
    }
}

@MainActor
enum TimelineRules {
    /// The web folds a body longer than this (`CLAMP_THRESHOLD`, UTF-16 units like JS `length`).
    nonisolated static let clampThreshold = 500
    /// One picture: at most this wide (the web's `maxWidth: 360`).
    nonisolated static let singleImageMaxWidth: CGFloat = 360
    /// One picture: at most this tall. The web has no limit; a very tall picture (a phone
    /// screenshot, 1:2.2) would fill more than a screen of the panel, so the app stops at
    /// this and narrows the picture to keep its shape (never crops).
    nonisolated static let singleImageMaxHeight: CGFloat = 480
    /// Video box: the web's `maxWidth: 560`, `maxHeight: 420`.
    nonisolated static let videoMaxWidth: CGFloat = 560
    nonisolated static let videoMaxHeight: CGFloat = 420
    /// Audio player: the web's `maxWidth: 560`.
    nonisolated static let audioMaxWidth: CGFloat = 560
    /// Reactors named in the list (the server sends at most 12; the rest are 「他N人」).
    nonisolated static let reactorLimit = 12

    // MARK: Long text

    /// Where to fold (the server's `foldPoint`): nil when the body is at most 500 UTF-16
    /// units; 500, or 499 when the 500th unit is the first half of an emoji.
    nonisolated static func foldPoint(_ text: String) -> Int? {
        let u = Array(text.utf16)
        guard u.count > clampThreshold else { return nil }
        return UTF16.isLeadSurrogate(u[clampThreshold - 1]) ? clampThreshold - 1 : clampThreshold
    }

    /// The body while folded, or nil when it is not folded (from the post's one display).
    /// A fold point out of range (negative, past the end) is brought inside the text.
    static func foldedText(_ post: Post) -> String? {
        let d = resolved(post)
        guard d.fold == true else { return nil }
        let n = post.text.utf16.count
        let at = max(0, min(d.foldAt ?? foldPoint(post.text) ?? n, n))
        guard at > 0, at < n else { return nil }  // nothing before the fold: show it all
        return prefix(post.text, utf16: at)
    }

    /// The first `n` UTF-16 units, never splitting a character's surrogate pair (the web's
    /// `slice` can leave half a pair, drawn as �; here it stops one short instead).
    static func prefix(_ s: String, utf16 n: Int) -> String {
        let u = s.utf16
        guard n < u.count else { return s }
        var i = u.index(u.startIndex, offsetBy: n)
        while i > u.startIndex, i.samePosition(in: s.unicodeScalars) == nil { i = u.index(before: i) }
        return String(s[..<i])
    }

    // MARK: Pictures

    /// Columns of the picture grid: 1 → 1, 2 → 2, 3 and more → 3 (the web's
    /// `repeat(min(n, 3), 1fr)`).
    nonisolated static func imageColumns(_ count: Int) -> Int { count > 0 ? min(count, 3) : 0 }
    static func imageColumns(_ post: Post) -> Int {
        max(0, min(3, resolved(post).imageColumns ?? imageColumns(post.images?.count ?? 0)))
    }

    /// Whether a media path is an animated GIF (served as the original, never resized).
    static func isGIF(_ path: String) -> Bool {
        let p = path.split(separator: "?").first.map(String.init) ?? path
        return p.lowercased().hasSuffix(".gif")
    }

    // MARK: Reactions

    /// Most reactions first; the same count in emoji order (JS string order = UTF-16). Always
    /// the post's reactions as they are here (a reaction just pressed reorders at once), by the
    /// same rule as the server's `reactions_order` (which is therefore not read).
    static func sortedReactions(_ post: Post) -> [Reaction] {
        sorted(post.reactions ?? [])
    }

    nonisolated static func sorted(_ list: [Reaction], order: [String]? = nil) -> [Reaction] {
        if let order, !order.isEmpty {
            let rank = Dictionary(order.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
            // Ones the server did not list yet (just added here): after, by the app's rule.
            let known = list.filter { rank[$0.emoji] != nil }.sorted { rank[$0.emoji]! < rank[$1.emoji]! }
            return known + sorted(list.filter { rank[$0.emoji] == nil })
        }
        return list.sorted { a, b in
            if a.count != b.count { return a.count > b.count }
            return Array(a.emoji.utf16).lexicographicallyPrecedes(Array(b.emoji.utf16))
        }
    }

    /// Who reacted, as the web's tooltip says it: 「❤️ 14人」 then the names joined with 、
    /// and 「他N人」 for the ones not in the list (the list is capped, the count is not).
    static func reactorsHeader(_ r: Reaction) -> String { "\(r.emoji) \(r.count)人" }
    /// N of 「他N人」: the count less the names sent (the server sends 12 at most).
    nonisolated static func reactorsMore(_ r: Reaction) -> Int { max(0, r.count - r.reactors.count) }
    static func reactorsNames(_ r: Reaction) -> String? {
        let names = r.reactors
        let hidden = reactorsMore(r)
        if names.isEmpty { return nil }
        return names.joined(separator: "、") + (hidden > 0 ? " 他\(hidden)人" : "")
    }
    static func reactorsText(_ r: Reaction) -> String {
        [reactorsHeader(r), reactorsNames(r)].compactMap { $0 }.joined(separator: "\n")
    }

    // MARK: Link card

    /// The card under a post: the server's link preview (the first link), unless the
    /// server says otherwise. Spotify stays a card (the web embeds a player, which would
    /// need a web view here).
    static func linkCard(_ post: Post) -> UrlPreview? {
        guard let p = post.urlPreview, !p.url.isEmpty, resolved(post).linkCardUrl != nil else { return nil }
        return p
    }

    /// The card is a YouTube one (16:9 thumbnail, at most 480 wide).
    static func isYouTubeCard(_ post: Post) -> Bool { resolved(post).linkCard?.kind == "youtube" }

    /// The card's kind, as the server's `linkCardOf`: "spotify" (the web shows only the
    /// embedded player — the app keeps the card), "youtube" (16:9, at most 480), "link".
    nonisolated static func linkCardKind(_ p: UrlPreview?) -> String? {
        guard let p, !p.url.isEmpty else { return nil }
        if let e = p.spotify?.embedUrl, !e.isEmpty { return "spotify" }
        if let v = p.videoId, !v.isEmpty { return "youtube" }
        return "link"
    }

    // MARK: Mentions

    /// Whether `name` (as written after @) is a member: the web's rule (exact name,
    /// any case). No members known yet → no @ gets the mention look (as on the web).
    /// The names the post's text mentions (its display's `mention_ranges`). The text is drawn
    /// after its Markdown is parsed, which moves the positions, so the drawing finds these
    /// names with the same patterns (an @ not in the ranges is never one of these names).
    static func mentionNames(_ post: Post) -> [String] {
        (resolved(post).mentionRanges ?? []).map(\.name)
    }

    // MARK: The one display a post is drawn from

    /// The server's `display`, or the same worked out here (cached per text and members list).
    static func resolved(_ post: Post) -> PostDisplayHints {
        if let d = post.display { return d }
        let key = "\(MemberDirectory.shared.generation)|\(post.id)|\(post.club ?? "")|\(post.images?.count ?? 0)|\(post.urlPreview?.url ?? "")|\(post.urlPreview?.videoId ?? "")|\(post.text)" as NSString
        if let hit = resolvedCache.object(forKey: key) { return hit.value }
        let d = computed(post, memberNames: MemberDirectory.shared.names, clubName: { _ in nil })
        resolvedCache.setObject(DisplayBox(d), forKey: key)
        return d
    }

    private final class DisplayBox { let value: PostDisplayHints; init(_ v: PostDisplayHints) { value = v } }
    private static let resolvedCache: NSCache<NSString, DisplayBox> = {
        let c = NSCache<NSString, DisplayBox>()
        c.countLimit = 1000
        return c
    }()

    /// The server's `findMentions` (UTF-16 ranges in `text`, a `@[A B]` first, then `@name`
    /// not inside one; any case), minus the ones overlapping a `#/user/` link.
    nonisolated static func findMentions(_ text: String, names: [String]) -> [PostDisplayHints.MentionRange] {
        guard !names.isEmpty, !text.isEmpty else { return [] }
        let set = Set(names.map { $0.lowercased() })
        let ns = text as NSString
        let all = NSRange(location: 0, length: ns.length)
        var out: [PostDisplayHints.MentionRange] = []
        for m in bracketRe.matches(in: text, range: all) {
            let n = ns.substring(with: m.range(at: 1))
            if set.contains(n.lowercased()) { out.append(.init(start: m.range.location, end: NSMaxRange(m.range), name: n)) }
        }
        var second: [PostDisplayHints.MentionRange] = []
        for m in plainRe.matches(in: text, range: all) {
            if out.contains(where: { m.range.location >= $0.start && m.range.location < $0.end }) { continue }
            let n = ns.substring(with: m.range(at: 1))
            if set.contains(n.lowercased()) { second.append(.init(start: m.range.location, end: NSMaxRange(m.range), name: n)) }
        }
        let links = findUserLinks(text)
        return (out + second).filter { m in !links.contains { m.start < $0.end && m.end > $0.start } }.sorted { $0.start < $1.start }
    }

    nonisolated static func findUserLinks(_ text: String) -> [PostDisplayHints.UserLink] {
        let ns = text as NSString
        return userLinkRe.matches(in: text, range: NSRange(location: 0, length: ns.length)).map {
            .init(start: $0.range.location, end: NSMaxRange($0.range), userId: ns.substring(with: $0.range(at: 1)))
        }
    }

    /// JavaScript's `\s` (the same set as Kotlin's JS_SPACE): not ICU's, which differs.
    nonisolated static let jsSpace = #"\t\n\u000B\f\r \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF"#
    nonisolated private static let bracketRe = try! NSRegularExpression(pattern: #"@\[([^\]]+)\]"#)
    nonisolated private static let plainRe = try! NSRegularExpression(pattern: "@([^" + jsSpace + #"@<\[]+)"#)
    nonisolated private static let userLinkRe = try! NSRegularExpression(pattern: #"(?:https?://bsm\.backspace\.fm)?/?#/user/([^"# + jsSpace + #"<)\]，。、]+)"#)

    // MARK: All of it (the server's computePostDisplay, for posts without `display`)

    nonisolated static func computed(_ post: Post, memberNames: [String], clubName: (String) -> String?) -> PostDisplayHints {
        let at = foldPoint(post.text)
        let rs = sorted(post.reactions ?? [])
        let kind = linkCardKind(post.urlPreview)
        let unset = post.club == "__unset__"
        var card: PostDisplayHints.LinkCard?
        if let p = post.urlPreview, let kind {
            switch kind {
            case "spotify": card = .init(kind: kind, url: p.url, embedUrl: p.spotify?.embedUrl, embedHeight: (p.spotify?.height).flatMap { $0 == 0 ? nil : $0 } ?? 152)
            case "youtube": card = .init(kind: kind, url: p.url, videoId: p.videoId, imageAspect: "16:9", imageMaxWidth: 480)
            default: card = .init(kind: kind, url: p.url)
            }
        }
        return PostDisplayHints(
            version: 1, fold: at != nil, foldAt: at,
            reactionsOrder: rs.map(\.emoji),
            reactorsMore: Dictionary(rs.map { ($0.emoji, reactorsMore($0)) }, uniquingKeysWith: { a, _ in a }),
            imageColumns: imageColumns(post.images?.count ?? 0),
            linkCardUrl: card?.url, linkCard: card,
            mentionRanges: findMentions(post.text, names: memberNames),
            userLinks: findUserLinks(post.text).filter { !$0.userId.contains("@") },
            clubLabel: post.club.flatMap { $0.isEmpty ? nil : (unset ? "未設定" : clubName($0)) },
            clubUnset: unset)
    }
}

/// The members' names, for drawing @mentions (GET /api/agent/members). Filled by the
/// chat (which loads them for its composer) or the timeline, whichever comes first.
/// Not observed by the rows: `generation` goes into the parsed-text cache key, and a
/// row draws again when the timeline next changes.
@MainActor
final class MemberDirectory {
    static let shared = MemberDirectory()
    private var namesSet = Set<String>()
    private(set) var generation = 0
    var isEmpty: Bool { names.isEmpty }

    func set(_ members: [MentionMember]) {
        let next = Set(members.map { $0.name.lowercased() })
        guard next != namesSet else { return }
        namesSet = next
        generation += 1
    }

    func contains(_ name: String) -> Bool { namesSet.contains(name.lowercased()) }
    /// The names (lower-cased; matching ignores case).
    var names: [String] { Array(namesSet) }
}
