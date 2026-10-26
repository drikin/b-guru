import Foundation

/// 🍻 アルバムをまとめて保存（docs/offkai-spec.md「アルバムをまとめて保存」）の名前の決まり。
/// Web の zip（lib/offkai.ts の albumZip・safeFilePart）と同じ名前になるように、同じ手順で作る:
///   フォルダ「B-guru オフ会 2026-10-26 題」、中は古い順に「001_表示名_1930.jpg」（日本時間の時分）。
/// 画面にも通信にも触らない（BguruChatTests で確かめる）。
enum OffkaiSaveNames {
    /// 日本時間（端末の地域によらない。サーバの jst() と同じ）。
    static let tokyo = TimeZone(identifier: "Asia/Tokyo")!

    /// JS の `\s`（正規表現の空白）と同じ文字。全角スペースも 1 つの空白にまとめる。
    private static let jsSpaces: Set<UInt32> = [
        0x09, 0x0A, 0x0B, 0x0C, 0x0D, 0x20, 0xA0, 0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005,
        0x2006, 0x2007, 0x2008, 0x2009, 0x200A, 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF,
    ]
    /// ファイル名に使えない記号（Windows でも開けるように、サーバと同じ）。
    private static let forbidden: Set<Character> = ["\\", "/", ":", "*", "?", "\"", "<", ">", "|"]

    /// ファイル名に使える形（サーバの safeFilePart と同じ）: 制御文字・書式制御文字（Cf）と \/:*?"<>| を落とし、空白をまとめて前後を削り、
    /// 先頭から `max` 文字（コードポイントで数える。JS の [...s] と同じ）、先頭の「.」は落とす。
    static func safePart(_ v: String, max: Int) -> String {
        var scalars: [Unicode.Scalar] = []
        var pendingSpace = false
        for s in v.unicodeScalars {
            // 書式制御文字（Cf: U+202E の向きの入れ替え・U+200B など）も落とす。U+FEFF も Cf なので空白より先に消える（サーバと同じ）。
            if s.value < 0x20 || s.value == 0x7F || forbidden.contains(Character(s)) || s.properties.generalCategory == .format { continue }
            if jsSpaces.contains(s.value) { pendingSpace = true; continue }
            if pendingSpace, !scalars.isEmpty { scalars.append(" ") }
            pendingSpace = false
            scalars.append(s)
        }
        var out = String(String.UnicodeScalarView(scalars.prefix(max)))
        while out.hasPrefix(".") { out.removeFirst() }
        return out
    }

    private static func formatter(_ pattern: String) -> DateFormatter {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.calendar = Calendar(identifier: .gregorian)
        f.timeZone = tokyo
        f.dateFormat = pattern
        return f
    }

    /// 保存先のフォルダ名「B-guru オフ会 2026-10-26 題」（題は 30 文字まで、無ければ日付まで）。
    static func folderName(title: String, startedAt: Date) -> String {
        let t = safePart(title, max: 30)
        let date = formatter("yyyy-MM-dd").string(from: startedAt)
        return "B-guru オフ会 \(date)\(t.isEmpty ? "" : " \(t)")"
    }

    /// 1 枚の名前「001_表示名_1930.jpg」。index は古い順の 0 始まり、count は全部の枚数（4 桁になれば 4 桁で揃える）。
    /// 名前が空なら「_表示名」を付けない。拡張子は元のファイルのものを小文字で。
    static func fileName(index: Int, count: Int, uploader: String, createdAt: Date, url: String) -> String {
        let width = Swift.max(3, String(count).count)
        let n = String(index + 1)
        let num = String(repeating: "0", count: Swift.max(0, width - n.count)) + n
        let who = safePart(uploader, max: 16)
        let hm = formatter("HHmm").string(from: createdAt)
        return "\(num)\(who.isEmpty ? "" : "_\(who)")_\(hm)\(fileExtension(url))"
    }

    /// 元のファイルの拡張子（「.jpg」、無ければ空。node の path.extname と同じく、名前の先頭の「.」は拡張子と見ない）。
    static func fileExtension(_ url: String) -> String {
        var path = url
        if let q = path.firstIndex(where: { $0 == "?" || $0 == "#" }) { path = String(path[..<q]) }
        let base = path.split(separator: "/", omittingEmptySubsequences: false).last.map(String.init) ?? path
        guard let dot = base.lastIndex(of: "."), dot != base.startIndex else { return "" }
        return base[dot...].lowercased()
    }

    /// 上書きしない名前: 使われていれば「名前 (2).jpg」「名前 (3).jpg」…（フォルダは題に「.」があっても末尾に付ける）。
    static func uniqueName(_ name: String, folder: Bool = false, isTaken: (String) -> Bool) -> String {
        guard isTaken(name) else { return name }
        let ext = folder ? "" : fileExtension(name)
        let stem = String(name.dropLast(ext.count))
        var i = 2
        while true {
            let candidate = "\(stem) (\(i))\(ext)"
            if !isTaken(candidate) { return candidate }
            i += 1
        }
    }

    /// 終わったときの一言（「40 枚を保存しました」「38 枚を保存、2 枚は失敗」）。
    static func resultMessage(saved: Int, failed: Int) -> String {
        failed == 0 ? "\(saved) 枚を保存しました" : "\(saved) 枚を保存、\(failed) 枚は失敗"
    }
}
