import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// 🐶 What the on-device Beagle can look up on the net (drikin 2026-10-24「ネットに検索もして欲しい」,
/// free services only — no key, no fee): the weather (Open-Meteo) and what something is (Japanese
/// Wikipedia). Looked up here from the question's words before the model answers — the small model
/// given them as tools did not call them and made the weather up (sunny 30 ℃ for a rainy day). Only
/// the place / word is sent to those services.
enum BeagleLookup {
    static let session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.timeoutIntervalForRequest = 8
        c.httpAdditionalHeaders = ["User-Agent": "B-guru Chat (bsm.backspace.fm)"]
        return URLSession(configuration: c)
    }()

    /// Dev only: BGURU_BEAGLE_PROMPT=1 prints each lookup to stderr.
    static func trace(_ s: String) {
        #if DEBUG
        if ProcessInfo.processInfo.environment["BGURU_BEAGLE_PROMPT"] != nil { FileHandle.standardError.write("[tool] \(s)\n".data(using: .utf8)!) }
        #endif
    }

    static func json(_ url: URL) async throws -> [String: Any] {
        let (data, resp) = try await session.data(from: url)
        guard (resp as? HTTPURLResponse)?.statusCode == 200,
              let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw URLError(.badServerResponse) }
        return obj
    }

    /// 「久留米 明日: くもり 最高 19℃ 最低 12℃ 降水確率 30%（Open-Meteo）」, or what went wrong.
    static func weather(place: String, day: Int) async -> String {
        let place = place.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !place.isEmpty else { return "場所がわからない" }
        do {
            // 「東京」「大阪」 alone are not found (「東京都」「大阪府」 are): try the usual endings too.
            var hit: [String: Any]?
            for name in [place, place + "市", place + "都", place + "府", place + "県", place + "町"] {
                var g = URLComponents(string: "https://geocoding-api.open-meteo.com/v1/search")!
                g.queryItems = [.init(name: "name", value: name), .init(name: "count", value: "1"), .init(name: "language", value: "ja")]
                if let h = (try await json(g.url!)["results"] as? [[String: Any]])?.first { hit = h; break }
            }
            guard let hit, let lat = hit["latitude"] as? Double, let lon = hit["longitude"] as? Double else { return "「\(place)」という場所が見つからない" }
            let name = (hit["name"] as? String) ?? place
            var f = URLComponents(string: "https://api.open-meteo.com/v1/forecast")!
            f.queryItems = [.init(name: "latitude", value: String(lat)), .init(name: "longitude", value: String(lon)),
                            .init(name: "daily", value: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"),
                            .init(name: "timezone", value: "Asia/Tokyo"), .init(name: "forecast_days", value: "3")]
            guard let daily = try await json(f.url!)["daily"] as? [String: Any] else { return "天気を取れなかった" }
            let i = max(0, min(2, day))
            func at<T>(_ k: String) -> T? { (daily[k] as? [Any]).flatMap { $0.indices.contains(i) ? $0[i] as? T : nil } }
            let code: Int = at("weather_code") ?? -1
            let hi: Double? = at("temperature_2m_max"), lo: Double? = at("temperature_2m_min")
            let rain: Int? = at("precipitation_probability_max")
            let label = ["今日", "明日", "あさって"][i]
            var s = "\(name) \(label): \(weatherWord(code))"
            if let hi { s += " 最高 \(Int(hi.rounded()))℃" }
            if let lo { s += " 最低 \(Int(lo.rounded()))℃" }
            if let rain { s += " 降水確率 \(rain)%" }
            return s + "（Open-Meteo）"
        } catch {
            return "天気を取れなかった（通信できない）"
        }
    }

    /// WMO weather codes in plain Japanese.
    static func weatherWord(_ c: Int) -> String {
        switch c {
        case 0: return "晴れ"
        case 1, 2: return "晴れ時々くもり"
        case 3: return "くもり"
        case 45, 48: return "霧"
        case 51...57: return "霧雨"
        case 61...67, 80...82: return "雨"
        case 71...77, 85, 86: return "雪"
        case 95...99: return "雷雨"
        default: return "不明"
        }
    }

    /// The summary of the Japanese Wikipedia article that best matches `word` (600 characters at most).
    static func wikipedia(_ word: String) async -> String {
        let word = word.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !word.isEmpty else { return "調べる言葉がない" }
        do {
            var s = URLComponents(string: "https://ja.wikipedia.org/w/api.php")!
            s.queryItems = [.init(name: "action", value: "query"), .init(name: "list", value: "search"), .init(name: "srsearch", value: word),
                            .init(name: "srlimit", value: "1"), .init(name: "format", value: "json")]
            guard let title = ((try await json(s.url!)["query"] as? [String: Any])?["search"] as? [[String: Any]])?.first?["title"] as? String
            else { return "Wikipedia に「\(word)」は見つからない" }
            let path = title.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? title
            guard let url = URL(string: "https://ja.wikipedia.org/api/rest_v1/page/summary/\(path)"),
                  let extract = try await json(url)["extract"] as? String, !extract.isEmpty else { return "Wikipedia の「\(title)」を読めなかった" }
            return "\(title)（Wikipedia）: " + String(extract.prefix(600))
        } catch {
            return "Wikipedia を読めなかった（通信できない）"
        }
    }
}


extension BeagleLookup {
    /// What to look up for `question`, done now: 「天気／気温／雨…」 → the weather of the place named;
    /// 「〇〇って誰／何／どんな…」 → 〇〇 on Wikipedia. nil when the question needs neither.
    static func facts(for question: String) async -> String? {
        let q = question.replacingOccurrences(of: "@" + BeagleOnDevice.name, with: "")
        if q.range(of: "天気|気温|雨|雪|予報|晴れ|寒い|暑い|傘", options: .regularExpression) != nil, let place = place(in: q) {
            let day = q.contains("あさって") || q.contains("明後日") ? 2 : (q.contains("明日") || q.contains("あした") ? 1 : 0)
            return await weather(place: place, day: day)
        }
        if let subject = subject(in: q) {
            return await wikipedia(subject)
        }
        return nil
    }

    /// The place in a weather question: its first word that is not about the weather or the day.
    static func place(in q: String) -> String? {
        let stop: Set<String> = ["天気", "気温", "予報", "明日", "今日", "明後日", "降水確率", "天気予報", "週末", "今週", "傘"]
        let re = try? NSRegularExpression(pattern: #"[\p{Han}\p{Katakana}ー]{2,}|[A-Za-z]{3,}"#)
        let ns = q as NSString
        for m in re?.matches(in: q, range: NSRange(location: 0, length: ns.length)) ?? [] {
            var w = ns.substring(with: m.range)
            for s in stop { w = w.replacingOccurrences(of: s, with: "") }
            if w.count >= 2 { return w }
        }
        return nil
    }

    /// 〇〇 in 「〇〇って誰／何／どんな…」「〇〇とは」「〇〇は誰／何」.
    static func subject(in q: String) -> String? {
        // Not 「…は何個」: only 「〇〇って／とは …」 and 「〇〇は誰」 (「赤は何個？」 looked up ピクミン).
        let pattern = #"^\s*([^、。？?！!]{2,30}?)\s*(?:(?:って|とは)\s*(?:誰|だれ|何|なに|なん|どんな|どういう|どこ)|は\s*(?:誰|だれ)(?:です)?\s*[？?]?\s*$)"#
        guard let re = try? NSRegularExpression(pattern: pattern),
              let m = re.firstMatch(in: q, range: NSRange(location: 0, length: (q as NSString).length)) else { return nil }
        let w = (q as NSString).substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespacesAndNewlines.union(.punctuationCharacters))
        return w.count >= 2 ? w : nil
    }
}
