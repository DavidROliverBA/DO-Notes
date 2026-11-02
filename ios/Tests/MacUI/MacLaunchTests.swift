import XCTest

/// The Mac app opens a window with Commonplace in it, its menus are there, and Settings offers
/// the cloud and this Mac's kit.
final class MacLaunchTests: XCTestCase {
    func testItOpensWithMenusAndSettings() throws {
        // The build beside this test, by path: by bundle id, macOS may open the copy in
        // /Applications instead, which the test can't see into.
        let built = Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("Commonplace.app")
        let app = XCUIApplication(url: built)
        app.launch()
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 30))
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
        XCTAssertTrue(app.menuBars.menuBarItems["Go"].exists)
        app.menuBars.menuBarItems["View"].click()
        XCTAssertTrue(app.menuItems["Reload Page"].exists)
        app.typeKey(.escape, modifierFlags: [])
        app.typeKey(",", modifierFlags: .command)
        let settings = app.windows.containing(.radioButton, identifier: nil).firstMatch
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        XCTAssertTrue(settings.radioButtons["Commonplace on this Mac (the kit, localhost:8070)"].exists)
        XCTAssertTrue(settings.checkBoxes["Open Commonplace when you log in"].exists)
    }
}
