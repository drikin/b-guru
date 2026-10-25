import SwiftUI

import ImageIO

/// Post photos, avatars and custom emoji. Every image is decoded at the size it is
/// shown, off the main thread (ImageIO thumbnails) — never the original: a phone
/// photo is 4032×3024 = 48 MB once decoded, and UIImage(data:) decoded it on the
/// main thread at first draw, which is what made scrolling stutter. The memory
/// cache is bounded by bytes. Uploaded images (/api/media/…) need the member's
/// token — the app has no web session — so they are fetched with the Bearer header.
@MainActor
final class MediaCache {
    static let shared = MediaCache()
    private let cache = NSCache<NSString, PlatformImage>()
    private var inFlight: [String: Task<PlatformImage?, Never>] = [:]
    var token: String?

    init() { cache.totalCostLimit = 64 * 1024 * 1024 }

    /// Photos, avatars and emoji are served `immutable` for a year, but the shared session's
    /// small default cache keeps few of them (nothing over ~5 % of its size): each launch,
    /// and each photo opened at another size, downloaded them again. Their own disk cache.
    nonisolated static let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        cfg.urlCache = URLCache(memoryCapacity: 16 * 1024 * 1024, diskCapacity: 300 * 1024 * 1024,
                                directory: FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?
                                    .appendingPathComponent("MediaCache", isDirectory: true))
        cfg.requestCachePolicy = .useProtocolCachePolicy
        return URLSession(configuration: cfg)
    }()

    nonisolated static func url(_ raw: String) -> URL? {
        raw.hasPrefix("http") ? URL(string: raw) : URL(string: raw, relativeTo: APIClient.baseURL)?.absoluteURL
    }

    private static func key(_ raw: String, _ maxPixel: Int) -> NSString { "\(raw)@\(maxPixel)" as NSString }

    #if DEBUG
    /// Dev only (the orientation self-test): a picture under a made-up path, at every size asked for.
    func debugInsert(_ image: PlatformImage, for raw: String) {
        for px in [MediaImage.defaultPixels, 600, 900, 2560, AvatarCache.pixels] { cache.setObject(image, forKey: Self.key(raw, px)) }
    }
    #endif

    /// The file's bytes as served (animated GIFs: the original, never a resized copy).
    /// Kept by size in their own small cache.
    private let dataCache: NSCache<NSString, NSData> = {
        let c = NSCache<NSString, NSData>()
        c.totalCostLimit = 24 * 1024 * 1024
        return c
    }()
    private var dataInFlight: [String: Task<Data?, Never>] = [:]

    #if DEBUG
    func debugInsertData(_ data: Data, for raw: String) { dataCache.setObject(data as NSData, forKey: raw as NSString, cost: data.count) }
    #endif

    func data(for raw: String) async -> Data? {
        if let hit = dataCache.object(forKey: raw as NSString) { return hit as Data }
        if let t = dataInFlight[raw] { return await t.value }
        let req = Self.request(raw, token: token)
        let t = Task<Data?, Never> {
            guard let req, let (data, resp) = try? await Self.session.data(for: req),
                  (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return data
        }
        dataInFlight[raw] = t
        let d = await t.value
        dataInFlight[raw] = nil
        if let d { dataCache.setObject(d as NSData, forKey: raw as NSString, cost: d.count) }
        return d
    }

    /// A request for a media path; only our own server (same scheme, host and port) ever gets the token.
    nonisolated static func request(_ raw: String, token: String?) -> URLRequest? {
        guard let url = url(raw) else { return nil }
        var req = URLRequest(url: url)
        if let token, isOwnServer(url) { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return req
    }

    nonisolated static func isOwnServer(_ url: URL) -> Bool {
        let base = APIClient.baseURL
        return url.scheme == base.scheme && url.host == base.host && url.port == base.port
    }

    func cached(_ raw: String, maxPixel: Int = MediaImage.defaultPixels) -> PlatformImage? {
        cache.object(forKey: Self.key(raw, maxPixel))
    }

    /// The image at most `maxPixel` pixels on its long side.
    func image(for raw: String, maxPixel: Int = MediaImage.defaultPixels) async -> PlatformImage? {
        let key = Self.key(raw, maxPixel)
        if let hit = cache.object(forKey: key) { return hit }
        if let t = inFlight[key as String] { return await t.value }
        let token = self.token
        let t = Task<PlatformImage?, Never> {
            guard let url = Self.url(raw) else { return nil }
            var req = URLRequest(url: url)
            // Only our own server (same scheme, host and port) ever gets the token.
            let base = APIClient.baseURL
            if let token, url.scheme == base.scheme, url.host == base.host, url.port == base.port {
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            guard let (data, resp) = try? await Self.session.data(for: req),
                  (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            guard let cg = await Task.detached(priority: .userInitiated, operation: { Self.decode(data, maxPixel: maxPixel) }).value
            else { return nil }
            return PlatformImage.decoded(cg)
        }
        inFlight[key as String] = t
        let img = await t.value
        inFlight[key as String] = nil
        if let img, let cg = img.cgImageForCost { cache.setObject(img, forKey: key, cost: cg.bytesPerRow * cg.height) }
        return img
    }

    /// Scaled while decoding (no full-size bitmap ever exists), EXIF rotation applied,
    /// and fully decoded here — so drawing it later costs nothing on the main thread.
    nonisolated static func decode(_ data: Data, maxPixel: Int) -> CGImage? {
        guard let src = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary) else { return nil }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        return CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary)
    }
}

extension PlatformImage {
    static func decoded(_ cg: CGImage) -> PlatformImage {
        #if os(macOS)
        NSImage(cgImage: cg, size: NSSize(width: cg.width, height: cg.height))
        #else
        UIImage(cgImage: cg, scale: 1, orientation: .up)
        #endif
    }

    fileprivate var cgImageForCost: CGImage? {
        #if os(macOS)
        cgImage(forProposedRect: nil, context: nil, hints: nil)
        #else
        cgImage
        #endif
    }
}

struct MediaImage: View {
    /// A wide photo across the screen (≈ 400 pt × 3).
    static let defaultPixels = 1200

    let path: String
    var contentMode: ContentMode = .fill
    /// Longest side it is decoded at.
    var maxPixel: Int = MediaImage.defaultPixels
    /// Told the picture's size (in pixels) once it is here — the post's pictures keep
    /// their shape (`PostImages`).
    var onSize: ((CGSize) -> Void)? = nil
    @State private var image: PlatformImage?
    @State private var failed = false

    var body: some View {
        ZStack {
            if let image {
                Image(platformImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else {
                Rectangle().fill(Color.primary.opacity(0.06))
                if failed { Image(systemName: "photo").foregroundStyle(.tertiary) } else { ProgressView() }
            }
        }
        .task(id: path) {
            if let hit = MediaCache.shared.cached(path, maxPixel: maxPixel) { image = hit; onSize?(hit.size); return }
            image = await MediaCache.shared.image(for: path, maxPixel: maxPixel)
            failed = image == nil
            if let image { onSize?(image.size) }
        }
    }
}
