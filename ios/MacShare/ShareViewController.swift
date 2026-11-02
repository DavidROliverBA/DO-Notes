// "Commonplace" in the Mac's Share menu (Safari, Finder, Photos, Notes…): shows what's being
// saved, with Save and Cancel (the work is in Shared/ShareModel.swift, shared with the iPhone's).

import AppKit
import SwiftUI

final class ShareViewController: NSViewController {
    private let model = ShareModel()

    override var nibName: NSNib.Name? { nil }

    override func loadView() {
        model.close = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
        model.cancel = { [weak self] in
            self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
        }
        let host = NSHostingView(rootView: MacShareSheet(model: model))
        host.frame = NSRect(x: 0, y: 0, width: 420, height: 260)
        view = host
        preferredContentSize = NSSize(width: 420, height: 260)
        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        Task { await model.load(items) }
    }
}

struct MacShareSheet: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Save to DO Notes").font(.headline)
            Group {
                switch model.phase {
                case .loading:
                    ProgressView("Getting it ready…")
                case .signedOut:
                    Label("Open DO Notes and sign in, then share again.", systemImage: "person.crop.circle.badge.exclamationmark")
                    Text("Sharing uses the sign-in in the DO Notes app. If you signed out or revoked its token in Settings, opening the app sets it up again.")
                        .font(.callout).foregroundStyle(.secondary)
                case let .done(message):
                    Label(message, systemImage: "checkmark.circle.fill").foregroundStyle(.green)
                default:
                    if case let .failed(message) = model.phase {
                        Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red)
                    }
                    ScrollView {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(Array(model.items.enumerated()), id: \.offset) { i, item in
                                MacItemRow(item: item, index: i, count: model.items.count)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Text("Goes to the Inbox in your home collection (\(AppConfig.serverURL.host ?? "")), as a to-do to file later.")
                        .font(.callout).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            HStack {
                Spacer()
                Button(model.phase == .signedOut ? "Close" : "Cancel") { model.cancel() }
                    .keyboardShortcut(.cancelAction)
                if model.phase == .sending {
                    ProgressView().controlSize(.small).accessibilityLabel("Saving")
                } else if model.phase == .ready || failedWithItems {
                    Button(failedWithItems ? "Try Again" : "Save") { model.save() }
                        .keyboardShortcut(.defaultAction)
                }
            }
        }
        .padding(16)
        .frame(width: 420, height: 260)
    }

    private var failedWithItems: Bool {
        if case .failed = model.phase { return !model.items.isEmpty }
        return false
    }
}

private struct MacItemRow: View {
    let item: Shared
    let index: Int
    let count: Int

    var body: some View {
        switch item {
        case let .link(url, title):
            VStack(alignment: .leading, spacing: 2) {
                Text(title?.isEmpty == false ? title! : url.host ?? url.absoluteString).bold().lineLimit(2)
                Text(url.absoluteString).font(.callout).foregroundStyle(.secondary).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Link: \(title ?? ""), \(url.host ?? "")")
        case let .text(text):
            Text(text).lineLimit(5).accessibilityLabel("Text: \(text)")
        case let .photo(data, _, _):
            HStack(spacing: 10) {
                if let image = NSImage(data: data) {
                    Image(nsImage: image).resizable().scaledToFill()
                        .frame(width: 48, height: 48).clipShape(RoundedRectangle(cornerRadius: 6))
                }
                Text(count == 1 ? "Picture" : "Picture \(index + 1) of \(count)")
            }
            .accessibilityElement(children: .combine)
        case let .file(_, name, _, _):
            Label(name, systemImage: "doc").accessibilityLabel("File: \(name)")
        }
    }
}
