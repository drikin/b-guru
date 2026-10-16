import SwiftUI

/// Uploaded images (/api/media/…) need the member's token — the app has no web
/// session — so they are fetched with the Bearer header and kept in memory.
@MainActor
final class MediaCache {
    static let shared = MediaCache()
    private let cache = NSCache<NSString, PlatformImage>()
    private var inFlight: [String: Task<PlatformImage?, Never>] = [:]
    var token: String?

    init() { cache.countLimit = 300 }

    static func url(_ raw: String) -> URL? {
        raw.hasPrefix("http") ? URL(string: raw) : URL(string: raw, relativeTo: APIClient.baseURL)?.absoluteURL
    }

    func cached(_ raw: String) -> PlatformImage? { cache.object(forKey: raw as NSString) }

    func image(for raw: String) async -> PlatformImage? {
        if let hit = cached(raw) { return hit }
        if let t = inFlight[raw] { return await t.value }
        let token = self.token
        let t = Task<PlatformImage?, Never> {
            guard let url = Self.url(raw) else { return nil }
            var req = URLRequest(url: url)
            // Only our own server (same scheme, host and port) ever gets the token.
            let base = APIClient.baseURL
            if let token, url.scheme == base.scheme, url.host == base.host, url.port == base.port {
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
            }
            guard let (data, resp) = try? await URLSession.shared.data(for: req),
                  (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
            return PlatformImage(data: data)
        }
        inFlight[raw] = t
        let img = await t.value
        inFlight[raw] = nil
        if let img { cache.setObject(img, forKey: raw as NSString) }
        return img
    }
}

struct MediaImage: View {
    let path: String
    var contentMode: ContentMode = .fill
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
            if let hit = MediaCache.shared.cached(path) { image = hit; return }
            image = await MediaCache.shared.image(for: path)
            failed = image == nil
        }
    }
}
