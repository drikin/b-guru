import Foundation

struct ServerEvent: Sendable {
    var event: String
    var data: Data
}

/// GET /api/agent/stream (Server-Sent Events). Yields events until the
/// connection drops; the caller reconnects with backoff. The server sends a
/// comment line every 25 s, so a 70 s read timeout means "dead connection".
enum LiveStream {
    static func connect(token: String) -> AsyncThrowingStream<ServerEvent, Error> {
        AsyncThrowingStream { continuation in
            let task = Task {
                let cfg = URLSessionConfiguration.default
                cfg.timeoutIntervalForRequest = 70
                cfg.timeoutIntervalForResource = .infinity
                cfg.httpAdditionalHeaders = ["User-Agent": APIClient.userAgent]
                let session = URLSession(configuration: cfg)
                var req = URLRequest(url: APIClient.baseURL.appendingPathComponent("/api/agent/stream"))
                req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
                req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
                do {
                    let (bytes, resp) = try await session.bytes(for: req)
                    let status = (resp as? HTTPURLResponse)?.statusCode ?? 0
                    if status == 401 { throw APIError.unauthorized(code: nil) }
                    guard status == 200 else { throw APIError.http(status: status, code: nil, message: nil) }
                    var name = "message"
                    var data = ""
                    for try await line in bytes.lines {
                        if line.isEmpty {
                            if !data.isEmpty {
                                continuation.yield(ServerEvent(event: name, data: Data(data.utf8)))
                            }
                            name = "message"
                            data = ""
                        } else if line.hasPrefix(":") {
                            continue // heartbeat
                        } else if line.hasPrefix("event:") {
                            name = line.dropFirst(6).trimmingCharacters(in: .whitespaces)
                        } else if line.hasPrefix("data:") {
                            if !data.isEmpty { data += "\n" }
                            data += line.dropFirst(5).trimmingCharacters(in: .whitespaces)
                        }
                        // `lines` drops the blank separator line, so dispatch as
                        // soon as a data line completes a JSON object as well.
                        if !data.isEmpty, data.hasSuffix("}"), let d = data.data(using: .utf8),
                           (try? JSONSerialization.jsonObject(with: d)) != nil {
                            continuation.yield(ServerEvent(event: name, data: d))
                            name = "message"
                            data = ""
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
                session.invalidateAndCancel()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
