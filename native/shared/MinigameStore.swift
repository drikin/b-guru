import Foundation
import Observation

// 🎮 散財ダッシュ (docs/minigame-spec.md). The game itself — title, run, results and the
// rankings — is the server's web page in a WKWebView (MinigameView.swift); this app is its
// frame and relays what it asks for to /api/agent/minigame/* with the member's token (the
// page never sees it). Main-actor only.

@MainActor
@Observable
final class MinigameStore {
    /// On for this member (capabilities `features.minigame.enabled`).
    private(set) var enabled = false
    private(set) var path = "/api/agent/minigame"
    private(set) var gamePath = "/minigame/index.html"
    /// The game is shown above the chat (☗ and 🎮 are never open together).
    private(set) var open = false
    /// The chat column's height (the game takes at most ~45 % of it, so the chat stays in view).
    private(set) var areaHeight: CGFloat = 0
    func setAreaHeight(_ h: CGFloat) { if abs(h - areaHeight) > 1 { areaHeight = h } }
    /// The message box has the focus (the game pauses: typing must not jump).
    var inputFocused = false

    /// Before the game opens (the chat leaves the club room and closes ☗).
    @ObservationIgnored var willOpen: (@MainActor () -> Void)?
    /// The open game's web view takes the stream's `minigame` events (set while it exists).
    @ObservationIgnored var onEvent: (@MainActor (Any) -> Void)?

    private let api: APIClient
    /// Debug demo: nothing is sent; the requests are answered here.
    private var offline = false

    init(api: APIClient) {
        self.api = api
    }

    var gameURL: URL {
        #if DEBUG
        if let s = ProcessInfo.processInfo.environment["BGURU_MINIGAME_URL"], let u = URL(string: s) { return u }
        #endif
        return APIClient.baseURL.appendingPathComponent(gamePath)
    }

    func configure(_ f: Capabilities.MinigameFeatures?, enabled on: Bool) {
        if let p = f?.path, p.hasPrefix("/api/") { path = p }
        if let g = f?.gameUrl, g.hasPrefix("/minigame/") { gamePath = g }
        enabled = on
        if !on { open = false }
    }

    func show() {
        willOpen?()
        open = true
    }

    func close() { open = false }

    /// The stream's `event: minigame` (today's top 10 changed / my best): to the game as is.
    func apply(_ data: Data) {
        guard enabled, let obj = try? JSONSerialization.jsonObject(with: data) else { return }
        onEvent?(obj)
    }

    // MARK: Relay (the game's requests → the API). Each answers (status, body object).

    func me() async -> (Int, [String: Any]) {
        if offline { return (200, demoMe()) }
        return Self.decode(await api.minigameRaw("GET", path: "\(path)/me"))
    }

    func requestPlay(mode: String, character: String) async -> (Int, [String: Any]) {
        if offline { return (201, ["play": demoPlay(mode: mode, character: character)]) }
        return Self.decode(await api.minigameRaw("POST", path: "\(path)/plays", json: ["mode": mode, "character": character]))
    }

    func finish(playId: Int, inputs: [Int], engineVersion: Int, score: Int?, ticks: Int?) async -> (Int, [String: Any]) {
        if offline { return (200, ["result": demoResult(playId: playId, score: score ?? 0, ticks: ticks ?? 0)]) }
        var json: [String: any Sendable] = ["inputs": inputs, "engine_version": engineVersion]
        if let score { json["score"] = score }
        if let ticks { json["ticks"] = ticks }
        return Self.decode(await api.minigameRaw("POST", path: "\(path)/plays/\(playId)/finish", json: json))
    }

    func leaderboard(period: String) async -> (Int, [String: Any]) {
        if offline { return (200, ["period": period, "mode": period == "week" ? "free" : "daily", "entries": [], "me": NSNull()]) }
        return Self.decode(await api.minigameRaw("GET", path: "\(path)/leaderboard", query: [URLQueryItem(name: "period", value: period)]))
    }

    private static func decode(_ r: (Int, Data)) -> (Int, [String: Any]) {
        let obj = (try? JSONSerialization.jsonObject(with: r.1)) as? [String: Any] ?? [:]
        return (r.0, obj)
    }

    // MARK: Debug demo

    private var demoSeq = 900
    private var demoEngine = 1
    private var demoBest = 0
    private var demoPlays = 0

    #if DEBUG
    func debugLoadDemo() {
        offline = true
        enabled = true
    }
    #endif

    /// The game said which rules it plays (the demo answers with the same version).
    func noteEngine(_ v: Int) { demoEngine = v }

    private static var today: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(identifier: "Asia/Tokyo")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: Date().addingTimeInterval(-5 * 3600))
    }

    private func demoMe() -> [String: Any] {
        let best: Any = demoBest > 0 ? ["score": demoBest, "distance": demoBest, "rank": 1, "play_id": demoSeq, "character": "drikin",
                                        "achieved_at": ISO8601DateFormatter().string(from: Date())] as [String: Any] : NSNull()
        return ["engine_version": demoEngine, "me": ["user_id": "me", "name": "ドリキン"],
                "daily": ["date": Self.today, "seed": 20261021, "resets_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(3600 * 12))],
                "best": ["today": best, "week": NSNull(), "all": best], "plays_today": demoPlays, "top_today": NSNull()]
    }

    private func demoPlay(mode: String, character: String) -> [String: Any] {
        demoSeq += 1
        return ["play_id": demoSeq, "seed": mode == "daily" ? 20261021 : Int.random(in: 1...2_000_000_000), "mode": mode,
                "character": character, "engine_version": demoEngine, "date": mode == "daily" ? Self.today : NSNull(),
                "expires_at": ISO8601DateFormatter().string(from: Date().addingTimeInterval(1800))]
    }

    private func demoResult(playId: Int, score: Int, ticks: Int) -> [String: Any] {
        demoPlays += 1
        let newBest = score > demoBest
        demoBest = max(demoBest, score)
        return ["play_id": playId, "mode": "daily", "score": score, "distance": score, "sd": 0, "ticks": ticks, "cause": "deadline",
                "best": demoBest, "new_best": newBest, "rank": 1, "period": "today", "rank_today": 1, "plays_today": demoPlays,
                "rest_hint": false, "mismatch": false]
    }
}
