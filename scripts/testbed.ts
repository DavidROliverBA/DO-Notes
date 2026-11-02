// Writes the Testbed collection: a folder of a few hundred made-up notes that exercise most of
// Commonplace (types and relations, aliases and ids, daily notes, tasks, journal entries,
// embeds, queries, boards, pictures, notes already in AI-XF form, and awkward cases), for trying
// features against something bigger than the demos. The same every run (a seeded random).
//
//   bun scripts/testbed.ts <folder>        e.g. ~/Commonplace/Testbed (empty or missing)

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const out = process.argv[2];
if (!out) throw new Error("Usage: bun scripts/testbed.ts <folder>");
if (existsSync(out) && readdirSync(out).some((f) => !f.startsWith("."))) throw new Error(`${out} isn't empty`);

let seed = 20261031;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
const some = <T>(xs: readonly T[], n: number): T[] => [...new Set(Array.from({ length: n }, () => pick(xs)))];
const files: Record<string, string | Uint8Array> = {};
const put = (path: string, text: string | Uint8Array) => (files[path] = text);
const kebab = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
const yaml = (o: Record<string, unknown>) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => (Array.isArray(v) ? `${k}:\n${v.map((x) => `  - ${typeof x === "string" && x.startsWith("[[") ? `"${x}"` : x}`).join("\n")}` : `${k}: ${typeof v === "string" && v.startsWith("[[") ? `"${v}"` : v}`))
    .join("\n");
const note = (fm: Record<string, unknown>, body: string) => `---\n${yaml(fm)}\n---\n${body.trim()}\n`;
const day = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number) => new Date(d.getTime() + n * 86_400_000);

// ── types ──────────────────────────────────────────────────────────────────────────────────
put(
  "Types/Person.md",
  `---
icon: user
colour: blue
properties:
  - name: role
    kind: text
  - name: organisation
    kind: relation
    type: Organisation
  - name: email
    kind: text
  - name: met
    kind: date
---
# {{title}}

## Notes
`,
);
put(
  "Types/Organisation.md",
  `---
icon: building
colour: amber
properties:
  - name: kind
    kind: select
    options: [Supplier, Client, Partner, Council]
  - name: website
    kind: text
---
# {{title}}
`,
);
put(
  "Types/Project.md",
  `---
icon: briefcase
colour: purple
properties:
  - name: status
    kind: select
    options: [Idea, Active, Paused, Done]
  - name: owner
    kind: relation
    type: Person
  - name: people
    kind: relation
    type: Person
    many: true
  - name: depends-on
    kind: relation
    type: Project
    many: true
  - name: due
    kind: date
  - name: budget
    kind: number
---
# {{title}}

## Goal

## Tasks
`,
);
put(
  "Types/Meeting.md",
  `---
icon: calendar
colour: green
properties:
  - name: date
    kind: date
  - name: attendees
    kind: relation
    type: Person
    many: true
  - name: project
    kind: relation
    type: Project
---
# {{title}}

## Agenda

## Decisions

## Actions
`,
);
put(
  "Types/Book.md",
  `---
icon: book
colour: red
properties:
  - name: author
    kind: relation
    type: Person
  - name: status
    kind: select
    options: [To read, Reading, Read]
  - name: rating
    kind: number
  - name: finished
    kind: date
---
# {{title}}
`,
);

// ── organisations and people ───────────────────────────────────────────────────────────────
const ORGS = ["Harbour Builders", "Northgate Council", "Kestrel Timber", "Bluewater Plumbing", "Lumen Electrical", "Orchard Architects", "Fieldstone Quarry", "Copperleaf Design", "Saltmarsh Surveyors", "Wren & Partners"];
for (const o of ORGS)
  put(`Organisations/${o}.md`, note({ type: "Organisation", kind: pick(["Supplier", "Client", "Partner", "Council"]), website: `https://${kebab(o)}.example` }, `# ${o}\n\nWorked with since ${2019 + Math.floor(rand() * 7)}. #org/${kebab(o).split("-")[0]}`));

const FIRST = ["Sam", "Priya", "Tom", "Aisha", "Jonas", "Mei", "Oliver", "Fatima", "Ravi", "Hannah", "Kofi", "Elena", "Marcus", "Zoe", "Ibrahim", "Lucy", "Dev", "Grace", "Ewan", "Noor", "Callum", "Sofia", "Ben", "Yuki", "Liam", "Amara", "Finn", "Isla", "Arjun", "Chloé"];
const LAST = ["Okafor", "Shah", "Brennan", "Khan", "Lindqvist", "Chen", "Hart", "Rahman", "Patel", "Moore", "Mensah", "Rossi", "Webb", "Clarke", "Haddad", "Fraser", "Nair", "Liu", "Grant", "Aziz", "Doyle", "Costa", "Ward", "Tanaka", "Byrne", "Eze", "Walsh", "Reid", "Iyer", "Dubois"];
const ROLES = ["Site manager", "Architect", "Quantity surveyor", "Electrician", "Plumber", "Planning officer", "Joiner", "Designer", "Project lead", "Engineer"];
const PEOPLE = FIRST.map((f, i) => `${f} ${LAST[i]}`);
PEOPLE.forEach((p, i) => {
  const first = p.split(" ")[0]!;
  put(
    `People/${p}.md`,
    note(
      {
        type: "Person",
        role: pick(ROLES),
        organisation: `[[${pick(ORGS)}]]`,
        email: `${kebab(first)}@example.com`,
        met: day(addDays(new Date("2024-01-10"), Math.floor(rand() * 900))),
        // Some go by another name, and some have an id (F9).
        aliases: i % 4 === 0 ? [first] : i % 7 === 0 ? [`${first[0]}.${p.split(" ")[1]}`] : undefined,
        id: i % 3 === 0 ? kebab(p) : undefined,
      },
      `# ${p}\n\n${pick(["Prefers email.", "Call before 10.", "Knows the planning rules well.", "Usually on site Tuesdays.", "Good with old buildings."])} #people\n`,
    ),
  );
});

// ── projects ───────────────────────────────────────────────────────────────────────────────
const PROJECTS = ["Kitchen extension", "Loft conversion", "Garden office", "Roof repair", "Solar panels", "Heat pump", "Bathroom refit", "Driveway", "Garage conversion", "Window replacement", "Rewiring", "Planning application"];
PROJECTS.forEach((p, i) => {
  const deps = i > 2 ? some(PROJECTS.slice(0, i), 1 + (i % 2)) : [];
  const tasks = Array.from({ length: 3 + (i % 4) }, (_, t) => `- [${rand() < 0.4 ? "x" : " "}] ${pick(["Get three quotes", "Book the survey", "Order materials", "Check the drawings", "Ask the council", "Pay the deposit", "Confirm the start date", "Clear the space"])}${rand() < 0.5 ? ` 📅 ${day(addDays(new Date("2026-10-01"), Math.floor(rand() * 90)))}` : ""}${t === 0 ? ` with [[${pick(PEOPLE)}]]` : ""}`);
  put(
    `Projects/${p}.md`,
    note(
      { type: "Project", status: pick(["Idea", "Active", "Active", "Paused", "Done"]), owner: `[[${pick(PEOPLE)}]]`, people: some(PEOPLE, 3).map((x) => `[[${x}]]`), "depends-on": deps.length ? deps.map((d) => `[[${d}]]`) : undefined, due: day(addDays(new Date("2026-11-01"), i * 21)), budget: 1000 * (2 + Math.floor(rand() * 40)) },
      `# ${p}\n\n## Goal\n\n${pick(["More room for the family.", "Lower the energy bills.", "Fix it before winter.", "Somewhere quiet to work."])} See [[${pick(ORGS)}]] for the quote.\n\n## Tasks\n\n${tasks.join("\n")}\n\n## Notes ^notes\n\nThe budget is in the properties. #project/${kebab(p).split("-")[0]}`,
    ),
  );
});

// ── meetings ───────────────────────────────────────────────────────────────────────────────
for (let i = 0; i < 40; i++) {
  const d = addDays(new Date("2026-08-03"), i * 2 + Math.floor(rand() * 2));
  const project = pick(PROJECTS);
  const who = some(PEOPLE, 2 + Math.floor(rand() * 3));
  const title = `${day(d)} ${project}`;
  put(
    `Meetings/${title}.md`,
    note(
      { type: "Meeting", date: day(d), attendees: who.map((w) => `[[${w}]]`), project: `[[${project}]]` },
      `# ${project}: ${pick(["kick-off", "site visit", "quote review", "progress check", "snagging"])}\n\n## Agenda\n\n- Where we are on [[${project}]]\n- ${pick(["Costs", "Timing", "Permissions", "Materials"])}\n\n## Decisions\n\n- ${pick(["Go with the second quote.", "Wait for the survey.", "Start in the spring.", "Ask for a revised drawing."])}\n\n## Actions\n\n- [ ] [[${who[0]}]] to ${pick(["send the drawings", "chase the council", "price the timber", "book the skip"])} 📅 ${day(addDays(d, 7))}\n- [${rand() < 0.5 ? "x" : " "}] Update [[${project}#Tasks]]\n`,
    ),
  );
}

// ── daily notes, with journal entries ──────────────────────────────────────────────────────
for (let i = 0; i < 61; i++) {
  const d = addDays(new Date("2026-09-01"), i);
  if (rand() < 0.2) continue;
  const entries = Array.from({ length: 1 + Math.floor(rand() * 3) }, () => {
    const h = String(7 + Math.floor(rand() * 13)).padStart(2, "0");
    const m = String(Math.floor(rand() * 60)).padStart(2, "0");
    return `### ${h}:${m}\n\n${pick(["Rang", "Emailed", "Met", "Texted"])} [[${pick(PEOPLE)}]] about [[${pick(PROJECTS)}]]. ${pick(["Good news on the price.", "Delayed a week.", "Needs another visit.", "All agreed.", "Waiting to hear back."])}`;
  }).sort();
  put(`Daily/${day(d)}.md`, `# ${d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}\n\n- [${rand() < 0.6 ? "x" : " "}] ${pick(["Water the plants", "Pay the builder", "Measure the window", "Post the forms"])}\n- [ ] ${pick(["Call the bank", "Order the paint", "Read a chapter", "Check the forecast"])}\n\n## Journal\n\n${entries.join("\n\n")}\n`);
}

// ── books ──────────────────────────────────────────────────────────────────────────────────
const BOOKS = ["The Timber Frame House", "A Pattern Language", "Home Energy Basics", "Small Spaces", "The Repair Manual", "Light and Room", "Brick by Brick", "The Kitchen Garden", "Quiet Work", "Stone Walls", "The Shed Book", "Planning Made Plain", "Old Houses", "The Draught Proofer", "Garden Rooms"];
for (const b of BOOKS)
  put(`Books/${b}.md`, note({ type: "Book", author: `[[${pick(PEOPLE)}]]`, status: pick(["To read", "Reading", "Read", "Read"]), rating: 1 + Math.floor(rand() * 5), finished: rand() < 0.5 ? day(addDays(new Date("2025-06-01"), Math.floor(rand() * 400))) : undefined }, `# ${b}\n\n> ${pick(["Build for the light you have.", "Every room needs two sources of light.", "Measure twice.", "The roof is the house."])}\n\nRelevant to [[${pick(PROJECTS)}]]. #reading`));

// ── ideas: plain notes, links of every shape ───────────────────────────────────────────────
const IDEAS = ["Rainwater butt", "Green roof", "Wood burner", "Skylight", "Built-in shelves", "Bike store", "Hedgehog house", "Pond", "Workshop bench", "Underfloor heating", "Triple glazing", "Wildflower lawn", "Log store", "Outdoor tap", "Porch", "Bay window seat", "Pantry", "Boot room", "Café table", "日本の庭", "Herb spiral", "Compost bins", "EV charger", "Battery storage", "Shutters"];
IDEAS.forEach((t, i) => {
  const links = some([...IDEAS, ...PROJECTS], 3).filter((x) => x !== t);
  put(
    `Ideas/${t}.md`,
    `# ${t}\n\n${pick(["Saw one at the show.", "Would save money in the long run.", "Nice to have.", "Ask about planning first."])} Related: ${links.map((l, j) => (j === 1 ? `[[${l}|this one]]` : `[[${l}]]`)).join(", ")}.\n\n${i % 5 === 0 ? `See also [the project](../Projects/${encodeURIComponent(pick(PROJECTS))}.md).\n\n` : ""}#idea${i % 3 === 0 ? " #idea/outdoor" : ""}${i % 4 === 0 ? " #cost/high" : ""}\n`,
  );
});

// ── reference: embeds, block refs, callouts, tables, queries, diagrams, code ────────────────
put(
  "Reference/House facts.md",
  `# House facts

Built in 1932. Solid brick walls, a slate roof. ^built

## Rooms

| Room | Size (m²) | Floor |
| --- | --- | --- |
| Kitchen | 14 | Tile |
| Living room | 22 | Oak |
| Study | 8 | Carpet |

## Utilities

- Gas meter under the stairs.
- Stopcock in the kitchen, left of the sink. ^stopcock

> [!warning] Asbestos
> The garage roof may contain asbestos. Get it tested before [[Garage conversion]].
`,
);
put(
  "Reference/Embeds.md",
  `# Embeds

The house was ![[House facts#^built]]

Where's the stopcock? ![[House facts#^stopcock]]

The rooms: ![[House facts#Rooms]]

A whole note: ![[Rainwater butt]]

A picture: ![[attachments/plan.png]]
`,
);
put(
  "Reference/Queries.md",
  `# Queries

\`\`\`dataview
TABLE status, owner, due FROM "Projects" SORT due ASC
\`\`\`

\`\`\`dataview
TASK FROM "Projects" WHERE !completed
\`\`\`

\`\`\`mermaid
flowchart LR
  Survey --> Drawings --> Planning --> Build
\`\`\`

\`\`\`ts
// Code isn't a link: [[Not a link]] #not-a-tag
const total = budgets.reduce((a, b) => a + b, 0);
\`\`\`
`,
);

// ── notes already in AI-XF form (F9): ids, typed links, provenance ─────────────────────────
const AIXF = ["Damp survey", "Structural report", "Energy assessment", "Party wall notice", "Building regulations"];
AIXF.forEach((t, i) =>
  put(
    `AI-XF/${t}.md`,
    `---
type: Note
id: ${kebab(t)}
aliases:
  - ${t.split(" ")[0]} doc
links:
  - rel: ${pick(["depends-on", "supports", "related-to", "part-of"])}
    to: ${kebab(AIXF[(i + 1) % AIXF.length]!)}
  - rel: mentions
    to: ${kebab(pick(PEOPLE))}
verified: ${i % 2 === 0}
generated: 2026-10-${String(10 + i).padStart(2, "0")}
provenance:
  source: longview
  by: exporter
---
# ${t}

Exported from Longview. Refers to [[${kebab(AIXF[(i + 2) % AIXF.length]!)}]] by its id.
`,
  ),
);

// ── awkward cases ──────────────────────────────────────────────────────────────────────────
put("Edge cases/Empty.md", "");
put("Edge cases/Only properties.md", note({ status: "draft", tags: ["edge"] }, ""));
put("Edge cases/Plan.md", "# Plan (edge cases)\n\nThere's another note called Plan in Projects/Old. [[Plan]] is ambiguous.\n");
put("Projects/Old/Plan.md", "# Plan (old)\n\nThe first plan, kept for reference.\n");
put("Edge cases/Broken links.md", "# Broken links\n\n[[Nowhere]], [[Also missing|with an alias]], [[Kitchen extension#No such heading]], ![[missing.png]].\n");
put("Edge cases/Unicode — naïve façade.md", "# Unicode — naïve façade\n\nEmoji 🏠🔨, accents (café, naïve), CJK (日本の庭), RTL (مرحبا). Links: [[日本の庭]], [[Café table]].\n");
put("Edge cases/Long note.md", `# Long note\n\n${Array.from({ length: 300 }, (_, i) => `## Section ${i + 1}\n\nParagraph ${i + 1} mentions [[${PEOPLE[i % PEOPLE.length]}]] and #long.\n`).join("\n")}`);
put("Edge cases/Links to boards.md", "# Links to boards\n\nThe map: [[Project map.canvas]]. Not a board: [[Project map]].\n");
put("Edge cases/Same name as a person.md", note({ aliases: ["Sam"] }, "# Same name as a person\n\nThis note also goes by Sam, as Sam Okafor does. [[Sam]] is ambiguous.\n"));

// ── boards ─────────────────────────────────────────────────────────────────────────────────
const canvas = (nodes: object[], edges: object[]) => `{\n\t"nodes":[\n${nodes.map((n) => `\t\t${JSON.stringify(n)}`).join(",\n")}\n\t],\n\t"edges":[\n${edges.map((e) => `\t\t${JSON.stringify(e)}`).join(",\n")}\n\t]\n}`;
const map = PROJECTS.slice(0, 8);
put(
  "Boards/Project map.canvas",
  canvas(
    [
      { id: "g1", type: "group", label: "This year", x: -40, y: -80, width: 1400, height: 560 },
      ...map.map((p, i) => ({ id: `p${i}`, type: "file", file: `Projects/${p}.md`, x: (i % 4) * 340, y: Math.floor(i / 4) * 240, width: 300, height: 200, ...(i % 3 === 0 ? { color: String(1 + (i % 6)) } : {}) })),
      { id: "t1", type: "text", text: "**Budget**: keep under £60k in total", x: 0, y: 560, width: 320, height: 100 },
      { id: "l1", type: "link", url: "https://www.planningportal.co.uk", x: 400, y: 560, width: 320, height: 100 },
      { id: "b1", type: "file", file: "Boards/Ideas map.canvas", x: 760, y: 560, width: 320, height: 220 },
    ],
    map.slice(1).map((p, i) => ({ id: `e${i}`, fromNode: `p${i}`, fromSide: "right", toNode: `p${i + 1}`, toSide: "left", ...(i % 2 ? { label: "before" } : {}) })),
  ),
);
put(
  "Boards/Ideas map.canvas",
  canvas(
    [{ id: "root", type: "text", text: "# Outdoors", x: 0, y: 0, width: 220, height: 80 }, ...IDEAS.slice(0, 8).map((t, i) => ({ id: `i${i}`, type: "file", file: `Ideas/${t}.md`, x: 300 + (i % 2) * 320, y: -300 + i * 90, width: 280, height: 160 }))],
    IDEAS.slice(0, 8).map((_, i) => ({ id: `m${i}`, fromNode: "root", toNode: `i${i}` })),
  ),
);

// ── pictures (tiny real PNGs) and the home note ────────────────────────────────────────────
const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAGklEQVR4nGNgYGD4z8DAwMDAxMDAwMBAwAAAJk0DAeUeCxQAAAAASUVORK5CYII="), (c) => c.charCodeAt(0));
put("attachments/plan.png", png);
put("attachments/site photo.png", png);
put(
  "Home.md",
  `# Testbed

Made-up notes for trying Commonplace features: ${PEOPLE.length} people, ${ORGS.length} organisations, ${PROJECTS.length} projects, 40 meetings, two months of daily notes, ${BOOKS.length} books, ${IDEAS.length} ideas, notes in AI-XF form, awkward cases and two boards.

- Start with [[Project map.canvas]] or [[Kitchen extension]].
- Queries: [[Queries]]. Embeds: [[Embeds]].
- AI-XF: [[Damp survey]].

Regenerate with \`bun scripts/testbed.ts <empty folder>\`.
`,
);

for (const [path, data] of Object.entries(files)) {
  mkdirSync(dirname(join(out, path)), { recursive: true });
  writeFileSync(join(out, path), data);
}
console.log(`Wrote ${Object.keys(files).length} files to ${out}`);
