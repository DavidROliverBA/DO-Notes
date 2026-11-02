import XCTest

/// The app opens Commonplace: against the Mac's kit in the Debug build (ios/Config/Debug.xcconfig).
final class LaunchTests: XCTestCase {
    func testTheAppShowsCommonplace() {
        let app = XCUIApplication()
        app.launch()
        let web = app.webViews["commonplace-web"]
        XCTAssertTrue(web.waitForExistence(timeout: 20))
        // A fresh simulator isn't signed in: the web client's sign-in, from the server.
        let signIn = web.buttons["Sign in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 30), "the sign-in page should load from the server")
    }
}
