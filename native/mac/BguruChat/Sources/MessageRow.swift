import AppKit
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

    static let quick = ["❤️", "👍", "😂", "🎉", "🙏", "👀"]

    private var m: ChatMessage { row.message }
    private var mine: Bool { m.isAuthor }

    var body: some View {
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
                            Button("再送", action: onRetry).buttonStyle(.link).font(.caption)
                            Button("取り消す", action: onDiscard).buttonStyle(.link).font(.caption).tint(.secondary)
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
        .opacity(row.state == .pending ? 0.6 : 1)
        .animation(.easeOut(duration: 0.15), value: row.state)
        .contextMenu { menu }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(mine ? "自分" : (m.authorName ?? ""))、\(m.body)\(m.mentionsMe ? "、あなたへのメンション" : "")\(row.state == .failed ? "、送信失敗" : "")")
    }

    private var bubble: some View {
        let emojiOnly = Self.isEmojiOnly(m.body)
        return Text(Self.attributed(m.body))
            .font(emojiOnly ? .system(size: 34) : .body)
            .textSelection(.enabled)
            .padding(.horizontal, emojiOnly ? 4 : 10)
            .padding(.vertical, emojiOnly ? 0 : 6)
            .background(
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(emojiOnly ? Color.clear : (mine ? Color.accentGreen.opacity(0.14)
                        : (m.mentionsMe ? Color.yellow.opacity(0.22) : Color.primary.opacity(0.06))))
            )
            .onTapGesture(count: 2) { if canReact && m.id > 0 { onReact("❤️") } }
    }

    @ViewBuilder private var menu: some View {
        if canReact && m.id > 0 {
            ForEach(Self.quick, id: \.self) { e in Button(e) { onReact(e) } }
            Divider()
        }
        if mine && canEdit && m.id > 0 { Button("編集", action: onEdit) }
        Button("テキストをコピー") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(m.body, forType: .string)
        }
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

    static func time(_ s: String) -> String {
        guard let d = isoFrac.date(from: s) ?? iso.date(from: s) else { return "" }
        return hm.string(from: d)
    }

    static func isEmojiOnly(_ s: String) -> Bool {
        let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty, t.count <= 3 else { return false }
        return t.unicodeScalars.allSatisfy { $0.properties.isEmojiPresentation || $0.properties.isEmoji && $0.value > 0x238C || $0.value == 0x200D || $0.value == 0xFE0F }
    }

    /// Links become clickable; @mentions get a subtle tint.
    static func attributed(_ s: String) -> AttributedString {
        var a = AttributedString(s)
        if let det = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue) {
            let ns = s as NSString
            for match in det.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
                guard let url = match.url, let r = Range(match.range, in: s),
                      let ar = Range(r, in: a) else { continue }
                a[ar].link = url
            }
        }
        if let re = try? NSRegularExpression(pattern: "@\\[[^\\]]+\\]|@[^\\s@\\[\\]]+") {
            for match in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
                guard let r = Range(match.range, in: s), let ar = Range(r, in: a) else { continue }
                a[ar].foregroundColor = Color.accentGreen
            }
        }
        return a
    }
}

struct ReactionChips: View {
    let reactions: [Reaction]
    let enabled: Bool
    let onTap: (String) -> Void

    var body: some View {
        HStack(spacing: 4) {
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
                .help(r.reactors.joined(separator: "、"))
                .accessibilityLabel("\(r.emoji) \(r.count)\(r.mine ? "、自分も付けた" : "")")
            }
        }
    }
}

/// Unicode emoji render as text; custom emoji (":name:") show the image from
/// the public catalog (GET /api/emojis), loaded once per launch.
struct ReactionGlyph: View {
    let emoji: String
    var body: some View {
        if emoji.hasPrefix(":"), emoji.hasSuffix(":"), emoji.count > 2,
           let url = EmojiCatalog.shared.url(for: String(emoji.dropFirst().dropLast())) {
            AsyncImage(url: url) { img in
                img.resizable().scaledToFit()
            } placeholder: { Text(emoji).font(.caption2) }
            .frame(width: 14, height: 14)
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
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                Text(String(name.prefix(1))).font(.caption2.bold()).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Color.primary.opacity(0.08))
            }
        }
        .frame(width: 22, height: 22)
        .clipShape(Circle())
        .task(id: url) { image = await AvatarCache.shared.image(for: url) }
    }
}

@MainActor
final class AvatarCache {
    static let shared = AvatarCache()
    private var cache: [String: NSImage] = [:]

    func image(for raw: String?) async -> NSImage? {
        guard let raw, !raw.isEmpty else { return nil }
        if let hit = cache[raw] { return hit }
        let url = raw.hasPrefix("http") ? URL(string: raw) : URL(string: raw, relativeTo: APIClient.baseURL)
        guard let url, let (data, _) = try? await URLSession.shared.data(from: url), let img = NSImage(data: data) else { return nil }
        cache[raw] = img
        return img
    }
}
