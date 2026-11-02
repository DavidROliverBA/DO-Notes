// What the app and the share extension are built for (ios/Config/*.xcconfig, through Info.plist).
// On the Mac the server can be changed in Settings (the cloud, or the Mac's own kit); the choice
// is kept in the app group's defaults, so the share extension sends to the same one.

import Foundation

enum AppConfig {
    /// The server the app was built for, such as https://notes.example.com.
    static var builtFor: URL {
        let s = Bundle.main.object(forInfoDictionaryKey: "CPServerURL") as? String ?? ""
        return URL(string: s) ?? URL(string: "http://localhost:8070")!
    }

    /// The Commonplace server: on the Mac, the one chosen in Settings; otherwise `builtFor`.
    static var serverURL: URL {
        #if os(macOS)
        if let s = shared?.string(forKey: serverKey), let url = URL(string: s), url.scheme == "http" || url.scheme == "https" { return url }
        #endif
        return builtFor
    }

    /// The app group the app and the extension share: the keychain group the token is kept in.
    static var appGroup: String {
        Bundle.main.object(forInfoDictionaryKey: "CPAppGroup") as? String ?? "group.com.davidroliver.commonplace"
    }

    /// The keychain group the capture token is kept in: the app group on the iPhone; on the Mac
    /// its own group (`keychain-access-groups`), since a Mac app group isn't one.
    static var keychainGroup: String {
        Bundle.main.object(forInfoDictionaryKey: "CPKeychainGroup") as? String ?? appGroup
    }

    /// The `Origin` a request from the app says it comes from: the server's own, as the web
    /// client's requests do (src/auth.ts sameOrigin).
    static func origin(of url: URL) -> String {
        var s = "\(url.scheme ?? "https")://\(url.host ?? "")"
        if let port = url.port { s += ":\(port)" }
        return s
    }

    #if os(macOS)
    static let serverKey = "server"
    /// The Mac's own kit (laptop/README.md).
    static let kitURL = URL(string: "http://localhost:8070")!
    static var shared: UserDefaults? { UserDefaults(suiteName: appGroup) }

    /// Choose the server (nil: the one it was built for). Windows load it at once (`serverChanged`).
    static func choose(_ url: URL?) {
        if let url { shared?.set(url.absoluteString, forKey: serverKey) } else { shared?.removeObject(forKey: serverKey) }
        NotificationCenter.default.post(name: serverChanged, object: nil)
    }

    static let serverChanged = Notification.Name("CommonplaceServerChanged")
    #endif
}
