# Gap analysis (2026-11-01)

Where Commonplace stands against what people expect from a notes app, measured against the tools
they'd compare it with (Obsidian, Notion, Capacities, Logseq, Bear, Apple Notes, Reflect). What
it already does is in [FEATURES.md](FEATURES.md); what's planned is in [BACKLOG.md](BACKLOG.md).
Each gap says whether it's already planned, and how much it matters for a personal and household
library shared by a few people.

**In short:** the writing, linking, types, search, AI, GitHub and publishing are ahead of most of
the field. The gaps are around the edges: **getting things in** (web clipper, email, voice,
imports), **being nudged** (reminders, notifications, activity), **reach** (Android, Windows,
TestFlight), and **identity**: the name is long and the icon is plain (F34).

## What's strong

Live co-editing with offline merges; typed notes with forms, views and relationships; full-text,
fuzzy and semantic search fused; Dataview and sandboxed dataviewjs; bring-your-own AI that asks
before changing anything, with costs in £; MCP for Claude; GitHub collections with pull
requests; published sites; boards; the graph and its timeline; the iPhone and Mac apps with share
extensions, passkeys and Siri; plain Markdown out at any time. Few rivals have more than half of
this, and none keep it all as portable Markdown.

## Gaps

**Priority:** ● high (felt every week) · ◐ medium · ○ low (nice to have).

### Getting things in

| Gap | Rivals | Status | Priority |
|---|---|---|---|
| **Web clipper** for Chrome and Safari on the Mac: save a page, a selection or a picture with its source | Obsidian, Notion, Evernote | Not planned (the Mac share extension covers Safari's Share menu, not a toolbar button or selections in Chrome) | ● |
| **Email in:** forward an email to a private address and it lands in the Inbox | Notion, Evernote, Reflect | Not planned | ◐ |
| **Voice notes:** record, keep the audio, transcribe | Apple Notes, Reflect | In Ideas | ◐ |
| **Search inside PDFs and pictures** (text and OCR) | Apple Notes, Evernote, Notion | Not planned: embeds show PDFs, but their words aren't searched | ◐ |
| **Import from Notion, Apple Notes, Evernote** | Every rival imports something | Notion and Apple Notes in Ideas; Day One done | ◐ |
| **Siri: open a note, ask a question** | Apple Notes | L8 item 5 | ○ |

### Being nudged

| Gap | Rivals | Status | Priority |
|---|---|---|---|
| **Reminders:** a task with a date tells you on the day (push on the iPhone and Mac) | Apple Notes, Notion, Todoist-style plugins | Not planned: due dates show on the Tasks page only | ● |
| **Notifications:** an invitation, a mention, a change to a note you follow | Notion, Google Docs | Not planned | ◐ |
| **Activity feed** in a shared collection | Notion | In Ideas | ◐ |
| **Comments** on notes | Notion, Google Docs | L3 | ◐ |
| **@people** (mention someone, who's told) | Notion | In Ideas (`@` calls assistants today) | ○ |

### Reach

| Gap | Rivals | Status | Priority |
|---|---|---|---|
| **TestFlight** for the iPhone app, so it installs without a cable and updates itself | Every rival is in the App Store | L8 step 1, still to do | ● |
| **Widgets and quick capture:** a home-screen widget, a Mac hotkey window, a menu-bar item | Apple Notes, Bear, Things | Mac hotkey and menu bar in L8 step 3; widgets not planned | ◐ |
| **Android** (beyond the home-screen web app) | Obsidian, Notion | Not planned; the web app installs and works offline | ○ |
| **Windows and Linux apps** | Obsidian, Notion | L8 step 3, "if ever"; the laptop kit runs there | ○ |

### Writing and organising

| Gap | Rivals | Status | Priority |
|---|---|---|---|
| **Drawing and handwriting** (a sketch in a note, Apple Pencil) | Apple Notes, Excalidraw in Obsidian | Boards cover shapes and arrows; no freehand | ◐ |
| **Templates beyond types:** a template picker for any new note | Obsidian, Notion | Types' bodies are templates; no untyped templates | ○ |
| **Image alignment and captions** | Notion | In Ideas (needs a design) | ○ |
| **Flashcards / spaced repetition** | Obsidian plugins, RemNote | Not planned | ○ |
| **Plugins** | Obsidian | Decided by design: Dataview and dataviewjs in a sandbox instead | — |

### Sharing and trust

| Gap | Rivals | Status | Priority |
|---|---|---|---|
| **Share one note by link** (read-only, revocable) without publishing a site | Notion, Bear, Apple Notes | Not planned: publish is per collection or folder | ◐ |
| **Two-step sign-in** for passwords (TOTP), and passkey-only accounts | Notion, Google | Passkeys done (F32); no TOTP | ◐ |
| **Audit log** for owners: who changed, invited or removed what | Notion (business plans) | Not planned; Version history covers notes | ○ |
| **End-to-end encryption** | Obsidian Sync, Standard Notes | Not planned: the server needs the text for search, AI and live editing | — |

### Running it

| Gap | Rivals | Status | Priority |
|---|---|---|---|
| **More than one server instance** and failover | Hosted rivals | L4, L7 | ○ |
| **Restore from the app** (not only a script) | — | Not planned; `scripts/restore.ts` and the e2e test | ○ |
| **VoiceOver on a real iPhone** | — | N12; the share sheet passed 2026-11-01, the rest still to do | ◐ |

### Identity

| Gap | Status | Priority |
|---|---|---|
| **A short, catchy name and a striking icon:** "Commonplace" is four syllables, hard to say to Siri in a hurry, and shared with many products; the icon is a plain mark that doesn't stand out on a home screen | Done 2026-11-01: **DO Notes**, with a ball-of-thread icon (F34) | — |

## Suggested order

Now kept in [BACKLOG.md](BACKLOG.md) → **Next: in this order** (decided 2026-11-01), which
merges these gaps with the rest of the backlog: TestFlight, reminders and quick capture first.
