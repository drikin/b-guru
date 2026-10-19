import AVFoundation
import Foundation
import MediaPlayer
import Observation
import SwiftUI

/// The jukebox: past backspace.fm episodes and the player (docs/jukebox-client-spec.md).
/// Lives as long as the sign-in (owned by ChatStore), so playback goes on when the Mac
/// panel closes, the tab changes or the iPhone is locked (background audio).
@MainActor
@Observable
final class JukeboxStore {
    // MARK: The archive

    private(set) var episodes: [Episode] = []
    private(set) var today: JukeboxResponse.Today?
    private(set) var loading = false
    private(set) var loadFailed = false

    // MARK: Now playing

    private(set) var current: Episode?
    private(set) var isPlaying = false
    /// Waiting for audio (starting, seeking, a slow network).
    private(set) var isBuffering = false
    private(set) var position: Double = 0
    private(set) var rate: Float = 1
    /// Paused because the member joined the voice room: offer "続きを再生", never resume by itself.
    private(set) var pausedForVoice = false
    private(set) var sleepAt: Date?
    private(set) var sleepAtEnd = false

    static let rates: [Float] = [1, 1.25, 1.5, 1.75, 2]

    private let api: APIClient
    private var player: AVPlayer?
    private var timeObserver: Any?
    private var endObserver: NSObjectProtocol?
    private var statusObservation: NSKeyValueObservation?
    private var bufferObservation: NSKeyValueObservation?
    private var sleepTask: Task<Void, Never>?
    private var lastSaved: Double = 0
    private var retriedExpired = false
    private var remoteReady = false

    init(api: APIClient) {
        self.api = api
        progress = (UserDefaults.standard.dictionary(forKey: Self.progressKey) as? [String: Double]) ?? [:]
        finished = Set(UserDefaults.standard.stringArray(forKey: Self.finishedKey) ?? [])
        rate = Float(UserDefaults.standard.double(forKey: Self.rateKey)).clamped(1, 2)
        #if os(iOS)
        NotificationCenter.default.addObserver(forName: AVAudioSession.interruptionNotification, object: nil, queue: .main) { [weak self] n in
            let type = (n.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt).flatMap(AVAudioSession.InterruptionType.init)
            let resume = ((n.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt).map { AVAudioSession.InterruptionOptions(rawValue: $0) } ?? []).contains(.shouldResume)
            MainActor.assumeIsolated { self?.interrupted(began: type == .began, shouldResume: resume) }
        }
        #endif
    }

    // MARK: Loading

    private static var cacheURL: URL? {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("jukebox.json")
    }

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    /// Shows the saved copy at once, then the server's.
    func load(path: String) async {
        #if DEBUG
        if api.token == "demo" { return }
        #endif
        if episodes.isEmpty, let url = Self.cacheURL, let data = try? Data(contentsOf: url),
           let r = try? Self.decoder.decode(JukeboxResponse.self, from: data) {
            apply(r)
        }
        guard !loading else { return }
        loading = true
        defer { loading = false }
        do {
            let data = try await api.jukeboxData(path: path)
            let r = try Self.decoder.decode(JukeboxResponse.self, from: data)
            apply(r)
            loadFailed = false
            if let url = Self.cacheURL {
                try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                try? data.write(to: url, options: .atomic)
            }
        } catch {
            loadFailed = episodes.isEmpty
        }
    }

    private func apply(_ r: JukeboxResponse) {
        episodes = r.episodes
        today = r.today
        if let c = current, let fresh = r.episodes.first(where: { $0.id == c.id }) { current = fresh }
    }

    var todayEpisode: Episode? {
        guard let id = today?.id else { return nil }
        return episodes.first { $0.id == id }
    }

    func episode(forAudioURL url: String) -> Episode? {
        episodes.first { $0.audioUrl == url }
    }

    // MARK: Progress (per episode, on this device; v2 syncs it)

    private static let progressKey = "jukebox.progress"
    private static let finishedKey = "jukebox.finished"
    private static let rateKey = "jukebox.rate"
    private static let lastKey = "jukebox.last"
    private(set) var progress: [String: Double] = [:]
    private(set) var finished: Set<String> = []

    /// 0…1 listened, or nil when never started.
    func fraction(_ e: Episode) -> Double? {
        if finished.contains(e.id) { return 1 }
        guard let p = progress[e.id], p > 0, let d = e.durationSec, d > 0 else { return nil }
        return min(1, p / Double(d))
    }

    private func saveProgress(force: Bool = false) {
        guard let c = current else { return }
        guard force || abs(position - lastSaved) >= 10 else { return }
        lastSaved = position
        progress[c.id] = position
        if let d = c.durationSec, Double(d) - position < 30 { finished.insert(c.id) }
        UserDefaults.standard.set(progress, forKey: Self.progressKey)
        UserDefaults.standard.set(Array(finished), forKey: Self.finishedKey)
        UserDefaults.standard.set(c.id, forKey: Self.lastKey)
    }

    // MARK: Playing

    /// Put a record on and play it (from where it was left off).
    func play(_ e: Episode) {
        if current?.id == e.id {
            if !isPlaying { resume() }
            return
        }
        saveProgress(force: true)
        stopPlayer()
        current = e
        pausedForVoice = false
        retriedExpired = false
        let resumeAt = finished.contains(e.id) ? 0 : (progress[e.id] ?? 0)
        position = resumeAt
        lastSaved = resumeAt
        startPlayer(at: resumeAt)
        resume()
    }

    func playRandom() {
        guard let e = episodes.randomElement() else { return }
        play(e)
    }

    func toggle() { isPlaying ? pause() : resume() }

    func resume() {
        guard current != nil else { return }
        if player == nil { startPlayer(at: position) }
        activateSession()
        pausedForVoice = false
        player?.playImmediately(atRate: rate)
        isPlaying = true
        updateNowPlaying()
    }

    func pause() {
        player?.pause()
        isPlaying = false
        saveProgress(force: true)
        updateNowPlaying()
    }

    /// The member is joining the voice room: the call wins, the record waits.
    func pauseForVoice() {
        guard isPlaying else { return }
        pause()
        pausedForVoice = true
    }

    func skip(_ seconds: Double) { seek(to: position + seconds) }

    func seek(to seconds: Double) {
        let maxT = Double(current?.durationSec ?? Int.max)
        let t = max(0, min(seconds, maxT))
        position = t
        player?.seek(to: CMTime(seconds: t, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        saveProgress(force: true)
        updateNowPlaying()
    }

    func cycleRate() {
        let i = Self.rates.firstIndex(of: rate) ?? 0
        setRate(Self.rates[(i + 1) % Self.rates.count])
    }

    func setRate(_ r: Float) {
        rate = r
        UserDefaults.standard.set(Double(r), forKey: Self.rateKey)
        player?.defaultRate = r
        if isPlaying { player?.rate = r }
        updateNowPlaying()
    }

    // MARK: Sleep timer

    func setSleep(minutes: Int?) {
        sleepTask?.cancel()
        sleepAtEnd = false
        sleepAt = minutes.map { Date().addingTimeInterval(Double($0) * 60) }
        guard let at = sleepAt else { return }
        sleepTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(0, at.timeIntervalSinceNow)))
            guard !Task.isCancelled else { return }
            await self?.fadeOutAndPause()
        }
    }

    func setSleepAtEnd() {
        sleepTask?.cancel()
        sleepAt = nil
        sleepAtEnd = true
    }

    private func fadeOutAndPause() async {
        guard let player else { return }
        for step in stride(from: 1.0, through: 0, by: -0.1) {
            player.volume = Float(step)
            try? await Task.sleep(for: .milliseconds(500))
        }
        pause()
        player.volume = 1
        sleepAt = nil
    }

    // MARK: AVPlayer

    private func startPlayer(at seconds: Double) {
        guard let c = current, let url = URL(string: c.audioUrl) else { return }
        // The feed's own URL every time: it goes through the download counters, and
        // what it redirects to is signed for about a day only.
        let item = AVPlayerItem(url: url)
        item.audioTimePitchAlgorithm = .timeDomain
        let p = AVPlayer(playerItem: item)
        p.automaticallyWaitsToMinimizeStalling = true
        p.defaultRate = rate
        player = p
        if seconds > 0 {
            p.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] t in
            MainActor.assumeIsolated { self?.tick(t.seconds) }
        }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.didEnd() }
        }
        statusObservation = item.observe(\.status) { [weak self] item, _ in
            let failed = item.status == .failed
            Task { @MainActor in if failed { self?.didFail() } }
        }
        bufferObservation = p.observe(\.timeControlStatus) { [weak self] p, _ in
            let waiting = p.timeControlStatus == .waitingToPlayAtSpecifiedRate
            Task { @MainActor in self?.isBuffering = waiting }
        }
        setUpRemoteCommands()
    }

    private func stopPlayer() {
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        timeObserver = nil
        endObserver = nil
        statusObservation = nil
        bufferObservation = nil
        player?.pause()
        player = nil
        isPlaying = false
        isBuffering = false
    }

    private func tick(_ seconds: Double) {
        guard seconds.isFinite, isPlaying else { return }
        position = seconds
        saveProgress()
        updateNowPlaying(elapsedOnly: true)
    }

    private func didEnd() {
        position = Double(current?.durationSec ?? Int(position))
        saveProgress(force: true)
        isPlaying = false
        if sleepAtEnd { sleepAtEnd = false }
        updateNowPlaying()
    }

    /// Paused for long, the signed address it was redirected to expires: start again
    /// from the feed's URL, at the same place (once).
    private func didFail() {
        guard !retriedExpired, current != nil else { isPlaying = false; return }
        retriedExpired = true
        let wasPlaying = isPlaying
        let at = position
        stopPlayer()
        startPlayer(at: at)
        if wasPlaying { resume() }
    }

    private func activateSession() {
        #if os(iOS)
        let s = AVAudioSession.sharedInstance()
        try? s.setCategory(.playback, mode: .spokenAudio)
        try? s.setActive(true)
        #endif
    }

    #if os(iOS)
    private func interrupted(began: Bool, shouldResume: Bool) {
        if began {
            if isPlaying { player?.pause(); isPlaying = false; saveProgress(force: true); updateNowPlaying() }
        } else if shouldResume, !pausedForVoice, current != nil {
            resume()
        }
    }
    #endif

    // MARK: Lock screen, Control Center, AirPods, Mac media keys

    private func setUpRemoteCommands() {
        guard !remoteReady else { return }
        remoteReady = true
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.resume() }; return .success }
        c.pauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.pause() }; return .success }
        c.togglePlayPauseCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.toggle() }; return .success }
        c.skipForwardCommand.preferredIntervals = [30]
        c.skipForwardCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.skip(30) }; return .success }
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.addTarget { [weak self] _ in MainActor.assumeIsolated { self?.skip(-15) }; return .success }
        c.changePlaybackPositionCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let t = e.positionTime
            MainActor.assumeIsolated { self?.seek(to: t) }
            return .success
        }
        c.changePlaybackRateCommand.supportedPlaybackRates = Self.rates.map { NSNumber(value: $0) }
        c.changePlaybackRateCommand.addTarget { [weak self] e in
            guard let e = e as? MPChangePlaybackRateCommandEvent else { return .commandFailed }
            let r = e.playbackRate
            MainActor.assumeIsolated { self?.setRate(r) }
            return .success
        }
        c.nextTrackCommand.isEnabled = false
        c.previousTrackCommand.isEnabled = false
    }

    private var artwork: MPMediaItemArtwork?
    private var artworkFor: String?

    private func updateNowPlaying(elapsedOnly: Bool = false) {
        let center = MPNowPlayingInfoCenter.default()
        guard let c = current else {
            center.nowPlayingInfo = nil
            return
        }
        var info = elapsedOnly ? (center.nowPlayingInfo ?? [:]) : [:]
        if !elapsedOnly {
            info[MPMediaItemPropertyTitle] = c.title
            info[MPMediaItemPropertyArtist] = "backspace.fm"
            info[MPMediaItemPropertyAlbumTitle] = "\(c.dateText) ・ \(c.series)"
            if let d = c.durationSec { info[MPMediaItemPropertyPlaybackDuration] = d }
            info[MPNowPlayingInfoPropertyMediaType] = MPNowPlayingInfoMediaType.audio.rawValue
            if artworkFor != c.id {
                artworkFor = c.id
                artwork = RecordArtwork.make(for: c)
            }
            if let artwork { info[MPMediaItemPropertyArtwork] = artwork }
        }
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = position
        info[MPNowPlayingInfoPropertyPlaybackRate] = isPlaying ? Double(rate) : 0
        info[MPNowPlayingInfoPropertyDefaultPlaybackRate] = Double(rate)
        center.nowPlayingInfo = info
        #if os(macOS)
        center.playbackState = isPlaying ? .playing : .paused
        #endif
    }

    // MARK: Demo

    #if DEBUG
    /// Offline sample data. `base` serves a test mp3 from this Mac (never the real feed:
    /// playing those would count as downloads of the show).
    func debugLoadDemo(base: String?) {
        let audio = (base ?? "http://127.0.0.1:8098") + "/tone.mp3"
        func ep(_ i: Int, _ date: String, _ title: String, _ series: String = "本編", n: Int?) -> Episode {
            Episode(id: "demo-\(i)", title: title, publishedAt: "\(date)T09:00:00.000Z", audioUrl: audio, durationSec: 180,
                    series: series, number: n, summary: "デモ用の回です。ドリキン、松尾、西川善司がテックの話題を語ります。", webUrl: nil)
        }
        episodes = [
            ep(1, "2026-10-04", "獣の数字回 — Z Fold8とFlex Titanium ep666", n: 666),
            ep(2, "2025-03-02", "B-side #120: 春のガジェット", "B-side", n: 120),
            ep(3, "2023-06-08", "#540: WWDC23 Vision Pro発表！", n: 540),
            ep(4, "2021-11-20", "DANBO-side #40: M1 Max", "DANBO-side", n: 40),
            ep(5, "2019-10-20", "#313:Galaxy ＆ 樋口監督ドヤ vs. GoPro 8ドヤ", n: 313),
            ep(6, "2016-09-10", "#140: iPhone 7 ジェットブラック", n: 140),
            ep(7, "2014-01-03", "#001: backspace.fm始まりました！", n: 1),
        ]
        today = .init(id: "demo-5", yearsAgo: 7, postId: nil)
    }
    #endif
}

private extension Float {
    func clamped(_ lo: Float, _ hi: Float) -> Float { self == 0 ? lo : Swift.min(Swift.max(self, lo), hi) }
}
