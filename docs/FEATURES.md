# Features

Everything DO Notes does, in one list. The [README](../README.md) has the short version, the
[help](help/index.md) shows how to use each part, and [ARCHITECTURE.md](ARCHITECTURE.md) explains how
it's built.

- **Extended Markdown:** `[[wikilinks]]` (with `|alias` and `#heading`), `![[embeds]]` for images,
  audio, video and PDFs, `#tags` (nested, inline or in frontmatter), YAML frontmatter shown as
  properties, `> [!callouts]`, `==highlights==` and coloured text and highlights (⌘⇧H; read from Highlightr,
  Editing Toolbar and Hilo, written as HTML that other editors show), GFM tables, ```` ```mermaid ```` diagrams (the same
  syntax other Markdown editors use), and task lists you can tick in reading view.
- **Dataview queries:** ```` ```dataview ```` blocks (`TABLE`, `LIST`, `TASK` and `CALENDAR`, with `FROM` a folder,
  `#tag` or `[[link]]`, `WHERE`, `SORT`, `GROUP BY`, `FLATTEN`, `LIMIT`, `WITHOUT ID` and Dataview's
  functions), inline `` `= expression` ``, and the common `` `$= dv.pages(…).where(…).length` `` count,
  read the way the Dataview plugin reads them, over frontmatter, inline `key:: value` fields,
  tags, links and tasks. Results show in reading view, embeds and Live Preview, follow the collection
  as it changes, and a task ticked in a `TASK` result is ticked in its own note.
- **dataviewjs:** ```` ```dataviewjs ```` blocks run Dataview's JavaScript API (`dv.pages`, `dv.table`,
  `dv.list`, `dv.taskList`, `dv.paragraph`, `dv.el`, `dv.query`, `dv.io.load`, `dv.view`, DataArray,
  Luxon dates…) in a sandboxed frame for each block: no network, no cookies, no access to the app,
  only the collection's notes (which any member can read) and its own box to draw in. Links in it
  open notes and its task boxes tick tasks, through checked messages to the app. Publish runs each
  block in the same sandbox in the owner's browser, over the published notes only, and keeps what
  it drew, since published pages run no script. A script stuck in an endless loop is stopped after
  5 seconds and says so, rather than freezing the page.
- **Live Preview:** markdown renders in place while you type. Headings, bold,
  links, `[[wikilinks]]`, images, task checkboxes, callouts, quotes, code and Mermaid diagrams show formatted, and a
  line reveals its raw markdown only while the cursor is on it. Frontmatter shows as a properties
  panel you can edit in place (text, numbers, dates, checkboxes, and lists as pills; add, rename
  or remove properties), and GFM tables render as tables you edit cell by cell (Tab between cells, a bar for rows and columns), written back with the pipes lined up. Click a
  link to follow it, tick a checkbox to complete a task. As in Notion, `/` opens a menu of
  blocks, and a `+` / `⋮⋮` handle beside each block inserts below it, turns it into another kind,
  colours, duplicates or deletes it, and drags it (a list item with its children) to a new place.
  Source mode (`</>`) shows plain markdown; reading view is
  read-only. Code blocks are coloured by language, with a language picker and Copy; a picture
  opens on its own with a click; `[[` suggests a note's headings and aliases; a pasted picture
  is named after its note; a word count sits at the bottom of the note; and each note reopens
  where you left it. Headings and list items fold away, resting on a link previews the
  note, and selecting words on a laptop shows a format bar (⌘B, ⌘I, ⌘⇧X and ⌘E toggle too).
- **Live collaboration:** Yjs CRDTs over WebSockets. Edits merge character by character, you see
  other people's cursors and selections and who is in the note, and undo only undoes your own
  changes. A phone that edits offline merges cleanly when it reconnects.
- **A library of collections:** everything on a server is one library, named by an admin (by
  default after the first admin: "David's Library"). It holds collections, each a separate set of
  notes and folders with its own members. Other Markdown editors call these vaults.
- **Multi-user collections:** accounts and shared collections with owner, editor and viewer roles. Viewers
  are read-only everywhere, including on the live socket. Owners invite people by email, and
  nobody joins until they accept: the invitation waits in their file panel (even if they sign up
  later) with Join collection and Decline. An admin manages accounts.
- **Types (think in things, not files):** say what a note *is* (Person, Meeting, Book) with
  `type:` in its properties. Start from a ready-made type (Person, Organisation, Meeting, Project,
  Book, Idea) or make your own; a type's note opens with a form for its properties (text, number,
  date, checkbox, list, a choice, or a link to another type), icon and colour, and its body is
  the template. Renaming a type renames it in every note. Each type has a page in the sidebar: its notes as a table, cards or a list, with
  filter, sort, group, editable cells, and views saved as a Bases (`.base`) file. A typed
  note shows its type's properties with the right editor (a relation picks a note of the right
  type), and the other side sees it: Sam's panel says "As attendees: Kickoff". Daily notes list
  what was made and changed that day. All plain, portable markdown.
- **Writing blocks (F28):** callouts that open and close (`> [!note]-`), coloured status labels
  (`:status[On track]{.green}`), a table of contents (`[TOC]`), `//` to pick a date, `:rocket`
  for emoji, a note's emoji icon, cover picture and wide page, and link cards for a web address
  on its own line, all plain Markdown.
- **Relationships (F27):** any note can say how it relates to another with AI-XF's relationships
  (Part of, Depends on, Supersedes, References…): **Add relationship** writes
  `part-of: "[[Onboarding]]"`, and the other note's side panel lists it the other way round
  (*Has part*). Pages of a guide say they're part of it, with no page tree.
- **Notes inside notes:** `![[Note]]` shows that note in place, and `![[Note#Heading]]` just that
  section, in Live Preview and reading view, three deep, with loops cut off. A link to a typed
  note on a line of its own shows as a card with its type and key properties (each type can turn
  cards off).
- **Weblinks:** a link shared from the iPhone (or ⌘K → Save a web link) becomes a Weblink note
  with the page's title, summary, site and picture, fetched safely by the server.
- **Tasks, bookmarks and mentions:** every `- [ ]` in the collection on one Tasks page (open or done,
  by note or by due date, ticked in place); bookmarks at the top of your sidebar; the side panel
  lists notes that mention this one without linking, with one-click Link; the file tree sorts by
  name, last changed or newest. Following a link to a missing note asks whether it's a plain note
  or one of your types.
- **Links:** backlinks, outgoing links (with one-tap creation of notes that don't exist yet), an
  outline, and renames that rewrite every `[[link]]` pointing at the note.
- **The graph** (after Capacities): notes show their type's icon and colour, and links from
  properties carry the property's name (*attendees*). The side panel's Graph tab centres on the
  open note, with Show more and Show less, and follows you. The page can show the whole collection, one
  note's neighbourhood, or a type, folder, tag or saved search. It has filters (only or hide types,
  daily notes, busy notes, unlinked notes, simplified), zoom, find, and a PNG export. A
  timeline under the graph shows notes by date: drag a range, or press Play to watch the collection grow
  month by month.
- **Search:** Postgres full-text and fuzzy title search, plus pgvector semantic search over
  heading-sized chunks, fused with Reciprocal Rank Fusion. `tag:x` and `path:x` filters work, and
  a Related panel shows the notes nearest in meaning.
- **Folders:** create folders and subfolders from the sidebar, including empty ones (shared with
  every member). Drag notes and folders onto a folder, or onto empty space for the
  top level (on a phone, press and hold, then drag). Rename or move a folder with everything
  inside; an empty folder can be deleted. Empty folders survive export and import.
- **Import and export:** a folder of Markdown files from any editor, a `.zip` of one, or loose `.md` files.
  Dot-folders (app settings, `.trash/`) are skipped, and CRLF line endings and BOMs are cleaned. Exports are
  per note (`.md`) or per collection (`.zip`).
- **Version history:** a snapshot is taken every ten minutes of editing, and before every import
  overwrite and restore. An agent's or GitHub's burst of changes keeps the version before the
  first, and each note keeps its newest 100 versions.
- **Trash:** deleted notes keep their history and can be restored for 30 days.
- **Storage guard:** the database disk is a fixed size (`DB_DISK_GB`, default 1). At 80% admins
  are told; at 90% new notes, files, imports and agents' edits are refused with a message saying
  why, while typing in open notes carries on, so the disk never fills (Render suspends a full
  database). A note is at most 5 MB.
- **Backups:** `GET /api/backup` with `Authorization: Bearer $BACKUP_TOKEN` returns every collection
  as markdown plus history, members and Trash as JSON; `.github/workflows/backup.yml` (in a private repository only: anyone who can read a repository can download its artifacts) fetches it
  daily and keeps 14 days of copies as workflow artifacts. The zip is streamed, so its size
  isn't limited by the server's memory. `bun scripts/restore.ts backup.zip --owner you@example.com`
  (with `DATABASE_URL` set) restores it: notes, files, folders, history and Trash, with members
  whose accounts exist. Not in a backup, by design: passwords, AI keys and GitHub tokens, and
  GitHub collection links (a GitHub collection restores as a plain collection).
- **Bring your own AI:** add an assistant with your own Anthropic, OpenAI, relaxAI (UK
  datacentre, billed in £) or OpenAI-compatible key (`/boyai`). Every conversation shows what it
  cost in £, and each assistant has a daily £ limit (£1 unless you change it), checked before
  every call against a ledger; list prices live in `src/prices.ts`. Type `@Claude` in a note to talk to it under that line, or press `⌘J` for the
  AI side panel. It works as a librarian (searches and answers with links to your notes), an
  author (makes pages from what it finds) and an organiser (reformats, sets properties, moves,
  splits, copies or moves notes to another collection). Changes to the open note happen live and are kept in Version history; anything else
  (a new page, another note, a move) shows a diff to **Apply** or **Discard**, with Undo after.
  It can also drive the app (open a note, show the graph, hide the file panel), and it knows your
  types: it files notes into them with their properties filled in, proposes a new type when
  several notes are the same kind of thing, and merges duplicates. Keys are stored
  encrypted (`SECRETS_KEY`) and never shown again or shared. **The web**, if you allow an
  assistant it and turn it on in a conversation (the globe): it reads public pages and, with
  your own Brave Search key, searches. A search or page whose words you didn't type yourself
  asks you first, showing exactly what would go out, and after any web request every change
  asks too.
- **Publish a collection as a website** (Settings → Website, owners): the whole collection or chosen
  folders become pages at `/p/<site>/`, with `[[links]]` between them, pictures, callouts and
  tasks (pages run no script, so a Mermaid diagram shows as its source, and Dataview results are
  worked out at Publish from the published notes only); a note with `publish: false` stays out, and a link to a note that isn't published shows
  as plain words. Publishing takes a copy, so your edits stay private until you publish again;
  Settings lists what a republish would add, change or take down. Features to switch on, with a
  preview of the pages beside them: a page list, contents, backlinks, tag pages, last-updated
  dates, reading time and a light and dark switch. Unlisted (search engines are
  asked to leave it out), and taking it down has an Undo. The choice is kept in `publish.json`,
  so it goes with an export or a GitHub repo.
- **GitHub collections:** open a repository of markdown (or one folder of it, such as `docs/`) as a
  collection with your own fine-grained token. Notes, pictures and canvases are copied in; code,
  app settings folders (dot-folders) and everything else stay on GitHub, untouched. Your edits are a branch: a bar at
  the top says which branch and how many notes changed, **Review changes** shows each one's diff
  against GitHub with a Revert, and **Open pull request** sends them as one commit on a new
  branch with a PR (later edits are more commits on it). **Update from main** brings in newer
  work: unchanged notes update in place, notes changed on both sides merge line by line, and a
  real clash waits for you to pick a side. **Cancel the branch** puts every note back. An owner
  can also have changes sent on their own (Settings → This collection): a pull request every hour, day
  or week; each note pushed to the branch once it goes quiet; or straight onto a branch, `main`
  included, with no PR. Automatic sends merge first and pause on a clash, leave out notes held
  back in Review changes, and say in the bar what's next and whose token sends. Unless an owner
  chooses that last way, nothing reaches `main` without a pull request.
- **Works offline:** a service worker keeps the app and what it needs to open, and every note you
  open is kept on the device (its CRDT state in IndexedDB), so the home-screen app opens with no
  signal, notes take edits, and they merge when it reconnects. Signing out forgets it all.
- **Guided tour:** a minute's walk round the screen, a step at a time, pointing at each part
  (laptop and iPhone paths), offered once on the home page and again from ⌘K; **What's new**
  shows what's been added since this device last looked.
- **Panels you can size:** drag the inner edge of the file panel or the side panel; double-click
  puts it back. A full-width editor (the ↔ button, ⌘K or Settings) lets notes fill the space
  between the panels, following them as they change.
- **Phone-ready:** drawers instead of side panels, a header that tucks away as you scroll, a formatting bar above the keyboard, safe-area
  insets, dark mode, and installable to the home screen.
