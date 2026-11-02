// Pure logic from src/ and web/lib/: markdown parsing (frontmatter, tags, links,
// paths, chunking), Yjs text diffs (the offline-merge regression test), hash embeddings, search
// query parsing, file-tree moves, frontmatter property edits, templates and daily notes, line
// diffs, AI prices, starter types, tables and colours. No database or network needed.

import { describe, expect, test } from "bun:test";
import * as Y from "yjs";
import { chunkNote, extractLinks, extractTags, findWikiLinks, headings, normalisePath, plainInline, normaliseTarget, parseFrontmatter, rewriteWikiLinks, titleFromPath } from "../src/markdown";
import { applyTextDiff, loadDoc, rebaseStoredDoc } from "../src/ydoc";
import { deleteProp, minimalChange, readProps, renameProp, setProp } from "../web/lib/frontmatter";
import { allFolders, moveDestinations, moveTarget } from "../web/lib/move";
import { toggleTask } from "../web/lib/render";
import { hashEmbed } from "../src/embed";
import { parseQuery } from "../src/search";

describe("frontmatter", () => {
  test("parses YAML and returns the body", () => {
    const fm = parseFrontmatter("---\ntitle: Hi\ntags: [a, b]\n---\n# Body\n");
    expect(fm.data).toEqual({ title: "Hi", tags: ["a", "b"] });
    expect(fm.body).toBe("# Body\n");
  });
  test("malformed YAML contributes nothing but keeps the body", () => {
    const fm = parseFrontmatter("---\n: : bad\n  - [\n---\ntext");
    expect(fm.data).toEqual({});
    expect(fm.body).toBe("text");
  });
  test("no frontmatter", () => expect(parseFrontmatter("plain").body).toBe("plain"));
});

describe("tags", () => {
  test("inline and frontmatter, lower-cased, nested, deduplicated", () => {
    const md = "---\ntags: [Project, area/home]\n---\nSome #project and #idea/sub, not a #123 or a url http://x.com/#frag\n";
    expect(extractTags(md)).toEqual(["area/home", "idea/sub", "project"]);
  });
  test("ignores headings and code", () => {
    expect(extractTags("# Heading\n`#nope`\n```\n#also-nope\n```\n#yes")).toEqual(["yes"]);
  });
  test("frontmatter tag string form", () => expect(extractTags("---\ntags: one, two\n---\n")).toEqual(["one", "two"]));
});

describe("links", () => {
  test("wikilinks with aliases, headings, embeds", () => {
    const md = "See [[Alpha]], [[Projects/Beta#Goals|the plan]] and ![[Gamma]] and ![[pic.png]]";
    expect(extractLinks(md).sort()).toEqual(["alpha", "gamma", "projects/beta"]);
    const ls = findWikiLinks(md);
    expect(ls[1]).toMatchObject({ target: "Projects/Beta#Goals", alias: "the plan", embed: false });
  });
  test("in a table, an aliased link's pipe is written \\| and still ends the target", () => {
    const md = "| a | b |\n| - | - |\n| [[Alpha\\|first]] | [[Projects/Beta#Goals\\|the plan]] |";
    expect(extractLinks(md).sort()).toEqual(["alpha", "projects/beta"]);
    expect(findWikiLinks(md)[0]).toMatchObject({ target: "Alpha", alias: "first" });
    expect(plainInline("[[Alpha\\|first]]")).toBe("first");
  });
  test("relative markdown links count, external ones don't", () => {
    expect(extractLinks("[a](Notes/Delta.md) [b](https://x.com) [c](#top) [d](img.png)")).toEqual(["notes/delta"]);
  });
  test("links inside code are ignored", () => expect(extractLinks("`[[nope]]`\n```\n[[nope2]]\n```")).toEqual([]));
  test("normaliseTarget", () => {
    expect(normaliseTarget("./Folder/My%20Note.md#H^b")).toBe("folder/my note");
  });
  test("rewrite keeps alias and heading", () => {
    const out = rewriteWikiLinks("x [[Old]] [[old#H|alias]] ![[Old]] [[Other]]", (t) => t === "old", "New");
    expect(out).toBe("x [[New]] [[New#H|alias]] ![[New]] [[Other]]");
  });
});

describe("paths", () => {
  test("normalise", () => {
    expect(normalisePath("/a//b/ c ")).toBe("a/b/c.md");
    expect(normalisePath("a\\b.md")).toBe("a/b.md");
    expect(normalisePath("img.png", null)).toBe("img.png");
  });
  test("refuses escapes", () => {
    expect(() => normalisePath("../etc/passwd")).toThrow();
    expect(() => normalisePath("")).toThrow();
  });
  test("title", () => expect(titleFromPath("A/B/Note.md")).toBe("Note"));
});

describe("chunking", () => {
  test("splits by heading and labels chunks", () => {
    const body = "intro para that is long enough ".repeat(10) + "\n## One\n" + "a ".repeat(400) + "\n## Two\n" + "b ".repeat(400);
    const chunks = chunkNote("Doc", body);
    expect(chunks.length).toBe(3);
    expect(chunks[1]!.body.startsWith("Doc › One")).toBe(true);
  });
  test("hard-splits a giant paragraph", () => {
    const chunks = chunkNote("Big", "x".repeat(5000), 1800);
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) expect(c.body.length).toBeLessThan(1900);
  });
  test("empty note yields nothing to embed", () => expect(chunkNote("E", "").length).toBe(0));
  test("headings", () => expect(headings("# A\ntext\n## B\n```\n# not\n```").map((h) => h.text)).toEqual(["A", "B"]));
  test("outline headings are plain text", () => {
    expect(headings("### New **bold** [[Contractors]]")[0]!.text).toBe("New bold Contractors");
    expect(plainInline("[[Smith & Sons|builders]] and [site](https://x.com)")).toBe("builders and site");
    expect(plainInline("*Plan* for `v2` ==now== ~~old~~ _x_")).toBe("Plan for v2 now old x");
    expect(plainInline("[[Plans#Budget]]")).toBe("Plans › Budget");
    expect(plainInline("snake_case_name and 2*3*4")).toBe("snake_case_name and 2*3*4");
  });
});

describe("tasks", () => {
  test("toggles the n-th task, skipping code", () => {
    const md = "- [ ] one\n```\n- [ ] code\n```\n- [x] two\n  - [ ] three";
    expect(toggleTask(md, 1)).toBe("- [ ] one\n```\n- [ ] code\n```\n- [ ] two\n  - [ ] three");
    expect(toggleTask(md, 2)).toContain("  - [x] three");
    expect(toggleTask(md, 9)).toBeNull();
  });
});

describe("yjs text diffs", () => {
  test("applyTextDiff converges and preserves untouched history", () => {
    const doc = new Y.Doc();
    const t = doc.getText("content");
    t.insert(0, "hello world");
    applyTextDiff(t, "hello brave world");
    expect(t.toString()).toBe("hello brave world");
    applyTextDiff(t, "");
    expect(t.toString()).toBe("");
  });
  test("never leaves a lone surrogate at either end of the change", () => {
    const doc = new Y.Doc();
    const t = doc.getText("content");
    t.insert(0, "a\u{1D400}b"); // 𝐀 = D835 DC00
    applyTextDiff(t, "a\u{1F400}b"); // 🐀 = D83D DC00 (same low surrogate)
    expect(t.toString()).toBe("a\u{1F400}b");
  });
  test("an offline client's edit merges cleanly with a server-side rebase", () => {
    // Server and client share a history...
    const server = loadDoc("line one\nline two\n", null);
    const client = new Y.Doc();
    Y.applyUpdate(client, Y.encodeStateAsUpdate(server));
    // ...client edits offline while the server applies a REST overwrite as a diff.
    client.getText("content").insert(0, "CLIENT ");
    const rebased = rebaseStoredDoc(server.getText("content").toString(), Y.encodeStateAsUpdate(server), "line one\nline two\nserver line\n");
    const reloaded = loadDoc("line one\nline two\nserver line\n", rebased);
    Y.applyUpdate(reloaded, Y.encodeStateAsUpdate(client));
    Y.applyUpdate(client, Y.encodeStateAsUpdate(reloaded));
    expect(reloaded.getText("content").toString()).toBe("CLIENT line one\nline two\nserver line\n");
    expect(client.getText("content").toString()).toBe(reloaded.getText("content").toString());
  });
});

describe("hash embeddings", () => {
  test("unit length, deterministic, similar texts closer", () => {
    const a = hashEmbed("postgres vector database search");
    const b = hashEmbed("vector search in a postgres database");
    const c = hashEmbed("gardening tomatoes in spring");
    const dot = (x: number[], y: number[]) => x.reduce((s, v, i) => s + v * y[i]!, 0);
    expect(a.length).toBe(1024);
    expect(Math.abs(dot(a, a) - 1)).toBeLessThan(1e-9);
    expect(dot(a, b)).toBeGreaterThan(dot(a, c));
    expect(hashEmbed("x y")).toEqual(hashEmbed("x y"));
  });
});

describe("search query parsing", () => {
  test("tag and path filters", () => {
    expect(parseQuery("deploy tag:Work #infra path:Projects/x")).toEqual({ text: "deploy", tags: ["work", "infra"], path: "Projects/x" });
  });
});

describe("moveTarget (drag and drop in the file tree)", () => {
  const note = (path: string) => ({ kind: "note" as const, id: 1, path });
  const folder = (path: string) => ({ kind: "folder" as const, path });
  test("a note moves into a folder, or back to the root", () => {
    expect(moveTarget(note("Inbox/Idea.md"), "Projects")).toBe("Projects/Idea.md");
    expect(moveTarget(note("Inbox/Idea.md"), "Projects/Kitchen")).toBe("Projects/Kitchen/Idea.md");
    expect(moveTarget(note("Inbox/Idea.md"), "")).toBe("Idea.md");
  });
  test("dropping where it already is does nothing", () => {
    expect(moveTarget(note("Inbox/Idea.md"), "Inbox")).toBeNull();
    expect(moveTarget(note("Inbox/Idea.md"), "inbox")).toBeNull();
    expect(moveTarget(note("Idea.md"), "")).toBeNull();
    expect(moveTarget(folder("Projects/Kitchen"), "Projects")).toBeNull();
  });
  test("a folder moves with its name, never into itself", () => {
    expect(moveTarget(folder("Projects/Kitchen"), "Archive")).toBe("Archive/Kitchen");
    expect(moveTarget(folder("Projects/Kitchen"), "")).toBe("Kitchen");
    expect(moveTarget(folder("Projects"), "Projects")).toBeNull();
    expect(moveTarget(folder("Projects"), "Projects/Kitchen")).toBeNull();
    expect(moveTarget(folder("Projects"), "projects/kitchen")).toBeNull();
    // A sibling that merely shares a prefix is a valid target.
    expect(moveTarget(folder("Pro"), "Projects")).toBe("Projects/Pro");
  });
  test("Move to… lists every folder, stored or implied, except where it is and inside itself", () => {
    const fs = allFolders(["Projects/Kitchen/Plan.md", "Inbox.md", "recipes/Cake.md"], ["Archive", "Projects", "Recipes"]);
    expect(fs).toEqual(["Archive", "Projects", "Projects/Kitchen", "Recipes"]); // case-insensitive, stored spelling wins
    expect(moveDestinations(note("Projects/Kitchen/Plan.md"), fs)).toEqual(["", "Archive", "Projects", "Recipes"]);
    expect(moveDestinations(folder("Projects"), fs)).toEqual(["Archive", "Recipes"]);
    expect(moveDestinations(note("Inbox.md"), fs)).toEqual(fs);
  });
});

describe("frontmatter properties (editing in place)", () => {
  const src = 'tags: [home, work]   # kept exactly\nstatus: open\n"due date": 2026-10-10\ndone: false\nbudget: 18000\nlist:\n  - a\n  - b\n# trailing comment';
  test("reads properties with their types", () => {
    expect(readProps(src)!.map((p) => [p.key, p.type, p.value])).toEqual([
      ["tags", "list", ["home", "work"]],
      ["status", "text", "open"],
      ["due date", "date", "2026-10-10"],
      ["done", "checkbox", false],
      ["budget", "number", 18000],
      ["list", "list", ["a", "b"]],
    ]);
    expect(readProps("a: [unclosed")).toBeNull();
    expect(readProps("")).toEqual([]);
    expect(readProps("nested:\n  x: 1")![0]).toMatchObject({ key: "nested", readOnly: true });
  });
  test("setting one property leaves every other line byte-for-byte", () => {
    const out = setProp(src, "status", "done");
    expect(out.split("\n").filter((l, i) => l !== src.split("\n")[i])).toEqual(["status: done"]);
    expect(setProp(src, "done", true)).toContain("\ndone: true\n");
    expect(setProp(src, "due date", "2026-11-01")).toContain('\n"due date": 2026-11-01\n');
  });
  test("lists keep their style: flow stays flow, block stays block", () => {
    expect(setProp(src, "tags", ["home", "work", "garden"]).split("\n")[0]).toBe("tags: [home, work, garden]");
    expect(setProp(src, "list", ["a"])).toContain("list:\n  - a\n# trailing comment");
    expect(setProp(src, "list", [])).toContain("\nlist:\n# trailing");
  });
  test("values that need quoting are quoted", () => {
    expect(setProp("", "title", "yes: no")).toBe('title: "yes: no"');
    expect(setProp("", "code", "18000")).toBe('code: "18000"');
    expect(setProp("", "empty", null)).toBe("empty:");
  });
  test("adding appends; deleting removes only that entry; renaming keeps the value text", () => {
    expect(setProp("a: 1\n\n", "b", "x")).toBe("a: 1\nb: x");
    expect(deleteProp(src, "list")).toBe('tags: [home, work]   # kept exactly\nstatus: open\n"due date": 2026-10-10\ndone: false\nbudget: 18000\n# trailing comment');
    expect(renameProp(src, "status", "state").split("\n")[1]).toBe("state: open");
    expect(renameProp(src, "tags", "labels").split("\n")[0]).toBe("labels: [home, work]   # kept exactly");
    expect(() => renameProp(src, "status", "done")).toThrow();
  });
  test("minimalChange finds the smallest replacement", () => {
    expect(minimalChange("status: open\nx", "status: done\nx")).toEqual({ from: 8, to: 12, insert: "done" });
    expect(minimalChange("same", "same")).toBeNull();
  });
});

describe("templates and daily notes", () => {
  const { addDays, dailyDate, dailyPath, dailyTemplatePath, fillTemplate, formatDate, isTemplate, splitTemplate } = require("../web/lib/templates") as typeof import("../web/lib/templates");
  const d = new Date(2026, 9, 11, 9, 5, 7); // Sunday 11 October 2026, 09:05:07

  test("Moment-style date formats, with [literal] text", () => {
    expect(formatDate(d, "YYYY-MM-DD HH:mm:ss")).toBe("2026-10-11 09:05:07");
    expect(formatDate(d, "dddd D MMMM YYYY")).toBe("Sunday 11 October 2026");
    expect(formatDate(d, "ddd Do MMM, h:mm a")).toBe("Sun 11th Oct, 9:05 am");
    expect(formatDate(new Date(2026, 0, 2), "Do [of] MMMM")).toBe("2nd of January");
    expect(formatDate(new Date(2026, 0, 23), "Do")).toBe("23rd");
    expect(formatDate(new Date(2026, 0, 12), "Do")).toBe("12th");
  });

  test("{{title}}, {{date}}, {{time}} and formats are filled; other braces are left alone", () => {
    const t = "# {{title}}\nCreated {{date}} at {{time}}\n{{date:dddd}} · {{ DATE : D MMM }}\n{{other}} {x}";
    expect(fillTemplate(t, { title: "Kitchen", date: d })).toBe("# Kitchen\nCreated 2026-10-11 at 09:05\nSunday · 11 Oct\n{{other}} {x}");
  });

  test("daily note paths, dates and the template's name", () => {
    expect(dailyPath(d)).toBe("Daily/2026-10-11.md");
    expect(dailyDate("Daily/2026-10-11.md")?.getDate()).toBe(11);
    expect(dailyDate("daily/2026-02-30.md")).toBeNull(); // no such day
    expect(dailyDate("Notes/2026-10-11.md")).toBeNull();
    expect(dailyPath(addDays(new Date(2026, 9, 31), 1))).toBe("Daily/2026-11-01.md");
    expect(dailyTemplatePath(["Templates/Meeting.md", "templates/Daily.md"])).toBe("templates/Daily.md");
    expect(dailyTemplatePath(["Templates/Daily note.md"])).toBe("Templates/Daily note.md");
    expect(isTemplate("Templates/Meeting.md")).toBe(true);
    expect(isTemplate("Projects/Templates.md")).toBe(false);
  });

  test("a template's frontmatter is split from its body", () => {
    expect(splitTemplate("---\ntags: [meeting]\n---\n# {{title}}\n")).toEqual({ yaml: "tags: [meeting]", body: "# {{title}}\n" });
    expect(splitTemplate("# Plain\n")).toEqual({ yaml: null, body: "# Plain\n" });
  });
});

describe("line diff (AI previews)", () => {
  const { lineDiff, diffStats } = require("../web/lib/diff");
  test("marks added and removed lines and folds unchanged runs", () => {
    const before = ["# Kitchen", "", "a", "b", "c", "d", "e", "f", "- tiles", "g"].join("\n");
    const after = ["# Kitchen", "", "a", "b", "c", "d", "e", "f", "| tiles |", "g"].join("\n");
    const d = lineDiff(before, after);
    expect(d[0]).toEqual({ kind: "gap", count: 6 });
    expect(d.filter((l: any) => l.kind !== "same" && l.kind !== "gap")).toEqual([
      { kind: "del", text: "- tiles" },
      { kind: "add", text: "| tiles |" },
    ]);
    expect(diffStats(d)).toBe("1 line added, 1 line removed");
  });
  test("a new note is all additions; no change says so", () => {
    expect(lineDiff("", "x\ny").filter((l: any) => l.kind === "add").length).toBe(2);
    expect(diffStats(lineDiff("same\n", "same\n"))).toBe("No change");
  });
});

describe("AI prices", () => {
  const { costOf, listPrice, pounds } = require("../src/prices");
  test("list prices in £, with cache reads at a tenth and writes at 1.25×", () => {
    expect(listPrice("relaxai", "DeepSeek-V4-Pro")).toEqual({ in: 1.17, out: 2.33 });
    expect(listPrice("anthropic", "claude-sonnet-5-5")).toEqual({ in: 1.5, out: 7.5 }); // $2/$10 at 0.75
    expect(listPrice("compatible", "anything")).toBeNull();
    const p = { in: 1, out: 10 };
    expect(costOf(p, { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 1_000_000 })).toBeCloseTo(1 + 1 + 0.1 + 1.25, 9);
    expect(pounds(0.001)).toBe("under 1p");
    expect(pounds(0.126)).toBe("£0.13");
  });
});

describe("starter types", () => {
  const { STARTERS, starterNeeds, starterNote, readTypeDef } = require("../src/types");
  test("each starter's note reads back as the same type, and links name the starters they need", () => {
    for (const s of STARTERS) {
      const def = readTypeDef(s.name, parseFrontmatter(starterNote(s)).data, { noteId: 1, path: `Types/${s.name}.md`, count: 0 });
      expect(def.properties.map((p: any) => [p.name, p.kind])).toEqual(s.shape.properties.map((p: any) => [p.name, p.kind]));
      expect(def.icon).toBe(s.shape.icon);
    }
    const by = (n: string) => STARTERS.find((s: any) => s.name === n);
    expect(starterNeeds(by("Meeting"))).toEqual(["Person", "Project"]);
    expect(starterNeeds(by("Person"))).toEqual(["Organisation"]);
    expect(starterNeeds(by("Book"))).toEqual([]);
  });

  test("the sets (F20) name real starters, every starter's icon can be picked, and links point at starters", () => {
    const { STARTER_SETS, TYPE_ICONS } = require("../src/types");
    for (const set of STARTER_SETS) for (const t of set.types) expect(STARTERS.some((s: any) => s.name === t)).toBe(true);
    expect(new Set(STARTERS.map((s: any) => s.name)).size).toBe(STARTERS.length);
    for (const s of STARTERS) {
      expect(TYPE_ICONS).toContain(s.shape.icon);
      for (const p of s.shape.properties) if (p.kind === "relation") expect(STARTERS.some((x: any) => x.name === p.type)).toBe(true);
    }
    expect(starterNeeds(STARTERS.find((s: any) => s.name === "Risk"))).toEqual(["Person", "Project"]);
  });

  test("the Architecture set covers every type Floe's folder-of-notes export writes", () => {
    const { STARTER_SETS } = require("../src/types");
    const arch = STARTER_SETS.find((s: any) => s.name === "Architecture").types.map((t: string) => t.toLowerCase());
    expect(arch.sort()).toEqual(["actor", "app", "component", "domain", "landscape", "store", "system"]);
    const system = STARTERS.find((s: any) => s.name === "System");
    const status = system.shape.properties.find((p: any) => p.name === "status");
    expect(status.options).toEqual(["live", "future", "deprecated", "removed"]);
    expect(system.shape.properties.map((p: any) => p.name)).toContain("floe-id");
  });
});

describe("tables as data (F8)", () => {
  const { parseTable, formatTable, setCell, addRow, addColumn, deleteColumn, deleteRow, setAlign, splitRow } = require("../web/lib/tableModel");
  const md = "| Item | Cost |\n|---|---:|\n| Units | £4,200 |\n| Worktops | £1,900 |";
  test("parses cells and alignment, and writes the pipes lined up", () => {
    const t = parseTable(md);
    expect(t).toEqual({ header: ["Item", "Cost"], align: [null, "right"], rows: [["Units", "£4,200"], ["Worktops", "£1,900"]] });
    expect(formatTable(t)).toBe("| Item     |   Cost |\n| -------- | -----: |\n| Units    | £4,200 |\n| Worktops | £1,900 |");
  });
  test("edits: a cell, rows and columns; pipes in a cell are escaped; short rows are filled", () => {
    let t = parseTable("a | b\n--|--\n1");
    expect(t.rows).toEqual([["1", ""]]);
    t = setCell(t, 0, 1, "x|y");
    t = addRow(t, 1);
    t = addColumn(t, 2);
    t = setCell(t, -1, 2, "c");
    t = setAlign(t, 2, "center");
    expect(formatTable(t)).toBe("| a   | b    |  c  |\n| --- | ---- | :-: |\n| 1   | x\\|y |     |\n|     |      |     |");
    expect(formatTable(deleteRow(deleteColumn(t, 0), 1))).toBe("| b    |  c  |\n| ---- | :-: |\n| x\\|y |     |");
    expect(splitRow("| `a|b` | c \\| d |")).toEqual(["`a|b`", "c \\| d"]);
    expect(parseTable("not | a table")).toBeNull();
  });
  test("move rows and columns; moves past the edge change nothing", () => {
    const { moveRow, moveColumn } = require("../web/lib/tableModel");
    const t = parseTable(md);
    expect(moveRow(t, 1, 0).rows.map((r: string[]) => r[0])).toEqual(["Worktops", "Units"]);
    expect(moveRow(t, 0, -1)).toBe(t);
    const m = moveColumn(t, 1, 0);
    expect(m.header).toEqual(["Cost", "Item"]);
    expect(m.align).toEqual(["right", null]);
    expect(m.rows[0]).toEqual(["£4,200", "Units"]);
    expect(moveColumn(t, 1, 2)).toBe(t);
  });
  test("sort by a column: amounts as numbers, words A to Z ignoring case and markup, empty cells last", () => {
    const { sortBy } = require("../web/lib/tableModel");
    const t = parseTable("| Name | Cost |\n|---|---|\n| **pear** | £1,200 |\n|  | 90 |\n| [[Apple]] | -5 |\n| banana |  |\n| Item 10 | 7.5% |\n| Item 9 | £1,200 |");
    expect(sortBy(t, 0, "asc").rows.map((r: string[]) => r[0])).toEqual(["[[Apple]]", "banana", "Item 9", "Item 10", "**pear**", ""]);
    expect(sortBy(t, 0, "desc").rows.map((r: string[]) => r[0])).toEqual(["**pear**", "Item 10", "Item 9", "banana", "[[Apple]]", ""]);
    // Equal values keep their order; the empty cell stays last both ways.
    expect(sortBy(t, 1, "asc").rows.map((r: string[]) => r[1])).toEqual(["-5", "7.5%", "90", "£1,200", "£1,200", ""]);
    expect(sortBy(t, 1, "asc").rows.filter((r: string[]) => r[1] === "£1,200").map((r: string[]) => r[0])).toEqual(["**pear**", "Item 9"]);
    expect(sortBy(t, 1, "desc").rows.map((r: string[]) => r[1])).toEqual(["£1,200", "£1,200", "90", "7.5%", "-5", ""]);
  });
  test("a range copied from a spreadsheet: a new table, or cells filled from where it's pasted", () => {
    const { parseGrid, tableFromGrid, pasteGrid } = require("../web/lib/tableModel");
    const grid = parseGrid('Firm\tPrice\r\nAcme\t100\r\n"Brick, ""& Co"""\t95\r\n');
    expect(grid).toEqual([["Firm", "Price"], ["Acme", "100"], ['Brick, "& Co"', "95"]]);
    expect(formatTable(tableFromGrid(grid))).toBe('| Firm          | Price |\n| ------------- | ----- |\n| Acme          | 100   |\n| Brick, "& Co" | 95    |');
    expect(parseGrid("plain text\nno tabs")).toBeNull();
    expect(parseGrid("a\tb\nc")).toBeNull(); // ragged
    // From Units' cost, two rows down and two columns across: a row and a column are added.
    const t = pasteGrid(parseTable(md), 0, 1, [["1", "x"], ["2", "y"], ["3", "z"]]);
    expect(t.header).toEqual(["Item", "Cost", ""]);
    expect(t.rows).toEqual([["Units", "1", "x"], ["Worktops", "2", "y"], ["", "3", "z"]]);
  });
});

describe("colours (F10)", () => {
  const { colourOf, safeColour, stripColour, wrapColour, hiloColour } = require("../web/lib/colours");
  test("only colour survives: palette colours become theme-aware classes, others a clean style", () => {
    expect(colourOf("mark", { style: "background: #FFF3A3A6;" })).toEqual({ classes: ["hl-yellow"], style: "" }); // Highlightr's yellow
    expect(colourOf("mark", { class: "hltr-pink" })).toEqual({ classes: ["hl-pink"], style: "" });
    expect(colourOf("font", { color: "#123456" })).toEqual({ classes: [], style: "color: #123456" });
    expect(colourOf("span", { style: "color: red; position: fixed; top: 0; background: url(javascript:alert(1))" })).toEqual({ classes: [], style: "color: red" });
    expect(colourOf("div", { style: "color: red" })).toEqual({ classes: [], style: "" });
    expect(safeColour("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(safeColour("expression(alert(1))")).toBeNull();
    expect(safeColour("var(--secret)")).toBeNull();
  });
  test("writing and removing: Highlightr-style marks, spans for text, Hilo read", () => {
    expect(wrapColour("tiles", "highlight", "yellow")).toBe('<mark style="background: #FFF3A3A6;">tiles</mark>');
    expect(wrapColour("late", "text", "red")).toBe('<span style="color: #D93025;">late</span>');
    expect(stripColour('a <mark style="background: #fff;">b</mark> <font color="red">c</font> <span class="x">d</span> =={green}e==')).toBe('a b c <span class="x">d</span> e');
    expect(hiloColour("{Red}urgent")).toEqual({ name: "red", text: "urgent" });
    expect(hiloColour("{nope}x")).toBeNull();
  });
});
