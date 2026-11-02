// The tour (first-run welcome): a few ordinary notes in Tour/ that teach Commonplace by being
// used, added only when someone asks for it from an empty vault's home. Nothing special about
// them: edit them, link to them, and delete the folder when done.

import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { createNote, findByPath } from "./notes";
import { STARTERS, starterNote, TYPES_FOLDER } from "./types";

const NOTES: [string, string][] = [
  [
    "Tour/Start here.md",
    `---
tags: [tour]
status: reading
---
# Start here

DO Notes keeps notes as plain markdown, so everything here opens anywhere.
Above this line are **properties**: click one to change it.

## Find your way
- **⌘O** finds a note by name, or makes one.
- **⌘K** lists everything you can do. Try typing "focus mode".
- Type **/** at the start of a line for headings, lists, tables and more.

## Try it now
- [ ] Tick this box
- [ ] Link to another note: type \`[[\` and pick [[Links and backlinks]]
- [ ] Make a note of a kind of thing: read [[Things, not files]]
- [ ] Look at [[Writing well]] for the quieter tools

For a walk round the screen itself, use ⌘K → **Take the tour**.

When you're done, delete the Tour folder: these are ordinary notes.
`,
  ],
  [
    "Tour/Links and backlinks.md",
    `# Links and backlinks

Write \`[[\` and a note's name to link to it. If the note doesn't exist yet, following the link
makes it. Every note lists the notes that link to it under **Backlinks**, in the side panel, so
connections work in both directions without filing anything twice.

Tags such as #tour gather notes about a subject, across folders and types.

You can show part of another note in place with an embed:

![[Start here#Find your way]]
`,
  ],
  [
    "Tour/Things, not files.md",
    `# Things, not files

A note can be a **thing** with a type: a Person, a Book, a Project. Its type gives it a shape
(the properties above its text) and a page that lists every note of that type as a table.

[[Ada Lovelace]] is a Person: open her and look above the title. **Person** in the sidebar
lists everyone.

To make one from a line in any note, put the cursor on the line and use ⌘K → "Turn into a
typed note…". Try it on this line: Charles Babbage
`,
  ],
  [
    "Tour/Ada Lovelace.md",
    `---
type: Person
role: Friend
---
# Ada Lovelace

Wrote the first published program, for [[Charles Babbage]]'s Analytical Engine.

## Notes
`,
  ],
  [
    "Tour/Writing well.md",
    `# Writing well

- **Focus mode** (⌘K → "Focus mode") hides everything but the text and keeps your line in the
  middle of the screen. Escape leaves it.
- **Version history** (⋯ → Version history) keeps earlier versions and shows what restoring
  one would change.
- **Search** finds words and meaning; **Save** keeps a search in the sidebar.
- **Today** opens a daily note, for whatever doesn't have a home yet.
- With your own AI key (Settings → AI assistants), type **@** and an assistant's name to ask it
  about this note.
`,
  ],
];

/** Add the tour to a vault (its notes, and the Person type if the vault has none); returns the
 *  "Start here" note's id. Already there: just returns it. */
export async function addTour(vaultId: number, user: User): Promise<{ id: number }> {
  const start = await findByPath(vaultId, NOTES[0]![0]);
  if (start) return { id: start.id };
  const [{ n }] = (await sql`select count(*)::int as n from notes where vault_id = ${vaultId}`) as any;
  if (n > 50) throw new HttpError(400, "The tour is for a new collection");
  if (!(await findByPath(vaultId, `${TYPES_FOLDER}/Person.md`))) await createNote(vaultId, user.id, `${TYPES_FOLDER}/Person.md`, starterNote(STARTERS.find((s) => s.name === "Person")!)).catch(() => {});
  let first = 0;
  for (const [path, content] of NOTES) {
    const made = await createNote(vaultId, user.id, path, content);
    if (!first) first = made.id;
  }
  return { id: first };
}
