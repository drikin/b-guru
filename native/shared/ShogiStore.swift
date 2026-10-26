import Foundation
import Observation
#if os(iOS)
import UIKit
#endif

// ☗ 将棋 — members play each other and the chat watches (docs/shogi-spec.md).
// The server's DB is the truth: positions (SFEN), moves (USI) and clocks all come from
// it. This app shows them, sends what the member does, and draws the board with the
// shared web part (/shogi-board/index.html in a WKWebView, ShogiBoardView.swift) — that
// page never sees the token. Main-actor only.

enum ShogiSide: String, Codable, Sendable, Hashable {
    case black, white
    var other: ShogiSide { self == .black ? .white : .black }
    var mark: String { self == .black ? "☗" : "☖" }
}

struct ShogiPlayer: Codable, Equatable, Sendable, Hashable {
    var userId: String
    var name: String
    var avatar: String?
}

/// `ShogiGameDto` (+ `my_color` from GET games/{id}) in src/lib/shogi-types.ts. Strings for
/// status / mode / result so a value added later does not break decoding.
struct ShogiGame: Decodable, Equatable, Sendable, Identifiable {
    struct LastMove: Codable, Equatable, Sendable { var usi: String; var label: String }
    struct Clocks: Codable, Equatable, Sendable {
        var blackMs: Int
        var whiteMs: Int
        var byoyomiMs: Int
        var initialMs: Int?
    }
    var id: Int
    var status: String          // open | offered | active | ended | closed
    var mode: String            // blitz | slow
    var creator: ShogiPlayer?
    var invitee: ShogiPlayer?
    var black: ShogiPlayer?
    var white: ShogiPlayer?
    var sfen: String
    var ply: Int
    var turn: String?
    var lastMove: LastMove?
    var clocks: Clocks?
    var turnStartedAt: String?
    var deadlineAt: String?
    var serverNow: String?
    var spectators: Int?
    var result: String?         // black | white | draw
    var endReason: String?
    var rematchOf: Int?
    var resultPostId: Int?
    /// GET games/{id} only: the caller's colour (nil = watching).
    var myColor: String?

    var isActive: Bool { status == "active" }
    var isEnded: Bool { status == "ended" || status == "closed" }
    var isBlitz: Bool { mode == "blitz" }
    var turnSide: ShogiSide { ShogiSide(rawValue: turn ?? "") ?? (ply % 2 == 0 ? .black : .white) }

    func player(_ s: ShogiSide) -> ShogiPlayer? { s == .black ? black : white }

    /// A test game against myself (black and white are the same member).
    var isSelfPlay: Bool { black != nil && black?.userId == white?.userId }

    func color(of userId: String?) -> ShogiSide? {
        guard let userId else { return nil }
        // Against myself: "my" side is whichever is to move (either side can be played).
        if isSelfPlay, black?.userId == userId { return turnSide }
        if black?.userId == userId { return .black }
        if white?.userId == userId { return .white }
        return nil
    }

    /// ビーグル (the server's system account) is one of the two players.
    static let beagleName = "ビーグル"
    var beagleSide: ShogiSide? {
        if black?.name == Self.beagleName { return .black }
        if white?.name == Self.beagleName { return .white }
        return nil
    }
    var isBeagleGame: Bool { beagleSide != nil }

    /// 「☗A vs ☖B」.
    var playersText: String { "☗\(black?.name ?? "?") vs ☖\(white?.name ?? "?")" }

    static let endReasonLabel = ["resign": "投了", "checkmate": "詰み", "timeout": "時間切れ", "sennichite": "千日手",
                                 "perpetual_check": "連続王手の千日手", "abandon": "放置", "aborted": "中断"]

    /// 「☗A の勝ち（投了）・87 手」 (same words as the web).
    var resultText: String {
        let how = endReason.flatMap { Self.endReasonLabel[$0] } ?? ""
        guard let result else { return "中断・\(ply) 手" }
        if result == "draw" { return "引き分け（\(how)）・\(ply) 手" }
        let w = result == "black" ? "☗\(black?.name ?? "?")" : "☖\(white?.name ?? "?")"
        return "\(w) の勝ち（\(how)）・\(ply) 手"
    }
}

/// `ShogiCommentaryDto` (src/lib/shogi-types.ts) — ビーグルの実況 for one move: the band under
/// the board (docs/shogi-spec.md「ビーグルの実況」). The same move's commentary is replaced
/// (template → ai): the later one wins.
struct ShogiCommentary: Decodable, Equatable, Sendable {
    struct Best: Decodable, Equatable, Sendable { var usi: String?; var label: String? }
    var gameId: Int
    var ply: Int
    var moveLabel: String?
    var text: String
    /// Black's point of view (pawn = 100, a mate ±9999); nil = not read.
    var evalCp: Double?
    /// The side with a mate in sight.
    var mate: String?
    var best: Best?
    var source: String?         // ai | template
    var highlight: String?      // reversal | mate
    var at: String?

    /// The board's `{ type: "commentary", … }` (the server's fields, as the board reads them).
    var boardMessage: [String: Any] {
        var m: [String: Any] = ["type": "commentary", "text": text, "ply": ply,
                                "eval_cp": evalCp ?? NSNull(), "mate": mate ?? NSNull(),
                                "move_label": moveLabel ?? ""]
        if let source { m["source"] = source }
        return m
    }

    /// Takes the place of `old` (the latest move's; for the same move, the later one).
    func replaces(_ old: ShogiCommentary?) -> Bool {
        guard let old else { return true }
        if ply != old.ply { return ply > old.ply }
        if let a = at.flatMap(ShogiTime.parse), let b = old.at.flatMap(ShogiTime.parse) { return a >= b }
        return true
    }
}

/// GET games/{id}: the game, and (members who have it) the latest commentary — `commentaries`
/// (every move) once it is over. A commentary that does not decode is dropped, never the game.
struct ShogiGameDetail: Decodable, Sendable {
    var game: ShogiGame
    var commentary: ShogiCommentary?

    private enum K: String, CodingKey { case game }
    private struct Extra: Decodable {
        var commentary: ShogiCommentary?
        var commentaries: [ShogiCommentary]?
        private enum K: String, CodingKey { case commentary, commentaries }
        init(from d: Decoder) throws {
            let c = try d.container(keyedBy: K.self)
            commentary = (try? c.decodeIfPresent(ShogiCommentary.self, forKey: .commentary)) ?? nil
            commentaries = (try? c.decodeIfPresent([ShogiCommentary].self, forKey: .commentaries)) ?? nil
        }
    }

    init(from d: Decoder) throws {
        let c = try d.container(keyedBy: K.self)
        game = try c.decode(ShogiGame.self, forKey: .game)
        let extra = try? c.decode(Extra.self, forKey: .game)
        commentary = extra?.commentary ?? extra?.commentaries?.max { $0.ply < $1.ply }
    }
}

struct ShogiListResponse: Decodable, Sendable {
    struct Me: Decodable, Sendable { var userId: String?; var selfPlay: Bool? }
    var me: Me?
    var games: [ShogiGame]
}

struct ShogiPostOutcome: Sendable {
    /// HTTP status; 0 = no answer (offline, timed out).
    var status: Int
    var game: ShogiGame?
    var error: String?
    var code: String?
    var spectators: Int?
}

/// The clocks as of now (ms). `byoyomi` is set once the side to move is in its 30 s.
struct ShogiClockNow: Equatable {
    var black: Int
    var white: Int
    var byoyomi: Int?

    /// 手番側の今の残り = 残り −（今 − turn_started_at − 1 秒）; nothing runs while ply < 2
    /// (docs/shogi-spec.md「API の応答」, src/lib/shogi-client.ts clockNow).
    static func of(_ g: ShogiGame, skew: TimeInterval, now: Date = Date()) -> ShogiClockNow? {
        guard let c = g.clocks else { return nil }
        var out = ShogiClockNow(black: c.blackMs, white: c.whiteMs, byoyomi: nil)
        guard g.isActive, g.ply >= 2, let started = g.turnStartedAt.flatMap(ShogiTime.parse) else { return out }
        let elapsed = max(0, Int(((now.timeIntervalSince1970 + skew) - started.timeIntervalSince1970) * 1000) - 1000)
        let main = g.turnSide == .black ? c.blackMs : c.whiteMs
        let left = main - elapsed
        if left >= 0 {
            if g.turnSide == .black { out.black = left } else { out.white = left }
        } else {
            if g.turnSide == .black { out.black = 0 } else { out.white = 0 }
            out.byoyomi = max(0, c.byoyomiMs + left)
        }
        return out
    }

    static func format(_ ms: Int) -> String {
        let s = max(0, Int((Double(ms) / 1000).rounded(.up)))
        return "\(s / 60):" + String(format: "%02d", s % 60)
    }
}

enum ShogiTime {
    nonisolated(unsafe) private static let frac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    nonisolated(unsafe) private static let plain = ISO8601DateFormatter()

    static func parse(_ s: String) -> Date? { frac.date(from: s) ?? plain.date(from: s) }
}

@MainActor
@Observable
final class ShogiStore {
    /// On for this member (capabilities `features.shogi.enabled`).
    private(set) var enabled = false
    /// This token may play (else watch only).
    private(set) var canPlay = true
    /// 「🐶 ビーグルと対局（練習）」 is offered (capabilities features.shogi.beagle).
    private(set) var beagle = false
    /// ビーグルの実況 reaches this member (capabilities `features.shogi.commentary`).
    private(set) var commentaryOn = false
    /// The latest commentary per game (stream `shogi_commentary`, GET games/{id}).
    private(set) var commentaries: [Int: ShogiCommentary] = [:]
    private(set) var path = "/api/agent/shogi"
    private(set) var boardPath = "/shogi-board/index.html"
    /// The ☗ 将棋 screen is shown above the chat (the third choice of テキスト｜ルーム｜☗ 将棋).
    private(set) var open = false
    private(set) var me: String?
    /// May play a test game against myself (「自分と指す（テスト）」 on my own open game).
    private(set) var selfPlay = false
    private(set) var games: [ShogiGame] = []
    /// The game on the board (nil = the lobby).
    private(set) var selectedId: Int?
    private(set) var busy = false
    /// A short note (started / sent / an error). Goes away by itself after 3 s.
    var notice: String? {
        didSet {
            guard let n = notice, n != oldValue else { return }
            noticeTask?.cancel()
            noticeTask = Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(3))
                guard !Task.isCancelled, let self, self.notice == n else { return }
                self.notice = nil
            }
        }
    }
    @ObservationIgnored private var noticeTask: Task<Void, Never>?
    /// The chat column's height (the screen above the chat takes at most half of it).
    private(set) var areaHeight: CGFloat = 0
    func setAreaHeight(_ h: CGFloat) { if abs(h - areaHeight) > 1 { areaHeight = h } }
    /// Server clock − this device's clock (s): the clocks are counted here, corrected by it.
    private(set) var skew: TimeInterval = 0
    /// Bumped whenever the server has answered a move: the board then gets the position
    /// again even if nothing changed, so a move that did not go through is taken back.
    private(set) var moveRevision = 0
    /// ⇅ per game (nil = my colour at the bottom, or black when watching).
    private(set) var orientations: [Int: ShogiSide] = [:]

    var confirmMove: Bool = UserDefaults.standard.bool(forKey: "shogiConfirmMove") {
        didSet { UserDefaults.standard.set(confirmMove, forKey: "shogiConfirmMove") }
    }
    var moveHints: Bool = UserDefaults.standard.object(forKey: "shogiMoveHints") as? Bool ?? true {
        didSet { UserDefaults.standard.set(moveHints, forKey: "shogiMoveHints") }
    }
    /// Before the screen opens (the chat leaves the club room: one thing above the chat).
    @ObservationIgnored var willOpen: (@MainActor () -> Void)?
    /// Someone asked me for a game (the Mac shows a notification).
    @ObservationIgnored var onOffer: (@MainActor (ShogiGame) -> Void)?
    /// A slow game came back to me (the Mac shows a notification).
    @ObservationIgnored var onMyTurn: (@MainActor (ShogiGame) -> Void)?

    private let api: APIClient
    /// Debug demo: nothing is sent; a move is played locally.
    private var offline = false

    init(api: APIClient) {
        self.api = api
    }

    var boardURL: URL {
        #if DEBUG
        if let s = ProcessInfo.processInfo.environment["BGURU_SHOGI_BOARD_URL"], let u = URL(string: s) { return u }
        #endif
        return APIClient.baseURL.appendingPathComponent(boardPath)
    }

    var selected: ShogiGame? { selectedId.flatMap { id in games.first { $0.id == id } } }

    func myColor(in g: ShogiGame) -> ShogiSide? {
        g.color(of: me) ?? g.myColor.flatMap(ShogiSide.init(rawValue:))
    }

    /// The side at the bottom of the board.
    func orientation(for g: ShogiGame) -> ShogiSide {
        orientations[g.id] ?? myColor(in: g) ?? .black
    }

    func setOrientation(_ s: ShogiSide, for id: Int) { orientations[id] = s }

    /// I can move on the board now.
    func canMove(in g: ShogiGame) -> Bool {
        guard canPlay, g.isActive, !busy, let my = myColor(in: g) else { return false }
        return g.turnSide == my
    }

    // MARK: Lobby lists

    var offersToMe: [ShogiGame] { games.filter { $0.status == "offered" && $0.invitee?.userId == me && me != nil } }
    var myPending: [ShogiGame] { games.filter { ($0.status == "open" || $0.status == "offered") && $0.creator?.userId == me && me != nil } }
    var openByOthers: [ShogiGame] { games.filter { $0.status == "open" && $0.creator?.userId != me } }
    var activeGames: [ShogiGame] {
        games.filter(\.isActive).sorted { a, b in
            let am = myColor(in: a) != nil, bm = myColor(in: b) != nil
            return am != bm ? am : a.id > b.id
        }
    }
    var recentEnded: [ShogiGame] { Array(games.filter { $0.status == "ended" }.prefix(10)) }
    /// The one game of the site (an open / offered / active one), if there is one: while it is
    /// on, nobody can ask for another (docs/shogi-spec.md「決めたこと」— 1 局ずつ・早い者勝ち).
    var currentGame: ShogiGame? {
        games.first(where: \.isActive) ?? games.first { $0.status == "open" || $0.status == "offered" }
    }
    var myActive: [ShogiGame] { games.filter { $0.isActive && myColor(in: $0) != nil } }

    /// Offers to me + my games waiting for my move (the mark on 「☗ 将棋」).
    var attention: Int {
        offersToMe.count + myActive.filter { myColor(in: $0) == $0.turnSide }.count
    }

    // MARK: Setup / events

    func configure(_ f: Capabilities.ShogiFeatures?, enabled on: Bool) {
        if let p = f?.path, p.hasPrefix("/api/") { path = p }
        if let b = f?.boardUrl, b.hasPrefix("/shogi-board/") { boardPath = b }
        canPlay = f?.play ?? true
        beagle = f?.beagle == true
        commentaryOn = on && f?.commentary == true
        if !commentaryOn { commentaries = [:] }
        enabled = on
        if !on {
            open = false
            selectedId = nil
            games = []
            return
        }
        Task { await reload() }
    }

    /// The lobby from the server (on connect / reconnect and when the screen opens).
    func reload() async {
        guard enabled, !offline else { return }
        guard let r = try? await api.shogiGames(path: path) else { return }
        if let id = r.me?.userId { me = id }
        selfPlay = r.me?.selfPlay == true
        var next = r.games
        // A game opened from a card / notification may be older than the list: keep it.
        if let sid = selectedId, !next.contains(where: { $0.id == sid }), let kept = selected { next.append(kept) }
        games = next
        if let now = r.games.first?.serverNow { updateSkew(now) }
        if let sid = selectedId { await loadGame(sid) }
    }

    func loadGame(_ id: Int) async {
        guard enabled, !offline else { return }
        do {
            let d = try await api.shogiGame(path: path, id: id)
            let g = d.game
            if let c = d.commentary { takeCommentary(c) }
            if me == nil, let c = g.myColor.flatMap(ShogiSide.init(rawValue:)) { me = g.player(c)?.userId }
            upsert(g)
            if let n = g.serverNow { updateSkew(n) }
        } catch APIError.http(404, _, _) {
            if selectedId == id { notice = "対局が見つかりません" }
        } catch {}
    }

    /// The stream's `event: shogi` — `{ action: state | end | offer, game }`.
    func apply(_ data: Data) {
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        struct E: Decodable { var action: String?; var game: ShogiGame? }
        guard enabled, let e = try? dec.decode(E.self, from: data), let g = e.game else { return }
        applyEvent(e.action ?? "state", g)
    }

    /// The stream's `event: shogi_commentary` — `{ game_id, commentary }` (members who have it).
    func applyCommentary(_ data: Data) {
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        struct E: Decodable { var gameId: Int?; var commentary: ShogiCommentary? }
        guard enabled, commentaryOn, let e = try? dec.decode(E.self, from: data), let c = e.commentary else { return }
        takeCommentary(c)
    }

    /// The commentary for the band under this game's board (nil = no band).
    func commentary(for id: Int) -> ShogiCommentary? { commentaryOn ? commentaries[id] : nil }

    private func takeCommentary(_ c: ShogiCommentary) {
        guard commentaryOn, c.replaces(commentaries[c.gameId]), commentaries[c.gameId] != c else { return }
        commentaries[c.gameId] = c
    }

    private func applyEvent(_ action: String, _ g: ShogiGame) {
        let before = games.first { $0.id == g.id }
        upsert(g)
        if let n = g.serverNow { updateSkew(n) }
        if action == "offer", g.status == "offered" {
            notice = "\(g.creator?.name ?? "だれか") さんから対局の申し込みが届きました"
            onOffer?(g)
        }
        guard g.isActive, let my = myColor(in: g) else { return }
        // My offer / open game was taken: on the lobby, go to its board.
        if let before, !before.isActive {
            if selectedId == nil, open { selectedId = g.id; notice = "対局が始まりました" }
        }
        // A slow game came back to me (the other side moved, or it just started with me first).
        if !g.isBlitz, !g.isSelfPlay, !g.isBeagleGame, g.turnSide == my, let before, before.ply < g.ply || !before.isActive {
            onMyTurn?(g)
        }
    }

    private func upsert(_ g: ShogiGame) {
        guard let i = games.firstIndex(where: { $0.id == g.id }) else {
            games.insert(g, at: 0)
            return
        }
        // An older event must not take a newer position back (compared by moves played).
        if games[i].ply > g.ply && games[i].status == g.status { return }
        var n = g
        if n.myColor == nil { n.myColor = games[i].myColor }
        if games[i] != n { games[i] = n }
    }

    private func updateSkew(_ serverNow: String) {
        guard let t = ShogiTime.parse(serverNow) else { return }
        skew = t.timeIntervalSinceNow
    }

    // MARK: Screen

    func show() {
        willOpen?()
        open = true
        Task { await reload() }
    }

    func close() { open = false }

    /// From a chat card or a notification: the screen on that game.
    func openGame(_ id: Int) {
        willOpen?()
        open = true
        selectedId = id
        onShowingGame?(id)
        Task { await loadGame(id) }
    }

    func select(_ id: Int?) {
        selectedId = id
        notice = nil
        if let id {
            onShowingGame?(id)
            Task { await loadGame(id) }
        }
    }

    /// A game came on the board (the iPhone removes its notification if the screen shows it).
    @ObservationIgnored var onShowingGame: ((Int) -> Void)?

    // MARK: Actions

    @discardableResult
    private func act(_ sub: String, _ json: [String: any Sendable] = [:]) async -> ShogiPostOutcome? {
        guard !busy else { return nil }
        busy = true
        notice = nil
        defer { busy = false }
        let r = await api.shogiPost(path: path, sub, json: json)
        if let g = r.game { applyEvent("state", g) }
        if r.status == 0 { notice = "通信できませんでした" }
        else if r.status >= 400 { notice = r.error ?? "うまくいきませんでした" }
        return r
    }

    /// 募集 / 再戦 (rematch_of: the other side is asked, colours swap). Fast games only (drikin 2026-10-21).
    func create(mode: String, rematchOf: Int? = nil) async {
        if offline { notice = "（デモ）申し込みは送りません"; return }
        var json: [String: any Sendable] = ["mode": mode]
        if let rematchOf { json["rematch_of"] = rematchOf }
        guard let r = await act("games", json) else { return }
        // One game at a time on the whole site: "busy" brings the game that is on (if visible).
        if r.status == 409, r.code == "busy" {
            if let g = r.game { select(g.id) }
            else { notice = "対局は 1 局ずつです。募集中の対局を受けるか、対局中なら観戦してください" }
            return
        }
        guard r.status == 201, let g = r.game else { return }
        notice = g.status == "offered" ? "\(g.invitee?.name ?? "相手") さんに申し込みました" : "募集しました（15 分）"
        if rematchOf != nil { selectedId = nil }
    }

    /// ビーグルと対局（練習）: starts at once (active); rematchOf = もう一局（先後交代）.
    func startBeagle(mode: String, rematchOf: Int? = nil) async {
        #if DEBUG
        if offline { demoStartBeagle(mode: mode, rematchOf: rematchOf); return }
        #endif
        var json: [String: any Sendable] = ["mode": mode, "opponent": "beagle"]
        if let rematchOf { json["rematch_of"] = rematchOf }
        guard let r = await act("games", json) else { return }
        if r.status == 409, r.code == "busy" {
            if let g = r.game { select(g.id) }
            else { notice = "対局は 1 局ずつです。募集中の対局を受けるか、対局中なら観戦してください" }
            return
        }
        guard r.status == 201, let g = r.game else { return }
        select(g.id)
        notice = "ビーグルとの対局が始まりました（先後は振り駒）"
    }

    func accept(_ id: Int) async {
        if offline { notice = "（デモ）受けません"; return }
        if let r = await act("games/\(id)/accept"), r.status == 200 { select(id) }
    }

    func decline(_ id: Int) async {
        if offline { notice = "（デモ）断りません"; return }
        await act("games/\(id)/decline")
    }

    func cancel(_ id: Int) async {
        if offline { notice = "（デモ）取り消しません"; return }
        await act("games/\(id)/cancel")
    }

    func resign(_ id: Int) async {
        #if DEBUG
        if offline { demoResign(id); return }
        #endif
        await act("games/\(id)/resign")
    }

    /// The board sent a move. Confirmed by the server's answer (or the stream); a 409 brings
    /// the latest position back. No answer: sent once more with the same client_move_id
    /// (the server never plays it twice).
    func play(usi: String, label: String) async {
        guard let g = selected, canMove(in: g) else { moveRevision += 1; return }
        #if DEBUG
        if offline { demoPlay(g, usi: usi, label: label); return }
        #endif
        busy = true
        notice = nil
        let id = g.id
        let ply = g.ply
        let clientMoveId = UUID().uuidString.replacingOccurrences(of: "-", with: "").lowercased()
        func payload() -> [String: any Sendable] { ["usi": usi, "expected_ply": ply, "client_move_id": clientMoveId] }
        var r = await api.shogiPost(path: path, "games/\(id)/move", json: payload())
        if r.status == 0 { r = await api.shogiPost(path: path, "games/\(id)/move", json: payload()) }
        busy = false
        if let game = r.game { applyEvent("state", game) }
        if r.status == 0 {
            notice = "通信できませんでした。もう一度指してください"
            await loadGame(id)
        } else if r.status >= 400 {
            notice = r.error ?? "その手は指せませんでした"
            if r.game == nil { await loadGame(id) }
        }
        moveRevision += 1
    }

    /// 観戦中の合図 (every 30 s while watching; the number of watchers).
    func watch(_ id: Int) async {
        guard !offline else { return }
        let r = await api.shogiPost(path: path, "games/\(id)/watch")
        if let n = r.spectators, let i = games.firstIndex(where: { $0.id == id }), games[i].spectators != n {
            games[i].spectators = n
        }
    }

    // MARK: Debug demo

    #if DEBUG
    /// Sample games for offline UI checks (no network): the site's one game (mine, my move)
    /// and two finished ones (one game at a time on the whole site).
    func debugLoadDemo(meId: String = "me", myName: String = "ドリキン") {
        offline = true
        enabled = true
        canPlay = true
        me = meId
        selfPlay = true
        beagle = true
        let now = ISO8601DateFormatter().string(from: Date())
        let started = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-25))
        let json = """
        [{"id":101,"status":"active","mode":"blitz","creator":{"user_id":"mazzo","name":"mazzo"},"invitee":null,
          "black":{"user_id":"\(meId)","name":"\(myName)"},"white":{"user_id":"mazzo","name":"mazzo"},
          "sfen":"lnsgkgsnl/1r5b1/p1pppp1pp/6p2/1p5P1/2P6/PP1PPPP1P/1B5R1/LNSGKGSNL b - 7","ply":6,"turn":"black",
          "last_move":{"usi":"8d8e","label":"△8五歩"},
          "clocks":{"black_ms":512000,"white_ms":548000,"byoyomi_ms":30000,"initial_ms":600000},
          "turn_started_at":"\(started)","server_now":"\(now)","spectators":3,"result":null,"end_reason":null},
         {"id":102,"status":"ended","mode":"slow","creator":{"user_id":"takuto","name":"takuto"},"invitee":null,
          "black":{"user_id":"takuto","name":"takuto"},"white":{"user_id":"coban","name":"coban"},
          "sfen":"lnsgkgsnl/1r5b1/pppppp1pp/6p2/9/2PP5/PP2PPPPP/1B5R1/LNSGKGSNL w - 4","ply":3,"turn":"white",
          "last_move":{"usi":"6g6f","label":"▲6六歩"},"clocks":null,
          "server_now":"\(now)","spectators":0,"result":"black","end_reason":"resign"},
         {"id":90,"status":"ended","mode":"blitz","creator":{"user_id":"mazzo","name":"mazzo"},
          "black":{"user_id":"mazzo","name":"mazzo"},"white":{"user_id":"\(meId)","name":"\(myName)"},
          "sfen":"lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1","ply":87,"turn":"white",
          "server_now":"\(now)","spectators":0,"result":"white","end_reason":"resign"}]
        """
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        games = (try? dec.decode([ShogiGame].self, from: Data(json.utf8))) ?? []
        // BGURU_DEMO_SHOGI_WATCH=1 / -demoShogiWatch: the game is between others (to watch it).
        if ProcessInfo.processInfo.environment["BGURU_DEMO_SHOGI_WATCH"] != nil || CommandLine.arguments.contains("-demoShogiWatch"),
           let i = games.firstIndex(where: { $0.id == 101 }) {
            games[i].black = ShogiPlayer(userId: "takuto", name: "takuto", avatar: nil)
        }
        // BGURU_DEMO_SHOGI_IDLE=1 / -demoShogiIdle: no game on (the lobby offers 募集・指名).
        if ProcessInfo.processInfo.environment["BGURU_DEMO_SHOGI_IDLE"] != nil || CommandLine.arguments.contains("-demoShogiIdle") {
            games.removeAll { !$0.isEnded }
        }
        // ビーグルの実況 (off with BGURU_DEMO_SHOGI_COMMENTARY=0 / -demoShogiNoCommentary: no band, as on an older server).
        commentaryOn = ProcessInfo.processInfo.environment["BGURU_DEMO_SHOGI_COMMENTARY"] != "0"
            && !CommandLine.arguments.contains("-demoShogiNoCommentary")
        commentaries = [:]
        if commentaryOn {
            demoCommentary(101, ply: 6, label: "△8五歩", text: "△8五歩で飛車先を伸ばしたわん。☗ドリキンさんは角道を受けるか考えどころだわん", eval: 35, source: "ai")
            demoCommentary(102, ply: 3, label: "▲6六歩", text: "▲6六歩で角道を止めたわん。じっくりした将棋になりそうだわん", eval: 60, source: "ai")
        }
        // BGURU_DEMO_SHOGI_CMT_CYCLE=1 / -demoShogiCommentaryCycle: on game 101, after 6 s a move (▲6六歩), its template
        // commentary 1 s later, the AI's 2 s after that; at 12 s the board is closed and opened again (a new web view:
        // the latest commentary must come back). Logs "[shogi-cmt] …" at each step.
        if ProcessInfo.processInfo.environment["BGURU_DEMO_SHOGI_CMT_CYCLE"] != nil || CommandLine.arguments.contains("-demoShogiCommentaryCycle") {
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(6))
                guard let self, let g = self.games.first(where: { $0.id == 101 }) else { return }
                self.demoPlay(g, usi: "6g6f", label: "▲6六歩")
                print("[shogi-cmt] moved"); fflush(stdout)
                try? await Task.sleep(for: .seconds(6))
                self.select(nil)
                try? await Task.sleep(for: .seconds(1))
                self.select(101)
                print("[shogi-cmt] reopened"); fflush(stdout)
            }
        }
    }

    private func demoCommentary(_ id: Int, ply: Int, label: String, text: String, eval: Double?, source: String) {
        commentaries[id] = ShogiCommentary(gameId: id, ply: ply, moveLabel: label, text: text, evalCp: eval, mate: nil, best: nil,
                                           source: source, highlight: nil, at: ISO8601DateFormatter().string(from: Date()))
    }

    /// After a demo move: the template at once (1 s), the AI's sentence for the same move later (it replaces it).
    private func demoCommentaryAfter(_ g: ShogiGame) {
        guard commentaryOn, let lm = g.lastMove else { return }
        let id = g.id, ply = g.ply
        let eval = Double((ply * 37) % 400 - 150)
        Task { @MainActor [weak self] in
            try? await Task.sleep(for: .seconds(1))
            guard let self, self.games.first(where: { $0.id == id })?.ply == ply else { return }
            self.demoCommentary(id, ply: ply, label: lm.label, text: "\(lm.label)。形勢はほぼ互角だわん", eval: eval, source: "template")
            try? await Task.sleep(for: .seconds(2))
            guard self.games.first(where: { $0.id == id })?.ply == ply else { return }
            self.demoCommentary(id, ply: ply, label: lm.label,
                                text: "\(lm.label)は落ち着いた一手だわん。次は相手の飛車の動きに注目したいわん", eval: eval, source: "ai")
        }
    }

    private func demoPlay(_ g: ShogiGame, usi: String, label: String) {
        guard let i = games.firstIndex(where: { $0.id == g.id }), let next = DemoSFEN.apply(usi, to: g.sfen) else {
            moveRevision += 1
            return
        }
        var n = games[i]
        let mover = n.turnSide
        n.sfen = next
        n.ply += 1
        n.turn = mover.other.rawValue
        n.lastMove = .init(usi: usi, label: label)
        if var c = n.clocks, let started = n.turnStartedAt.flatMap(ShogiTime.parse), n.ply > 2 {
            let spent = Int(Date().timeIntervalSince(started) * 1000)
            if mover == .black { c.blackMs = max(0, c.blackMs - spent) } else { c.whiteMs = max(0, c.whiteMs - spent) }
            n.clocks = c
        }
        n.turnStartedAt = ISO8601DateFormatter().string(from: Date())
        games[i] = n
        moveRevision += 1
        demoCommentaryAfter(n)
    }

    private func demoStartBeagle(mode: String, rematchOf: Int?) {
        let now = ISO8601DateFormatter().string(from: Date())
        let meP = #"{"user_id":"\#(me ?? "me")","name":"ドリキン"}"#
        let dog = #"{"user_id":"beagle","name":"ビーグル","avatar":"/icon-192.png"}"#
        let clocks = mode == "blitz" ? #"{"black_ms":600000,"white_ms":600000,"byoyomi_ms":30000,"initial_ms":600000}"# : "null"
        let json = """
        {"id":\(200 + (rematchOf ?? 0) % 100),"status":"active","mode":"\(mode)","creator":\(meP),"invitee":\(dog),
         "black":\(meP),"white":\(dog),"sfen":"lnsgkgsnl/1r5b1/ppppppppp/9/9/9/PPPPPPPPP/1B5R1/LNSGKGSNL b - 1",
         "ply":0,"turn":"black","clocks":\(clocks),"turn_started_at":"\(now)","server_now":"\(now)","spectators":0}
        """
        let dec = JSONDecoder()
        dec.keyDecodingStrategy = .convertFromSnakeCase
        guard let g = try? dec.decode(ShogiGame.self, from: Data(json.utf8)) else { return }
        games.removeAll { $0.id == g.id }
        games.insert(g, at: 0)
        selectedId = g.id
        notice = "ビーグルとの対局が始まりました（先後は振り駒）"
    }

    private func demoResign(_ id: Int) {
        guard let i = games.firstIndex(where: { $0.id == id }), let my = myColor(in: games[i]) else { return }
        games[i].status = "ended"
        games[i].result = my.other.rawValue
        games[i].endReason = "resign"
        moveRevision += 1
    }
    #endif
}

#if DEBUG
/// Plays a USI move on an SFEN (demo only — no rule checks; the board only offers legal moves).
enum DemoSFEN {
    static func apply(_ usi: String, to sfen: String) -> String? {
        let parts = sfen.split(separator: " ").map(String.init)
        guard parts.count >= 4 else { return nil }
        // Board: 9 rows of 9 cells, each "" or a piece ("P", "+p", …). Row 0 = rank a, column 0 = file 9.
        var board: [[String]] = []
        for row in parts[0].split(separator: "/") {
            var cells: [String] = []
            var promo = false
            for ch in row {
                if let n = ch.wholeNumberValue { cells += Array(repeating: "", count: n) }
                else if ch == "+" { promo = true }
                else { cells.append((promo ? "+" : "") + String(ch)); promo = false }
            }
            guard cells.count == 9 else { return nil }
            board.append(cells)
        }
        guard board.count == 9 else { return nil }
        let black = parts[1] == "b"
        var hand: [Character: Int] = [:]
        var count = 0
        for ch in parts[2] where ch != "-" {
            if let n = ch.wholeNumberValue { count = count * 10 + n } else { hand[ch, default: 0] += max(1, count); count = 0 }
        }
        func square(_ s: Substring) -> (Int, Int)? {
            guard s.count == 2, let f = s.first?.wholeNumberValue, let r = s.last?.asciiValue else { return nil }
            let row = Int(r) - 97
            guard (1...9).contains(f), (0...8).contains(row) else { return nil }
            return (row, 9 - f)
        }
        let u = Array(usi)
        if u.count == 4, u[1] == "*" {
            guard let (r, c) = square(Substring(String(u[2...3]))) else { return nil }
            let p = black ? Character(String(u[0]).uppercased()) : Character(String(u[0]).lowercased())
            guard (hand[p] ?? 0) > 0, board[r][c].isEmpty else { return nil }
            hand[p]! -= 1
            board[r][c] = String(p)
        } else if u.count >= 4 {
            guard let (fr, fc) = square(Substring(String(u[0...1]))), let (tr, tc) = square(Substring(String(u[2...3]))) else { return nil }
            var piece = board[fr][fc]
            guard !piece.isEmpty else { return nil }
            let captured = board[tr][tc]
            if !captured.isEmpty, let base = captured.last {
                let mine = black ? Character(String(base).uppercased()) : Character(String(base).lowercased())
                hand[mine, default: 0] += 1
            }
            if u.count == 5, u[4] == "+" { piece = "+" + piece }
            board[fr][fc] = ""
            board[tr][tc] = piece
        } else {
            return nil
        }
        var rows: [String] = []
        for row in board {
            var s = "", empty = 0
            for cell in row {
                if cell.isEmpty { empty += 1; continue }
                if empty > 0 { s += String(empty); empty = 0 }
                s += cell
            }
            if empty > 0 { s += String(empty) }
            rows.append(s)
        }
        var handText = ""
        for p in "RBGSNLPrbgsnlp" {
            let n = hand[p] ?? 0
            if n > 0 { handText += (n > 1 ? String(n) : "") + String(p) }
        }
        let moveNo = (Int(parts[3]) ?? 1) + 1
        return "\(rows.joined(separator: "/")) \(black ? "w" : "b") \(handText.isEmpty ? "-" : handText) \(moveNo)"
    }
}
#endif
