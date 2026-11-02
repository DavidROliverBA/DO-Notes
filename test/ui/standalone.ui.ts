// The standalone HTML file (standalone/): builds it, serves it, and drives it in Chrome against a
// folder in the browser's private file system (standing in for a folder picked from disk), then
// with files picked the way Safari and Firefox open them. Needs no database.
// Run: bun test --timeout 30000 ./test/ui/standalone.ui.ts

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Browser, type KeyInput, type Page } from "puppeteer-core";
import { chromePath } from "./chrome";

const ROOT = join(import.meta.dir, "..", "..");
const PORT = 3480;
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let page: Page;

const FILES: Record<string, string> = {
  "Welcome.md": "# Welcome\n\nSee [[Projects/Plan]] and [[Ideas]]. #start\n\n![[attachments/dot.svg]]\n",
  "Projects/Plan.md": "---\nstatus: active\n---\n# Plan\n\n- [ ] first step\n\nBack to [[Welcome]].\n",
  "Diagram.md": "# Diagram\n\n```mermaid\nflowchart LR\n  A[Start] --> B[Welcome]\n  class B internal-link\n```\n\n```mermaid\nnot a diagram\n```\n\nAfter.\n",
  "Board.md": '# Board\n\nOpen: `$= dv.pages("").where(p => p.status == "active").length`\n\n```dataview\nTABLE status AS "Status"\nFROM "Projects"\n```\n\n```dataview\nTASK FROM "Projects"\n```\n',
  "Log.md": '# Log\n\n```dataview\nCALENDAR date FROM "Logbook"\n```\n',
  "Logbook/Kickoff.md": "---\ndate: 2026-03-03\n---\nStarted.\n",
  "Logbook/Review.md": "---\ndate: 2026-03-10\n---\nReviewed.\n",
  "Script.md": '# Script\n\n```dataviewjs\nconst ps = dv.pages(\'"Logbook"\').sort((p) => p.date);\ndv.table(["Note", "Day"], ps.map((p) => [p.file.link, p.date.toFormat("d LLL")]));\ndv.taskList(dv.pages(\'"Projects"\').file.tasks);\nlet net = "open";\ntry { await fetch("https://example.com/"); } catch (e) { net = "blocked"; }\nlet cookie = "readable";\ntry { document.cookie; } catch (e) { cookie = "blocked"; }\nlet top = "reachable";\ntry { parent.document.title; } catch (e) { top = "blocked"; }\ndv.paragraph(`network ${net}, cookies ${cookie}, app ${top}`);\n```\n',
  "Chores.md": "# Chores\n\n- [ ] water the beans 📅 2026-11-01\n",
  "Templates/Meeting.md": "# {{title}}\n\nNotes from {{date}}.\n",
  "attachments/dot.svg": '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="5"/></svg>',
};

beforeAll(async () => {
  const build = Bun.spawnSync(["bun", join(ROOT, "standalone", "build.ts")]);
  if (build.exitCode !== 0) throw new Error(build.stderr.toString());
  const html = Bun.file(join(ROOT, "standalone", "dist", "commonplace.html"));
  server = Bun.serve({ port: PORT, fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) });
  browser = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

/** Fill the private file system with FILES and make the folder picker return it. */
async function freshFolder(p: Page) {
  await p.evaluate(async (files) => {
    const root = await navigator.storage.getDirectory();
    for await (const name of (root as any).keys()) await root.removeEntry(name, { recursive: true });
    for (const [path, text] of Object.entries(files)) {
      const parts = path.split("/");
      let d = root;
      for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part, { create: true });
      const w = await (await d.getFileHandle(parts.at(-1)!, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
    (window as any).showDirectoryPicker = async () => root;
  }, FILES);
}

const readFile = (p: Page, path: string) =>
  p.evaluate(async (path) => {
    const parts = path.split("/");
    let d = await navigator.storage.getDirectory();
    for (const part of parts.slice(0, -1)) d = await d.getDirectoryHandle(part);
    return (await (await d.getFileHandle(parts.at(-1)!)).getFile()).text();
  }, path);

/** Wait for `check` to hold, asking again every 100 ms (up to 5 s). */
async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 50; i++) {
    if (await check()) return;
    await Bun.sleep(100);
  }
  throw new Error("Timed out waiting");
}

const press = async (p: Page, key: KeyInput) => {
  await p.keyboard.down("Meta");
  await p.keyboard.press(key);
  await p.keyboard.up("Meta");
};

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

const clickText = (p: Page, selector: string, text: string) =>
  p.evaluate(
    (selector, text) => {
      const el = [...document.querySelectorAll<HTMLElement>(selector)].find((e) => e.textContent?.trim().includes(text));
      if (!el) throw new Error(`No ${selector} with ${text}`);
      el.click();
    },
    selector,
    text,
  );

describe("standalone, with a folder", () => {
  beforeAll(async () => {
    page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.goto(`http://localhost:${PORT}/`);
    await page.waitForSelector(".login-card");
    await freshFolder(page);
    await clickText(page, ".login-card button", "Open a folder");
    await page.waitForSelector(".sidebar .tree-row.note");
  });

  test("lists the notes and opens one", async () => {
    // The last changed note opens, with its folder.
    const rows = await page.$$eval(".tree-row", (r) => r.map((x) => x.textContent?.trim()));
    expect(rows).toContain("Projects");
    expect(rows).toContain("Welcome");
    await clickText(page, ".tree-row.note", "Welcome");
    await page.waitForSelector(".note-title");
    expect(await page.$eval(".note-title", (e) => e.textContent)).toBe("Welcome");
  });

  test("Live Preview shows the image from the folder", async () => {
    await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>(".cm-content img")].some((i) => i.src.startsWith("blob:") && i.naturalWidth > 0));
  });

  test("a wikilink opens its note, and backlinks show", async () => {
    await page.click(".cm-lp-link[data-target='Projects/Plan']");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Plan");
    const backlinks = await page.$$eval(".right-panel .link-list button", (b) => b.map((x) => x.textContent));
    expect(backlinks).toContain("Welcome");
  });

  test("typing is written to the file", async () => {
    await page.click(".cm-content");
    await page.keyboard.down("Meta");
    await page.keyboard.press("ArrowDown");
    await page.keyboard.up("Meta");
    await page.keyboard.type("\nAdded line.");
    await page.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("Saved to the folder"));
    expect(await readFile(page, "Projects/Plan.md")).toContain("Added line.");
  });

  test("an unresolved link makes the note in the same folder", async () => {
    await clickText(page, ".tree-row.note", "Welcome");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Welcome");
    await page.click(".cm-lp-link[data-target='Ideas']");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Ideas");
    expect(await readFile(page, "Ideas.md")).toBe("");
  });

  test("reading view renders, and a task ticks in the file", async () => {
    await clickText(page, ".tree-row.note", "Plan");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Plan");
    await page.click("button[aria-label='Reading view']");
    await page.waitForSelector(".preview input.task");
    await page.click(".preview input.task");
    await page.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("Saved to the folder"));
    await page.waitForFunction(() => (document.querySelector(".preview input.task") as HTMLInputElement | null)?.checked);
    expect(await readFile(page, "Projects/Plan.md")).toContain("- [x] first step");
    await page.click("button[aria-label='Live preview']");
  });

  test("search finds text and tags", async () => {
    await clickText(page, ".tabs button", "Search");
    await page.type(".search-panel input", "#start");
    await page.waitForSelector(".search-results a");
    expect(await page.$$eval(".search-results .hit-title", (h) => h.map((x) => x.textContent))).toEqual(["Welcome"]);
    await clickText(page, ".tabs button", "Files");
  });

  test("rename moves the file", async () => {
    await page.click(".title-button");
    await page.waitForSelector(".title-input");
    await page.$eval(".title-input", (i) => ((i as HTMLInputElement).value = ""));
    await page.type(".title-input", "Roadmap");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Roadmap");
    expect(await readFile(page, "Projects/Roadmap.md")).toContain("# Plan");
    expect(await readFile(page, "Projects/Plan.md").catch(() => "gone")).toBe("gone");
    // The link in Welcome follows it, as in the app.
    await page.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Updated the links in 1 note"));
    await until(async () => (await readFile(page, "Welcome.md")).includes("See [[Roadmap]] and"));
  });

  test("a rename that only changes case keeps the file", async () => {
    await page.click(".title-button");
    await page.waitForSelector(".title-input");
    await page.$eval(".title-input", (i) => ((i as HTMLInputElement).value = ""));
    await page.type(".title-input", "roadmap");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "roadmap");
    expect(await readFile(page, "Projects/roadmap.md")).toContain("# Plan");
  });

  test("a mermaid block draws as a diagram, in Live Preview and reading view", async () => {
    await clickText(page, ".tree-row.note", "Diagram");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Diagram");
    const drawn = (sel: string) =>
      page.waitForFunction((sel) => !!document.querySelector(sel)?.shadowRoot?.querySelector("svg .node"), { timeout: 15000 }, sel);
    await drawn(".cm-content .mermaid-diagram");
    // A diagram that doesn't parse says so, with its source.
    await page.waitForFunction(() => document.querySelector(".cm-content .mermaid-diagram.mermaid-failed")?.shadowRoot?.querySelector(".error")?.textContent?.includes("Diagram error"));
    await page.click("button[aria-label='Reading view']");
    await drawn(".preview .mermaid-diagram");
    // `class B internal-link`: the node opens its note.
    await page.evaluate(() => {
      const node = [...document.querySelector(".preview .mermaid-diagram")!.shadowRoot!.querySelectorAll<SVGElement>(".node.internal-link")].find((n) => n.textContent?.includes("Welcome"))!;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    });
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Welcome");
    await page.click("button[aria-label='Live preview']");
  });

  test("Dataview: a table, an inline count, a task ticked from the results, and a link", async () => {
    await clickText(page, ".tree-row.note", "Board");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Board");
    await page.waitForFunction(() => document.querySelector(".cm-content .dataview-block table td")?.textContent === "roadmap" || document.querySelector(".cm-content .dataview-block table td")?.textContent === "Roadmap", { timeout: 5000 });
    expect(await page.$$eval(".cm-content .dataview-block table th", (t) => t.map((x) => x.textContent))).toEqual(["File 1", "Status"]);
    expect(await page.$eval(".cm-content .dataview-inline", (e) => e.textContent)).toBe("1");
    // The task is in Projects/roadmap.md (renamed and ticked above): unticking it here unticks it there.
    expect(await page.$eval(".cm-content input.dv-task", (b) => (b as HTMLInputElement).checked)).toBe(true);
    await page.click(".cm-content input.dv-task");
    await page.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("Saved to the folder"));
    expect(await readFile(page, "Projects/roadmap.md")).toContain("- [ ] first step");
    await page.waitForFunction(() => (document.querySelector(".cm-content input.dv-task") as HTMLInputElement | null)?.checked === false);
    await page.click(".cm-content .dataview-block table a.internal-link");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent?.toLowerCase() === "roadmap");
  });

  test("Dataview CALENDAR: opens at the month with notes, moves between months, and lists a day's notes", async () => {
    await clickText(page, ".tree-row.note", "Log");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Log");
    const title = () => page.$eval(".cm-content .dv-cal-title", (e) => e.textContent);
    await page.waitForSelector(".cm-content .dv-calendar");
    expect(await title()).toBe("March 2026 2");
    expect(await page.$$eval(".cm-content .dv-cal-list li", (l) => l.map((x) => x.textContent))).toEqual(["Kickoff", "Review"]);
    await page.click('.cm-content [data-dv-day="2026-03-10"]');
    await page.waitForFunction(() => document.querySelectorAll(".cm-content .dv-cal-list li").length === 1);
    expect(await page.$eval(".cm-content .dv-cal-list", (e) => e.textContent)).toBe("Tuesday 10 March 2026Review");
    await page.click('.cm-content [aria-label="Next month"]');
    await page.waitForFunction(() => document.querySelector(".cm-content .dv-cal-title")?.textContent === "April 2026 0");
    expect(await page.$eval(".cm-content .dv-calendar .dv-empty", (e) => e.textContent)).toBe("Nothing in April 2026.");
    await page.click('.cm-content [aria-label="Previous month"]');
    await page.waitForFunction(() => document.querySelector(".cm-content .dv-cal-title")?.textContent === "March 2026 2");
    await page.click(".cm-content .dv-cal-list a.internal-link");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Kickoff");
  });

  test("dataviewjs runs sandboxed: draws, ticks a task, opens a note, and can't reach the network or the app", async () => {
    await clickText(page, ".tree-row.note", "Script");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Script");
    const handle = await page.waitForSelector(".cm-content iframe.dv-frame");
    expect(await handle!.evaluate((f) => f.getAttribute("sandbox"))).toBe("allow-scripts");
    const frame = (await handle!.contentFrame())!;
    await frame.waitForFunction(() => document.body.textContent?.includes("network"), { timeout: 8000 });
    expect(await frame.$$eval("table tbody tr", (r) => r.map((x) => x.textContent))).toEqual(["Kickoff3 Mar", "Review10 Mar"]);
    expect(await frame.$eval("#root", (e) => e.textContent)).toContain("network blocked, cookies blocked, app blocked");
    // The frame grows to what it drew.
    expect(await handle!.evaluate((f) => f.getBoundingClientRect().height)).toBeGreaterThan(150);
    // Its task box ticks the task in its note, through the app.
    const before = await readFile(page, "Projects/roadmap.md");
    await frame.click("input.dv-task");
    await page.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("Saved to the folder"));
    await page.waitForFunction(async (b) => {
      const d = await (await navigator.storage.getDirectory()).getDirectoryHandle("Projects");
      return (await (await d.getFileHandle("roadmap.md")).getFile()).text().then((t) => t !== b);
    }, {}, before);
    expect((await readFile(page, "Projects/roadmap.md")).includes("- [x] first step")).toBe(!before.includes("- [x] first step"));
    const again = (await (await page.waitForSelector(".cm-content iframe.dv-frame"))!.contentFrame())!;
    await again.waitForSelector("table a.internal-link");
    await again.click("table a.internal-link");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Kickoff");
  });

  test("Help shows the standalone pages, with their pictures inside the file", async () => {
    await page.click('.sidebar [aria-label="Help"]');
    await page.waitForSelector(".help-page h1");
    const topics = await page.$$eval(".help-nav button", (b) => b.map((x) => x.textContent));
    expect(topics).toEqual(["Help", "Writing notes", "Links and embeds", "Organising notes", "Finding things", "Queries and diagrams", "The standalone file", "Keyboard shortcuts"]);
    // A link to a page only the app's help has is plain words here.
    expect(await page.$$eval(".help-page a.internal-link", (a) => a.map((x) => x.getAttribute("data-target")))).not.toContain("getting-started.md");
    await clickText(page, ".help-nav button", "The standalone file");
    await page.waitForFunction(() => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>(".help-page img")];
      return imgs.length === 2 && imgs.every((i) => i.src.startsWith("data:image/webp") && i.complete && i.naturalWidth > 0);
    });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".help"));
  });

  test("⌘O opens a note by name", async () => {
    await page.keyboard.down("Meta");
    await page.keyboard.press("o");
    await page.keyboard.up("Meta");
    await page.waitForSelector(".switcher input");
    await page.type(".switcher input", "welc");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Welcome");
  });

  test("the app's editor: the / menu and the formatting bar", async () => {
    await clickText(page, ".tree-row.note", "Chores");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Chores");
    await page.click(".cm-content");
    await press(page, "ArrowDown");
    await page.keyboard.type("\n/head");
    await page.waitForFunction(() => document.querySelector(".cm-tooltip-autocomplete")?.textContent?.includes("Heading 1"));
    await Bun.sleep(150); // CodeMirror takes Enter for the menu a moment after it opens
    await page.keyboard.press("Enter");
    await page.keyboard.type("Garden");
    await until(async () => (await readFile(page, "Chores.md")).endsWith("\n# Garden"));
    for (let i = 0; i < 6; i++) await page.keyboard.down("Shift"), await page.keyboard.press("ArrowLeft"), await page.keyboard.up("Shift");
    await page.waitForSelector(".cm-format-bar", { visible: true });
    // Nothing from the server: no assistants after @.
    await page.keyboard.press("End");
    await page.keyboard.type("\n@");
    await Bun.sleep(300);
    expect(await page.$(".cm-tooltip-autocomplete")).toBeNull();
    await page.keyboard.press("Backspace");
  });

  test("⌘K offers what works here, and makes today's note", async () => {
    await press(page, "k");
    await page.waitForSelector(".palette input");
    // Server features aren't offered.
    const titles = await page.$$eval(".palette .palette-title", (t) => t.map((x) => x.textContent));
    expect(titles).toContain("Graph view");
    expect(titles).toContain("Bold");
    for (const t of ["Version history", "Settings", "Ask AI in the side panel", "Journal", "New journal entry", "Move to Trash", "Take the tour"]) expect(titles).not.toContain(t);
    await page.type(".palette input", "today's note");
    await page.waitForFunction(() => document.querySelector(".palette li.on .palette-title")?.textContent === "Today's note");
    await page.keyboard.press("Enter");
    const day = today();
    await page.waitForFunction((d) => document.querySelector(".note-title")?.textContent === d, {}, day);
    expect(await readFile(page, `Daily/${day}.md`)).toMatch(/^# \w+day /);
    expect(await page.$(".day-nav")).not.toBeNull();
  });

  test("a note from a template", async () => {
    await press(page, "k");
    await page.waitForSelector(".palette input");
    await page.type(".palette input", "new note from template");
    await page.waitForFunction(() => document.querySelector(".palette li.on .palette-title")?.textContent === "New note from template");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".choose-list");
    await clickText(page, ".choose-list li", "Meeting");
    await page.waitForSelector(".modal input[type=text], .modal input:not([type])");
    await page.keyboard.down("Meta");
    await page.keyboard.press("a");
    await page.keyboard.up("Meta");
    await page.keyboard.type("Standup");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Standup");
    expect(await readFile(page, "Standup.md")).toBe(`# Standup\n\nNotes from ${today()}.\n`);
  });

  test("a bookmark and a saved search in the file panel", async () => {
    await page.click(".note-actions button[aria-label='More']");
    await clickText(page, ".menu .menu-item", "Bookmark");
    await page.waitForFunction(() => [...document.querySelectorAll(".shortcuts .type-row")].some((b) => b.textContent === "Standup"));
    await clickText(page, ".tabs button", "Search");
    // Empty the box (it still has the last search), as React sees typing.
    await page.$eval(".search-panel input", (i) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(i, "");
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.type(".search-panel input", "beans");
    await page.click(".search-save");
    await clickText(page, ".tabs button", "Files");
    await page.waitForFunction(() => document.querySelector(".saved-search")?.textContent?.includes("beans"));
    // Kept in this browser, by the folder's name and the note's path.
    const kept = await page.evaluate(() => Object.fromEntries(Object.entries(localStorage).filter(([k]) => k.startsWith("cp-standalone-bookmarks") || k.startsWith("cp-standalone-searches"))));
    expect(Object.values(kept)).toEqual(expect.arrayContaining(['["Standup.md"]', '["beans"]']));
  });

  test("Tasks lists the folder's tasks, and ticking one writes its file", async () => {
    await clickText(page, ".shortcuts .type-row", "Tasks");
    await page.waitForFunction(() => [...document.querySelectorAll(".tasks-page .task-text")].some((t) => t.textContent === "water the beans"));
    await page.click(".tasks-page input[aria-label^='water the beans']");
    await until(async () => (await readFile(page, "Chores.md")).includes("- [x] water the beans"));
  });

  test("the graph draws the folder's notes and links", async () => {
    await clickText(page, ".sidebar-actions button", "Graph");
    await page.waitForSelector(".graph-stage [aria-label^='Graph of']");
    const label = await page.$eval(".graph-stage [aria-label^='Graph of']", (e) => e.getAttribute("aria-label")!);
    const [, notes, links] = /(\d+) notes and (\d+) links/.exec(label)!;
    expect(Number(notes)).toBeGreaterThan(10);
    expect(Number(links)).toBeGreaterThanOrEqual(2); // Welcome and the plan link to each other
  });
});

describe("standalone, with several folders", () => {
  test("opens two folders, switches between them, remembers them, and closes one", async () => {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.goto(`http://localhost:${PORT}/`);
    await p.waitForSelector(".login-card");
    await p.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of (root as any).keys()) await root.removeEntry(name, { recursive: true });
      const write = async (d: FileSystemDirectoryHandle, name: string, text: string) => {
        const w = await (await d.getFileHandle(name, { create: true })).createWritable();
        await w.write(text);
        await w.close();
      };
      const garden = await root.getDirectoryHandle("Garden", { create: true });
      const work = await root.getDirectoryHandle("Work", { create: true });
      await write(garden, "Beans.md", "# Beans\n\nSee [[Plan]].\n");
      await write(garden, "Plan.md", "# Garden plan\n");
      await write(work, "Plan.md", "# Work plan\n");
      await write(work, "Budget.md", "# Budget\n\nSee [[Plan]].\n");
      const queue = [garden, work];
      (window as any).showDirectoryPicker = async () => queue.shift();
    });
    const tree = () => p.$$eval(".tree-row.note", (r) => r.map((x) => x.textContent?.trim()).sort());
    await clickText(p, ".login-card button", "Open a folder");
    await p.waitForSelector(".tree-row.note");
    expect(await tree()).toEqual(["Beans", "Plan"]);

    // Open another: the welcome screen, with a way back, then the second folder.
    await p.select("select[aria-label='Collection']", "add");
    await p.waitForSelector(".login-card");
    expect(await p.$$eval(".login-card button", (b) => b.map((x) => x.textContent?.trim()))).toEqual(expect.arrayContaining(["Go to Garden", "Open another folder", "Back to Garden"]));
    await clickText(p, ".login-card button", "Open another folder");
    await p.waitForFunction(() => (document.querySelector("select[aria-label='Collection']") as HTMLSelectElement | null)?.selectedOptions[0]?.textContent === "Work");
    expect(await tree()).toEqual(["Budget", "Plan"]);
    expect(await p.$$eval("select[aria-label='Collection'] option", (o) => o.map((x) => x.textContent))).toEqual(["Garden", "Work", "Open another folder…", "Close Work"]);

    // A link finds the note in its own folder.
    await clickText(p, ".tree-row.note", "Budget");
    await p.click(".cm-lp-link[data-target='Plan']");
    await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Work plan"));

    // Back to Garden, at the note it was on, and typing there writes Garden's file.
    const gardenId = await p.$eval("select[aria-label='Collection'] option", (o) => (o as HTMLOptionElement).value);
    await p.select("select[aria-label='Collection']", gardenId);
    await p.waitForFunction(() => [...document.querySelectorAll(".tree-row.note")].some((r) => r.textContent === "Beans"));
    await clickText(p, ".tree-row.note", "Beans");
    await p.click(".cm-content");
    await press(p, "ArrowDown");
    await p.keyboard.type("Sown.");
    const readIn = (folder: string, name: string) =>
      p.evaluate(
        async (folder, name) => (await (await (await (await navigator.storage.getDirectory()).getDirectoryHandle(folder)).getFileHandle(name)).getFile()).text(),
        folder,
        name,
      );
    await until(async () => (await readIn("Garden", "Beans.md")).includes("Sown."));
    expect(await readIn("Work", "Budget.md")).not.toContain("Sown.");

    // Both are remembered for next time.
    await p.reload();
    await p.waitForSelector(".login-card");
    // The last opened first (the folder the tests above opened is on the list too, after them).
    await p.waitForSelector(".standalone-folders li");
    expect((await p.$$eval(".standalone-folders li button:first-child", (b) => b.map((x) => x.textContent?.trim()))).slice(0, 2)).toEqual(["Reopen Work", "Reopen Garden"]);
    await clickText(p, ".standalone-folders button", "Reopen Work");
    await p.waitForSelector(".tree-row.note");
    expect(await tree()).toEqual(["Budget", "Plan"]);

    // Closing the only open folder goes back to the welcome screen.
    await p.select("select[aria-label='Collection']", "close");
    await p.waitForSelector(".login-card");
    await p.close();
  }, 30000);
});

describe("standalone, with picked files", () => {
  test("edits stay in the tab and download as a zip", async () => {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.goto(`http://localhost:${PORT}/`);
    await p.waitForSelector(".login-card");
    const input = (await p.$("input[type=file][accept]"))!;
    const dir = mkdtempSync(join(tmpdir(), "cp-standalone-"));
    const note = join(dir, "standalone-note.md");
    await Bun.write(note, "# Picked\n\nText.\n");
    try {
      await input.uploadFile(note);
      await p.waitForSelector(".note-title");
      expect(await p.$eval(".note-title", (e) => e.textContent)).toBe("standalone-note");
      await p.click(".cm-content");
      await p.keyboard.type("More. ");
      await p.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("1 changed"));
      // Catch the download instead of saving it: its name, and the zip's first bytes.
      await p.evaluate(() => {
        HTMLAnchorElement.prototype.click = function () {
          (window as any).downloaded = fetch(this.href)
            .then((r) => r.arrayBuffer())
            .then((b) => ({ name: this.download, magic: [...new Uint8Array(b).slice(0, 2)] }));
        };
      });
      await p.click(".standalone-foot button");
      expect(await p.evaluate(() => (window as any).downloaded)).toEqual({ name: "Files changes.zip", magic: [0x50, 0x4b] });
      await p.waitForFunction(() => document.querySelector(".standalone-foot")?.textContent?.includes("No unsaved changes"));
    } finally {
      await Bun.file(note).delete();
      await p.close();
    }
  });
});

describe("standalone, with a large folder", () => {
  // A large vault: 3,500 notes in 870 folders with 7 links each. Typing once re-ran every
  // backlink lookup over the whole list (7.6 s a key); now it must keep up with typing.
  test("opens quickly and keeps up with typing", async () => {
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.goto(`http://localhost:${PORT}/`);
    await p.waitForSelector(".login-card");
    await p.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      for await (const name of (root as any).keys()) await root.removeEntry(name, { recursive: true });
      const N = 3500;
      const dirs: FileSystemDirectoryHandle[] = [];
      for (let i = 0; i < 870; i++) dirs.push(await (i < 30 ? root : dirs[i % 30]!).getDirectoryHandle(`Folder ${i}`, { create: true }));
      const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit. ".repeat(140);
      const jobs: Promise<void>[] = [];
      for (let i = 0; i < N; i++) {
        const links = Array.from({ length: 7 }, (_, k) => `[[Note ${(i * 7 + k * 131) % N}]]`).join(" ");
        const text = `---\ntags: [work]\n---\n# Note ${i}\n\n${links}\n\n${filler}\n`;
        jobs.push((async () => {
          const w = await (await dirs[i % 870]!.getFileHandle(`Note ${i}.md`, { create: true })).createWritable();
          await w.write(text);
          await w.close();
        })());
        if (jobs.length > 200) await Promise.all(jobs.splice(0));
      }
      await Promise.all(jobs);
      (window as any).showDirectoryPicker = async () => root;
    });
    const start = Date.now();
    await clickText(p, ".login-card button", "Open a folder");
    await p.waitForSelector(".cm-content");
    expect(Date.now() - start).toBeLessThan(5000);
    await p.click(".cm-content");
    const times = await p.evaluate(async () => {
      const out: number[] = [];
      for (let i = 0; i < 15; i++) {
        const s = performance.now();
        document.execCommand("insertText", false, "a");
        await new Promise((r) => requestAnimationFrame(() => setTimeout(r)));
        out.push(performance.now() - s);
      }
      return out.sort((a, b) => a - b);
    });
    expect(times[7]!).toBeLessThan(100);
    await p.close();
  }, 60000);
});
