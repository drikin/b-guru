import Foundation

// 😀 Reactions — the data and the optimistic toggle, shared by the chat, the timeline and ✉️👥 DM.
// Foundation only, so the Mac's unit tests compile it with DMLogic / GroupDMLogic (mac/Tests).

/// One chip: the same shape as the server's ReactionSummary (src/lib/reactions.ts) for chat, posts and DM.
struct Reaction: Codable, Equatable, Sendable, Hashable {
    var emoji: String
    var count: Int
    var mine: Bool
    var reactors: [String]
}

enum ReactionLogic {
    /// The chips after I tap `emoji` (before the server answers): mine off → on (+1, a new chip at the end),
    /// on → off (−1, the chip goes at 0).
    static func toggled(_ list: [Reaction], emoji: String) -> [Reaction] {
        var next = list
        if let i = next.firstIndex(where: { $0.emoji == emoji }) {
            if next[i].mine {
                next[i].count -= 1
                next[i].mine = false
                if next[i].count <= 0 { next.remove(at: i) }
            } else {
                next[i].count += 1
                next[i].mine = true
            }
        } else {
            next.append(Reaction(emoji: emoji, count: 1, mine: true, reactors: []))
        }
        return next
    }
}

/// POST {dm|gdm}/messages/:id/reactions → { added, reactions } (the chat's answer's shape).
struct DMReactionResponse: Decodable, Sendable {
    var added: Bool?
    var reactions: [Reaction]
}
