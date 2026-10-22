import SwiftUI

/// A post's text with its Markdown drawn, like the web timeline (src/lib/md.ts: GFM,
/// line breaks kept). Headings, lists, quotes, rules and code blocks are blocks; bold,
/// italic, `code`, ~~strike~~ and [links](…) inside them. Bare URLs stay tappable.
/// The post's mentions (its display's `mention_ranges`, TimelineRules.mentionNames) are drawn
/// like the web's: green, bold, on a light green rounded background
/// (`.post-body a[href^="#mention-"]`); any other @ is plain text. Text with no Markdown in it
/// is one paragraph.
struct PostText: View {
    let text: String
    /// The names the post mentions (TimelineRules.mentionNames); nil → the members list.
    var mentions: [String]? = nil

    var body: some View {
        let blocks = PostMarkdown.blocks(text, mentions: mentions)
        if blocks.count == 1, case .paragraph(let a) = blocks[0] {
            paragraph(a)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in block(b) }
            }
        }
    }

    private func paragraph(_ a: AttributedString) -> some View {
        MentionText(a)
            .font(.body)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private func block(_ b: PostMarkdown.Block) -> some View {
        switch b {
        case .paragraph(let a):
            paragraph(a)
        case .heading(let level, let a):
            MentionText(a)
                .font(level == 1 ? .title3.bold() : level == 2 ? .headline : .subheadline.bold())
                .fixedSize(horizontal: false, vertical: true)
                .padding(.top, 2)
        case .item(let indent, let marker, let a):
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(marker).font(.body).foregroundStyle(.secondary).monospacedDigit()
                paragraph(a)
            }
            .padding(.leading, CGFloat(indent) * 16 + 2)
        case .quote(let a):
            paragraph(a)
                .foregroundStyle(.secondary)
                .padding(.leading, 10)
                .overlay(alignment: .leading) {
                    RoundedRectangle(cornerRadius: 1.5).fill(Color.secondary.opacity(0.35)).frame(width: 3)
                }
        case .code(let s):
            Text(s)
                .font(.system(.callout, design: .monospaced))
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(RoundedRectangle(cornerRadius: 6).fill(Color.primary.opacity(0.06)))
        case .rule:
            Divider().padding(.vertical, 4)
        }
    }
}

/// Text whose member @mentions sit on a rounded light-green background. The mention runs
/// carry `MentionKey`; on macOS 15 / iOS 18 `MentionRenderer` draws one rounded shape behind
/// each (no background colour on the text itself, which drew a seam between runs); older
/// systems get a plain square background colour instead. Text without a mention is a plain `Text`.
struct MentionText: View {
    let a: AttributedString
    init(_ a: AttributedString) { self.a = a }

    var body: some View {
        if PostMarkdown.hasMention(a) {
            if #available(macOS 15.0, iOS 18.0, *) {
                PostMarkdown.mentionText(a).textRenderer(MentionRenderer())
            } else {
                Text(PostMarkdown.squareBackgrounds(a))
            }
        } else {
            Text(a)
        }
    }
}

/// Marks a mention's run in a post's text (read by MentionText; Text itself ignores it).
enum MentionKey: AttributedStringKey {
    typealias Value = Bool
    static let name = "fm.backspace.bguru.mention"
}

@available(macOS 15.0, iOS 18.0, *)
struct MentionMark: TextAttribute {}

/// Draws a rounded tint behind each mention run, then the text.
@available(macOS 15.0, iOS 18.0, *)
struct MentionRenderer: TextRenderer {
    func draw(layout: Text.Layout, in ctx: inout GraphicsContext) {
        for line in layout {
            // A mention can be several runs (the @ and a Japanese name come from different
            // fonts): one rounded shape over the runs next to each other.
            var chip: CGRect?
            func flush() {
                if let r = chip {
                    ctx.fill(Path(roundedRect: r.insetBy(dx: -3, dy: -1), cornerRadius: 4), with: .color(Color.accentGreen.opacity(0.14)))
                }
                chip = nil
            }
            for run in line {
                if run[MentionMark.self] != nil {
                    let r = run.typographicBounds.rect
                    chip = chip.map { $0.union(r) } ?? r
                } else {
                    flush()
                }
            }
            flush()
            for run in line { ctx.draw(run) }
        }
    }
}

@MainActor
enum PostMarkdown {
    enum Block {
        case paragraph(AttributedString)
        case heading(Int, AttributedString)
        /// A list item: nesting level, "•" or "1.", text.
        case item(Int, String, AttributedString)
        case quote(AttributedString)
        case code(String)
        case rule
    }

    private final class Box { let value: [Block]; init(_ v: [Block]) { value = v } }
    private static let cache: NSCache<NSString, Box> = {
        let c = NSCache<NSString, Box>()
        c.countLimit = 500
        return c
    }()

    /// Parsed once per text (rows redraw on every scroll and live update), and again when
    /// the members list changes (it decides which @ are mentions).
    static func blocks(_ s: String, mentions: [String]? = nil) -> [Block] {
        let key = "\(MemberDirectory.shared.generation)|\(mentions?.joined(separator: "\u{1}") ?? "-")|\(s)" as NSString
        if let hit = cache.object(forKey: key) { return hit.value }
        let names = mentions.map { Set($0.map { $0.lowercased() }) }
        let b = withMentions(names) { looksLikeMarkdown(s) ? parse(s) : [.paragraph(plain(s))] }
        cache.setObject(Box(b), forKey: key)
        return b
    }

    /// The names the text being parsed may mention (nil → the members list).
    private static var mentionNames: Set<String>?
    private static func withMentions<T>(_ names: Set<String>?, _ run: () -> T) -> T {
        mentionNames = names
        defer { mentionNames = nil }
        return run()
    }
    private static func isMention(_ name: String) -> Bool {
        if let mentionNames { return mentionNames.contains(name.lowercased()) }
        return MemberDirectory.shared.contains(name)
    }

    private static let hint = try? NSRegularExpression(
        pattern: #"(^|\n)[ \t]*(#{1,6}[ \t]|[-*+][ \t]|\d+[.)][ \t]|>|```|(-{3,}|\*{3,}|_{3,})[ \t]*(\n|$))|\*\*|__|~~|`|\[[^\]\n]+\]\([^)\s]+\)|(^|[\s(])[*_][^\s*_]"#)

    static func looksLikeMarkdown(_ s: String) -> Bool {
        hint?.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)) != nil
    }

    private static let headingRe = try? NSRegularExpression(pattern: #"^[ \t]*(#{1,6})[ \t]+(.*?)[ \t#]*$"#)
    private static let ruleRe = try? NSRegularExpression(pattern: #"^[ \t]*(-[ \t]*){3,}$|^[ \t]*(\*[ \t]*){3,}$|^[ \t]*(_[ \t]*){3,}$"#)
    private static let itemRe = try? NSRegularExpression(pattern: #"^([ \t]*)([-*+]|\d{1,3}[.)])[ \t]+(.*)$"#)

    private static func groups(_ re: NSRegularExpression?, _ line: String) -> [String]? {
        guard let re, let m = re.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)) else { return nil }
        return (0..<m.numberOfRanges).map { i in
            Range(m.range(at: i), in: line).map { String(line[$0]) } ?? ""
        }
    }

    static func parse(_ s: String) -> [Block] {
        var out: [Block] = []
        var para: [String] = []
        var quote: [String] = []
        func flush() {
            if !para.isEmpty { out.append(.paragraph(inline(para.joined(separator: "\n")))); para = [] }
            if !quote.isEmpty { out.append(.quote(inline(quote.joined(separator: "\n")))); quote = [] }
        }
        let lines = s.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
        var i = 0
        while i < lines.count {
            let line = lines[i]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            if trimmed.hasPrefix("```") {
                flush()
                var code: [String] = []
                i += 1
                while i < lines.count, !lines[i].trimmingCharacters(in: .whitespaces).hasPrefix("```") {
                    code.append(lines[i]); i += 1
                }
                out.append(.code(code.joined(separator: "\n")))
                i += 1
                continue
            }
            if trimmed.isEmpty {
                flush()
            } else if let g = groups(headingRe, line) {
                flush()
                out.append(.heading(g[1].count, inline(g[2])))
            } else if groups(ruleRe, line) != nil {
                flush()
                out.append(.rule)
            } else if let g = groups(itemRe, line) {
                flush()
                let indent = g[1].replacingOccurrences(of: "\t", with: "  ").count / 2
                let marker = g[2].first?.isNumber == true ? g[2].replacingOccurrences(of: ")", with: ".") : "•"
                out.append(.item(min(indent, 4), marker, inline(g[3])))
            } else if trimmed.hasPrefix(">") {
                if !para.isEmpty { out.append(.paragraph(inline(para.joined(separator: "\n")))); para = [] }
                quote.append(String(trimmed.dropFirst()).trimmingCharacters(in: .whitespaces))
            } else {
                if !quote.isEmpty { out.append(.quote(inline(quote.joined(separator: "\n")))); quote = [] }
                para.append(line)
            }
            i += 1
        }
        flush()
        return out.isEmpty ? [.paragraph(plain(s))] : out
    }

    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    /// The web's two forms (highlightMentions in src/app/page.tsx): `@[Full Name]` and `@name`.
    private static let mentionRegex = try? NSRegularExpression(pattern: #"@\[([^\]]+)\]|@([^"# + TimelineRules.jsSpace + #"@<\[]+)"#)
    /// The mention's background (MentionRenderer, or the square fallback).
    static let mentionBackground = Color.accentGreen.opacity(0.14)

    /// Text without Markdown: links and mentions only.
    static func plain(_ s: String) -> AttributedString { decorate(AttributedString(s)) }

    /// Bold / italic / code / strike / links inside a block, then bare URLs and @mentions.
    static func inline(_ s: String) -> AttributedString {
        decorate((try? AttributedString(
            markdown: s,
            options: .init(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        )) ?? AttributedString(s))
    }

    private static func decorate(_ input: AttributedString) -> AttributedString {
        var a = input
        let plain = String(a.characters)
        func range(_ ns: NSRange) -> Range<AttributedString.Index>? {
            guard let r = Range(ns, in: plain) else { return nil }
            let lo = plain.distance(from: plain.startIndex, to: r.lowerBound)
            let n = plain.distance(from: r.lowerBound, to: r.upperBound)
            let start = a.characters.index(a.startIndex, offsetBy: lo)
            return start..<a.characters.index(start, offsetBy: n)
        }
        let all = NSRange(plain.startIndex..., in: plain)
        for m in linkDetector?.matches(in: plain, range: all) ?? [] {
            guard let url = m.url, let r = range(m.range), a[r].link == nil else { continue }
            a[r].link = url
        }
        // From the end, so replacing `@[Full Name]` with `@Full Name` (as the web shows it)
        // leaves the earlier matches where they were.
        for m in (mentionRegex?.matches(in: plain, range: all) ?? []).reversed() {
            let bracket = m.range(at: 1).location != NSNotFound
            guard let nr = Range(m.range(at: bracket ? 1 : 2), in: plain), let r = range(m.range) else { continue }
            let name = String(plain[nr])
            guard isMention(name) else { continue }
            var chip = AttributedString("@" + name)
            chip.foregroundColor = Color.accentGreen
            chip.inlinePresentationIntent = .stronglyEmphasized
            chip[MentionKey.self] = true
            if bracket {
                a.replaceSubrange(r, with: chip)
            } else {
                a[r].foregroundColor = Color.accentGreen
                a[r].inlinePresentationIntent = (a[r].inlinePresentationIntent ?? []).union(.stronglyEmphasized)
                a[r][MentionKey.self] = true
                a[r].link = nil
            }
        }
        return a
    }

    static func hasMention(_ a: AttributedString) -> Bool {
        a.runs.contains { $0[MentionKey.self] == true }
    }

    /// Before macOS 15 / iOS 18: the mention's background as a plain (square) colour.
    static func squareBackgrounds(_ a: AttributedString) -> AttributedString {
        var out = a
        for run in a.runs where run[MentionKey.self] == true { out[run.range].backgroundColor = mentionBackground }
        return out
    }

    /// The same text as one `Text`, the mention runs marked for MentionRenderer (and without
    /// the square background, which the renderer replaces).
    @available(macOS 15.0, iOS 18.0, *)
    static func mentionText(_ a: AttributedString) -> Text {
        var out = Text(verbatim: "")
        for run in a.runs {
            let part = AttributedString(a[run.range])
            if run[MentionKey.self] == true {
                out = out + Text(part).customAttribute(MentionMark())
            } else {
                out = out + Text(part)
            }
        }
        return out
    }
}
