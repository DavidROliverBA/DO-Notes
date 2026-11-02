import XCTest
@testable import Commonplace

final class SaveIntentTests: XCTestCase {
    func testSiriSaysTheServersWords() throws {
        XCTAssertEqual(try SaveToCommonplace.reply(to: .saved("Saved it to Inbox")), "Saved it to Inbox.")
        XCTAssertEqual(try SaveToCommonplace.reply(to: .saved("Saved.")), "Saved.")
    }

    func testSignedOutSaysToSignIn() {
        XCTAssertThrowsError(try SaveToCommonplace.reply(to: .signedOut)) { e in
            XCTAssertEqual(e as? SaveProblem, SaveProblem("Open DO Notes and sign in first, then try again."))
        }
    }

    func testAFailureSaysWhy() {
        XCTAssertThrowsError(try SaveToCommonplace.reply(to: .failed("Couldn't reach Commonplace"))) { e in
            XCTAssertEqual((e as? SaveProblem)?.message, "Couldn't reach Commonplace")
        }
    }

    func testThreeShortcuts() {
        // Save to DO Notes, Open a Note, Ask DO Notes.
        XCTAssertEqual(CommonplaceShortcuts.appShortcuts.count, 3)
    }

    func testOpenAndAskLinksCarryTheWordsSafely() {
        XCTAssertEqual(SkeinLink.make("find", "Kitchen plan").absoluteString, "commonplace://find?q=Kitchen%20plan")
        let ask = SkeinLink.make("ask", "What did we spend & when? 50%")
        XCTAssertEqual(ask.host, "ask")
        XCTAssertEqual(URLComponents(url: ask, resolvingAgainstBaseURL: false)?.queryItems?.first?.value, "What did we spend & when? 50%")
    }
}
