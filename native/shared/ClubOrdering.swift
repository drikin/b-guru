import Foundation

/// 「自分の順番」 / 「未読順」 of the club list (ドリキン 2026-11-09「自分でカスタマイズした順番か未読順かで選べるように」).
enum ClubSort: String, CaseIterable, Sendable {
    case custom, unread
    var label: String { self == .custom ? "自分の順番" : "未読順" }
}

/// The club list's order (pure — tested). 自分の順番: the saved keys first, in that order (ones not
/// listed are skipped), then the rest in the catalog's order. 未読順: most unread first, ties in
/// 自分の順番.
enum ClubOrdering {
    static func ordered<T>(_ clubs: [T], key: (T) -> String, saved: [String], unread: [String: Int], sort: ClubSort) -> [T] {
        var rank: [String: Int] = [:]
        for (i, k) in saved.enumerated() where rank[k] == nil { rank[k] = i }
        var catalog: [String: Int] = [:]
        for (i, c) in clubs.enumerated() where catalog[key(c)] == nil { catalog[key(c)] = i }
        func custom(_ a: String, _ b: String) -> Bool {
            switch (rank[a], rank[b]) {
            case let (x?, y?): return x < y
            case (_?, nil): return true
            case (nil, _?): return false
            default: return (catalog[a] ?? 0) < (catalog[b] ?? 0)
            }
        }
        return clubs.sorted { l, r in
            let a = key(l), b = key(r)
            if sort == .unread {
                let x = unread[a] ?? 0, y = unread[b] ?? 0
                if x != y { return x > y }
            }
            return custom(a, b)
        }
    }

    /// The badge: nothing for 0, "99+" above 99.
    static func badge(_ n: Int) -> String? { n <= 0 ? nil : n > 99 ? "99+" : "\(n)" }
}
