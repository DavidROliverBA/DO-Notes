// Makes sure the share extension has a capture token whenever someone is signed in to the web
// view. It asks the server with the web view's own sign-in cookie: GET /api/me/tokens says who's
// signed in and whether our token still exists (it may have been revoked in Settings), and
// POST /api/me/tokens makes a new one for the home collection's Inbox (src/tokens.ts). Each device's
// token carries a name of its own ("iPhone app · 7Q4K"), and before making one the app revokes any
// other with that name: a token the app forgot (signed out, the keychain emptied) never piles up.

import Foundation
import WebKit
#if canImport(UIKit)
import UIKit
#endif

@MainActor
final class TokenKeeper {
    /// Read each time: on the Mac the server can be changed in Settings.
    private var server: URL { AppConfig.serverURL }
    private var store: TokenStore { TokenStore.shared }
    private var checking = false
    private var lastCheck = Date.distantPast
    private var again = false

    /// After a page loads or the app comes back: at most every 30 seconds, unless `force`.
    func check(_ cookies: WKHTTPCookieStore, force: Bool = false) {
        guard !checking else {
            // One is running; look again when it's done, so a sign-in during it isn't missed.
            if force { again = true }
            return
        }
        guard force || Date().timeIntervalSince(lastCheck) > 30 else { return }
        checking = true
        lastCheck = Date()
        Task {
            defer {
                checking = false
                if again {
                    again = false
                    check(cookies, force: true)
                }
            }
            let jar = await cookies.allCookies().filter { server.host == $0.domain || server.host?.hasSuffix("." + $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) == true }
            guard !jar.isEmpty else {
                store.clear()
                await Reminders.shared.clear()
                return
            }
            let headers = HTTPCookie.requestHeaderFields(with: jar)
            await ensureToken(cookies: headers)
            // The alerts for dated tasks (F35) are refreshed on the same beat.
            await Reminders.shared.sync(server: server, cookies: headers)
            // And what's new under the bell (F39), as alerts.
            await Alerts.sync(server: server, cookies: headers)
        }
    }

    /// How the token is named in Settings → Connections: one name per device. An iPhone's own
    /// name needs an entitlement, so it has a short code kept in the keychain instead.
    static var deviceName: String {
        #if os(macOS)
        "Mac app (\(Host.current().localizedName ?? "Mac"))"
        #else
        "\(UIDevice.current.model) app · \(DeviceTag.value)"
        #endif
    }

    private func request(_ path: String, method: String = "GET", cookies: [String: String], body: [String: Any]? = nil) -> URLRequest {
        var r = URLRequest(url: server.appendingPathComponent(path))
        r.httpMethod = method
        r.httpShouldHandleCookies = false
        for (k, v) in cookies { r.setValue(v, forHTTPHeaderField: k) }
        r.setValue(AppConfig.origin(of: server), forHTTPHeaderField: "Origin")
        r.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            r.setValue("application/json", forHTTPHeaderField: "Content-Type")
            r.httpBody = try? JSONSerialization.data(withJSONObject: body)
        }
        return r
    }

    private func ensureToken(cookies: [String: String]) async {
        guard let (data, res) = try? await URLSession.shared.data(for: request("api/me/tokens", cookies: cookies)) else { return } // offline: later
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 {
            // Signed out: the extension stops sending to that account at once. The token itself
            // stays listed in Settings → Connections for that person, who can revoke it.
            store.clear()
            return
        }
        guard status == 200, let rows = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else { return }
        let ids = Set(rows.compactMap { ($0["id"] as? NSNumber)?.intValue })
        // Ours is still there for whoever is signed in: nothing to do. Otherwise it was revoked,
        // someone else signed in, or there isn't one yet: make one.
        if let have = store.read(), ids.contains(have.id) { return }
        store.clear()
        // Tokens this device made and forgot: revoke them before making the new one.
        for row in rows where row["name"] as? String == Self.deviceName {
            if let old = (row["id"] as? NSNumber)?.intValue {
                _ = try? await URLSession.shared.data(for: request("api/me/tokens/\(old)", method: "DELETE", cookies: cookies))
            }
        }
        let body: [String: Any] = ["kind": "capture", "name": Self.deviceName, "notePath": "Inbox"]
        guard let (made, res2) = try? await URLSession.shared.data(for: request("api/me/tokens", method: "POST", cookies: cookies, body: body)),
              (res2 as? HTTPURLResponse)?.statusCode == 200,
              let obj = (try? JSONSerialization.jsonObject(with: made)) as? [String: Any],
              let token = obj["token"] as? String,
              let id = ((obj["row"] as? [String: Any])?["id"] as? NSNumber)?.intValue
        else { return }
        store.write(CaptureToken(id: id, token: token))
    }
}

#if !os(macOS)
/// A short code for this iPhone or iPad, made once and kept in the keychain (which outlives a
/// reinstall), so its token's name is its own.
enum DeviceTag {
    static var value: String {
        let store = TokenStore(service: "commonplace.device", account: "tag", accessGroup: AppConfig.keychainGroup)
        if let t = store.read() { return t.token }
        let letters = Array("ABCDEFGHJKLMNPQRSTUVWXYZ23456789")
        let tag = String((0..<4).map { _ in letters.randomElement()! })
        store.write(CaptureToken(id: 0, token: tag))
        return tag
    }
}
#endif
