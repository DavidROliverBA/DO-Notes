// One window's Commonplace: the web client in a web view, as on the iPhone (ios/App/
// WebViewController.swift), with the Mac's ways: other sites open in the default browser, file
// inputs use the open panel, downloads the save panel, and the window's title is the page's.
// Its data store is the persistent default, so the sign-in cookie survives a restart.

import AppKit
import Combine
import UniformTypeIdentifiers
import WebKit

@MainActor
final class WebPage: NSObject, ObservableObject, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKHTTPCookieStoreObserver {
    let webView: WKWebView
    @Published private(set) var title = "DO Notes"
    @Published private(set) var canGoBack = false
    @Published private(set) var canGoForward = false
    /// Couldn't reach the server (the kit not running, or offline): said in the window.
    @Published private(set) var problem: String?

    private let keeper = TokenKeeper()
    private var downloads: [WKDownload: URL] = [:]
    private var watching: [NSKeyValueObservation] = []
    private var observers: [NSObjectProtocol] = []
    private var server: URL { AppConfig.serverURL }

    init(open url: URL? = nil) {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        // So the web client knows it's in the Mac app (web/lib/iphoneApp.ts) and treats it as Safari.
        config.applicationNameForUserAgent = "Version/18.0 Safari/605.1.15 CommonplaceMac/1.0"
        config.preferences.isElementFullscreenEnabled = true
        webView = WKWebView(frame: .zero, configuration: config)
        super.init()
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.allowsBackForwardNavigationGestures = true
        webView.allowsMagnification = true
        webView.isInspectable = true
        webView.setAccessibilityIdentifier("commonplace-web")
        watching = [
            webView.observe(\.title) { [weak self] w, _ in Task { @MainActor in self?.title = (w.title?.isEmpty == false ? w.title! : "DO Notes") } },
            webView.observe(\.canGoBack) { [weak self] w, _ in Task { @MainActor in self?.canGoBack = w.canGoBack } },
            webView.observe(\.canGoForward) { [weak self] w, _ in Task { @MainActor in self?.canGoForward = w.canGoForward } },
        ]
        // Signing in and out are fetches in the web client, not page loads: the cookie says so.
        webView.configuration.websiteDataStore.httpCookieStore.add(self)
        // On the main queue, whoever posts it: a web view is only ever touched there.
        let centre = NotificationCenter.default
        observers = [
            centre.addObserver(forName: AppConfig.serverChanged, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.serverChanged() } },
            centre.addObserver(forName: NSApplication.didBecomeActiveNotification, object: nil, queue: .main) { [weak self] _ in MainActor.assumeIsolated { self?.cameBack() } },
        ]
        webView.load(URLRequest(url: url.flatMap(target) ?? server))
    }

    // MARK: What the menus do

    func reload() {
        problem = nil
        if webView.url == nil || !isOurs(webView.url) { webView.load(URLRequest(url: server)) } else { webView.reload() }
    }
    func goBack() { webView.goBack() }
    func goForward() { webView.goForward() }
    func zoom(by step: CGFloat?) { webView.pageZoom = step.map { min(3, max(0.5, webView.pageZoom + $0)) } ?? 1 }

    /// A deep link (commonplace://open/<path>) or a link to one of the server's pages.
    func open(_ url: URL) {
        if let t = target(url) { webView.load(URLRequest(url: t)) }
    }

    private func target(_ url: URL) -> URL? {
        if url.scheme == "commonplace" {
            // commonplace://open/Projects/Roof → <server>/Projects/Roof
            var path = url.path
            if url.host != "open", let host = url.host { path = "/" + host + path }
            var c = URLComponents(url: server, resolvingAgainstBaseURL: false)!
            c.path = path.isEmpty ? "/" : path
            c.query = url.query
            return c.url
        }
        return isOurs(url) ? url : nil
    }

    private func serverChanged() {
        problem = nil
        webView.load(URLRequest(url: server))
        keeper.check(webView.configuration.websiteDataStore.httpCookieStore, force: true)
    }

    private func cameBack() {
        keeper.check(webView.configuration.websiteDataStore.httpCookieStore, force: true)
    }

    nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        Task { @MainActor in keeper.check(cookieStore, force: true) }
    }

    private func isOurs(_ url: URL?) -> Bool {
        guard let url else { return false }
        if url.scheme == "about" || url.scheme == "blob" || url.scheme == "data" { return true }
        return url.host == server.host && url.port == server.port
    }

    // MARK: Navigation

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, preferences: WKWebpagePreferences) async -> (WKNavigationActionPolicy, WKWebpagePreferences) {
        if action.shouldPerformDownload { return (.download, preferences) }
        guard let url = action.request.url else { return (.cancel, preferences) }
        // Frames (dataviewjs's sandbox, embeds) load what they load; only the page itself is steered.
        if action.targetFrame?.isMainFrame == false { return (.allow, preferences) }
        if isOurs(url) { return (.allow, preferences) }
        NSWorkspace.shared.open(url)
        return (.cancel, preferences)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse) async -> WKNavigationResponsePolicy {
        if let http = response.response as? HTTPURLResponse,
           (http.value(forHTTPHeaderField: "Content-Disposition") ?? "").lowercased().hasPrefix("attachment") {
            return .download
        }
        return response.canShowMIMEType ? .allow : .download
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        problem = nil
        keeper.check(webView.configuration.websiteDataStore.httpCookieStore)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        let e = error as NSError
        if e.domain == NSURLErrorDomain && e.code == NSURLErrorCancelled { return }
        problem = server == AppConfig.kitURL
            ? "Couldn't reach DO Notes on this Mac (\(server.host ?? "localhost"):\(server.port ?? 80)). Start the kit (./commonplace.sh start in the laptop folder), or choose the cloud in Settings."
            : "Couldn't reach DO Notes at \(server.host ?? server.absoluteString). Check you're online."
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    /// `target="_blank"` or window.open: the server's pages here, anything else in the browser.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isOurs(url) { webView.load(action.request) } else { NSWorkspace.shared.open(url) }
        }
        return nil
    }

    // MARK: File inputs: the open panel

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo) async -> [URL]? {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = parameters.allowsDirectories
        panel.canChooseFiles = true
        guard let window = webView.window else { return panel.runModal() == .OK ? panel.urls : nil }
        return await panel.beginSheetModal(for: window) == .OK ? panel.urls : nil
    }

    // MARK: Downloads: exports, bundles, pictures → the save panel

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename.isEmpty ? "download" : suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.canCreateDirectories = true
        let ok = if let window = webView.window { await panel.beginSheetModal(for: window) == .OK } else { panel.runModal() == .OK }
        guard ok, let url = panel.url else { return nil }
        // The panel has asked about replacing it already.
        try? FileManager.default.removeItem(at: url)
        downloads[download] = url
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloads.removeValue(forKey: download) else { return }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: download)
    }
}
