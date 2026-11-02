// The bar iOS puts above the keyboard in a web view (up and down chevrons on the left, a tick on
// the right) takes a row of the screen and duplicates the web client's own formatting bar.
// Safari always shows it; in the app it's switched off by giving the web view's content view a
// subclass whose inputAccessoryView is nil, as Capacitor's and Cordova's keyboard plugins do. Only
// public Objective-C runtime calls. The keyboard still closes by swiping down over the text.

import ObjectiveC
import UIKit
import WebKit

private final class NoFormBar: NSObject {
    @objc var inputAccessoryView: AnyObject? { nil }
}

extension WKWebView {
    func hideFormBar() {
        guard let content = scrollView.subviews.first(where: { String(describing: type(of: $0)).hasPrefix("WKContent") }),
              let base: AnyClass = object_getClass(content)
        else { return }
        let name = "\(base)_CommonplaceNoFormBar"
        var subclass: AnyClass? = NSClassFromString(name)
        if subclass == nil, let made = objc_allocateClassPair(base, name, 0),
           let method = class_getInstanceMethod(NoFormBar.self, #selector(getter: NoFormBar.inputAccessoryView)) {
            class_addMethod(made, #selector(getter: UIResponder.inputAccessoryView), method_getImplementation(method), method_getTypeEncoding(method))
            objc_registerClassPair(made)
            subclass = made
        }
        if let subclass { object_setClass(content, subclass) }
    }
}
