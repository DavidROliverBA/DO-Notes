// The DO Notes Clipper in Safari (F37): the same extension as Chrome's (clipper/), carried by the Mac
// app. Its one native message, {want: "capture"}, answers with the server and the capture token
// the app made at sign-in (Shared/TokenStore.swift), so Safari needs no setup.

import Foundation
import SafariServices

final class SafariWebExtensionHandler: NSObject, NSExtensionRequestHandling {
    func beginRequest(with context: NSExtensionContext) {
        let item = context.inputItems.first as? NSExtensionItem
        let message = item?.userInfo?[SFExtensionMessageKey] as? [String: Any]
        var answer: [String: Any] = [:]
        if message?["want"] as? String == "capture", let t = TokenStore.shared.read() {
            answer = ["server": AppConfig.origin(of: AppConfig.serverURL), "token": t.token]
        }
        let reply = NSExtensionItem()
        reply.userInfo = [SFExtensionMessageKey: answer]
        context.completeRequest(returningItems: [reply], completionHandler: nil)
    }
}
