// Siri, Shortcuts, Spotlight and the Action button: "Save to DO Notes" asks what to save and
// sends it to the home collection's Inbox, as the share extension does (Shared/Capture.swift),
// with the capture token the app made at sign-in (Shared/TokenKeeper.swift). In the apps only,
// never the extensions: an App Shortcuts provider belongs to one bundle.

import AppIntents

struct SaveToCommonplace: AppIntent {
    static let title: LocalizedStringResource = "Save to DO Notes"
    static let description = IntentDescription("Saves what you say or type to the Inbox in your home collection.")

    @Parameter(title: "What to save", requestValueDialog: "What shall I save?")
    var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Save \(\.$text) to DO Notes")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let said = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { throw $text.needsValueError("What shall I save?") }
        let result = await CaptureClient().send([.text(said)], token: TokenStore.shared.read())
        if result == .signedOut { TokenStore.shared.clear() }
        return .result(dialog: "\(try Self.reply(to: result))")
    }

    /// What Siri says: the server's words when it's saved; otherwise why not, as an error.
    static func reply(to result: CaptureResult) throws -> String {
        switch result {
        case let .saved(message):
            return message.hasSuffix(".") ? message : message + "."
        case .signedOut:
            throw SaveProblem("Open DO Notes and sign in first, then try again.")
        case let .failed(message):
            throw SaveProblem(message)
        }
    }
}

struct SaveProblem: Error, CustomLocalizedStringResourceConvertible, Equatable {
    let message: String
    init(_ message: String) { self.message = message }
    var localizedStringResource: LocalizedStringResource { "\(message)" }
}

struct CommonplaceShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SaveToCommonplace(),
            phrases: [
                "Save to \(.applicationName)",
                "Save a note in \(.applicationName)",
                "Add to \(.applicationName)",
                "Note in \(.applicationName)",
            ],
            shortTitle: "Save to Inbox",
            systemImageName: "tray.and.arrow.down"
        )
        AppShortcut(
            intent: OpenNoteInSkein(),
            phrases: [
                "Open a note in \(.applicationName)",
                "Find a note in \(.applicationName)",
                "Open \(.applicationName) note",
            ],
            shortTitle: "Open a Note",
            systemImageName: "doc.text.magnifyingglass"
        )
        AppShortcut(
            intent: AskSkein(),
            phrases: [
                "Ask \(.applicationName)",
                "Ask \(.applicationName) a question",
                "Ask my notes in \(.applicationName)",
            ],
            shortTitle: "Ask DO Notes",
            systemImageName: "sparkles"
        )
    }
}
