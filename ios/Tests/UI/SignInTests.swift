import XCTest

/// Signs in to a scratch server (scripts/ios-e2e.ts), after which the app makes the share
/// extension's token. Skipped unless the script passes an account in.
final class SignInTests: XCTestCase {
    func testSigningInInTheApp() throws {
        let env = ProcessInfo.processInfo.environment
        guard let email = env["CP_EMAIL"], let password = env["CP_PASSWORD"] else { throw XCTSkip("run by scripts/ios-e2e.ts") }
        let app = XCUIApplication()
        app.launch()
        let web = app.webViews["commonplace-web"]
        XCTAssertTrue(web.buttons["Sign in"].waitForExistence(timeout: 30))
        let emailField = web.textFields.firstMatch
        emailField.tap()
        emailField.typeText(email)
        let passwordField = web.secureTextFields.firstMatch
        passwordField.tap()
        passwordField.typeText(password)
        web.buttons["Sign in"].tap()
        // Signed in: the sign-in button is gone and the collection has loaded.
        let gone = NSPredicate(format: "exists == false")
        expectation(for: gone, evaluatedWith: web.buttons["Sign in"])
        waitForExpectations(timeout: 30)
        // Give the app a moment to make the token (ios/App/TokenKeeper.swift).
        sleep(4)
    }
}
