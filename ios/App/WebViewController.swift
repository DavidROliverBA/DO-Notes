// The app is Commonplace's own web client in a web view (docs/ARCHITECTURE.md, "The iPhone app").
// The server's pages stay here; other sites open in a Safari sheet; downloads go to the share
// sheet. Its data store is the persistent default, so the sign-in cookie, the service worker and
// offline copies (F4) survive a restart; the server's domain is an app-bound domain
// (WKAppBoundDomains), which is what lets the service worker run in a web view at all.

import SafariServices
import SwiftUI
import UIKit
import WebKit

final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKHTTPCookieStoreObserver {
    private let server = AppConfig.serverURL
    private(set) var webView: WKWebView!
    private let keeper = TokenKeeper()
    private var downloads: [WKDownload: URL] = [:]
    private var pending: URL?

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.limitsNavigationsToAppBoundDomains = true
        config.allowsInlineMediaPlayback = true
        // So the web client knows it's in the app (web/lib/iphoneApp.ts).
        config.applicationNameForUserAgent = "Mobile/15E148 Safari/604.1 CommonplaceApp/1.0"
        let web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        web.allowsBackForwardNavigationGestures = true
        // The page lays itself out under the notch and home bar (viewport-fit=cover, env(safe-area-inset-*)).
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.isOpaque = false
        web.backgroundColor = .systemBackground
        web.isInspectable = true
        web.accessibilityIdentifier = "commonplace-web"
        webView = web
        view = web
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        webView.hideFormBar()
        webView.scrollView.keyboardDismissMode = .interactive
        webView.load(URLRequest(url: pending ?? server))
        pending = nil
        NotificationCenter.default.addObserver(self, selector: #selector(cameBack), name: UIApplication.didBecomeActiveNotification, object: nil)
        // Signing in and out are fetches in the web client, not page loads: the cookie says so.
        webView.configuration.websiteDataStore.httpCookieStore.add(self)
    }

    nonisolated func cookiesDidChange(in cookieStore: WKHTTPCookieStore) {
        Task { @MainActor in keeper.check(cookieStore, force: true) }
    }

    @objc private func cameBack() {
        keeper.check(webView.configuration.websiteDataStore.httpCookieStore, force: true)
    }

    /// A deep link (commonplace://open/<path>) or a universal link to one of the server's pages.
    func open(_ url: URL) {
        // commonplace://capture: the widget's quick capture (F36), a sheet over the page.
        if url.scheme == "commonplace", url.host == "capture" {
            presentCapture()
            return
        }
        var target: URL?
        if url.scheme == "commonplace" {
            // commonplace://open/Projects/Roof → <server>/Projects/Roof
            var path = url.path
            if url.host != "open", let host = url.host { path = "/" + host + path }
            var c = URLComponents(url: server, resolvingAgainstBaseURL: false)!
            c.path = path.isEmpty ? "/" : path
            c.query = url.query
            target = c.url
        } else if url.host == server.host {
            target = url
        }
        guard let target else { return }
        if webView == nil { pending = target } else { webView.load(URLRequest(url: target)) }
    }

    private func presentCapture() {
        guard presentedViewController == nil else { return }
        let sheet = UIHostingController(rootView: QuickCaptureView(close: { [weak self] in self?.dismiss(animated: true) }))
        sheet.sheetPresentationController?.detents = [.medium(), .large()]
        sheet.sheetPresentationController?.prefersGrabberVisible = true
        present(sheet, animated: true)
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
        openOutside(url)
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
        keeper.check(webView.configuration.websiteDataStore.httpCookieStore)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        webView.reload()
    }

    /// A link to `target="_blank"` or window.open: the server's pages here, anything else outside.
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let url = action.request.url {
            if isOurs(url) { webView.load(action.request) } else { openOutside(url) }
        }
        return nil
    }

    private func openOutside(_ url: URL) {
        if url.scheme == "http" || url.scheme == "https" {
            let safari = SFSafariViewController(url: url)
            safari.dismissButtonStyle = .close
            present(safari, animated: true)
        } else {
            // mailto:, tel:, maps and other apps' links
            UIApplication.shared.open(url)
        }
    }

    // MARK: Downloads: exports, bundles, pictures → the share sheet (Save to Files, AirDrop)

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        download.delegate = self
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        download.delegate = self
    }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String) async -> URL? {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let url = dir.appendingPathComponent(suggestedFilename.isEmpty ? "download" : suggestedFilename)
        downloads[download] = url
        return url
    }

    func downloadDidFinish(_ download: WKDownload) {
        guard let url = downloads.removeValue(forKey: download) else { return }
        let sheet = UIActivityViewController(activityItems: [url], applicationActivities: nil)
        sheet.popoverPresentationController?.sourceView = view
        sheet.popoverPresentationController?.sourceRect = CGRect(x: view.bounds.midX, y: view.bounds.midY, width: 1, height: 1)
        sheet.completionWithItemsHandler = { _, _, _, _ in try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        present(sheet, animated: true)
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: download)
    }
}
