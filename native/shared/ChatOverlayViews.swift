import SwiftUI

// MARK: - チャットの上に機能を重ねる形: the switch row, the chips, the windows (docs/chat-overlay-spec.md)
//
// Everything here draws the registry in OverlayModel; the feature panels themselves (ShogiScreen, OffkaiScreen,
// MinigameScreen, WatchDockView, RoomView) are reused as the expanded windows' contents.

/// The orange "going on now" dot — the same mark on every platform.
private let overlayLiveColor = Color(red: 0xea / 255, green: 0x58 / 255, blue: 0x0c / 255)
private let overlayOffkaiInk = Color(red: 0x9a / 255, green: 0x34 / 255, blue: 0x12 / 255)
private let overlayOffkaiBorder = Color(red: 0xf3 / 255, green: 0xd3 / 255, blue: 0xb6 / 255)
private let overlayOffkaiFill = Color(red: 0xff / 255, green: 0xf3 / 255, blue: 0xe8 / 255)

/// The chat's second row: one switch per feature that is on for this member (🏠🎧n ・ ☗ ・ 🎮 ・ 📺 ・ 🍻), and the
/// chips (while typing, or for a sound that goes on with its switch off). Never wider than the column: it
/// scrolls sideways when it does not fit (the narrowest phones, the largest text).
struct OverlaySwitchRow: View {
    let overlay: OverlayModel
    /// Mac's panel header: smaller switches.
    var compact = false
    /// A chip tapped (the caller also drops the keyboard).
    var onChip: (ActivityID) -> Void

    var body: some View {
        ViewThatFits(in: .horizontal) {
            row
            ScrollView(.horizontal, showsIndicators: false) { row }
        }
    }

    private var row: some View {
        HStack(spacing: compact ? 4 : 8) {
            let chips = overlay.chipsInExpanded ? [] : overlay.chipIDs
            // Typing: the chips first (what was open stays one tap away), then the switches.
            if overlay.typing {
                ForEach(chips, id: \.self) { id in OverlayChip(overlay: overlay, id: id, compact: compact) { onChip(id) } }
            }
            ForEach(overlay.available, id: \.self) { id in
                OverlaySwitchButton(overlay: overlay, id: id, compact: compact)
            }
            if !overlay.typing {
                ForEach(chips, id: \.self) { id in OverlayChip(overlay: overlay, id: id, compact: compact) { onChip(id) } }
            }
        }
        .fixedSize()
        .animation(.easeOut(duration: 0.15), value: overlay.typing)
    }
}

/// One switch: on = green border on a pale green ground; the orange dot while it is going on.
struct OverlaySwitchButton: View {
    let overlay: OverlayModel
    let id: ActivityID
    var compact = false

    var body: some View {
        let d = OverlayModel.descriptor(id)
        let on = overlay.isShown(id)
        let live = overlay.isLive(id)
        Button { overlay.toggle(id) } label: {
            HStack(spacing: 3) {
                Text(d.icon).font(.app(size: compact ? 12 : 15))
                if let badge = overlay.switchBadge(id) {
                    Text(badge).font(.app(size: compact ? 10 : 13)).foregroundStyle(.secondary).monospacedDigit()
                }
            }
            .padding(.horizontal, compact ? 7 : 12)
            .frame(minWidth: compact ? 30 : 44, minHeight: compact ? 22 : 36)
            .background(Capsule().fill(on ? Color.accentGreen.opacity(0.16) : Color.clear))
            .overlay(Capsule().strokeBorder(on ? Color.accentGreen : Color.primary.opacity(0.18), lineWidth: 1))
            .overlay(alignment: .topTrailing) {
                if live {
                    Circle().fill(overlayLiveColor)
                        .frame(width: compact ? 6 : 8, height: compact ? 6 : 8)
                        .offset(x: compact ? -3 : -5, y: compact ? 2 : 4)
                }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .help(d.label + (live ? "（いま動いています）" : ""))
        .accessibilityLabel(d.label + (live ? "、いま動いています" : ""))
        .accessibilityValue(on ? "表示中" : "")
        .accessibilityAddTraits(on ? .isSelected : [])
    }
}

/// A round chip: a window shrunk (another is expanded, or the member is typing), or a sound that goes on.
/// Tap: that one comes back, expanded.
struct OverlayChip: View {
    let overlay: OverlayModel
    let id: ActivityID
    var compact = false
    let action: () -> Void

    var body: some View {
        let text = overlay.chipText(id)
        Button(action: action) {
            Text(text)
                .font(.app(size: compact ? 11 : 12, weight: .medium))
                .lineLimit(1)
                .foregroundStyle(ink)
                .padding(.horizontal, compact ? 8 : 10)
                .frame(height: compact ? 22 : 28)
                .background(Capsule().fill(fill))
                .overlay(Capsule().strokeBorder(border, lineWidth: 1))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize()
        .help(text)
        .accessibilityLabel(text + "（タップで広げる）")
    }

    private var ink: Color {
        switch id {
        case .watch: return Color(white: 0.92)
        case .offkai: return overlayOffkaiInk
        default: return .secondary
        }
    }
    private var fill: Color {
        switch id {
        case .watch: return Color(red: 0x0f / 255, green: 0x14 / 255, blue: 0x11 / 255)
        case .offkai: return overlayOffkaiFill
        default: return .clear
        }
    }
    private var border: Color {
        switch id {
        case .watch: return .clear
        case .offkai: return overlayOffkaiBorder
        default: return Color.primary.opacity(0.18)
        }
    }
}

/// The windows over the chat's messages: the small ones (dragged anywhere inside, remembered), or the one
/// expanded across the top with the others' chips. Taps elsewhere reach the chat below.
struct ChatOverlayLayer: View {
    let store: ChatStore
    var onChip: (ActivityID) -> Void

    private var overlay: OverlayModel { store.overlay }
    @State private var sizes: [ActivityID: CGSize] = [:]
    @State private var dragging: (id: ActivityID, by: CGSize)?

    #if os(iOS)
    /// iPhone: 📺's small window is the floating player (MainView draws it over every page).
    private let watchHasOwnWindow = true
    #else
    private let watchHasOwnWindow = false
    #endif

    private static let miniWidth: CGFloat = 188

    var body: some View {
        GeometryReader { g in
            ZStack(alignment: .topLeading) {
                Color.clear.allowsHitTesting(false)
                // 📺 elsewhere: the iPhone's floating player, or the Mac's own window (⧉).
                let minis = overlay.miniIDs.filter { !($0 == .watch && (watchHasOwnWindow || overlay.watchInOwnWindow)) }
                ForEach(Array(minis.enumerated()), id: \.element) { i, id in
                    let p = place(id, slot: i, in: g.size, all: minis)
                    OverlayMiniWindow(overlay: overlay, id: id)
                        .frame(width: Self.miniWidth)
                        .onGeometryChange(for: CGSize.self) { $0.size } action: { s in sizes[id] = s }
                        .offset(x: p.x, y: p.y)
                        .gesture(
                            DragGesture(minimumDistance: 8, coordinateSpace: .named("chatOverlay"))
                                .onChanged { v in dragging = (id, v.translation) }
                                .onEnded { v in
                                    let base = place(id, slot: i, in: g.size, all: minis, ignoringDrag: true)
                                    let to = clamp(CGPoint(x: base.x + v.translation.width, y: base.y + v.translation.height), id, in: g.size)
                                    overlay.move(id, to: to)
                                    dragging = nil
                                }
                        )
                        .transition(.scale(scale: 0.85, anchor: .top).combined(with: .opacity))
                }
                if let e = overlay.expandedNow, !overlay.typing, !(e == .watch && overlay.watchInOwnWindow) {
                    OverlayExpandedWindow(store: store, id: e, onChip: onChip)
                        .frame(width: g.size.width)
                        .frame(maxHeight: g.size.height * 0.8, alignment: .top)
                        .transition(.move(edge: .top).combined(with: .opacity))
                }
                // 📺 kept playing while it is only a chip (typing / another expanded / switched off with the sound on).
                if watchNeedsKeepAlive {
                    WatchPlayerHost(watch: store.watch)
                        .frame(width: 2, height: 2)
                        .opacity(0.01)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
            .coordinateSpace(name: "chatOverlay")
        }
        .animation(.spring(response: 0.3, dampingFraction: 0.88), value: overlay.expandedNow)
        .animation(.easeOut(duration: 0.18), value: overlay.miniIDs)
    }

    /// The player is shown nowhere else (no floating window, no small or expanded window) but is still open.
    private var watchNeedsKeepAlive: Bool {
        let w = store.watch
        guard overlay.enabled, w.open, w.controller != nil else { return false }
        if overlay.expandedNow == .watch && !overlay.typing { return false }
        #if os(iOS)
        if w.mode == .floating && overlay.watchFloats { return false }
        return true
        #else
        guard w.mode == .docked else { return false } // in its own window (⧉)
        return !overlay.miniIDs.contains(.watch)
        #endif
    }

    /// Where a small window sits: its remembered place (or a default slot — right, left, then a row lower),
    /// moved by a drag in progress, kept inside the chat.
    private func place(_ id: ActivityID, slot: Int, in size: CGSize, all: [ActivityID], ignoringDrag: Bool = false) -> CGPoint {
        let w = Self.miniWidth
        // iPhone with 📺 floating (top-left by default): the others stack down the right; otherwise right, left,
        // right… each column stacked by the heights above it.
        let oneColumn = watchHasOwnWindow && overlay.miniIDs.contains(.watch)
        let column = { (k: Int) in oneColumn ? 0 : k % 2 }
        let above = all.prefix(slot).enumerated().filter { column($0.offset) == column(slot) }
            .reduce(CGFloat(0)) { $0 + (sizes[$1.element]?.height ?? 120) + 10 }
        // …and below the floating 📺 when the two would not fit side by side.
        let belowWatch = oneColumn && OverlayModel.floatingWatchWidth + 8 + w + 16 > size.width
            ? OverlayModel.floatingWatchHeight + 8 : 0
        let base = overlay.positions[id] ?? CGPoint(x: column(slot) == 0 ? size.width - w - 10 : 10, y: 10 + belowWatch + above)
        var p = base
        if !ignoringDrag, let d = dragging, d.id == id { p.x += d.by.width; p.y += d.by.height }
        return clamp(p, id, in: size)
    }

    private func clamp(_ p: CGPoint, _ id: ActivityID, in size: CGSize) -> CGPoint {
        let w = Self.miniWidth, h = sizes[id]?.height ?? 120
        return CGPoint(x: min(max(6, p.x), max(6, size.width - w - 6)),
                       y: min(max(6, p.y), max(6, size.height - h - 6)))
    }
}

// MARK: - Small windows

/// A small window: the feature's title, ⤢ (expand), and what is worth seeing at a glance.
private struct OverlayMiniWindow: View {
    let overlay: OverlayModel
    let id: ActivityID

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            switch id {
            case .room: OverlayRoomMini(overlay: overlay)
            case .shogi: OverlayShogiMini(overlay: overlay)
            case .game: OverlayGameMini(overlay: overlay)
            case .watch: OverlayWatchMini(overlay: overlay)
            case .offkai: OverlayOffkaiMini(overlay: overlay)
            }
        }
        .padding(id == .watch ? 0 : 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 14).fill(id == .watch ? Color.black : Color.overlayCard))
        .overlay(RoundedRectangle(cornerRadius: 14).strokeBorder(id == .offkai ? overlayOffkaiBorder : Color.primary.opacity(0.1), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 14))
        .shadow(color: .black.opacity(0.18), radius: 12, y: 6)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(OverlayModel.descriptor(id).label + "（小さな窓）")
    }
}

/// Title + ⤢.
private struct OverlayMiniHeader: View {
    let overlay: OverlayModel
    let id: ActivityID
    let title: String
    var dark = false

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.app(size: 13, weight: .bold)).lineLimit(1)
                .foregroundStyle(dark ? Color(white: 0.92) : Color.primary)
            Spacer(minLength: 4)
            Button { overlay.expand(id) } label: {
                Text("⤢").font(.app(size: 14)).foregroundStyle(dark ? Color(white: 0.75) : Color.secondary)
                    .frame(width: 26, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("広げる")
            .accessibilityLabel("広げる")
        }
    }
}

private struct OverlayPill: View {
    let title: String
    var filled: Color? = nil
    var action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(title).font(.app(size: 12, weight: .bold))
                .lineLimit(1)
                .foregroundStyle(filled == nil ? Color.primary : Color.white)
                .padding(.horizontal, 10)
                .frame(maxWidth: .infinity, minHeight: 30)
                .background(Capsule().fill(filled ?? Color.clear))
                .overlay(Capsule().strokeBorder(filled == nil ? Color.primary.opacity(0.18) : Color.clear))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

/// 🏠: who is in the room's voice (talking: a green ring), 入る／出る and the mic.
private struct OverlayRoomMini: View {
    let overlay: OverlayModel
    private var room: RoomStore { overlay.room }

    var body: some View {
        let inVoice = room.inVoice
        let speaking = Set(room.voice.members.filter(\.speaking).map(\.userId))
        OverlayMiniHeader(overlay: overlay, id: .room, title: "🏠 部室" + (inVoice.isEmpty ? "" : " 🎧\(inVoice.count)"))
        if inVoice.isEmpty {
            Text("いまは誰もいません").font(.app(size: 12)).foregroundStyle(.secondary)
        } else {
            HStack(spacing: -4) {
                ForEach(inVoice.prefix(6)) { m in
                    Text(String(m.name.prefix(1)))
                        .font(.app(size: 11, weight: .semibold))
                        .frame(width: 24, height: 24)
                        .background(Circle().fill(Color.primary.opacity(0.08)))
                        .background(Circle().fill(Color.overlayCard).padding(-1.5))
                        .overlay(Circle().strokeBorder(speaking.contains(m.userId) ? Color.accentGreen : Color.clear, lineWidth: 2))
                        .accessibilityLabel(m.name + (speaking.contains(m.userId) ? "（話しています）" : ""))
                }
                if inVoice.count > 6 { Text(" +\(inVoice.count - 6)").font(.app(size: 11)).foregroundStyle(.secondary) }
            }
        }
        HStack(spacing: 6) {
            if room.mode == .room {
                OverlayPill(title: "出る") { Task { await room.toText() } }
                OverlayPill(title: room.voice.micOn ? "🎙 オン" : "🎙 オフ", filled: room.voice.micOn ? Color.accentGreen : nil) {
                    Task { await room.setMic(!room.voice.micOn) }
                }
                .disabled(room.voice.micBusy)
                #if os(macOS)
                if room.voice.inRoom { OverlayHandoffButton(handoff: room.voice.handoff, target: .room, mic: room.voice.micOn) }
                #endif
            } else {
                OverlayPill(title: "入る", filled: Color.accentGreen) { overlay.enterRoom() }
            }
        }
        #if os(macOS)
        if room.voice.inRoom { VoiceHandoffNotice(handoff: room.voice.handoff, target: .room, font: .app(size: 11)) }
        #endif
    }
}

#if os(macOS)
/// 「スマホで続ける」 in a small window: an icon in the 📷 button's shape (the pills fill the row).
private struct OverlayHandoffButton: View {
    let handoff: VoiceHandoff?
    let target: VoiceHandoff.Target
    let mic: Bool

    var body: some View {
        VoiceHandoffButton(handoff: handoff, target: target, mic: mic) {
            Image(systemName: "iphone").font(.app(size: 12)).frame(width: 36, height: 30)
                .overlay(Capsule().strokeBorder(Color.primary.opacity(0.18)))
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}
#endif

/// ☗: the game in one line (who, how many moves, whose turn), tap to see the board.
private struct OverlayShogiMini: View {
    let overlay: OverlayModel
    private var shogi: ShogiStore { overlay.shogi }

    var body: some View {
        OverlayMiniHeader(overlay: overlay, id: .shogi, title: "☗ 将棋")
        Button { overlay.expand(.shogi) } label: {
            VStack(alignment: .leading, spacing: 2) {
                if let g = shogi.selected ?? shogi.currentGame {
                    Text(g.playersText).font(.app(size: 12, weight: .semibold)).lineLimit(1)
                    Text(status(g)).font(.app(size: 12)).foregroundStyle(.secondary).lineLimit(1)
                } else {
                    Text("対局はありません").font(.app(size: 12)).foregroundStyle(.secondary)
                    if !shogi.offersToMe.isEmpty {
                        Text("申し込み \(shogi.offersToMe.count) 件").font(.app(size: 12, weight: .semibold)).foregroundStyle(overlayLiveColor)
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func status(_ g: ShogiGame) -> String {
        if g.isEnded { return "\(g.ply) 手・終局" }
        if g.status == "open" || g.status == "offered" { return "対局の申し込み中" }
        guard let my = shogi.myColor(in: g) else { return "\(g.ply) 手・観戦" }
        return "\(g.ply) 手・" + (g.turnSide == my ? "あなたの番" : "相手の番")
    }
}

/// 🎮: today's best only; 遊ぶ expands it (too small to play otherwise).
private struct OverlayGameMini: View {
    let overlay: OverlayModel
    @State private var best: Int?

    var body: some View {
        OverlayMiniHeader(overlay: overlay, id: .game, title: "🎮 散財ダッシュ")
        Text(best.map { "今日のベスト \($0)" } ?? "今日のベスト —").font(.app(size: 12)).foregroundStyle(.secondary).monospacedDigit()
        OverlayPill(title: "▶ 遊ぶ", filled: Color.accentGreen) { overlay.expand(.game) }
            .task {
                let (status, obj) = await overlay.minigame.me()
                guard status == 200, let b = obj["best"] as? [String: Any], let today = b["today"] as? [String: Any] else { return }
                best = (today["score"] as? NSNumber)?.intValue
            }
    }
}

/// 🍻: the title, who is talking and how many listen, 「🔊 聞く」 and 📷 (expands to send photos).
private struct OverlayOffkaiMini: View {
    let overlay: OverlayModel
    private var offkai: OffkaiStore { overlay.offkai }

    var body: some View {
        OverlayMiniHeader(overlay: overlay, id: .offkai, title: "🍻 " + (offkai.running?.displayTitle ?? "オフ会"))
        if let e = offkai.running {
            Text(e.speaker.map { "🎙 \($0.displayName) 話し中 · 🎧\(offkai.listeners)" } ?? "🎧\(offkai.listeners) 人が聞いています")
                .font(.app(size: 12)).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 6) {
                OverlayPill(title: offkai.audio == .off ? "🔊 聞く" : (offkai.audio == .connecting ? "つないでいます…" : "止める"),
                            filled: offkai.audio == .off ? overlayLiveColor : nil) {
                    Task { await offkai.toggleListen() }
                }
                .disabled(offkai.busy || offkai.iAmSpeaker)
                Button { overlay.expand(.offkai) } label: {
                    Text("📷").font(.app(size: 12)).frame(width: 36, height: 30)
                        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.18)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("写真（広げる）")
                #if os(macOS)
                if offkai.audio == .listening {
                    OverlayHandoffButton(handoff: offkai.handoff, target: .offkai, mic: offkai.speaking || offkai.iAmSpeaker)
                }
                #endif
            }
            OffkaiReadAloudToggle(offkai: offkai, font: .app(size: 12), compact: true)
            #if os(macOS)
            if offkai.audio != .off { VoiceHandoffNotice(handoff: offkai.handoff, target: .offkai, font: .app(size: 11)) }
            #endif
        } else {
            Text("いまは開かれていません").font(.app(size: 12)).foregroundStyle(.secondary)
            OverlayPill(title: "これまでのオフ会") { overlay.expand(.offkai) }
        }
    }
}

/// 📺 (Mac; the iPhone uses the floating player): the picture and its bar.
private struct OverlayWatchMini: View {
    let overlay: OverlayModel

    var body: some View {
        VStack(spacing: 0) {
            WatchPlayerHost(watch: overlay.watch)
                .aspectRatio(16 / 9, contentMode: .fit)
                .frame(maxWidth: .infinity)
                .frame(height: 188 * 9 / 16 + 40)
            OverlayMiniHeader(overlay: overlay, id: .watch, title: "📺 " + (overlay.watch.title ?? "みんなで見る"), dark: true)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
        }
    }
}

// MARK: - The expanded window

/// One feature across the top of the chat (iPhone: about half the height; Mac: most of the panel), with ⤡
/// and the other windows' chips.
private struct OverlayExpandedWindow: View {
    let store: ChatStore
    let id: ActivityID
    var onChip: (ActivityID) -> Void

    private var overlay: OverlayModel { store.overlay }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                let d = OverlayModel.descriptor(id)
                // ☗'s players already start with ☗.
                Text(title.hasPrefix(d.icon) ? title : "\(d.icon) \(title)").font(.app(size: 14, weight: .bold)).lineLimit(1)
                Spacer(minLength: 4)
                Button { overlay.collapse() } label: {
                    Text("⤡ 小さく").font(.app(size: 12))
                        .padding(.horizontal, 10).frame(height: 28)
                        .overlay(Capsule().strokeBorder(Color.primary.opacity(0.18)))
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("小さくする")
            }
            content
            let chips = overlay.chipIDs
            if !chips.isEmpty {
                ViewThatFits(in: .horizontal) {
                    chipRow(chips)
                    ScrollView(.horizontal, showsIndicators: false) { chipRow(chips) }
                }
                .frame(maxWidth: .infinity, alignment: .trailing)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.overlayCard)
        .overlay(alignment: .bottom) { Divider() }
        .shadow(color: .black.opacity(0.12), radius: 12, y: 8)
    }

    private func chipRow(_ chips: [ActivityID]) -> some View {
        HStack(spacing: 6) {
            ForEach(chips, id: \.self) { c in OverlayChip(overlay: overlay, id: c) { onChip(c) } }
        }
        .fixedSize()
    }

    private var title: String {
        switch id {
        case .shogi:
            if let g = store.shogi.selected { return "\(g.playersText) · \(g.ply) 手" }  // "☗a vs ☖b"

            return "将棋"
        case .offkai: return store.offkai.running?.displayTitle ?? "オフ会"
        case .watch: return store.watch.title ?? "みんなで見る"
        case .game: return "散財ダッシュ"
        case .room: return "部室"
        }
    }

    @ViewBuilder private var content: some View {
        switch id {
        case .shogi:
            ShogiScreen(shogi: store.shogi)
        case .offkai:
            OffkaiScreen(offkai: store.offkai)
        case .game:
            MinigameScreen(minigame: store.minigame)
        case .watch:
            WatchDockView(watch: store.watch)
        case .room:
            if store.room.mode == .room {
                RoomView(room: store.room)
                    .frame(height: max(220, (store.shogi.areaHeight > 0 ? store.shogi.areaHeight : 700) * 0.45))
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    OverlayRoomMini(overlay: overlay)
                    Text("部室に入ると、歩いて近くの人と話せます").font(.app(size: 12)).foregroundStyle(.secondary)
                }
                .frame(maxWidth: 360, alignment: .leading)
            }
        }
    }
}

extension Color {
    /// The windows' ground: white / the dark background.
    static var overlayCard: Color {
        #if os(iOS)
        Color(uiColor: .systemBackground)
        #else
        Color(nsColor: .windowBackgroundColor)
        #endif
    }
}
