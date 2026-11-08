import Foundation

// 部室・音声まわりの純粋な決まり（Web の src/lib/room-logic.ts・voice-client.ts と同じ仕様）。
// 画面や LiveKit に触らないので、native/mac/Tests からそのまま試せる。

/// 頭の上の名前札（Web の shortRoomName）。
enum RoomNameTag {
    /// 全角 6 字ぶん。半角 ASCII は幅 1、それ以外は幅 2。
    static let width = 12

    /// 空白や改行は 1 つの空白にまとめ、幅を超えたら幅 width - 1 までで切って「…」。
    /// Character（書記素）ごとに数えるので、家族の絵文字（ZWJ）や国旗の途中では切らない。
    static func short(_ name: String, width: Int = width) -> String {
        let flat = name.split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
        let chars = Array(flat)
        func w(_ c: Character) -> Int {
            if c.unicodeScalars.count == 1, let v = c.unicodeScalars.first?.value, (0x20...0x7e).contains(v) { return 1 }
            return 2
        }
        let total = chars.reduce(0) { $0 + w($1) }
        if total <= width { return flat }
        var out = ""
        var used = 0
        for c in chars {
            if used + w(c) > width - 1 { break }
            out.append(c)
            used += w(c)
        }
        while out.last == " " { out.removeLast() }
        return out + "…"
    }
}

/// 相手ごとの音量（自分だけ、0…1、無ければ 1）。端末に覚える（UserDefaults "voiceGains"）。
enum VoiceGains {
    static let key = "voiceGains"

    /// 覚えていた値のうち、0…1 の数だけ。
    static func sanitized(_ raw: [String: Any]?) -> [String: Double] {
        var out: [String: Double] = [:]
        for (k, v) in raw ?? [:] {
            guard let n = (v as? NSNumber)?.doubleValue, n.isFinite, n >= 0, n <= 1 else { continue }
            out[k] = n
        }
        return out
    }

    /// その人の音量を変えたあとの一覧。0.01 刻みに丸め、1（いつもの大きさ）は覚えない。
    static func setting(_ gains: [String: Double], id: String, to gain: Double) -> [String: Double] {
        let g = max(0, min(1, ((gain.isFinite ? gain : 1) * 100).rounded() / 100))
        var next = gains
        if g >= 1 { next[id] = nil } else { next[id] = g }
        return next
    }
}

/// 出入りの効果音（Web の playVoiceSfx）: その場で作る短いサイン波。音の素材ファイルは使わない。
enum VoiceSfxTone {
    enum Kind: Sendable { case join, leave }

    static let sampleRate = 44_100
    /// 2 音目は 0.09 秒あとから。各音は 0.01 秒で立ち上がり、0.16 秒でほぼ消え、0.18 秒で止める。
    static let gap = 0.09
    static let noteLength = 0.18

    /// join: 上がる 2 音、leave: 下がる 2 音。
    static func frequencies(_ kind: Kind) -> [Double] { kind == .join ? [660, 990] : [740, 494] }

    /// 自分の出入りは少し大きく。
    static func peak(mine: Bool) -> Double { mine ? 0.12 : 0.06 }

    static func samples(_ kind: Kind, mine: Bool, sampleRate: Int = sampleRate) -> [Float] {
        let notes = frequencies(kind)
        let sr = Double(sampleRate)
        let count = Int(((Double(notes.count - 1) * gap + noteLength) * sr).rounded(.up))
        var out = [Float](repeating: 0, count: count)
        let peak = peak(mine: mine)
        for (i, f) in notes.enumerated() {
            let start = Int((Double(i) * gap * sr).rounded())
            let len = Int((noteLength * sr).rounded())
            for n in 0..<len where start + n < count {
                let t = Double(n) / sr
                let env: Double
                if t < 0.01 { env = peak * t / 0.01 }
                else if t <= 0.16 { env = peak * pow(0.0001 / peak, (t - 0.01) / 0.15) }
                else { env = 0.0001 * (noteLength - t) / (noteLength - 0.16) }
                out[start + n] += Float(env * sin(2 * Double.pi * f * t))
            }
        }
        return out
    }

    /// 16 bit・モノラルの WAV（AVAudioPlayer にそのまま渡せる）。
    static func wav(_ samples: [Float], sampleRate: Int = sampleRate) -> Data {
        var d = Data()
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { d.append(contentsOf: $0) } }
        let bytes = UInt32(samples.count * 2)
        d.append(contentsOf: Array("RIFF".utf8)); u32(36 + bytes)
        d.append(contentsOf: Array("WAVE".utf8))
        d.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1)
        u32(UInt32(sampleRate)); u32(UInt32(sampleRate * 2)); u16(2); u16(16)
        d.append(contentsOf: Array("data".utf8)); u32(bytes)
        for s in samples { u16(UInt16(bitPattern: Int16(max(-1, min(1, s)) * 32767))) }
        return d
    }
}

/// 「interval 秒に 1 回まで」（効果音 1.2 秒・再起動の入り直し 10 秒・音声の入り直し 30 秒）。
struct RateGate: Sendable {
    let interval: TimeInterval
    private(set) var last: Date?

    init(interval: TimeInterval) { self.interval = interval }

    /// 通してよければ true（そのときを覚える）。
    mutating func allow(now: Date = Date()) -> Bool {
        if let last, now.timeIntervalSince(last) < interval { return false }
        last = now
        return true
    }
}

/// サーバの再起動（GET /api/agent/room の boot が前回と変わった）。初めて読んだときは再起動ではない。
enum RoomRestart {
    static func restarted(previous: String?, current: String?) -> Bool {
        guard let previous, let current else { return false }
        return previous != current
    }
}

/// ステージの自動マイク: 今いる場所から「あるべき状態」を決める。
///   - ステージの上で、マイクが切れていて、本人が切った（または許可がなく入れられなかった）のでなければ、
///     1 秒立ち止まってからオン（scheduleOn）。
///   - ステージの外で、自動で入れたマイクがオンなら切る（turnOff）。自分で入れたマイクは切らない。
enum StageMic {
    enum Action: Equatable, Sendable { case none, scheduleOn, turnOff }

    static let dwell: TimeInterval = 1

    static func decide(onStage: Bool, micOn: Bool, auto: Bool, suppressed: Bool) -> Action {
        if onStage { return !micOn && !suppressed ? .scheduleOn : .none }
        return auto && micOn ? .turnOff : .none
    }
}
