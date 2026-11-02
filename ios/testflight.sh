#!/bin/sh
# Archive the iPhone app and upload it to TestFlight (ios/README.md → TestFlight). Needs the App
# Store Connect record (bundle id com.davidroliver.commonplace) and an Apple ID signed in to
# Xcode (Settings → Accounts). App Store Connect raises the build number itself.
set -e
cd "$(dirname "$0")"
export DEVELOPER_DIR="${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}"
xcodegen -q
xcodebuild -project Commonplace.xcodeproj -scheme Commonplace -configuration Release \
  -destination 'generic/platform=iOS' -archivePath build/DONotes.xcarchive -allowProvisioningUpdates archive
xcodebuild -exportArchive -archivePath build/DONotes.xcarchive -exportOptionsPlist ExportOptions.plist \
  -exportPath build/export -allowProvisioningUpdates
echo "Uploaded. It shows in App Store Connect → TestFlight once Apple has processed it (a few minutes)."
