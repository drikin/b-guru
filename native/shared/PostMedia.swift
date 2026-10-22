import SwiftUI
import AVFoundation
import AVKit
import ImageIO
import Network

// A post's pictures, GIFs, video and audio, drawn as the web draws them (src/app/page.tsx):
// pictures never cropped, video and audio played right in the timeline. The sizes are in
// TimelineRules.

// MARK: - Pictures

/// The shape (width / height) of each picture seen this launch, so a row built again
/// (scrolled back to) has its final height at once instead of growing when the picture comes.
@MainActor
enum ImageAspects {
    private static var known: [String: CGFloat] = [:]
    static func aspect(_ path: String) -> CGFloat? { known[path] }
    static func record(_ path: String, _ size: CGSize) {
        guard size.width > 0, size.height > 0 else { return }
        if known.count > 4000 { known.removeAll() }
        known[path] = size.width / size.height
    }
}

/// 1 picture: its own shape, at most 360 wide (and 480 tall: a taller one is narrowed).
/// 2: two columns; 3 to 5: three columns (the web's and Android's grid): every cell the same
/// width, as tall as its picture's shape needs, top-aligned, a row as tall as its tallest cell.
/// Never cropped. Tap → full screen.
///
/// Under an open thread (`mediaActive` false) a picture that arrives does not change the
/// row's height until the thread is closed: rows of the hidden lazy list changing height is
/// the shape of the 2026-10-21 freeze.
struct PostImages: View {
    let images: [String]
    /// The display's `image_columns` (TimelineRules.imageColumns).
    var columns: Int? = nil
    let onOpen: (Int) -> Void
    @State private var aspects: [String: CGFloat] = [:]
    @State private var pending: [String: CGFloat] = [:]
    @Environment(\.mediaActive) private var mediaActive

    private var single: Bool { images.count == 1 }

    private func aspect(_ path: String) -> CGFloat {
        aspects[path] ?? ImageAspects.aspect(path) ?? (single ? 4.0 / 3.0 : 1)
    }

    var body: some View {
        PictureRows(aspects: images.map(aspect),
                    columns: max(1, columns ?? TimelineRules.imageColumns(images.count)), spacing: 4) {
            ForEach(Array(images.enumerated()), id: \.offset) { i, path in
                Button { onOpen(i) } label: { cell(path) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(single ? "画像" : "画像 \(i + 1)")
            }
        }
        .onChange(of: mediaActive) { _, on in
            guard on, !pending.isEmpty else { return }
            for (p, a) in pending {
                ImageAspects.record(p, CGSize(width: a, height: 1))
                aspects[p] = a
            }
            pending = [:]
        }
    }

    private func cell(_ path: String) -> some View {
        let px = single ? MediaImage.defaultPixels : 600
        let found: (CGSize) -> Void = { size in
            let a = size.width / max(size.height, 1)
            guard mediaActive else { pending[path] = a; return }
            ImageAspects.record(path, size)
            if aspects[path] != a { aspects[path] = a }
        }
        // The picture at its own shape, rounded, at the top of its cell (the cell is only
        // taller than the picture when its shape is beyond the limits in PictureRows); the
        // rest of the cell is see-through.
        return Group {
            if TimelineRules.isGIF(path) {
                AnimatedGIF(path: path, maxPixel: px, onSize: found)
            } else {
                MediaImage(path: path, contentMode: .fit, maxPixel: px, onSize: found)
            }
        }
        .aspectRatio(aspect(path), contentMode: .fit)
        .clipShape(RoundedRectangle(cornerRadius: single ? 10 : 8, style: .continuous))
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .contentShape(Rectangle())
    }
}

/// Lays the pictures out: one alone (TimelineRules' single size), or columns of equal width
/// (`(width − gaps) / columns`), each cell `width / shape` tall, top-aligned, each row as tall
/// as its tallest cell. A cell is at most twice as tall as it is wide (docs/timeline-spec.md §1,
/// Android's `gridCellHeight`): a taller picture is fitted in its cell.
struct PictureRows: Layout {
    var aspects: [CGFloat]
    var columns: Int
    var spacing: CGFloat

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let f = frames(width: proposal.width ?? TimelineRules.singleImageMaxWidth)
        return CGSize(width: f.map(\.maxX).max() ?? 0, height: f.map(\.maxY).max() ?? 0)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let f = frames(width: bounds.width)
        for (i, s) in subviews.enumerated() where i < f.count {
            let r = f[i]
            s.place(at: CGPoint(x: bounds.minX + r.minX, y: bounds.minY + r.minY), proposal: ProposedViewSize(r.size))
        }
    }

    func frames(width: CGFloat) -> [CGRect] {
        let width = max(width, 1)
        guard !aspects.isEmpty else { return [] }
        if columns == 1 || aspects.count == 1 {
            let a = max(aspects[0], 0.05)
            var w = min(width, TimelineRules.singleImageMaxWidth)
            var h = w / a
            if h > TimelineRules.singleImageMaxHeight { h = TimelineRules.singleImageMaxHeight; w = h * a }
            return [CGRect(x: 0, y: 0, width: w.rounded(), height: h.rounded())]
        }
        let cw = ((width - spacing * CGFloat(columns - 1)) / CGFloat(columns)).rounded(.down)
        var out: [CGRect] = []
        var y: CGFloat = 0
        var i = 0
        while i < aspects.count {
            let row = aspects[i..<min(i + columns, aspects.count)]
            // A cell is at most twice as tall as it is wide (docs/timeline-spec.md §1, as Android's
            // gridCellHeight); a wide picture is as short as its shape makes it.
            let heights = row.map { min(cw / max($0, 0.01), cw * 2).rounded() }
            for (k, h) in heights.enumerated() {
                out.append(CGRect(x: CGFloat(k) * (cw + spacing), y: y, width: cw, height: h))
            }
            y += (heights.max() ?? 0) + spacing
            i += columns
        }
        return out
    }
}

// MARK: - Animated GIF

extension EnvironmentValues {
    /// False while the timeline's media should stand still: the list under an open thread
    /// (the Mac keeps it built, unseen).
    @Entry var mediaActive: Bool = true
}

/// A GIF that moves while it can be seen and stops when it cannot (scrolled away, the tab
/// or the panel hidden, a thread over the list). Frames are decoded one at a time off the
/// main thread at the size shown — never all at once at full size (a 100-frame GIF would be
/// 100 bitmaps); a small GIF keeps its frames after the first loop.
struct AnimatedGIF: View {
    let path: String
    var maxPixel = 600
    var onSize: ((CGSize) -> Void)? = nil
    @State private var player = GIFPlayer()
    @State private var visible = false
    @Environment(\.screenVisibility) private var visibility
    @Environment(\.mediaActive) private var mediaActive

    private var running: Bool { visible && mediaActive && (visibility?.timeline ?? true) }

    var body: some View {
        ZStack {
            if let f = player.frame {
                Image(decorative: f.image, scale: 1).resizable().aspectRatio(contentMode: .fit)
            } else {
                Rectangle().fill(Color.primary.opacity(0.06))
                if player.failed { Image(systemName: "photo").foregroundStyle(.tertiary) } else { ProgressView() }
            }
        }
        .overlay(alignment: .bottomLeading) {
            Text("GIF").font(.system(size: 9, weight: .bold)).foregroundStyle(.white)
                .padding(.horizontal, 4).padding(.vertical, 1)
                .background(RoundedRectangle(cornerRadius: 3).fill(.black.opacity(0.55)))
                .padding(5)
                .accessibilityHidden(true)
        }
        .modifier(SeenOnScreen(visible: $visible))
        .task(id: path) {
            await player.load(path: path, maxPixel: maxPixel)
            if let s = player.size { onSize?(s) }
        }
        .onChange(of: running, initial: true) { _, run in
            if run { player.start() } else { player.stop() }
        }
        .onDisappear { player.stop() }
        .accessibilityLabel("GIF 画像")
    }
}

/// On screen (macOS 15 / iOS 18: any part in the scroll view's visible area; before that,
/// built by the lazy list).
struct SeenOnScreen: ViewModifier {
    @Binding var visible: Bool
    func body(content: Content) -> some View {
        if #available(iOS 18.0, macOS 15.0, *) {
            content.onScrollVisibilityChange(threshold: 0.01) { if visible != $0 { visible = $0 } }
                .onDisappear { visible = false }
        } else {
            content.onAppear { visible = true }.onDisappear { visible = false }
        }
    }
}

struct SendableImage: @unchecked Sendable { let image: CGImage }

@MainActor
@Observable
final class GIFPlayer {
    private(set) var frame: SendableImage?
    private(set) var failed = false
    @ObservationIgnored private(set) var size: CGSize?
    @ObservationIgnored private var decoder: GIFDecoder?
    @ObservationIgnored private var task: Task<Void, Never>?
    @ObservationIgnored private var index = 0

    func load(path: String, maxPixel: Int) async {
        guard decoder == nil else { return }
        guard let data = await MediaCache.shared.data(for: path) else { failed = true; return }
        let dec = await Task.detached(priority: .userInitiated) { GIFDecoder(data: data, maxPixel: maxPixel) }.value
        guard let dec else { failed = true; return }
        decoder = dec
        size = dec.size
        if frame == nil { frame = await Task.detached(priority: .userInitiated) { dec.frame(0) }.value }
        if wantsToRun { start() }
    }

    @ObservationIgnored private var wantsToRun = false

    /// How many GIFs are moving right now (the scroll check looks).
    static private(set) var moving = 0

    func start() {
        wantsToRun = true
        guard task == nil, let dec = decoder, dec.count > 1 else { return }
        Self.moving += 1
        task = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                let i = (self.index + 1) % dec.count
                let delay = dec.delay(self.index)
                let t0 = Date()
                let next = await Task.detached(priority: .utility) { dec.frame(i) }.value
                let rest = delay - Date().timeIntervalSince(t0)
                if rest > 0 { try? await Task.sleep(for: .seconds(rest)) }
                guard !Task.isCancelled else { return }
                self.index = i
                if let next { self.frame = next }
            }
        }
    }

    func stop() {
        wantsToRun = false
        if task != nil { Self.moving -= 1 }
        task?.cancel()
        task = nil
    }
}

/// Reads a GIF's frames at a given size. Thread-safe (one frame at a time, behind a lock).
final class GIFDecoder: @unchecked Sendable {
    private let source: CGImageSource
    private let maxPixel: Int
    private let lock = NSLock()
    private var kept: [Int: SendableImage] = [:]
    private let keepAll: Bool
    let count: Int
    let size: CGSize
    private let delays: [Double]

    init?(data: Data, maxPixel: Int) {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let n = CGImageSourceGetCount(src)
        guard n > 0 else { return nil }
        source = src
        count = n
        self.maxPixel = maxPixel
        let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any]
        let w = (props?[kCGImagePropertyPixelWidth] as? CGFloat) ?? 1
        let h = (props?[kCGImagePropertyPixelHeight] as? CGFloat) ?? 1
        size = CGSize(width: w, height: h)
        delays = (0..<n).map { i in
            let p = CGImageSourceCopyPropertiesAtIndex(src, i, nil) as? [CFString: Any]
            let g = p?[kCGImagePropertyGIFDictionary] as? [CFString: Any]
            let d = (g?[kCGImagePropertyGIFUnclampedDelayTime] as? Double) ?? (g?[kCGImagePropertyGIFDelayTime] as? Double) ?? 0.1
            // Browsers draw a delay under 20 ms as 100 ms; so does this.
            return d < 0.02 ? 0.1 : d
        }
        // Keep the decoded frames when they all fit in 12 MB (at the size shown).
        let scale = min(1, CGFloat(maxPixel) / max(w, h))
        keepAll = CGFloat(n) * (w * scale) * (h * scale) * 4 <= 12 * 1024 * 1024
    }

    func delay(_ i: Int) -> Double { delays.indices.contains(i) ? delays[i] : 0.1 }

    func frame(_ i: Int) -> SendableImage? {
        lock.lock()
        defer { lock.unlock() }
        if let hit = kept[i] { return hit }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, i, opts as CFDictionary) else { return nil }
        let img = SendableImage(image: cg)
        if keepAll { kept[i] = img }
        return img
    }
}

// MARK: - One player at a time

/// Only one of the timeline's videos / sounds plays at a time; starting one (with its own
/// button or the system's controls) stops the one before and pauses the jukebox, and the
/// jukebox starting stops them.
@MainActor
enum InlinePlayback {
    private static var current: (id: ObjectIdentifier, stop: () -> Void)?
    /// The jukebox to pause when a video or sound starts (set by the rows that play).
    static weak var jukebox: JukeboxStore?

    static func claim(_ owner: AnyObject, stop: @escaping () -> Void) {
        let id = ObjectIdentifier(owner)
        if let c = current, c.id != id { c.stop() }
        current = (id, stop)
        if jukebox?.isPlaying == true { jukebox?.pause() }
        #if os(iOS)
        // Heard with the ring/silent switch on silent, as the jukebox is. Not while in the
        // voice room (its session records and plays; changing it would cut the call).
        let s = AVAudioSession.sharedInstance()
        if s.category != .playAndRecord {
            try? s.setCategory(.playback, mode: .default)
            try? s.setActive(true)
        }
        #endif
    }

    static func release(_ owner: AnyObject) {
        if current?.id == ObjectIdentifier(owner) { current = nil }
    }

    /// Something else (the jukebox) starts playing.
    static func stopAll() {
        let c = current
        current = nil
        c?.stop()
    }

    private static var finalURLs: [String: URL] = [:]

    /// The media file. Our own uploads need the member's token: where the address finally
    /// leads is checked first (one tiny ranged request whose redirects never carry the token
    /// to another host), and the token goes with the file only when that is still our own
    /// server. AVFoundation sends the header it is given to wherever the file redirects, so
    /// it is never given one for an address that leaves our server.
    static func asset(_ raw: String) async -> AVURLAsset? {
        guard let url = raw.hasPrefix("file:") ? URL(string: raw) : MediaCache.url(raw) else { return nil }
        guard let token = MediaCache.shared.token, MediaCache.isOwnServer(url) else { return AVURLAsset(url: url) }
        let final: URL
        if let known = finalURLs[raw] {
            final = known
        } else {
            var req = URLRequest(url: url)
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            req.setValue("bytes=0-0", forHTTPHeaderField: "Range")
            // Could not check where it ends up: play without the token this time (tried again next time).
            guard let resp = try? await URLSession.shared.data(for: req, delegate: SameServerRedirects()).1,
                  let end = resp.url else { return AVURLAsset(url: url) }
            final = end
            finalURLs[raw] = final
        }
        guard MediaCache.isOwnServer(final) else { return AVURLAsset(url: final) }
        return AVURLAsset(url: final, options: ["AVURLAssetHTTPHeaderFieldsKey": ["Authorization": "Bearer \(token)"]])
    }
}

/// Follows redirects, without the token once one leaves our own server.
private final class SameServerRedirects: NSObject, URLSessionTaskDelegate {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest) async -> URLRequest? {
        var r = request
        if let u = r.url, !MediaCache.isOwnServer(u) { r.setValue(nil, forHTTPHeaderField: "Authorization") }
        return r
    }
}

/// Whether the network is cheap (not a phone's cellular data / Low Data Mode, not a
/// personal hotspot): only then are videos' first frames fetched just for being seen.
final class NetworkCost: @unchecked Sendable {
    static let shared = NetworkCost()
    private let monitor = NWPathMonitor()
    private let lock = NSLock()
    private var _cheap = false
    var cheap: Bool { lock.withLock { _cheap } }

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            let ok = path.status == .satisfied && !path.isExpensive && !path.isConstrained
            self?.lock.withLock { self?._cheap = ok }
        }
        monitor.start(queue: DispatchQueue(label: "fm.backspace.bguru.networkcost"))
    }
}

// MARK: - Video

/// A first frame and the video's shape, made once per video this launch.
@MainActor
enum VideoPosters {
    final class Poster: Sendable { let image: SendableImage?; let aspect: CGFloat?
        init(image: SendableImage?, aspect: CGFloat?) { self.image = image; self.aspect = aspect } }
    private static let cache: NSCache<NSString, Poster> = {
        let c = NSCache<NSString, Poster>()
        c.countLimit = 60
        return c
    }()
    private static var inFlight: [String: Task<Poster, Never>] = [:]

    static func cached(_ url: String) -> Poster? { cache.object(forKey: url as NSString) }

    static func poster(_ url: String) async -> Poster {
        if let hit = cache.object(forKey: url as NSString) { return hit }
        if let t = inFlight[url] { return await t.value }
        let t = Task<Poster, Never> {
            guard let asset = await InlinePlayback.asset(url) else { return Poster(image: nil, aspect: nil) }
            return await Self.make(asset)
        }
        inFlight[url] = t
        let p = await t.value
        inFlight[url] = nil
        cache.setObject(p, forKey: url as NSString)
        return p
    }

    nonisolated private static func make(_ asset: AVURLAsset) async -> Poster {
        let gen = AVAssetImageGenerator(asset: asset)
        gen.appliesPreferredTrackTransform = true
        gen.maximumSize = CGSize(width: 1120, height: 1120)
        if let cg = try? await gen.image(at: .zero).image {
            return Poster(image: SendableImage(image: cg), aspect: CGFloat(cg.width) / CGFloat(max(cg.height, 1)))
        }
        // No frame (yet): at least the shape.
        if let track = try? await asset.loadTracks(withMediaType: .video).first,
           let (size, t) = try? await track.load(.naturalSize, .preferredTransform) {
            let r = CGRect(origin: .zero, size: size).applying(t)
            return Poster(image: nil, aspect: abs(r.width) / max(abs(r.height), 1))
        }
        return Poster(image: nil, aspect: nil)
    }
}

/// The post's video (the web's: as wide as the column up to 560, at most 420 tall, ▶ over
/// the first frame; pressing it plays here with the system's controls). The first frame is
/// fetched for being seen only on a cheap network (NetworkCost); otherwise ▶ 「動画」 until
/// pressed. Under an open thread a frame that arrives does not change the row's height until
/// the thread is closed. Stops when scrolled away or when another video / sound starts.
struct PostVideo: View {
    let url: String
    @State private var model = VideoModel()
    @State private var poster: VideoPosters.Poster?
    @State private var pendingPoster: VideoPosters.Poster?
    @State private var visible = false
    @Environment(\.mediaActive) private var mediaActive
    @Environment(\.screenVisibility) private var visibility
    @Environment(\.jukebox) private var jukebox

    var body: some View {
        FitBox(aspect: poster?.aspect ?? 16.0 / 9.0, maxWidth: TimelineRules.videoMaxWidth, maxHeight: TimelineRules.videoMaxHeight) {
            ZStack {
                Color.black
                if let player = model.player {
                    VideoPlayer(player: player)
                } else {
                    if let img = poster?.image {
                        Image(decorative: img.image, scale: 1).resizable().aspectRatio(contentMode: .fit)
                    }
                    Button {
                        InlinePlayback.jukebox = jukebox
                        model.play(url)
                    } label: {
                        ZStack {
                            Color.black.opacity(0.22)
                            VStack(spacing: 8) {
                                Image(systemName: "play.fill").font(.system(size: 20)).foregroundStyle(.white)
                                    .frame(width: 52, height: 52).background(Circle().fill(.black.opacity(0.7)))
                                if poster?.image == nil {
                                    Text("動画").font(.caption.weight(.semibold)).foregroundStyle(.white.opacity(0.85))
                                }
                            }
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("動画を再生")
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .modifier(SeenOnScreen(visible: $visible))
        .task(id: url) {
            InlinePlayback.jukebox = jukebox
            if poster == nil { poster = VideoPosters.cached(url) }
            guard poster == nil, url.hasPrefix("file:") || NetworkCost.shared.cheap else { return }
            let p = await VideoPosters.poster(url)
            if mediaActive { poster = p } else { pendingPoster = p }
        }
        .onChange(of: mediaActive) { _, on in
            if on, let p = pendingPoster { pendingPoster = nil; poster = p }
        }
        .onChange(of: visible && mediaActive && (visibility?.timeline ?? true)) { _, seen in
            if !seen { model.pause() }
        }
        .onDisappear { model.pause() }
    }
}

@MainActor
@Observable
final class VideoModel {
    private(set) var player: AVPlayer?
    @ObservationIgnored private var status: NSKeyValueObservation?
    @ObservationIgnored private var starting = false

    func play(_ url: String) {
        if let player { player.play(); return }
        guard !starting else { return }
        starting = true
        Task {
            defer { starting = false }
            guard let asset = await InlinePlayback.asset(url) else { return }
            let p = AVPlayer(playerItem: AVPlayerItem(asset: asset))
            // Whatever starts it — the ▶ here or the system's own controls later — it takes
            // the one-player-at-a-time turn (and pauses the jukebox).
            status = p.observe(\.timeControlStatus, options: [.new]) { [weak self] p, _ in
                let playing = p.timeControlStatus != .paused
                Task { @MainActor in
                    guard let self else { return }
                    if playing { InlinePlayback.claim(self) { [weak self] in self?.player?.pause() } } else { InlinePlayback.release(self) }
                }
            }
            player = p
            p.play()
        }
    }

    func pause() {
        player?.pause()
        InlinePlayback.release(self)
    }
}

/// One child, `aspect` wide per tall, as wide as offered up to `maxWidth` and at most
/// `maxHeight` tall (the box keeps the width; what it holds fits inside, as the web's
/// `width: 100%; max-height: 420px` video does).
struct FitBox: Layout {
    var aspect: CGFloat
    var maxWidth: CGFloat
    var maxHeight: CGFloat

    private func size(_ proposal: ProposedViewSize) -> CGSize {
        let w = min(proposal.width ?? maxWidth, maxWidth)
        return CGSize(width: w.rounded(), height: min(w / max(aspect, 0.05), maxHeight).rounded())
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize { size(proposal) }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let s = size(proposal)
        for v in subviews { v.place(at: bounds.origin, proposal: ProposedViewSize(s)) }
    }
}

// MARK: - Audio

/// The post's sound, in a small player (▶ / ❚❚, where it is, how long). The web shows the
/// browser's audio controls. Fetched only when played.
struct PostAudio: View {
    let url: String
    @State private var model = AudioModel()
    @Environment(\.jukebox) private var jukebox

    var body: some View {
        HStack(spacing: 10) {
            Button {
                if model.isPlaying { model.pause() } else {
                    InlinePlayback.jukebox = jukebox
                    model.play(url)
                }
            } label: {
                Image(systemName: model.isPlaying ? "pause.fill" : "play.fill")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Color.accentGreen))
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(model.isPlaying ? "一時停止" : "音声を再生")
            AudioProgress(model: model)
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .frame(maxWidth: TimelineRules.audioMaxWidth, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.primary.opacity(0.05)))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Color.primary.opacity(0.08)))
        .onDisappear { model.pause() }
    }
}

/// The bar and times: its own view, so the position's ticks redraw only this.
private struct AudioProgress: View {
    let model: AudioModel
    var body: some View {
        HStack(spacing: 8) {
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.12))
                    Capsule().fill(Color.accentGreen)
                        .frame(width: g.size.width * (model.duration > 0 ? min(1, model.position / model.duration) : 0))
                }
                .contentShape(Rectangle())
                .gesture(DragGesture(minimumDistance: 0).onEnded { v in
                    guard model.duration > 0 else { return }
                    model.seek(to: max(0, min(1, v.location.x / max(g.size.width, 1))) * model.duration)
                })
            }
            .frame(height: 4)
            Text("\(Self.time(model.position)) / \(model.duration > 0 ? Self.time(model.duration) : "--:--")")
                .font(.caption.monospacedDigit()).foregroundStyle(.secondary)
                .fixedSize()
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("再生位置 \(Self.time(model.position))")
    }

    static func time(_ s: Double) -> String {
        guard s.isFinite, s >= 0 else { return "0:00" }
        let t = Int(s)
        return t >= 3600 ? String(format: "%d:%02d:%02d", t / 3600, t / 60 % 60, t % 60) : String(format: "%d:%02d", t / 60, t % 60)
    }
}

@MainActor
@Observable
final class AudioModel {
    private(set) var isPlaying = false
    private(set) var position: Double = 0
    private(set) var duration: Double = 0
    @ObservationIgnored nonisolated(unsafe) private var player: AVPlayer?
    @ObservationIgnored nonisolated(unsafe) private var observer: Any?
    @ObservationIgnored nonisolated(unsafe) private var endObserver: NSObjectProtocol?

    @ObservationIgnored private var starting = false

    func play(_ url: String) {
        if player == nil {
            guard !starting else { return }
            starting = true
            isPlaying = true
            Task {
                defer { starting = false }
                guard let asset = await InlinePlayback.asset(url) else { isPlaying = false; return }
                start(asset)
            }
            return
        }
        InlinePlayback.claim(self) { [weak self] in self?.pause() }
        player?.play()
        isPlaying = true
    }

    private func start(_ asset: AVURLAsset) {
        do {
            let item = AVPlayerItem(asset: asset)
            let p = AVPlayer(playerItem: item)
            player = p
            observer = p.addPeriodicTimeObserver(forInterval: CMTime(seconds: 0.5, preferredTimescale: 600), queue: .main) { [weak self] t in
                MainActor.assumeIsolated {
                    guard let self else { return }
                    self.position = t.seconds
                    if let d = self.player?.currentItem?.duration.seconds, d.isFinite, d != self.duration { self.duration = d }
                }
            }
            endObserver = NotificationCenter.default.addObserver(forName: AVPlayerItem.didPlayToEndTimeNotification, object: item, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated {
                    self?.player?.seek(to: .zero)
                    self?.position = 0
                    self?.pause()
                }
            }
        }
        InlinePlayback.claim(self) { [weak self] in self?.pause() }
        player?.play()
        isPlaying = true
    }

    func pause() {
        player?.pause()
        if isPlaying { isPlaying = false }
        InlinePlayback.release(self)
    }

    func seek(to s: Double) {
        player?.seek(to: CMTime(seconds: s, preferredTimescale: 600))
        position = s
    }

    deinit {
        if let observer { player?.removeTimeObserver(observer) }
        if let endObserver { NotificationCenter.default.removeObserver(endObserver) }
    }
}
