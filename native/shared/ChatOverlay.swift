import Foundation
import Observation
import SwiftUI

// MARK: - チャットの上に機能を重ねる形（docs/chat-overlay-spec.md）
//
// The chat's second row becomes switches only (🏠 ・ ☗ ・ 🎮 ・ 📺 ・ 🍻); a switch on puts that feature in a small
// window over the chat (the chat keeps its full height). ⤢ expands one (only one at a time); the others shrink to
// round chips. Typing shrinks every window to a chip. Off (capabilities `chat_overlay.enabled` false) the old row
// and panels stay exactly as they were — nothing here runs.
//
// The features keep their own logic and state in their stores; this file is the one place that knows
// the list of them (the registry) and which are shown / expanded / where.

/// One feature that can sit over the chat. The order is the switch row's order.
enum ActivityID: String, CaseIterable, Codable, Hashable, Sendable {
    case room, shogi, game, watch, offkai
}

/// What the switch row, the windows and the chips draw for one feature.
struct ActivityDescriptor {
    let id: ActivityID
    /// The switch's mark.
    let icon: String
    /// For VoiceOver and the expanded window's title.
    let label: String
}

/// Which features are over the chat, which one is expanded, where the small windows are, and whether the
/// member is typing. Bridges to each feature's store: a switch on is the store's open (`show()`), off its
/// close — so the features themselves, their sounds and their own rules stay where they are.
@MainActor
@Observable
final class OverlayModel {
    /// The server has it on for this member (capabilities `chat_overlay.enabled`).
    var enabled = false {
        didSet { if enabled != oldValue { syncWatch() } }
    }
    /// The club room's window (the room has no "open" of its own: entering it is a separate step).
    private(set) var roomShown = false
    /// 📺 switched off while a video plays: the player is kept (a chip) so the sound goes on.
    private(set) var watchHidden = false
    /// The one expanded window (only if it is shown — see `expandedNow`).
    private(set) var expanded: ActivityID? {
        didSet { if expanded != oldValue { syncWatch() } }
    }
    /// The composer has the focus: every window shrinks to a chip.
    var typing = false {
        didSet { if typing != oldValue { syncWatch() } }
    }
    /// Top-left of each small window inside the chat area (remembered on this device).
    private(set) var positions: [ActivityID: CGPoint] = OverlayModel.loadPositions()

    /// A switch or chip is opening a store: its willOpen must not expand it (only outside opens do).
    @ObservationIgnored private var quiet = false

    let room: RoomStore
    let shogi: ShogiStore
    let minigame: MinigameStore
    let watch: WatchStore
    let offkai: OffkaiStore

    init(room: RoomStore, shogi: ShogiStore, minigame: MinigameStore, watch: WatchStore, offkai: OffkaiStore) {
        self.room = room
        self.shogi = shogi
        self.minigame = minigame
        self.watch = watch
        self.offkai = offkai
    }

    // MARK: Registry

    static let descriptors: [ActivityID: ActivityDescriptor] = [
        .room: ActivityDescriptor(id: .room, icon: "🏠", label: "部室"),
        .shogi: ActivityDescriptor(id: .shogi, icon: "☗", label: "将棋"),
        .game: ActivityDescriptor(id: .game, icon: "🎮", label: "ゲーム"),
        .watch: ActivityDescriptor(id: .watch, icon: "📺", label: "みんなで見る"),
        .offkai: ActivityDescriptor(id: .offkai, icon: "🍻", label: "オフ会"),
    ]

    static func descriptor(_ id: ActivityID) -> ActivityDescriptor { descriptors[id]! }

    /// On for this member.
    func isAvailable(_ id: ActivityID) -> Bool {
        switch id {
        case .room: return room.enabled
        case .shogi: return shogi.enabled
        case .game: return minigame.enabled
        case .watch: return watch.enabled
        case .offkai: return offkai.enabled
        }
    }

    var available: [ActivityID] { ActivityID.allCases.filter(isAvailable) }
    var anyAvailable: Bool { !available.isEmpty }

    /// The switch is on (a window — small, expanded or shrunk to a chip while typing / another is expanded).
    func isShown(_ id: ActivityID) -> Bool {
        guard isAvailable(id) else { return false }
        switch id {
        case .room: return roomShown
        case .shogi: return shogi.open
        case .game: return minigame.open
        case .watch: return watch.open && !watchHidden
        case .offkai: return offkai.open
        }
    }

    /// Something is going on right now (the orange dot): ☗ a game in play, 🍻 one being held, 📺 a video on,
    /// 🏠 someone talking.
    func isLive(_ id: ActivityID) -> Bool {
        guard isAvailable(id) else { return false }
        switch id {
        case .room: return room.voice.members.contains { $0.speaking }
        case .shogi: return shogi.games.contains(where: \.isActive)
        case .game: return false
        case .watch: return watch.title != nil
        case .offkai: return offkai.running != nil
        }
    }

    /// Switched off, but its sound goes on (🍻 being listened to, 📺 playing, in the club room): a chip stays.
    func lingers(_ id: ActivityID) -> Bool {
        guard isAvailable(id), !isShown(id) else { return false }
        switch id {
        case .room: return room.mode == .room
        case .watch: return watch.open
        case .offkai: return offkai.audio != .off
        case .shogi, .game: return false
        }
    }

    /// The switch's extra text (🏠🎧5).
    func switchBadge(_ id: ActivityID) -> String? {
        guard id == .room else { return nil }
        let n = room.inVoice.count
        return n > 0 ? "🎧\(n)" : nil
    }

    /// A chip's words: 「📺 再生中」「🍻 mazzo 話し中 · 🔊」「☗ 6 手」.
    func chipText(_ id: ActivityID) -> String {
        switch id {
        case .room:
            let n = room.inVoice.count
            if room.mode == .room { return "🏠 部室にいます" + (n > 0 ? " · 🎧\(n)" : "") }
            return "🏠 部室" + (n > 0 ? " 🎧\(n)" : "")
        case .shogi:
            guard let g = shogi.selected ?? shogi.currentGame else { return "☗ 将棋" }
            var s = "☗ \(g.ply) 手"
            if g.isActive, let my = shogi.myColor(in: g) { s += g.turnSide == my ? " · あなたの番" : "" }
            return s
        case .game:
            return "🎮 散財ダッシュ"
        case .watch:
            if watch.playing { return "📺 再生中" }
            return watch.title != nil ? "📺 一時停止" : "📺 みんなで見る"
        case .offkai:
            let sound = offkai.audio == .listening ? " · 🔊" : ""
            if let s = offkai.running?.speaker { return "🍻 \(s.displayName) 話し中" + sound }
            if let e = offkai.running { return "🍻 \(e.displayTitle)" + sound }
            return "🍻 オフ会" + sound
        }
    }

    // MARK: Layout state

    var shownIDs: [ActivityID] { ActivityID.allCases.filter(isShown) }

    /// The expanded window, if it is still shown.
    var expandedNow: ActivityID? {
        guard enabled, let e = expanded, isShown(e) else { return nil }
        return e
    }

    /// The small windows on screen (none while typing or while one is expanded).
    var miniIDs: [ActivityID] {
        guard enabled, !typing, expandedNow == nil else { return [] }
        return shownIDs
    }

    /// The chips: while typing every window; while one is expanded the others; and those switched off whose
    /// sound goes on.
    var chipIDs: [ActivityID] {
        guard enabled else { return [] }
        let e = typing ? nil : expandedNow
        let windows = (typing || e != nil) ? shownIDs.filter { $0 != e } : []
        return windows + ActivityID.allCases.filter(lingers)
    }

    /// The chips sit in the expanded window (bottom-right); otherwise next to the switches.
    var chipsInExpanded: Bool { !typing && expandedNow != nil }

    // MARK: Actions

    /// A switch: on → a small window (🎮 starts expanded: too small to play otherwise); off → gone.
    func toggle(_ id: ActivityID) {
        if isShown(id) { hide(id) } else { show(id, expand: id == .game) }
    }

    func show(_ id: ActivityID, expand: Bool = false) {
        guard isAvailable(id) else { return }
        quiet = true
        defer { quiet = false }
        switch id {
        case .room: roomShown = true
        case .shogi: if !shogi.open { shogi.show() }
        case .game: if !minigame.open { minigame.show() }
        case .offkai: if !offkai.open { offkai.show() }
        case .watch:
            watchHidden = false
            if !watch.open { watch.show() }
        }
        if expand { expanded = id }
        syncWatch()
    }

    /// Off. The sound goes on (🍻 / the room stay a chip; a playing 📺 keeps its player as a chip).
    func hide(_ id: ActivityID) {
        if expanded == id { expanded = nil }
        switch id {
        case .room: roomShown = false
        case .shogi: shogi.close()
        case .game: minigame.close()
        case .offkai: offkai.close()
        case .watch:
            if watch.playing {
                watchHidden = true
            } else {
                watchHidden = false
                watch.close()
            }
        }
        syncWatch()
    }

    /// ⤢ or a chip: this one big, the others become chips.
    func expand(_ id: ActivityID) {
        if !isShown(id) { show(id, expand: true) } else { expanded = id }
    }

    /// ⤡: back to a small window.
    func collapse() { expanded = nil }

    /// The 🏠 window's 入る: into the room, and the window grows (walking is done big).
    func enterRoom() {
        Task { await room.enter() }
        expand(.room)
    }

    /// A store is opening (its willOpen): from outside the row (a push, a chat card, a link, the demo) it is
    /// switched on and expanded; from a switch it stays small.
    func storeWillOpen(_ id: ActivityID) {
        guard !quiet else { return }
        expanded = id
    }

    /// 📺 is opening from outside: from the timeline (floating) it stays small, from the chat it expands.
    func watchWillShow(floating: Bool) {
        guard enabled, !quiet else { return }
        watchHidden = false
        if !floating { expanded = .watch }
    }

    /// iPhone: the player is the floating window when small, docked (drawn in the expanded window) when big.
    /// Mac: the page is told to draw only the picture and its bar while small.
    func syncWatch() {
        guard enabled else {
            watch.compactOverride = nil
            return
        }
        let big = expanded == .watch && !typing && !watchHidden
        #if os(iOS)
        let want: WatchStore.Mode = big ? .docked : .floating
        if watch.mode != want { watch.setMode(want) }
        #else
        watch.compactOverride = !big
        #endif
    }

    /// iPhone: the chat page is the one on screen (iPad: always). Off it, a floating 📺 shows whatever the chat
    /// has expanded or the composer had (opened from the timeline, it must be seen there).
    var chatPageShown = true

    /// iPhone: may the floating player show now (a small window, nothing expanded, not typing — or another page).
    var watchFloats: Bool {
        guard enabled else { return true }
        if watchHidden { return false }
        if !chatPageShown { return true }
        return !typing && expandedNow == nil
    }

    /// iPhone: the small floating 📺's width — wide enough for the page's bar (seek, time, 🔊, ⧉: at 180 the ⧉
    /// fell off the edge) — and its height with the title bar, for placing the other windows below it.
    static let floatingWatchWidth: CGFloat = 236
    static var floatingWatchHeight: CGFloat { floatingWatchWidth * 9 / 16 + 44 + 26 }

    /// Mac: 📺 is in its own window (⧉): the overlay draws no player of its own (one web view, one place).
    var watchInOwnWindow: Bool {
        #if os(macOS)
        return watch.mode == .floating
        #else
        return false
        #endif
    }

    /// The player page's ⧉. iPhone: expand it over the chat (or back to small when it is the expanded one) —
    /// docking above the chat does not exist here. Mac: into its own window and back, the overlay steps aside.
    func watchPopout() -> Bool {
        guard enabled else { return false }
        #if os(iOS)
        if expandedNow == .watch { collapse() } else { expand(.watch) }
        #else
        let toWindow = watch.mode == .docked
        if toWindow && expanded == .watch { expanded = nil }
        watch.setMode(toWindow ? .floating : .docked)
        syncWatch()
        #endif
        return true
    }

    // MARK: Positions

    func move(_ id: ActivityID, to p: CGPoint) {
        positions[id] = p
        let dict = positions.reduce(into: [String: [Double]]()) { $0[$1.key.rawValue] = [Double($1.value.x), Double($1.value.y)] }
        UserDefaults.standard.set(dict, forKey: Self.positionsKey)
    }

    private static let positionsKey = "chatOverlayPositions"

    private static func loadPositions() -> [ActivityID: CGPoint] {
        guard let raw = UserDefaults.standard.dictionary(forKey: positionsKey) as? [String: [Double]] else { return [:] }
        var out: [ActivityID: CGPoint] = [:]
        for (k, v) in raw { if let id = ActivityID(rawValue: k), v.count == 2 { out[id] = CGPoint(x: v[0], y: v[1]) } }
        return out
    }

    #if DEBUG
    /// The demo (BGURU_DEMO=1 + BGURU_DEMO_OVERLAY=1): BGURU_DEMO_OVERLAY_SHOW=watch,offkai switches those on,
    /// BGURU_DEMO_OVERLAY_EXPAND=shogi expands one (for the screenshots of each state). Nothing is sent.
    func debugApplyDemoEnv() {
        let env = ProcessInfo.processInfo.environment
        let list = { (key: String) in (env[key] ?? "").split(separator: ",").compactMap { ActivityID(rawValue: String($0).trimmingCharacters(in: .whitespaces)) } }
        for id in list("BGURU_DEMO_OVERLAY_SHOW") { show(id) }
        if let e = list("BGURU_DEMO_OVERLAY_EXPAND").first { expand(e) } else { expanded = nil }
        // Positions as on a fresh install (the screenshots should not depend on an earlier drag).
        if env["BGURU_DEMO_OVERLAY_RESET"] != nil { positions = [:]; UserDefaults.standard.removeObject(forKey: Self.positionsKey) }
    }
    #endif
}
