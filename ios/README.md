# DO Notes for iPhone and Mac

Two small native apps from one project: the DO Notes web client in a web view, plus a
share extension that saves links, text and photos to the Inbox. The Mac app (`Mac/`,
`MacShare/`) shares everything that isn't a screen with the iPhone's (`Shared/`). How it fits together is in
[ARCHITECTURE.md §7.12](../docs/ARCHITECTURE.md); what people see is in
[the help](../docs/help/iphone.md).

## What you need

- Xcode (27 or later) and XcodeGen (`brew install xcodegen`).
- Signed in to Xcode with the Apple Developer account (Settings → Apple Accounts) for builds on
  a phone. The simulator needs no signing.
- `Config/Local.xcconfig` (not in git) with your team id and your server, for builds on a phone,
  the Mac app and TestFlight:
  ```
  DEVELOPMENT_TEAM = ABCDE12345
  LIVE_HOST = notes.example.com
  ```
- If `xcode-select -p` points at the Command Line Tools, prefix commands with
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.

## Build and test

```sh
cd ios
xcodegen                     # makes Commonplace.xcodeproj from project.yml (not kept in git)
xcodebuild -scheme Commonplace -destination 'platform=iOS Simulator,name=iPhone 18 Pro' -derivedDataPath build test
cd .. && bun scripts/ios-e2e.ts   # end to end on the simulator against a scratch server
```

The end-to-end run also shares through the real share sheet (`Tests/UI/ShareSheetTests.swift`:
a page from Safari, a photo from Photos); `IOS_E2E_LOG=<dir>` keeps xcodebuild's full output.

The **Debug** build talks to the laptop kit (`http://localhost:8070`), the **Release** build to
your live server (`LIVE_HOST`); both are in `Config/`. Override for one build with `SERVER_HOST=…` on the
`xcodebuild` line.

## The Mac app

```sh
cd ios
xcodegen
xcodebuild -scheme CommonplaceMac -destination 'platform=macOS' -derivedDataPath build -allowProvisioningUpdates test
xcodebuild -scheme CommonplaceMac -configuration Release -destination 'platform=macOS' -derivedDataPath build -allowProvisioningUpdates build
ditto "build/Build/Products/Release/DO Notes.app" "/Applications/DO Notes.app"
```

It opens the cloud unless Settings (⌘,) chooses this Mac's kit or another address. The shared
keychain group (`keychain-access-groups`) needs a provisioning profile, so keep
`-allowProvisioningUpdates`; the first run of the UI test asks to let Xcode control the Mac.
Help for people: [The Mac app](../docs/help/mac-app.md).

## On a phone

1. Connect the iPhone (cable, or the same Wi-Fi once paired) and turn on **Developer Mode**
   (Settings → Privacy & Security), once.
2. Build and install the Release configuration:
   ```sh
   xcodebuild -scheme Commonplace -configuration Release -destination 'generic/platform=iOS' -derivedDataPath build -allowProvisioningUpdates
   xcrun devicectl device install app --device <name or id> build/Build/Products/Release-iphoneos/Commonplace.app
   ```
   `xcrun devicectl list devices` names the phone. The first time, the phone may ask you to
   trust the developer: Settings → General → VPN & Device Management.

## TestFlight

1. In Xcode → **Settings → Apple Accounts**, sign in with the Apple ID of your developer team,
   and put the team id in `ios/Config/Local.xcconfig` (below). Command-line builds use it to make
   profiles and to upload. A new extension's first profile may need one build inside Xcode.
2. In App Store Connect, **Apps → +** → New App: iOS, a name no other app has (the home
   screen shows *DO Notes* whatever it is), bundle id `com.davidroliver.commonplace`,
   any SKU.
3. `./testflight.sh` archives and uploads (`ExportOptions.plist`); App Store Connect numbers the
   build itself.
4. In App Store Connect → TestFlight, add yourself and the people you share with as internal testers:
   they get an invitation for the TestFlight app, and updates arrive on their own. Internal
   testing needs no App Review.

## Universal links, passwords and passkeys

Set `APPLE_APP_IDS=<team id>.com.davidroliver.commonplace` on the server. It then serves
`/.well-known/apple-app-site-association`, so links to it open in the app and iCloud Keychain
fills the app's sign-in.

The phone reads that file through Apple's CDN, which can keep an old answer (none) for hours.
Until it updates, links open in Safari, passwords don't fill, and passkeys fail at once with
*not allowed … in the current context*. For a development build, turn on **Settings → Developer
→ Associated Domains Development** on the phone, raise `CURRENT_PROJECT_VERSION` and install
again: the app's `?mode=developer` entries then read the file straight from the server.
