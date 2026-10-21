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
    /// For 指名 (the chat's member list, loaded once per launch).
    let members: [MentionMember]

    /// The smallest the screen gets (tabs, the game's bar and the smallest whole board).
    static let minHeight: CGFloat = 410

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ShogiGameTabs(shogi: shogi)
            if let n = shogi.notice {
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
                ScrollView {
                    ShogiLobby(shogi: shogi, members: members)
                        .padding(.bottom, 6)
                }
                .scrollIndicators(.automatic)
            }
        }
        .padding(.horizontal, 10)
        .padding(.top, 4)
        .padding(.bottom, 4)
        .frame(maxHeight: .infinity, alignment: .top)
        // About half the chat, like the club room's map (the web: clamp(260px, 52%, 640px)):
        // the chat stays in view below, while watching and while playing. Never under 410 pt:
        // the board's smallest squares (22 px) with both hands and bands need ~350 of it.
        .containerRelativeFrame(.vertical) { h, _ in min(640, max(Self.minHeight, h * 0.52)) }
    }
}

/// ロビー ・ my games (● = my move) ・ the game I am watching.
private struct ShogiGameTabs: View {
    let shogi: ShogiStore

    var body: some View {
        HStack(spacing: 4) {
            chip("ロビー", selected: shogi.selectedId == nil, alert: shogi.offersToMe.count > 0) { shogi.select(nil) }
            ForEach(shogi.myActive.prefix(4)) { g in
                let my = shogi.myColor(in: g)
                let opp = my.flatMap { g.player($0.other) }
                chip("\(g.isBlitz ? "⚡" : "🐢")\(opp?.name ?? "?")", selected: shogi.selectedId == g.id,
                     alert: my == g.turnSide) { shogi.select(g.id) }
            }
            if let g = shogi.selected, shogi.myColor(in: g) == nil || !g.isActive, !shogi.myActive.contains(where: { $0.id == g.id }) {
                chip("\(g.isEnded ? "🎞" : "👀")\(g.black?.name ?? "?") vs \(g.white?.name ?? "?")", selected: true, alert: false) {}
            }
            Spacer(minLength: 0)
        }
        .lineLimit(1)
    }

    private func chip(_ text: String, selected: Bool, alert: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 3) {
                Text(text).font(.caption.weight(selected ? .semibold : .regular)).lineLimit(1)
                if alert { Circle().fill(Color.red).frame(width: 6, height: 6) }
            }
            .foregroundStyle(selected ? Color.white : Color.primary)
            .padding(.horizontal, 8)
            .frame(height: 22)
            .background(Capsule().fill(selected ? Color.accentGreen : Color.primary.opacity(0.07)))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityLabel(alert ? "\(text)、あなたの番か申し込みあり" : text)
    }
}

// MARK: - Lobby

private struct ShogiLobby: View {
    let shogi: ShogiStore
    let members: [MentionMember]
    @AppStorage("shogiLobbyMode") private var mode = "blitz"

    private var others: [MentionMember] {
        members.filter { $0.userId != shogi.me && $0.name != "ビーグル" }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if let g = shogi.currentGame {
                ShogiCurrentGame(shogi: shogi, game: g)
            } else if shogi.canPlay {
                section("対局を申し込む") {
                    Picker("持ち時間", selection: $mode) {
                        Text("⚡ 速い（10 分＋30 秒）").tag("blitz")
                        Text("🐢 ゆっくり").tag("slow")
                    }
                    .pickerStyle(.segmented)
                    .labelsHidden()
                    HStack(spacing: 8) {
                        Button("募集する") { Task { await shogi.create(mode: mode) } }
                            .buttonStyle(.borderedProminent)
                            .tint(Color.accentGreen)
                        Menu {
                            if others.isEmpty { Text("メンバーを読み込み中…") }
                            ForEach(others) { m in
                                Button(m.name) { Task { await shogi.create(mode: mode, invitee: m.userId) } }
                            }
                        } label: {
                            Label("相手を指名", systemImage: "person.crop.circle.badge.plus")
                        }
                        .fixedSize()
                    }
                    .disabled(shogi.busy)
                    .controlSize(.small)
                    Text("先後は振り駒。募集は 15 分、指名は 24 時間で期限切れ。ゆっくりは 72 時間指さないと負けです。")
                        .font(.caption2).foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if shogi.currentGame == nil, !shogi.offersToMe.isEmpty {
                section("届いた申し込み") {
                    ForEach(shogi.offersToMe) { g in
                        row {
                            Text("\(g.creator?.name ?? "?") さんから（\(g.modeLabel)\(g.rematchOf != nil ? "・再戦" : "")）").font(.callout)
                        } actions: {
                            Button("受ける") { Task { await shogi.accept(g.id) } }.buttonStyle(.borderedProminent).tint(Color.accentGreen)
                            Button("今はむり") { Task { await shogi.decline(g.id) } }.buttonStyle(.bordered)
                        }
                    }
                }
            }

            if shogi.currentGame == nil, !shogi.myPending.isEmpty {
                section("自分の申し込み") {
                    ForEach(shogi.myPending) { g in
                        row {
                            Text(g.status == "offered" ? "\(g.invitee?.name ?? "?") さんへ（\(g.modeLabel)）" : "募集中（\(g.modeLabel)）").font(.callout)
                        } actions: {
                            if shogi.selfPlay, g.status == "open" {
                                // Test only (server's self_play): take my own open game and play both sides.
                                Button("自分と指す（テスト）") { Task { await shogi.accept(g.id) } }.buttonStyle(.bordered)
                            }
                            Button("取り下げる") { Task { await shogi.cancel(g.id) } }.buttonStyle(.bordered)
                        }
                    }
                }
            }

            if shogi.currentGame == nil, !shogi.openByOthers.isEmpty {
                section("募集中") {
                    ForEach(shogi.openByOthers) { g in
                        row {
                            Text("\(g.creator?.name ?? "?") さん（\(g.modeLabel)）").font(.callout)
                        } actions: {
                            if shogi.canPlay {
                                Button("受ける") { Task { await shogi.accept(g.id) } }.buttonStyle(.borderedProminent).tint(Color.accentGreen)
                            }
                        }
                    }
                }
            }

            if shogi.currentGame == nil {
            section("対局中") {
                if shogi.activeGames.isEmpty {
                    Text("いまはありません").font(.caption).foregroundStyle(.secondary)
                }
                ForEach(shogi.activeGames) { g in
                    row {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(g.playersText).font(.callout)
                            Text("\(g.modeLabel)・\(g.ply) 手\((g.spectators ?? 0) > 0 ? "・👀\(g.spectators ?? 0)" : "")")
                                .font(.caption2).foregroundStyle(.secondary)
                        }
                    } actions: {
                        Button(shogi.myColor(in: g) != nil ? "指す" : "観戦") { shogi.select(g.id) }.buttonStyle(.bordered)
                    }
                }
            }

            }

            if !shogi.recentEnded.isEmpty {
                section("最近の結果") {
                    ForEach(shogi.recentEnded) { g in
                        row {
                            VStack(alignment: .leading, spacing: 1) {
                                Text(g.playersText).font(.callout)
                                Text(g.resultText).font(.caption2).foregroundStyle(.secondary)
                            }
                        } actions: {
                            Button("見る") { shogi.select(g.id) }.buttonStyle(.borderless)
                        }
                    }
                }
            }
        }
        .controlSize(.small)
        .disabled(shogi.busy)
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.caption.weight(.bold)).foregroundStyle(.secondary)
            content()
        }
    }

    private func row<L: View, A: View>(@ViewBuilder _ label: () -> L, @ViewBuilder actions: () -> A) -> some View {
        HStack(spacing: 6) {
            label().frame(maxWidth: .infinity, alignment: .leading).lineLimit(2)
            actions().lineLimit(1).fixedSize()
        }
    }
}

/// One game at a time: while one is open / offered / on, the lobby shows it big instead of
/// 「対局を申し込む」 (受ける / 観戦する / 指す).
private struct ShogiCurrentGame: View {
    let shogi: ShogiStore
    let game: ShogiGame

    var body: some View {
        let g = game
        let me = shogi.me
        let mine = shogi.myColor(in: g) != nil
        VStack(alignment: .leading, spacing: 8) {
            Text("対局は 1 局ずつです。募集中の対局を受けるか、対局中なら観戦してください。")
                .font(.caption).foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            HStack(alignment: .center, spacing: 10) {
                if g.isActive { ShogiMiniBoard(sfen: g.sfen, size: 72) }
                VStack(alignment: .leading, spacing: 3) {
                    if g.isActive {
                        Text(g.playersText).font(.callout.weight(.semibold))
                        Text("\(g.modeLabel)・\(g.ply) 手\((g.spectators ?? 0) > 0 ? "・👀\(g.spectators ?? 0)" : "")\(g.lastMove.map { "・\($0.label)" } ?? "")")
                            .font(.caption).foregroundStyle(.secondary)
                    } else if g.status == "offered" {
                        Text("\(g.creator?.name ?? "?") さん → \(g.invitee?.name ?? "?") さん（\(g.modeLabel)）").font(.callout.weight(.semibold))
                        Text("指名の返事を待っています").font(.caption).foregroundStyle(.secondary)
                    } else {
                        Text("\(g.creator?.name ?? "?") さんが募集中（\(g.modeLabel)）").font(.callout.weight(.semibold))
                    }
                    HStack(spacing: 8) {
                        if g.isActive {
                            Button(mine ? "指す" : "観戦する") { shogi.select(g.id) }
                                .buttonStyle(.borderedProminent).tint(Color.accentGreen)
                        } else if g.creator?.userId == me, me != nil {
                            if shogi.selfPlay, g.status == "open" {
                                Button("自分と指す（テスト）") { Task { await shogi.accept(g.id) } }.buttonStyle(.bordered)
                            }
                            Button("取り下げる") { Task { await shogi.cancel(g.id) } }.buttonStyle(.bordered)
                        } else if g.status == "open" || g.invitee?.userId == me, shogi.canPlay {
                            Button("受ける") { Task { await shogi.accept(g.id) } }
                                .buttonStyle(.borderedProminent).tint(Color.accentGreen)
                            if g.status == "offered" { Button("今はむり") { Task { await shogi.decline(g.id) } }.buttonStyle(.bordered) }
                        }
                    }
                    .lineLimit(1)
                    .controlSize(.small)
                    .disabled(shogi.busy)
                }
            }
            .padding(10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.04)))
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentGreen.opacity(0.45)))
        }
    }
}

/// An offer / open game that was opened from a notification or the tabs.
private struct ShogiOfferView: View {
    let shogi: ShogiStore
    let game: ShogiGame

    var body: some View {
        let toMe = game.invitee?.userId == shogi.me && shogi.me != nil
        let mine = game.creator?.userId == shogi.me && shogi.me != nil
        VStack(alignment: .leading, spacing: 8) {
            Text(mine ? (game.status == "offered" ? "\(game.invitee?.name ?? "?") さんへの申し込み（\(game.modeLabel)）" : "募集中（\(game.modeLabel)）")
                 : "\(game.creator?.name ?? "?") さんからの申し込み（\(game.modeLabel)）")
                .font(.callout)
            HStack(spacing: 8) {
                if (toMe || (!mine && game.status == "open")) && shogi.canPlay {
                    Button("受ける") { Task { await shogi.accept(game.id) } }.buttonStyle(.borderedProminent).tint(Color.accentGreen)
                }
                if toMe { Button("今はむり") { Task { await shogi.decline(game.id); shogi.select(nil) } }.buttonStyle(.bordered) }
                if mine { Button("取り下げる") { Task { await shogi.cancel(game.id) } }.buttonStyle(.bordered) }
                Button("ロビーへ") { shogi.select(nil) }.buttonStyle(.borderless)
            }
            .controlSize(.small)
            .disabled(shogi.busy)
        }
        .padding(.vertical, 6)
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
        VStack(alignment: .leading, spacing: 4) {
            bar
            // The board gets what is left: the page shrinks its squares to fit (max_height).
            GeometryReader { geo in
                board(maxHeight: geo.size.height)
                    .frame(width: geo.size.width, height: geo.size.height, alignment: .top)
            }
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
        var s = "\(g.modeLabel)・\(g.ply) 手"
        if let n = g.spectators, n > 0 { s += "・👀\(n)" }
        if g.isActive, let my { s += g.turnSide == my ? "・あなたの番" : "・相手の番" }
        if g.isActive, my == nil { s += "・\(g.turnSide.mark)の番" }
        return s
    }

    private var bar: some View {
        HStack(spacing: 6) {
            Text(status)
                .font(.caption.weight(g.isActive && my == g.turnSide ? .semibold : .regular))
                .foregroundStyle(g.isActive && my == g.turnSide ? Color.accentGreen : Color.secondary)
                .lineLimit(1)
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

    private func board(maxHeight: CGFloat) -> some View {
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
        .frame(height: min(maxHeight, boardHeight > 0 ? boardHeight : maxHeight))
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

    private func stateMessage(at now: Date, maxHeight: CGFloat) -> [String: Any] {
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
            // The whole board (hands and bands too) fits this height (− the page's 12 px padding).
            "max_height": max(160, Int(maxHeight) - 12),
        ]
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
        VStack(alignment: .leading, spacing: 6) {
            Text(g.resultText).font(.callout.weight(.semibold))
            HStack(spacing: 8) {
                if my != nil, shogi.canPlay {
                    Button("再戦を申し込む（先後交代）") { Task { await shogi.create(mode: g.mode, rematchOf: g.id) } }
                        .buttonStyle(.borderedProminent).tint(Color.accentGreen)
                }
                Button("閉じる") { shogi.select(nil) }.buttonStyle(.bordered)
            }
            .controlSize(.small)
            .disabled(shogi.busy)
        }
        .padding(.vertical, 4)
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
        HStack(alignment: .center, spacing: 10) {
            if let g { ShogiMiniBoard(sfen: g.sfen) }
            VStack(alignment: .leading, spacing: 3) {
                if let g, g.isActive {
                    Text("\(g.playersText)（\(g.modeLabel)）\(g.ply) 手目").font(.caption)
                    if let lm = g.lastMove {
                        Text("最後の手 \(lm.label)\((g.spectators ?? 0) > 0 ? "・👀\(g.spectators ?? 0)" : "")")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                } else {
                    Text(body_).font(.caption).fixedSize(horizontal: false, vertical: true)
                }
                Button(buttonTitle(g)) { shogi.openGame(gameId) }
                    .buttonStyle(.bordered)
                    .tint(Color.accentGreen)
                    .controlSize(.small)
            }
        }
        .padding(8)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.primary.opacity(0.04)))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.accentGreen.opacity(0.45)))
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .combine)
    }

    private func buttonTitle(_ g: ShogiGame?) -> String {
        guard let g, !g.isEnded else { return "盤で見る" }
        return shogi.myColor(in: g) != nil ? "盤を開く" : "観戦する"
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
