import XCTest
@testable import Commonplace

/// After SignInTests, the app has made a capture token: send with it, as the share extension
/// does, to the scratch server (scripts/ios-e2e.ts). Skipped otherwise.
final class LiveCaptureTests: XCTestCase {
    func testSharingWithTheAppsToken() async throws {
        guard ProcessInfo.processInfo.environment["CP_LIVE"] == "1" else { throw XCTSkip("run by scripts/ios-e2e.ts") }
        var token = TokenStore.shared.read()
        for _ in 0..<20 where token == nil {
            try await Task.sleep(for: .milliseconds(500))
            token = TokenStore.shared.read()
        }
        let t = try XCTUnwrap(token, "the app should have made a token after sign-in")
        XCTAssertTrue(t.token.hasPrefix("cpc_"))
        let link = await CaptureClient().send([.link(URL(string: "https://example.com/tiling")!, title: "How to tile")], token: t)
        XCTAssertEqual(link, .saved("Saved it to Inbox"))
        let text = await CaptureClient().send([.text("Ring the electrician")], token: t)
        XCTAssertEqual(text, .saved("Saved it to Inbox"))
        let jpeg = UIGraphicsImageRenderer(size: CGSize(width: 40, height: 30)).jpegData(withCompressionQuality: 0.8) { ctx in
            UIColor.systemPurple.setFill()
            ctx.fill(CGRect(x: 0, y: 0, width: 40, height: 30))
        }
        let photo = await CaptureClient().send([.photo(jpeg, filename: "Photo 1.jpeg", mimeType: "image/jpeg")], token: t)
        XCTAssertEqual(photo, .saved("Saved it to Inbox"))
    }
}
