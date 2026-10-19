import SwiftUI

/// A post's text with its Markdown drawn, like the web timeline (src/lib/md.ts: GFM,
/// line breaks kept). Headings, lists, quotes, rules and code blocks are blocks; bold,
/// italic, `code`, ~~strike~~ and [links](…) inside them. Bare URLs stay tappable and
/// @mentions green. Text with no Markdown in it is drawn exactly as before.
struct PostText: View {
    let text: String

    var body: some View {
        let blocks = PostMarkdown.blocks(text)
        if blocks.count == 1, case .paragraph(let a) = blocks[0] {
            paragraph(a)
        } else {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in block(b) }
            }
        }
    }

    private func paragraph(_ a: AttributedString) -> some View {
        Text(a)
            .font(.body)
            .multilineTextAlignment(.leading)
            .fixedSize(horizontal: false, vertical: true)
    }

    @ViewBuilder private func block(_ b: PostMarkdown.Block) -> some View {
        switch b {
        case .paragraph(let a):
            paragraph(a)
        case .heading(let level, let a):
            Text(a)
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

    /// Parsed once per text (rows redraw on every scroll and live update).
    static func blocks(_ s: String) -> [Block] {
        if let hit = cache.object(forKey: s as NSString) { return hit.value }
        let b = looksLikeMarkdown(s) ? parse(s) : [.paragraph(MessageRow.attributed(s))]
        cache.setObject(Box(b), forKey: s as NSString)
        return b
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
        return out.isEmpty ? [.paragraph(MessageRow.attributed(s))] : out
    }

    private static let linkDetector = try? NSDataDetector(types: NSTextCheckingResult.CheckingType.link.rawValue)
    private static let mentionRegex = try? NSRegularExpression(pattern: "@\\[[^\\]]+\\]|@[^\\s@\\[\\]]+")

    /// Bold / italic / code / strike / links inside a block, then bare URLs and @mentions.
    static func inline(_ s: String) -> AttributedString {
        var a = (try? AttributedString(
            markdown: s,
            options: .init(allowsExtendedAttributes: false, interpretedSyntax: .inlineOnlyPreservingWhitespace, failurePolicy: .returnPartiallyParsedIfPossible)
        )) ?? AttributedString(s)
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
        for m in mentionRegex?.matches(in: plain, range: all) ?? [] {
            guard let r = range(m.range) else { continue }
            a[r].foregroundColor = Color.accentGreen
        }
        return a
    }
}
