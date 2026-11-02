// Quick capture on the Mac (F36): ⌃⌥Space from any app, or the DO Notes menu-bar item, opens a small
// floating window that saves a few words to the Inbox (Shared/QuickCapture.swift). The hotkey is
// registered with the system's own hotkey service, which needs no Accessibility permission; it
// works while DO Notes is running (Settings → Open DO Notes when you log in keeps it so).

import AppKit
import Carbon.HIToolbox
import SwiftUI

@MainActor
final class CapturePanel {
    static let shared = CapturePanel()
    private var panel: NSPanel?

    func show() {
        let p = panel ?? {
            let p = NSPanel(contentRect: NSRect(x: 0, y: 0, width: 440, height: 250), styleMask: [.titled, .closable, .fullSizeContentView], backing: .buffered, defer: false)
            p.title = "Save to DO Notes"
            p.titlebarAppearsTransparent = true
            p.isFloatingPanel = true
            p.level = .floating
            p.hidesOnDeactivate = false
            p.isReleasedWhenClosed = false
            p.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
            panel = p
            return p
        }()
        // A fresh form each time, so the last words don't linger.
        p.contentView = NSHostingView(rootView: QuickCaptureView(close: { [weak p] in p?.close() }).frame(width: 440))
        p.center()
        NSApp.activate(ignoringOtherApps: true)
        p.makeKeyAndOrderFront(nil)
    }
}

/// ⌃⌥Space, system-wide.
enum CaptureHotKey {
    static let shortcut = "⌃⌥Space"
    private static var ref: EventHotKeyRef?

    static func register() {
        guard ref == nil else { return }
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { MainActor.assumeIsolated { CapturePanel.shared.show() } }
            return noErr
        }, 1, &spec, nil, nil)
        let id = EventHotKeyID(signature: OSType(0x534B_4E31), id: 1) // "SKN1"
        RegisterEventHotKey(UInt32(kVK_Space), UInt32(controlKey | optionKey), id, GetApplicationEventTarget(), 0, &ref)
    }

    static func unregister() {
        if let ref { UnregisterEventHotKey(ref) }
        ref = nil
    }
}

/// The menu-bar item's menu.
struct MenuBarMenu: View {
    @Environment(\.openWindow) private var openWindow

    var body: some View {
        Button("Save to Inbox…") { CapturePanel.shared.show() }
        Button("Open DO Notes") {
            NSApp.activate(ignoringOtherApps: true)
            if !NSApp.windows.contains(where: { $0.isVisible && !($0 is NSPanel) && $0.canBecomeMain }) { openWindow(id: "main") }
        }
        Divider()
        SettingsLink { Text("Settings…") }
    }
}
