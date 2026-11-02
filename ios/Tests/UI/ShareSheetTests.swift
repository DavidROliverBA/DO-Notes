import XCTest

/// Shares through the real share sheet into the Commonplace extension, as someone would: a page
/// from Safari and a photo from Photos. Run by scripts/ios-e2e.ts after SignInTests has made
/// the token; the script then checks the Inbox. Skipped without a page to share.
final class ShareSheetTests: XCTestCase {
    private var page: URL!

    override func setUpWithError() throws {
        continueAfterFailure = false
        guard let s = ProcessInfo.processInfo.environment["CP_SHARE_URL"], let url = URL(string: s) else { throw XCTSkip("run by scripts/ios-e2e.ts") }
        page = url
    }

    func testSharingAPageFromSafari() throws {
        let safari = XCUIApplication(bundleIdentifier: "com.apple.mobilesafari")
        XCUIDevice.shared.system.open(page)
        XCTAssertTrue(safari.wait(for: .runningForeground, timeout: 30))
        let menu = safari.buttons["MoreMenuButton"]
        XCTAssertTrue(menu.waitForExistence(timeout: 20))
        menu.tap()
        let share = safari.buttons["ShareButton"]
        XCTAssertTrue(share.waitForExistence(timeout: 10))
        share.tap()
        saveWithCommonplace(in: safari, showing: "Link:")
    }

    func testSharingAPhotoFromPhotos() throws {
        let photos = XCUIApplication(bundleIdentifier: "com.apple.mobileslideshow")
        photos.launch()
        // The first run shows "What's New in Photos".
        let welcome = photos.buttons["Continue"]
        if welcome.waitForExistence(timeout: 5) { welcome.tap() }
        let share = photos.buttons["Share"]
        // Photos reopens where it was left: on a photo (Share showing) after an earlier run,
        // otherwise on the grid, scrolled anywhere.
        if !share.waitForExistence(timeout: 3) {
            let all = photos.images.matching(NSPredicate(format: "label BEGINSWITH 'Photo,'"))
            XCTAssertTrue(all.firstMatch.waitForExistence(timeout: 20), "no photos in the library")
            let photo = try XCTUnwrap(all.allElementsBoundByIndex.last(where: { $0.isHittable }), "no photo on screen")
            photo.tap()
        }
        XCTAssertTrue(share.waitForExistence(timeout: 10), "no Share button:\n\(photos.buttons.debugDescription)")
        share.tap()
        saveWithCommonplace(in: photos, showing: "Photo")
    }

    /// Picks Commonplace in an open share sheet, checks the preview, taps Save and waits for
    /// the server's answer.
    private func saveWithCommonplace(in app: XCUIApplication, showing preview: String) {
        let cell = app.cells.matching(identifier: "shareCell").matching(NSPredicate(format: "label == 'DO Notes'")).firstMatch
        XCTAssertTrue(cell.waitForExistence(timeout: 15), "DO Notes isn't in the share sheet")
        cell.tap()
        // The extension's sheet: what it's about to save, then Save.
        let save = app.buttons["Save"]
        XCTAssertTrue(save.waitForExistence(timeout: 20), "the extension's sheet didn't open")
        XCTAssertTrue(app.navigationBars["DO Notes"].exists)
        let item = app.descendants(matching: .any).matching(NSPredicate(format: "label BEGINSWITH %@", preview)).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 10), "the sheet should show what it's saving (\(preview))")
        save.tap()
        // "Saved it to Inbox" shows for a second, then the sheet closes itself; it closes only
        // when the server saved it (signed out or an error keeps it open with the reason).
        let sheet = app.navigationBars["DO Notes"]
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 30), "the sheet stayed open:\n\(app.debugDescription)")
    }
}
