# Commonplace standalone

Commonplace as a single HTML file that edits a folder of Markdown files. No server, account or
database: open the file in a browser, choose a folder, and edit. Nothing is uploaded.

```sh
bun run standalone        # writes standalone/dist/commonplace.html (about 3.8 MB)
bun run test:standalone   # builds it and drives it in Chrome
```

## What it does

- The app's own editor (`web/components/Editor.tsx`): Live Preview, Source mode, edit-and-preview
  and reading view, the `/` menu, the formatting bar, folding, hover previews, the block handle,
  the properties panel, `[[wikilinks]]` (and `[[` completion), embeds, callouts, tables, Mermaid
  diagrams, Dataview queries and dataviewjs (run over the open folder; dataviewjs in a sandboxed
  frame, stopped if it loops forever), tasks, properties and tags.
- **Several folders at once**, each a collection: the select at the top of the file panel moves
  between them, opens another or closes one. Chrome and Edge remember the folders for the start
  screen.
- ⌘K offers the commands that work without a server (`offerOnly` in `App.tsx`); ⌘O opens a note
  by name; a link to a note that doesn't exist makes it, beside the note it was in.
- A file panel with folders, search across every note (words and `#tags`), a tag list, Tasks,
  bookmarks and saved searches (kept in the browser by the folder's name and the notes' paths).
- Today's note in `Daily/`, templates from `Templates/`, the graph, the Tasks page.
- Backlinks, outgoing links and the outline in the side panel.
- Pasted or dropped images are saved in `attachments/`, and `![[image.png]]` shows images from
  the folder.
- Rename, move and delete notes. Renaming updates links to the note, as the app does.
- Help (the ? beside the folder's name): the help pages that apply to the standalone file, with
  their pictures inside the file.

## Browsers

- **Chrome and Edge** open a real folder (the File System Access API) and write each change back
  to the file half a second after typing stops. The folders opened before can be reopened with
  one click.
- **Safari and Firefox** can't write to a folder, so the folder (or some files) is read into the
  tab and edits stay there. **Download changes** saves the changed notes as a zip to unzip over
  the folder. Closing the tab with changes not downloaded asks first.

Hidden folders (`.git`, app settings) and `node_modules` are skipped.

## How it's built

`build.ts` bundles `main.tsx` with Bun and inlines the script and stylesheet into one page. It
reuses the web client as it is (the editor, `web/lib/commands.ts`, the Graph and Tasks pages,
the dialogs in `web/ui/`, every stylesheet) and swaps `web/lib/api.ts` for `api-shim.ts`, so the
shared code that would ask the server reads the open folders instead. The editor edits a Yjs
document, as in the app; here each note's is made from its file and kept only in the tab. Opened
from disk, the page can't use the address bar for the app's paths, so the router keeps them in
memory (`keepInMemory` in `web/lib/router.ts`).

| File | What it is |
| --- | --- |
| `vault.ts` | The open folders: notes in memory, writes to disk, attachments as blob URLs, the remembered folders |
| `App.tsx` | Welcome screen, file panel, search, the note screen and side panel, the commands offered |
| `api-shim.ts` | Stands in for `web/lib/api.ts`: notes, Dataview, graph, tasks, bookmarks, saved searches, pictures |
| `search.ts` | Search over a folder's notes |

What needs the server stays in the full app: live collaboration, sharing, semantic search, the
assistant, history and Trash, types, the journal, publishing and GitHub collections. The guided
tour stays too: it walks through the app's screens.

The file includes open-source packages, each under its own licence. They're listed, with their
licence texts, in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md), and a comment at the top of the file links there.
