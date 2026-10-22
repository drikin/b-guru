import AppKit
import Foundation
#if canImport(FoundationModels)
import FoundationModels
#endif

/// 端末内 AI（macOS の Foundation モデル）がタイムラインから「この人が興味を持ちそうな投稿」を選び、ティッカーで知らせる（設定、既定は切）。
///
/// - すべてこの Mac の中だけ：投稿の中身・興味の記録はサーバーにも外部にも送らない（モデルも端末内）。statusbar.log に本文は書かない。
/// - 興味の材料（既存のタイムラインとアプリの中で取れるものだけ）: 自分の投稿、自分がリアクションした投稿、この Mac で開いたスレッド・返信したスレッド
///   （開いた記録はこの機能がオンのあいだだけ、最大 200 件を Application Support/AIPicks/memory.json に）、自分の投稿・リアクションの部活。
///   1 日 1 回、AI で 200 字以内の「興味のまとめ」にする（材料が少ないときは要約せず、題材を短く並べて渡す）。
/// - 1 時間ごと（アプリが起きていて、前回より新しい投稿があるとき。低電力モード・静かな時間・チャットを見ているあいだはしない）:
///   未読・自分のでない・まだおすすめしていない投稿を最大 30 件、6 件ずつ（1 件 160 字に詰めて文脈の長さに収める）採点させ、
///   合う度 7 以上の最上位 1 件だけをティッカーで「🐶 おすすめ：○○さん『ひとこと』」。1 日 6 件まで、同じ投稿は二度出さない。
/// - AI の失敗（ガードレール・文脈超過・未対応の言語・そのほか）は黙って次回へ（ログに理由の種類だけ）。
/// - FoundationModels は macOS 26 から。アプリは macOS 14 からなので、#if canImport と #available で囲む（それより前は設定も出ない）。
@MainActor
final class AIPicks {
    struct Topic: Codable {
        var id: Int
        var text: String
        var at: Date
    }
    struct Memory: Codable {
        var opened: [Topic] = []
        var replied: [Topic] = []
        var summary = ""
        var summaryAt: Date?
        var picked: [Int] = []
        var day = ""
        var dayCount = 0
        var lastRunAt: Date?
        var lastSeenNewest = 0
    }

    static let maxTopics = 200
    static let maxPerDay = 6
    static let minScore = 7
    static let batchSize = 6
    static let maxCandidates = 30
    static let interval: TimeInterval = 3600

    static var directory: URL { HangWatch.directory.deletingLastPathComponent().appendingPathComponent("AIPicks", isDirectory: true) }
    static var fileURL: URL { directory.appendingPathComponent("memory.json") }

    private(set) var memory = Memory()
    weak var timeline: TimelineStore?
    /// しないときの理由（チャットを見ている・静かな時間）。nil = してよい。
    var blockedReason: () -> String? = { nil }
    /// おすすめが決まった（ティッカーへ）。
    var onPick: ((_ text: String, _ postId: Int) -> Void)?
    private var timer: Timer?
    private var running = false
    #if DEBUG
    /// 開発のみ：静かな時間・新しい投稿の有無・1 日の上限を無視してすぐ回す。
    var debugForce = false
    #endif

    var enabled = false {
        didSet {
            guard enabled != oldValue else { return }
            if enabled {
                start()
            } else {
                // オフにしたら興味の記録も消す（端末の中だけとはいえ、使わない記録は残さない）。
                stop()
                memory = Memory()
                Self.eraseMemory()
            }
        }
    }

    init() {
        if let d = try? Data(contentsOf: Self.fileURL), let m = try? JSONDecoder().decode(Memory.self, from: d) { memory = m }
    }

    // MARK: - 使えるか

    /// 端末内 AI が使えるか。使えないときは理由（設定の下に 1 行で出す）。
    static func availability() -> (ok: Bool, reason: String?) {
        #if canImport(FoundationModels)
        if #available(macOS 26, *) {
            let model = SystemLanguageModel.default
            switch model.availability {
            case .available:
                if !model.supportsLocale(Locale(identifier: "ja_JP")) { return (false, "この Mac の端末内 AI は日本語に対応していません") }
                return (true, nil)
            case .unavailable(.deviceNotEligible): return (false, "この Mac は Apple Intelligence に対応していません")
            case .unavailable(.appleIntelligenceNotEnabled): return (false, "Apple Intelligence がオフです（システム設定でオンにすると使えます）")
            case .unavailable(.modelNotReady): return (false, "端末内 AI を準備中です（しばらくすると使えます）")
            case .unavailable: return (false, "端末内 AI を使えません")
            }
        }
        return (false, "macOS 26 以降で使えます")
        #else
        return (false, "このビルドでは使えません")
        #endif
    }

    // MARK: - 興味の材料（オンのあいだだけ記録）

    func noteOpened(_ p: Post) {
        guard enabled, !p.mine else { return }
        memory.opened.removeAll { $0.id == p.id }
        memory.opened.append(Topic(id: p.id, text: Self.short(p.text, 120), at: Date()))
        if memory.opened.count > Self.maxTopics { memory.opened.removeFirst(memory.opened.count - Self.maxTopics) }
        save()
    }

    func noteReplied(_ rootId: Int) {
        guard enabled else { return }
        let text = timeline?.posts.first(where: { $0.id == rootId }).map { Self.short($0.text, 120) }
            ?? memory.opened.last(where: { $0.id == rootId })?.text ?? ""
        guard !text.isEmpty else { return }
        memory.replied.removeAll { $0.id == rootId }
        memory.replied.append(Topic(id: rootId, text: text, at: Date()))
        if memory.replied.count > Self.maxTopics { memory.replied.removeFirst(memory.replied.count - Self.maxTopics) }
        save()
    }

    private func save() {
        do {
            try FileManager.default.createDirectory(at: Self.directory, withIntermediateDirectories: true)
            try JSONEncoder().encode(memory).write(to: Self.fileURL, options: [.atomic])
        } catch {
            StatusBarDiag.note("AI おすすめ: 記録を保存できない")
        }
    }

    // MARK: - 定期的に

    private func start() {
        timer?.invalidate()
        let t = Timer(timeInterval: Self.interval, repeats: true) { [weak self] _ in
            MainActor.assumeIsolated { self?.runIfDue() }
        }
        t.tolerance = 300
        RunLoop.main.add(t, forMode: .common)
        timer = t
        prewarm()
        // 起動・オンにしてから 2 分後に 1 回目（前回から 1 時間たっていれば）
        DispatchQueue.main.asyncAfter(deadline: .now() + 120) { [weak self] in self?.runIfDue() }
    }

    private func stop() {
        timer?.invalidate()
        timer = nil
    }

    private func runIfDue() {
        guard enabled else { return }
        if let last = memory.lastRunAt, Date().timeIntervalSince(last) < Self.interval - 60 { return }
        Task { await run() }
    }

    private func prewarm() {
        #if canImport(FoundationModels)
        if #available(macOS 26, *), Self.availability().ok {
            LanguageModelSession(instructions: Self.scoreInstructions).prewarm()
        }
        #endif
    }

    /// 1 回分：条件を見て、興味のまとめ（1 日 1 回）→ 採点 → 最上位 1 件をティッカーへ。
    func run() async {
        guard enabled, !running else { return }
        var force = false
        #if DEBUG
        force = debugForce
        #endif
        guard Self.availability().ok else { StatusBarDiag.note("AI おすすめ: しない（端末内 AI を使えない）"); return }
        if ProcessInfo.processInfo.isLowPowerModeEnabled { StatusBarDiag.note("AI おすすめ: しない（低電力モード）"); return }
        if !force, let why = blockedReason() { StatusBarDiag.note("AI おすすめ: しない（\(why)）"); return }
        let today = Self.dayKey(Date())
        if memory.day != today { memory.day = today; memory.dayCount = 0 }
        if !force, memory.dayCount >= Self.maxPerDay { StatusBarDiag.note("AI おすすめ: しない（今日は \(Self.maxPerDay) 件出した）"); return }
        guard let timeline else { return }
        running = true
        defer { running = false }
        await timeline.refresh()
        let posts = timeline.posts
        let newest = posts.map(\.id).max() ?? 0
        if !force, newest <= memory.lastSeenNewest { StatusBarDiag.note("AI おすすめ: しない（新しい投稿なし）"); return }
        memory.lastRunAt = Date()
        memory.lastSeenNewest = max(memory.lastSeenNewest, newest)
        save()
        let picked = Set(memory.picked)
        let opened = Set(memory.opened.map(\.id))
        let candidates = posts.filter { !$0.mine && $0.unread == true && !picked.contains($0.id) && !opened.contains($0.id) }
            .prefix(Self.maxCandidates)
        guard !candidates.isEmpty else { StatusBarDiag.note("AI おすすめ: 候補なし"); return }
        #if canImport(FoundationModels)
        if #available(macOS 26, *) {
            let interest = await interestText(posts: posts, clubs: timeline.clubs)
            guard !interest.isEmpty else { StatusBarDiag.note("AI おすすめ: 興味の材料がない"); return }
            let started = Date()
            #if DEBUG
            NSLog("[ai] 採点を始める（候補 %d 件）", candidates.count)
            #endif
            var scored: [(post: Post, score: Int, note: String)] = []
            var failures = 0
            for batch in stride(from: 0, to: candidates.count, by: Self.batchSize).map({ Array(candidates.dropFirst($0).prefix(Self.batchSize)) }) {
                do {
                    #if DEBUG
                    let tb = Date()
                    #endif
                    scored += try await score(batch, interest: interest, clubs: timeline.clubs)
                    #if DEBUG
                    NSLog("[ai] %d 件を %.1f 秒", batch.count, Date().timeIntervalSince(tb))
                    #endif
                } catch {
                    failures += 1
                    StatusBarDiag.note("AI おすすめ: 採点に失敗（\(Self.reason(error))）")
                    #if DEBUG
                    NSLog("[ai] 採点の失敗: %@ / %@", String(describing: type(of: error)), String(describing: error))
                    #endif
                }
            }
            let elapsed = Date().timeIntervalSince(started)
            #if DEBUG
            for s in scored.sorted(by: { $0.score > $1.score }) {
                NSLog("[ai] %d点 %d %@『%@』← %@", s.score, s.post.id, s.post.authorName ?? "-", s.note, Self.short(s.post.text, 24))
            }
            NSLog("[ai] 採点 %d 件・失敗 %d 回・%.1f 秒", scored.count, failures, elapsed)
            #endif
            guard let best = scored.filter({ $0.score >= Self.minScore }).max(by: { $0.score < $1.score }) else {
                StatusBarDiag.note(String(format: "AI おすすめ: 合うものなし（%d 件を採点、%.0f 秒）", scored.count, elapsed))
                return
            }
            memory.picked.append(best.post.id)
            if memory.picked.count > 500 { memory.picked.removeFirst(memory.picked.count - 500) }
            memory.dayCount += 1
            save()
            StatusBarDiag.note(String(format: "AI おすすめ: 出した（%d 点、%d 件を採点、%.0f 秒）", best.score, scored.count, elapsed))
            let name = Self.short(best.post.authorName ?? "だれか", 12)
            onPick?("🐶 おすすめ：\(name)さん『\(Self.short(best.note, 40))』", best.post.id)
        }
        #endif
    }

    // MARK: - AI

    static let scoreInstructions = """
    あなたは会員制コミュニティ「B-guru」のアシスタントです。会員の「興味のまとめ」と、タイムラインの新しい投稿の一覧を受け取ります。
    それぞれの投稿が、その会員の興味にどれだけ合うかを 0〜10 の整数で採点してください（10 = とても合う、0 = まったく合わない）。
    興味と関係が薄い投稿には低い点を付けてください。点を甘くしないでください。
    まず投稿の番号と、その投稿の話題を確かめてから採点してください（番号と話題を取り違えないこと）。
    投稿ごとに、日本語で 40 字以内のひとこと（なぜその人に合うか、または投稿の要約）を付けてください。投稿にない事実は書かないでください。
    """

    static let summaryInstructions = """
    あなたは会員制コミュニティ「B-guru」のアシスタントです。会員が自分で書いた投稿・反応した投稿・開いたスレッドの題材の一覧から、
    その会員が興味を持っている話題を、日本語 200 字以内でまとめてください。人の名前は書かず、話題（機材・趣味・分野など）だけを書いてください。
    """

    /// 興味のまとめ（1 日 1 回 AI で作る。材料が少ないときは題材をそのまま短く）。
    private func interestText(posts: [Post], clubs: [String: String]) async -> String {
        let mine = posts.filter(\.mine).prefix(10).map { "自分の投稿: " + Self.short($0.text, 60) }
        let reacted = posts.filter { !$0.mine && ($0.reactions ?? []).contains(where: \.mine) }.prefix(10).map { "反応した投稿: " + Self.short($0.text, 60) }
        let opened = memory.opened.suffix(12).reversed().map { "開いたスレッド: " + Self.short($0.text, 60) }
        let replied = memory.replied.suffix(8).reversed().map { "返信したスレッド: " + Self.short($0.text, 60) }
        var clubCount: [String: Int] = [:]
        for p in posts where p.mine || (p.reactions ?? []).contains(where: \.mine) {
            if let c = p.club, let n = clubs[c] { clubCount[n, default: 0] += 1 }
        }
        let clubLine = clubCount.isEmpty ? [] : ["よく関わる部活: " + clubCount.sorted { $0.value > $1.value }.prefix(4).map(\.key).joined(separator: "、")]
        let items = Array(mine) + Array(reacted) + Array(opened) + Array(replied)
        let raw = (clubLine + items).joined(separator: "\n")
        guard !items.isEmpty else { return "" }
        if items.count < 6 { return Self.short(raw, 400) }
        if let at = memory.summaryAt, Calendar.current.isDateInToday(at), !memory.summary.isEmpty { return memory.summary }
        #if canImport(FoundationModels)
        if #available(macOS 26, *) {
            do {
                let session = LanguageModelSession(instructions: Self.summaryInstructions)
                let r = try await session.respond(to: "題材：\n" + Self.short(raw, 1400), options: GenerationOptions(temperature: 0.2, maximumResponseTokens: 300))
                let text = Self.short(r.content, 200)
                memory.summary = text
                memory.summaryAt = Date()
                save()
                StatusBarDiag.note("AI おすすめ: 興味のまとめを作った（\(text.count) 字）")
                #if DEBUG
                NSLog("[ai] 興味のまとめ：%@", text)
                #endif
                return text
            } catch {
                StatusBarDiag.note("AI おすすめ: まとめに失敗（\(Self.reason(error))）")
                return Self.short(raw, 400)
            }
        }
        #endif
        return Self.short(raw, 400)
    }

    #if canImport(FoundationModels)
    @available(macOS 26, *)
    private func score(_ batch: [Post], interest: String, clubs: [String: String]) async throws -> [(post: Post, score: Int, note: String)] {
        let list = batch.enumerated().map { i, p in
            let club = p.club.flatMap { clubs[$0] }.map { "（\($0)）" } ?? ""
            let link = p.urlPreview?.title.map { " リンク: " + Self.short($0, 40) } ?? ""
            return "[\(i + 1)]\(club) " + Self.short(p.text, 160) + link
        }.joined(separator: "\n")
        let prompt = "興味のまとめ：\n\(interest)\n\n新しい投稿：\n\(list)\n\nすべての投稿（\(batch.count) 件）を採点してください。"
        let session = LanguageModelSession(instructions: Self.scoreInstructions)
        let r = try await session.respond(to: prompt, generating: AIPickScores.self,
                                     options: GenerationOptions(temperature: 0.2, maximumResponseTokens: 700))
        return r.content.items.compactMap { s in
            guard s.number >= 1, s.number <= batch.count else { return nil }
            return (batch[s.number - 1], min(10, max(0, s.score)), Self.cleanNote(s.note))
        }
    }
    #endif

    /// 失敗の理由の種類だけ（本文や投稿は書かない）。
    static func reason(_ error: Error) -> String {
        #if canImport(FoundationModels)
        if #available(macOS 27, *), let e = error as? LanguageModelError {
            switch e {
            case .guardrailViolation: return "ガードレール"
            case .contextSizeExceeded: return "文脈の長さを超えた"
            case .unsupportedLanguageOrLocale: return "未対応の言語"
            case .rateLimited: return "回数の制限"
            case .timeout: return "時間切れ"
            case .refusal: return "断られた"
            default: return "生成のエラー"
            }
        }
        if #available(macOS 26, *), let e = error as? LanguageModelSession.GenerationError {
            switch e {
            case .guardrailViolation: return "ガードレール"
            case .exceededContextWindowSize: return "文脈の長さを超えた"
            case .unsupportedLanguageOrLocale: return "未対応の言語"
            case .assetsUnavailable: return "モデルを使えない"
            case .rateLimited: return "回数の制限"
            case .decodingFailure: return "出力を読めない"
            default: return "生成のエラー"
            }
        }
        #endif
        return "その他のエラー"
    }

    // MARK: - 小物

    static func short(_ s: String, _ limit: Int) -> String {
        let one = s.split(whereSeparator: { $0.isWhitespace || $0.isNewline }).joined(separator: " ")
        return one.count > limit ? String(one.prefix(limit)) + "…" : one
    }

    /// モデルの出力に混ざることがある記号（」}]、```json、<ctrl…> など）から先を捨て、40 字に詰める。
    static func cleanNote(_ s: String) -> String {
        var t = s
        for stop in ["\"", "」}", "}", "]", "```", "<ctrl", "\\"] {
            if let r = t.range(of: stop) { t = String(t[..<r.lowerBound]) }
        }
        t = t.trimmingCharacters(in: CharacterSet(charactersIn: " 　、。「」『』"))
        return short(t, 40)
    }

    static func dayKey(_ d: Date) -> String {
        let c = Calendar.current.dateComponents([.year, .month, .day], from: d)
        return "\(c.year ?? 0)-\(c.month ?? 0)-\(c.day ?? 0)"
    }

    /// 記録を消す（開発のみの後片付け、設定から消す場合にも）。
    static func eraseMemory() {
        try? FileManager.default.removeItem(at: directory)
    }
}

#if canImport(FoundationModels)
@available(macOS 26, *)
@Generable
struct AIPickScore {
    @Guide(description: "投稿の番号（[ ] の中の数字）")
    var number: Int
    @Guide(description: "その番号の投稿の話題を 15 字以内で（投稿の本文から）")
    var topic: String
    @Guide(description: "その会員の興味に合う度合い。0 はまったく合わない、10 はとても合う", .range(0...10))
    var score: Int
    @Guide(description: "日本語で 40 字以内のひとこと。なぜその人に合うか、または投稿の要約")
    var note: String
}

@available(macOS 26, *)
@Generable
struct AIPickScores {
    @Guide(description: "すべての投稿の採点（投稿 1 件につき 1 つ）", .maximumCount(6))
    var items: [AIPickScore]
}
#endif

#if DEBUG
extension AIPicks {
    /// 開発のみ：興味の材料を入れる（オンにしてから）。
    func debugSeed(opened: [(Int, String)], replied: [(Int, String)]) {
        memory.opened = opened.map { Topic(id: $0.0, text: $0.1, at: Date()) }
        memory.replied = replied.map { Topic(id: $0.0, text: $0.1, at: Date()) }
        memory.summary = ""
        memory.summaryAt = nil
        memory.picked = []
    }

    /// 開発のみ：いろいろな話題の投稿 30 件（未読）と、自分の投稿・反応した投稿（興味の材料）。
    static func debugTimeline() -> (posts: [Post], clubs: [String: String]) {
        let now = ISO8601DateFormatter().string(from: Date())
        func p(_ id: Int, _ who: String, _ club: String, _ text: String, mine: Bool = false, reacted: Bool = false, unread: Bool = true) -> Post {
            Post(id: id, authorId: who, authorName: who, isAuthor: mine, replyCount: 0, text: text, createdAt: now, club: club,
                 reactions: reacted ? [Reaction(emoji: "❤️", count: 2, mine: true, reactors: [])] : nil, unread: mine ? false : unread)
        }
        var posts: [Post] = [
            // 興味の材料：自分の投稿・反応した投稿（読んだもの）
            p(901, "ドリキン", "camera", "RED KOMODO-X で撮った夜景、IPP2 で少し持ち上げたらノイズが気にならない。レンズは 35mm", mine: true),
            p(902, "ドリキン", "video", "DaVinci Resolve でカラコレのノードを整理した。シリアルとパラレルの使い分けが分かってきた", mine: true),
            p(903, "ドリキン", "apple", "M3 Max の MacBook Pro、8K の書き出しが思ったより速い", mine: true),
            p(904, "コバン", "camera", "ソニーの新しい単焦点、ボケがきれい。作例を上げました", reacted: true, unread: false),
            p(905, "ゆう", "video", "照明を LED パネル 2 灯にしたらトーク動画の肌がきれいになった", reacted: true, unread: false),
        ]
        let topics: [(String, String, String)] = [
            ("たけし", "camera", "富士フイルムの新しいミラーレスが発表。動画は 6.2K 30p、ログ撮影にも対応"),
            ("mazzo", "food", "近所に新しいラーメン屋ができた。煮干しスープが濃くておいしい"),
            ("NORIO", "car", "ポルシェ 911 の新型に試乗。ハンドリングが軽くなった"),
            ("ひろ", "sports", "昨日の野球、9 回裏のサヨナラで大盛り上がりでした"),
            ("あや", "video", "Final Cut Pro の新しいバージョンで、自動の文字起こしと字幕が付いた"),
            ("けん", "pet", "うちの猫が箱から出てこない"),
            ("りえ", "money", "新 NISA の積立先をインデックスに変えた話"),
            ("たけし", "camera", "RED の新しいファームで、KOMODO の発熱が少し下がったらしい"),
            ("mazzo", "food", "カレーを 3 日寝かせたら別物になった"),
            ("ゆう", "video", "撮影用の LED ライトがセール中。色温度可変で CRI 96"),
            ("NORIO", "apple", "新しい Mac mini を注文した。動画編集用に 64GB にした"),
            ("ひろ", "game", "新作の RPG を 40 時間遊んだ感想"),
            ("あや", "movie", "映画館で見た新作の感想。音響がすごかった"),
            ("けん", "outdoor", "週末にキャンプ。焚き火で焼いたマシュマロ"),
            ("りえ", "book", "最近読んだミステリーがおもしろかった"),
            ("コバン", "audio", "ポッドキャスト用のマイクを RODE に替えたら声がクリアに"),
            ("たけし", "camera", "ジンバルなしでも手持ちで安定する撮り方のコツ"),
            ("mazzo", "garden", "ベランダのトマトが赤くなった"),
            ("NORIO", "car", "EV の充電スポットが近所に増えた"),
            ("ひろ", "sports", "マラソン大会に申し込んだ"),
            ("あや", "video", "YouTube のサムネイル、文字を大きくしたらクリック率が上がった"),
            ("けん", "pet", "犬の散歩コースを変えたら喜んでいる"),
            ("りえ", "fashion", "秋物のコートを買った"),
            ("コバン", "apple", "iPhone のカメラで ProRes 撮影、色の余裕がすごい"),
            ("たけし", "drone", "ドローンの規制が変わったので確認した"),
            ("mazzo", "food", "パン作りに挑戦。発酵が難しい"),
            ("NORIO", "tech", "家の Wi-Fi をメッシュにしたら安定した"),
            ("ひろ", "music", "ライブに行ってきた。ギターの音がよかった"),
            ("あや", "video", "カラーグレーディングの LUT を自作してみた"),
            ("けん", "travel", "京都の紅葉がそろそろ見頃"),
        ]
        posts += topics.enumerated().map { i, t in p(1000 + i, t.0, t.1, t.2) }
        let clubs = ["camera": "カメラ部", "video": "動画部", "apple": "リンゴ部", "food": "グルメ部", "car": "クルマ部", "sports": "スポーツ部",
                     "pet": "ペット部", "money": "マネー部", "game": "ゲーム部", "movie": "映画部", "outdoor": "アウトドア部", "book": "読書部",
                     "audio": "オーディオ部", "garden": "園芸部", "fashion": "ファッション部", "drone": "ドローン部", "tech": "テック部",
                     "music": "音楽部", "travel": "旅行部"]
        return (posts, clubs)
    }
}
#endif
