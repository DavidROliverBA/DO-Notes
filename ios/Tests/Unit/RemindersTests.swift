import XCTest
@testable import Commonplace

@MainActor
final class RemindersTests: XCTestCase {
    private func reminder(_ key: String, _ at: String) -> Reminder {
        Reminder(key: key, vaultId: 1, vault: "Household", noteId: 2, path: "Jobs.md", title: "Jobs", line: 1, task: "x", text: key, due: String(at.prefix(10)), at: at)
    }

    func testTheServersTimeIsThisDevicesOwn() {
        var cal = Calendar(identifier: .gregorian)
        cal.timeZone = TimeZone(identifier: "Europe/London")!
        let d = Reminders.date("2026-11-02T09:30", calendar: cal)!
        let parts = cal.dateComponents([.year, .month, .day, .hour, .minute], from: d)
        XCTAssertEqual([parts.year, parts.month, parts.day, parts.hour, parts.minute], [2026, 11, 2, 9, 30])
        XCTAssertNil(Reminders.date("tomorrow"))
    }

    func testOnlyWhatsStillToComeSoonestFirstAndNoMoreThanIOSKeeps() {
        let now = Reminders.date("2026-11-02T10:00")!
        let list = [reminder("later", "2026-11-03T09:00"), reminder("past", "2026-11-02T09:00"), reminder("soon", "2026-11-02T14:30")]
        XCTAssertEqual(Reminders.toSchedule(list, now: now).map(\.0.key), ["soon", "later"])
        let many = (0..<80).map { reminder("r\($0)", String(format: "2026-11-%02dT09:00", 3 + $0 % 20)) }
        XCTAssertEqual(Reminders.toSchedule(many, now: now).count, Reminders.most)
    }
}
