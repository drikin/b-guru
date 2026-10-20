import Foundation
import UserNotifications

/// Fills in the real text of a B-guru push. The server sends ids and a generic
/// line only (privacy); here, on the device, we fetch the message with this
/// device's own token (shared Keychain) and replace title/body. On any failure
/// or when time runs out, the generic text is shown — never nothing.
final class NotificationService: UNNotificationServiceExtension, @unchecked Sendable {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var best: UNMutableNotificationContent?

    override func didReceive(_ request: UNNotificationRequest,
                             withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void) {
        self.contentHandler = contentHandler
        guard let content = request.content.mutableCopy() as? UNMutableNotificationContent else {
            contentHandler(request.content)
            return
        }
        best = content
        guard let token = Keychain.load() else {
            contentHandler(content)
            return
        }
        let info = content.userInfo
        let ask = Lookup(
            kind: info["kind"] as? String ?? "",
            messageId: (info["message_id"] as? NSNumber)?.intValue,
            postId: (info["post_id"] as? NSNumber)?.intValue,
            replyId: (info["reply_id"] as? NSNumber)?.intValue
        )
        Task {
            if let text = await Self.lookup(ask, token: token) { self.apply(text) }
            self.finish()
        }
    }

    override func serviceExtensionTimeWillExpire() {
        finish()
    }

    private func apply(_ t: (title: String, body: String)) {
        best?.title = t.title
        best?.body = t.body
    }

    private func finish() {
        guard let handler = contentHandler, let content = best else { return }
        contentHandler = nil
        handler(content)
    }

    private static let base = URL(string: "https://bsm.backspace.fm")!

    private static func get(_ path: String, token: String) async -> [String: Any]? {
        var req = URLRequest(url: base.appendingPathComponent(path))
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.timeoutInterval = 8
        guard let (data, resp) = try? await URLSession.shared.data(for: req),
              (resp as? HTTPURLResponse)?.statusCode == 200 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    }

    private static func clip(_ s: String) -> String {
        s.count > 240 ? String(s.prefix(240)) + "…" : s
    }

    struct Lookup: Sendable {
        var kind: String
        var messageId: Int?
        var postId: Int?
        var replyId: Int?
    }

    /// The real (title, body) for a push, or nil to keep the generic text.
    static func lookup(_ q: Lookup, token: String) async -> (title: String, body: String)? {
        switch q.kind {
        case "chat_mention", "chat_new":
            guard let id = q.messageId,
                  let m = await get("/api/agent/chat/\(id)", token: token)?["message"] as? [String: Any],
                  let body = m["body"] as? String else { return nil }
            let name = (m["author_name"] as? String) ?? "誰か"
            return ("\(name)（B-guru チャット）", clip(body))
        case "reply":
            guard let postId = q.postId,
                  let thread = await get("/api/agent/posts/\(postId)", token: token) else { return nil }
            let replies = thread["replies"] as? [[String: Any]] ?? []
            guard let r = replies.first(where: { ($0["id"] as? NSNumber)?.intValue == q.replyId }) ?? replies.last,
                  let text = r["text"] as? String else { return nil }
            return ("\((r["author_name"] as? String) ?? "誰か") が返信しました", clip(text))
        case "timeline_new":
            guard let postId = q.postId,
                  let post = await get("/api/agent/posts/\(postId)", token: token)?["post"] as? [String: Any],
                  let text = post["text"] as? String else { return nil }
            return ("\((post["author_name"] as? String) ?? "誰か") が投稿しました", clip(text))
        default:
            return nil
        }
    }
}
