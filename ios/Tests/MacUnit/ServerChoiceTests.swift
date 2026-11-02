import XCTest
@testable import Commonplace

/// The Mac's server, chosen in Settings: kept in the app group's defaults so the share extension
/// sends to the same one, and the cloud when nothing (or nonsense) is chosen.
final class ServerChoiceTests: XCTestCase {
    override func tearDown() {
        AppConfig.choose(nil)
    }

    func testTheCloudUnlessAnotherIsChosen() {
        AppConfig.choose(nil)
        XCTAssertEqual(AppConfig.serverURL, AppConfig.builtFor)
        XCTAssertEqual(AppConfig.builtFor.scheme, "https")
        AppConfig.choose(AppConfig.kitURL)
        XCTAssertEqual(AppConfig.serverURL.absoluteString, "http://localhost:8070")
        // The extension reads the same defaults.
        XCTAssertEqual(UserDefaults(suiteName: AppConfig.appGroup)?.string(forKey: AppConfig.serverKey), "http://localhost:8070")
        AppConfig.shared?.set("javascript:alert(1)", forKey: AppConfig.serverKey)
        XCTAssertEqual(AppConfig.serverURL, AppConfig.builtFor)
    }

    func testChoosingSaysSo() {
        let said = expectation(forNotification: AppConfig.serverChanged, object: nil)
        AppConfig.choose(AppConfig.kitURL)
        wait(for: [said], timeout: 1)
    }

    func testAPageFollowsTheChoice() async throws {
        AppConfig.choose(AppConfig.kitURL)
        let page = await WebPage()
        let url = await page.webView.url
        XCTAssertEqual(url?.host, "localhost")
        await MainActor.run { AppConfig.choose(nil) }
        try await Task.sleep(for: .milliseconds(200))
        let after = await page.webView.url
        XCTAssertEqual(after?.host, AppConfig.builtFor.host)
    }
}
