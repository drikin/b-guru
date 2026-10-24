import SwiftUI

// MARK: - Pixel art (all drawn in code, no image assets — same as the web prototype)

/// One art pixel = 1 unit; a tile is 16. Colours as 0xRRGGBB.
private func col(_ hex: UInt32, _ a: Double = 1) -> Color {
    Color(.sRGB, red: Double((hex >> 16) & 0xFF) / 255, green: Double((hex >> 8) & 0xFF) / 255, blue: Double(hex & 0xFF) / 255, opacity: a)
}
private func cg(_ hex: UInt32, _ a: CGFloat = 1) -> CGColor {
    CGColor(srgbRed: CGFloat((hex >> 16) & 0xFF) / 255, green: CGFloat((hex >> 8) & 0xFF) / 255, blue: CGFloat(hex & 0xFF) / 255, alpha: a)
}

enum RoomArt {
    static let tile = 16

    nonisolated(unsafe) private static var floorCache: (key: [String], image: CGImage)?
    nonisolated(unsafe) private static var bedCache: (key: [String], bed: (Int, Int)?)?
    nonisolated(unsafe) private static var labelSizes: [String: CGSize] = [:]

    /// The beagle's bed (the first "b" tile), found once per map (it was searched for
    /// across the whole map on every frame).
    static func cachedBed(_ geo: RoomGeometry) -> (Int, Int)? {
        if let c = bedCache, c.key == geo.map.tiles { return c.bed }
        var bed: (Int, Int)?
        if let bx = (0..<geo.map.w).first(where: { x in (0..<geo.map.h).contains { geo.tile(x, $0) == "b" } }),
           let by = (0..<geo.map.h).first(where: { geo.tile(bx, $0) == "b" }) {
            bed = (bx, by)
        }
        bedCache = (geo.map.tiles, bed)
        return bed
    }

    /// A label's measured size, measured once per text (zone names, signs, member names).
    static func labelSize(_ s: String, measure: () -> CGSize) -> CGSize {
        if let hit = labelSizes[s] { return hit }
        let size = measure()
        if labelSizes.count > 500 { labelSizes.removeAll() }
        labelSizes[s] = size
        return size
    }

    /// The floor plan for this map, made once and reused every frame.
    static func cachedFloor(_ geo: RoomGeometry) -> CGImage? {
        if let c = floorCache, c.key == geo.map.tiles { return c.image }
        guard let img = floorImage(geo) else { return nil }
        floorCache = (geo.map.tiles, img)
        return img
    }

    /// The static floor plan as one bitmap (drawn once, scaled without smoothing).
    static func floorImage(_ geo: RoomGeometry) -> CGImage? {
        let W = geo.map.w * tile, H = geo.map.h * tile
        guard let c = CGContext(data: nil, width: W, height: H, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
        c.translateBy(x: 0, y: CGFloat(H))
        c.scaleBy(x: 1, y: -1)
        for y in 0..<geo.map.h { for x in 0..<geo.map.w { drawTile(c, geo, x, y) } }
        // Zone outlines.
        c.setStrokeColor(cg(0x3ccf74, 0.55))
        c.setLineWidth(1)
        c.setLineDash(phase: 0, lengths: [3, 3])
        for z in geo.map.zones {
            c.stroke(CGRect(x: CGFloat(z.x * tile) + 0.5, y: CGFloat(z.y * tile) + 0.5, width: CGFloat(z.w * tile) - 1, height: CGFloat(z.h * tile) - 1))
        }
        return c.makeImage()
    }

    private static func drawTile(_ c: CGContext, _ geo: RoomGeometry, _ X: Int, _ Y: Int) {
        let x = X * tile, y = Y * tile
        func px(_ hex: UInt32, _ dx: Int, _ dy: Int, _ w: Int = 1, _ h: Int = 1, _ a: CGFloat = 1) {
            c.setFillColor(cg(hex, a)); c.fill(CGRect(x: x + dx, y: y + dy, width: w, height: h))
        }
        func floor() {
            px(0x7a5236, 0, 0, 16, 16)
            for i in 0..<4 { px(i % 2 == 1 ? 0x845b3c : 0x70492f, 0, i * 4, 16, 3); px(0x5c3b25, (X * 7 + i * 5) % 14, i * 4, 1, 3) }
        }
        let t = geo.tile(X, Y)
        switch t {
        case "#":
            px(0x3b3046, 0, 0, 16, 16)
            for r in 0..<4 { px(0x4a3d57, 0, r * 4, 16, 1); px(0x2e2538, (r % 2) * 8 + 3, r * 4 + 1, 1, 3); px(0x2e2538, ((r % 2) * 8 + 11) % 16, r * 4 + 1, 1, 3) }
        case "w":
            px(0x3b3046, 0, 0, 16, 16); px(0x1b2a4a, 2, 3, 12, 11); px(0x26406e, 2, 3, 12, 4); px(0xf7e7a1, 10, 5, 2, 2)
            px(0xd7c6e0, 7, 3, 1, 11); px(0xd7c6e0, 2, 8, 12, 1); px(0x5d4c6b, 1, 14, 14, 1)
        case "D":
            px(0x2a1c14, 0, 0, 16, 16); px(0x5a3a22, 1, 0, 14, 16); px(0xf2b24c, geo.tile(X - 1, Y) == "D" ? 3 : 12, 8, 1, 2)
        case "B":
            floor(); px(0x4b2f1d, 0, 0, 16, 16)
            let books: [UInt32] = [0xc0504d, 0x4f81bd, 0x9bbb59, 0xf2b24c, 0x8064a2, 0x4bacc6]
            for (i, b) in books.enumerated() { px(b, 1 + i * 2 + (i > 2 ? 1 : 0), 2, 2, 5); px(b, 2 + ((i + 3) % 6) * 2, 9, 2, 5) }
            px(0x2e1c11, 0, 7, 16, 2)
        case "C":
            floor(); px(0x5a3d6e, 0, 2, 16, 12); px(0x7a5a92, 0, 2, 16, 3); px(0x43305a, 0, 13, 16, 1)
            if X % 2 == 0 { px(0x2b2b33, 4, 6, 8, 5); px(0x4bacc6, 5, 7, 6, 3); px(0x55555f, 7, 11, 2, 2) } else { px(0xf3e9d8, 6, 7, 4, 4); px(0x6b3f22, 7, 8, 2, 2) }
        case "s":
            floor(); px(0x2b5052, 4, 9, 8, 6); px(0x3c6e71, 3, 7, 10, 3)
        case "S", "M":
            px(0x5b3f7a, 0, 0, 16, 16); px(0x6a4b8c, 0, 0, 16, 1); px(0x4c3366, 0, 8, 16, 1)
            let below = geo.tile(X, Y + 1)
            if below != "S" && below != "M" { px(0x2b1d3a, 0, 13, 16, 3); px(0xf2b24c, 3, 14, 2, 1); px(0xf2b24c, 11, 14, 2, 1) }
            if t == "M" { px(0xcfcfd6, 7, 5, 2, 9); px(0x55555f, 5, 14, 6, 1); px(0x2b2b33, 6, 2, 4, 4); px(0x8a8a96, 7, 3, 1, 1) }
        case ",":
            floor(); px(0x8c2f39, 0, 0, 16, 16); px(0xa8404a, 1, 1, 14, 14)
            if (X + Y) % 2 == 1 { px(0xf2b24c, 7, 7, 2, 2) } else { px(0xd9a441, 3, 3); px(0xd9a441, 12, 12) }
        case "T":
            floor(); px(0xc9925b, 0, 0, 16, 16); px(0xe0ab73, 0, 0, 16, 2); px(0xa4743f, 0, 14, 16, 2)
            if (X + Y) % 3 == 0 { px(0xf3e9d8, 4, 5, 7, 5); px(0x43384a, 5, 6, 5, 1); px(0x43384a, 5, 8, 4, 1) }
        case "c":
            floor(); px(0x3c6e71, 3, 3, 10, 10); px(0x4f8a8d, 3, 3, 10, 2); px(0x2b5052, 3, 12, 10, 1)
        case "F":
            floor(); px(0x2f5d8a, 0, 2, 16, 13); px(0x3f73a8, 0, 2, 16, 4); px(0x24496d, 0, 13, 16, 2)
            if geo.tile(X - 1, Y) != "F" { px(0x24496d, 0, 2, 2, 13) }
            if geo.tile(X + 1, Y) != "F" { px(0x24496d, 14, 2, 2, 13) }
        case "V":
            floor(); px(0xc43d3d, 1, 0, 14, 16)
            if geo.tile(X, Y - 1) != "V" {
                px(0x2a2a33, 3, 2, 10, 12)
                for (i, k) in ([0x3ccf74, 0xf2b24c, 0x4bacc6, 0xf3e9d8] as [UInt32]).enumerated() { px(k, 4 + (i % 2) * 5, 3 + (i / 2) * 5, 3, 4) }
            } else { px(0xf3e9d8, 3, 2, 6, 2); px(0x1b1b22, 3, 8, 10, 4); px(0x8e2a2a, 1, 14, 14, 2) }
        case "P":
            floor(); px(0x9b5a34, 4, 10, 8, 6); px(0x7d4425, 4, 10, 8, 1); px(0x2f8f4e, 3, 3, 10, 8); px(0x3fb065, 5, 1, 6, 6)
            px(0x24703c, 2, 7, 3, 3); px(0x24703c, 11, 6, 3, 3)
        case "b":
            floor(); px(0x6b4a8c, 0, 3, 16, 12); px(0x8a67ab, 1, 5, 14, 8)
        default:
            floor()
        }
    }

    struct Look { var skin, hair, shirt, pants: UInt32 }
    // Same palettes and hash as the web and Android (src/lib/room-logic.ts lookFor), so
    // a member looks the same on every device.
    private static let skins: [UInt32] = [0xf1c7a0, 0xe8b48c, 0xf4cfaa, 0xe2ac82, 0xf6d4b5, 0xc98e66, 0xa8714e]
    private static let hairs: [UInt32] = [0x3a2a20, 0x6b6b6b, 0x1e1a22, 0xcfcfcf, 0x5a3a22, 0x2b2b44, 0x8a4a2a, 0xc46a3a, 0xd9b25a]
    private static let shirts: [UInt32] = [0xf2b24c, 0x4f81bd, 0x9bbb59, 0x8064a2, 0xc0504d, 0x4bacc6, 0xf3e9d8, 0xe07a9a, 0x3ccf74]
    private static let pants: [UInt32] = [0x2f3e5c, 0x333344, 0x3b3b46, 0x2a2a33, 0x3a2f2a, 0x6b4a8c, 0x43384a, 0x4a5a3a]

    /// FNV-1a over UTF-16 code units (JavaScript's charCodeAt).
    static func hashId(_ id: String) -> UInt32 {
        var h: UInt32 = 0x811c9dc5
        for u in id.utf16 { h ^= UInt32(u); h = h &* 0x01000193 }
        return h
    }

    /// A stable look per member, from their user id.
    static func look(_ userId: String) -> Look {
        let h = hashId(userId)
        return Look(skin: skins[Int(h % UInt32(skins.count))], hair: hairs[Int((h >> 5) % UInt32(hairs.count))],
                    shirt: shirts[Int((h >> 10) % UInt32(shirts.count))], pants: pants[Int((h >> 15) % UInt32(pants.count))])
    }

    /// A member at art-pixel (x, y): 16×16, 3 facings, 2-step walk, sitting.
    static func person(_ g: inout GraphicsContext, _ x: Double, _ y: Double, _ l: Look, _ dir: RoomGeometry.Dir, _ step: Int, sitting: Bool) {
        func px(_ hex: UInt32, _ dx: Double, _ dy: Double, _ w: Double = 1, _ h: Double = 1, _ a: Double = 1) {
            g.fill(Path(CGRect(x: x + dx, y: y + dy, width: w, height: h)), with: .color(col(hex, a)))
        }
        px(0x000000, 3, 14, 10, 2, 0.28)
        let lift: Double = sitting ? 2 : 0
        if !sitting {
            let a: Double = step == 1 ? -1 : 0, b: Double = step == 2 ? -1 : 0
            px(l.pants, 5, 12 + a, 2, 3); px(l.pants, 9, 12 + b, 2, 3)
            px(0x1e1a22, 5, 15 + a, 2, 1); px(0x1e1a22, 9, 15 + b, 2, 1)
        } else { px(l.pants, 4, 12, 8, 2) }
        px(l.shirt, 4, 8 + lift, 8, 5 - lift)
        px(0x000000, 4, 12, 8, 1, 0.18)
        let sw: Double = step == 1 ? 1 : step == 2 ? -1 : 0
        let side = dir == .left || dir == .right
        if !side { px(l.skin, 3, 9 + lift + sw, 1, 3); px(l.skin, 12, 9 + lift - sw, 1, 3) } else { px(l.skin, 7 + sw, 9 + lift, 2, 3) }
        px(l.skin, 4, 2 + lift, 8, 7)
        px(l.hair, 4, 1 + lift, 8, 3)
        switch dir {
        case .up: px(l.hair, 4, 1 + lift, 8, 6)
        case .left: px(l.hair, 8, 1 + lift, 4, 6); px(0x1e1a22, 5, 5 + lift, 1, 2)
        case .right: px(l.hair, 4, 1 + lift, 4, 6); px(0x1e1a22, 10, 5 + lift, 1, 2)
        case .down:
            px(l.hair, 4, 4 + lift, 1, 2); px(l.hair, 11, 4 + lift, 1, 2)
            px(0x1e1a22, 6, 5 + lift, 1, 2); px(0x1e1a22, 9, 5 + lift, 1, 2)
            px(0xe08a7a, 5, 7 + lift); px(0xe08a7a, 10, 7 + lift)
        }
    }

    /// The club beagle: tricolour, long ears, white-tipped tail.
    static func beagle(_ g: inout GraphicsContext, _ x: Double, _ y: Double, frame: Int, flip: Bool) {
        func px(_ hex: UInt32, _ dx: Double, _ dy: Double, _ w: Double = 1, _ h: Double = 1, _ a: Double = 1) {
            let fx = flip ? 16 - dx - w : dx
            g.fill(Path(CGRect(x: x + fx, y: y + dy, width: w, height: h)), with: .color(col(hex, a)))
        }
        px(0x000000, 2, 14, 12, 2, 0.25)
        px(0xc97a3a, 3, 7, 9, 5); px(0x2a1f1a, 5, 7, 6, 2); px(0xf6efe4, 4, 11, 7, 1)
        let l: Double = frame == 1 ? 1 : 0
        for (lx, ly) in [(3.0, 12.0), (5, 12 - l), (9, 12), (11, 12 - (1 - l))] { px(0xf6efe4, lx, ly, 1, 3) }
        px(0xc97a3a, 11, 3, 4, 5); px(0xf6efe4, 13, 6, 3, 2); px(0x2a1f1a, 15, 6); px(0x2a1f1a, 13, 4); px(0x7a4520, 10, 4, 2, 5)
        px(0xc97a3a, 1, 5 + l, 1, 3); px(0xf6efe4, 0, 4 + l)
    }
}

// MARK: - The room view

/// The map with everyone in it, plus the room's controls (listen / mic / reactions /
/// D-pad). Tap the floor to walk there, tap someone to wave or walk over.
struct RoomView: View {
    @Bindable var room: RoomStore
    @State private var menuFor: RoomMember?
    @FocusState private var focused: Bool
    /// The chat (and the panel / app) can be seen: the map is drawn only then.
    @Environment(\.screenVisibility) private var visibility
    private var onScreen: Bool { visibility?.room ?? true }

    var body: some View {
        VStack(spacing: 6) {
            controls
            GeometryReader { geo in
                map(size: geo.size)
            }
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(alignment: .bottomLeading) { reactionsBar.padding(6) }
            #if os(iOS)
            .overlay(alignment: .bottomTrailing) { DPad(room: room).padding(6) }
            #endif
            if let n = room.notice { Text(n).font(.app(.caption)).foregroundStyle(.secondary) }
        }
        .focusable()
        .focused($focused)
        .focusEffectDisabled()
        .onKeyPress(phases: [.down, .repeat]) { press in key(press) }
        .onAppear { focused = true }
        .confirmationDialog(menuFor?.name ?? "", isPresented: Binding(get: { menuFor != nil }, set: { if !$0 { menuFor = nil } }), titleVisibility: .visible) {
            if let m = menuFor {
                Button("👋 手を振る") { room.sendReaction("👋", to: m.userId) }
                Button("そばへ行く") { room.walk(toX: m.x, y: m.y) }
            }
        }
    }

    // MARK: Controls

    private var controls: some View {
        HStack(spacing: 8) {
            Button {
                Task { await room.setListening(!room.listening) }
            } label: {
                Label(room.listening ? "聞いている" : "見るだけ", systemImage: room.listening ? "headphones" : "eye")
                    .font(.app(.subheadline))
            }
            .buttonStyle(.bordered)
            .tint(room.listening ? Color.accentGreen : .secondary)
            .help(room.listening ? "押すと音を聞かずに見るだけにします" : "押すと近くの人の声が聞こえます")
            Button {
                Task { await room.setMic(!room.voice.micOn) }
            } label: {
                Label(room.voice.micOn ? "マイク オン" : "マイク オフ", systemImage: room.voice.micOn ? "mic.fill" : "mic.slash")
                    .font(.app(.subheadline))
            }
            .buttonStyle(.bordered)
            .tint(room.voice.micOn ? Color.accentGreen : .secondary)
            .disabled(room.voice.micBusy)
            Spacer(minLength: 4)
            if let z = room.zoneName {
                Text(z + "にいます").font(.app(.caption, weight: .bold)).foregroundStyle(Color.accentGreen)
                    .padding(.horizontal, 8).padding(.vertical, 3)
                    .overlay(Capsule().stroke(Color.accentGreen))
            }
        }
    }

    private var reactionsBar: some View {
        HStack(spacing: 4) {
            ForEach(Array(room.reactionChoices.enumerated()), id: \.offset) { i, e in
                Button { room.sendReaction(e) } label: {
                    Text(e).font(.app(size: 17)).frame(width: 32, height: 32)
                        .background(RoundedRectangle(cornerRadius: 8).fill(Color.black.opacity(0.55)))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("リアクション \(e)（\(i + 1)）")
            }
        }
    }

    // MARK: Map

    private func zoom(for size: CGSize) -> CGFloat {
        let tilesAcross: CGFloat = size.width < 600 ? 13 : 20
        return max(1.5, size.width / (CGFloat(RoomArt.tile) * tilesAcross))
    }

    private func camera(_ size: CGSize, _ z: CGFloat, _ now: Date) -> CGPoint {
        guard let geo = room.geometry else { return .zero }
        let W = CGFloat(geo.map.w * RoomArt.tile), H = CGFloat(geo.map.h * RoomArt.tile)
        let vw = size.width / z, vh = size.height / z
        let me = room.meId.flatMap { room.displayPosition($0, at: now) } ?? (Double(geo.map.door.x), Double(geo.map.door.y))
        let cx = (CGFloat(me.x) + 0.5) * 16 - vw / 2, cy = (CGFloat(me.y) + 0.5) * 16 - vh / 2
        let x = W <= vw ? (W - vw) / 2 : min(max(cx, 0), W - vw)
        let y = H <= vh ? (H - vh) / 2 : min(max(cy, 0), H - vh)
        return CGPoint(x: x.rounded(), y: y.rounded())
    }

    private func map(size: CGSize) -> some View {
        let z = zoom(for: size)
        // 30 frames a second only while someone walks or a bubble / reaction is up; the
        // rest of the time the beagle's steps (every 0.45 s) are all that moves. It drew 30
        // a second all the time (≈ 10 % CPU on the Mac, also with the panel closed), and
        // not at all while the room cannot be seen.
        return TimelineView(RoomSchedule(busyUntil: room.busyUntil, paused: !onScreen)) { tl in
            let now = tl.date
            let cam = camera(size, z, now)
            Canvas { g, _ in
                g.fill(Path(CGRect(origin: .zero, size: size)), with: .color(col(0x120e14)))
                g.scaleBy(x: z, y: z)
                g.translateBy(x: -cam.x, y: -cam.y)
                draw(&g, now: now)
            }
            .contentShape(Rectangle())
            .gesture(SpatialTapGesture().onEnded { t in tap(t.location, size: size, z: z, cam: cam) })
            .accessibilityLabel("部室のマップ")
            .accessibilityHint("タップした場所へ歩きます")
        }
        .id(room.revision % 1) // keep identity; reading revision redraws the map on every change
    }

    private func tap(_ p: CGPoint, size: CGSize, z: CGFloat, cam: CGPoint) {
        focused = true
        let tx = Int(((p.x / z) + cam.x) / 16), ty = Int(((p.y / z) + cam.y) / 16)
        if let who = room.members.values.first(where: { $0.userId != room.meId && $0.x == tx && $0.y == ty }) {
            menuFor = who
            return
        }
        room.walk(toX: tx, y: ty)
    }

    private func draw(_ g: inout GraphicsContext, now: Date) {
        guard let geo = room.geometry else { return }
        let W = CGFloat(geo.map.w * 16), H = CGFloat(geo.map.h * 16)
        if let floor = RoomArt.cachedFloor(geo) {
            g.draw(Image(decorative: floor, scale: 1, orientation: .up).interpolation(.none).resizable(), in: CGRect(x: 0, y: 0, width: W, height: H))
        }
        // Hearing range around me (outside the zones).
        if let m = room.me, m.inRoom, room.listening, geo.zone(m.x, m.y) == nil, let p = room.displayPosition(m.userId, at: now) {
            let r = CGFloat(geo.map.hearRadius * 16)
            let circle = Path(ellipseIn: CGRect(x: (p.x + 0.5) * 16 - r, y: (p.y + 0.5) * 16 - r, width: r * 2, height: r * 2))
            g.fill(circle, with: .color(col(0x3ccf74, 0.08)))
            g.stroke(circle, with: .color(col(0x3ccf74, 0.45)), lineWidth: 1)
        }
        for z in geo.map.zones { label(&g, z.name, x: CGFloat(z.x * 16 + 3), y: CGFloat(z.y * 16 + 2), fg: col(0x3ccf74)) }
        for l in geo.map.labels { label(&g, l.name, x: CGFloat(l.x * 16 + 2), y: CGFloat(l.y * 16 + 3), fg: col(0xf2b24c)) }
        // The beagle pads around its bed.
        if let (bedX, bedY) = RoomArt.cachedBed(geo) {
            let t = now.timeIntervalSinceReferenceDate
            let phase = Int(t / 0.9) % 8
            let off = [0, 1, 2, 2, 1, 0, -1, -1][phase]
            RoomArt.beagle(&g, Double((bedX + off) * 16), Double((bedY - 1) * 16), frame: Int(t / 0.45) % 2, flip: phase >= 3 && phase < 7)
        }
        // People, back to front.
        let people = room.members.values.compactMap { m -> (RoomMember, (x: Double, y: Double))? in
            room.displayPosition(m.userId, at: now).map { (m, $0) }
        }.sorted { $0.1.y < $1.1.y }
        let speaking = Set(room.voice.members.filter { $0.speaking }.map(\.userId))
        for (m, p) in people {
            let x = (p.x * 16).rounded(), y = (p.y * 16).rounded() - 2
            if speaking.contains(m.userId) {
                g.stroke(Path(ellipseIn: CGRect(x: x, y: y + 12, width: 16, height: 6)), with: .color(col(0x3ccf74)), lineWidth: 1)
            }
            let sitting = room.step(m.userId, at: now) == 0 && ["c", "s"].contains(geo.tile(m.x, m.y))
            RoomArt.person(&g, x, y, RoomArt.look(m.userId), room.facing(m.userId, at: now), room.step(m.userId, at: now), sitting: sitting)
            let mark = m.away ? "💤" : !m.inRoom ? "⌨️" : !m.listening ? "👀" : speaking.contains(m.userId) || (m.userId == room.meId && room.voice.micActive) ? "🔊" : "🎧"
            let mine = m.userId == room.meId
            label(&g, "\(mark) \(mine ? "あなた" : m.name)", x: x + 8, y: y - 9, fg: mine ? col(0x1d1820) : .white,
                  bg: mine ? col(0xf2b24c, 0.92) : col(0x120e14, 0.78), center: true)
        }
        for (m, p) in people {
            let x = p.x * 16 + 8, y = p.y * 16 - 12
            if let text = room.bubble(m.userId, at: now) { bubble(&g, text, x: x, y: y) }
            for (i, r) in room.floating(m.userId, at: now).enumerated() {
                let k = r.age / 1.8
                var gg = g
                gg.opacity = 1 - k * k
                gg.draw(Text(r.emoji).font(.app(size: 12)), at: CGPoint(x: p.x * 16 + 6 + Double(i) * 7, y: p.y * 16 - 8 - k * 18))
            }
        }
    }

    private func label(_ g: inout GraphicsContext, _ s: String, x: CGFloat, y: CGFloat, fg: Color, bg: Color = col(0x120e14, 0.75), center: Bool = false) {
        let t = g.resolve(Text(s).font(.app(size: 7, weight: .bold)).foregroundStyle(fg))
        let size = RoomArt.labelSize(s) { t.measure(in: CGSize(width: 400, height: 20)) }
        let lx = center ? x - size.width / 2 - 2 : x
        g.fill(Path(CGRect(x: lx, y: y, width: size.width + 4, height: 9)), with: .color(bg))
        g.draw(t, at: CGPoint(x: lx + 2, y: y + 4.5), anchor: .leading)
    }

    private func bubble(_ g: inout GraphicsContext, _ s: String, x: Double, y: Double) {
        let chars = Array(s)
        let rows = stride(from: 0, to: chars.count, by: 12).map { String(chars[$0..<min($0 + 12, chars.count)]) }
        let resolved = rows.map { g.resolve(Text($0).font(.app(size: 7)).foregroundStyle(col(0x1d1820))) }
        let w = (resolved.map { $0.measure(in: CGSize(width: 400, height: 20)).width }.max() ?? 0) + 8
        let h = Double(rows.count) * 9 + 5
        let bx = (x - w / 2).rounded(), by = (y - h - 4).rounded()
        g.fill(Path(CGRect(x: bx - 1, y: by - 1, width: w + 2, height: h + 2)), with: .color(col(0x1d1820)))
        g.fill(Path(CGRect(x: bx, y: by, width: w, height: h)), with: .color(col(0xfffaf0)))
        g.fill(Path(CGRect(x: x - 1, y: by + h, width: 3, height: 2)), with: .color(col(0xfffaf0)))
        for (i, t) in resolved.enumerated() { g.draw(t, at: CGPoint(x: bx + 4, y: by + 7 + Double(i) * 9), anchor: .leading) }
    }

    // MARK: Keyboard (Mac, iPad with a keyboard)

    private func key(_ press: KeyPress) -> KeyPress.Result {
        switch press.key {
        case .upArrow: room.nudge(.up); return .handled
        case .downArrow: room.nudge(.down); return .handled
        case .leftArrow: room.nudge(.left); return .handled
        case .rightArrow: room.nudge(.right); return .handled
        default: break
        }
        switch press.characters.lowercased() {
        case "w": room.nudge(.up)
        case "s": room.nudge(.down)
        case "a": room.nudge(.left)
        case "d": room.nudge(.right)
        case "1", "2", "3", "4", "5", "6":
            let i = Int(press.characters)! - 1
            if i < room.reactionChoices.count { room.sendReaction(room.reactionChoices[i]) }
        default: return .ignored
        }
        return .handled
    }
}

/// Smooth (30 a second) until `busyUntil`, then every 0.45 s on the beagle's step; nothing
/// while paused.
struct RoomSchedule: TimelineSchedule {
    let busyUntil: Date
    let paused: Bool

    func entries(from start: Date, mode: TimelineScheduleMode) -> UnfoldFirstSequence<Date> {
        let step = 0.45
        return sequence(first: start) { t in
            if paused { return nil }
            if t < busyUntil { return t.addingTimeInterval(1.0 / 30) }
            // Next step boundary (the beagle's frames are counted from the reference date).
            let n = (t.timeIntervalSinceReferenceDate / step).rounded(.down) + 1
            return Date(timeIntervalSinceReferenceDate: n * step)
        }
    }
}

#if os(iOS)
/// On-screen arrows: press and hold to keep walking.
private struct DPad: View {
    let room: RoomStore
    @State private var holding: RoomGeometry.Dir?

    var body: some View {
        Grid(horizontalSpacing: 4, verticalSpacing: 4) {
            GridRow { Color.clear.frame(width: 40, height: 40); arrow(.up, "chevron.up"); Color.clear.frame(width: 40, height: 40) }
            GridRow { arrow(.left, "chevron.left"); Color.clear.frame(width: 40, height: 40); arrow(.right, "chevron.right") }
            GridRow { Color.clear.frame(width: 40, height: 40); arrow(.down, "chevron.down"); Color.clear.frame(width: 40, height: 40) }
        }
        .task(id: holding) {
            while let d = holding, !Task.isCancelled {
                room.nudge(d)
                try? await Task.sleep(for: .seconds(RoomStore.stepTime + 0.02))
            }
        }
    }

    private func arrow(_ d: RoomGeometry.Dir, _ icon: String) -> some View {
        Image(systemName: icon).font(.app(size: 16, weight: .bold))
            .frame(width: 40, height: 40)
            .background(RoundedRectangle(cornerRadius: 10).fill(Color.black.opacity(0.55)))
            .foregroundStyle(.white)
            .gesture(DragGesture(minimumDistance: 0).onChanged { _ in if holding != d { holding = d } }.onEnded { _ in holding = nil })
            .accessibilityLabel(["up": "上へ", "down": "下へ", "left": "左へ", "right": "右へ"]["\(d)"] ?? "")
            .accessibilityAddTraits(.isButton)
    }
}
#endif

/// テキスト｜ルーム inside the chat. The ルーム tab shows how many are in the room's
/// voice (🟢 while someone talks) — the text view's way in, no separate banner.
/// With ☗ 将棋 / 🎮 ゲーム on, more choices (icons only; read as 「将棋」「ゲーム」). The room,
/// ☗ and 🎮 are independent: each shows only when it is on for this member.
struct RoomModePicker: View {
    let room: RoomStore
    var shogi: ShogiStore? = nil
    var minigame: MinigameStore? = nil

    enum Choice: Hashable { case text, room, shogi, game }

    private var roomLabel: String {
        let n = room.inVoice.count
        guard n > 0 else { return "ルーム" }
        let talking = room.voice.members.contains { $0.speaking }
        return "ルーム 🎧\(n)" + (talking ? " 🟢" : "")
    }

    private var shogiOn: Bool { shogi?.enabled == true }
    private var gameOn: Bool { minigame?.enabled == true }

    var body: some View {
        Picker("表示", selection: Binding<Choice>(
            get: { RoomModePicker.current(room: room, shogi: shogi, minigame: minigame) },
            set: { RoomModePicker.choose($0, room: room, shogi: shogi, minigame: minigame) }
        )) {
            Text("テキスト").tag(Choice.text)
            if room.enabled { Text(roomLabel).tag(Choice.room) }
            if shogiOn {
                Text(shogi?.attention ?? 0 > 0 ? "☗●" : "☗").tag(Choice.shogi).accessibilityLabel("将棋")
            }
            if gameOn { Text("🎮").tag(Choice.game).accessibilityLabel("ゲーム") }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
        .controlSize(.small)
        .fixedSize()
        .id("\(room.enabled)|\(shogiOn)|\(gameOn)") // a new control for a different number of segments
    }

    static func current(room: RoomStore, shogi: ShogiStore?, minigame: MinigameStore? = nil) -> Choice {
        if minigame?.enabled == true, minigame?.open == true { return .game }
        if shogi?.enabled == true, shogi?.open == true { return .shogi }
        return room.mode == .room ? .room : .text
    }

    static func choose(_ c: Choice, room: RoomStore, shogi: ShogiStore?, minigame: MinigameStore? = nil) {
        switch c {
        case .text:
            shogi?.close()
            minigame?.close()
            Task { await room.toText() }
        case .room:
            shogi?.close()
            minigame?.close()
            Task { await room.enter() }
        case .shogi:
            shogi?.show() // closes 🎮 and leaves the room first (ChatStore sets that up)
        case .game:
            minigame?.show() // closes ☗ and leaves the room first
        }
    }
}


/// The compact テキスト｜ルーム for a tight header (the Mac panel's top row): a speech
/// bubble and a house, with how many are in the room's voice. Drawn by hand — the
/// system segmented control drops symbols embedded in text.
struct RoomModeIcons: View {
    let room: RoomStore
    /// ☗ 将棋 and 🎮 ゲーム: more segments (icons only), each only when on for this member.
    var shogi: ShogiStore? = nil
    var minigame: MinigameStore? = nil

    var body: some View {
        let n = room.inVoice.count
        let talking = room.voice.members.contains { $0.speaking }
        let choice = RoomModePicker.current(room: room, shogi: shogi, minigame: minigame)
        let shogiOn = shogi?.enabled == true
        let gameOn = minigame?.enabled == true
        HStack(spacing: 2) {
            segment(selected: choice == .text, help: "テキスト") {
                Image(systemName: "list.bullet") // not a bubble: 💬 is the chat tab itself
            } action: {
                RoomModePicker.choose(.text, room: room, shogi: shogi, minigame: minigame)
            }
            if room.enabled {
                segment(selected: choice == .room, help: n > 0 ? "ルーム（部室のボイスに \(n) 人）" : "ルーム（部室）") {
                    HStack(spacing: 3) {
                        Image(systemName: "house")
                        if n > 0 { Text("\(n)").monospacedDigit() }
                        if talking { Circle().fill(Color.accentGreen).frame(width: 5, height: 5) }
                    }
                } action: {
                    RoomModePicker.choose(.room, room: room, shogi: shogi, minigame: minigame)
                }
            }
            if shogiOn, let shogi {
                let attention = shogi.attention
                segment(selected: choice == .shogi, help: attention > 0 ? "将棋（申し込みかあなたの番が \(attention) 件）" : "将棋") {
                    HStack(spacing: 3) {
                        Text("☗")
                        if attention > 0 { Circle().fill(Color.red).frame(width: 5, height: 5) }
                    }
                } action: {
                    RoomModePicker.choose(.shogi, room: room, shogi: shogi, minigame: minigame)
                }
            }
            if gameOn {
                segment(selected: choice == .game, help: "ゲーム（散財ダッシュ）") {
                    Text("🎮")
                } action: {
                    RoomModePicker.choose(.game, room: room, shogi: shogi, minigame: minigame)
                }
            }
        }
        .padding(2)
        .background(RoundedRectangle(cornerRadius: 7).fill(Color.primary.opacity(0.08)))
        .fixedSize()
        .accessibilityElement(children: .contain)
        .accessibilityLabel(accessibilityText(n: n, shogiOn: shogiOn, gameOn: gameOn))
    }

    private func accessibilityText(n: Int, shogiOn: Bool, gameOn: Bool = false) -> String {
        let choices = ["テキスト"] + (room.enabled ? ["ルーム"] : []) + (shogiOn ? ["将棋"] : []) + (gameOn ? ["ゲーム"] : [])
        let head = "表示：" + choices.joined(separator: "か")
        return room.enabled && n > 0 ? "\(head)。部室のボイスに \(n) 人" : head
    }

    private func segment<L: View>(selected: Bool, help: String, @ViewBuilder label: () -> L, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            label()
                .font(.app(size: 12, weight: .medium))
                .foregroundStyle(selected ? Color.white : Color.primary)
                .padding(.horizontal, 9)
                .frame(height: 20)
                .background(RoundedRectangle(cornerRadius: 5).fill(selected ? Color.accentColor : Color.clear))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .help(help)
        .accessibilityLabel(help)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
