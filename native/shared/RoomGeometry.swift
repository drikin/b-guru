import Foundation

/// The club room's rules, the same as src/lib/room-map.ts on the server: what is
/// walkable, which zone a tile is in, how loud one person is for another, and the
/// shortest walk between two tiles.
struct RoomGeometry: Sendable {
    let map: RoomMapInfo
    private static let solid: Set<Character> = ["#", "w", "D", "C", "B", "T", "M", "F", "V", "P"]

    func tile(_ x: Int, _ y: Int) -> Character {
        guard y >= 0, y < map.tiles.count else { return "#" }
        let row = Array(map.tiles[y])
        return x >= 0 && x < row.count ? row[x] : "#"
    }

    func walkable(_ x: Int, _ y: Int) -> Bool { !Self.solid.contains(tile(x, y)) }

    func zone(_ x: Int, _ y: Int) -> RoomMapInfo.Zone? { map.zones.first { $0.contains(x, y) } }

    /// 0 = not heard, 1 = full volume (see room-map.ts audibility).
    func audibility(listener: (x: Int, y: Int), speaker: (x: Int, y: Int)) -> Double {
        let ls = zone(listener.x, listener.y), sp = zone(speaker.x, speaker.y)
        if sp?.kind == "stage" { return 1 }
        if ls?.kind == "table" || sp?.kind == "table" { return ls == sp ? 1 : 0 }
        let d = hypot(Double(listener.x - speaker.x), Double(listener.y - speaker.y))
        let r = Double(map.hearRadius)
        if d > r { return 0 }
        return max(0.15, min(1, 1 - (d - 1) / r))
    }

    enum Dir: CaseIterable { case up, down, left, right
        var delta: (Int, Int) { switch self { case .up: (0, -1); case .down: (0, 1); case .left: (-1, 0); case .right: (1, 0) } }
    }

    /// Steps from (sx, sy) to (tx, ty) avoiding solid tiles and `blocked` ones (other
    /// people; the target itself may be occupied-free only). Empty when unreachable.
    func path(from sx: Int, _ sy: Int, to tx: Int, _ ty: Int, blocked: Set<Int> = []) -> [(Int, Int)] {
        guard walkable(tx, ty), !(sx == tx && sy == ty) else { return [] }
        let w = map.w
        let key = { (x: Int, y: Int) in y * w + x }
        var prev: [Int: Int] = [key(sx, sy): -1]
        var queue = [(sx, sy)], head = 0
        while head < queue.count {
            let (x, y) = queue[head]; head += 1
            if x == tx && y == ty { break }
            for d in Dir.allCases {
                let nx = x + d.delta.0, ny = y + d.delta.1, k = key(nx, ny)
                if prev[k] != nil || !walkable(nx, ny) || (blocked.contains(k) && !(nx == tx && ny == ty)) { continue }
                prev[k] = key(x, y)
                queue.append((nx, ny))
            }
        }
        guard prev[key(tx, ty)] != nil else { return [] }
        var out: [(Int, Int)] = []
        var k = key(tx, ty)
        while k != key(sx, sy), let p = prev[k], p >= 0 {
            out.append((k % w, k / w))
            k = p
        }
        return out.reversed()
    }
}
