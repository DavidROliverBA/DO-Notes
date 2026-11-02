// The share extension's work on both platforms (ios/Share for the iPhone, ios/MacShare for the
// Mac): read what was shared, show it, and send it to the home collection's Inbox with the token
// the app made at sign-in (Shared/TokenKeeper.swift).

import Combine
import Foundation
import UniformTypeIdentifiers
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        case ready
        case sending
        case done(String)
        case signedOut
        case failed(String)
    }

    @Published var phase: Phase = .loading
    @Published var items: [Shared] = []
    var close: () -> Void = {}
    var cancel: () -> Void = {}

    func load(_ inputs: [NSExtensionItem]) async {
        var photos: [Shared] = []
        var links: [Shared] = []
        var texts: [Shared] = []
        for input in inputs {
            // Safari passes the page's title as the item's text.
            let title = input.attributedContentText?.string ?? input.attributedTitle?.string
            for provider in input.attachments ?? [] {
                if let photo = await Self.photo(from: provider, number: photos.count + 1) {
                    photos.append(photo)
                } else if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                          let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
                          url.scheme == "http" || url.scheme == "https" {
                    links.append(.link(url, title: title))
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let text = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String,
                          !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    texts.append(.text(text))
                }
            }
        }
        // The server keeps photos over text when both come (src/capture.ts plan), so show what it keeps.
        items = Array((photos.isEmpty ? links + texts : photos).prefix(maxCaptureItems))
        phase = items.isEmpty ? .failed("There's nothing here DO Notes can save: share a link, some text or a photo.") : .ready
    }

    private static func photo(from provider: NSItemProvider, number: Int) async -> Shared? {
        guard let type = provider.registeredContentTypes.first(where: { $0.conforms(to: .image) }) else { return nil }
        let data: Data? = await withCheckedContinuation { done in
            _ = provider.loadDataRepresentation(for: type) { data, _ in done.resume(returning: data) }
        }
        guard let data else { return nil }
        let ext = type.preferredFilenameExtension ?? "jpg"
        let name = (provider.suggestedName ?? "Photo \(number)") + "." + ext
        return .photo(data, filename: name, mimeType: type.preferredMIMEType ?? "application/octet-stream")
    }

    func save() {
        phase = .sending
        Task {
            // A photo's words, read here, so search finds it by them (Shared/TextReader.swift).
            var sending: [Shared] = []
            for item in items {
                if case let .photo(data, name, type) = item {
                    sending.append(.file(data, filename: name, mimeType: type, words: await TextReader.words(in: data)))
                } else {
                    sending.append(item)
                }
            }
            let result = await CaptureClient().send(sending, token: TokenStore.shared.read())
            switch result {
            case let .saved(message):
                phase = .done(message)
                Self.announce(message)
                try? await Task.sleep(for: .seconds(Self.voiceOverRunning ? 2.5 : 1.0))
                close()
            case .signedOut:
                TokenStore.shared.clear()
                phase = .signedOut
            case let .failed(message):
                phase = .failed(message)
            }
        }
    }

    /// Said by VoiceOver: the server's words, once it's saved.
    private static func announce(_ message: String) {
        #if os(macOS)
        NSAccessibility.post(element: NSApp as Any, notification: .announcementRequested, userInfo: [.announcement: message, .priority: NSAccessibilityPriorityLevel.high.rawValue])
        #else
        UIAccessibility.post(notification: .announcement, argument: message)
        #endif
    }

    private static var voiceOverRunning: Bool {
        #if os(macOS)
        NSWorkspace.shared.isVoiceOverEnabled
        #else
        UIAccessibility.isVoiceOverRunning
        #endif
    }
}
