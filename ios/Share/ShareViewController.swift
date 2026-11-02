// "Commonplace" in the iPhone's share sheet: shows what's being saved (the work is in
// Shared/ShareModel.swift, shared with the Mac's extension).

import SwiftUI
import UIKit
import UniformTypeIdentifiers

final class ShareViewController: UIViewController {
    private let model = ShareModel()

    override func viewDidLoad() {
        super.viewDidLoad()
        model.close = { [weak self] in self?.extensionContext?.completeRequest(returningItems: nil) }
        model.cancel = { [weak self] in
            self?.extensionContext?.cancelRequest(withError: NSError(domain: NSCocoaErrorDomain, code: NSUserCancelledError))
        }
        let host = UIHostingController(rootView: ShareSheet(model: model))
        addChild(host)
        host.view.frame = view.bounds
        host.view.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(host.view)
        host.didMove(toParent: self)

        let items = extensionContext?.inputItems as? [NSExtensionItem] ?? []
        Task { await model.load(items) }
    }
}

struct ShareSheet: View {
    @ObservedObject var model: ShareModel

    var body: some View {
        NavigationStack {
            Form {
                switch model.phase {
                case .loading:
                    ProgressView("Getting it ready…")
                case .signedOut:
                    Section {
                        Label("Open DO Notes and sign in, then share again.", systemImage: "person.crop.circle.badge.exclamationmark")
                    } footer: {
                        Text("Sharing uses the sign-in in the DO Notes app. If you signed out or revoked its token in Settings, opening the app sets it up again.")
                    }
                case let .done(message):
                    Label(message, systemImage: "checkmark.circle.fill")
                        .foregroundStyle(.green)
                        .accessibilityAddTraits(.updatesFrequently)
                default:
                    if case let .failed(message) = model.phase {
                        Section { Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.red) }
                    }
                    if !model.items.isEmpty {
                        Section {
                            ForEach(Array(model.items.enumerated()), id: \.offset) { i, item in
                                ItemRow(item: item, index: i, count: model.items.count)
                            }
                        } header: {
                            Text(model.items.count == 1 ? "Saving" : "Saving \(model.items.count) things")
                        } footer: {
                            Text("Goes to the Inbox in your home collection, as a to-do to file later.")
                        }
                    }
                }
            }
            .navigationTitle("DO Notes")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(model.phase == .signedOut ? "Close" : "Cancel") { model.cancel() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    if model.phase == .sending {
                        ProgressView().accessibilityLabel("Saving")
                    } else if model.phase == .ready || isFailedWithItems {
                        Button(isFailedWithItems ? "Try again" : "Save") { model.save() }
                            .bold()
                    }
                }
            }
        }
    }

    private var isFailedWithItems: Bool {
        if case .failed = model.phase { return !model.items.isEmpty }
        return false
    }
}

private struct ItemRow: View {
    let item: Shared
    let index: Int
    let count: Int

    var body: some View {
        switch item {
        case let .link(url, title):
            VStack(alignment: .leading, spacing: 2) {
                Text(title?.isEmpty == false ? title! : url.host ?? url.absoluteString).font(.headline).lineLimit(2)
                Text(url.absoluteString).font(.footnote).foregroundStyle(.secondary).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Link: \(title ?? ""), \(url.host ?? "")")
        case let .text(text):
            Text(text).lineLimit(6)
                .accessibilityLabel("Text: \(text)")
        case let .photo(data, _, _):
            HStack(spacing: 12) {
                if let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFill()
                        .frame(width: 64, height: 64).clipShape(RoundedRectangle(cornerRadius: 8))
                }
                Text(count == 1 ? "Photo" : "Photo \(index + 1) of \(count)")
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel(count == 1 ? "Photo" : "Photo \(index + 1) of \(count)")
        case let .file(_, name, _, _):
            Label(name, systemImage: "doc").accessibilityLabel("File: \(name)")
        }
    }
}
