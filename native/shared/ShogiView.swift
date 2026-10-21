import SwiftUI

// ☗ 将棋 above the chat: the lobby (募集・指名・届いた申し込み・対局中・最近の結果), a game
// (the board with names / clocks in its two bands, and a bar with moves, watchers and ⋯),
// the end (result, 再戦, 閉じる). Same flow as the web (src/components/shogi/ShogiPanel.tsx).

extension EnvironmentValues {
    /// ☗ 将棋, for the chat's game cards (nil = this member does not have it).
    @Entry var shogi: ShogiStore? = nil
}

struct ShogiScreen: View {
    let shogi: ShogiStore

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            // In a game the note takes the game's bar for its 3 s (no extra line).
            if let n = shogi.notice, shogi.selected == nil {
                HStack(alignment: .top, spacing: 4) {
                    Text(n).font(.caption).foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Button { shogi.notice = nil } label: { Image(systemName: "xmark").font(.caption2) }
                        .buttonStyle(.borderless)
                        .accessibilityLabel("お知らせを閉じる")
                }
            }
            if let g = shogi.selected {
                if g.status == "open" || g.status == "offered" {
                    ShogiOfferView(shogi: shogi, game: g)
                } else {
                    ShogiGameView(shogi: shogi, game: g)
                }
            } else if shogi.selectedId != nil {
                Text("読み込み中…").font(.callout).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity).padding(.vertical, 20)
            } else {
                // As tall as it needs; it scrolls only if it would pass half the chat.
                ViewThatFits(in: .vertical) {
                    ShogiLobby(shogi: shogi)
                    ScrollView { ShogiLobby(shogi: shogi) }
                }
                .frame(maxHeight: shogi.areaHeight > 0 ? shogi.areaHeight * 0.5 : 360, alignment: .top)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 2)
        .padding(.bottom, 2)
    }
}

// MARK: - Lobby

/// Two buttons when nothing is on (drikin 2026-10-21「はやい、遅いも要らない」「シンプルなデザインに」:
/// fast games only); while the site's one game is open / offered / on, that game on one line
/// with its button. Same as the web's Lobby (src/components/shogi/ShogiPanel.tsx).
private struct ShogiLobby: View {
    let shogi: ShogiStore

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let g = shogi.currentGame {
                ShogiCurrentGame(shogi: shogi, game: g)
            } else if shogi.canPlay {
                HStack(spacing: 8) {
                    Button("対局を募集") { Task { await shogi.create(mode: "blitz") } }
                        .buttonStyle(.borderedProminent).tint(Color.accentGreen)
                    if shogi.beagle {
                        Button("🐶 ビーグルと対局") { Task { await shogi.startBeagle(mode: "blitz") } }
                            .buttonStyle(.bordered).tint(.orange)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            } else {
                Text("対局はありません").font(.caption).foregroundStyle(.secondary)
            }
        }
        .controlSize(.small)
        .disabled(shogi.busy)
    }
}

/// The site's one game on one line: 「対局中 ☗A vs ☖B 12手 [指す/観戦]」 or 「募集中 A さん [受ける]」.
private struct ShogiCurrentGame: View {
    let shogi: ShogiStore
    let game: ShogiGame

    var body: some View {
        let g = game
        let me = shogi.me
        let mine = me != nil && g.creator?.userId == me
        HStack(spacing: 8) {
            Group {
                if g.isActive {
                    Text("対局中 ").foregroundStyle(.secondary) + Text("\(g.playersText) \(g.ply)手")
                } else if g.status == "offered" {
                    Text("申し込み中 ").foregroundStyle(.secondary) + Text("\(g.creator?.name ?? "?") → \(g.invitee?.name ?? "?")")
                } else {
                    Text("募集中 ").foregroundStyle(.secondary) + Text(mine ? "あなた" : "\(g.creator?.name ?? "?") さん")
                }
            }
            .font(.callout)
            .lineLimit(1)
            .frame(maxWidth: .infinity, alignment: .leading)
            if g.isActive {
                Button(shogi.myColor(in: g) != nil ? "指す" : "観戦") { shogi.select(g.id) }
                    .buttonStyle(.borderedProminent).tint(Color.accentGreen)
            } else if mine {
                if shogi.selfPlay, g.status == "open" {
                    Button("自分と指す（テスト）") { Task { await shogi.accept(g.id) } }.buttonStyle(.bordered)
                }
                Button("取り下げる") { Task { await shogi.cancel(g.id) } }.buttonStyle(.bordered)
            } else if shogi.canPlay, g.status == "open" || g.invitee?.userId == me {
                Button("受ける") { Task { await shogi.accept(g.id) } }
                    .buttonStyle(.borderedProminent).tint(Color.accentGreen)
                if g.status == "offered" { Button("断る") { Task { await shogi.decline(g.id) } }.buttonStyle(.bordered) }
            }
        }
        .controlSize(.small)
        .lineLimit(1)
        .padding(.vertical, 4)
    }
}

/// An open / offered game opened from a notification: the same one line, and back to the lobby.
private struct ShogiOfferView: View {
    let shogi: ShogiStore
    let game: ShogiGame

    var body: some View {
        HStack(spacing: 6) {
            Button { shogi.select(nil) } label: {
                Image(systemName: "chevron.backward").font(.system(size: 12, weight: .semibold))
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("ロビーへ")
            ShogiCurrentGame(shogi: shogi, game: game)
        }
    }
}

// MARK: - A game

struct ShogiGameView: View {
    let shogi: ShogiStore
    let game: ShogiGame
    @Environment(\.colorScheme) private var scheme
    @Environment(\.screenVisibility) private var visibility
    @State private var boardHeight: CGFloat = 0
    @State private var confirmResign = false

    private var g: ShogiGame { game }
    private var my: ShogiSide? { shogi.myColor(in: g) }
    private var onScreen: Bool { visibility?.room ?? true }

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            bar
            // Exactly as tall as the board says it is (no room above or below). Its size comes
            // from the width; past half the chat it is told to shrink (max_height).
            board(maxHeight: boardMax)
            if g.isEnded { endBanner }
        }
        // 観戦中の合図 (30 s) while this game is on screen and I only watch.
        .task(id: "\(g.id)|\(g.isActive)|\(my == nil)|\(onScreen)") {
            guard g.isActive, my == nil, onScreen else { return }
            while !Task.isCancelled {
                await shogi.watch(g.id)
                try? await Task.sleep(for: .seconds(30))
            }
        }
        .alert("投了しますか？", isPresented: $confirmResign) {
            Button("投了する", role: .destructive) { Task { await shogi.resign(g.id) } }
            Button("やめる", role: .cancel) {}
        } message: {
            Text("この対局は負けになります。")
        }
    }

    // MARK: The bar: mode, moves, watchers, whose move, ⋯

    private var status: String {
        var s = "\(g.ply) 手"
        // The board's own band (last move, ⇅) is hidden to give the squares its height: the
        // last move is said here, ⇅ is in ⋯.
        if let lm = g.lastMove { s += "・\(lm.label)" }
        if let n = g.spectators, n > 0 { s += "・👀\(n)" }
        if g.isActive, let my {
            s += g.turnSide == my ? "・あなたの番" : (g.beagleSide == g.turnSide ? "・ビーグルが考え中…🐶" : "・相手の番")
        }
        if g.isActive, my == nil { s += "・\(g.turnSide.mark)の番" }
        return s
    }

    private var bar: some View {
        HStack(spacing: 6) {
            Button { shogi.select(nil) } label: {
                Image(systemName: "chevron.backward").font(.system(size: 12, weight: .semibold))
                    .frame(width: 22, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.borderless)
            .help("ロビーへ")
            .accessibilityLabel("ロビーへ")
            Group {
                if let n = shogi.notice {
                    // A note (3 s) in place of the status, so it adds no line.
                    Text(n).font(.caption).foregroundStyle(.orange)
                        .onTapGesture { shogi.notice = nil }
                } else {
                    Text(status)
                        .font(.caption.weight(g.isActive && my == g.turnSide ? .semibold : .regular))
                        .foregroundStyle(g.isActive && my == g.turnSide ? Color.accentGreen : Color.secondary)
                }
            }
            .lineLimit(1)
            .minimumScaleFactor(0.85)
            .frame(maxWidth: .infinity, alignment: .leading)
            Menu {
                if g.isActive, my != nil, shogi.canPlay {
                    if g.ply < 2 {
                        Button("取り消す（中断）", systemImage: "arrow.uturn.backward") { Task { await shogi.cancel(g.id) } }
                    }
                    Button("投了…", systemImage: "flag", role: .destructive) { confirmResign = true }
                    Divider()
                    Toggle("指す前に確認", isOn: Binding(get: { shogi.confirmMove }, set: { shogi.confirmMove = $0 }))
                    Toggle("駒の動きヒント", isOn: Binding(get: { shogi.moveHints }, set: { shogi.moveHints = $0 }))
                    Divider()
                }
                Button("盤を反転", systemImage: "arrow.up.arrow.down") {
                    shogi.setOrientation(shogi.orientation(for: g).other, for: g.id)
                }
                Button("ロビーへ", systemImage: "list.bullet") { shogi.select(nil) }
            } label: {
                Image(systemName: "ellipsis.circle").font(.system(size: 15))
            }
            .menuIndicator(.hidden)
            #if os(macOS)
            .menuStyle(.borderlessButton)
            #endif
            .fixedSize()
            .accessibilityLabel("対局のメニュー")
        }
        .frame(minHeight: 22)
    }

    // MARK: The board

    /// I am playing this game (the big board); watching gets the compact one.
    private var playing: Bool { my != nil && g.isActive }

    /// The board's height limit: under half the chat column (45 %), less this bar (and the end's buttons).
    private var boardMax: CGFloat? {
        guard shogi.areaHeight > 0 else { return nil }
        return max(220, shogi.areaHeight * 0.45 - 26 - (g.isEnded ? 50 : 0))
    }

    private func board(maxHeight: CGFloat?) -> some View {
        let blitzLive = g.isActive && g.isBlitz && onScreen
        return TimelineView(.periodic(from: .now, by: blitzLive ? 1 : 3600)) { ctx in
            let state = stateMessage(at: ctx.date, maxHeight: maxHeight)
            ShogiBoardWebView(
                url: boardURL,
                state: Self.json(state),
                stateKey: Self.json(state, excludingLabels: true),
                revision: shogi.moveRevision,
                labels: labelsJSON(at: ctx.date),
                onMove: { usi, label in Task { await shogi.play(usi: usi, label: label) } },
                onFlip: { o in shogi.setOrientation(o, for: g.id) },
                height: $boardHeight
            )
        }
        .frame(height: boardHeight > 0 ? boardHeight : (maxHeight ?? 360))
        .frame(maxWidth: playing ? 520 : 440)
        .frame(maxWidth: .infinity)
        .accessibilityLabel("将棋盤")
    }

    private var boardURL: URL {
        var c = URLComponents(url: shogi.boardURL, resolvingAgainstBaseURL: false)
        c?.queryItems = [URLQueryItem(name: "theme", value: scheme == .dark ? "dark" : "light")]
        return c?.url ?? shogi.boardURL
    }

    private func label(_ side: ShogiSide, at now: Date) -> String {
        let name = g.player(side)?.name ?? "?"
        let turn = g.isActive && g.turnSide == side
        guard let c = ShogiClockNow.of(g, skew: shogi.skew, now: now) else {
            return name + (turn ? "（手番）" : "")
        }
        let main = side == .black ? c.black : c.white
        let byo = turn && c.byoyomi != nil ? " 秒読み \(Int((Double(c.byoyomi ?? 0) / 1000).rounded(.up)))" : ""
        let t = g.isActive && g.ply < 2 ? ShogiClockNow.format(g.clocks?.initialMs ?? main) : ShogiClockNow.format(main)
        return "\(name) \(t)\(byo)\(turn ? " ●" : "")"
    }

    private func labels(at now: Date) -> (top: String, bottom: String) {
        let bottom = shogi.orientation(for: g)
        return (label(bottom.other, at: now), label(bottom, at: now))
    }

    private func stateMessage(at now: Date, maxHeight: CGFloat?) -> [String: Any] {
        let l = labels(at: now)
        var m: [String: Any] = [
            "type": "state",
            "sfen": g.sfen,
            "my_color": my?.rawValue ?? NSNull(),
            "can_move": shogi.canMove(in: g),
            "last_move": g.lastMove.map { ["usi": $0.usi, "label": $0.label] as [String: Any] } ?? NSNull(),
            "orientation": shogi.orientation(for: g).rawValue,
            "settings": ["confirm_move": shogi.confirmMove, "move_hints": shogi.moveHints],
            "compact": !playing,
            "theme": scheme == .dark ? "dark" : "light",
            "show_close": false,
            "hide_band": true,
            // The whole board (hands and bands too) fits this height (− the page's 12 px padding).
        ]
        // The whole board (hands and labels too) within this height (− the page's 12 px padding).
        if let maxHeight { m["max_height"] = max(160, Int(maxHeight) - 12) }
        // The clocks change every second: the state itself is compared without them.
        m["top_label"] = l.top
        m["bottom_label"] = l.bottom
        return m
    }

    private func labelsJSON(at now: Date) -> String {
        let l = labels(at: now)
        return Self.json(["type": "labels", "top_label": l.top, "bottom_label": l.bottom])
    }

    static func json(_ m: [String: Any], excludingLabels: Bool = false) -> String {
        var m = m
        if excludingLabels { m["top_label"] = nil; m["bottom_label"] = nil }
        guard let d = try? JSONSerialization.data(withJSONObject: m, options: [.sortedKeys]) else { return "{}" }
        return String(decoding: d, as: UTF8.self)
    }

    // MARK: The end

    private var endBanner: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(g.resultText).font(.caption.weight(.semibold)).lineLimit(1)
            HStack(spacing: 8) {
                if my != nil, shogi.canPlay {
                    if g.isBeagleGame {
                        Button("🐶 もう一局（先後交代）") { Task { await shogi.startBeagle(mode: "blitz", rematchOf: g.id) } }
                            .buttonStyle(.borderedProminent).tint(Color.accentGreen)
                    } else {
                        Button("再戦を申し込む（先後交代）") { Task { await shogi.create(mode: "blitz", rematchOf: g.id) } }
                            .buttonStyle(.borderedProminent).tint(Color.accentGreen)
                    }
                }
                Button("閉じる") { shogi.select(nil) }.buttonStyle(.bordered)
            }
            .controlSize(.small)
            .lineLimit(1)
            .disabled(shogi.busy)
        }
        .padding(.vertical, 2)
    }
}

// MARK: - The chat's game card

/// kind "shogi" in the chat: a small picture of the board (dots only) and 「観戦する」.
/// Redrawn from the game's `shogi` events (the message itself is not rewritten per move).
struct ShogiChatCard: View {
    let shogi: ShogiStore
    let gameId: Int
    let body_: String

    var body: some View {
        let g = shogi.games.first { $0.id == gameId }
        if let g, g.isActive {
            // 「☗A vs ☖B 対局中 ⚡ 12手 [観戦]」 — one line, redrawn by the game's events.
            HStack(spacing: 8) {
                Text("\(g.playersText) 対局中 \(g.ply)手\(g.lastMove.map { " \($0.label)" } ?? "")")
                    .font(.caption)
                    .lineLimit(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Button(shogi.myColor(in: g) != nil ? "盤を開く" : "観戦") { shogi.openGame(gameId) }
                    .buttonStyle(.bordered)
                    .tint(Color.accentGreen)
                    .controlSize(.mini)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 5)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color.accentGreen.opacity(0.07)))
            .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(Color.accentGreen.opacity(0.4)))
            .accessibilityElement(children: .combine)
        } else {
            // Over (or not known here): the result only, one small line; a tap shows the board.
            Text(g.map { $0.isEnded ? "\($0.playersText) \($0.resultText)" : body_ } ?? body_)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(maxWidth: .infinity)
                .contentShape(Rectangle())
                .onTapGesture { shogi.openGame(gameId) }
                .accessibilityAddTraits(.isButton)
        }
    }
}

/// 9×9 dots (black's pieces dark, white's light) — no letters at 96 pt.
struct ShogiMiniBoard: View {
    let sfen: String
    var size: CGFloat = 96

    var body: some View {
        let cells = Self.cells(sfen)
        Canvas { ctx, sz in
            let c = sz.width / 9
            ctx.fill(Path(roundedRect: CGRect(origin: .zero, size: sz), cornerRadius: 4), with: .color(Color(red: 0.914, green: 0.788, blue: 0.541)))
            for (i, v) in cells.prefix(81).enumerated() where v != 0 {
                let r = CGRect(x: CGFloat(i % 9) * c + c * 0.14, y: CGFloat(i / 9) * c + c * 0.14, width: c * 0.72, height: c * 0.72)
                if v == 1 {
                    ctx.fill(Path(ellipseIn: r), with: .color(Color(red: 0.169, green: 0.114, blue: 0.055)))
                } else {
                    ctx.fill(Path(ellipseIn: r), with: .color(Color(red: 1, green: 0.973, blue: 0.902)))
                    ctx.stroke(Path(ellipseIn: r), with: .color(Color(red: 0.541, green: 0.416, blue: 0.212)), lineWidth: 0.8)
                }
            }
        }
        .frame(width: size, height: size)
        .accessibilityLabel("盤の様子")
    }

    /// 0 empty, 1 black, 2 white, row by row from rank a.
    static func cells(_ sfen: String) -> [UInt8] {
        var out: [UInt8] = []
        let board = sfen.split(separator: " ").first ?? ""
        for ch in board where ch != "/" && ch != "+" {
            if let n = ch.wholeNumberValue { out += Array(repeating: 0, count: n) }
            else { out.append(ch.isUppercase ? 1 : 2) }
        }
        return out
    }
}

/// The ☗ 将棋 screen folded to one line (iPhone, while the keyboard is up): the game's state
/// and a way back to the board.
struct ShogiFoldedBar: View {
    let shogi: ShogiStore
    let onUnfold: () -> Void

    var body: some View {
        Button(action: onUnfold) {
            HStack(spacing: 6) {
                Text(summary).font(.caption).lineLimit(1)
                Spacer(minLength: 0)
                Text("盤を表示").font(.caption.weight(.semibold)).foregroundStyle(Color.accentGreen)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 7)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var summary: String {
        guard let g = shogi.selected else { return "ロビー" + (shogi.offersToMe.isEmpty ? "" : "・申し込み \(shogi.offersToMe.count) 件") }
        var s = "\(g.playersText)・\(g.ply) 手"
        if let lm = g.lastMove { s += "・\(lm.label)" }
        if g.isEnded { s += "・終局" }
        else if g.isActive, let my = shogi.myColor(in: g) { s += g.turnSide == my ? "・あなたの番" : "・相手の番" }
        return s
    }
}
