// Commonplace for iPhone (ios/README.md): one web view on the server, plus the share extension
// (ios/Share/). Deep links (commonplace://open/<path>) and universal links open the page here.

import BackgroundTasks
import SwiftUI
import WebKit

@main
struct CommonplaceApp: App {
    private let links = LinkInbox()
    @Environment(\.scenePhase) private var phase

    init() {
        // Reminders for dated tasks (F35): an alert's actions, and tapping one opens its note.
        Reminders.shared.start()
        Reminders.shared.open = { [links] in links.open($0) }
    }

    var body: some Scene {
        WindowGroup {
            WebScreen(links: links)
                .ignoresSafeArea()
                .onOpenURL { links.open($0) }
                .onContinueUserActivity(NSUserActivityTypeBrowsingWeb) { activity in
                    if let url = activity.webpageURL { links.open(url) }
                }
        }
        .onChange(of: phase) { _, now in
            if now == .background { ReminderRefresh.schedule() }
        }
        .backgroundTask(.appRefresh(ReminderRefresh.id)) {
            ReminderRefresh.schedule()
            await ReminderRefresh.run()
        }
    }
}

/// While the app isn't open, iOS wakes it now and then (about every few hours, as it sees fit) to
/// refresh the reminders, so a task dated on the laptop still alerts on the phone.
enum ReminderRefresh {
    static let id = "com.davidroliver.commonplace.reminders"

    static func schedule() {
        let req = BGAppRefreshTaskRequest(identifier: id)
        req.earliestBeginDate = Date().addingTimeInterval(2 * 3600)
        try? BGTaskScheduler.shared.submit(req)
    }

    @MainActor
    static func run() async {
        let server = AppConfig.serverURL
        let jar = await WKWebsiteDataStore.default().httpCookieStore.allCookies().filter { server.host == $0.domain || server.host?.hasSuffix("." + $0.domain.trimmingCharacters(in: CharacterSet(charactersIn: "."))) == true }
        guard !jar.isEmpty else { return }
        await Reminders.shared.sync(server: server, cookies: HTTPCookie.requestHeaderFields(with: jar))
        await Alerts.sync(server: server, cookies: HTTPCookie.requestHeaderFields(with: jar))
    }
}

/// A link can arrive before the web view exists (the app launched by it): keep it until then.
@MainActor
final class LinkInbox {
    weak var controller: WebViewController?
    private var waiting: URL?

    func open(_ url: URL) {
        if let controller { controller.open(url) } else { waiting = url }
    }

    func attach(_ vc: WebViewController) {
        controller = vc
        if let url = waiting {
            vc.open(url)
            waiting = nil
        }
    }
}

struct WebScreen: UIViewControllerRepresentable {
    let links: LinkInbox

    func makeUIViewController(context: Context) -> WebViewController {
        let vc = WebViewController()
        links.attach(vc)
        return vc
    }

    func updateUIViewController(_ vc: WebViewController, context: Context) {}
}
