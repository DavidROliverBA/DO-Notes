// Reminders for dated tasks (F35): the app asks the server which of your tasks are due
// (GET /api/me/reminders, src/reminders.ts) with the web view's sign-in, and schedules each as an
// alert on this device. No push service: the alerts are local, so they arrive offline too. The
// list is refreshed whenever the app checks its sharing token (Shared/TokenKeeper.swift), and on
// the iPhone in the background as well. An alert offers Done (ticks the task in its note) and
// Remind me in an hour; tapping it opens the note.

import Foundation
import UserNotifications
import WebKit

struct Reminder: Codable, Equatable {
    var key: String
    var vaultId: Int
    var vault: String
    var noteId: Int
    var path: String
    var title: String
    var line: Int
    var task: String
    var text: String
    var due: String
    var at: String
}

struct ReminderList: Codable {
    var on: Bool
    var time: String
    var reminders: [Reminder]
}

@MainActor
final class Reminders: NSObject, UNUserNotificationCenterDelegate {
    static let shared = Reminders()
    static let category = "SKEIN_TASK"
    static let prefix = "skein-reminder-"
    /// iOS keeps at most 64 pending alerts per app; leave room for snoozes.
    static let most = 56

    /// Opens a commonplace://open/… link: set by each app (the iPhone's link inbox, the Mac's windows).
    var open: (URL) -> Void = { _ in }
    private var center: UNUserNotificationCenter { .current() }

    /// Call once at launch: the alerts' actions, and this object answering them.
    func start() {
        let done = UNNotificationAction(identifier: "done", title: "Done", options: [])
        let later = UNNotificationAction(identifier: "later", title: "Remind me in an hour", options: [])
        center.setNotificationCategories([UNNotificationCategory(identifier: Self.category, actions: [done, later], intentIdentifiers: [])])
        center.delegate = self
    }

    /// When to remind, read as this device's own time: "2026-11-02T09:00".
    static func date(_ at: String, calendar: Calendar = .current) -> Date? {
        let parts = at.split(whereSeparator: { $0 == "-" || $0 == "T" || $0 == ":" }).compactMap { Int($0) }
        guard parts.count == 5 else { return nil }
        return calendar.date(from: DateComponents(year: parts[0], month: parts[1], day: parts[2], hour: parts[3], minute: parts[4]))
    }

    /// The reminders still to come, soonest first, no more than iOS keeps.
    static func toSchedule(_ list: [Reminder], now: Date = Date()) -> [(Reminder, Date)] {
        Array(list.compactMap { r in date(r.at).map { (r, $0) } }.filter { $0.1 > now }.sorted { $0.1 < $1.1 }.prefix(most))
    }

    /// Fetch the list with the web view's cookies and schedule it, replacing what was there.
    func sync(server: URL, cookies: [String: String]) async {
        var req = URLRequest(url: server.appendingPathComponent("api/me/reminders"))
        req.httpShouldHandleCookies = false
        for (k, v) in cookies { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        guard let (data, res) = try? await URLSession.shared.data(for: req) else { return } // offline: keep what's scheduled
        let status = (res as? HTTPURLResponse)?.statusCode ?? 0
        if status == 401 { await clear(); return }
        guard status == 200, let list = try? JSONDecoder().decode(ReminderList.self, from: data) else { return }
        let due = Self.toSchedule(list.reminders)
        if !due.isEmpty, await center.notificationSettings().authorizationStatus == .notDetermined {
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
        }
        await replace(with: due)
    }

    /// Signed out: no more alerts for that account.
    func clear() async {
        let ours = await center.pendingNotificationRequests().map(\.identifier).filter { $0.hasPrefix(Self.prefix) && !$0.contains("later-") }
        center.removePendingNotificationRequests(withIdentifiers: ours)
    }

    private func replace(with due: [(Reminder, Date)]) async {
        await clear()
        for (r, when) in due { try? await center.add(request(r, at: when, id: Self.prefix + r.key)) }
    }

    private func request(_ r: Reminder, at when: Date, id: String) -> UNNotificationRequest {
        let c = UNMutableNotificationContent()
        c.title = r.text
        c.body = r.title == r.text ? r.vault : "\(r.title) · \(r.vault)"
        c.sound = .default
        c.categoryIdentifier = Self.category
        c.threadIdentifier = "\(r.vaultId)"
        if let data = try? JSONEncoder().encode(r) { c.userInfo = ["reminder": data] }
        let parts = Calendar.current.dateComponents([.year, .month, .day, .hour, .minute], from: when)
        return UNNotificationRequest(identifier: id, content: c, trigger: UNCalendarNotificationTrigger(dateMatching: parts, repeats: false))
    }

    // MARK: Answering an alert

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        [.banner, .list, .sound]
    }

    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        // A notification from the bell (Shared/Alerts.swift): open its note.
        if let link = response.notification.request.content.userInfo["open"] as? String, let url = URL(string: link) {
            await MainActor.run { self.open(url) }
            return
        }
        guard let data = response.notification.request.content.userInfo["reminder"] as? Data,
              let r = try? JSONDecoder().decode(Reminder.self, from: data) else { return }
        let action = response.actionIdentifier
        await MainActor.run {
            Task { await self.answer(action, r) }
        }
    }

    private func answer(_ action: String, _ r: Reminder) async {
        let server = AppConfig.serverURL
        switch action {
        case "done":
            await tick(r, server: server)
        case "later":
            let id = Self.prefix + "later-" + r.key
            try? await center.add(request(r, at: Date().addingTimeInterval(3600), id: id))
        default:
            if let url = URL(string: "commonplace://open/v/\(r.vaultId)/n/\(r.noteId)") { open(url) }
        }
    }

    /// Done: tick the task in its note, as the Tasks page does (PATCH …/tasks), signed in as the
    /// web view is.
    private func tick(_ r: Reminder, server: URL) async {
        let jar = await WKWebsiteDataStore.default().httpCookieStore.allCookies().filter { server.host == $0.domain || server.host?.hasSuffix("." + $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) == true }
        var req = URLRequest(url: server.appendingPathComponent("api/vaults/\(r.vaultId)/notes/\(r.noteId)/tasks"))
        req.httpMethod = "PATCH"
        req.httpShouldHandleCookies = false
        for (k, v) in HTTPCookie.requestHeaderFields(with: jar) { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue(AppConfig.origin(of: server), forHTTPHeaderField: "Origin")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["line": r.line, "text": r.task, "done": true])
        _ = try? await URLSession.shared.data(for: req)
    }
}
