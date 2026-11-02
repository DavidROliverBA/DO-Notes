// The capture token the app makes after sign-in, kept in the keychain under the app group so the
// share extension can read it. Only the token and its row id (to revoke it when replaced).

import Foundation
import Security

struct CaptureToken: Codable, Equatable {
    var id: Int
    var token: String
}

struct TokenStore {
    var service = "commonplace.capture"
    /// Which server the token is for; a token for the kit is never sent to the live server.
    var account: String
    /// nil in unit tests, which run without the app's entitlements.
    var accessGroup: String?

    static var shared: TokenStore {
        TokenStore(account: AppConfig.origin(of: AppConfig.serverURL), accessGroup: AppConfig.keychainGroup)
    }

    private var query: [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        if let g = accessGroup { q[kSecAttrAccessGroup as String] = g }
        #if os(macOS)
        // The keychain the iPhone uses, where an access group can be shared with the extension.
        q[kSecUseDataProtectionKeychain as String] = true
        #endif
        return q
    }

    func read() -> CaptureToken? {
        var q = query
        q[kSecReturnData as String] = true
        q[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: AnyObject?
        guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let data = out as? Data else { return nil }
        return try? JSONDecoder().decode(CaptureToken.self, from: data)
    }

    @discardableResult
    func write(_ t: CaptureToken) -> Bool {
        guard let data = try? JSONEncoder().encode(t) else { return false }
        SecItemDelete(query as CFDictionary)
        var q = query
        q[kSecValueData as String] = data
        // Readable by the extension while the phone is locked after the first unlock (sharing
        // from a lock-screen widget or a background app).
        q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        return SecItemAdd(q as CFDictionary, nil) == errSecSuccess
    }

    func clear() {
        SecItemDelete(query as CFDictionary)
    }
}
