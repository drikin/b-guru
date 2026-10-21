import Foundation

enum APIError: Error, Sendable {
    case unauthorized(code: String?)
    case http(status: Int, code: String?, message: String?)
    case transport(String)

    /// Retrying will not help (bad input, auth gone) — the caller should give
    /// the text back to the user instead of offering 再送.
    var isPermanent: Bool {
        switch self {
        case .unauthorized: return true
        case let .http(status, _, _): return (400..<500).contains(status) && status != 408 && status != 429
        case .transport: return false
        }
    }
}

/// Talks to /api/agent/*. One shared URLSession so requests ride a warm
/// HTTP/2 connection — the single biggest factor in how fast a send feels.
final class APIClient: Sendable {
    static let baseURL: URL = {
        #if DEBUG
        // Dev only: BGURU_DEV_BASE_URL=http://localhost:3000 talks to a local server.
        if let s = ProcessInfo.processInfo.environment["BGURU_DEV_BASE_URL"], let u = URL(string: s) { return u }
        #endif
        return URL(string: "https://bsm.backspace.fm")!
    }()

    let token: String
    private let session: URLSession
    private let decoder: JSONDecoder = {
        let d = JSONDecoder()
        d.keyDecodingStrategy = .convertFromSnakeCase
        return d
    }()

    init(token: String) {
        self.token = token
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = 15
        cfg.httpMaximumConnectionsPerHost = 4
        cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
        cfg.httpAdditionalHeaders = ["User-Agent": APIClient.userAgent]
        self.session = URLSession(configuration: cfg)
    }

    static var userAgent: String {
        let v = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0"
        return "BguruChatMac/\(v)"
    }

    func request(_ method: String, _ path: String, json: [String: Any]? = nil) -> URLRequest {
        var req = URLRequest(url: APIClient.baseURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let json {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try? JSONSerialization.data(withJSONObject: json)
        }
        return req
    }

    func send<T: Decodable>(_ req: URLRequest, as: T.Type = T.self) async throws -> T {
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            throw APIError.transport(error.localizedDescription)
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let body = try? decoder.decode(APIErrorBody.self, from: data)
            if status == 401 { throw APIError.unauthorized(code: body?.code) }
            throw APIError.http(status: status, code: body?.code, message: body?.error)
        }
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError.transport("decode: \(error)")
        }
    }

    // MARK: - Endpoints

    func capabilities() async throws -> Capabilities {
        try await send(request("GET", "/api/agent/capabilities"))
    }

    // MARK: Club room

    func room() async throws -> RoomResponse {
        try await send(request("GET", "/api/agent/room"))
    }

    /// POST /api/agent/room { action, … } — enter / text / move / voice / react.
    func roomAction(_ body: [String: Any]) async throws -> RoomActionResponse {
        try await send(request("POST", "/api/agent/room", json: body))
    }

    // MARK: Jukebox

    /// GET /api/agent/jukebox — every past episode and today's pick (raw bytes, cached by the store).
    func jukeboxData(path: String) async throws -> Data {
        let (data, resp): (Data, URLResponse)
        do { (data, resp) = try await session.data(for: request("GET", path)) } catch {
            throw APIError.transport(error.localizedDescription)
        }
        let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { throw APIError.unauthorized(code: nil) }
        guard (200..<300).contains(status) else { throw APIError.http(status: status, code: nil, message: nil) }
        return data
    }

    // MARK: BS ネタ帳

    /// POST /api/agent/neta { url, title, description? }.
    func sendToNeta(path: String, url: String, title: String, description: String) async -> NetaOutcome {
        var body: [String: Any] = ["url": url, "title": title]
        if !description.isEmpty { body["description"] = description }
        do {
            let (data, resp) = try await session.data(for: request("POST", path, json: body))
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
            if status == 201 { return .sent }
            if status == 409, let ex = obj["existing"] as? [String: Any] {
                return .duplicate(title: ex["title"] as? String ?? "", submitter: ex["submitter"] as? String ?? "")
            }
            return .failed(obj["error"] as? String ?? "送れませんでした（\(status)）")
        } catch {
            return .failed("ネタ帳につながりませんでした")
        }
    }

    // MARK: ☗ 将棋 (docs/shogi-spec.md: GET = scope read, POST = scope chat)

    /// GET {path}/games?status=… — the lobby (ended: the latest 20).
    func shogiGames(path: String, statuses: [String] = ["open", "offered", "active", "ended"]) async throws -> ShogiListResponse {
        var comps = URLComponents(url: APIClient.baseURL.appendingPathComponent("\(path)/games"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "status", value: statuses.joined(separator: ","))]
        var req = request("GET", "\(path)/games")
        req.url = comps.url
        return try await send(req)
    }

    /// GET {path}/games/{id} — the whole game (moves, my_color).
    func shogiGame(path: String, id: Int) async throws -> ShogiGame {
        struct R: Decodable { var game: ShogiGame }
        let r: R = try await send(request("GET", "\(path)/games/\(id)"))
        return r.game
    }

    /// POST {path}/games[/{id}/{action}]. Never throws: a 409 carries the latest game,
    /// which the caller shows (the board goes back to it). status 0 = no answer.
    func shogiPost(path: String, _ sub: String, json: [String: any Sendable] = [:]) async -> ShogiPostOutcome {
        do {
            let (data, resp) = try await session.data(for: request("POST", "\(path)/\(sub)", json: json))
            let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
            struct Body: Decodable { var game: ShogiGame?; var error: String?; var code: String?; var duplicate: Bool?; var spectators: Int? }
            let body = try? decoder.decode(Body.self, from: data)
            return ShogiPostOutcome(status: status, game: body?.game, error: body?.error, code: body?.code,
                                    spectators: body?.spectators)
        } catch {
            return ShogiPostOutcome(status: 0, game: nil, error: nil, code: nil, spectators: nil)
        }
    }

    // MARK: 🎮 散財ダッシュ (docs/minigame-spec.md: GET = scope read, POST = scope chat)

    /// The game's requests, relayed as they are: the HTTP status and the JSON body (status 0 = no answer).
    func minigameRaw(_ method: String, path: String, query: [URLQueryItem] = [], json: [String: any Sendable]? = nil) async -> (Int, Data) {
        var req = request(method, path, json: json)
        if !query.isEmpty, var c = URLComponents(url: APIClient.baseURL.appendingPathComponent(path), resolvingAgainstBaseURL: false) {
            c.queryItems = query
            req.url = c.url
        }
        do {
            let (data, resp) = try await session.data(for: req)
            return ((resp as? HTTPURLResponse)?.statusCode ?? 0, data)
        } catch {
            return (0, Data())
        }
    }

    // MARK: Voice room

    func voiceState() async throws -> VoiceStateResponse {
        try await send(request("GET", "/api/agent/voice"))
    }

    func voiceToken() async throws -> VoiceTokenResponse {
        try await send(request("POST", "/api/agent/voice/token", json: [:]))
    }

    struct OK: Decodable, Sendable { var ok: Bool }

    struct MuteResult: Decodable, Sendable { var ok: Bool; var muted: Bool? }

    func voiceReport(userId: String, reason: String) async throws {
        _ = try await send(request("POST", "/api/agent/voice/report", json: ["user_id": userId, "reason": reason]), as: OK.self)
    }

    func voiceMute(userId: String) async throws -> Bool {
        try await send(request("POST", "/api/agent/voice/mute", json: ["user_id": userId]), as: MuteResult.self).muted ?? false
    }

    func voiceKick(userId: String, ban: Bool) async throws {
        _ = try await send(request("POST", "/api/agent/voice/kick", json: ["user_id": userId, "ban": ban]), as: OK.self)
    }

    func chat(limit: Int = 100) async throws -> ChatListResponse {
        var comps = URLComponents(url: APIClient.baseURL.appendingPathComponent("/api/agent/chat"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "limit", value: String(limit)), .init(name: "include", value: "reactions")]
        var req = request("GET", "/api/agent/chat")
        req.url = comps.url
        return try await send(req)
    }

    func post(body: String, clientId: String, images: [String] = []) async throws -> ChatMessage {
        var json: [String: Any] = ["body": body, "client_id": clientId]
        if !images.isEmpty { json["images"] = images }
        let r: ChatSendResponse = try await send(request("POST", "/api/agent/chat", json: json))
        return r.message
    }

    func edit(id: Int, body: String) async throws -> ChatMessage {
        let r: ChatSendResponse = try await send(request("PATCH", "/api/agent/chat/\(id)", json: ["body": body]))
        return r.message
    }

    func toggleReaction(id: Int, emoji: String) async throws -> ReactionToggleResponse {
        try await send(request("POST", "/api/agent/chat/\(id)/reactions", json: ["emoji": emoji]))
    }

    func markRead(upTo id: Int) async throws -> ReadResponse {
        try await send(request("POST", "/api/agent/chat/read", json: ["last_read_id": id]))
    }

    func summary() async throws -> SummaryResponse {
        try await send(request("GET", "/api/agent/summary"))
    }

    /// APNs device token for this iPhone/iPad (hex). environment: "sandbox" | "production".
    func registerPush(deviceToken: String, environment: String, platform: String,
                      notifyMode: String = "all", quietHours: Bool = true, notifyTimeline: Bool? = nil,
                      notifyShogi: Bool? = nil) async throws {
        struct OK: Decodable { var ok: Bool }
        var body: [String: Any] = ["token": deviceToken, "environment": environment, "platform": platform,
                                   "notify_mode": notifyMode, "quiet_hours": quietHours]
        if let notifyTimeline { body["notify_timeline"] = notifyTimeline }
        // ☗ 将棋 pushes (shogi_offer / shogi_turn) come only to apps that say they know them.
        if let notifyShogi { body["notify_shogi"] = notifyShogi }
        let _: OK = try await send(request("POST", "/api/agent/devices/push", json: body))
    }

    func unregisterPush(deviceToken: String) async {
        _ = try? await session.data(for: request("DELETE", "/api/agent/devices/push", json: ["token": deviceToken]))
    }

    func members() async throws -> [MentionMember] {
        struct R: Decodable { var members: [MentionMember] }
        let r: R = try await send(request("GET", "/api/agent/members"))
        return r.members
    }

    func chatMessage(id: Int) async throws -> ChatMessage {
        let r: ChatSendResponse = try await send(request("GET", "/api/agent/chat/\(id)"))
        return r.message
    }

    // MARK: - Timeline

    func posts(cursor: String? = nil, limit: Int = 30) async throws -> PostListResponse {
        var comps = URLComponents(url: APIClient.baseURL.appendingPathComponent("/api/agent/posts"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "limit", value: String(limit)), .init(name: "include", value: "reactions,read")]
        if let cursor { comps.queryItems?.append(.init(name: "cursor", value: cursor)) }
        var req = request("GET", "/api/agent/posts")
        req.url = comps.url
        return try await send(req)
    }

    func thread(id: Int) async throws -> ThreadResponse {
        var comps = URLComponents(url: APIClient.baseURL.appendingPathComponent("/api/agent/posts/\(id)"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "include", value: "reactions,read")]
        var req = request("GET", "/api/agent/posts/\(id)")
        req.url = comps.url
        return try await send(req)
    }

    func clubs() async throws -> [ClubInfo] {
        struct R: Decodable { var clubs: [ClubInfo] }
        let r: R = try await send(request("GET", "/api/agent/clubs"))
        return r.clubs
    }

    func publish(text: String, images: [String], parentId: Int?) async throws -> Post {
        var json: [String: Any] = ["text": text, "images": images]
        if let parentId { json["parent_id"] = parentId }
        let r: PublishResponse = try await send(request("POST", "/api/agent/publish", json: json))
        return r.post
    }

    /// JPEG data for each image (already resized by the caller). Returns /api/media/… URLs.
    /// `path`: the timeline's upload, or the chat's (/api/agent/chat/upload).
    func upload(images: [Data], path: String = "/api/agent/upload") async throws -> [String] {
        let boundary = "bguru-\(UUID().uuidString)"
        var body = Data()
        for (i, data) in images.enumerated() {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"images\"; filename=\"photo\(i).jpg\"\r\nContent-Type: image/jpeg\r\n\r\n".utf8))
            body.append(data)
            body.append(Data("\r\n".utf8))
        }
        body.append(Data("--\(boundary)--\r\n".utf8))
        var req = request("POST", path)
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        req.timeoutInterval = 120
        let r: UploadResponse = try await send(req)
        return r.urls
    }

    func togglePostReaction(id: Int, emoji: String) async throws -> PostReactionToggleResponse {
        try await send(request("POST", "/api/agent/reactions", json: ["post_id": id, "emoji": emoji]))
    }

    func markPostsRead(_ ids: [Int]) async {
        _ = try? await session.data(for: request("POST", "/api/agent/read", json: ["post_ids": ids]))
    }

    func revokeSelf() async {
        _ = try? await session.data(for: request("DELETE", "/api/agent/token/self"))
    }
}
