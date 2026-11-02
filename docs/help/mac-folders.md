---
title: Folders on your Mac
---
# Folders on your Mac

When DO Notes runs on your Mac (the laptop kit), a collection can be kept in a **folder of Markdown files** on your computer as well as in DO Notes. Open the same folder in Obsidian, VS Code, iA Writer or any other editor: what you change there appears in DO Notes within a few seconds, and what you change in DO Notes is written to the files.

Folders live in one place on your Mac, `~/Commonplace` unless the laptop kit was set up with another (see `COMMONPLACE_FOLDERS` in the laptop guide). Each collection kept in a folder has a folder of its own inside it.

## Keep a collection in a folder

1. Open the collection, then Settings → **This collection**. At the top, **Setup** shows where it's **Kept**.
2. Press **Keep in a folder on this Mac…** and pick a folder, or **New folder…** to make one.
3. Choose how the two are kept in step (below).

One side has to be empty to start, so nothing is mixed up:

- **An empty folder** gets the collection's notes and files.
- **An empty collection** gets the folder's. To bring in a folder you already have, make a new collection and keep it in that folder.

Dot-folders such as `.obsidian` are left alone, and so are links to folders elsewhere.

## Kept in step how?

| | When a note changes in both places at once |
| --- | --- |
| **Both, kept in step** | The changes are merged when they're on different lines. When they aren't, the note waits under **Changed in both places** in Setup, with the difference shown, until you press **Keep this one** or **Take the folder's**. Nothing writes conflict markers into a note. |
| **The folder is the master copy** | The folder's text wins. The DO Notes version is still in the note's history. **Rebuild from the folder** makes the collection match the folder exactly. |

Either way:

- **Renaming or moving** a file renames the note, and the other way round.
- **Deleting** a file sends the note to Trash in DO Notes. Deleting a note in DO Notes moves its file to the folder's `.trash` folder, never deletes it.
- **History, links, search, tasks and the graph** work as in any collection.

## Pause, change or stop

- **Pause** stops changes passing between the two until you press **Resume**. If the folder goes missing or turns up empty (an unplugged drive, a folder moved in Finder), the collection pauses itself instead of sending your notes to Trash.
- **Change how** switches between the two ways above.
- **Stop keeping it there** leaves the notes in DO Notes and the files in the folder, and stops passing changes between them.

**Export to a folder…** writes any collection out to an empty folder once, without keeping them in step.

> Don't keep a collection in a folder that iCloud Drive, Dropbox or OneDrive also syncs: two programs syncing the same files can lose changes. Use the DO Notes own sharing, or a GitHub collection, to reach other devices.
