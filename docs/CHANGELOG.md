# Changelog

What's been finished, newest first, with the date and the release or commit. What's next is in
[BACKLOG.md](BACKLOG.md); finished designs are in [design/](design/). Releases on GitHub carry the
same notes.

- **2026-11-02** — **Landscapes from Floe, kept up to date** (F41): with Floe connected, ⌘K →
  **Bring in a landscape from Floe…** puts a landscape in a folder (`Architecture/<landscape>`),
  with the types it needs and an overview note holding its diagrams. **Update from Floe** (⋯)
  previews, then rewrites only Floe's part of each note (its keys, and the text between
  `<!-- floe -->` markers, drawn as a quiet *From Floe* label in Live Preview), matched by
  `floe-id`, so what you wrote stays; renames follow with their links, and objects removed in
  Floe are marked `status: removed`, never deleted. Changes to Floe's part are named before Floe's
  version replaces them. Opening the overview asks Floe once a session whether it has changed.
  `/` → **Floe diagram…** puts any diagram in a note, and **Update Floe diagrams** redraws them.
  Reads Floe's own notes export with the connection's read-only token; nothing in Floe changes.
  Design in `docs/design/F41.md`.
- **2026-11-02** — **Skein is now DO Notes** (David Oliver's initials; "Skein" was hard to say):
  the name in the apps, the clipper, Siri, messages and help. Code names, the `commonplace://`
  scheme and bundle ids don't change, so installed apps, tokens and links keep working. Still MIT licensed, and not a commercial product.
- **2026-11-02** — **Siri: Open a note and Ask Skein** (L8 step 5), on the iPhone and the Mac,
  beside Save to Skein: Siri asks which note (or the question) and opens Skein at the note by
  its title in any collection (`/api/find`), or with the question sent to the assistant. They
  open the app, so they use its sign-in and need no token.
- **2026-11-02** — **Send to Longview** (F30 step 4): with a Longview write token added under
  Settings → Connections → Longview (kept apart from the read token, used only for `save_url`), a
  Weblink note's ⋯ menu → **Send to Longview…** saves its address in Longview, with the reason
  typed; never the note. The assistant's connection stays read-only.
- **2026-11-02** — **Two-step sign-in** (F40): Settings → Account → Two-step sign-in adds a
  code app (TOTP, QR code or key, Apple Passwords and the rest) as a second step after the
  password, with ten single-use recovery codes, shown once; turning it on signs out other
  devices; passkeys skip the code. **Passkeys only** drops the password (needs a passkey here;
  the last one can't be removed; a password comes back with a passkey's confirmation).
  `reset-password` on the kit clears both. Also: the **Mac app has its icon** (the icon set had
  only the iPhone's sizes).
- **2026-11-01** — **Comments on notes** (L3): select words, ⋯ → **Comment…**; the words are
  marked, and the thread is in the side panel with Reply and Resolve (Undo). Anchored by Yjs
  relative positions, so it stays on its words while others type; kept beside the note, never
  in the Markdown; exported in `.comments/`, kept in backups and restores; notifications for the
  writer, the thread's starter and anyone @named. Design in `docs/design/L3.md`.

- **2026-11-01** — **Notifications and activity** (F39): a bell in the file panel with an unread
  count and a list (mentions, invitations, changes to notes you follow at most hourly, and
  comments), each opening its note, plus *Since you last looked here* for the open collection.
  Typing `@` lists the collection's people as well as assistants; **⋯ → Follow this note**. The
  iPhone and Mac apps show new ones as alerts when they refresh. Design in `docs/design/F39.md`.

- **2026-11-01** — **Share one note by link** (F38): ⋯ → **Share by link…** makes a read-only,
  unlisted page of the note at `/s/<slug>/`, copied to the clipboard. It's a snapshot, as a
  published site is (no script, the note's pictures and files copied, links to other notes as
  plain words, hidden comments hidden); **Update the page** brings it up to date, **Stop
  sharing** takes it away at once, with Undo (`src/shareLink.ts`).

- **2026-11-01** — **The words inside files, and voice notes.** Search finds words inside PDFs
  (read on the server with `unpdf` when added, and in the background for older ones), photos
  shared or saved from the iPhone and Mac apps (read on the device by Apple's text recognition),
  and voice notes, and shows the note that uses the file (*In Receipt.png: …*); the words are
  kept on the attachment, never written into notes. Quick capture's **Record** makes a voice
  note, transcribed on the device by Apple's speech recognition; it goes to the Inbox with the
  transcript quoted under it (`src/fileText.ts`, `ios/Shared/TextReader.swift`,
  `ios/Shared/VoiceNote.swift`).

- **2026-11-01** — **From your connections**, in the side panel (F33 step 4; F30 step 3): for the
  open note, what each connection the person put in the panel has on it, looked up by the note's
  title (never its text) when it opens or is renamed, and shown as links out. Off for each
  connection until turned on in its Review, which saves at once; Longview and Recall use their
  search tools, any other service a read tool with one text input. Kept ten minutes per note
  (`src/outsidePanel.ts`).

- **2026-11-01** — **Landscapes from Floe, first part** (towards F41): the
  **Architecture** starter types (Landscape, Domain, Actor, System, App, Store, Component; their
  properties are the ones Floe's folder-of-notes export writes) and the set in Setup; an import
  now **adds the starter types its notes name** (`type: system`, any case) when the collection has
  none, and says which (`typesAdded`; `src/transfer.ts`); and `scripts/floe-diagrams.ts`, which
  fills each ```` ```mermaid ```` block starting `%% floe: <landscape> / <diagram>` with that Floe
  diagram (`--list` prints every diagram's line, `--dry-run` writes nothing).

- **2026-11-01** — **Floe** as a connection preset (F33): a read-only Floe token and its address,
  and the assistant lists your landscapes, opens one, and fetches a diagram as Mermaid C4
  (`floe_landscapes`, `floe_landscape`, `floe_diagram`). Floe's address can be preset with
  `FLOE_MCP_URL`.

- **2026-11-01** — **Connect any service** (F33 step 2): Settings → Connections → **Add a
  connection…** looks at an MCP address first and says what it found, or which rule it fails (a
  web page, a sign-in on its own page, tools that all change things); then a token, or no
  sign-in past a warning the person confirms. Its read tools start on, Review opens to choose,
  and **Try it** makes one harmless call. The laptop kit may reach services on the same computer
  (`CONNECTIONS_ALLOW_LOCAL`). A service with no sign-in gets no Authorization header at all.

- **2026-11-01** — **The Skein Clipper** (F37), for Safari and Chrome: a toolbar button and a
  right-click menu save the page (as a Weblink note), the selected words (as a quote linked to
  the page) or a picture to the Inbox, through `POST /api/capture`. In Safari it comes with the
  Mac app and uses its sign-in; in Chrome it's loaded from `clipper/` with a capture token. The
  capture route now accepts requests from other origins, since it signs in by token alone.

- **2026-11-01** — **Quick capture** (F36): a **Save to Skein** widget for the iPhone's home and
  lock screens opens a small form that saves to the Inbox (`commonplace://capture`); on the Mac,
  **⌃⌥Space** from any app and a **✎** menu-bar item open the same form in a floating window
  (each can be switched off in the Mac app's Settings). The form sends text as the share
  extension does (`ios/Shared/QuickCapture.swift`, `ios/Widget/`, `ios/Mac/CapturePanel.swift`).

- **2026-11-01** — **Reminders for dated tasks** (F35). The Skein apps on the iPhone and Mac
  remind you on the day about open tasks with a date (📅) in notes you wrote or last edited, or
  that name you (@Name or [[Name]]), at 09:00 or your own time (Settings → Account →
  Reminders), or the task's own `⏰ 14:30`. **Done** in the alert ticks the task; **Remind me
  in an hour** snoozes it; tapping opens the note. The apps schedule the alerts themselves
  (no push service), refreshed when opened and, on the iPhone, in the background
  (`src/reminders.ts`, `ios/Shared/Reminders.swift`; design in `docs/design/F35.md`).

- **2026-11-01** — **N12, the consolidation pass, is finished.** The last part, a real iPhone,
  passed every journey in the Skein app on David's iPhone 17 Pro Max: opening and the single
  sharing token; writing with the formatting bar and no Safari form bar; ticking a task; links and
  search; sharing a page, a photo and text, and Siri's "Save to Skein", all to the Inbox; offline
  open, edit and merge in Airplane mode; every Settings section in light and dark; VoiceOver
  through the library, a note, a task and the ⋯ menu; and a note edited in Safari. The earlier
  parts (automated accessibility, speed at 10,000 notes, a tested restore, the streamed backup)
  were done 2026-10-13.

- **2026-11-01** — One sharing token per device (L8): the iPhone app's token is named with a
  short code of its own (*iPhone app · 7Q4K*), and before the app makes a new one it revokes any
  others with its name, so tokens it forgot (after signing out, or an emptied keychain) no longer
  pile up in Settings → Connections. The Mac app's already carried the Mac's name.

- **2026-11-01** — **Commonplace is now Skein** (F34), with a new icon: a ball of thread with
  one strand looping out to a gold link, in shades of navy blue. The shown name changed everywhere people see it (the
  web app, the iPhone and Mac apps (the Mac app is now Skein.app), the share sheet, Siri's
  "Save to Skein", help, the tour, messages, the standalone file and the laptop kit); the code,
  bundle ids, addresses and paths keep `commonplace`. `scripts/make-icons.ts` makes every icon
  from `web/icon.svg`, including the iPhone's dark and tinted icons. The name was chosen after a
  gap analysis (`docs/GAP-ANALYSIS.md`) and a search of the alternatives (recorded in F34).

- **2026-11-01** — **Save to Commonplace** with Siri (L8), on the iPhone and the Mac: an App
  Intent (`ios/Intents/SaveToCommonplace.swift`) asks what to save and sends it to the home
  collection's Inbox with the app's capture token, as the share extension does. Its phrases
  (*save to*, *add to*, *note in Commonplace*) need no setup; it's also in Shortcuts, Spotlight
  and the Action button.

- **2026-11-01** — The connections manager, step 1 (F33): Longview and Recall as presets.
  - Each connection's tools are listed from the service and sorted **read**, **doesn't say**
    or **changes things** (`src/connections.ts`); a preset (`src/presets.ts`) says which of its
    tools read, and the rest go by their own annotations. Tools that change things are never
    offered; one that doesn't say is off, and asks before every use when turned on.
  - **Review** beside each connected service chooses its tools. If the service changes a tool the
    person chose, the connection is held, offering nothing, until they look; Review shows what
    it said before and now.
  - Settings → Connections → **Connected services** lists every connection; Longview and Recall
    are added from there. F30's two connections move across on first boot.
  - `tools/list` is followed through its pages.

- **2026-11-01** — No form bar above the keyboard in the iPhone app (L8). The bar iOS puts
  over the keyboard in a web view (up and down chevrons, a tick) is switched off in the app
  (`ios/App/FormBar.swift`), giving the note that row; the keyboard closes by swiping down over
  the text. Safari still shows it. iPhone build 5.

- **2026-11-01** — Longview and Recall as connections (F30 steps 1–2, and Recall).
  - Settings → Connections → **Longview**: its address and a read token, checked with one
    search; a token that could change Longview is refused. **Recall**: Connect Recall… signs in
    on Recall's own page (OAuth with PKCE, Commonplace registering itself), for read access
    only. Each sealed with `SECRETS_KEY`, never sent to the browser; Disconnect removes it (and
    revokes Recall's sign-in).
  - The in-app assistant gets `longview_search`, `longview_entity`, `longview_trend`,
    `longview_ask`, `recall_search` and `recall_read`: in-app only, never over Commonplace's MCP
    server. The web's rule: a search in the person's words runs, anything else asks; after
    one, every change asks (`src/outside.ts`, a small MCP client in `src/mcpClient.ts`).
  - Tests: fake Longview and Recall (`test/fakeMcp.ts`), the whole sign-in, refresh and revoke.
  - Fixed on the way: a server starting while another writes to the database tries its schema
    up to ten times instead of five (it gave up and didn't start), and the storage-guard test
    has the time its second server needs.

- **2026-11-01** — Passkeys: sign in with Face ID or Touch ID (F32).
  - **Settings → Account → Passkeys:** add one on this device, see each with when it was last
    used, remove one (Undo puts it back).
  - **Sign in with a passkey** on the sign-in page, or from the email box's suggestions.
    Passwords keep working.
  - WebAuthn with user verification (`src/passkeys.ts`, `@simplewebauthn/server` and
    `/browser`); only each passkey's public half is stored, per address. Tests sign in with a
    software authenticator (`test/fakeAuthenticator.ts`) and, in the browser, Chrome's virtual
    one.
  - The Mac app has Associated Domains for the cloud (`webcredentials:`, `applinks:`), so
    passkeys and saved passwords work in it, as they now do in the iPhone app.

- **2026-11-01** — Commonplace as a Mac app (L8).
  - A native Mac app (`ios/Mac/`, in the iPhone app's project): the web client in windows and
    tabs, the Mac's menus (Reload, zoom, Back and Forward; the web's own shortcuts reach the
    page), the Mac's file chooser and save panel, other sites in the browser.
  - **Settings** chooses the cloud (the default), this Mac's kit or another address, and
    turns on opening at login.
  - **Share → Commonplace** from Safari, Notes, Photos and the Finder saves to the Inbox, with
    the token the app makes at sign-in (*Mac app* in Settings → Connections).
  - The share extension's work and the token keeper moved to `ios/Shared/`, used by both apps.
  - Help: [The Mac app](help/mac-app.md).

- **2026-11-01** — F31, the relationship builder, is done: all four steps, checked by keyboard
  and with VoiceOver on the iPhone. Design in [design/F31.md](design/F31.md).

- **2026-11-01** — Every relationship in one place, and turned round (F31 step 4).
  - **Relationships** in the side panel lists a note's relationships both ways, each read from
    this note (*Loft · comes after · Roof*), each kind's two directions together; it takes the
    place of the per-property *As …* lists. The links route now returns the note's own relation
    properties too (`relationsFrom`, `src/typeIndex.ts`).
  - Each row's ⋯ (keyboard too): **Change…** (the builder, replacing it), **Swap** (turn it
    round), **Reverse** (the same relationship written into the other note under the other
    direction's name, `comes-after: [[Roof]]` in Loft), **Remove**. One Undo puts both notes
    back (`web/lib/relations.ts`); a row that has changed since it was drawn changes nothing.
  - A relationship kept under the other direction's name exports as that name, with the kind as
    its inverse in `vocab/rels.json`, and comes back on import as the same kind.
  - Fixed on the way: a ⋯ menu opened by keyboard on a laptop now puts focus on its first item
    (it was hidden while being placed); a write from outside the editor to an open note is saved
    at once instead of after the typing pause, so it reads back straight away; the builder
    fetches the note list if it opens before the app's has loaded.

- **2026-10-31** — The relationship builder (F31 step 3).
  - One sentence of three labelled boxes, **[Roof] [comes before] [Loft]**, each a
    type-to-filter list that works by keyboard alone (`web/ui/Combobox.tsx`, the ARIA combobox
    pattern); focus moves on as each is chosen, and the whole sentence is read out as it changes.
  - Either direction of a kind can be chosen, and **Swap** reads it from the other note; it's
    always written into the note it starts from. A new kind can be added from it, with its name
    the other way round. Add, then Undo from the message.
  - Opens from ⌘K, the note's ⋯ menu, `/`, **Add relationship…** under the properties, and a
    board arrow (the arrow's notes and label filled in). It replaces the two-step dialogs.

- **2026-10-31** — A collection's own kinds of relationship (F31 step 2).
  - A **Relationships** note at the top of a collection lists its own kinds as a table: name, the
    name the other way round (— when it reads the same both ways) and meaning
    (`src/relationships.ts`).
  - One list everywhere (`GET /api/vaults/:v/relationships`): the collection's own, then its
    types' relations, then AI-XF's core kinds. **Add relationship…** offers it, and the other
    note's side panel names a relationship the other way round (*comes after*).
  - AI-XF export writes the collection's kinds into `vocab/rels.json` with both names, used or
    not; import adds a bundle's kinds to the note (or makes it), never twice.

- **2026-10-31** — Board arrows by keyboard (F31 step 1).
  - **Reverse the arrow** turns a selected arrow round (ends and sides swap, heads stay), one Undo.
  - **Connect to…** draws an arrow from the selected card to one picked from a list: no drag
    needed (WCAG 2.5.7).
  - **Arrows on this board** lists every arrow as a sentence (*Roof → comes before → Loft*);
    choosing one selects it and brings it into view. It's the board's text alternative.
  - The board's toolbar wraps on the phone instead of running off the screen.

- **2026-10-31** — Commonplace as an iPhone app (L8 step 1, with parts of steps 2 and 4).
  - **A native app** (`ios/`, Swift): Commonplace's own web client, full screen, signed in as on
    the web. Links to other sites open in a Safari sheet; downloads offer the share sheet; the
    server's domain is app-bound, so the service worker runs and the app opens offline.
  - **Commonplace in every share sheet:** a link, some text or up to 10 photos go to the home
    collection's Inbox, with a preview first and VoiceOver labels throughout. No Shortcut to
    build: the app makes its own **iPhone app** token at sign-in (revocable in Settings →
    Connections) and drops it at sign-out.
  - Universal links and password autofill once `APPLE_APP_IDS` is set on the server.
  - Checked end to end on the simulator (`bun scripts/ios-e2e.ts`): the app signs in, makes its
    token, and a shared link, text and photo land in the Inbox, including a page from Safari and
    a photo from Photos shared through the real share sheet.

- **2026-10-31** — AI-XF: ids, and bundles in and out (F9; design in [design/F9.md](design/F9.md)).
  - **Ids:** every new note gets `id:` (from its title, kept for ever: renames and copies don't
    change it), so `[[kitchen-extension]]` always finds the note and Longview can point at it. It's
    kept out of sight in the app; ⋯ or ⌘K **Copy the note's id**. A collection can turn it off.
  - **Export as AI-XF bundle** (Settings, ⌘K, or a folder's menu): canonical concepts, relations
    as typed links mirrored in the body, a manifest that keeps its namespace, and type and rel
    vocabularies. Notes without an id are given one first, after asking. The Testbed collection
    passes the reference validator at Level 3 with no warnings.
  - **Import a bundle:** every key kept; typed links become relation properties; missing types
    are made. `ai-concepts-kb` and `psychology-kb` go in and out again at Level 3 with every link.

- **2026-10-31** — Boards: notes as cards on a whiteboard (F11, all four steps; design in
  [design/F11.md](design/F11.md)).
  - **A board is a `.canvas`** (JSON Canvas), so boards from Obsidian open as they were and
    boards made here open there. ⌘K → **New board**; imported `.canvas` files become boards.
  - **Cards:** notes (the note itself, so an edit anywhere shows on every board), other boards
    (a small map of their cards; click to open), text in Markdown, links, pictures and labelled
    groups that carry their cards. Move, resize from the corners, colour, front and back.
  - **Arrows** from the dot on any side of a card, with labels. An arrow between two notes can
    become a relation property of the first, so the link holds outside the board.
  - **Layouts:** Tidy up, Arrange the group, Mind map from here; each one Undo.
  - **Live and offline:** several people arrange a board at once (different cards' moves all
    stay; others' selections show), Undo takes back only your own changes, and a board opened
    once works offline. 150 cards pan smoothly in the phone emulation.
  - **A note's boards:** the side panel's **On boards** lists the boards a note is on and the
    arrows to and from it there.
  - Boards kept as plain files by earlier versions move into notes at start-up, unchanged.

- **2026-10-31** — Undo stays long enough to use: a message with **Undo** now stays 20 seconds
  (was 8), and any message waits while the pointer is on it or focus is in it. Found walking
  through moving a note between the Mac and the cloud.

- **2026-10-30** — The cloud library on your Mac (F23, commits 5e34de7 and 5c3285a; design in
  [design/F23.md](design/F23.md)).
  - **One menu:** on the Mac, Settings → Connections → *Cloud library* signs in to the
    Commonplace you use on the web; its collections join the menu under *In the cloud*. Notes
    open and change there live, with everyone else, and stay on the Mac for when the cloud can't
    be reached.
  - **Move between them:** *Move to another collection…* moves notes or folders between the Mac
    and the cloud, with pictures, types and history; Undo puts them back.
  - **In the cloud:** a Mac signs in with its own kind of token (`cpd_`, scope `device`), listed
    in Settings → Connections → *Macs signed in*; signing it out closes it at once. New API:
    `/bundle` and `/receive` per collection.
  - Members, renaming, publishing and GitHub stay in the cloud. Deploy the cloud first, then
    update the laptop kit.
  - Tests: 10 e2e, two of the servers at once; 1 browser (the whole sign-in, through the
    consent page, with the test server as its own cloud).
  - Fixed while checking it: the browser can load the sign-in's return address twice at once,
    and the second said the sign-in had expired (now it waits for the first); and a server asked
    for its collections with a device token added its own cloud collections, which loops when a
    server is its own cloud (a device now gets only the collections kept there).

- **2026-10-30** — Folders on your Mac (F22, commit 50d2cf1; design in
  [design/F22.md](design/F22.md)).
  - **Keep a collection in a folder of Markdown** on the Mac (laptop kit): Setup → Kept →
    *Keep in a folder on this Mac…*. The folder is under `COMMONPLACE_FOLDERS` (`~/Commonplace`
    by default), and any editor can open it. Edits there arrive within a second or so (live in
    an open editor); edits here are written to the files.
  - **Two ways:** *Both, kept in step* (a note changed in both places that doesn't merge waits
    under *Changed in both places*) or *The folder is the master copy* (the folder wins;
    *Rebuild from the folder*). Never conflict markers.
  - Renames and moves go both ways; deleted in the folder → Trash; deleted here → the folder's
    `.trash/`. A folder that vanishes or turns up empty pauses the collection.
  - *Export to a folder* for any collection; the collection menu groups *In folders on this
    Mac*; `src/syncCore.ts` holds the file helpers shared with GitHub collections.
  - Help: *Folders on your Mac*. Tests: 10 e2e, 1 browser.

- **2026-10-30** — Aliased links in tables resolve (commit 6b29b13).
  - In a table the alias pipe is written `[[Note\|alias]]`; the link grammar took the backslash
    as part of the target, so the editor's table cells showed such links as unresolved,
    `![[pic.png\|300]]` became a broken link, and backlinks and the graph missed them. The
    grammar now accepts `\|` (markdown, render, publish, dataview, the dataviewjs sandbox).
  - Tests: 1 unit.
- **2026-10-27** — The standalone file catches up with the app, and opens several folders at
  once (release v0.0.73; `standalone/`).
  - **Several folders:** each folder opened is a collection. The select at the top of the file
    panel moves between them, opens another or closes one; each keeps its own place, bookmarks and
    saved searches, and links resolve within their own folder. Chrome and Edge remember every
    folder opened (not just the last) for the start screen, with × to forget one.
  - **The app's editor** replaces the standalone's simpler one: the `/` menu, the formatting bar,
    folding, hover previews, the block handle, the properties panel, icons and covers, spelling
    help. Each note is a Yjs document kept only in the tab.
  - **⌘K** with the commands that work without a server (`offerOnly` in `web/lib/commands.ts`),
    and the note's ⋯ menu from the same list.
  - **Bookmarks, saved searches, Tasks, Today's note, templates and the graph**, answered from the
    open folder by `standalone/api-shim.ts`. The graph's date rules and the task finder moved to
    `src/graphParts.ts` and `src/tasks.ts` so the browser can use them.
  - **Renaming or moving a note updates the links to it**, as the app does.
  - Focus mode, the full-width editor and the theme button.
  - The router can keep its paths in memory (`keepInMemory`), since a file opened from disk can't
    use the address bar for them.
  - Not brought across: the guided tour (it walks the app's screens), and everything that needs
    the server. The file is 3.8 MB (was 3.4).
  - Tests: 7 standalone browser.
- **2026-10-27** — Typing on the iPhone, clear of the keyboard bar (release v0.0.72; found in
  the real-iPhone check, N12).
  - iOS 26 floats a ˄ ˅ ✓ bar over the page above the keyboard, which no web page can hide
    (checked again). A text box being typed in is now scrolled clear of it (`web/main.tsx`,
    `--keyboard-bar`).
  - **Search on a phone** folds away the collection, the GitHub bar and New/Today/Graph while the
    box has focus or words in it, so the box is at the top and the results get the screen.
  - **The GitHub bar on a phone** is compact: how many notes changed (and what's next, small,
    under it), Send and ⋯; the branch's name is on the changes page.
  - Tests: 1 browser extended.
- **2026-10-26** — Easier table editing (release v0.0.71; `web/lib/tableModel.ts`,
  `web/lib/tableWidget.ts`).
  - **Row and Column menus** on the table's bar, for the cell you're in: insert above, below,
    left or right; **move** a row up or down and a column left or right; delete; and **sort** the
    rows by the column, A to Z or Z to A. Amounts sort as numbers (£1,200 after 90), words ignore
    case and markup, empty cells go last, and equal values keep their order. The bar is shorter,
    so it fits a phone.
  - **Paste from a spreadsheet:** a range copied from Numbers, Excel or Google Sheets, pasted
    into a note, becomes a Markdown table (its first row the header); pasted into a cell, it fills
    the cells from there across and down, adding rows and columns as needed. In code it stays as
    copied.
  - **Fixed:** a cell left just before a move or sort could write its old text back over the
    moved cell; a cell now writes back only when its own text was changed.
  - Tests: 3 unit, 1 browser.
- **2026-10-26** — Finding the tour (release v0.0.70).
  - **Help** has **Take the tour** and **What's new** above its topics.
  - **Search and Find a note offer commands:** typing a command's name ("tour", "history")
    lists it beside the notes found, first in Find a note unless a note's title starts with the
    words. Each word must start a word of the command's name or keywords; `/`-menu blocks are
    left out. The standalone file's Find a note is unchanged.
  - Tests: 1 browser.
- **2026-10-26** — Guided tour (release v0.0.69; `web/lib/tour.ts`, `web/ui/Tour.tsx`).
  - A step at a time over the real screen: the page dimmed except round the part being described,
    a card with Next, Back and Skip (Escape ends it, ←/→ move). Laptop and iPhone paths; the
    iPhone one starts with Add to Home Screen (and Safari's address bar at the Top).
  - Offered once on the collection's home page; then ⌘K **Take the tour** and **What's new**,
    which shows the steps for features added since this device last looked and is offered on the
    home page after each release. Kept on the device (`cp:tour`). The tour opens a note and the
    panels as it goes and puts the panels back after.
  - Every step is in one list with the release that added it, so a new feature adds its step.
  - Tests: 3 browser (laptop, What's new, iPhone).
- **2026-10-26** — Editor usability, release 3 (release v0.0.68; `web/lib/format.ts`,
  `web/lib/selectionToolbar.ts`).
  - **Format bar on selection** (laptops): heading, bold, italic, strikethrough, highlight, inline
    code, link and colour, each a command from `commands.ts`; it waits for the mouse to be let
    go, shows what's already applied, and Escape hides it.
  - **Formatting toggles:** ⌘B, ⌘I, ⌘⇧X and ⌘E (and the buttons) wrap the selection or take the
    marks off again; `*` and `**` don't undo each other.
  - **Link…** links the selected words to a note (`[[Note|words]]`) or a web address.
  - Tests: 3 unit, 2 browser.
- **2026-10-26** — Editor usability, release 2 (release v0.0.67; `web/lib/folding.ts`,
  `web/lib/hoverPreview.ts`).
  - **Folding:** a › after each heading and each list item with children folds what's under it
    (a heading down to the next at its level), shown as "⋯ 12 lines"; ⌘⌥[ / ⌘⌥], and ⌘K
    **Fold all headings** and **Unfold all**. A view only: the note doesn't change.
  - **Hover preview:** rest the pointer on a `[[link]]` in the editor or reading view to see the
    start of the note, or of the heading's section. Laptops only for now.
  - Tests: 2 browser.
- **2026-10-26** — Editor usability, release 1 (release v0.0.66; `src/codeHighlight.ts`,
  `web/lib/places.ts`, `web/ui/lightbox.ts`).
  - **`[[` finds headings and aliases:** `[[Note#` lists that note's headings (`[[#` this
    note's), and a note's aliases are suggested, written as `[[Note|Alias]]`.
  - **Word count:** words and reading time at the bottom right of a note on a laptop, or the
    selection's words; properties don't count. Published pages' reading time uses the same count.
  - **Pasted pictures are named after the note** (`Kitchen plan.png`, then `Kitchen plan 1.png`),
    not `Pasted image 2026…`.
  - **Notes reopen where you left them:** cursor and scroll, per device, for the last 200
    notes; forgotten at sign-out.
  - **Code blocks:** coloured by language (JavaScript, TypeScript, Python, SQL, JSON, YAML, HTML,
    CSS, shell) in the editor, reading view and published pages; in Live Preview a language
    picker and Copy on the block, Copy in reading view.
  - **Click a picture to see it on its own** (Escape or a click closes it).
  - Tests: 5 unit, 6 browser. New dependencies (MIT): `@codemirror/lang-javascript`, `-python`,
    `-sql`, `-json`, `-css`, `-html`, `@codemirror/legacy-modes`.
- **2026-10-26** — Full-width editor (release v0.0.65; `web/lib/editorWidth.ts`).
  - The **↔** button beside the view switch, ⌘K **Full-width editor** / **Normal editor width**,
    or Settings → Account → Appearance: every note's text fills the space between the side panels
    and follows them as they open, close or are dragged. Kept on this device; focus mode keeps its
    reading width. A browser test.
- **2026-10-26** — F28 part 2, writing blocks from Confluence (release v0.0.64; `web/lib/look.ts`,
  `web/lib/embeds.ts`, `src/weblinks.ts`, design in [design/F28.md](design/F28.md)).
  - **Emoji:** `:rocket` suggests emoji as you type and writes the emoji itself.
  - **Icon, cover and width:** **Icon…**, **Cover picture…** (upload or a web address) and
    **Wide page** in the note's ⋯ menu and ⌘K, written as `icon:`, `cover:` and `width:`
    properties. The icon shows by the title and in the file list.
  - **Link cards:** a web address on a line of its own shows as a card with the page's title,
    summary, site and picture, in Live Preview and reading view, from the weblinks' safe fetch
    (`/api/vaults/:v/linkcard`, cached a day).
  - Tests: 2 unit, an e2e of the card route, a browser test. New dependency: `unicode-emoji-json`
    (MIT), loaded only when first needed.
- **2026-10-26** — F28 part 1, writing blocks from Confluence (release v0.0.63; `src/blocks.ts`,
  `web/lib/livePreview.ts`, `web/lib/render.ts`, `src/publish.ts`).
  - **Expand:** `> [!note]-` is a callout that opens and closes, closed to start (`+`: open). A
    chevron in Live Preview (a view only, the note doesn't change), `<details>` in reading view
    and on published sites, so it works with no script.
  - **Status:** `:status[On track]{.green}` (the generic directive syntax) shows as a coloured
    label; `/status` asks for the words and colour.
  - **Table of contents:** `[TOC]` on its own line lists the note's headings as links, in Live
    Preview (a click moves to the heading), reading view and published sites.
  - **Dates:** `//` offers today, tomorrow, yesterday, the coming week and a picker; `/date` opens
    the picker. Written as `2026-10-26`.
  - Tests: 2 unit, 3 browser.
- **2026-10-26** — F27, relationships between any notes (release v0.0.62; `src/types.ts`
  `RELS`, `web/lib/propertiesWidget.ts`). **Add relationship** (under the properties, in ⌘K, the
  `/` menu and the note's ⋯ menu) says how a note relates to another, with AI-XF's
  relationships: Part of, Depends on, Supersedes, References and the rest. It picks the notes this
  one already links to first, and writes a property named after the relationship
  (`part-of: "[[Onboarding]]"`), the same one way to write relations as a type's. The other note
  shows the inverse in the side panel (*Has part*, *Depended on by*). It's how to make
  Confluence's parent and child pages without a page tree. Tests: a browser test.
- **2026-10-26** — The journal, F24 release 2 (release v0.0.61; `src/dayone.ts`,
  `web/lib/journal.ts`, design in [design/F24.md](design/F24.md)).
  - **Import from Day One:** on the journal page (or ⌘K), choose Day One's JSON export. It's
    counted first ("Import 359 entries from Day One?"), then each entry goes into its day's daily
    note under `## Journal` at the time it was written, with titles in bold, tags as #tags, and
    photos and files stored and shown where they were. Importing again adds nothing. Checked
    against a real export: 383 entries, 24 empty, 359 imported over 225 days, each reading back
    unchanged.
  - **Reflect on this week** (⌘K) opens the assistant with the last seven days of your journal
    and a request to reflect on them, changing nothing.
  - **Tests:** 3 unit, an e2e import (times across midnight and zones, a photo, a second import,
    a dry run, viewers refused, junk refused), and browser tests of the import and of Reflect.
- **2026-10-26** — Spelling and grammar help, Grammarly-friendly (release v0.0.60;
  `web/lib/writingAids.ts`, `web/components/Editor.tsx`). The editor library switches off spell
  check, autocorrect, capitals and writing suggestions for the whole note, which silenced the
  browser's spell check, the iPhone keyboard's help and Grammarly. They're now on in prose, and
  left off in code blocks, the properties at the top, inline code and links. A switch in Settings
  → Account → Writing (and ⌘K) turns them off, remembered per device. Tests: a browser test of
  where the help is on and off, and the switch. Grammarly itself wasn't available to test here:
  try it on the laptop and with its iPhone keyboard.
- **2026-10-26** — N16, the iPhone formatting bar (release v0.0.59; `web/main.tsx`,
  `web/styles/format-bar.css`). With the keyboard up, the bar under the note showed an empty
  second row: room kept for the home indicator, which the keyboard covers. The app now notes when
  the keyboard takes the screen (`keyboard-up` on the page, from the visual viewport it already
  follows), and the bar then keeps no such room. A browser test checks the rule; the real check is
  on an iPhone.
- **2026-10-26** — `#Type` inline, F26 (release v0.0.58; `web/components/Editor.tsx`, design in
  [design/F26.md](design/F26.md)).
  - In the editor, `#` and the start of a type's name offers **New Person…** after the tags.
    Choose it, type the name (`#Person Sam Okafor`) and press Enter: the note is made from the
    type's template and `[[Sam Okafor]]` is left in its place. An existing note of that name is
    linked instead. Undo brings back what was typed, in one step.
  - A tag typed by hand with a type's name stays a tag: only the menu choice starts this.
  - **Tests:** a browser test on the laptop and the iPhone (make, link, Undo, and a hand-typed
    tag left alone).
- **2026-10-26** — Sign-in for MCP clients, F25 (release v0.0.57; `src/oauth.ts`,
  `web/components/OAuthConsent.tsx`, design in [design/F25.md](design/F25.md)).
  - **claude.ai and the Claude apps:** add Commonplace as a custom connector in claude.ai
    (Settings → Connectors) with the address Connect Claude shows. Claude sends you to
    Commonplace, which asks **Let Claude use your notes?**, with **Read only** as a choice. The
    Claude iPhone and desktop apps then have it too. Claude Code can sign in the same way.
  - **How:** OAuth 2.1 with PKCE, as the MCP authorization spec asks: the well-known metadata,
    dynamic client registration, the consent page, and a token endpoint. Access tokens last an
    hour and refresh tokens change on every use. Only hashes are stored, and no token goes in a URL.
  - **Connections** lists each app that has signed in ("signed in from claude.ai"), and
    **Disconnect** ends it at once, refresh token included. Pasted tokens work as before.
  - **Safety:** the consent page names the app and where it returns to, and asks you to allow only
    apps you've just added. Return addresses must be https, loopback http or an app's own scheme,
    and match what was registered; an untrustworthy request is explained, never redirected.
  - **Tests:** 2 e2e tests (the official MCP client signs in end to end, then refresh, expiry,
    revoking, a client without a secret, read only, and the refusals), a browser test of the
    consent page, and axe on it, laptop and iPhone, light and dark.
- **2026-10-25** — The journal, F24 release 1 (release v0.0.56; `src/journal.ts`, `JournalPage.tsx`,
  `JournalEntry.tsx`, help page `journal.md`).
  - **New journal entry**, from ⌘K, a note's ⋯ menu, or press-and-hold (right-click on a laptop)
    on Today. It opens a short sheet (⌘Enter adds the entry).
  - **Where entries go:** today's daily note in your home collection, under `## Journal` as
    `### HH:MM` and the text, by your device's clock. The daily note is made from your daily
    template if there's none yet. Entries are added live-safely (a function passed to
    `overwriteContent`), so typing in today's note isn't undone.
  - **The Journal page** (under Tasks in the file panel, or ⌘K) shows each day's entries
    newest first, On this day from earlier years, a calendar, and Earlier days.
  - **The assistant and MCP** have `add_journal_entry`, a write tool with a preview.
  - **Websites:** `## Journal` sections are always left off published sites.
  - **Fixed on the way:** the day calendar was an ARIA grid without rows or cells (axe). It's
    now a labelled group.
  - **Tests:** 3 unit, 3 e2e (writing to home, the page and On this day, roles and bad input),
    an MCP call, a publish check, 2 browser tests and axe on the page, laptop and iPhone, light
    and dark. Day One import and Reflect on this week are release 2.
- **2026-10-25** — N15, a review of v0.0.45 to v0.0.54 (release v0.0.55). A code review and a
  security review were run over the range. The security review found nothing that met its bar.
  Everything both reviews raised is fixed, each with a test:
  - **GitHub, held notes** (`src/git.ts`): a held note, or one still being typed, could go back to
    `main`'s version on the PR branch when its earlier push predated recorded blob shas. Push
    now reads those from the branch.
  - **GitHub, publishing to an existing branch** (`src/gitAuto.ts`): choosing a branch that lacks
    some of the collection's files is now refused before anything changes. Before, following it
    sent those notes to Trash.
  - **Reading web pages** (`src/web.ts`): reading a hostile page (thousands of unclosed tags) took
    time quadratic in its size, so about six minutes for 1.5 MB, blocking the one server. It's
    now linear: under a millisecond for the same page.
  - **The assistant's first web request** (`src/ai.ts`): it no longer goes out without asking
    unless it sends only what the person typed, or opens a link a search returned. A first
    request could otherwise carry note text out if a clipped page steered it.
  - **Library name** (`/api/session`): no longer shown before sign-in, since by default it
    carries the first admin's name.
  - **Copy or move between collections** (`src/between.ts`):
    - a move counts the notes' history against the storage guard;
    - an identical picture already there under a renamed name is used, with the embed
      pointing at it, instead of at a different file of the original name;
    - a folder sent into another folder keeps links between its notes that spell out the path;
    - the route uses the shared `vaultCtx` check.
  - **The timeline** (`src/graph.ts`, `web/lib/graph.ts`): an impossible or placeholder date no
    longer counts, and a long span groups months so there are never more than 240 bars. Before,
    one `0001-01-01` drew 24,000 of them.
  - **The graph's Show more:** the graph builds each note's neighbours once per set of links,
    not on every render.
  - **Six iCloud sync-conflict copies** (`theme 2.ts` and others) are deleted, and
    `.gitignore` keeps future ones out.
- **2026-10-25** — Collection setup, the slim F20 (release v0.0.54;
  `web/components/CollectionSetup.tsx`, help page `collections.md`).
  - **Setup** is at the top of Settings → This collection, and a new collection opens there. It
    shows where the collection is kept (this library, or this library with a GitHub copy), who's
    in it (with Invite for owners), and whether it's your home.
  - **Starter-type sets:** Personal, Household, Programme, Department and Reference. Each adds the
    types the collection hasn't got, plus any type their links need. There are 15 new starter
    types (Home, Appointment, Document, Decision, Risk, Action, Stakeholder, Milestone, Team,
    Process, Policy, Service, Article, Topic, Source), with new icons (home, flag, alert).
    `STARTER_SETS` in `src/types.ts`, unit-tested. `addStarters` in `web/lib/types.ts` is shared
    with the New type dialog.
  - **A home collection** for each person (`users.home_vault_id`, `PUT /api/me/home`). It's the
    one chosen, or else the first you own. Share from iPhone defaults to a *Home collection*
    token (no fixed collection) that follows your home when it changes. The app opens there when
    there's no last-used collection.
  - **The collection menu** puts home first, marks it "· home", and groups collections into "In
    this library" and "From GitHub" when you have both.
  - **Tests:** e2e (home, a home token following a change, refusing a collection you're not in)
    and a browser test (adding a set, making a collection home).
- **2026-10-25** — `package.json`'s version is 0.0.53, the release that's out. It had stayed at
  0.0.45, so the MCP server and the standalone file reported the wrong version.
  `test/version.test.ts` now fails when the newest release in this changelog and `package.json`
  differ.
- **2026-10-25** — Your library and its collections (release v0.0.53). A server is now a
  **library** and vaults are **collections**, everywhere people read: the app, the server's
  messages, the AI's and MCP's descriptions, the help, the README and the docs. The library's name
  sits at the top of the file panel and ends the tab title ("Kitchen plan · Personal · David's
  Library"). By default it's the first admin's first name ("David's Library"), and an admin can
  rename it in Settings → Admin (`server_info.library`, `PUT /api/admin/library`). A new
  account's first collection is called *Personal*. When an account is deleted, the collections
  handed to the admin are renamed to say where they came from ("Personal (from Eve)"). The code,
  database, API, URLs, storage keys, backup format and MCP tool names keep "vault", so nothing
  already connected breaks, and ⌘K still finds collection commands by "vault". The help says that
  other editors call a collection a vault. CLAUDE.md and ARCHITECTURE.md explain the two words.
- **2026-10-25** — Third-party notices (`THIRD_PARTY_NOTICES.md`, generated by `bun run notices`
  from `scripts/notices.ts`). It lists every package Commonplace ships or runs: the 158 production
  dependencies and their own dependencies, with each one's licence and full licence text, plus
  what runs alongside (PostgreSQL, pgvector, Bun) and a note on libheif (LGPL-3.0, used only in a
  separate server process). `test/notices.test.ts` fails when a dependency changes without the
  file being regenerated. The README and the standalone file (a comment at its top) link to it.
- **2026-10-25** — Light, dark or Auto (release v0.0.52, `web/lib/theme.ts`). A button beside Trash
  steps through Auto, Light and Dark, and its icon shows the current choice. Auto follows the
  device's setting. The same choice is in Settings → Account (Appearance) and in ⌘K ("Theme").
  Each device remembers its own. A choice sets `data-theme` on the page, and `tokens.css` now
  answers to that as well as to the system setting (a design test checks that both dark blocks
  have the same values). Published sites already worked this way, so the copy `src/publish.ts`
  used to make is gone. Mermaid diagrams, dataviewjs frames and the browser's own bars follow the
  choice. Tested in the browser.
- **2026-10-25** — The README is shorter and opens with a picture: the app on a laptop in dark
  mode beside an iPhone in light mode (`docs/images/hero.webp`, made by `bun run readme:shot`). A
  table of highlights replaces the long feature list, which moved to
  [FEATURES.md](FEATURES.md) unchanged apart from adding the timeline and panel resizing. "How it
  works" now gives the overview and points to ARCHITECTURE.md for the detail.
- **2026-10-25** — You can resize the panels, as in Floe (release v0.0.51, `web/ui/PanelResizer.tsx`). Drag the
  inner edge of the file panel or the side panel to make it wider, for example to give the graph
  in the side panel more room. Each panel can be 200 to 720px wide, and the note always keeps at
  least 360px. Double-click the edge to put the width back. The edge is a separator for the
  keyboard: the arrow keys move it 16px, and Home and End go to the narrowest and widest. Each
  browser remembers the widths. Phones have no handle. Tested in the browser.
- **2026-10-25** — A timeline on the graph (release v0.0.50, F21; `web/components/GraphTimeline.tsx`,
  `noteWhen` in `src/graph.ts`; design in [design/F21.md](design/F21.md)). **Timeline** in the
  graph's bar opens a strip: notes per month as bars on a day scale, and a range with two handles.
  Notes outside fade, or go with Hide the rest; a link shows only when both its notes are in range;
  every note keeps its place in the layout, so nothing moves. Play grows the range a month at a
  time (about ten seconds; pressing the graph pauses it; slower steps with Reduce Motion). The
  handles are sliders with dates as their values (arrows a day, Page Up and Down a month), the
  count and range are read out ("Showing 42 notes, March to June 2025"), and the range is in the
  address. A note's date: a daily note's day, then `date:`, `created:` or `day:`, then its type's
  (`timeline:` in the type, or its first date property that isn't a birthday), then the day it
  was made. Tests: 3 unit, a browser test, axe on the strip. On the way: range sliders no longer
  pick up the text box style; the graph's header says "1 link"; on the phone the header no longer
  moves while a menu is open (moving it scrolled the note, which closed the menu).
- **2026-10-25** — More room for the note on the iPhone (`web/lib/phoneChrome.ts`). Scrolling
  down tucks the note's header up out of view and scrolling up, or reaching the top, brings it
  back; it stays in the page, so focus from the keyboard or VoiceOver shows it, and it never hides
  while something in it has focus. The find button steps aside while the header is away and for
  a moment after each keystroke. Focus mode is in the phone's ⋯ menu: no header, no formatting
  bar, and a Leave focus button. With Reduce Motion, nothing slides. Considered and left out:
  drawing under the status bar in the home-screen app, which would make the clock white on the
  light theme and gains nothing, since the header already pads for it.
- **2026-10-25** — On an iPhone, a GitHub vault's branch bar sits at the top of the Files drawer
  instead of above the note, so the note keeps the whole screen (`BranchBar.tsx`,
  `PanelToggle.tsx`). A dot on the Files button stands in for it, with the reason in its label for
  VoiceOver: accent for changes not on GitHub yet, orange for a clash to settle or paused sending.
  Review changes and Open PR close the drawer. The laptop is unchanged.
- **2026-10-24** — Copy or move notes to another vault (release v0.0.49; `src/between.ts`, the
  `copy_to_vault` tool). In a note's ⋯ menu and a folder's menu: Copy to another vault… and Move
  to another vault…, picking the vault and then the folder there, with Undo. Embedded pictures and
  files come along, as does everything in a folder, and any type the other vault lacks (with its
  saved views). A taken name keeps both; a different file of the same name is renamed and the
  embed follows. A move carries each note's history and creation date and sends the original to
  Trash; files are only copied. A viewer can copy out but not move; the other vault needs edit
  rights. GitHub vaults are vaults like any other. The assistant (and MCP agents) can do it with
  `copy_to_vault`, which always asks first in the app. Tests: 5 end to end and a browser test.
  Also fixed two UI-test counts left stale by v0.0.48 (the help page list and the MCP tool list).
- **2026-10-24** — N14 closed: holding delete in a note on the iPhone keeps deleting again,
  checked on a real iPhone in Safari and the home-screen app with Live Preview on. It went away
  with an iOS update after 18.7 (reported 2026-10-17), with nothing else changed on the phone, so
  it was most likely an iOS bug. The app's own change from that hunt stays (the visual-viewport
  height is written only when it changes, and not while keys are going down); the temporary
  `?cm-off=` debug switch (`web/lib/debugOff.ts`) is gone.
- **2026-10-24** — Laptop guide brought up to date (`laptop/README.md`): the kit rebuilt and
  started from v0.0.49; offline behaviour of the assistant, web search and GitHub vaults (automatic
  sending retries every five minutes and sends when back online), and web search added to what
  leaves the computer.
- **2026-10-23** — The graph, after Capacities (release v0.0.48; `src/graph.ts`,
  `web/lib/graph.ts`, `web/components/GraphCanvas.tsx`, `LocalGraph.tsx`, help page `graph.md`).
  Notes show their type's icon in its colour; links from properties carry the property's name
  (worked out from frontmatter, alphabetical when there are several); links in the text are
  fainter. A Graph tab in the side panel centres on the open note with Show more and Show less,
  and follows you, on the iPhone too. The page shows the whole vault, one note's neighbourhood
  (`?note=`), or a type, folder, tag or saved search (from the type page, the folder menu, the Tags
  tab and saved searches). A bar holds filters (only or hide types, unlinked notes, daily notes,
  busy notes over 25 links, a simplified drawing; kept per vault on the device, with a badge),
  zoom with fit, a PNG export and Show more / Show less. Find in graph moves to a note, and ⌘K has
  "This note in the graph". The view keeps fitting while it settles until you touch it; icons and
  words stay readable when zoomed out. Tests: 5 unit, 1 end to end, a browser test of the tab and
  page, and axe on the graph with filters open (it caught type-coloured chip text below AA).
- **2026-10-23** — The AI assistant can use the web (release v0.0.47; `src/web.ts`). It needs
  switching on in two places: Settings → AI assistants → Change → "may search the web and read
  pages" (off by default), then the globe in a conversation (off at the start of each one; ⌘K → Let
  the AI use the web). `read_web_page` reads any public page through the weblinks fetcher (no
  private addresses) and keeps its readable text. `web_search` uses the person's own Brave Search
  key, added under Settings → AI assistants → Web search, checked with one search and kept sealed.
  Against pages that try to make the model leak notes: after the first web request in a
  conversation, each further one waits for the person, showing the exact search or address (Allow
  or Don't), and so does every change, even to the open note. Links a search returned open without
  asking. MCP agents don't get these tools. Tests: 5 end to end (a fake Brave and local pages)
  and 2 for page text.
- **2026-10-23** — N11 passed: GitHub vaults on the live site with a **fine-grained** token,
  through the UI. The token connected, the copy-in worked, and a push opened a PR on the test
  repo with one note and no other files. Switched to Keep a branch in sync, the next edit went to
  the same PR by itself about 2–3 minutes after typing stopped ("Sent automatically by
  Commonplace"). Hold back, Release and Pause weren't tried live; the e2e tests cover them.
  Lesson: give the token **only** the repositories it's for. The first try picked the public
  repo from the list, and its PR had to be closed.
- **2026-10-23** — GitHub vaults send on their own: F19 (release v0.0.46; `src/gitAuto.ts`,
  `src/schedule.ts`, `web/components/GitHubSending.tsx`). Settings → This vault → Sending to
  GitHub offers four ways: Ask me (as before), Regular review (a PR every hour, day or week at a
  UK time, joining the open one until it's merged), Keep a branch in sync (each note pushed once
  nobody has typed in it for two minutes), and Publish straight to a branch (`main` or another,
  on a schedule or soon after edits; deletions wait for Send now; a warning about deploys). Every
  automatic run merges first and pauses on a clash. It also pauses when GitHub refuses (for
  example a protected branch) or when the sender disconnects or stops being an editor, and the bar
  says why. "Hold back" in Review changes keeps a note out. The bar shows "Next PR at 18:00 · 2
  changes waiting · sends as Sam", with Send now and Pause; ⌘K has both. Commits name other
  editors, with emails only if the owner opts in. Fixed on the way: after your own PR merged, an
  edit to the same note showed as a clash on the next Update. Tests: 12 end to end against the
  fake GitHub (now able to protect a branch) and 3 for UK times across the clock changes. Design:
  [design/F19.md](design/F19.md).
- **2026-10-22** — Commonplace on a laptop (release v0.0.45; `laptop/`,
  `scripts/reset-password.ts`): the app and its own Postgres as a compose project reachable only
  from this computer, with `laptop/commonplace.sh` to start (it makes `SECRETS_KEY` and shows the
  setup token), stop, back up and restore the whole database, update, reset a password and package
  both images into one `.tar.gz` for a computer with no internet or source (for this kind of
  machine, or `linux/amd64`). `COMMONPLACE_LISTEN=0.0.0.0` lets an iPhone on the same Wi-Fi in.
  `laptop/README.md` is an install guide for Mac, Windows and Linux with a FAQ. Tested end to end:
  first account with the token, notes, restart, backup, restore, password reset, kit and load.
- **2026-10-18** — Help (release v0.0.44; `docs/help/`, `web/lib/help.ts`,
  `web/components/Help.tsx`): a user guide of 17 pages with Mermaid diagrams and 35 screenshots
  taken from the real app (`bun run help:shots`). The same Markdown is the Help screen in the app
  (the ? at the bottom of the file panel, ⌘K → Help or Keyboard shortcuts), the Help in the
  standalone file (its 8 pages, pictures inside the file) and pages on GitHub. Mermaid's dark
  theme gets a darker edge-label box, to meet WCAG AA contrast. `test/help.test.ts` checks pages,
  links, pictures and shortcuts; the UI tests open Help on a laptop and an iPhone and in the
  standalone file, and axe checks it in both themes.
- **2026-10-18** — Two demo vaults in `demo/` (`bun run demo` zips them into `demo/dist/`):
  *The Allotment Notebook*, a personal notebook that publishes whole with every website feature on,
  and *Harbour Studio*, a studio's people, projects and meetings as types, publishing only its
  handbook. `test/e2e.test.ts` imports and publishes both and checks every page, and that
  nothing private reaches the site.
- **2026-10-18** — The website builder: F18 step 2 (release v0.0.43; `src/publish.ts`,
  `web/components/SiteSettings.tsx`). Settings → Website gains seven features to switch on, each
  off until chosen and kept in `publish.json`: a page list (beside the text, after it on a phone),
  a contents list of a page's headings, backlinks from published pages, tag pages
  (`_site/tags/…`), last-updated dates, reading time, and a light and dark switch. Pages still
  run no script: the switch is three links that set a cookie for the site. A preview beside the
  switches shows the pages Publish would make, from the notes as they are, to the owner only
  (`/api/vaults/:v/site/preview/…`, framed with no scripts); a feature changes the preview at once
  and the site at the next Publish. Each page's details are worked out at Publish into
  `site_pages.meta`, from the text the page shows, so hidden text and unpublished notes add no
  backlink or tag. Hover previews need script, so they aren't on offer.
- **2026-10-17** — iPhone: holding the delete key should keep deleting (release v0.0.42;
  `web/lib/blockHandle.ts`). On a phone the block handle moved beside the cursor's block on every
  keystroke, measuring the line in the middle of CodeMirror's update, before the text was redrawn;
  it now waits for the editor's measure step. Not yet confirmed on a real iPhone.
- **2026-10-17** — dataviewjs on published sites, and endless loops stopped (release v0.0.41;
  `web/sandbox/loopGuard.ts`, `freezeDataviewJs` in `web/lib/dataviewjs.ts`, `cleanFrozen` in
  `src/publish.ts`). Publish runs each published dataviewjs block in the same sandbox in the
  owner's browser, over the published notes only (it can read only published notes, the site's
  files and views' code), and freezes what it drew into the page; the server keeps only a few
  tags and safe attributes, and links to notes that aren't published become plain words. Every
  loop in a script gets a guard, so one that holds the thread for 5 seconds is stopped with
  "Evaluation Error: … Is there a loop that never ends?" instead of freezing the tab; the app also
  closes a frame that stops answering for 10 seconds.
- **2026-10-16** — dataviewjs (release v0.0.40; `web/sandbox/dvjs.ts`, `src/sandbox.ts`,
  `web/lib/dataviewjs.ts`), in the app and the standalone version: a ```` ```dataviewjs ```` block runs
  in a sandboxed frame with an opaque origin and no network, on Dataview's `dv` API built over the
  same query engine (pages, DataArray with field swizzling, Links, Luxon dates and durations,
  `dv.table` / `list` / `taskList` / `paragraph` / `header` / `span` / `el`, `dv.execute` / `query` /
  `evaluate`, `dv.func`, `dv.io.load` / `csv`, `dv.view`). Links open notes and task boxes tick
  tasks through checked messages; the frame grows to what it draws. Live Preview shows it with an
  Edit code button. Dates now follow the reader's named time zone (`tz`), so a date or file time
  keeps its own summer-time offset. Published sites show dataviewjs as code.
- **2026-10-16** — Dataview `CALENDAR` views (release v0.0.39): `CALENDAR <date> FROM … WHERE …`
  draws a month, Monday first, with a dot for each note on its day. It opens at this month (or the
  nearest one with notes); ‹ › and Today move between months, and choosing a day lists its notes
  under the month (otherwise the month's are listed). Published pages show every month that has
  notes, newest first, without buttons.
- **2026-10-16** — Dataview queries (release v0.0.38; `src/dataview.ts`), in the app, the
  standalone version and published sites: ```` ```dataview ```` blocks with `TABLE`, `LIST` and
  `TASK`, `FROM` folders, tags and links, `WHERE`, `SORT`, `GROUP BY`, `FLATTEN`, `LIMIT` and
  Dataview's functions; inline `` `= expressions` ``; and the `` `$= dv.pages(…).where(…).length` ``
  counts, translated rather than run. Results show in reading view, embeds and Live Preview, refresh
  as notes change, and a task ticked in a result is ticked in its note. The app runs queries on the
  server over a per-vault cache that rereads only changed notes; the standalone file runs them in
  the browser; Publish works them out from published notes only and freezes them into the page.
  Checked against a 3,500-note vault: all 489 blocks and 91 of its 92 inline expressions run (the
  other has a stray bracket), median 104 ms to open a note with its results. No note code runs:
  `dataviewjs` and other `$=` JavaScript show as code; CALENDAR isn't supported yet.
- **2026-10-16** — Mermaid diagrams (release v0.0.37; `web/lib/mermaid.ts`), in the app and the
  standalone version, with the syntax other Markdown editors use: a ```` ```mermaid ```` block draws
  in reading view, in embeds, and in Live Preview off the cursor (a click shows the source). It
  follows light and dark, `%%{init}%%` directives work, and `class A internal-link` makes a node
  open the note it names; a diagram that doesn't parse shows the error above its source. Mermaid
  loads only for a note with a diagram (served at `/vendor/mermaid.js`, or packed inside the
  standalone file, now 2.4 MB). Strict mode, sanitised SVG and a shadow root per diagram keep it
  from running script or restyling the app. Published sites show the source, as their pages run
  no script.
- **2026-10-16** — The standalone version is fast on a large folder (release v0.0.36). On a
  folder shaped like a 3,500-note vault, a keystroke took 7.6 s and now takes one frame, opening
  takes 0.5 s instead of 4.9 s, and switching notes is instant instead of 3.8 s. Link lookups
  (`web/lib/links.ts: resolveLocal`) use an index built once per note list instead of scanning
  every note, which speeds up the full app's Live Preview and links too. Typing no longer
  rebuilds the note list unless tags, type or aliases change; notes are read in parallel; the
  preview and search follow just behind typing. `test/ui/standalone.ui.ts` checks a folder that
  size.
- **2026-10-16** — A standalone version (release v0.0.35; `standalone/`, `bun run standalone`): Commonplace as one
  HTML file that edits a folder of Markdown files with no server or account. It reuses the app's
  editor (Live Preview and the other three modes, wikilinks, embeds, tables, properties), the file
  panel, search, tags, backlinks and outline, and ⌘O. Chrome and Edge save to the files as you
  type; Safari and Firefox keep edits in the tab and download them as a zip.
- **2026-10-15** — The review's remaining findings (release v0.0.34, N13). Being added to a
  vault is now an invitation to accept (Join vault / Decline in the sidebar; owners see and cancel
  pending ones), which grants nothing until accepted, and the reply no longer says whether an
  email has an account. Outgoing fetches (weblinks, assistants) connect to the address that was
  checked, so DNS rebinding can't swap in a private one (`src/egress.ts`). The app sends a CSP
  (no inline script), `frame-ancestors 'none'`, Referrer-Policy, nosniff and HSTS. Offline copies
  are kept per person, and someone else signing in on the same browser clears the last person's.
  Only an owner deletes from Trash for good. The Docker image is pinned and runs as non-root.
  In the app: search shows its errors and can't be repopulated after clearing, vault switches
  can't mix vaults' bookmarks, saved searches or types, the links panel resets per note, folders
  and the title work from the keyboard, the quick switcher and command palette use the shared
  dialog (focus trap and return), and the error screen says what to do. Tests wait on conditions
  instead of fixed sleeps, the HEIC test runs everywhere (a fixture), and each suite has its own
  ports so they can run at once.

- **2026-10-15** — Ready for public review (release v0.0.33). A high-level design
  (`docs/ARCHITECTURE.md`: context, components, data model, key flows, security model, decisions),
  `SECURITY.md`, `CONTRIBUTING.md`, `test/README.md` and an MIT licence; a header on every file and
  a comment on every table; dead code removed; the product described in its own words. Fixes from a
  security review: the private-address check sees IPv4 written inside IPv6 (and guards assistants'
  base URLs too); the assistant asks before changing even the open note once a conversation has
  used another vault; sign-in pauses after ten wrong passwords and a new password signs out other
  devices; signup is off unless set, and production without `SETUP_TOKEN` makes one; zip imports
  expand to at most 256 MB and pass the storage guard; only owners can import `publish.json`; MCP
  batches are capped. The rest followed in v0.0.34 (N13, above).

- **2026-10-13** — Publish a vault as a website (release v0.0.32, F18 step 1). Settings →
  Website (owners): the whole vault or chosen folders, `publish: false` to keep a note out, a
  "what will be public" list, Publish, and "Take the site down" with Undo. Pages live at
  `/p/<random slug>/`, unlisted (`noindex`), in one reading theme from the app's tokens, light
  and dark, with a page list and a top-level `index`/`Home`/`README` note as the home page.
  Publish takes a snapshot (`site_pages`, `site_files`), so edits stay private until the next
  Publish, and Settings lists what a republish would add, change or take down. The tests show a
  note left out, its title and its files can't be reached by any URL, that pages run no script,
  and that the pages pass axe on the laptop and iPhone in both themes (which also fixed callout
  title contrast in the app). The choice is `publish.json` at the vault's top level.

- **2026-10-13** — Links by alias and id (release v0.0.31, F9 step 1 in part): a note's
  `aliases` (a list or one string) and AI-XF `id` are other names a link can
  use, so `[[Sam]]` reaches a note with `aliases: [Sam]` in backlinks, the graph, type pages,
  link resolution and the editor. A real title or path still wins. Kept as a generated column
  (`notes.link_names`, from the frontmatter), so the markdown stays the source.

- **2026-10-13** — A short tour (release v0.0.30, first-run welcome): an empty vault's home
  offers "Add a short tour", five ordinary notes in `Tour/` (`src/tour.ts`) that teach
  Commonplace by being used: properties, ⌘O, ⌘K, `/`, links and backlinks, an embed, a typed
  note (with the Person type, added if missing), focus mode and history. Opt-in, once per
  vault, and deleted like any folder.

- **2026-10-13** — Turn into a typed note (release v0.0.29, from Capacities): select text, or
  put the cursor on a line, then ⌘K "Turn into a typed note…" (or ⋮⋮ → "Make it a note of a
  type…"), pick a type, and the text becomes a note of that type with a `[[link]]` left in
  its place; list and to-do markup stay. An existing note of that name is linked rather than
  made twice.

- **2026-10-13** — Writing: history diff, saved searches, focus mode (release v0.0.28).
  **History** shows what restoring a version would change, as a diff against the note now
  ("Restoring brings back 1 line and takes away 2"), or its full text. **Saved searches**:
  Save in the Search panel keeps a search in the sidebar under Bookmarks, run afresh each time
  (a smart folder); per person, like bookmarks (`saved_searches`). **Focus mode** (⌘K "Focus
  mode"): only the text, at reading width, with typewriter scrolling; Escape or Leave focus
  ends it, and it's remembered on the device. Tests: 4 new UI tests, 1 e2e.

- **2026-10-13** — Accessibility (release v0.0.27, part of N12): axe runs in the UI tests on
  the main screens, laptop and iPhone, light and dark, and passes; a new keyboard-only test
  covers find, edit, Settings and back. Fixed: text contrast (`--faint`, `--accent`,
  `--danger` darkened just enough for 4.5:1), accessible names (editor, task checkboxes,
  property inputs, member role), the view switch as a radio group, the palette and quick
  switcher as a combobox with a listbox, a focus trap in every dialog, and focus landing in
  the note's text (below its properties) when it's opened from the keyboard. Also fixed:
  `fuzzyScore`'s "no match" could be outscored by a bonus, so the palette, quick switcher, `/`
  menu and choice dialogs never filtered anything out; and the palette now matches each word in
  any order ("account settings").

- **2026-10-13** — Speed at 10,000 notes (release v0.0.26, part of N12): `bun run bench` builds
  a 10,000-note vault and checks each endpoint against a budget. Fixed what it found: type pages
  (32 s → 13 ms) and the graph (failed → 150 ms) now resolve links with an equality join over
  each note's link names (`notes.linkKeys`) instead of a suffix test against every note; backlinks
  use it too. Imports, GitHub copies and restores refresh Postgres's statistics every 1,000
  notes, and new indexes on lower(path) and lower(title) keep lookups indexed: importing 10,000
  notes went from 61 s to 12 s.

- **2026-10-13** — Backups you can restore (release v0.0.25): `/api/backup` now streams the
  zip a piece at a time (a 472 MB backup peaked at 315 MB of server memory, which had 148 MB at
  rest), and `scripts/restore.ts` restores one into an empty database: notes, files, empty
  folders, history, Trash and members whose accounts exist. A new e2e test restores a backup
  and compares it note for note. Also: the boot-time schema now retries if it deadlocks with a
  server still writing (as the old instance can during a deploy).
- **2026-10-13** — GitHub vaults against real GitHub (release v0.0.24, N11): a scripted trial
  on a real private repo passed every step. Fixed what it found: a pull request GitHub refuses
  after the branch is pushed no longer strands the vault (the branch is recorded first, and
  Open pull request tries again). GitHub's refusals are logged without the token, and push
  errors stay in the dialog.

- **2026-10-12** — N9 storage guard, instead of storage autoscaling (release v0.0.23): the
  database disk stays a fixed 1 GB with autoscaling off on purpose, and the server guards it
  (`src/storage.ts`). At 80% admins see a warning when they open Commonplace; at 90% new notes,
  files, imports, GitHub copies and agents' edits are refused with a 507 that says why, while
  typing in open notes carries on, so the disk never fills (Render suspends a full database).
  Agents and GitHub syncs now keep one version per ten-minute burst rather than one per call,
  each note keeps its newest 100 versions (pruned at boot and every six hours), and a note is
  at most 5 MB however it's written. `DB_DISK_GB` defaults to 1. Tests: 3 new (176 in all).
  Also: the backlog was taken stock of and restructured (finished designs in `docs/design/`,
  this changelog split out, F9 rewritten around F16, a decided order for Next).

- **2026-10-12** — F17 one Settings screen (release v0.0.22): Account and Vault settings are
  now one **Settings** screen (`web/components/Settings.tsx`) with sections Account, This vault,
  AI assistants, Connections (Claude, GitHub, Share from iPhone) and Admin (admins only). On a
  laptop the sections are listed beside the open one; on the iPhone the list comes first and a
  section opens in its place, with a way back. The gear opens This vault, the account button
  Account, and ⌘K has one command per section ("github token", "members", "api key" find them).
  `openSettings()` (`web/lib/settings.ts`) opens it from anywhere: "New vault from GitHub" no
  longer carries its own copy of the connect form but opens Settings → Connections over the
  dialog, which carries on once connected. The rule and a checklist line are in
  [PRINCIPLES.md](PRINCIPLES.md) §2; server messages and docs now say "Settings → …". The audit
  found nothing else to move: the remaining controls (sort, edit or read mode, panels, task
  and graph filters, the AI panel's assistant) change the view, and type definitions are
  markdown. Also fixed: the vault home could say "This vault is empty" for a moment before its
  notes and folders arrived. Tests: 3 new UI tests (62 in all).

- **2026-10-12** — F14 GitHub vaults, all four steps (release v0.0.21):
  - **Copy in:** from the vault picker ("New vault from GitHub…") or ⌘K. Connect a fine-grained
    token (Account → GitHub: checked with GitHub, sealed with `SECRETS_KEY`, shown only as its
    last four characters), then pick a repo, branch and folder; the folder list shows how many
    notes each holds. Only markdown, canvases and attachments come in (not dot-folders), within
    the import limits. It reads through the Trees and Blobs APIs rather than the zipball, so a
    big code repo with a small `docs/` costs only the docs.
  - **The bar and Review changes:** the bar shows the branch, "N notes changed", any clashes and
    the PR's state, on the laptop and the iPhone. Review changes lists notes and files that were
    added, edited, moved (an added file identical to a deleted one) or deleted, each with a diff
    against GitHub (the AI chat's diff, now `web/ui/Diff.tsx`) and Revert.
  - **Pull request:** the form is filled in from the changed notes. Co-authors (others who edited
    them) appear as `Co-authored-by:` lines you can see and remove before sending. The push is
    one commit (blobs, a tree on the base tree, a commit and a ref) and opens the PR. Later edits
    show as "Push N more changes" and land on the same PR. The PR's state is checked at most
    once a minute.
  - **Update from main:** files unchanged here update in place; notes changed on both sides
    merge line by line (`src/merge3.ts`, diff3); real clashes keep your text and wait under "To
    settle" with Keep mine or Take main's (and block pushing until settled). On a pushed branch
    the next push is a merge commit, so the PR shows only your changes. After the PR is merged,
    the update ends the branch.
  - **Cancel the branch:** a confirmation names how many changes go back. Every note returns
    through `overwriteContent` (reason `github-revert`, so its edits stay in history), added
    notes go to Trash, and the pushed branch is deleted unless a PR is open.
  - **Tests:** 9 end-to-end tests against `test/fakeGitHub.ts` (an in-memory git with real blob
    SHAs, which also proves the token is never in a URL), 6 merge unit tests, and 3 browser tests.
  - **Also:** the capture token now defaults to the vault you're in, and the screenshot script
    uses a fresh browser per device and theme.
- **2026-10-12** — F12 step 2, the `+` and `⋮⋮` block handle (release v0.0.20):
  `web/lib/blocks.ts` works out blocks from the syntax tree each time (a list item with its
  children, a heading's line, a paragraph, a table, a code block, a quote or callout).
  `web/lib/blockHandle.ts` draws the handle.
  - **Where it shows:** on a laptop it follows the pointer in the left margin, which is now 52px
    there; reading view matches, so nothing jumps. On the phone just the ⋮⋮ sits by the
    cursor's block.
  - **`+`:** adds a line below (a new item in a list) with the `/` menu open.
  - **⋮⋮ menu:** Turn into… (text, headings, lists, to-do, quote, callout), Colour…, Duplicate,
    Copy link to heading, and Delete with Undo, which puts the text back where it was even if
    the note changed since.
  - **Drag:** moves the whole block with a drop line, reindenting a list item to the level it
    joins and keeping one blank line between paragraphs. A mouse drag starts after 5px, a finger
    after a 400ms press. A move is one change, so one ⌘Z puts it back. It's refused while
    another person's cursor is inside the block.
  - **Shared code:** `menuAt()` in `web/ui/Menu.tsx` opens the shared menu from outside React.
  - **Tests:** 12 unit tests, plus three browser tests: a drag while someone else types, then
    Undo; `+` with Turn into and Delete; a long-press drag on the phone.
- **2026-10-12** — F10 coloured text and highlights (release v0.0.19):
  - **Reading:** every form people's notes carry: Highlightr's `<mark style="background: #…A6;">`
    and `<mark class="hltr-…">` (checked in its source), Editing Toolbar's `<font color>` and
    `<span style="background:">` (checked in its source), hand-written `<span style="color">`,
    and Hilo's `=={red}…==`. They show in reading view and in Live Preview, where the tags hide
    off the cursor's line.
  - **Safety:** the sanitiser still forbids `style`; a hook keeps only `color` and `background`,
    only on span, mark and font, and only plain colour values. A test proves an overlay or
    `url()` can't get through.
  - **Theme-aware:** palette colours (and Highlightr's defaults) are drawn with shades for light
    and dark from tokens.
  - **Writing:** ⌘⇧H, ⌘K → Colour…, or the phone bar's **A** colours the selection (or the word
    at the cursor) as a highlight or text in six colours, or removes colour. It writes
    Highlightr's `<mark style="background">` and `<span style="color">`, which other Markdown
    editors show with no plugin.
- **2026-10-11** — F8 tables cell by cell (release v0.0.18): in Live Preview each cell edits in
  place (its markdown while editing, rendered otherwise); Tab and Shift-Tab move, Enter goes
  down, Tab or Enter at the end adds a row; a bar over the table adds rows and columns either
  side, deletes them, aligns a column and opens the markdown. Every change rewrites the table
  with aligned pipes (wide characters counted, `|` escaped) as one minimal edit, so it merges
  with live typing and one Undo reverses it; what's being typed in a cell is folded into a row or
  column change, never lost. Also: the server's shutdown flush is capped at 10 s (Render kills a
  slow process at 30 s), and the browser tests restart headless Chrome every 20 pages, which
  stops painting after forty-odd in one run.
- **2026-10-11** — Weblinks as notes (release v0.0.17, from Capacities): a link shared from the
  iPhone, or saved with ⌘K → Save a web link, becomes a Weblink note (a starter type, added on
  first use) with the page's Open Graph title, description, site and picture (saved as an
  attachment), and the inbox to-do links to it. The address kept is where the link leads after
  redirects, and saving it again finds the same note. Safe fetching (`src/weblinks.ts`): http(s)
  on ports 80/443 only; private, loopback, link-local (cloud metadata), CGNAT and unique-local
  addresses refused, re-checked at every redirect; 8 s, 1.5 MB HTML, 5 MB picture. Checked live:
  BBC News and GitHub save with pictures; 169.254.169.254 and 10.0.0.1 are refused.
- **2026-10-11** — Small wins (release v0.0.16):
  - **Tasks:** every `- [ ]` in the vault (not in code or frontmatter), open, done or all, by
    note or by due date (`📅 YYYY-MM-DD`, with overdue in red); ticking one ticks its line,
    merged with typing, and refuses if the line has changed.
  - **Unlinked mentions:** notes that say a note's title as a whole word, outside links and
    code, with one-click Link that keeps the words written (`[[Boiler|boiler]]`). After
    Capacities' "related content".
  - **Bookmarks (F7):** per person, from ⋯ or ⌘K, at the top of the sidebar beside Tasks.
  - **Sorting (F7):** the file tree sorts by name, last changed or newest.
  - **Create as a type:** following a link to a missing note asks "A note, or a Person…" when
    the vault has types.
- **2026-10-11** — F16 step 6, the AI organiser knows types (release v0.0.15):
  - **New tools** (also on MCP): `list_types`; `set_type`, which checks choices against the
    type's options and requires links to be `[[wikilinks]]`; `create_type`; and `merge_notes`,
    which folds the duplicate's text and missing properties in, relinks every note, and sends
    the duplicate to Trash. Each previews its change.
  - **Approval:** typing the open note applies at once; anything else waits for approval.
  - **Instructions:** the assistant's instructions list the vault's types and properties, with
    rules not to invent values and to leave a property out when the note doesn't say.
  - **Tried on relaxAI's DeepSeek-V4-Pro:** asked to file a six-note inbox, it read each note,
    proposed Dune as a Book (author, Read, rating 5), Sam as a Person (Trade, phone) and Shah
    Interiors as an Organisation, and suggested a Recipe type for the three bakes, all waiting
    for approval; £0.012.
- **2026-10-11** — F2 notes inside notes, with F16 step 5 link cards (release v0.0.14):
  - **Embeds:** `![[Note]]` shows the note, and `![[Note#Heading]]` just that section, in a framed
    box whose title opens it, in Live Preview (a block widget; click it to edit the line) and in
    reading view. They nest three deep; a loop says "Already shown above"; a missing note or
    heading says so. Tasks inside an embed are shown, not ticked.
  - **Link cards:** a `[[link]]` alone on its line, to a typed note, shows the type's icon and
    colour, the title and up to three of its properties. Inline links and untyped notes stay
    links. A type can turn cards off (`cards: false`, a checkbox in the type editor).
  - **AI:** `split_note` now leaves an embed, so the original still reads in full.
  - **Fixed:** after six full page loads, the seventh could stall, because the back/forward
    cache kept event streams open and used up the browser's six connections to the site. Streams
    now close on `pagehide`, and a restored page reloads.
- **2026-10-11** — F4 works offline on the iPhone (release v0.0.13):
  - **The app opens with no signal:** a service worker (`web/sw.js`) is network first for
    everything, with a cached copy of the app and the reads it needs to start (session, vaults,
    note lists, note metadata, types, pictures). It never caches writes, the event stream, AI,
    search or exports.
  - **Notes open and take edits offline:** every opened note keeps its Yjs state on the device
    (`y-indexeddb`, the 200 most recent), and is editable as soon as that copy loads, server or
    not. Edits merge when the socket reconnects.
  - **Copies can't merge with the wrong note:** they're named with this database's `instance`
    id (`server_info`), so a replaced database never merges with them.
  - "You're offline" and "Back online" toasts, and an Offline badge in the sidebar.
  - Signing out forgets the copies and the cached reads.
  - Tested by stopping the server: the app opened from the device, took an edit, kept it across a
    reload, and synced it once the server came back, with no duplicated text.
  - Not yet: creating, renaming or moving notes offline (they say the server can't be reached).
- **2026-10-11** — F16 type editor and starter types (release v0.0.12):
  - **Type editor:** a type's own note opens with a form: icon, colour, and its properties (name,
    kind, choices for a Choice, target type and "more than one" for a link), reordered or removed
    with Undo. Each change saves on its own and merges with live typing (`PUT …/types/:name`),
    keeping the template and any other keys. Renaming a property offers to rename it in the
    notes that have it.
  - **Renaming a type** (`POST …/rename`) carries every note's `type:`, other types' links to it,
    and its saved views with it.
  - **Starters:** New type offers Person, Organisation, Meeting, Project, Book and Idea, each with
    sensible properties and a template. Adding one also adds the starters its links need.
- **2026-10-11** — F16 types, steps 1–4 (release v0.0.11), after Capacities:
  - **Format:** a type is a note in `Types/` (properties, icon, colour, and its body as the
    template); a note is typed by `type:` in any common form; relations are wikilinks in
    properties, so they're ordinary links. `notes.type_name` is a generated, indexed column.
  - **Sidebar and chip:** a Types section above Folders (with types notes use but nobody has
    defined yet, to "Define it"). A chip above each title opens the type's page or changes the
    type, keeping every property.
  - **Properties panel:** shows the type's properties even when empty, with a menu for selects, a
    picker of the right type's notes for relations, and a type menu.
  - **Type pages:** table, cards or list; filter, sort, group; Recent, Untagged and No backlinks;
    cells set properties live-safe (`PATCH …/properties`); "New Person" uses the template; views
    are saved as `Types/Person.base` (a subset of the `.base` format) and export with the vault.
  - **Relations from the other side:** backlinks grouped by property ("As attendees").
  - **Days thread themselves:** a daily note lists what was made and changed that day, and every
    note links to the day it was made.
  - Lists by default on a phone.
- **2026-10-11** — F5 semantic search with relaxAI (release v0.0.10): `EMBEDDING_PROVIDER=relaxai`
  embeds with `Mistral-7b-embedding` (UK datacentre, £0.20/M), cut from 4096 to 1024 dims and
  renormalised (Longview's measurement, re-checked here: same best match at both widths).
  relaxAI's similarities are bunched, so its search floor is 0.6 *and* within 0.04 of the best
  hit, and Related needs 0.75. Measured on a real vault with the live API: meaning-only queries
  ("keeping the house warm", "travel plans") found the right note, and Related paired Boiler
  with Central heating service, not with Pancakes. Search and Related only compare vectors from
  the current provider, so results stay right while a switch re-embeds. Chose relaxAI over the
  planned Voyage to keep everything UK-hosted, as in Longview.
- **2026-10-11** — AI costs in £ and a daily £ limit (release v0.0.9), for every provider:
  `src/prices.ts` holds list prices checked 2026-10-11 (relaxAI in £; Anthropic and OpenAI in $
  at 0.75), counting prompt-cache reads at a tenth and writes at 1.25×. Each assistant has a
  price (the list price, or its own) and a daily limit (£1 by default); every model call is
  recorded in `ai_usage` and the limit is checked before each one, so a turn stops cleanly when
  it's reached and nothing more goes to the provider until the next day (London time) or the
  limit is raised. A limit needs a price, so unknown models must be given one. The cost line
  shows £; it turns amber at 80% of the limit. OpenAI's default model moved to gpt-6.1-sol.
- **2026-10-11** — relaxAI as a named provider (release v0.0.8), as Longview uses it: Civo's UK
  datacentre, OpenAI-compatible, default DeepSeek-V4-Pro (Nemotron-3-Super and
  DeepSeek-V41-Flash offered). 32k max_tokens for its reasoning models; conversation cost shown
  in £ from Longview's price table. Checked against the live API on 2026-10-11: streamed tool
  calls and tool-result round trips work on all four chat models; Kimi-K26 still answers but is
  no longer listed.
- **2026-10-11** — F13 bring your own AI (release v0.0.7): `/boyai` (or ⌘K, Account → AI
  assistants) adds an assistant with your own key: Anthropic, OpenAI, or any OpenAI-compatible
  base URL. Keys sealed with AES-256-GCM under `SECRETS_KEY`, never returned or shared, sent only
  in headers. **`@name`** in a note opens the chat under that line (a bottom sheet on the
  iPhone); ✓ keeps it as a folded `> [!ai]-` callout, ✗ discards. **⌘J** (or the side panel's
  AI tab, opened with F15's top-right toggle) is a conversation that follows you between notes;
  ✓ saves it to `AI/`. Librarian, author and organiser: new tools `rewrite_note`,
  `set_properties`, `move_note`, `split_note` (also on MCP). Changes to the open note apply live
  (merged with typing, kept in Version history); anything else returns as a pending change with
  a line diff to **Apply** or **Discard**, and every applied change gets Undo. It drives the app
  through the command list (`open_note`, `run_app_command`, Go and View commands only). Streams
  over SSE, stateless on the server; 12 model calls per turn at most; token counts shown
  (prices aren't, since they change). Tested end to end with a fake provider
  (`test/fakeAi.ts`). Not done from the plan: the assistant's own cursor colour in the note.
- **2026-10-11** — F15 sidebar toggle (release v0.0.6): the ▯| button at the top left of every
  screen shows and hides the file panel, and |▯ at the top right the links panel; both slide
  (the column widths are registered CSS properties, so they animate and the note widens
  smoothly), are remembered per laptop (`cp:left`, `cp:right`), and leave the tab order when
  hidden. **⌘\\** and "Show or hide the file panel" in ⌘K; search and tag clicks open it
  first. On the phone the same icon opens the drawer. `web/ui/PanelToggle.tsx`.
- **2026-10-11** — Milestone B, L1 MCP server (release v0.0.5): `POST /mcp` (Streamable HTTP,
  stateless JSON) with personal MCP tokens (`cpm_…`, read-only or read and write, revocable,
  bearer only); tools `list_vaults`, `search_notes`, `read_note`, `list_notes`, `list_tags`,
  `create_note`, `append_to_note`, `edit_note`, defined once in `src/tools.ts` for F13 to reuse.
  Runs as the user with their roles; every write saves the previous text as a version and merges
  with live typing. Account → Connect Claude; `docs/MCP.md`. Tested with the official MCP SDK
  client. Fixed on the way: a refused write left an unhandled rejection that crashed the server.
- **2026-10-11** — Milestone A, a daily driver (release v0.0.4):
  - **F6 Move to…** for notes and folders (`chooseDialog`), sharing one move-with-Undo path
    with dragging (`web/lib/moving.ts`).
  - **F3 Templates** (`Templates/`, `{{title}}`, `{{date}}`, `{{time}}`, `{{date:FORMAT}}`):
    Insert template… merges properties into the note's own; New note from template; Today
    uses `Templates/Daily.md`; daily notes get ‹ › and a month calendar in the side panel.
  - **One command list** (`web/lib/commands.ts`) behind the **⌘K palette**, the note's ⋯ menu,
    and the editor's **`/` menu** (F12 step 1: blocks, callout, table, code, divider, link,
    tag, date, picture, template, property; not in code, frontmatter or URLs). ⌘O stays the
    note switcher.
- **2026-10-11** — Quick capture from the iPhone (from the brainstorm): an Apple Shortcut in the
  share sheet posts links, text and photos to `POST /api/capture` with a per-person capture token
  (hashed, revocable, `Authorization: Bearer` only); they land as to-dos in an inbox note,
  appended through the live room so they never undo typing. Photos are converted server-side in
  a child process (HEIC → JPEG, 2048 px, EXIF upright; size-capped for the 512 MB instance).
  Account → Share from iPhone makes tokens and shows the steps; `docs/IPHONE-SHORTCUT.md`.
  Principle §10 (built to become iOS and desktop apps) and L8 added. Shortcut steps still to be
  checked on a real phone.
- **2026-10-11** — N10 one design language (`4da1fad`, release v0.0.2; v0.0.1 is the rollback
  point before it): shared `web/ui/` kit (Modal, Menu as popover or phone action sheet, the
  app's own confirm, prompt and Undo toasts) replacing all 25 browser dialogs; Undo instead of
  confirms for Trash, empty folders, members and version restore; `web/styles/` split per area
  on tokens (type scale, radii, motion with reduced-motion, layers, focus ring, tap size);
  44 px phone targets, folder ⋯ menus, one Edit/Read toggle on the phone. Enforced by
  `test/design.test.ts`; `bun run screens` for visual checks. Spacing is on a 4 px grid by
  convention but not yet tokenised.
- **2026-10-10** — F1 edit properties in place: text, number, date, checkbox and list (pills)
  values, add with a type, rename, remove, Edit YAML, and **⋯ → Add property** for notes with no
  frontmatter. Each edit rewrites only that property's lines (`web/lib/frontmatter.ts`), so
  comments and formatting elsewhere survive and edits merge with live typing. 5 browser tests,
  6 unit tests.
- **2026-10-10** — N8 iPhone photos (library and camera) upload as JPEG, checked on a real phone.
- **2026-10-10** — N1 Trash: deleted notes keep their history for 30 days and can be restored;
  live edits are flushed first. N2 photos shrink to 2048 px JPEG in the browser; admin page shows
  storage. N3 off-site backup: bearer-token `/api/backup` and a daily GitHub Action (Render's own
  PITR is 3 days on Hobby; exports kept 7). N4 `bun run test:ui` (13 headless-Chromium tests);
  it found that Live Preview links stayed "unresolved" until the note list loaded, now fixed.
  N5 plain-text outline. N6 vault home with only folders. N7 `render.yaml` drift documented,
  `SETUP_TOKEN` cleared.
- **2026-10-10** — Postgres 17 → 18 (L5): local Docker on `pgvector/pgvector:pg18`; production
  upgraded in place on Render, now Postgres 18.6 with pgvector 0.8.6, confirmed by the boot log.
  Failed live saves now retry instead of dropping unsaved edits (`ae68cb0`)
- **2026-10-10** — Drag and drop notes and folders, with mouse and long-press touch (`c01fff3`)
- **2026-10-10** — New folder button; empty folders persist and round-trip through zip (`660ab5d`)
- **2026-10-10** — Simultaneous creates return 409, not 500 (`74abddb`)
- **2026-10-10** — Live Preview renders frontmatter and tables; picture picker (`6b74b54`)
- **2026-10-10** — Live Preview and Source mode (`d446204`)
- **2026-10-10** — Setup token for the first admin; deployed to Render (`158af13`)
