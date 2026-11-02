// Commonplace for the Mac (ios/README.md): the web client in a window, as many windows and tabs
// as wanted, with the Mac's menus, Settings to choose the server (the cloud or this Mac's kit)
// and open at login, and a share extension (ios/MacShare/). The web client's own shortcuts
// (⌘K, ⌘O, ⌘F…) reach the page first, so the menus here keep off them.

import ServiceManagement
import SwiftUI
import WebKit

@main
struct CommonplaceMacApp: App {
    @AppStorage("menuBarItem") private var menuBarItem = true

    init() {
        // Reminders for dated tasks (F35): an alert's actions, and tapping one opens its note.
        Reminders.shared.start()
        Reminders.shared.open = { NSWorkspace.shared.open($0) }
        // Quick capture (F36): ⌃⌥Space from anywhere, unless switched off in Settings.
        if UserDefaults.standard.object(forKey: "captureHotKey") as? Bool ?? true { CaptureHotKey.register() }
    }

    var body: some Scene {
        WindowGroup("DO Notes", id: "main") {
            Window()
        }
        .handlesExternalEvents(matching: ["*"])
        .defaultSize(width: 1280, height: 860)
        .commands {
            PageCommands()
        }

        Settings {
            SettingsView()
        }

        MenuBarExtra("DO Notes", systemImage: "square.and.pencil", isInserted: $menuBarItem) {
            MenuBarMenu()
        }
    }
}

/// One window: its page, the page's title as the window's, and a note if the server can't be reached.
private struct Window: View {
    @StateObject private var page = WebPage()

    var body: some View {
        WebView(page: page)
            .overlay(alignment: .top) {
                if let problem = page.problem {
                    HStack(spacing: 12) {
                        Image(systemName: "wifi.exclamationmark").accessibilityHidden(true)
                        Text(problem).fixedSize(horizontal: false, vertical: true)
                        Button("Try again") { page.reload() }
                    }
                    .padding(12)
                    .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 10))
                    .padding(16)
                    .accessibilityElement(children: .contain)
                }
            }
            .navigationTitle(page.title)
            .focusedSceneObject(page)
            .onOpenURL { page.open($0) }
            .frame(minWidth: 480, minHeight: 360)
    }
}

private struct WebView: NSViewRepresentable {
    let page: WebPage
    func makeNSView(context: Context) -> WKWebView { page.webView }
    func updateNSView(_ view: WKWebView, context: Context) {}
}

/// View and Go menus for the frontmost window. Reload is ⌘R; zoom is ⌘+ ⌘- ⌘0; back and forward
/// are ⌘[ and ⌘] (none of them the web client's).
private struct PageCommands: Commands {
    @FocusedObject private var page: WebPage?

    var body: some Commands {
        CommandGroup(before: .toolbar) {
            Button("Reload Page") { page?.reload() }
                .keyboardShortcut("r")
                .disabled(page == nil)
            Divider()
            Button("Actual Size") { page?.zoom(by: nil) }
                .keyboardShortcut("0")
                .disabled(page == nil)
            Button("Zoom In") { page?.zoom(by: 0.1) }
                .keyboardShortcut("+")
                .disabled(page == nil)
            Button("Zoom Out") { page?.zoom(by: -0.1) }
                .keyboardShortcut("-")
                .disabled(page == nil)
            Divider()
        }
        CommandMenu("Go") {
            Button("Back") { page?.goBack() }
                .keyboardShortcut("[")
                .disabled(page?.canGoBack != true)
            Button("Forward") { page?.goForward() }
                .keyboardShortcut("]")
                .disabled(page?.canGoForward != true)
        }
    }
}

/// Settings (⌘,): which Commonplace to open, and opening at login.
struct SettingsView: View {
    private enum Where: String, CaseIterable, Identifiable {
        case cloud, kit, other
        var id: String { rawValue }
    }

    @State private var choice: Where = .cloud
    @State private var other = ""
    @State private var atLogin = SMAppService.mainApp.status == .enabled
    @State private var loginProblem: String?
    @AppStorage("menuBarItem") private var menuBarItem = true
    @AppStorage("captureHotKey") private var captureHotKey = true

    var body: some View {
        Form {
            Picker("Open", selection: $choice) {
                Text("DO Notes in the cloud (\(AppConfig.builtFor.host ?? ""))").tag(Where.cloud)
                Text("DO Notes on this Mac (the kit, localhost:8070)").tag(Where.kit)
                Text("Another address").tag(Where.other)
            }
            .pickerStyle(.radioGroup)
            if choice == .other {
                TextField("Address", text: $other, prompt: Text("https://commonplace.example.com"))
                    .onSubmit(apply)
            }
            Text("Every window opens it, and the share extension saves to it. Sign in once for each.")
                .font(.callout)
                .foregroundStyle(.secondary)
            Divider()
            Toggle("Open DO Notes when you log in", isOn: $atLogin)
                .onChange(of: atLogin) { _, on in
                    do {
                        if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() }
                        loginProblem = nil
                    } catch {
                        loginProblem = error.localizedDescription
                        atLogin = SMAppService.mainApp.status == .enabled
                    }
                }
            if let loginProblem { Text(loginProblem).foregroundStyle(.red) }
            Divider()
            Toggle("Save to Inbox with \(CaptureHotKey.shortcut) from any app", isOn: $captureHotKey)
                .onChange(of: captureHotKey) { _, on in if on { CaptureHotKey.register() } else { CaptureHotKey.unregister() } }
            Toggle("Show DO Notes in the menu bar", isOn: $menuBarItem)
            Text("Both open a small window that saves a few words to the Inbox in your home collection.")
                .font(.callout)
                .foregroundStyle(.secondary)
        }
        .padding(20)
        .frame(width: 520)
        .onAppear(perform: load)
        .onChange(of: choice) { _, _ in apply() }
    }

    private func load() {
        let now = AppConfig.serverURL
        if now == AppConfig.builtFor { choice = .cloud } else if now == AppConfig.kitURL { choice = .kit } else {
            choice = .other
            other = now.absoluteString
        }
    }

    private func apply() {
        switch choice {
        case .cloud: if AppConfig.serverURL != AppConfig.builtFor { AppConfig.choose(nil) }
        case .kit: if AppConfig.serverURL != AppConfig.kitURL { AppConfig.choose(AppConfig.kitURL) }
        case .other:
            let t = other.trimmingCharacters(in: .whitespaces)
            guard let url = URL(string: t.contains("://") ? t : "https://" + t), url.host != nil, url.scheme == "https" || url.scheme == "http" else { return }
            if url != AppConfig.serverURL { AppConfig.choose(url) }
        }
    }
}
