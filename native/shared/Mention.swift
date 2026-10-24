import SwiftUI

/// A member that can be @mentioned (GET /api/agent/members — no email).
struct MentionMember: Codable, Identifiable, Hashable, Sendable {
    var userId: String
    var name: String
    var avatar: String?
    var id: String { userId }
}

/// @mention helpers shared by the Mac and iOS composers. Same token format as
/// the web (src/lib/chat-mention.ts): `@name ` or `@[First Last] `.
enum Mention {
    static func token(_ name: String) -> String {
        name.contains(where: \.isWhitespace) ? "@[\(name)] " : "@\(name) "
    }

    /// Lower-cased, all whitespace (incl. full-width) removed — like normWs.
    static func norm(_ s: String) -> String {
        s.lowercased().filter { !$0.isWhitespace && $0 != "\u{3000}" }
    }

    /// The "@query" being typed at the end of `text` (nil when not mentioning):
    /// an `@` at the start or after whitespace, then no whitespace (or `@[` …
    /// without the closing `]`).
    static func activeQuery(in text: String) -> (start: String.Index, query: String)? {
        guard let at = text.lastIndex(of: "@") else { return nil }
        if at > text.startIndex {
            let before = text[text.index(before: at)]
            guard before.isWhitespace else { return nil }
        }
        var rest = text[text.index(after: at)...]
        if rest.hasPrefix("[") {
            rest = rest.dropFirst()
            if rest.contains("]") { return nil }
            return (at, String(rest))
        }
        if rest.contains(where: \.isWhitespace) { return nil }
        return (at, String(rest))
    }

    /// Replace the "@query" at the end with the member's token.
    static func complete(_ text: String, with name: String) -> String {
        guard let q = activeQuery(in: text) else { return text + token(name) }
        return String(text[..<q.start]) + token(name)
    }

    /// Up to `limit` matches: names containing the query (prefix matches first),
    /// people active in the chat recently ranked before everyone else.
    static func candidates(_ members: [MentionMember], query: String, recent: [String], limit: Int = 6) -> [MentionMember] {
        let q = norm(query)
        let recentRank = Dictionary(recent.enumerated().map { ($1, $0) }, uniquingKeysWith: { a, _ in a })
        return members
            .filter { q.isEmpty || norm($0.name).contains(q) }
            .sorted { a, b in
                let ap = norm(a.name).hasPrefix(q), bp = norm(b.name).hasPrefix(q)
                if ap != bp { return ap }
                let ar = recentRank[a.name] ?? Int.max, br = recentRank[b.name] ?? Int.max
                if ar != br { return ar < br }
                return a.name < b.name
            }
            .prefix(limit)
            .map { $0 }
    }
}

/// The suggestion strip above the composer.
struct MentionSuggestions: View {
    let members: [MentionMember]
    let onPick: (MentionMember) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(members.enumerated()), id: \.element.id) { idx, m in
                Button { onPick(m) } label: {
                    HStack(spacing: 8) {
                        AvatarView(url: m.avatar, name: m.name)
                        Text(m.name).lineLimit(1)
                        Spacer()
                        if idx == 0 {
                            Text("⏎").font(.app(.caption)).foregroundStyle(.tertiary)
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("\(m.name) をメンション")
                if idx < members.count - 1 { Divider() }
            }
        }
        .background(RoundedRectangle(cornerRadius: 10).fill(.background).shadow(color: .black.opacity(0.12), radius: 4, y: 1))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Color.primary.opacity(0.08)))
    }
}

/// Read-only sheet to select and copy part of a message (iOS: a long press
/// opens the message menu, so text selection lives here).
struct SelectableTextSheet: View {
    let author: String
    let text: String
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                Text(text)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding()
            }
            .navigationTitle(author)
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("閉じる") { dismiss() } }
                ToolbarItem(placement: .primaryAction) {
                    Button("すべてコピー") {
                        Platform.copy(text)
                        dismiss()
                    }
                }
            }
        }
    }
}
