import XCTest
@testable import Commonplace

final class AlertsTests: XCTestCase {
    private func bell(_ ids: [Int], read: Set<Int> = []) -> Bell {
        Bell(unread: ids.count - read.count, items: ids.map { BellItem(id: $0, kind: "mention", text: "n\($0)", vaultId: 1, noteId: 2, read: read.contains($0)) })
    }

    func testTheFirstTimeNothingIsReplayed() {
        let r = Alerts.toShow(bell([5, 4, 3]), after: nil)
        XCTAssertTrue(r.show.isEmpty)
        XCTAssertEqual(r.newest, 5)
    }

    func testOnlyNewUnreadOnesOldestFirstAndNoFlood() {
        let r = Alerts.toShow(bell([12, 11, 10, 9, 8, 7, 6, 5], read: [11]), after: 5)
        XCTAssertEqual(r.show.map(\.id), [7, 8, 9, 10, 12]) // five at most, the newest of them; 11 was read
        XCTAssertEqual(r.newest, 12)
        XCTAssertTrue(Alerts.toShow(bell([12]), after: 12).show.isEmpty)
    }
}
