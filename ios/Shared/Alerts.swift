// Notifications as alerts (F39): when the app refreshes (as it does for reminders, Shared/
// Reminders.swift: on opening, coming back, and on the iPhone in the background), it asks the
// server what's new under the bell (GET /api/me/notifications) and shows anything it hasn't
// shown on this device: a mention, an invitation, a change to a note you follow, a comment. No
// push service, so an alert can wait until the next refresh. Tapping one opens its note.

import Foundation
import UserNotifications

struct BellItem: Codable {
    var id: Int
    var kind: String
    var text: String
    var vaultId: Int?
    var noteId: Int?
    var read: Bool
}

struct Bell: Codable {
    var unread: Int
    var items: [BellItem]
}

enum Alerts {
    /// The newest notification this device has shown, per server.
    private static func key(_ server: URL) -> String { "alerted-\(AppConfig.origin(of: server))" }

    /// Which to show: unread ones newer than the last shown, oldest first, at most five at a time.
    /// The first time, none: the device starts from now rather than replaying the past.
    static func toShow(_ bell: Bell, after last: Int?) -> (show: [BellItem], newest: Int) {
        let newest = bell.items.map(\.id).max() ?? (last ?? 0)
        guard let last else { return ([], newest) }
        let fresh = bell.items.filter { $0.id > last && !$0.read }.sorted { $0.id < $1.id }
        return (Array(fresh.suffix(5)), max(newest, last))
    }

    @MainActor
    static func sync(server: URL, cookies: [String: String]) async {
        var req = URLRequest(url: server.appendingPathComponent("api/me/notifications"))
        req.httpShouldHandleCookies = false
        for (k, v) in cookies { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, res) = try? await URLSession.shared.data(for: req), (res as? HTTPURLResponse)?.statusCode == 200,
              let bell = try? JSONDecoder().decode(Bell.self, from: data) else { return }
        let defaults = UserDefaults.standard
        let last = defaults.object(forKey: key(server)) as? Int
        let (show, newest) = toShow(bell, after: last)
        defaults.set(newest, forKey: key(server))
        guard !show.isEmpty else { return }
        let center = UNUserNotificationCenter.current()
        if await center.notificationSettings().authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        for item in show {
            let c = UNMutableNotificationContent()
            c.title = "DO Notes"
            c.body = item.text
            c.sound = .default
            c.threadIdentifier = "bell"
            if let v = item.vaultId, let n = item.noteId { c.userInfo = ["open": "commonplace://open/v/\(v)/n/\(n)"] }
            try? await center.add(UNNotificationRequest(identifier: "skein-bell-\(item.id)", content: c, trigger: nil))
        }
    }
}
