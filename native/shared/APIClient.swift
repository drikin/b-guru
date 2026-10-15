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
    static let baseURL = URL(string: "https://bsm.backspace.fm")!

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

    func chat(limit: Int = 100) async throws -> ChatListResponse {
        var comps = URLComponents(url: APIClient.baseURL.appendingPathComponent("/api/agent/chat"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [.init(name: "limit", value: String(limit)), .init(name: "include", value: "reactions")]
        var req = request("GET", "/api/agent/chat")
        req.url = comps.url
        return try await send(req)
    }

    func post(body: String, clientId: String) async throws -> ChatMessage {
        let r: ChatSendResponse = try await send(request("POST", "/api/agent/chat", json: ["body": body, "client_id": clientId]))
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

    func revokeSelf() async {
        _ = try? await session.data(for: request("DELETE", "/api/agent/token/self"))
    }
}
