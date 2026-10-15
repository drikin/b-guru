import Foundation
import Security

/// The agent token lives only in the login Keychain, bound to this device
/// (never synced, never readable before first unlock).
enum Keychain {
    private static let service = "fm.backspace.bguru.chat"
    private static let account = "agent-token"

    /// iOS: shared with the Notification Service Extension (it fetches the
    /// real text of a push with this token). macOS keeps the app-only item.
    #if os(iOS)
    static let accessGroup: String? = "F9349EVF2K.fm.backspace.bguru.chat.shared"
    #else
    static let accessGroup: String? = nil
    #endif

    private static func base() -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let g = accessGroup { q[kSecAttrAccessGroup as String] = g }
        return q
    }

    static func load() -> String? {
        var q = base()
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess,
              let data = out as? Data else { return nil }
        return String(data: data, encoding: .utf8)
    }

    @discardableResult
    static func save(_ token: String) -> Bool {
        delete()
        var q = base()
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        q[kSecValueData as String] = Data(token.utf8)
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    static func delete() {
        SecItemDelete(base() as CFDictionary)
    }
}
