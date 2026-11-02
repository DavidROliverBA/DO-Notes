// Siri and Shortcuts, beside Save to DO Notes (L8 step 5): "Open a note in DO Notes" asks which note
// and opens the app at it; "Ask DO Notes" asks for the question and opens the app's assistant with
// it, sent. Both open the app rather than answer in Siri, so they need no token: the app's own
// sign-in is used, and the assistant keeps its rules (it asks before changing anything). The app
// is opened with its own link (commonplace://find?q=… or commonplace://ask?q=…), which the web
// client turns into the note or the question (web/App.tsx).

import AppIntents
import Foundation
#if os(iOS)
import UIKit
#else
import AppKit
#endif

enum SkeinLink {
    /// commonplace://<page>?q=<words>, the words encoded as a query value.
    static func make(_ page: String, _ words: String) -> URL {
        var c = URLComponents()
        c.scheme = "commonplace"
        c.host = page
        c.queryItems = [URLQueryItem(name: "q", value: words)]
        return c.url!
    }

    @MainActor
    static func open(_ url: URL) async {
        #if os(iOS)
        await UIApplication.shared.open(url)
        #else
        NSWorkspace.shared.open(url)
        #endif
    }
}

struct OpenNoteInSkein: AppIntent {
    static let title: LocalizedStringResource = "Open a Note in DO Notes"
    static let description = IntentDescription("Opens the note with that title, from any of your collections.")
    static let openAppWhenRun = true

    @Parameter(title: "Note", requestValueDialog: "Which note?")
    var name: String

    static var parameterSummary: some ParameterSummary {
        Summary("Open \(\.$name) in DO Notes")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let said = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { throw $name.needsValueError("Which note?") }
        await SkeinLink.open(SkeinLink.make("find", said))
        return .result()
    }
}

struct AskSkein: AppIntent {
    static let title: LocalizedStringResource = "Ask DO Notes"
    static let description = IntentDescription("Opens the DO Notes assistant with your question, about your notes.")
    static let openAppWhenRun = true

    @Parameter(title: "Question", requestValueDialog: "What's your question?")
    var question: String

    static var parameterSummary: some ParameterSummary {
        Summary("Ask DO Notes \(\.$question)")
    }

    @MainActor
    func perform() async throws -> some IntentResult {
        let said = question.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !said.isEmpty else { throw $question.needsValueError("What's your question?") }
        await SkeinLink.open(SkeinLink.make("ask", said))
        return .result()
    }
}
