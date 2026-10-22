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
    /// The years on the shelf, newest first (made once per archive, not on every redraw).
    private(set) var years: [String] = []
    /// Lower-cased title + summary per episode, for the shelf's search (made once per archive).
    @ObservationIgnored private var searchKeys: [String: String] = [:]
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

    private var loadedAt: Date?

    /// Shows the saved copy at once, then the server's — at most every 30 minutes (opening
    /// the tab again does not fetch and decode ~1 MB again). The decoding runs off the main
    /// thread: switching tabs got heavy when it did not (drikin 2026-10-19).
    func load(path: String, force: Bool = false) async {
        #if DEBUG
        if api.token == "demo" { return }
        #endif
        if !force, let at = loadedAt, Date().timeIntervalSince(at) < 30 * 60, !episodes.isEmpty { return }
        guard !loading else { return }
        loading = true
        defer { loading = false }
        if episodes.isEmpty, let url = Self.cacheURL,
           let r = await Task.detached(priority: .userInitiated, operation: { () -> Prepared? in
               guard let data = try? Data(contentsOf: url) else { return nil }
               return try? Self.prepare(Self.decode(data))
           }).value {
            apply(r)
        }
        do {
            let data = try await api.jukeboxData(path: path)
            let r = try await Task.detached(priority: .userInitiated) { try Self.prepare(Self.decode(data)) }.value
            apply(r)
            loadFailed = false
            loadedAt = Date()
            if let url = Self.cacheURL {
                Task.detached(priority: .utility) {
                    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try? data.write(to: url, options: .atomic)
                }
            }
        } catch {
            loadFailed = episodes.isEmpty
        }
    }

    private nonisolated static func decode(_ data: Data) throws -> JukeboxResponse {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return try d.decode(JukeboxResponse.self, from: data)
    }

    /// The archive with what the shelf needs worked out once, off the main thread.
    struct Prepared: Sendable {
        var response: JukeboxResponse
        var years: [String]
        var searchKeys: [String: String]
    }

    private nonisolated static func prepare(_ r: JukeboxResponse) -> Prepared {
        var keys: [String: String] = [:]
        keys.reserveCapacity(r.episodes.count)
        for e in r.episodes {
            keys[e.id] = (e.title + "\n" + e.summary).lowercased()
            _ = e.dateText // parsed once here, then cached
        }
        return Prepared(response: r, years: Array(Set(r.episodes.map(\.year))).sorted(by: >), searchKeys: keys)
    }

    private func apply(_ p: Prepared) {
        let r = p.response
        if episodes != r.episodes {
            episodes = r.episodes
            searchKeys = p.searchKeys
            if years != p.years { years = p.years }
        }
        if today != r.today { today = r.today }
        if let c = current, let fresh = r.episodes.first(where: { $0.id == c.id }), fresh != c { current = fresh }
    }

    /// Whether the episode's title or summary contains `query` (already lower-cased).
    func matches(_ e: Episode, query: String) -> Bool {
        (searchKeys[e.id] ?? (e.title + "\n" + e.summary).lowercased()).contains(query)
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
    /// Where each episode was left. Not observed: saving it every 10 s while playing made the
    /// whole jukebox screen (every shelf row) update; the screen sees `currentFraction`.
    @ObservationIgnored private(set) var progress: [String: Double] = [:]
    private(set) var finished: Set<String> = []
    /// How far the record on the turntable has been listened to (0…1), for its shelf row.
    private(set) var currentFraction: Double?

    /// 0…1 listened, or nil when never started.
    /// `isCurrent`: the caller already knows whether it is the record playing (rows then do
    /// not each follow `current`).
    func fraction(_ e: Episode, isCurrent: Bool? = nil) -> Double? {
        if finished.contains(e.id) { return 1 }
        if isCurrent ?? (e.id == current?.id) { return currentFraction }
        return Self.fraction(progress[e.id], e)
    }

    private static func fraction(_ position: Double?, _ e: Episode) -> Double? {
        guard let p = position, p > 0, let d = e.durationSec, d > 0 else { return nil }
        return min(1, p / Double(d))
    }

    private func updateCurrentFraction() {
        let f = current.flatMap { Self.fraction(progress[$0.id], $0) }
        if f != currentFraction { currentFraction = f }
    }

    /// `markFinished`: only while listening (a seek near the end is not "聴いた").
    private func saveProgress(force: Bool = false, markFinished: Bool = false) {
        guard let c = current else { return }
        guard force || abs(position - lastSaved) >= 10 else { return }
        lastSaved = position
        progress[c.id] = position
        updateCurrentFraction()
        if markFinished, let d = c.durationSec, Double(d) - position < 30, !finished.contains(c.id) { finished.insert(c.id) }
        UserDefaults.standard.set(progress, forKey: Self.progressKey)
        UserDefaults.standard.set(Array(finished), forKey: Self.finishedKey)
        UserDefaults.standard.set(c.id, forKey: Self.lastKey)
    }

    // MARK: Playing

    /// Says whether the member is in (or joining) the voice room: no records then — the
    /// call owns the audio (on iOS the jukebox's audio session would break the call's).
    var voiceBusy: () -> Bool = { false }
    /// Shown for a moment when play was refused (in a call).
    private(set) var notice: String?

    private func refusedForVoice() -> Bool {
        guard voiceBusy() else { return false }
        pausedForVoice = true
        notice = "ボイスに入っているあいだは聴けません"
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(3))
            self?.notice = nil
        }
        return true
    }

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
        // Listened to before: hear it again from the top (it is marked again at the end).
        let resumeAt = finished.contains(e.id) ? 0 : (progress[e.id] ?? 0)
        if finished.contains(e.id) { finished.remove(e.id) }
        updateCurrentFraction()
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
        guard let c = current else { return }
        if refusedForVoice() { updateNowPlaying(); return }
        // At the very end: from the top again.
        if let d = c.durationSec, position >= Double(d) - 1 { position = 0; player?.seek(to: .zero) }
        // A failed item (network, an expired address): build it again at the same place.
        if player == nil || player?.currentItem?.status == .failed {
            stopPlayer()
            startPlayer(at: position)
        }
        activateSession()
        pausedForVoice = false
        InlinePlayback.stopAll() // a video or sound playing in the timeline stops
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

    /// Signed out: stop and forget what is on the lock screen.
    func shutdown() {
        if isPlaying { pause() }
        sleepTask?.cancel()
        stopPlayer()
        current = nil
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        #if os(macOS)
        MPNowPlayingInfoCenter.default().playbackState = .stopped
        #endif
    }

    func skip(_ seconds: Double) { seek(to: position + seconds) }

    func seek(to seconds: Double) {
        let maxT = Double(current?.durationSec ?? Int.max)
        let t = max(0, min(seconds, maxT))
        position = t
        seekingUntil = Date().addingTimeInterval(1.5)
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
        player?.volume = 1
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
        player?.volume = 1
        sleepAt = nil
        sleepAtEnd = true
    }

    private func fadeOutAndPause() async {
        guard let player else { return }
        for step in stride(from: 1.0, through: 0, by: -0.1) {
            if Task.isCancelled { player.volume = 1; return }
            player.volume = Float(step)
            try? await Task.sleep(for: .milliseconds(500))
        }
        pause()
        player.volume = 1
        sleepAt = nil
    }

    // MARK: AVPlayer

    /// While a seek (or the first jump to the saved place) settles, the clock may still
    /// say an old time: do not save that.
    private var seekingUntil = Date.distantPast
    private var failObserver: NSObjectProtocol?
    private var wasPlayingBeforeInterruption = false

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
            seekingUntil = Date().addingTimeInterval(3)
            p.seek(to: CMTime(seconds: seconds, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
        }
        timeObserver = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] t in
            MainActor.assumeIsolated { self?.tick(t.seconds) }
        }
        endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.didEnd() }
        }
        // A dropped connection often arrives as this, not as a failed status.
        failObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.failedToPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.didFail() }
        }
        let (status, control) = Self.observe(item: item, player: p, store: self)
        statusObservation = status
        bufferObservation = control
        setUpRemoteCommands()
    }

    /// KVO calls back on any thread: the closures live outside the main actor and hop to it.
    private nonisolated static func observe(item: AVPlayerItem, player: AVPlayer, store: JukeboxStore) -> (NSKeyValueObservation, NSKeyValueObservation) {
        nonisolated(unsafe) weak var weakStore = store
        let status = item.observe(\.status) { _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { weakStore?.itemStatusChanged() } }
        }
        let control = player.observe(\.timeControlStatus) { _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { weakStore?.controlStatusChanged() } }
        }
        return (status, control)
    }

    private func itemStatusChanged() {
        switch player?.currentItem?.status {
        case .readyToPlay: retriedExpired = false
        case .failed: didFail()
        default: break
        }
    }

    /// The player stopped by itself (headphones out, the session ended, the network gave
    /// up): the record stops too, and the place is kept.
    private func controlStatusChanged() {
        guard let p = player else { return }
        let buffering = p.timeControlStatus == .waitingToPlayAtSpecifiedRate
        if buffering != isBuffering {
            isBuffering = buffering
            // Playing again after a stall: put the lock screen's clock right.
            if !buffering, isPlaying { updateNowPlaying() }
        }
        if p.timeControlStatus == .paused, p.rate == 0, isPlaying {
            isPlaying = false
            saveProgress(force: true)
            updateNowPlaying()
        }
    }

    private func stopPlayer() {
        if let timeObserver { player?.removeTimeObserver(timeObserver) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
        if let failObserver { NotificationCenter.default.removeObserver(failObserver) }
        timeObserver = nil
        endObserver = nil
        failObserver = nil
        statusObservation = nil
        bufferObservation = nil
        player?.pause()
        player = nil
        isPlaying = false
        isBuffering = false
    }

    private func tick(_ seconds: Double) {
        guard seconds.isFinite, isPlaying, Date() > seekingUntil else { return }
        position = seconds
        saveProgress(markFinished: true)
        // Not the Now Playing info: the system moves the elapsed time on by itself from the
        // rate given at play / pause / seek / rate changes (setting it twice a second cost
        // work in the app and in the system's media service).
    }

    private func didEnd() {
        position = Double(current?.durationSec ?? Int(position))
        saveProgress(force: true, markFinished: true)
        isPlaying = false
        if sleepAtEnd { sleepAtEnd = false }
        updateNowPlaying()
    }

    /// The signed address it was redirected to expires after a long pause (or the network
    /// dropped): start again from the feed's URL, at the same place. Once per failure; a
    /// successful start (readyToPlay) allows the next one.
    private func didFail() {
        guard current != nil else { return }
        guard !retriedExpired else {
            isPlaying = false
            notice = "再生できませんでした。もう一度押してください"
            updateNowPlaying()
            return
        }
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
        // Never take the session from a call (LiveKit uses play-and-record).
        guard s.category != .playAndRecord else { return }
        try? s.setCategory(.playback, mode: .spokenAudio)
        try? s.setActive(true)
        #endif
    }

    #if os(iOS)
    private func interrupted(began: Bool, shouldResume: Bool) {
        if began {
            wasPlayingBeforeInterruption = isPlaying
            if isPlaying { player?.pause(); isPlaying = false; saveProgress(force: true); updateNowPlaying() }
        } else if shouldResume, wasPlayingBeforeInterruption, !pausedForVoice, current != nil {
            wasPlayingBeforeInterruption = false
            resume()
        }
    }
    #endif

    // MARK: Lock screen, Control Center, AirPods, Mac media keys

    private func setUpRemoteCommands() {
        guard !remoteReady else { return }
        remoteReady = true
        Self.registerRemoteCommands(store: self, rates: Self.rates)
    }

    /// MediaPlayer may call these on its own queue: the closures are not tied to the main
    /// actor (one that was crashed the app) and hop to it.
    private nonisolated static func registerRemoteCommands(store: JukeboxStore, rates: [Float]) {
        nonisolated(unsafe) weak var weakStore = store
        func onMain(_ f: @escaping @MainActor (JukeboxStore) -> Void) -> MPRemoteCommandHandlerStatus {
            DispatchQueue.main.async { MainActor.assumeIsolated { if let s = weakStore { f(s) } } }
            return .success
        }
        let c = MPRemoteCommandCenter.shared()
        c.playCommand.addTarget { _ in onMain { $0.resume() } }
        c.pauseCommand.addTarget { _ in onMain { $0.pause() } }
        c.togglePlayPauseCommand.addTarget { _ in onMain { $0.toggle() } }
        c.skipForwardCommand.preferredIntervals = [30]
        c.skipForwardCommand.addTarget { _ in onMain { $0.skip(30) } }
        c.skipBackwardCommand.preferredIntervals = [15]
        c.skipBackwardCommand.addTarget { _ in onMain { $0.skip(-15) } }
        c.changePlaybackPositionCommand.addTarget { e in
            guard let e = e as? MPChangePlaybackPositionCommandEvent else { return .commandFailed }
            let t = e.positionTime
            return onMain { $0.seek(to: t) }
        }
        c.changePlaybackRateCommand.supportedPlaybackRates = rates.map { NSNumber(value: $0) }
        c.changePlaybackRateCommand.addTarget { e in
            guard let e = e as? MPChangePlaybackRateCommandEvent else { return .commandFailed }
            let r = e.playbackRate
            return onMain { $0.setRate(r) }
        }
        c.nextTrackCommand.isEnabled = false
        c.previousTrackCommand.isEnabled = false
    }

    private var artwork: MPMediaItemArtwork?
    private var artworkFor: String?

    /// Play, pause, seek, rate, a new record: the lock screen / Control Center's info.
    private func updateNowPlaying() {
        let center = MPNowPlayingInfoCenter.default()
        guard let c = current else {
            center.nowPlayingInfo = nil
            return
        }
        var info: [String: Any] = [:]
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
        defer {
            let p = Self.prepare(JukeboxResponse(episodes: episodes, today: today))
            searchKeys = p.searchKeys
            years = p.years
        }
        // BGURU_DEMO_JUKEBOX_JSON=<a saved /api/agent/jukebox response>: the real-sized
        // archive (1,170 records) for performance checks; the audio stays the test tone.
        if let path = ProcessInfo.processInfo.environment["BGURU_DEMO_JUKEBOX_JSON"],
           let data = try? Data(contentsOf: URL(fileURLWithPath: path)), var r = try? Self.decode(data) {
            r.episodes = r.episodes.map { var e = $0; e.audioUrl = audio; return e }
            episodes = r.episodes
            today = r.today
        }
    }
    #endif
}

private extension Float {
    func clamped(_ lo: Float, _ hi: Float) -> Float { self == 0 ? lo : Swift.min(Swift.max(self, lo), hi) }
}
