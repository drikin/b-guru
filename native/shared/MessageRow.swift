import SwiftUI

struct MessageRow: View {
    let row: ChatRow
    let showHeader: Bool
    let canReact: Bool
    let canEdit: Bool
    let onReact: (String) -> Void
    let onEdit: () -> Void
    let onRetry: () -> Void
    let onDiscard: () -> Void
    /// Reply with an @mention of this message's author (others' messages only).
    var onReplyMention: (() -> Void)? = nil
    var highlighted = false
    /// This message is open in the composer for editing.
    var editing = false
    /// Previews of photos still being sent (the stored message has their URLs instead).
    var localImages: [PlatformImage] = []
    /// Tap on a photo: open it full screen (index into `m.images`).
    var onOpenImage: ((Int) -> Void)? = nil

    /// ☗ 将棋 (nil when it is off): a kind "shogi" message is drawn as its game card.
    @Environment(\.shogi) private var shogi
    @State private var hovering = false
    @State private var pickerOpen = false
    @State private var selecting = false

    static let quick = ["❤️", "👍", "😂", "🎉", "🙏", "👀"]

    private var m: ChatMessage { row.message }
    private var mine: Bool { m.isAuthor }

    var body: some View {
        if m.isShogiCard, let shogi, let id = m.shogiGameId {
            // The game card from ビーグル: a small board and 「観戦する」 (redrawn by the game's events).
            ShogiChatCard(shogi: shogi, gameId: id, body_: m.body)
                .padding(.vertical, 2)
        } else if m.isNotice {
            // A quiet note from B-guru (who came into / left the room): one small grey line.
            Text(m.body)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .padding(.vertical, 1)
        } else {
            bubbleRow
        }
    }

    private var bubbleRow: some View {
        HStack(alignment: .top, spacing: 6) {
            if mine { Spacer(minLength: 40) }
            if !mine {
                AvatarView(url: m.avatar, name: m.authorName ?? "")
                    .opacity(showHeader ? 1 : 0)
                    .accessibilityHidden(true)
            }
            VStack(alignment: mine ? .trailing : .leading, spacing: 2) {
                if showHeader || row.state == .failed {
                    HStack(spacing: 6) {
                        if !mine { Text(m.authorName ?? "").font(.caption).foregroundStyle(.secondary) }
                        if row.state == .failed {
                            Text("送信できませんでした").font(.caption).foregroundStyle(.red)
                            Button("再送", action: onRetry).linkButton().font(.caption)
                            Button("取り消す", action: onDiscard).linkButton().font(.caption).tint(.secondary)
                        }
                        if m.edited { Text("編集済み").font(.caption2).foregroundStyle(Color.accentGreen) }
                        Text(Self.time(m.createdAt)).font(.caption2).foregroundStyle(.tertiary).monospacedDigit()
                    }
                }
                bubble
                if let rs = m.reactions, !rs.isEmpty {
                    ReactionChips(reactions: rs, enabled: canReact && m.id > 0, onTap: onReact)
                }
            }
            if !mine { Spacer(minLength: 40) }
        }
        .padding(.vertical, highlighted ? 2 : 0)
        .background(
            RoundedRectangle(cornerRadius: 10)
                .fill(Color.accentGreen.opacity(highlighted ? 0.16 : 0))
                .animation(.easeOut(duration: 0.6), value: highlighted)
        )
        .opacity(row.state == .pending ? 0.6 : 1)
        .animation(.easeOut(duration: 0.15), value: row.state)
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .contextMenu { menu }
        .sheet(isPresented: $selecting) {
            SelectableTextSheet(author: m.authorName ?? "メッセージ", text: m.body)
        }
        .accessibilityElement(children: .combine)
        .accessibilityAction(named: "❤️ を付ける") { if canReact && m.id > 0 { onReact("❤️") } }
        .accessibilityAction(named: "編集") { if mine && canEdit && m.id > 0 { onEdit() } }
        .accessibilityAction(named: "返信") { if !mine { onReplyMention?() } }
        .accessibilityLabel("\(mine ? "自分" : (m.authorName ?? ""))、\(m.displayBody)\((m.images ?? []).isEmpty ? "" : "、写真 \((m.images ?? []).count) 枚")\(m.mentionsMe ? "、あなたへのメンション" : "")\(row.state == .failed ? "、送信失敗" : "")")
    }

    @ViewBuilder private var bubble: some View {
        let paths = m.images ?? []
        if !paths.isEmpty || !localImages.isEmpty {
            VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
                ChatPhotos(paths: paths, local: paths.isEmpty ? localImages : [], onOpen: onOpenImage)
                if !m.displayBody.isEmpty { textBubble }
            }
        } else {
            textBubble
        }
    }

    private var textBubble: some View {
        let emojiOnly = Self.isEmojiOnly(m.displayBody)
        return Text(Self.attributed(m.displayBody))
            .font(emojiOnly ? .system(size: 34) : .body)
            #if os(macOS)
            // macOS: select part of a message with the mouse. On iOS a long press
            // must open the menu (reactions / edit / copy) instead.
            .textSelection(.enabled)
            #endif
            .padding(.horizontal, emojiOnly ? 4 : 10)
            .padding(.vertical, emojiOnly ? 0 : 6)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(emojiOnly ? Color.clear : (mine ? Color.accentGreen.opacity(0.14)
                        : (m.mentionsMe ? Color.yellow.opacity(0.22) : Color.primary.opacity(0.06))))
            )
            .overlay(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(Color.accentGreen, lineWidth: editing ? 1.5 : 0)
            )
            #if os(iOS)
            // iOS: double-tap = ❤️ (text selection lives in the menu → "テキストを選択").
            // macOS has no double-click shortcut: it would block selecting text with the mouse.
            .onTapGesture(count: 2) { if canReact && m.id > 0 { onReact("❤️") } }
            #endif
            // Actions hang off the bubble's outer top corner on hover: ❤️ in one
            // click, 😊 for the picker, ✏️ for your own. An overlay takes no
            // space, so bubbles keep their full width and nothing jumps.
            .overlay(alignment: mine ? .topLeading : .topTrailing) {
                actionBar
                    .fixedSize()
                    .alignmentGuide(mine ? .leading : .trailing) { d in
                        mine ? d[.trailing] - 14 : d[.leading] + 14
                    }
                    .offset(y: -12)
            }
    }

    private var showActions: Bool { (hovering || pickerOpen || Self.debugForceActions) && m.id > 0 && row.state == .sent }

    #if DEBUG
    static let debugForceActions = CommandLine.arguments.contains("-forceActions")
    #else
    static let debugForceActions = false
    #endif

    @ViewBuilder private var actionBar: some View {
        if canReact || (mine && canEdit) || (!mine && onReplyMention != nil) {
            HStack(spacing: 0) {
                if canReact {
                    ActionButton(systemImage: nil, text: "❤️", help: "❤️ を付ける（ダブルクリックでも）") { onReact("❤️") }
                    ActionButton(systemImage: "face.smiling", text: nil, help: "リアクションを選ぶ") { pickerOpen = true }
                        .popover(isPresented: $pickerOpen, arrowEdge: .bottom) {
                            ReactionPicker { emoji in
                                pickerOpen = false
                                onReact(emoji)
                            }
                            .presentationCompactAdaptation(.popover) // iPhone: stay a popover, not a full sheet
                        }
                }
                if let onReplyMention, !mine {
                    ActionButton(systemImage: "arrowshape.turn.up.left", text: nil,
                                 help: "\(m.authorName ?? "") さんに返信（@メンション）", action: onReplyMention)
                }
                if mine && canEdit {
                    ActionButton(systemImage: "pencil", text: nil, help: "編集（入力欄が空のとき ↑ でも）", action: onEdit)
                }
            }
            .padding(2)
            .background(Capsule().fill(.background).shadow(color: .black.opacity(0.12), radius: 2, y: 1))
            .opacity(showActions ? 1 : 0)
            .animation(.easeOut(duration: 0.12), value: showActions)
            .allowsHitTesting(showActions)
            .accessibilityHidden(true) // exposed as accessibility actions on the row instead
        }
    }

    @ViewBuilder private var menu: some View {
        if let onReplyMention, !mine, m.id > 0 {
            Button("返信（@メンション）", systemImage: "arrowshape.turn.up.left", action: onReplyMention)
        }
        if canReact && m.id > 0 {
            ForEach(Self.quick, id: \.self) { e in Button(e) { onReact(e) } }
            Divider()
        }
        if mine && canEdit && m.id > 0 { Button("編集", action: onEdit) }
        Button("テキストをコピー", systemImage: "doc.on.doc") {
            Platform.copy(m.body)
        }
        #if os(iOS)
        Button("テキストを選択", systemImage: "selection.pin.in.out") { selecting = true }
        #endif
    }

    // MARK: helpers

    private static let isoFrac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso = ISO8601DateFormatter()
    private static let hm: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "H:mm"
        return f
    }()

    /// "12:34" — parsed once per timestamp (every row asked again on each redraw).
    static func time(_ s: String) -> String {
        if let hit = timeCache.object(forKey: s as NSString) { return hit as String }
        guard let d = isoFrac.date(from: s) ?? iso.date(from: s) else { return "" }
        let t = hm.string(from: d)
        timeCache.setObject(t as NSString, forKey: s as NSString)
        return t
    }
    private static let timeCache: NSCache<NSString, NSString> = {
        let c = NSCache<NSString, NSString>()
        c.countLimit = 2000
        return c
    }()

    static func isEmojiOnly(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= 3 else { return false }
        return t.unicodeScalars.allSatisfy { $0.properties.isEmojiPresentation || $0.properties.isEmoji && $0.value > 0x238C || $0.value == 0x200D || $0.value == 0xFE0F }
    }

    /// Links become clickable; @mentions get a subtle tint.
    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    private static let mentionRegex = try? NSRegularExpression(pattern: "@\\[[^\\]]+\\]|@[^\\s@\\[\\]]+")
    private final class Box { let value: AttributedString; init(_ v: AttributedString) { value = v } }
    private static let attributedCache: NSCache<NSString, Box> = {
        let c = NSCache<NSString, Box>()
        c.countLimit = 1000
        return c
    }()

    /// Parsed once per text (rows re-render on every live update and scroll; making
    /// an NSDataDetector each time was the costliest part of drawing a message).
    static func attributed(_ s: String) -> AttributedString {
        if let hit = attributedCache.object(forKey: s as NSString) { return hit.value }
        let a = parseAttributed(s)
        attributedCache.setObject(Box(a), forKey: s as NSString)
        return a
    }

    private static func parseAttributed(_ s: String) -> AttributedString {
        var a = AttributedString(s)
        if let det = linkDetector {
            let ns = s as NSString
            for match in det.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
                guard let url = match.url, let r = Range(match.range, in: s),
                      let ar = Range(r, in: a) else { continue }
                a[ar].link = url
            }
        }
        if let re = mentionRegex {
            for match in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
                guard let r = Range(match.range, in: s), let ar = Range(r, in: a) else { continue }
                a[ar].foregroundColor = Color.accentGreen
            }
        }
        return a
    }
}

/// Rows are compared before their body runs (`.equatable()` in the lists): typing, a
/// presence change or another row's update no longer re-evaluates every row. The closures
/// are left out — they act on the same store and composer for the life of the list, and
/// whatever they take from the row is compared here.
extension MessageRow: @MainActor Equatable {
    static func == (a: Self, b: Self) -> Bool {
        a.row == b.row && a.showHeader == b.showHeader && a.canReact == b.canReact && a.canEdit == b.canEdit
            && a.highlighted == b.highlighted && a.editing == b.editing
            && (a.onReplyMention == nil) == (b.onReplyMention == nil)
            && (a.onOpenImage == nil) == (b.onOpenImage == nil)
            && a.localImages.count == b.localImages.count
            && zip(a.localImages, b.localImages).allSatisfy { $0 === $1 }
    }
}

struct ActionButton: View {
    let systemImage: String?
    let text: String?
    let help: String
    var tint: Color? = nil
    let action: () -> Void
    @State private var over = false

    var body: some View {
        Button(action: action) {
            Group {
                if let systemImage { Image(systemName: systemImage).font(.system(size: 12, weight: .medium)) }
                if let text { Text(text).font(.system(size: 13)) }
            }
            .frame(width: 24, height: 22)
            .background(Circle().fill(Color.primary.opacity(over ? 0.10 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(tint.map { AnyShapeStyle($0) } ?? AnyShapeStyle(.secondary))
        .help(help)
        .onHover { over = $0 }
    }
}

/// The reaction picker (the web's ReactionBar): 「よく使う」 12, then every emoji, then the
/// community's custom emoji (sent as ":name:"). The chat and the timeline use the same one.
struct ReactionPicker: View {
    let onPick: (String) -> Void
    /// The web's QUICK_EMOJIS, in its order (how often each is used).
    static let unicode = ["❤️", "👍", "🎉", "😂", "🙏", "🔥", "👏", "😮", "😢", "🤔", "💯", "✨"]
    /// The web's PICKER_EMOJIS.
    static let all = ["😀","😄","😁","😆","😅","😂","🤣","😊","😇","🙂","😉","😍","😘","😜","🤪","😝",
        "😎","🤓","🥳","😏","😌","😴","🤤","😪","😷","🤒","🤕","🤢","🤮","🥴","😵","🤯",
        "😤","😠","😡","🤬","😭","😢","😱","😨","😰","😥","😓","🫡","🤝","👍","👎","👌",
        "✌️","🤞","🙏","👏","💪","🤙","👋","🤌","🖐️","✋","🤚","👈","👉","👆","👇","🏆",
        "🔥","❤️","🧡","💛","💚","💙","💜","🖤","🤍","💔","💯","💥","✨","⭐","🌟","💫",
        "🎉","🎊","🎁","🎂","🍰","🍺","🍻","🥂","☕","🍵","🍜","🍣","🍩","🍪","🍎","🍉",
        "🚀","🤔","🥇","🗽","🎬","📷","🎧","🎮","💻","📱","⌚","💾","☁️","🌧️","☀️","🌙",
        "🌈","⚡","❄️","🚗","🚕","✈️","🏠","🌸","🐶","🐱","🦊","🐻","🐼","🐨","🐸","🐝",
        "🦄","🐙","🍀","🌍","⚽","🏀","🎯","🎲","🎳","🎹","🎸","🥁","🎨","🧸","🪙","💰",
        "💎","⏰","📌","🔔","🔒","✅","❌","⚠️","❓","❗","💬","📢","🗯️","🧦"]
    private let cols = Array(repeating: GridItem(.fixed(30), spacing: 4), count: 7)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text("よく使う").font(.caption).foregroundStyle(.secondary)
                grid(Self.unicode)
                Text("すべて").font(.caption).foregroundStyle(.secondary)
                grid(Self.all)
                let custom = EmojiCatalog.shared.names
                if !custom.isEmpty {
                    Text("カスタム絵文字").font(.caption).foregroundStyle(.secondary)
                    LazyVGrid(columns: cols, spacing: 4) {
                        ForEach(custom, id: \.self) { name in
                            Button { onPick(":\(name):") } label: {
                                ReactionGlyph(emoji: ":\(name):", size: 24).frame(width: 30, height: 30)
                            }
                            .buttonStyle(.plain)
                            .help(":\(name):")
                            .accessibilityLabel(":\(name):")
                        }
                    }
                }
            }
            .padding(10)
        }
        .frame(width: 270, height: 300)
    }

    private func grid(_ emojis: [String]) -> some View {
        LazyVGrid(columns: cols, spacing: 4) {
            ForEach(Array(emojis.enumerated()), id: \.offset) { _, e in
                Button { onPick(e) } label: { Text(e).font(.system(size: 20)).frame(width: 30, height: 30) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(e)
            }
        }
    }
}

/// Lays its children out left to right and starts a new line when the width runs out.
/// Its minimum width is that of its widest child, never the sum of them.
struct FlowRow: Layout {
    var spacing: CGFloat = 4

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, width: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0, x + spacing + size.width > maxWidth {
                width = max(width, x)
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            x += (x > 0 ? spacing : 0) + size.width
            lineHeight = max(lineHeight, size.height)
        }
        return CGSize(width: max(width, x), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0
        for s in subviews {
            let size = s.sizeThatFits(.unspecified)
            if x > 0, x + spacing + size.width > bounds.width + 0.5 { // rounding: never wrap more than measured
                x = 0
                y += lineHeight + spacing
                lineHeight = 0
            }
            if x > 0 { x += spacing }
            s.place(at: CGPoint(x: bounds.minX + x, y: bounds.minY + y), proposal: ProposedViewSize(size))
            x += size.width
            lineHeight = max(lineHeight, size.height)
        }
    }
}

struct ReactionChips: View {
    let reactions: [Reaction]
    let enabled: Bool
    let onTap: (String) -> Void

    var body: some View {
        // Wraps onto more lines instead of growing sideways: a post with many kinds of
        // reaction made the row (and with it the Mac panel's minimum width) wider than the
        // panel, which kept relaying the panel while scrolling (drikin 2026-10-20, the
        // timeline froze).
        FlowRow(spacing: 4) {
            ForEach(reactions, id: \.emoji) { r in
                Button { onTap(r.emoji) } label: {
                    HStack(spacing: 2) {
                        ReactionGlyph(emoji: r.emoji)
                        Text("\(r.count)").font(.caption2).monospacedDigit()
                    }
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Capsule().fill(r.mine ? Color.accentGreen.opacity(0.18) : Color.primary.opacity(0.06)))
                    .overlay(Capsule().strokeBorder(r.mine ? Color.accentGreen.opacity(0.5) : .clear))
                }
                .buttonStyle(.plain)
                .disabled(!enabled)
                // Who reacted, as the web's tooltip: 「❤️ 14人」, the names (up to 12) and 「他N人」.
                // Mac: hover. iPhone / iPad: press and hold the chip.
                .help(r.reactors.isEmpty ? "" : TimelineRules.reactorsText(r))
                #if os(iOS)
                .modifier(ReactorsMenu(reaction: r, enabled: enabled, onTap: onTap))
                #endif
                .accessibilityLabel("\(r.emoji) \(r.count)\(r.mine ? "、自分も付けた" : "")")
                .accessibilityHint(TimelineRules.reactorsNames(r) ?? "")
            }
        }
    }
}

#if os(iOS)
/// iPhone / iPad: holding a reaction shows who reacted (the web's hover list) over the
/// chip, with the reaction's own toggle under it.
private struct ReactorsMenu: ViewModifier {
    let reaction: Reaction
    let enabled: Bool
    let onTap: (String) -> Void

    func body(content: Content) -> some View {
        if reaction.reactors.isEmpty && reaction.count == 0 {
            content
        } else {
            content.contextMenu {
                if enabled {
                    Button(reaction.mine ? "\(reaction.emoji) を外す" : "\(reaction.emoji) を付ける") { onTap(reaction.emoji) }
                }
            } preview: {
                ReactorsList(reaction: reaction)
            }
        }
    }
}
#endif

/// 「❤️ 14人」 and who (the web's ReactionWhoList).
struct ReactorsList: View {
    let reaction: Reaction
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                ReactionGlyph(emoji: reaction.emoji)
                Text("\(reaction.count)人").font(.subheadline.bold())
            }
            if !reaction.reactors.isEmpty {
                let shown = reaction.reactors
                let hidden = TimelineRules.reactorsMore(reaction)
                (Text(shown.joined(separator: "、")) + Text(hidden > 0 ? " 他\(hidden)人" : "").foregroundStyle(.secondary))
                    .font(.subheadline)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(14)
        .frame(width: 260, alignment: .leading)
    }
}

/// Unicode emoji render as text; custom emoji (":name:") show the image from
/// the public catalog (GET /api/emojis), loaded once per launch.
struct ReactionGlyph: View {
    let emoji: String
    var size: CGFloat = 14
    var body: some View {
        if emoji.hasPrefix(":"), emoji.hasSuffix(":"), emoji.count > 2,
           let url = EmojiCatalog.shared.url(for: String(emoji.dropFirst().dropLast())) {
            // Cached (AsyncImage refetched it every time a row scrolled back into view).
            MediaImage(path: url.absoluteString, contentMode: .fit, maxPixel: 64)
                .frame(width: size, height: size)
        } else {
            Text(emoji).font(.caption)
        }
    }
}

@MainActor
@Observable
final class EmojiCatalog {
    static let shared = EmojiCatalog()
    private var urls: [String: URL] = [:]
    private var loaded = false

    func url(for name: String) -> URL? { urls[name] }
    var names: [String] { urls.keys.sorted() }

    /// GET /api/agent/emojis with the app's token (capabilities `custom_emoji_list`).
    func load(api: APIClient, path: String) async {
        guard !loaded, let list = try? await api.customEmojis(path: path) else { return }
        loaded = true
        for e in list {
            let base: URL? = e.imageUrl.hasPrefix("/") ? APIClient.baseURL : nil
            if let u = URL(string: e.imageUrl, relativeTo: base) { urls[e.name] = u.absoluteURL }
        }
    }

    func load() async {
        guard !loaded else { return }
        struct Item: Decodable { var name: String; var imageUrl: String }
        struct List: Decodable { var emojis: [Item] }
        guard let (data, _) = try? await URLSession.shared.data(from: APIClient.baseURL.appendingPathComponent("/api/emojis")),
              let list = try? JSONDecoder().decode(List.self, from: data) else { return }
        loaded = true
        for e in list.emojis {
            if let u = URL(string: e.imageUrl, relativeTo: APIClient.baseURL) { urls[e.name] = u.absoluteURL }
        }
    }
}

/// Avatars are cached in memory so scrolling and live updates never refetch.
struct AvatarView: View {
    let url: String?
    let name: String
    var size: CGFloat = 22
    @State private var image: PlatformImage?

    var body: some View {
        Group {
            if let image {
                Image(platformImage: image).resizable().scaledToFill()
            } else {
                Text(String(name.prefix(1))).font(.caption2.bold()).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.primary.opacity(0.08))
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .task(id: url) { image = await AvatarCache.shared.image(for: url) }
    }
}

/// Avatars: the same downscaled, off-main-thread decoding as post photos (some
/// members' profile pictures are full-size photos), cached by MediaCache.
@MainActor
final class AvatarCache {
    static let shared = AvatarCache()
    /// Largest avatar drawn (36 pt) at 3x, rounded up.
    static let pixels = 128

    func image(for raw: String?) async -> PlatformImage? {
        guard let raw, !raw.isEmpty else { return nil }
        return await MediaCache.shared.image(for: raw, maxPixel: Self.pixels)
    }
}


/// Photos in a chat bubble: one is shown wide, two to four as a 2-column grid of
/// squares. Decoded small (MediaImage), tap for full screen.
struct ChatPhotos: View {
    let paths: [String]
    /// Previews while the message is still being sent.
    var local: [PlatformImage] = []
    var onOpen: ((Int) -> Void)?

    private var count: Int { paths.isEmpty ? local.count : paths.count }

    var body: some View {
        if count == 1 {
            cell(0, width: 220, height: 165)
        } else {
            LazyVGrid(columns: [GridItem(.fixed(108), spacing: 4), GridItem(.fixed(108), spacing: 4)], spacing: 4) {
                ForEach(0..<count, id: \.self) { i in cell(i, width: 108, height: 108) }
            }
            .frame(width: 220, alignment: .leading)
        }
    }

    @ViewBuilder private func cell(_ i: Int, width: CGFloat, height: CGFloat) -> some View {
        Group {
            if paths.isEmpty {
                Image(platformImage: local[i]).resizable().scaledToFill()
            } else {
                MediaImage(path: paths[i], maxPixel: count == 1 ? 720 : 400)
            }
        }
        .frame(width: width, height: height)
        .clipped()
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .contentShape(Rectangle())
        .onTapGesture { if !paths.isEmpty { onOpen?(i) } }
        .accessibilityLabel("写真 \(i + 1)")
        .accessibilityAddTraits(.isButton)
    }
}
