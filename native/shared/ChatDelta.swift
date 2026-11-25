import Foundation

/// The chat's cache on this device and the catch-up after a reconnect (owner 2026-11-25: 毎回
/// 取り直さない). The server gives every message a `sig` (a short hash of what this member sees of
/// it); GET /api/agent/chat?after=<newest>&from=<oldest> sends only the newer messages and
/// `window` = [id, sig] for the ones this device has. A sig that differs (an edit, reactions, a
/// notice rewritten, a renamed author) or a row with no sig (changed by the stream) is read again
/// with ids=…; an id missing from the window was deleted or expired.
/// What the catch-up needs of a chat message (ChatMessage; the unit tests use their own).
protocol ChatDeltaItem {
    var id: Int { get }
    var sig: String? { get }
    var createdAt: String { get }
}

enum ChatDelta {
    /// The newest rows the catch-up compares (the window answers at most 200).
    static let compared = 150

    struct Plan: Equatable {
        /// Rows to drop (deleted or expired on the server).
        var removed: Set<Int>
        /// Ids to read again (changed, or on the server but not here).
        var reread: [Int]
    }

    /// `local`: the server messages this device has (ids > 0), oldest first.
    static func plan<M: ChatDeltaItem>(local: [M], window: [WindowEntry]) -> Plan {
        let server = Dictionary(window.map { ($0.id, $0.sig) }, uniquingKeysWith: { a, _ in a })
        let mine = Dictionary(local.map { ($0.id, $0.sig) }, uniquingKeysWith: { a, _ in a })
        let removed = Set(local.map(\.id).filter { server[$0] == nil })
        var reread = local.compactMap { m -> Int? in
            guard let s = server[m.id] else { return nil }
            return m.sig == s ? nil : m.id
        }
        reread += window.map(\.id).filter { mine[$0] == nil } // missed here (a gap)
        return Plan(removed: removed, reread: Array(Set(reread)).sorted())
    }

    /// The list after the catch-up: drop the removed, replace the re-read (an asked-for id
    /// that did not come back is gone too), add the new ones; oldest first, the newest `keep`.
    static func merge<M: ChatDeltaItem>(local: [M], plan: Plan, reread: [M], new: [M], keep: Int = compared) -> [M] {
        var byId: [Int: M] = [:]
        let asked = Set(plan.reread)
        for m in local where !plan.removed.contains(m.id) && !asked.contains(m.id) { byId[m.id] = m }
        for m in reread { byId[m.id] = m }
        for m in new { byId[m.id] = m }
        return Array(byId.values.sorted { $0.id < $1.id }.suffix(keep))
    }

    /// One [id, sig] pair of the window.
    struct WindowEntry: Decodable, Equatable, Sendable {
        var id: Int
        var sig: String
        init(id: Int, sig: String) { self.id = id; self.sig = sig }
        init(from decoder: Decoder) throws {
            var c = try decoder.unkeyedContainer()
            id = try c.decode(Int.self)
            sig = try c.decode(String.self)
        }
    }

    /// Chat expires after 24 hours: older cached rows are not shown.
    static func fresh<M: ChatDeltaItem>(_ messages: [M], now: Date = Date()) -> [M] {
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        return messages.filter { m in
            guard let d = iso.date(from: m.createdAt) ?? plain.date(from: m.createdAt) else { return false }
            return now.timeIntervalSince(d) < 24 * 3600
        }
    }
}

/// Small JSON files for what the app shows before the network answers, one set per account
/// (by a hash of the token), in Application Support. Removed on sign-out.
enum LocalCache {
    static var folder: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("BguruCache", isDirectory: true)
    }

    static func url(_ name: String, token: String) -> URL? {
        guard !token.isEmpty, token != "demo" else { return nil }
        var h: UInt64 = 1469598103934665603 // FNV-1a: only to keep accounts apart, not a secret
        for b in token.utf8 { h = (h ^ UInt64(b)) &* 1099511628211 }
        return folder.appendingPathComponent("\(name)-\(String(h, radix: 16)).json")
    }

    static func read<T: Decodable>(_ type: T.Type, _ name: String, token: String) -> T? {
        guard let u = url(name, token: token), let d = try? Data(contentsOf: u) else { return nil }
        return try? JSONDecoder().decode(T.self, from: d)
    }

    static func write<T: Encodable>(_ value: T, _ name: String, token: String) {
        guard let u = url(name, token: token), let d = try? JSONEncoder().encode(value) else { return }
        try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try? d.write(to: u, options: .atomic)
    }

    /// Sign-out: every account's files.
    static func clear() { try? FileManager.default.removeItem(at: folder) }
}
