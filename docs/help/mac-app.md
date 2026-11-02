---
title: The Mac app
---
# The Mac app

The **DO Notes** Mac app shows the same DO Notes as the web, in windows of its own, and adds **DO Notes** to the Mac's Share menu. Open it and sign in as you do on the web.

- **Windows and tabs:** **File → New Window** (⌘N) opens another; **Window → Merge All Windows** puts them in tabs. Each window's title is the note open in it.
- **The keys you know:** the web's shortcuts work as they do in a browser (⌘K, ⌘O, ⌘F and the rest, see [Keyboard shortcuts](shortcuts.md)). The app adds **Reload Page** (⌘R), zoom (⌘+, ⌘−, ⌘0), and **Go → Back** and **Forward** (⌘[ and ⌘]).
- **Files:** adding a picture or a file opens the Mac's own file chooser, and exports and downloads ask where to save, then show the file in the Finder. Links to other sites open in your browser.

## Signing in with Touch ID

Add a passkey in **Settings → Account → Passkeys** (in DO Notes, not the app's own Settings), then sign in with **Sign in with a passkey** and Touch ID. Your saved password from Passwords fills in too. Both work for DO Notes in the cloud; see [Signing in](getting-started.md).

## Which DO Notes it opens

**DO Notes → Settings** (⌘,) chooses:

- **DO Notes in the cloud**, the one it's set up for. This is the start.
- **DO Notes on this Mac**, the laptop kit at `localhost:8070`, with [folders on your Mac](mac-folders.md) and, once you've signed in to the cloud from it, the cloud's collections too. The kit has to be running (`./commonplace.sh start`); if it isn't, the window says so.
- **Another address**, for another DO Notes server.

Every window changes at once. Sign in once for each.

Settings also has **Open DO Notes when you log in**.

## Sharing from other apps

In Safari, Notes, Photos, the Finder and most other apps, **Share → DO Notes** saves a page, some text or up to ten pictures to the **Inbox** in your home collection, as a to-do to file later. It shows what it's saving, with **Save** and **Cancel**, and says when it's saved.

It uses the app's sign-in, so open the app and sign in once first. If you sign out, or remove its token in **Settings → Connections** (it's listed as *Mac app*), sharing asks you to open the app again, and opening it sets sharing up afresh. If **DO Notes** isn't in the Share menu, turn it on in **System Settings → General → Login Items & Extensions → Sharing**.

## Quick capture

Press **⌃⌥Space** in any app, or click **✎** in the menu bar and choose **Save to Inbox…**: a small window opens over whatever you're doing. Type a few words and press **Return** (or **Esc** to close); they go to the **Inbox** in your home collection as a to-do. **Record** makes a voice note instead, written down on the Mac itself and saved with the recording. It works while DO Notes is running, so turn on **Open DO Notes when you log in** in the DO Notes Settings (⌘,), where you can also switch off the shortcut or the menu-bar item.

## The DO Notes Clipper, in Safari and Chrome

The clipper is a toolbar button for saving from the web. Click it to save the page you're on, or the words you've selected, to the **Inbox**; right-click a picture, selected words or a link to save just that. A page becomes a **Weblink** note with its title, summary and picture; selected words are kept as a quote with a link back to the page.

- **Safari:** it comes with the DO Notes app. Turn it on in Safari → **Settings** → **Extensions** → **DO Notes Clipper**, and allow it on all websites. It uses the app's sign-in, so there's nothing else to set.
- **Chrome:** load the `clipper` folder from the DO Notes code (Chrome → **Extensions** → **Developer mode** → **Load unpacked**). In its **Options**, give it your DO Notes address and a capture token from Settings → **Connections** → **Share from iPhone** → **Create token**. **⌥⇧S** opens it from the keyboard.

## Saving with Siri

Say **"Save to DO Notes"** to Siri, and say what to save: it goes to the **Inbox** in your home collection, as sharing does, with the same sign-in. **Save to DO Notes** is in the Shortcuts app and Spotlight too.

**"Open a note in DO Notes"** (or *find a note in DO Notes*): Siri asks which note; say its title, and DO Notes opens at it, from any of your collections (the same title first, then one starting with your words, then one containing them). **"Ask DO Notes"**: Siri asks for your question, and DO Notes opens with it sent to your assistant in the side panel, which answers from your notes as it does when you type. Both open the app rather than answer in Siri, so they use the app's sign-in and nothing else. In Shortcuts they're **Open a Note** and **Ask DO Notes**.
