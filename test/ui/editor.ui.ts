// Browser tests: headless Chromium against a real server and a scratch database. Not part of
// `bun test` (they need Chrome); run with `bun run test:ui`. Chrome is found from CHROME_PATH, a
// Playwright download, or an installed Google Chrome (test/ui/chrome.ts). Needs the docker
// database (`docker compose up -d db`): each run drops and recreates `commonplace_ui` on it
// (UI_ADMIN_DATABASE_URL names the admin connection).
//
// Covers what unit and API tests can't: Live Preview rendering and reveal-on-cursor, task and
// table widgets, properties, the picture picker's resizing, folders, drag and drop (mouse and
// long-press touch), Trash, the / menu and ⌘K, the block handle, GitHub vaults, templates,
// Settings, the AI panel, types, embeds, offline on the iPhone, accessibility (axe), published
// sites, keyboard-only use, and live co-editing between two pages. Debug switches: UI_DEBUG=1
// prints page errors, UI_WATCHDOG=1 reports frozen pages, A11Y_REPORT=1 prints every axe finding.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// bun test runs on UTC; the server and the pages work in London time, so "today" must match theirs.
process.env.TZ = "Europe/London";
import postgres from "postgres";
import puppeteer, { type Browser, type ElementHandle, type KeyInput, type Page } from "puppeteer-core";
import { startFakeAi } from "../fakeAi";
import { startFakeGitHub, TOKEN } from "../fakeGitHub";
import { LONGVIEW_READ, LONGVIEW_WRITE, startFakeLongview, startFakeRecall, startFakeService } from "../fakeMcp";
import { chromePath } from "./chrome";
import { codeAt, fromBase32 } from "../../src/totp";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addDays, dailyPath, formatDate } from "../../web/lib/templates";

const PORT = 3298;
const BASE = `http://localhost:${PORT}`;
const ADMIN_DB = process.env.UI_ADMIN_DATABASE_URL ?? "postgres://commonplace:commonplace@localhost:5434/commonplace";
const DB = ADMIN_DB.replace(/\/[^/]+$/, "/commonplace_ui");

let server: ReturnType<typeof Bun.spawn>;
/** Folder collections (F22) live here, as the laptop kit's COMMONPLACE_FOLDERS. */
const FOLDERS = mkdtempSync(join(tmpdir(), "cp-ui-folders-"));
let browser: Browser;
let cookie = "";
let vaultId = 0;
const errors: string[] = [];
/** While the offline test has the server stopped, failed requests are expected, not bugs. */
let serverDown = false;

async function api(path: string, body?: unknown, method?: string) {
  const r = await fetch(`${BASE}/api${path}`, {
    method: method ?? (body ? "POST" : "GET"),
    headers: { cookie, "content-type": "application/json", origin: BASE },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r.json();
}
const note = (path: string, content = "") => api(`/vaults/${vaultId}/notes`, { path, content });
const paths = async () => ((await api(`/vaults/${vaultId}/notes`)) as { path: string }[]).map((n) => n.path).sort();

/** Pages opened in this browser. Headless Chrome stops painting (and so taking clicks) after
 *  forty-odd pages in one run (2026-10-11), so start a fresh one every so often, between tests. */
let opened = 0;
const launch = () => puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });

/** At the start of each group of tests (their browser state, such as open folders, carries from
 *  one test to the next within a group): a fresh browser if this one has opened enough pages. */
async function freshBrowser() {
  if (opened < 15) return;
  await browser.close();
  browser = await launch();
  opened = 0;
}

async function open(url: string, phone = false): Promise<Page> {
  opened++;
  const page = await browser.newPage();
  await page.emulateTimezone("Europe/London"); // the server's TIME_ZONE and the tests' clock (headless Chrome may run on UTC)
  page.setDefaultTimeout(10000); // fail with a message well inside the 30 s test timeout
  await page.setViewport(phone ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1200, height: 850 });
  page.on("pageerror", (e) => errors.push(e instanceof Error ? e.message : String(e)));
  page.on("console", (m) => m.type() === "error" && !serverDown && errors.push(m.text()));
  // The app has its own dialogs (web/ui/overlays.tsx); a browser one is a bug.
  page.on("dialog", (d) => (errors.push(`browser ${d.type()} dialog: ${d.message()}`), void d.dismiss()));
  await page.setCookie({ name: "cp_session", value: cookie.split("=")[1]!, url: BASE });
  if (process.env.UI_WATCHDOG) watchdog(page);
  await page.goto(`${BASE}${url}`, { waitUntil: "load" });
  await page.bringToFront(); // headless Chrome holds back input to a tab that isn't in front
  return page;
}
/** Debugging aid (UI_WATCHDOG=1): report a page that stops answering, with its stack. */
function watchdog(page: Page) {
  let reported = false;
  const t = setInterval(async () => {
    if (page.isClosed()) return clearInterval(t);
    const ok = await Promise.race([page.evaluate(() => true).catch((e) => `error: ${e}`), Bun.sleep(5000).then(() => false)]);
    if (ok === true || reported || page.isClosed()) return;
    if (typeof ok === "string") console.log("WATCHDOG evaluate failed:", page.url(), ok.slice(0, 200));
    reported = true;
    console.log("WATCHDOG frozen page:", page.url());
    try {
      const cdp = await page.createCDPSession();
      await cdp.send("Debugger.enable");
      const paused = new Promise<any>((res) => cdp.once("Debugger.paused", res));
      await cdp.send("Debugger.pause");
      const ev = await Promise.race([paused, Bun.sleep(3000).then(() => null)]);
      console.log("WATCHDOG stack:", ev ? ev.callFrames.slice(0, 30).map((f: any) => `${f.functionName || "anon"}:${f.location.lineNumber + 1}`).join(" < ") : "no pause");
      if (ev) {
        for (const f of ev.callFrames.slice(0, 3)) {
          const src = (await cdp.send("Debugger.getScriptSource", { scriptId: f.location.scriptId })).scriptSource.split("\n");
          console.log(`WATCHDOG ${f.functionName}:${f.location.lineNumber + 1}\n` + src.slice(f.location.lineNumber - 4, f.location.lineNumber + 2).map((l: string) => "   | " + l.slice(0, 160)).join("\n"));
        }
      }
    } catch (e) {
      console.log("WATCHDOG couldn't pause:", String(e));
    }
  }, 2000);
}

const openNote = async (id: number, phone = false) => {
  const page = await open(`/v/${vaultId}/n/${id}`, phone);
  await page.waitForSelector(".cm-content");
  await page.waitForSelector(".note-body[data-synced]", { timeout: 10_000 }); // live sync
  return page;
};
const content = (p: Page) => p.$eval(".cm-content", (e) => e.textContent ?? "");
async function until(fn: () => Promise<boolean> | boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await Bun.sleep(50);
  }
  throw new Error("condition not met in time");
}
/** Fill in the app's prompt dialog and press its action button. */
async function answer(p: Page, text: string) {
  const input = await p.waitForSelector("[data-dialog-input]");
  await input!.evaluate((e) => (e as HTMLInputElement).select());
  await p.keyboard.type(text);
  await p.click("[data-dialog-action]");
  await p.waitForSelector("[data-dialog-input]", { hidden: true });
}
/** Open a folder row's ⋯ menu and choose an item. */
async function folderAction(p: Page, folder: string, item: string) {
  const at = await rowCenter(p, folder);
  await p.mouse.move(at.x, at.y); // the row's buttons show on hover
  await p.click(`button[aria-label="${folder} folder actions"]`);
  await p.waitForSelector(".menu-item");
  await p.evaluate((t) => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes(t))!.click(), item);
}
/** Choose from a table's Row or Column menu, for the cell being edited. */
async function tableMenu(p: Page, menu: "Row" | "Column", item: string) {
  await p.evaluate((m) => [...document.querySelectorAll<HTMLButtonElement>(".table-bar button")].find((b) => b.getAttribute("aria-label") === m)!.click(), menu);
  await p.waitForSelector(".menu-item");
  await p.evaluate((t) => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === t)!.click(), item);
}
const clickToast = (p: Page, label: string) =>
  p.waitForSelector(".toast-action").then(() => p.evaluate((t) => [...document.querySelectorAll<HTMLButtonElement>(".toast-action")].find((b) => b.textContent === t)!.click(), label));

async function rowCenter(p: Page, label: string, scroll = true) {
  const h = await p.evaluateHandle(
    (t) => [...document.querySelectorAll(".tree-row")].find((r) => r.querySelector(".tree-label")?.textContent === t),
    label,
  );
  if (scroll) {
    await (h as any).evaluate((e: Element) => e.scrollIntoView({ block: "nearest" })); // as a person would scroll to it
    await Bun.sleep(50);
  }
  const b = await (h as any).boundingBox();
  if (!b) throw new Error(`no tree row ${label}`);
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

beforeAll(async () => {
  const admin = postgres(ADMIN_DB, { onnotice: () => {} });
  await admin.unsafe("drop database if exists commonplace_ui with (force)");
  await admin.unsafe("create database commonplace_ui");
  await admin.end();
  server = startServer();
  await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok ?? false, 20000);
  return afterStart();
}, 60000);

function startServer() {
  return Bun.spawn(["bun", "src/server.ts"], {
    env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), ALLOW_SIGNUP: "true", AIXF_IDS: "false", SETUP_TOKEN: "", EMBEDDING_PROVIDER: "hash", SECRETS_KEY: "ui-secrets-key", ALLOW_LOCAL_AI: "true", WEBLINKS_ALLOW_LOCAL: "true", GITHUB_API_URL: "http://localhost:3286", FOLDERS_ROOT: FOLDERS, FOLDERS_LABEL: "~/Commonplace", CLOUD_LINK: "true", ALLOW_LOCAL_CLOUD: "true", CONNECTIONS_ALLOW_LOCAL: "true", RECALL_MCP_URL: "http://localhost:3412/mcp/", NODE_ENV: process.env.UI_NODE_ENV ?? "production" },
    stdout: "ignore",
    stderr: "inherit",
  });
}

async function afterStart() {
  const r = await fetch(`${BASE}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "ui@example.com", password: "password-ui", name: "Ui" }),
  });
  cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  vaultId = (await api("/vaults"))[0].id;
  browser = await launch();
}

afterAll(async () => {
  if (process.env.UI_DEBUG) console.log("page errors:", errors);
  await browser?.close();
  server?.kill();
  rmSync(FOLDERS, { recursive: true, force: true });
});

describe("live preview", () => {
  beforeAll(freshBrowser);
  let id = 0;
  test("renders markdown in place and reveals the cursor's line", async () => {
    await note("Contractors.md", "# Contractors");
    id = (
      await note(
        "Kitchen.md",
        "# Kitchen\n\nAt [[Contractors|our builders]] and [[Missing]]. **Bold**, *it*, ~~gone~~, `code`, ==hi== and [a link](https://example.com).\n\n> [!tip] Decision\n> Quartz.\n\n## Tasks\n- [x] Quotes\n- [ ] Tiles\n- Plain\n\n---\n\nEnd",
      )
    ).id;
    const p = await openNote(id);
    const text = await content(p);
    expect(text).toContain("At our builders and Missing. Bold, it, gone, code, hi and a link.");
    expect(text).not.toContain("**");
    expect(text).not.toContain("[[");
    expect(await p.$$eval(".cm-lp-task", (b) => b.length)).toBe(2);
    expect(await p.$(".cm-lp-callout-title")).not.toBeNull();
    // Clicking a line shows its markdown.
    const tasks = (await rowOfLine(p, "Tasks"))!;
    await p.mouse.click(tasks.x + tasks.width - 4, tasks.y + tasks.height / 2);
    await until(async () => (await lineText(p, "Tasks")) === "## Tasks");
    await p.close();
  });

  test("ticking a checkbox edits the markdown", async () => {
    const p = await openNote(id);
    const boxes = await p.$$(".cm-lp-task");
    await boxes[1]!.click();
    await until(async () => (await api(`/vaults/${vaultId}/notes/${id}`)).content.includes("- [x] Tiles"));
    await p.close();
  });

  test("clicking a wikilink opens the note; Source mode shows raw markdown", async () => {
    const p = await openNote(id);
    await p.click(".cm-lp-wikilink:not(.cm-lp-unresolved)");
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent)) === "Contractors");
    await p.goto(`${BASE}/v/${vaultId}/n/${id}`, { waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await p.click('.segmented button[title="Source mode"]');
    await until(async () => (await content(p)).includes("[[Contractors|our builders]]"));
    await p.click('.segmented button[title="Live preview"]');
    await p.close();
  });

  test("frontmatter is a properties table and tables render; the table's Markdown button reveals the source", async () => {
    const t = await note("Budget.md", "---\ntags: [home]\nstatus: open\n---\n# Budget\n\n| Item | Cost |\n|---|---:|\n| Units | **£7,500** |\n\nAfter");
    const p = await openNote(t.id);
    expect(await p.$eval('.prop-row[data-key="status"] .prop-input', (e) => (e as HTMLInputElement).value)).toBe("open");
    expect(await p.$$eval(".cm-lp-table table", (t) => t.length)).toBe(1);
    expect(await p.$eval(".cm-lp-table td:last-child strong", (e) => e.textContent)).toBe("£7,500");
    await p.click(".cm-lp-table td");
    await p.waitForSelector(".table-bar", { visible: true });
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".table-bar button")].find((b) => b.textContent?.includes("Markdown"))!.click());
    await until(async () => (await content(p)).includes("|---|---:|"));
    expect(await p.$(".cm-lp-properties")).not.toBeNull(); // only the touched block reveals
    await p.close();
  });

  test("tables edit cell by cell: type, Tab across, Tab at the end adds a row, the bar adds a column; pipes line up", async () => {
    const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
    const t = await note("Quotes.md", "# Quotes\n\n| Firm | Price |\n|---|---:|\n| Acme | 100 |\n\nAfter\n");
    const p = await openNote(t.id);
    await p.waitForSelector(".cm-table-edit td");
    await p.click('.cm-table-edit td[data-r="0"][data-c="0"]');
    await p.keyboard.down("Meta");
    await p.keyboard.press("a");
    await p.keyboard.up("Meta");
    await p.keyboard.type("Acme Tiles");
    await p.keyboard.press("Tab"); // to Price
    await p.keyboard.press("Tab"); // the last cell: a new row
    await p.keyboard.type("Brick & Co");
    await p.keyboard.press("Tab");
    await p.keyboard.type("95");
    await tableMenu(p, "Column", "Insert column right");
    await p.keyboard.type("Notes");
    await p.keyboard.press("Escape");
    await until(async () => (await raw(t.id)).includes("| Brick & Co |    95 | Notes |"), 8000);
    expect(await raw(t.id)).toBe("# Quotes\n\n| Firm       | Price |       |\n| ---------- | ----: | ----- |\n| Acme Tiles |   100 |       |\n| Brick & Co |    95 | Notes |\n\nAfter\n");
    // One undo takes back the last change only.
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("z");
    await p.keyboard.up("Meta");
    await until(async () => !(await raw(t.id)).includes("Notes"), 8000);
    await p.close();
  });

  test("tables: sort, move a row and a column, paste a spreadsheet range into a cell and into the note", async () => {
    const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
    const t = await note("Plants.md", "# Plants\n\n| Plant | Height |\n|---|---|\n| sage | 60 |\n| Basil | 120 |\n| mint | 9 |\n\nAfter\n");
    const p = await openNote(t.id);
    await p.waitForSelector(".cm-table-edit td");
    // Sort by Height: numbers by size, not as text.
    await p.click('.cm-table-edit td[data-r="0"][data-c="1"]');
    // The bar is on screen, not clipped by the table's block: a real click reaches it.
    await p.click('.table-bar button[aria-label="Column"]');
    await p.waitForSelector(".menu-item");
    await p.keyboard.press("Escape");
    await p.click('.cm-table-edit td[data-r="0"][data-c="1"]');
    await tableMenu(p, "Column", "Sort A to Z");
    await until(async () => (await raw(t.id)).includes("| mint  | 9      |\n| sage  | 60     |\n| Basil | 120    |"), 8000);
    // Move Basil up, then the Height column to the left.
    await p.click('.cm-table-edit td[data-r="2"][data-c="0"]');
    await tableMenu(p, "Row", "Move row up");
    await until(async () => (await raw(t.id)).includes("| Basil | 120    |\n| sage  | 60     |"), 8000);
    await p.click('.cm-table-edit td[data-r="1"][data-c="1"]');
    await tableMenu(p, "Column", "Move column left");
    await until(async () => (await raw(t.id)).startsWith("# Plants\n\n| Height | Plant |\n| ------ | ----- |\n| 9      | mint  |\n| 120    | Basil |"), 8000);
    // The header row can't move or be deleted.
    await p.click('.cm-table-edit th[data-c="0"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".table-bar button")].find((b) => b.getAttribute("aria-label") === "Row")!.click());
    await p.waitForSelector(".menu-item");
    expect(await p.$$eval(".menu-item", (b) => b.map((x) => x.textContent))).toEqual(["Insert row below"]);
    await p.keyboard.press("Escape");
    // Two rows by two columns pasted into the last row's first cell: one row is added.
    const paste = (sel: string, text: string) =>
      p.evaluate(
        (s, v) => {
          const dt = new DataTransfer();
          dt.setData("text/plain", v);
          document.querySelector(s)!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
        },
        sel,
        text,
      );
    await p.click('.cm-table-edit td[data-r="2"][data-c="0"]');
    await paste('.cm-table-edit td[data-r="2"][data-c="0"]', "45\tthyme\r\n30\tchives\r\n");
    await until(async () => (await raw(t.id)).includes("| 45     | thyme  |\n| 30     | chives |\n\nAfter"), 8000);
    await p.keyboard.press("Escape");
    // A range pasted at the end of the note becomes a table of its own.
    const after = await p.evaluateHandle(() => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent === "After")!);
    await (after as ElementHandle<Element>).click();
    await p.keyboard.press("End");
    await paste(".cm-content", "Month\tRain\nMay\t50\nJune\t42\n");
    await until(async () => (await raw(t.id)).endsWith("After\n\n| Month | Rain |\n| ----- | ---- |\n| May   | 50   |\n| June  | 42   |\n"), 8000);
    await until(() => p.$$eval(".cm-table-edit", (x) => x.length).then((n) => n === 2));
    await p.close();
  });

  test("colours: every plugin's form shows; only a safe colour survives the sanitiser", async () => {
    const md = [
      "# Colours",
      "",
      '<mark style="background: #FFF3A3A6;">highlightr</mark> <mark class="hltr-blue">classes</mark> <font color="#ff0000">font</font> =={green}hilo==',
      "",
      '<span style="color: #123456; position: fixed; top: 0; left: 0; width: 100vw; height: 100vh; background: url(https://x.invalid/a.png)">evil</span>',
      "",
      '<div style="position: fixed; inset: 0; background: red">overlay</div>',
    ].join("\n");
    const n = await note("Colours.md", md);
    const p = await openNote(n.id);
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForSelector(".preview mark.hl-yellow");
    expect(await p.$eval(".preview mark.hl-blue", (e) => e.textContent)).toBe("classes");
    expect(await p.$eval(".preview mark.hl-green", (e) => e.textContent)).toBe("hilo");
    expect(await p.$eval(".preview font", (e) => getComputedStyle(e).color)).toBe("rgb(255, 0, 0)");
    const evil = await p.evaluate(() => {
      const s = [...document.querySelectorAll(".preview span")].find((e) => e.textContent === "evil")!;
      return { style: s.getAttribute("style"), position: getComputedStyle(s).position };
    });
    expect(evil).toEqual({ style: "color: #123456", position: "static" });
    expect(await p.evaluate(() => [...document.querySelectorAll(".preview [style]")].every((e) => /^(color|background-color): [^;]+$/.test(e.getAttribute("style")!)))).toBe(true);
    // Live Preview shows the colours too, with the tags hidden off the cursor's line.
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Live preview"]')!.click());
    await p.waitForSelector(".cm-lp-colour.hl-yellow");
    expect(await content(p)).not.toContain("<mark");
    await p.close();
  });

  test("colouring from the editor writes the portable HTML markup, and Remove colour takes it off", async () => {
    const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
    const n = await note("Paint.md", "# Paint\n\nChoose tiles soon\n");
    const p = await openNote(n.id);
    await p.evaluate(() => {
      const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent === "Choose tiles soon")!;
      const t = line.firstChild!;
      const r = document.createRange();
      r.setStart(t, 7);
      r.setEnd(t, 12);
      getSelection()!.removeAllRanges();
      getSelection()!.addRange(r);
    });
    await Bun.sleep(100);
    await p.keyboard.down("Meta");
    await p.keyboard.down("Shift");
    await p.keyboard.press("h");
    await p.keyboard.up("Shift");
    await p.keyboard.up("Meta");
    await p.waitForSelector("[data-dialog-input]");
    await p.keyboard.type("yellow highlight");
    await Bun.sleep(100);
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).includes('Choose <mark style="background: #FFF3A3A6;">tiles</mark> soon'), 8000);
    await p.keyboard.down("Meta");
    await p.keyboard.down("Shift");
    await p.keyboard.press("h");
    await p.keyboard.up("Shift");
    await p.keyboard.up("Meta");
    await p.waitForSelector("[data-dialog-input]");
    await p.keyboard.type("remove");
    await Bun.sleep(100);
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).includes("Choose tiles soon"), 8000);
    await p.close();
  });

  test("mermaid blocks draw as diagrams, in Live Preview and reading view, and can't restyle the app", async () => {
    await note("Builders.md", "# Builders\n");
    const md = [
      "# Flow",
      "",
      "```mermaid",
      "%%{init: {'themeCSS': 'body, .app { display: none !important; }'}}%%",
      "flowchart LR",
      "  A[Quote] --> B[Builders]",
      "  class B internal-link",
      "```",
      "",
      "Below.",
    ].join("\n");
    const n = await note("Flow.md", md);
    const p = await openNote(n.id);
    const drawn = (sel: string) => p.waitForFunction((sel) => !!document.querySelector(sel)?.shadowRoot?.querySelector("svg .node"), { timeout: 15000 }, sel);
    await drawn(".cm-content .mermaid-diagram");
    expect(await p.evaluate(() => getComputedStyle(document.body).display)).not.toBe("none");
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await drawn(".preview .mermaid-diagram");
    await p.evaluate(() => {
      const node = document.querySelector(".preview .mermaid-diagram")!.shadowRoot!.querySelector<SVGElement>(".node.internal-link")!;
      node.dispatchEvent(new MouseEvent("click", { bubbles: true, composed: true }));
    });
    await p.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Builders");
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.close();
  });

  test("Dataview: results in Live Preview and reading view, ticking a task in its own note, and refreshing", async () => {
    const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
    const t = await note("DV/Tasks One.md", "---\nstatus: active\npriority: 2\n---\n# Tasks One\n\n- [ ] Call the plumber\n");
    await note("DV/Tasks Two.md", "---\nstatus: paused\npriority: 1\n---\n# Tasks Two\n");
    const board = await note(
      "DV Board.md",
      '# DV Board\n\nActive: `= length(filter(dv.pages("DV"), (p) => p.status = "active"))`\n\n```dataview\nTABLE status AS "Status" FROM "DV" SORT priority ASC\n```\n\n```dataview\nTASK FROM "DV" WHERE !completed\n```\n',
    );
    const p = await openNote(board.id);
    await p.waitForFunction(() => document.querySelectorAll(".cm-content .dataview-block table tbody tr").length === 2, { timeout: 8000 });
    expect(await p.$$eval(".cm-content .dataview-block table tbody tr", (r) => r.map((x) => x.textContent))).toEqual(["Tasks Twopaused", "Tasks Oneactive"]);
    expect(await p.$eval(".cm-content .dataview-inline", (e) => e.textContent)).toBe("1");
    await p.click(".cm-content input.dv-task");
    await until(async () => (await raw(t.id)).includes("- [x] Call the plumber"), 8000);
    await p.waitForFunction(() => document.querySelector(".cm-content .dataview-block .dv-empty")?.textContent === "No tasks.", { timeout: 8000 });
    // Another note changing shows without reopening this one.
    await api(`/vaults/${vaultId}/notes/${t.id}/content`, { content: (await raw(t.id)).replace("status: active", "status: paused") }, "PUT");
    await p.waitForFunction(() => document.querySelector(".cm-content .dataview-inline")?.textContent === "0", { timeout: 10000 });
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForFunction(() => document.querySelectorAll(".preview .dataview-block table tbody tr").length === 2, { timeout: 8000 });
    await p.click(".preview .dataview-block table a.internal-link");
    await p.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Tasks Two");
    // CALENDAR in the app: today's month, a day button per day with notes.
    const cal = await note("DV Calendar.md", '```dataview\nCALENDAR file.cday FROM "DV"\n```\n');
    await p.goto(`${BASE}/v/${vaultId}/n/${cal.id}`);
    await p.waitForSelector(".preview .dv-calendar .dv-cal-today button", { timeout: 8000 });
    expect(await p.$eval(".preview .dv-calendar .dv-cal-today button", (b) => b.getAttribute("aria-label"))).toMatch(/, 2 notes$/);
    await p.click('.preview [aria-label="Previous month"]');
    await p.waitForFunction(() => !document.querySelector(".preview .dv-cal-today") && !!document.querySelector(".preview .dv-cal-now"));
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.close();
  });

  test("dataviewjs runs in its sandbox page under the app's policy: draws, reads a note, opens one", async () => {
    await note("JS/Jsalpha.md", "---\nrank: 2\n---\nJsalpha text\n");
    await note("JS/Jsbeta.md", "---\nrank: 1\n---\n");
    const n = await note(
      "JS Board.md",
      '# JS Board\n\n```dataviewjs\nconst ps = dv.pages(\'"JS"\').sort((p) => p.rank);\ndv.list(ps.file.link);\nconst text = await dv.io.load("JS/Jsalpha.md");\ndv.paragraph("Loaded: " + text.split("\\n").pop() + text.includes("Jsalpha text"));\nlet cookie = "readable"; try { document.cookie; } catch { cookie = "blocked"; }\ndv.paragraph("cookie " + cookie);\n```\n',
    );
    const p = await openNote(n.id);
    const handle = await p.waitForSelector(".cm-content iframe.dv-frame");
    expect(await handle!.evaluate((f) => (f as HTMLIFrameElement).src)).toEndWith("/sandbox/dataviewjs");
    const frame = (await handle!.contentFrame())!;
    await frame.waitForFunction(() => document.body.textContent?.includes("cookie"), { timeout: 10000 });
    expect(await frame.$$eval("li", (l) => l.map((x) => x.textContent))).toEqual(["Jsbeta", "Jsalpha"]);
    expect(await frame.$eval("#root", (e) => e.textContent)).toContain("Loaded: true");
    expect(await frame.$eval("#root", (e) => e.textContent)).toContain("cookie blocked");
    await frame.click("li a.internal-link");
    await p.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Jsbeta");
    await p.close();
  });

  test("a dataviewjs script that never stops is stopped, and the page stays usable", async () => {
    const n = await note("JS Forever.md", "# JS Forever\n\n```dataviewjs\nlet i = 0;\nwhile (true) i++;\n```\n");
    const p = await open(`/v/${vaultId}/n/${n.id}`);
    // The script holds its frame for 5 s before it's stopped, which on a busy machine can push the
    // note's first paint past the usual 10 s wait: this page gets 20.
    p.setDefaultTimeout(20_000);
    await p.waitForSelector(".cm-content");
    const handle = await p.waitForSelector(".cm-content iframe.dv-frame");
    const frame = (await handle!.contentFrame())!;
    // 5 s of the script's busy time, plus however long the sandbox takes to start on this machine.
    await frame.waitForFunction(() => document.querySelector(".dv-error")?.textContent?.includes("ran for over 5 seconds"), { timeout: 25_000 });
    expect(await p.evaluate(() => document.querySelector(".note-title")?.textContent)).toBe("JS Forever");
    await p.close();
  }, 45_000);

  test("the outline shows headings as plain text", async () => {
    const t = await note("Outline.md", "# Plan **now**\n\n## See [[Contractors|builders]]");
    const p = await openNote(t.id);
    const outline = await p.$$eval(".right-panel li, .outline li", (els) => els.map((e) => e.textContent?.trim()));
    expect(outline).toContain("Plan now");
    expect(outline).toContain("See builders");
    await p.close();
  });
});

describe("properties", () => {
  beforeAll(freshBrowser);
  const fm = (id: number) => api(`/vaults/${vaultId}/notes/${id}`).then((n) => n.content.split("\n---")[0] as string);
  async function setInput(p: Page, sel: string, value: string) {
    await p.click(sel);
    expect(await p.$eval(sel, (e) => e === document.activeElement)).toBe(true); // one click focuses it
    await p.$eval(sel, (e) => (e as HTMLInputElement).select()); // Puppeteer's ⌘A doesn't select in inputs
    await p.keyboard.press("Backspace");
    await p.keyboard.type(value);
    await p.keyboard.press("Enter");
  }

  test("edit text, number, checkbox and date values in place; other lines are untouched", async () => {
    const n = await note("Props.md", '---\ntags: [home]   # kept\nstatus: open\nbudget: 100\ndone: false\ndue: 2026-10-10\n"my key": x\n---\n# Props');
    const p = await openNote(n.id);
    await setInput(p, '.prop-row[data-key="status"] .prop-input', "in progress");
    await until(async () => (await fm(n.id)).includes("status: in progress"));
    await setInput(p, '.prop-row[data-key="budget"] .prop-input', "250");
    await until(async () => (await fm(n.id)).includes("budget: 250"));
    await p.click('.prop-row[data-key="done"] .prop-check');
    await until(async () => (await fm(n.id)).includes("done: true"));
    await p.$eval('.prop-row[data-key="due"] .prop-input', (e) => {
      (e as HTMLInputElement).value = "2026-12-25";
      e.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(async () => (await fm(n.id)).includes("due: 2026-12-25"));
    const text = await fm(n.id);
    expect(text).toContain("tags: [home]   # kept");
    expect(text).toContain('"my key": x');
    await p.close();
  });

  test("lists: add pills with Enter, remove with ×; the flow style is kept", async () => {
    const n = await note("Tags.md", "---\ntags: [home]\n---\nBody");
    const p = await openNote(n.id);
    await p.click('.prop-row[data-key="tags"] .prop-pill-input');
    await p.keyboard.type("#garden");
    await p.keyboard.press("Enter");
    await until(async () => (await fm(n.id)).includes("tags: [home, garden]"));
    // Focus comes back to the list input, so several can be typed in a row.
    await until(async () => (await p.evaluate(() => document.activeElement?.classList.contains("prop-pill-input"))) === true);
    await p.keyboard.type("diy,");
    await until(async () => (await fm(n.id)).includes("tags: [home, garden, diy]"));
    await p.click('.prop-row[data-key="tags"] .pill-x[aria-label="Remove home"]');
    await until(async () => (await fm(n.id)).includes("tags: [garden, diy]"));
    await p.close();
  });

  test("add, rename and remove properties; Edit YAML shows the source", async () => {
    const n = await note("Manage.md", "---\nstatus: open\n---\nBody");
    const p = await openNote(n.id);
    await p.click(".prop-new-key");
    await p.keyboard.type("aliases");
    await p.select(".prop-new-type", "list");
    await p.keyboard.press("Enter");
    await p.click(".prop-new-key");
    await p.keyboard.press("Enter"); // empty name: nothing happens
    await until(async () => (await fm(n.id)).includes("aliases:"));
    await setInput(p, '.prop-row[data-key="status"] .prop-key', "state");
    await until(async () => (await fm(n.id)).includes("state: open"));
    await p.click('.prop-row[data-key="aliases"] .prop-del');
    await until(async () => !(await fm(n.id)).includes("aliases"));
    await p.click(".props-yaml");
    await until(async () => (await content(p)).includes("state: open") && !(await p.$(".cm-lp-props")));
    await p.close();
  });

  test("Add property on a note without frontmatter creates it", async () => {
    const n = await note("Bare.md", "# Bare\n\nText");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu button")].find((b) => b.textContent?.includes("Add property"))!.click());
    await until(async () => (await p.evaluate(() => document.activeElement?.classList.contains("prop-new-key"))) === true);
    await p.keyboard.type("status");
    await p.keyboard.press("Enter");
    await until(async () => (await api(`/vaults/${vaultId}/notes/${n.id}`)).content.startsWith("---\nstatus:\n---\n# Bare"));
    await p.close();
  });

  test("a property edit reaches a collaborator live", async () => {
    const n = await note("SharedProps.md", "---\nstatus: open\n---\nBody");
    const [a, b] = [await openNote(n.id), await openNote(n.id)];
    await a.bringToFront();
    await setInput(a, '.prop-row[data-key="status"] .prop-input', "shipped");
    await until(async () => (await b.$eval('.prop-row[data-key="status"] .prop-input', (e) => (e as HTMLInputElement).value)) === "shipped");
    await a.close();
    await b.close();
  });
});

describe("pictures", () => {
  beforeAll(freshBrowser);
  test("a large photo is resized to 2048px JPEG before upload and shown inline", async () => {
    const t = await note("Photos.md", "Photo below\n");
    const p = await openNote(t.id);
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    // A noisy 4000×3000 JPEG, made in the page, fed to the picture picker.
    await p.evaluate(async () => {
      const c = document.createElement("canvas");
      c.width = 4000;
      c.height = 3000;
      const g = c.getContext("2d")!;
      const img = g.createImageData(4000, 3000);
      for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 2654435761) >>> 24;
      g.putImageData(img, 0, 0);
      const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), "image/jpeg", 0.95));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], "IMG_0001.jpg", { type: "image/jpeg" }));
      const input = document.querySelector<HTMLInputElement>('input[type=file][accept="image/*"]')!;
      input.files = dt.files;
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await until(async () => (await api(`/vaults/${vaultId}/notes/${t.id}`)).content.includes("![[attachments/IMG_0001.jpg]]"), 15000);
    await p.keyboard.press("ArrowUp");
    await p.keyboard.press("ArrowUp");
    await until(async () => (await p.$$eval(".cm-lp-image", (i) => (i as HTMLImageElement[]).map((x) => x.naturalWidth))).includes(2048), 10000);
    const file = await fetch(`${BASE}/api/vaults/${vaultId}/files?path=${encodeURIComponent("attachments/IMG_0001.jpg")}`, { headers: { cookie } });
    expect(file.headers.get("content-type")).toBe("image/jpeg");
    expect((await file.arrayBuffer()).byteLength).toBeLessThan(4_000_000);
    await p.close();
  }, 30000);
});

describe("folders, drag and drop, trash", () => {
  beforeAll(freshBrowser);
  test("new folder, subfolder, and deleting an empty one with Undo", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click('.sidebar-actions button[aria-label="New folder"]');
    await answer(p, "Recipes");
    await until(async () => (await api(`/vaults/${vaultId}/folders`)).includes("Recipes"));
    await p.waitForSelector('button[aria-label="Recipes folder actions"]');
    await folderAction(p, "Recipes", "New folder inside");
    await answer(p, "Desserts");
    await until(async () => (await api(`/vaults/${vaultId}/folders`)).includes("Recipes/Desserts"));
    await p.waitForFunction(() => [...document.querySelectorAll(".tree-label")].some((e) => e.textContent === "Desserts"));
    // No "Are you sure?" for an empty folder: it goes at once, and Undo brings it back.
    await folderAction(p, "Desserts", "Delete empty folder");
    await until(async () => !(await api(`/vaults/${vaultId}/folders`)).includes("Recipes/Desserts"));
    await clickToast(p, "Undo");
    await until(async () => (await api(`/vaults/${vaultId}/folders`)).includes("Recipes/Desserts"));
    await folderAction(p, "Desserts", "Delete empty folder");
    await until(async () => !(await api(`/vaults/${vaultId}/folders`)).includes("Recipes/Desserts"));
    await p.close();
  });

  test("a dialog over Settings: Escape closes only the dialog", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click('button[aria-label="Settings"]');
    await p.waitForSelector(".modal");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Leave collection")!.click());
    await p.waitForSelector("[data-dialog-action]");
    expect(await p.$$eval(".modal", (m) => m.length)).toBe(2);
    await p.keyboard.press("Escape");
    await until(async () => (await p.$$eval(".modal", (m) => m.length)) === 1);
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Settings");
    await p.keyboard.press("Escape");
    await until(async () => (await p.$$(".modal")).length === 0);
    await p.close();
  });

  test("drag a note into a folder with the mouse; a click still opens notes", async () => {
    await note("Pancakes.md", "# Pancakes");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await Bun.sleep(300);
    const a = await rowCenter(p, "Pancakes");
    const t = await rowCenter(p, "Recipes");
    await p.mouse.move(a.x, a.y);
    await p.mouse.down();
    for (let i = 1; i <= 10; i++) await p.mouse.move(a.x + ((t.x - a.x) * i) / 10, a.y + ((t.y - a.y) * i) / 10);
    expect(await p.$eval(".tree-row.drop-over .tree-label", (e) => e.textContent)).toBe("Recipes");
    await p.mouse.up();
    await until(async () => (await paths()).includes("Recipes/Pancakes.md"));
    expect(p.url()).toBe(`${BASE}/v/${vaultId}`); // the drop didn't open the note
    await p.close();
  });

  test("long-press drags on touch; a swipe scrolls instead", async () => {
    await note("Apples.md", "# Apples"); // sorts just below the folders, so both fit on a phone screen
    const p = await open(`/v/${vaultId}`, true);
    await (await p.waitForSelector('button[aria-label="Files"]'))!.click(); // the app renders after its session request
    await p.waitForSelector(".tree-row");
    await Bun.sleep(400);
    // Both rows on screen first, then measure both without scrolling again.
    await rowCenter(p, "Recipes");
    await rowCenter(p, "Apples");
    let a = await rowCenter(p, "Apples", false);
    const t = await rowCenter(p, "Recipes", false);
    await p.touchscreen.touchStart(a.x, a.y);
    await Bun.sleep(550);
    for (let i = 1; i <= 10; i++) await p.touchscreen.touchMove(a.x + ((t.x - a.x) * i) / 10, a.y + ((t.y - a.y) * i) / 10);
    await p.touchscreen.touchEnd();
    await until(async () => (await paths()).includes("Recipes/Apples.md"));
    a = await rowCenter(p, "Recipes");
    await p.touchscreen.touchStart(a.x, a.y);
    await p.touchscreen.touchMove(a.x, a.y + 80);
    await p.touchscreen.touchEnd();
    expect(await p.$(".drag-ghost")).toBeNull();
    await p.close();
  });

  test("Move to… files a note into a folder from its menu, and Undo puts it back", async () => {
    const n = await note("Filed.md", "file me");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Move to…")!.click());
    await p.waitForSelector(".choose-list li");
    await p.keyboard.type("recip");
    await p.keyboard.press("Enter");
    await until(async () => (await paths()).includes("Recipes/Filed.md"));
    await until(async () => (await p.$eval(".breadcrumb", (e) => e.textContent).catch(() => "")) === "Recipes");
    await clickToast(p, "Undo");
    await until(async () => (await paths()).includes("Filed.md"));
    await p.close();
  });

  test("Copy to another vault… picks the vault and its folder, and Undo takes the copy away", async () => {
    const other = await api("/vaults", { name: "Second vault" });
    await api(`/vaults/${other.id}/notes`, { path: "Kept/Here.md", content: "" });
    const n = await note("Shared plan.md", "copy me");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Copy to another collection…")!.click());
    await p.waitForSelector(".choose-list li");
    await p.keyboard.type("second");
    await p.keyboard.press("Enter");
    await until(async () => (await p.$eval(".modal h2", (e) => e.textContent).catch(() => "")) === "Into which folder of Second vault?");
    await p.keyboard.type("kept");
    await p.keyboard.press("Enter");
    const there = async () => ((await api(`/vaults/${other.id}/notes`)) as { path: string }[]).map((x) => x.path).sort();
    await until(async () => (await there()).includes("Kept/Shared plan.md"));
    expect(await paths()).toContain("Shared plan.md"); // a copy: the original stays
    await clickToast(p, "Undo");
    await until(async () => !(await there()).includes("Kept/Shared plan.md"));
    await p.close();
  });

  test("Move to Trash, then restore from the Trash screen", async () => {
    const n = await note("Doomed.md", "keep me");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Move to Trash"))!.click());
    await until(async () => !(await paths()).includes("Doomed.md"));
    await p.click('button[aria-label="Trash"]');
    await p.waitForSelector(".trash-list li");
    expect(await p.$eval(".trash-list li", (e) => e.textContent)).toContain("Doomed");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".trash-list button")].find((b) => b.textContent?.includes("Restore"))!.click());
    await until(async () => (await paths()).includes("Doomed.md"));
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === "Doomed");
    await p.close();
  });

  test("Move to Trash offers Undo, which brings the note back and opens it", async () => {
    const n = await note("Oops.md", "not yet");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Move to Trash"))!.click());
    await until(async () => !(await paths()).includes("Oops.md"));
    expect(await p.$eval(".toast", (e) => e.textContent)).toContain("Moved “Oops” to Trash");
    await clickToast(p, "Undo");
    await until(async () => (await paths()).includes("Oops.md"));
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === "Oops");
    await p.close();
  });

  test("on a phone the note menu is an action sheet", async () => {
    const n = await note("Sheet.md", "x");
    const p = await openNote(n.id, true);
    await p.click('button[aria-label="More"]');
    await p.waitForSelector(".menu.sheet");
    const { height } = (await (await p.$(".menu.sheet .menu-item"))!.boundingBox())!;
    expect(height).toBeGreaterThanOrEqual(44); // a finger-sized target
    await p.click(".menu-cancel");
    await p.waitForSelector(".menu.sheet", { hidden: true });
    await p.close();
  });

  test("on a phone scrolling down tucks the header and find button away, and up brings them back; focus mode from the menu", async () => {
    const n = await note("Long read.md", Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of a long note.`).join("\n\n"));
    const p = await openNote(n.id, true);
    const scrollBy = (y: number) => p.evaluate((y) => document.querySelector(".cm-scroller")!.scrollBy(0, y), y);
    await scrollBy(300);
    await Bun.sleep(100);
    await scrollBy(300);
    await p.waitForSelector(".app.chrome-hidden");
    await Bun.sleep(400);
    const head = (await (await p.$(".note-header"))!.boundingBox())!;
    expect(head.y + head.height).toBeLessThanOrEqual(1);
    expect(await p.$eval(".fab", (e) => getComputedStyle(e).visibility)).toBe("hidden");
    // Focus arriving in the header (the keyboard, VoiceOver) shows it.
    await p.focus(".note-header .panel-toggle");
    await p.waitForSelector(".app:not(.chrome-hidden)");
    await p.evaluate(() => (document.activeElement as HTMLElement).blur());
    await scrollBy(400);
    await Bun.sleep(100);
    await scrollBy(400);
    await p.waitForSelector(".app.chrome-hidden");
    await Bun.sleep(450);
    await scrollBy(-200);
    await p.waitForSelector(".app:not(.chrome-hidden)");
    await Bun.sleep(400); // the header sliding back
    // Focus mode: no header or formatting bar, and a way out.
    await p.click('button[aria-label="More"]');
    await p.waitForSelector(".menu.sheet");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Focus mode"))!.click());
    await p.waitForSelector(".focus-exit-float");
    expect(await p.$eval(".note-header", (e) => getComputedStyle(e).display)).toBe("none");
    await p.click(".focus-exit-float");
    await p.waitForSelector(".focus-exit-float", { hidden: true });
    expect(await p.$eval(".note-header", (e) => getComputedStyle(e).display)).not.toBe("none");
    await p.close();
  });
});

describe("commands: the / menu and ⌘K", () => {
  beforeAll(freshBrowser);
  const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
  const endOfDoc = async (p: Page) => {
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
  };

  test("/ at the start of a line offers blocks; /tab inserts a table and /todo makes a to-do", async () => {
    const n = await note("Slash.md", "# Slash\n");
    const p = await openNote(n.id);
    await endOfDoc(p);
    await p.keyboard.press("Enter");
    await p.keyboard.type("/");
    await p.waitForSelector(".cm-tooltip-autocomplete");
    expect(await p.$$eval(".cm-tooltip-autocomplete li", (l) => l.length)).toBeGreaterThan(10);
    await p.keyboard.type("tab");
    await p.waitForFunction(() => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes("Table"));
    await Bun.sleep(150); // CodeMirror ignores Enter for 75 ms after the list changes
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).includes("| Column | Column |\n| --- | --- |"));
    expect(await raw(n.id)).not.toContain("/tab");
    await endOfDoc(p);
    await p.keyboard.press("Enter");
    await p.keyboard.type("/todo");
    await p.waitForFunction(() => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes("To-do"));
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.keyboard.type("Buy grout");
    await until(async () => (await raw(n.id)).includes("\n- [ ] Buy grout"));
    await p.close();
  });

  test("a slash inside a word, a URL or code doesn't open the menu", async () => {
    const n = await note("NoSlash.md", "x\n");
    const p = await openNote(n.id);
    await endOfDoc(p);
    await p.keyboard.type(" and/or https://example.com/a `a/b` ");
    await Bun.sleep(300);
    expect(await p.$(".cm-tooltip-autocomplete")).toBeNull();
    await p.close();
  });

  test("spelling and grammar help: on in prose, off in code, properties and links; switched off from ⌘K", async () => {
    const n = await note("Wide/Spelling.md", "---\nstatus: draft\n---\n# Spelling\n\nSome prose with `code` and https://example.com here.\n\n```js\nconst x = 1;\n```\n");
    const p = await openNote(n.id);
    const attrs = () => p.$eval(".cm-content", (e) => [e.getAttribute("spellcheck"), e.getAttribute("autocorrect"), e.getAttribute("autocapitalize"), e.getAttribute("writingsuggestions")]);
    expect(await attrs()).toEqual(["true", "on", "sentences", "true"]);
    const checked = (text: string) =>
      p.evaluate((t) => {
        const lines = [...document.querySelectorAll<HTMLElement>(".cm-line")];
        const line = lines.find((l) => l.textContent?.includes(t))!;
        const el = [...line.querySelectorAll<HTMLElement>("*")].find((x) => x.textContent === t) ?? line;
        return (el.closest("[spellcheck]") as HTMLElement).getAttribute("spellcheck");
      }, text);
    expect(await checked("Some prose with ")).toBe("true");
    expect(await checked("const x = 1;")).toBe("false");
    expect(await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-line")].filter((l) => l.textContent?.includes("status")).every((l) => l.closest("[spellcheck]")!.getAttribute("spellcheck") === "false"))).toBe(true);
    expect(await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-line [spellcheck='false']")].some((e) => e.textContent?.includes("example.com")))).toBe(true);
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("Turn off spelling");
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await until(async () => (await attrs())[0] === "false");
    await p.reload();
    await p.waitForSelector(".cm-content");
    expect((await attrs())[0]).toBe("false"); // remembered on this device
    await p.evaluate(() => localStorage.removeItem("cp:writing-aids"));
    await p.close();
  });

  test("#Type inline (F26): # offers New Critter…, the title follows, Enter makes the note and links it; Undo puts the text back", async () => {
    await note("Types/Critter.md", "---\nicon: user\nproperties:\n  - name: habitat\n    kind: text\n---\n# {{title}}\n\n## Notes\n").catch(() => {});
    for (const phone of [false, true]) {
      const who = phone ? "Pip Okafor" : "Sam Okafor";
      const n = await note(`Wide/Hash type ${phone ? "phone" : "laptop"}.md`, "# Met\n");
      const p = await openNote(n.id, phone);
      await endOfDoc(p);
      await p.keyboard.press("Enter");
      await p.keyboard.type("Met #Crit");
      await p.waitForFunction(() => [...document.querySelectorAll(".cm-tooltip-autocomplete li")].some((l) => l.textContent?.includes("New Critter…")));
      await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".cm-tooltip-autocomplete li")].find((l) => l.textContent?.includes("New Critter…"))!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
      await until(async () => (await raw(n.id)).includes("Met #Critter "));
      await p.keyboard.type(who);
      await p.waitForFunction((w) => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes(`New Critter “${w}”`), {}, who);
      await Bun.sleep(150); // CodeMirror ignores Enter for 75 ms after the list changes
      await p.keyboard.press("Enter");
      await until(async () => (await raw(n.id)).includes(`Met [[${who}]]`));
      await until(async () => ((await api(`/vaults/${vaultId}/notes`)) as { path: string }[]).some((x) => x.path === `${who}.md`));
      const made = ((await api(`/vaults/${vaultId}/notes`)) as { id: number; path: string }[]).find((x) => x.path === `${who}.md`)!;
      expect((await api(`/vaults/${vaultId}/notes/${made.id}`)).content).toMatch(new RegExp(`^---\\ntype: Critter\\n[\\s\\S]*# ${who}\\n`));
      await p.keyboard.down("Meta");
      await p.keyboard.press("z");
      await p.keyboard.up("Meta");
      await until(async () => (await raw(n.id)).includes(`Met #Critter ${who}`));
      // Typed by hand, a tag with a type's name stays a tag: nothing is offered after it.
      await endOfDoc(p);
      await p.keyboard.press("Enter");
      await p.keyboard.type("#critter ");
      await p.keyboard.press("Escape");
      await p.keyboard.type("and more");
      await Bun.sleep(300);
      expect(await p.$$eval(".cm-tooltip-autocomplete li", (l) => l.map((x) => x.textContent).join("|"))).not.toContain("New Critter “");
      await p.close();
    }
  });

  test("⌘K lists every command, including this note's, and runs one", async () => {
    const n = await note("Palette.md", "# Palette\n");
    const p = await openNote(n.id);
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette li");
    const titles = await p.$$eval(".palette li .palette-title", (l) => l.map((e) => e.textContent));
    for (const t of ["Move to Trash", "Heading 1", "Graph view", "New folder", "Collection settings"]) expect(titles).toContain(t);
    await p.keyboard.type("graph");
    await p.keyboard.press("Enter");
    await until(() => p.url().endsWith(`/v/${vaultId}/graph`));
    await p.close();
  });

  test("the graph after Capacities: the side panel's tab around the note, Show more, and the page with filters and a scope", async () => {
    await note("Graphs/Far.md", "# Far\n");
    await note("Graphs/Near.md", "# Near\n\nSee [[Far]].\n");
    const n = await note("Graphs/Middle.md", "# Middle\n\nNext to [[Near]].\n");
    const p = await openNote(n.id);
    if (!(await p.$(".app.right-open"))) await p.click('button[aria-label="Side panel"]');
    await p.waitForSelector(".right-tabs [role=tab]");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((b) => b.textContent?.includes("Graph"))!.click());
    await p.waitForSelector(".local-graph .graph-canvas");
    const label = () => p.$eval(".local-graph .graph-canvas", (c) => c.getAttribute("aria-label"));
    await until(async () => (await label()) === "Notes linked with Middle: 1");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".local-graph button")].find((b) => b.textContent === "Show more")!.click());
    await until(async () => (await label()) === "Notes linked with Middle: 2");
    // The page around the note, then scoped to a folder, with the filters panel.
    await p.click('.local-graph button[aria-label="Open the full graph around this note"]');
    await until(() => p.url().endsWith(`/graph?note=${n.id}`));
    await p.waitForSelector(".graph-scope");
    expect(await p.$eval(".graph-scope", (e) => e.textContent)).toContain("around Middle");
    await p.goto(`${BASE}/v/${vaultId}/graph?folder=Graphs`);
    await until(async () => ((await p.$eval(".graph-view .graph-canvas", (c) => c.getAttribute("aria-label")).catch(() => "")) ?? "").startsWith("Graph of Graphs/: 3 notes and 2 links"));
    await p.click(".graph-bar button[aria-expanded]");
    await p.waitForSelector(".graph-filters");
    await p.evaluate(() => [...document.querySelectorAll<HTMLInputElement>(".graph-filters label")].find((l) => l.textContent?.includes("Notes with no links"))!.querySelector("input")!.click());
    expect(await p.$eval(".graph-badge", (e) => e.textContent)).toBe("1");
    await p.evaluate(() => [...document.querySelectorAll<HTMLInputElement>(".graph-filters label")].find((l) => l.textContent?.includes("Notes with no links"))!.querySelector("input")!.click());
    await p.close();
  });

  test("the journal (F24): an entry from ⌘K lands in today's note under Journal, and the journal page shows it", async () => {
    // Its own collection as home, so today's note in the main one is left for the daily-note tests.
    const jv = (await api("/vaults", { name: "Journal UI" })).id;
    await api(`/vaults/${jv}/notes`, { path: "Start.md", content: "# Start\n" });
    await api("/me/home", { vaultId: jv }, "PUT");
    const p = await open(`/v/${jv}`);
    await p.waitForSelector(".tree-row");
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("New journal entry");
    await p.keyboard.press("Enter");
    await p.waitForSelector('textarea[aria-label="Journal entry"]');
    await p.keyboard.type("Fixed the gate at last.");
    await p.keyboard.down("Meta");
    await p.keyboard.press("Enter");
    await p.keyboard.up("Meta");
    await p.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Added to your journal"));
    const day = await p.evaluate(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; });
    const daily = ((await api(`/vaults/${jv}/notes`)) as { id: number; path: string }[]).find((n) => n.path === `Daily/${day}.md`)!;
    expect((await api(`/vaults/${jv}/notes/${daily.id}`)).content).toMatch(/## Journal\n\n### \d{2}:\d{2}\n\nFixed the gate at last\.\n/);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar .type-row")].find((b) => b.textContent?.includes("Journal"))!.click());
    await p.waitForSelector(".journal-day");
    expect(await p.$eval(".journal-day", (e) => e.textContent)).toContain("Fixed the gate at last.");
    await api("/me/home", { vaultId }, "PUT");
    await p.close();
  });

  test("Import from Day One (F24): the journal page counts the export, asks, and shows the imported days", async () => {
    const { zipSync, strToU8 } = await import("fflate");
    const iv = (await api("/vaults", { name: "Day One UI" })).id;
    const file = `${require("node:os").tmpdir()}/cp-dayone-ui.zip`;
    await Bun.write(
      file,
      zipSync({
        "Journal.json": strToU8(
          JSON.stringify({
            entries: [
              { uuid: "1", creationDate: "2019-05-04T08:00:00Z", timeZone: "Europe/London", text: "# Bluebells\nIn the woods at last\\." },
              { uuid: "2", creationDate: "2019-05-05T19:30:00Z", timeZone: "Europe/London", text: "Quiet evening." },
            ],
          }),
        ),
      }),
    );
    const p = await open(`/v/${iv}/journal`);
    await p.waitForSelector(".journal-main .muted");
    const [chooser] = await Promise.all([p.waitForFileChooser(), p.click('button[aria-label="Import from Day One"]')]);
    await chooser.accept([file]);
    await p.waitForFunction(() => document.querySelector(".modal h2")?.textContent === "Import 2 entries from Day One?");
    expect(await p.$eval(".modal", (e) => e.textContent)).toContain("on 2 days");
    await p.click(".modal button.primary");
    await p.waitForSelector(".journal-day");
    expect(await p.$$eval(".journal-day h3", (h) => h.map((x) => x.textContent))).toEqual(["Sunday 5 May 2019", "Saturday 4 May 2019"]);
    expect(await p.$eval(".journal-day:last-child", (e) => e.textContent)).toContain("Bluebells");
    await p.close();
  });

  test("press and hold Today offers a journal entry", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".today-button");
    await p.click(".today-button", { button: "right" });
    await p.waitForSelector(".menu-item");
    expect(await p.$$eval(".menu-item", (b) => b.map((x) => x.textContent))).toEqual(["Today's note", "New journal entry"]);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "New journal entry")!.click());
    await p.waitForSelector('textarea[aria-label="Journal entry"]');
    await p.keyboard.press("Escape");
    await p.close();
  });

  test("an app signing in (F25): the consent page names it, Allow sends a code back, and Connections lists it", async () => {
    const p = await open(await oauthClient("Claude"));
    await p.waitForSelector(".consent h2");
    expect(await p.$eval(".consent h2", (e) => e.textContent)).toBe("Let Claude use your notes?");
    expect(await p.$eval(".consent", (e) => e.textContent)).toContain("It returns to 127.0.0.1");
    await p.click(".consent label.check input");
    await Promise.all([p.waitForNavigation(), p.click(".consent-actions .primary")]);
    const back = new URL(p.url());
    expect([back.pathname, back.searchParams.get("state"), !!back.searchParams.get("code")]).toEqual(["/oauth-test-callback", "ui", true]);
    // The code isn't exchanged here (the e2e tests do that), so nothing is listed yet; an unknown app is explained, not followed.
    const seen = errors.length;
    await p.goto(`${BASE}/oauth/authorize?client_id=cpo_nobody&response_type=code`);
    await p.waitForSelector(".consent .error");
    expect(await p.$eval(".consent .error", (e) => e.textContent)).toContain("isn't registered");
    errors.splice(seen, errors.length - seen, ...errors.slice(seen).filter((e) => !e.includes("status of 400"))); // the refusal, as expected
    await p.close();
  });

  test("the library's name heads the file panel, and the tab says note · collection · library", async () => {
    const n = await note("Wide/Library.md", "# Library\n");
    const p = await openNote(n.id);
    if (!(await p.$(".app.left-open"))) await p.click('button[aria-label="Files"]');
    const lib = await p.$eval(".sidebar .library-name", (e) => e.textContent);
    expect(lib).toEndWith("'s Library");
    await until(async () => (await p.title()) === `Library · ${await p.$eval('select[aria-label="Collection"] option:checked', (o) => o.textContent!.replace(/ \(\d+ members\)$/, "").replace(/ · home$/, ""))} · ${lib}`);
    await p.close();
  });

  test("the theme: the button beside Trash steps Auto → Light → Dark, is remembered, and Settings offers the same", async () => {
    const n = await note("Wide/Theme.md", "# Theme\n");
    const p = await openNote(n.id);
    await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    if (!(await p.$(".app.left-open"))) await p.click('button[aria-label="Files"]');
    const bg = () => p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
    const attr = () => p.evaluate(() => document.documentElement.dataset.theme ?? "auto");
    const button = '.sidebar-foot button[aria-label^="Theme"]';
    expect(await attr()).toBe("auto");
    expect(await bg()).toBe("#fff");
    expect(await p.$eval(button, (b) => b.getAttribute("aria-label"))).toBe("Theme: Auto, following the system. Press for Light");
    await p.click(button);
    expect(await attr()).toBe("light");
    await p.click(button);
    expect(await attr()).toBe("dark");
    expect(await bg()).toBe("#1c1b22");
    await p.reload();
    await p.waitForSelector(".cm-content");
    expect(await attr()).toBe("dark");
    expect(await bg()).toBe("#1c1b22");
    // Light wins over a dark system; Auto follows it.
    await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "dark" }]);
    await p.click(button);
    expect(await attr()).toBe("auto");
    expect(await bg()).toBe("#1c1b22");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-foot button.account")][0]!.click());
    await p.waitForSelector('[role=radiogroup][aria-label="Theme"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[role=radiogroup][aria-label="Theme"] button')].find((b) => b.textContent?.includes("Light"))!.click());
    expect(await attr()).toBe("light");
    expect(await bg()).toBe("#fff");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>('[role=radiogroup][aria-label="Theme"] button')].find((b) => b.textContent?.includes("Auto"))!.click());
    expect(await attr()).toBe("auto");
    await p.close();
  });

  test("the panels' drag handles: drag and arrow keys change the width, which is remembered, and double-click puts it back", async () => {
    const n = await note("Wide/Panels.md", "# Panels\n");
    const p = await openNote(n.id);
    if (!(await p.$(".app.left-open"))) await p.click('button[aria-label="Files"]');
    if (!(await p.$(".app.right-open"))) await p.click('button[aria-label="Side panel"]');
    const width = (sel: string) => p.$eval(sel, (e) => Math.round(e.getBoundingClientRect().width));
    await until(async () => (await width(".right-panel")) === 280);
    const box = (await (await p.$(".panel-resizer.right"))!.boundingBox())!;
    await p.mouse.move(box.x + 4, box.y + 200);
    await p.mouse.down();
    await p.mouse.move(box.x - 116, box.y + 200, { steps: 5 });
    await p.mouse.up();
    await until(async () => (await width(".right-panel")) === 400);
    await p.focus(".panel-resizer.left");
    await p.keyboard.press("ArrowRight");
    await until(async () => (await width(".sidebar")) === 288);
    expect(await p.$eval(".panel-resizer.left", (e) => e.getAttribute("aria-valuenow"))).toBe("288");
    await p.reload();
    await until(async () => (await width(".right-panel").catch(() => 0)) === 400);
    expect(await width(".sidebar")).toBe(288);
    await p.click(".panel-resizer.right", { count: 2 });
    await p.click(".panel-resizer.left", { count: 2 });
    await until(async () => (await width(".right-panel")) === 280 && (await width(".sidebar")) === 272);
    await p.close();
  });

  test("the graph's timeline: notes by their dates, a range by keyboard, Hide the rest, the address, and Play", async () => {
    await note("Dated/Kickoff.md", "---\ndate: 2025-01-10\n---\n# Kickoff\n");
    await note("Dated/Review.md", "---\ndate: 2025-03-20\n---\n# Review\n\nAfter [[Kickoff]].\n");
    await note("Dated/Launch.md", "---\ncreated: 2025-06-02\n---\n# Launch\n\nAfter [[Review]].\n");
    const p = await open(`/v/${vaultId}/graph?folder=Dated`);
    await p.waitForSelector(".graph-view .graph-canvas");
    const timelineButton = () => p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".graph-bar button")].find((b) => b.textContent?.includes("Timeline"))!.click());
    await timelineButton();
    await p.waitForSelector(".graph-timeline");
    const words = () => p.$eval(".timeline-words", (e) => e.textContent ?? "");
    expect(await words()).toBe("Showing 3 notes, 10 January to 2 June 2025");
    expect(await p.$$eval(".timeline-bar", (l) => l.length)).toBe(6); // January to June, empty months too
    // The end handle back a month (Page Down), then the start on a day (arrow): two notes, then one.
    await p.focus(".timeline-to");
    await p.keyboard.press("PageDown");
    await until(async () => (await words()) === "Showing 2 notes, 10 January to 2 May 2025");
    expect(await p.$eval(".timeline-to", (e) => e.getAttribute("aria-valuetext"))).toBe("2 May 2025");
    await p.focus(".timeline-from");
    await p.keyboard.press("ArrowRight");
    await until(async () => (await words()) === "Showing 1 note, 11 January to 2 May 2025");
    expect(new URL(p.url()).searchParams.get("from")).toBe("2025-01-11");
    expect(new URL(p.url()).searchParams.get("to")).toBe("2025-05-02");
    await p.evaluate(() => [...document.querySelectorAll<HTMLLabelElement>(".graph-timeline label")].find((l) => l.textContent?.includes("Hide the rest"))!.querySelector("input")!.click());
    // The address opens the same range.
    const q = new URL(p.url()).search;
    const again = await open(`/v/${vaultId}/graph${q}`);
    await again.waitForSelector(".graph-timeline");
    expect(await again.$eval(".timeline-words", (e) => e.textContent)).toBe("Showing 1 note, 11 January to 2 May 2025");
    await again.close();
    // Play runs from the first month to the last, then stops.
    await p.click('.graph-timeline button[aria-label^="Play"]');
    await p.waitForSelector('.graph-timeline button[aria-label="Pause"]');
    await until(async () => (await words()) === "Showing 3 notes, 10 January to 2 June 2025", 15000);
    await p.waitForSelector('.graph-timeline button[aria-label^="Play"]');
    // All dates, and closing the timeline takes the range out of the address.
    await p.click('.graph-timeline button[aria-label="Close the timeline"]');
    await p.waitForSelector(".graph-timeline", { hidden: true });
    expect(new URL(p.url()).searchParams.get("from")).toBeNull();
    await p.close();
  });
});

describe("help", () => {
  beforeAll(freshBrowser);
  const heading = (p: Page) => p.$eval(".help-page h1", (e) => e.textContent);

  test("opens from the file panel and ⌘K; links go between pages; pictures load and diagrams draw", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click('.sidebar-foot [aria-label="Help"]');
    await p.waitForSelector(".help-page h1");
    expect(await heading(p)).toBe("Help");
    expect(await p.$$eval(".help-nav > button", (b) => b.length)).toBe(23); // the topics (the tour's buttons are above them)
    await p.waitForFunction(() => !!document.querySelector(".help-page .mermaid-diagram")?.shadowRoot?.querySelector("svg"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>(".help-page a.internal-link")].find((a) => a.textContent === "Links and embeds")!.click());
    await p.waitForFunction(() => document.querySelector(".help-page h1")?.textContent === "Links and embeds");
    expect(await p.$eval(".help-nav button.on", (b) => b.textContent)).toBe("Links and embeds");
    await p.waitForFunction(() => {
      const imgs = [...document.querySelectorAll<HTMLImageElement>(".help-page img")];
      return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0);
    });
    await p.keyboard.press("Escape");
    await until(async () => !(await p.$(".help")));
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("keyboard shortcuts");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector(".help-page h1")?.textContent === "Keyboard shortcuts");
    await p.close();
  });

  test("on a phone the topics come first, and a page opens in their place with a way back", async () => {
    const p = await openNote((await note("Help on a phone.md", "# Help on a phone\n")).id, true);
    await p.click('button[aria-label="Files"]');
    await Bun.sleep(400); // the drawer slides in
    await p.click('.sidebar-foot [aria-label="Help"]');
    await p.waitForSelector(".help-nav button");
    expect(await p.$(".help-page")).toBeNull();
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".help-nav button")].find((b) => b.textContent === "On the iPhone")!.click());
    await p.waitForFunction(() => document.querySelector(".help-page h1")?.textContent === "On the iPhone");
    expect(await p.$eval(".help-nav", (n) => getComputedStyle(n).display)).toBe("none");
    await p.click(".settings-back");
    await p.waitForFunction(() => !document.querySelector(".help-page") && !!document.querySelector(".help-nav button"));
    await p.close();
  });
});

describe("block handle (F12)", () => {
  beforeAll(freshBrowser);
  const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
  /** Hover a line so its handle shows; the handle's grip and + as screen points. */
  const hoverLine = async (p: Page, text: string) => {
    const r = (await rowOfLine(p, text))!;
    await p.mouse.move(r.x + 30, r.y + r.height / 2);
    await p.waitForSelector(".cm-block-handle:not([hidden])");
    await Bun.sleep(50);
    const box = async (sel: string) => {
      const b = (await (await p.$(sel))!.boundingBox())!;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    };
    return { grip: await box(".cm-block-grip"), plus: await box(".cm-block-plus"), line: r };
  };

  test("dragging a list item moves it with its sub-items, while someone else types; Undo puts it back", async () => {
    const start = "# Plan\n\n- Alpha\n  - one\n  - two\n- Beta\n- Gamma\n\nEnd";
    const n = await note("Drag.md", start);
    const [a, b] = [await openNote(n.id), await openNote(n.id)];
    // Someone else is typing at the end of the note.
    await b.bringToFront();
    await b.click(".cm-content");
    await b.keyboard.down("Meta");
    await b.keyboard.press("ArrowDown");
    await b.keyboard.up("Meta");
    await b.keyboard.type(" and more");
    await a.bringToFront();
    await until(async () => (await content(a)).includes("End and more"));
    const { grip } = await hoverLine(a, "Alpha");
    const to = (await rowOfLine(a, "Gamma"))!;
    await a.mouse.move(grip.x, grip.y);
    await a.mouse.down();
    for (let i = 1; i <= 8; i++) await a.mouse.move(grip.x, grip.y + ((to.y + to.height * 0.8 - grip.y) * i) / 8);
    await a.waitForSelector(".cm-block-drop:not([hidden])");
    await a.mouse.up();
    await until(async () => (await raw(n.id)).includes("- Beta\n- Gamma\n- Alpha\n  - one\n  - two\n\nEnd"));
    // The other person's typing survived, and they see the move.
    expect(await raw(n.id)).toContain("End and more");
    await until(async () => (await content(b)).indexOf("Gamma") < (await content(b)).indexOf("Alpha"));
    await a.click(".cm-content");
    await a.keyboard.down("Meta");
    await a.keyboard.press("z");
    await a.keyboard.up("Meta");
    await until(async () => (await raw(n.id)).startsWith(start));
    await a.close();
    await b.close();
  });

  test("+ adds a line below with the / menu open; ⋮⋮ turns a block into a to-do and deletes one with Undo", async () => {
    const n = await note("Handle.md", "First idea\n\nSecond idea");
    const p = await openNote(n.id);
    const { plus } = await hoverLine(p, "First idea");
    await p.mouse.click(plus.x, plus.y);
    await p.waitForSelector(".cm-tooltip-autocomplete");
    await p.keyboard.type("h2");
    await p.waitForFunction(() => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes("Heading 2"));
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.keyboard.type("Between");
    await until(async () => (await raw(n.id)) === "First idea\n\n## Between\n\nSecond idea");

    let h = await hoverLine(p, "Second idea");
    await p.mouse.click(h.grip.x, h.grip.y);
    await p.waitForSelector(".menu.popover");
    await p.click(".menu.popover .menu-item:nth-child(1)"); // Turn into…
    await p.waitForSelector(".choose input");
    await p.keyboard.type("to-do");
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).endsWith("\n- [ ] Second idea"));

    h = await hoverLine(p, "First idea");
    await p.mouse.click(h.grip.x, h.grip.y);
    await p.waitForSelector(".menu.popover");
    const del = await p.evaluateHandle(() => [...document.querySelectorAll(".menu.popover .menu-item")].find((b) => b.textContent === "Delete"));
    await (del as any).click();
    await until(async () => (await raw(n.id)) === "## Between\n\n- [ ] Second idea");
    await clickToast(p, "Undo");
    await until(async () => (await raw(n.id)) === "First idea\n\n## Between\n\n- [ ] Second idea");
    await p.close();
  });

  test("on a phone the ⋮⋮ sits by the cursor's block; a long press drags it", async () => {
    const n = await note("PhoneDrag.md", "Top line\n\nMiddle line\n\nBottom line");
    const p = await openNote(n.id, true);
    const r = (await rowOfLine(p, "Top line"))!;
    await p.touchscreen.tap(r.x + 40, r.y + r.height / 2);
    await p.waitForSelector(".cm-block-handle.touch:not([hidden])");
    const g = (await (await p.$(".cm-block-grip"))!.boundingBox())!;
    expect(Math.abs(g.y + g.height / 2 - (r.y + r.height / 2))).toBeLessThan(6); // beside that line
    const to = (await rowOfLine(p, "Bottom line"))!;
    const from = { x: g.x + g.width / 2, y: g.y + g.height / 2 };
    await p.touchscreen.touchStart(from.x, from.y);
    await Bun.sleep(550);
    for (let i = 1; i <= 8; i++) await p.touchscreen.touchMove(from.x, from.y + ((to.y + to.height * 0.8 - from.y) * i) / 8);
    await p.touchscreen.touchEnd();
    await until(async () => (await raw(n.id)) === "Middle line\n\nBottom line\n\nTop line");
    await p.close();
  });
});

describe("GitHub vaults (F14)", () => {
  beforeAll(freshBrowser);
  const gh = startFakeGitHub(3286);
  afterAll(() => gh.stop());
  let gv = 0;
  const barText = (p: Page) => p.$eval(".branch-bar", (e) => e.textContent ?? "");

  test("New vault from GitHub, not connected yet: Connect opens Settings → Connections over the dialog, and connecting there carries on", async () => {
    await api("/me/github", undefined, "DELETE");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector('select[aria-label="Collection"]');
    await p.select('select[aria-label="Collection"]', "github");
    await p.waitForFunction(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Connect GitHub…"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Connect GitHub…")!.click());
    await p.waitForSelector('input[aria-label="GitHub token"]');
    expect(await p.$eval(".settings-nav [aria-current=page]", (e) => e.textContent)).toStartWith("Connections");
    await p.type('input[aria-label="GitHub token"]', TOKEN);
    await p.click(".github-connect button.primary");
    await p.waitForFunction(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Disconnect"));
    await p.keyboard.press("Escape");
    await until(async () => (await p.$$(".modal")).length === 1);
    await p.waitForSelector('select[aria-label="Repository"] option[value="sam/house"]');
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("New collection from GitHub");
    await p.close();
  });

  test("New vault from GitHub: pick the repo and folder; the bar shows the branch and what changed, on the laptop and the iPhone", async () => {
    await api("/me/github", { token: TOKEN }, "PUT");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector('select[aria-label="Collection"]');
    await p.select('select[aria-label="Collection"]', "github");
    await p.waitForSelector('select[aria-label="Folder"] option[value="docs"]');
    await p.select('select[aria-label="Folder"]', "docs");
    await p.waitForFunction(() => document.querySelector(".modal button.primary")?.textContent === "Copy 3 notes in");
    await p.click(".modal button.primary");
    await p.waitForSelector(".branch-bar .branch-count");
    gv = Number(/\/v\/(\d+)/.exec(p.url())![1]);
    expect(await barText(p)).toContain("Same as main");
    const boiler = ((await api(`/vaults/${gv}/notes`)) as any[]).find((n) => n.path === "Boiler.md");
    await p.goto(`${BASE}/v/${gv}/n/${boiler.id}`);
    await p.waitForSelector(".cm-content");
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type("Checked the flue.");
    await p.waitForFunction(() => document.querySelector(".branch-bar")?.textContent?.includes("1 note changed"), { timeout: 8000 });
    expect(await barText(p)).toContain("On commonplace/boiler");
    // The iPhone keeps the bar in the Files drawer, leaving the note the screen, with a dot on Files.
    const phone = await open(`/v/${gv}/n/${boiler.id}`, true);
    await phone.waitForSelector('.note-header .panel-toggle[aria-label="Files, changes not on GitHub yet"] .toggle-badge');
    expect(await phone.$(".main .branch-bar")).toBeNull();
    await phone.click(".note-header .panel-toggle");
    await phone.waitForFunction(() => document.querySelector(".sidebar .branch-bar")?.textContent?.includes("1 note changed"));
    await Bun.sleep(400); // the drawer slides in
    const bar = (await (await phone.$(".sidebar .branch-bar"))!.boundingBox())!;
    expect(bar.x).toBeGreaterThanOrEqual(0);
    expect(bar.x + bar.width).toBeLessThanOrEqual(390);
    // One line on a phone: the count and Send/⋯; the branch's name is on the changes page.
    expect(bar.height).toBeLessThanOrEqual(50);
    expect(await phone.$eval(".sidebar .branch-line", (e) => getComputedStyle(e).display)).toBe("none");
    // Searching folds away what's above the box, so it sits at the top, clear of the keyboard;
    // it stays folded while there are words in it, and comes back when they're cleared.
    const shown = (sel: string) => phone.$eval(sel, (e) => getComputedStyle(e).display !== "none");
    await phone.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar .tabs button")].find((b) => b.textContent === "Search")!.click());
    await phone.waitForSelector(".search-panel input");
    // The Search tab puts the cursor in the box; leaving it empty brings the panel back.
    await phone.focus(".search-panel input");
    await until(async () => !(await shown(".sidebar .vault-switch")));
    await phone.evaluate(() => (document.activeElement as HTMLElement).blur());
    await until(() => shown(".sidebar .vault-switch"));
    await phone.focus(".search-panel input");
    await until(async () => !(await shown(".sidebar .vault-switch")));
    expect(await shown(".sidebar .branch-bar")).toBe(false);
    expect(await shown(".sidebar .sidebar-actions")).toBe(false);
    expect(await shown(".sidebar .tabs")).toBe(true);
    expect((await (await phone.$(".search-panel input"))!.boundingBox())!.y).toBeLessThan(150);
    await phone.keyboard.type("flue");
    await phone.evaluate(() => (document.activeElement as HTMLElement).blur());
    expect(await shown(".sidebar .vault-switch")).toBe(false);
    await phone.$eval(".search-panel input", (e) => {
      const i = e as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(i, "");
      i.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await until(() => shown(".sidebar .vault-switch"));
    await phone.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar .tabs button")].find((b) => b.textContent === "Files")!.click());
    await phone.click(".sidebar .branch-count");
    await phone.waitForSelector(".change-edited");
    expect(await phone.$(".app.left-open")).toBeNull();
    await phone.close();
    await p.close();
  });

  test("Review changes shows the diff; Open pull request sends one commit to a new branch with a PR", async () => {
    const p = await open(`/v/${gv}`);
    await p.waitForSelector(".branch-count");
    await p.click(".branch-count");
    await p.waitForSelector(".change-edited");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".change-edited button")].find((b) => b.textContent === "Diff")!.click());
    await p.waitForSelector(".change .diff .diff-add");
    expect(await p.$eval(".change .diff .diff-add", (e) => e.textContent)).toContain("Checked the flue.");
    await p.click('.branch-bar button[aria-label="Open pull request"]');
    await p.waitForSelector(".pr-form");
    expect(await p.$eval('.pr-form input[required]', (e) => (e as HTMLInputElement).value)).toBe("commonplace/boiler");
    await p.click(".pr-form button.primary");
    await p.waitForSelector(".branch-pr");
    expect(await p.$eval(".branch-pr", (e) => e.textContent)).toContain("#1");
    expect(gh.files("commonplace/boiler")["docs/Boiler.md"]).toContain("Checked the flue.");
    expect(gh.files("main")["docs/Boiler.md"]).not.toContain("Checked the flue.");
    await p.close();
  });

  test("Cancel the branch asks first, then puts every note back", async () => {
    const p = await open(`/v/${gv}`);
    await p.waitForSelector('.branch-bar button[aria-label="Branch"]');
    await p.click('.branch-bar button[aria-label="Branch"]');
    await p.waitForSelector(".menu");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu .menu-item")].find((b) => b.textContent === "Cancel the branch")!.click());
    await p.waitForSelector("[data-dialog-action]");
    expect(await p.$eval(".dialog-message", (e) => e.textContent)).toContain("Pull request #1 stays open");
    await p.click("[data-dialog-action]");
    await p.waitForFunction(() => document.querySelector(".branch-bar")?.textContent?.includes("Same as main"));
    const boiler = ((await api(`/vaults/${gv}/notes`)) as any[]).find((n) => n.path === "Boiler.md");
    expect((await api(`/vaults/${gv}/notes/${boiler.id}`)).content).not.toContain("flue.");
    await p.close();
  });
});

describe("templates and daily notes", () => {
  beforeAll(freshBrowser);
  const read = async (path: string) => {
    const n = ((await api(`/vaults/${vaultId}/notes`)) as { id: number; path: string }[]).find((x) => x.path === path);
    return n ? ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string) : null;
  };

  test("Today uses Templates/Daily.md; the arrows and the calendar move between days", async () => {
    await note("Templates/Daily.md", "# {{date:dddd D MMMM}}\n\n## Plan\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click('.sidebar-actions button[title^="Today"]');
    const today = new Date();
    await until(async () => (await read(dailyPath(today))) === `# ${formatDate(today, "dddd D MMMM")}\n\n## Plan\n`);
    await p.waitForSelector(".day-nav");
    await p.click('.day-nav button[title="Previous day"]');
    const yesterday = addDays(today, -1);
    await until(async () => (await read(dailyPath(yesterday))) !== null);
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === formatDate(yesterday, "YYYY-MM-DD"));
    // The calendar marks both days and opens today's again.
    await p.waitForSelector(".calendar-day.has");
    expect(await p.$$eval(".calendar-day.has", (d) => d.length)).toBeGreaterThanOrEqual(1);
    await p.click(".calendar-day.today");
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === formatDate(today, "YYYY-MM-DD"));
    await p.close();
  });

  test("Insert template merges its properties and fills {{title}}", async () => {
    await note("Templates/Meeting.md", "---\ntags: [meeting]\nstatus: open\n---\n## Attendees\n- {{title}}\n");
    const n = await note("Standup.md", "---\nstatus: done\n---\n# Standup\n");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Insert template…")!.click());
    await p.waitForSelector(".choose-list li");
    await p.keyboard.type("meet");
    await p.keyboard.press("Enter");
    await until(async () => ((await read("Standup.md")) ?? "").includes("- Standup"));
    const text = (await read("Standup.md"))!;
    expect(text.match(/^---/gm)!.length).toBe(2); // still one frontmatter block
    expect(text).toContain("status: done"); // the note's own value wins
    expect(text).toMatch(/tags:[\s\S]*meeting/);
    await p.close();
  });

  test("New note from a template asks for a title", async () => {
    const p = await open(`/v/${vaultId}`);
    // The button appears once the note list (with its templates) has loaded.
    await p.waitForFunction(() => [...document.querySelectorAll(".quick-actions button")].some((b) => b.textContent?.includes("From a template")));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".quick-actions button")].find((b) => b.textContent?.includes("From a template"))!.click());
    await p.waitForSelector(".choose-list li");
    await p.keyboard.type("meet");
    await p.keyboard.press("Enter");
    await answer(p, "Board review");
    await until(async () => ((await read("Board review.md")) ?? "").includes("- Board review"));
    await p.close();
  });
});

describe("Settings (F17)", () => {
  beforeAll(freshBrowser);
  const current = (p: Page) => p.$eval(".settings-nav [aria-current=page]", (e) => e.textContent ?? "");
  const modalText = (p: Page) => p.$eval(".modal", (e) => e.textContent ?? "");
  const closeAll = async (p: Page) => {
    await p.keyboard.press("Escape");
    await until(async () => (await p.$$(".modal")).length === 0);
  };

  test("Setup (F20): a set of starter types in a click, home, and the menu marks home", async () => {
    const sv = (await api("/vaults", { name: "Setup test" })).id;
    const p = await open(`/v/${sv}`);
    await p.waitForSelector(".vault-home");
    await p.click('button[aria-label="Settings"]');
    await p.waitForSelector(".setup .starter-sets");
    await p.click('.starter-sets button[aria-label^="Add the Reference types"]');
    await until(async () => (await p.$$eval(".starter-sets button", (bs) => bs.map((b) => b.getAttribute("aria-label")))).includes("Reference types all added"));
    const types = ((await api(`/vaults/${sv}/types`)).types as { name: string }[]).map((t) => t.name).sort();
    expect(types).toEqual(["Article", "Source", "Topic"]);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".setup button")].find((b) => b.textContent === "Make this my home collection")!.click());
    await until(async () => (await modalText(p)).includes("Your home collection"));
    await until(async () => (await p.$eval('select[aria-label="Collection"] option:checked', (o) => o.textContent)) === "Setup test · home");
    await api("/me/home", { vaultId }, "PUT");
    await p.close();
  });

  test("AI-XF (F9): a new note gets an id; Export as AI-XF bundle asks once before giving the rest ids", async () => {
    const xv = (await api("/vaults", { name: "Bundle test" })).id;
    await api(`/vaults/${xv}/notes`, { path: "Older", content: "# Older\n" }); // made before ids were on: none
    await api(`/vaults/${xv}`, { noteIds: true }, "PATCH");
    const made = await api(`/vaults/${xv}/notes`, { path: "Kitchen plan", content: "# Kitchen plan\n" });
    expect(made.content).toContain("id: kitchen-plan");
    await api(`/vaults/${xv}/notes`, { path: "Daily/2026-10-30", content: "# Friday\n" }); // daily notes get none
    const p = await open(`/v/${xv}/n/${made.id}`);
    await p.waitForSelector(".note-body[data-synced]");
    // The id is kept out of sight: no properties panel for a note that has only its id.
    await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Kitchen plan"));
    expect(await p.$(".cm-lp-props")).toBeNull();
    expect(await p.$eval(".cm-content", (e) => e.textContent ?? "")).not.toContain("kitchen-plan");
    // ⌘K offers the id and the bundle.
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette li");
    const titles = await p.$$eval(".palette li .palette-title", (l) => l.map((e) => e.textContent));
    expect(titles).toContain("Copy the note's id");
    expect(titles).toContain("Export collection as AI-XF bundle");
    await p.keyboard.press("Escape");
    // Settings → This collection → Export: the older and daily notes need ids first, asked once.
    await p.click('button[aria-label="Settings"]');
    await p.waitForSelector(".settings-section");
    // Note the download's address and stop it there: headless Chrome holds on to a download.
    let downloaded = "";
    await p.setRequestInterception(true);
    p.on("request", (r) => {
      if (!r.url().includes("format=ai-xf")) return void r.continue();
      downloaded = r.url();
      void r.abort();
    });
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-section button")].find((b) => b.textContent === "Export as AI-XF bundle (.zip)")!.click());
    await until(async () => (await p.$$eval(".modal, [role=dialog], [role=alertdialog]", (l) => l.map((e) => e.textContent ?? "").join(" | "))).includes("Give 2 notes ids?"));
    await p.click("[data-dialog-action]");
    await until(() => downloaded.endsWith(`/api/vaults/${xv}/export?format=ai-xf`));
    expect((await api(`/vaults/${xv}/aixf/ids`)).missing).toBe(0);
    await p.close();
  });

  test("Setup on the Mac (F22): keep a collection in a new folder, and the menu groups it", async () => {
    const fv = (await api("/vaults", { name: "Mac notes" })).id;
    await api(`/vaults/${fv}/notes`, { path: "Hello.md", content: "# Hello" });
    const p = await open(`/v/${fv}`);
    await p.waitForSelector(".tree-row");
    await p.click('button[aria-label="Settings"]');
    await p.waitForSelector(".setup-facts");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".setup button")].find((b) => b.textContent === "Keep in a folder on this Mac…")!.click());
    await p.waitForSelector(".choose-list li");
    await p.keyboard.press("Enter"); // New folder…
    await p.waitForSelector(".modal input");
    await p.keyboard.type("Mac notes");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => [...document.querySelectorAll(".choose-label")].some((e) => e.textContent === "Both, kept in step"));
    await p.keyboard.press("Enter");
    await until(async () => (await modalText(p)).includes("In a folder on this Mac: ~/Commonplace/Mac notes"));
    await until(() => existsSync(join(FOLDERS, "Mac notes/Hello.md")));
    await until(async () => (await p.$$eval('select[aria-label="Collection"] optgroup', (g) => g.map((x) => x.getAttribute("label")))).includes("In folders on this Mac"));
    await api(`/vaults/${fv}/folder`, undefined, "DELETE");
    await p.close();
  });

  test("passkeys (F32): add one in Settings → Account, sign in with it on a signed-out browser, remove it and Undo", async () => {
    // Chrome's virtual authenticator stands in for Face ID: it says yes at once.
    const authenticator = async (page: Page) => {
      const cdp = await page.createCDPSession();
      await cdp.send("WebAuthn.enable");
      const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
        options: { protocol: "ctap2", transport: "internal", hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true },
      });
      return { cdp, authenticatorId };
    };
    const p = await open(`/v/${vaultId}`);
    const mine = await authenticator(p);
    try {
      await p.waitForSelector(".tree-row");
      await p.click("button.account");
      await p.waitForSelector(".passkeys");
      await p.waitForFunction(() => document.querySelector(".passkeys")?.textContent?.includes("No passkeys yet."));
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".passkeys button")].find((b) => b.textContent?.includes("Add a passkey"))!.click());
      await p.waitForSelector(".passkey-list li");
      expect(await p.$eval(".passkey-list li", (e) => e.textContent)).toContain("not used yet");

      // Another browser, signed out, with the same passkey (as iCloud Keychain would share it).
      const { credentials } = await mine.cdp.send("WebAuthn.getCredentials", { authenticatorId: mine.authenticatorId });
      expect(credentials).toHaveLength(1);
      const ctx = await browser.createBrowserContext();
      const out = await ctx.newPage();
      const theirs = await authenticator(out);
      await theirs.cdp.send("WebAuthn.addCredential", { authenticatorId: theirs.authenticatorId, credential: credentials[0]! });
      await out.goto(`${BASE}/`);
      await out.waitForSelector(".passkey-button");
      // The email box offers passkeys among its suggestions too.
      expect(await out.$eval("input[type=email]", (e) => e.getAttribute("autocomplete"))).toBe("username webauthn");
      // Chrome's stand-in answers the email box's suggestion by itself, so it may be in already;
      // otherwise the button.
      await out.evaluate(() => document.querySelector<HTMLButtonElement>(".passkey-button")?.click());
      await out.waitForSelector(".tree-row", { timeout: 15000 });
      expect(await out.$(".login-card")).toBeNull();
      await ctx.close();

      // Remove it, and Undo.
      await p.click('button[aria-label^="Remove the passkey"]');
      await p.waitForFunction(() => document.querySelector(".passkeys")?.textContent?.includes("No passkeys yet."));
      await p.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent?.includes("Removed the passkey")));
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".toast-action")].find((b) => b.textContent === "Undo")!.click());
      await p.waitForSelector(".passkey-list li");
    } finally {
      for (const k of (await api("/passkeys")) as { id: number }[]) await api(`/passkeys/${k.id}`, undefined, "DELETE");
      await p.close();
    }
  });

  test("Siri's links (L8 step 5): /find?q= opens the note by its title; /ask?q= sends the question to the assistant", async () => {
    const id = (await note("Siri zephyr service.md", "# Siri zephyr service\n\nDue in March.\n")).id;
    const p = await open(`/find?q=${encodeURIComponent("siri zephyr")}`);
    const panelWas = await p.evaluate(() => ({ "cp:right": localStorage.getItem("cp:right"), "cp:rightTab": localStorage.getItem("cp:rightTab") }));
    try {
      await p.waitForFunction((n) => location.pathname.endsWith(`/n/${n}`), {}, id);
      await p.waitForSelector(".cm-content");
      expect(await p.$eval(".cm-content", (e) => e.textContent)).toContain("Due in March");
      // Nothing by that name: said so, and the collection opens.
      await p.goto(`${BASE}/find?q=${encodeURIComponent("no such note anywhere")}`);
      await p.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent?.includes("No note called")));
      await p.waitForFunction(() => /^\/v\/\d+$/.test(location.pathname));
      // Ask: the side panel opens on the assistant with the question.
      await p.goto(`${BASE}/ask?q=${encodeURIComponent("When is the zephyr due?")}`);
      await p.waitForFunction(() => /^\/v\/\d+$/.test(location.pathname));
      await p.waitForFunction(() => document.querySelector(".app")?.classList.contains("right-ai"));
    } finally {
      // The side panel's tab and whether it's open are kept in the browser: put them back for the tests after.
      await p.evaluate((was) => Object.entries(was).forEach(([k, v]) => (v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v))), panelWas).catch(() => {});
      await p.close();
    }
  });

  test("two-step sign-in (F40): turn it on in Settings with the code app's code, keep the recovery codes, then sign in with password and code", async () => {
    const p = await open(`/v/${vaultId}`);
    const clickText = (page: Page, sel: string, text: string) =>
      page.evaluate((sel, text) => [...document.querySelectorAll<HTMLButtonElement>(sel)].find((b) => b.textContent?.includes(text))!.click(), sel, text);
    try {
      await p.waitForSelector(".tree-row");
      await p.click("button.account");
      await p.waitForSelector(".two-step");
      await clickText(p, ".two-step button", "Turn on two-step");
      await p.waitForSelector(".two-step-setup img");
      expect(await p.$eval(".two-step-setup a", (a) => a.getAttribute("href"))).toStartWith("otpauth://totp/");
      const secret = fromBase32(await p.$eval(".two-step-setup .secret", (e) => e.textContent!));
      const used = Math.floor(Date.now() / 30_000);
      await p.type('input[aria-label="Code from your code app"]', codeAt(secret, used));
      await p.type('.two-step-setup input[type="password"]', "password-ui");
      await p.click('.two-step-setup button[type="submit"]');
      await p.waitForSelector(".recovery-codes li");
      expect(await p.$$eval(".recovery-codes li", (l) => l.length)).toBe(10);
      await clickText(p, ".recovery button", "I've saved them");
      await p.waitForFunction(() => document.querySelector(".two-step")?.textContent?.includes("10 recovery codes left"));

      // A signed-out browser: the password, then the code.
      const ctx = await browser.createBrowserContext();
      const out = await ctx.newPage();
      await out.goto(`${BASE}/`);
      await out.waitForSelector(".login-card input[type=email]");
      await out.type(".login-card input[type=email]", "ui@example.com");
      await out.type(".login-card input[type=password]", "password-ui");
      await out.click(".login-card button.primary");
      await out.waitForSelector('input[aria-label="Code"]');
      expect(await out.$eval('input[aria-label="Code"]', (e) => e.getAttribute("autocomplete"))).toBe("one-time-code");
      await out.type('input[aria-label="Code"]', codeAt(secret, used + 1));
      await out.click(".login-card button.primary");
      await out.waitForSelector(".tree-row", { timeout: 15000 });
      await ctx.close();
    } finally {
      await api("/me/two-step", { password: "password-ui" }, "DELETE").catch(() => {});
      await p.close();
    }
  });

  test("Connected services (F30, F33): Longview with a read token; Recall signs in on its own page and the list updates by itself; Review shows its tools", async () => {
    const longview = startFakeLongview(3411);
    const recall = startFakeRecall(3412);
    const p = await open(`/v/${vaultId}`);
    try {
      await p.waitForSelector(".tree-row");
      await p.click('button[aria-label="Settings"]');
      await p.waitForSelector(".settings-nav");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
      await p.waitForFunction(() => [...document.querySelectorAll(".connection-add h4")].some((h) => h.textContent === "Recall"));
      // Longview: the address is filled in for the usual one; here, the fake's.
      await p.$eval('input[aria-label="Longview\'s address"]', (e) => (e as HTMLInputElement).select());
      await p.keyboard.type("http://localhost:3411/mcp");
      await p.type('input[aria-label="Longview read token"]', LONGVIEW_READ);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-section button")].find((b) => b.textContent === "Connect Longview")!.click());
      await p.waitForFunction(() => document.body.textContent?.includes("token …0001"));
      // Send to Longview (F30 step 4): a write token, kept apart from the read one.
      await p.waitForSelector(".longview-send summary"); // it loads its own state
      await p.evaluate(() => document.querySelector<HTMLElement>(".longview-send summary")!.click());
      await p.type('input[aria-label="Longview write token"]', LONGVIEW_WRITE);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".longview-send button")].find((b) => b.textContent === "Turn on")!.click());
      await p.waitForFunction(() => document.querySelector(".longview-send")?.textContent?.includes("Send to Longview is on (token …0002)"));
      // Recall: the button opens Recall's page in a new tab; signing in there shows here by itself.
      await p.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>("button")].some((b) => b.textContent?.includes("Connect Recall") && !b.disabled));
      const opened = new Promise<Page>((done) => browser.once("targetcreated", async (t) => done((await t.page())!)));
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Connect Recall"))!.click());
      const tab = await opened;
      await tab.waitForFunction(() => document.body?.textContent?.includes("Recall is connected"), { timeout: 15000 });
      await tab.close();
      await p.waitForFunction(() => document.body.textContent?.includes("signed in, read only"), { timeout: 15000 });
      // Review: the tools in their groups; a tool that changes things can't be turned on.
      recall.addTools([{ name: "delete_card", description: "Delete a card.", annotations: { destructiveHint: true } }]);
      await p.evaluate(() => [...document.querySelectorAll<HTMLLIElement>(".connection-list li")].find((li) => li.textContent?.includes("Recall"))!.querySelector<HTMLButtonElement>("button")!.click());
      await p.waitForSelector(".tool-group");
      await p.waitForFunction(() => [...document.querySelectorAll(".tool-group legend")].some((l) => l.textContent === "In the side panel"));
      expect(await p.$$eval(".tool-group legend", (l) => l.map((x) => x.textContent))).toEqual(["Read", "Changes things", "In the side panel"]);
      expect(await p.$eval(".tool-row.off input", (i) => (i as HTMLInputElement).disabled)).toBe(true);
      await p.click(".modal [data-dialog-action]");
      await p.waitForFunction(() => !document.querySelector(".tool-group"));

      // A Weblink note's ⋯ menu sends its address, with the reason typed; never the note.
      const weblink = (await note("Saved page.md", "---\ntype: Weblink\nurl: https://example.com/carbon\n---\n# Saved page\n\nMy own notes on it.\n")).id;
      const q = await openNote(weblink);
      try {
        await q.click('button[aria-label="More"]');
        await q.waitForFunction(() => [...document.querySelectorAll(".menu-item")].some((b) => b.textContent?.includes("Send to Longview")));
        await q.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Send to Longview"))!.click());
        await q.waitForSelector("[data-dialog-input]");
        await q.type("[data-dialog-input]", "Good numbers");
        await q.click("[data-dialog-action]");
        await q.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent?.includes("Sent to Longview")));
        expect(longview.seen.find((x) => x.tool === "save_url")?.args).toEqual({ url: "https://example.com/carbon", note: "Good numbers" });
        expect(JSON.stringify(longview.seen)).not.toContain("My own notes");
      } finally {
        await q.close();
      }
    } finally {
      for (const c of ((await api("/me/connections")) as { connections: { id: number }[] }).connections) await api(`/me/connections/${c.id}`, undefined, "DELETE").catch(() => {});
      longview.stop();
      recall.stop();
      await p.close();
    }
  });

  test("Add a connection (F33 step 2): look at an address, read the no-sign-in warning, connect, choose its tools and try it", async () => {
    const service = startFakeService(3413);
    const p = await open(`/v/${vaultId}`);
    try {
      await p.waitForSelector(".tree-row");
      await p.click('button[aria-label="Settings"]');
      await p.waitForSelector(".settings-nav");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
      await p.waitForFunction(() => [...document.querySelectorAll("button")].some((b) => b.textContent?.includes("Add a connection")));
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Add a connection"))!.click());
      await p.waitForSelector("#service-address");
      await p.type("#service-address", "http://localhost:3413/mcp");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector(".add-service[role=status]")?.textContent?.includes("Items 2.1, an MCP service. It doesn't ask who you are. It offers 4 tools: 2 read, 1 doesn't say what it does, 1 changes things."));
      // Connect waits for the warning to be read and confirmed.
      expect(await p.$eval(".modal [data-dialog-action]", (b) => (b as HTMLButtonElement).disabled)).toBe(true);
      await p.evaluate(() => [...document.querySelectorAll<HTMLLabelElement>(".notice.warning label")][0]!.click());
      await p.click(".modal [data-dialog-action]");
      // Review opens next: the read tools are on; Try it shows the service's answer.
      await p.waitForSelector(".tool-group");
      await p.waitForFunction(() => [...document.querySelectorAll(".tool-group legend")].some((l) => l.textContent === "In the side panel"));
      expect(await p.$$eval(".tool-group legend", (l) => l.map((x) => x.textContent))).toEqual(["Read", "Doesn't say", "Changes things", "In the side panel"]);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Try it")!.click());
      await p.waitForFunction(() => document.querySelector(".tool-tried pre")?.textContent?.includes("First item"));
      await p.click(".modal [data-dialog-action]");
      await p.waitForFunction(() => !document.querySelector(".tool-group"));
      await p.waitForFunction(() => document.body.textContent?.includes("no sign-in · 2 of 3 tools on"));
      // From your connections (F33 step 4): on in Review, then the open note's title looks it up.
      await p.evaluate(() => [...document.querySelectorAll<HTMLLIElement>(".connection-list li")].find((li) => li.textContent?.includes("Items"))!.querySelector<HTMLButtonElement>("button")!.click());
      await p.waitForFunction(() => [...document.querySelectorAll(".tool-group legend")].some((l) => l.textContent === "In the side panel"));
      await p.evaluate(() => [...document.querySelectorAll<HTMLLabelElement>(".tool-group label")].find((l) => l.textContent?.includes("Look up the open note"))!.click());
      await until(async () => ((await api("/me/connections")).connections as { panel: string | null }[]).some((c) => c.panel === "search_items"));
      await p.evaluate(() => document.querySelector<HTMLButtonElement>(".modal [data-dialog-action]")!.click());
      await p.waitForFunction(() => !document.querySelector(".tool-group"));
      const n = await note("Panel lookup.md", "Words that stay here.");
      await p.goto(`${BASE}/v/${vaultId}/n/${n.id}`, { waitUntil: "load" });
      await p.waitForFunction(() => document.querySelector(".from-connections")?.textContent?.includes("About Panel lookup"), { timeout: 10000 });
      expect(JSON.stringify(service.seen)).not.toContain("Words that stay here");
    } finally {
      for (const c of ((await api("/me/connections")) as { connections: { id: number }[] }).connections) await api(`/me/connections/${c.id}`, undefined, "DELETE").catch(() => {});
      service.stop();
      await p.close();
    }
  });

  test("one Settings screen: the gear opens This vault, the account button Account, and ⌘K finds a section by what it's about", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click('button[aria-label="Settings"]');
    await p.waitForSelector(".settings-nav [aria-current=page]");
    expect(await current(p)).toStartWith("This collection");
    expect(await modalText(p)).toContain("Members");
    await closeAll(p);
    await p.click("button.account");
    await p.waitForSelector(".settings-nav [aria-current=page]");
    expect(await current(p)).toStartWith("Account");
    // How you sign in (F40) loads with the account's state, a moment after the rest.
    await p.waitForFunction(() => document.querySelector(".modal")?.textContent?.includes("Change password"));
    expect(await modalText(p)).toContain("Two-step sign-in");
    // Reminders (F35): the switch and the time save at once and come back as saved.
    await p.waitForSelector("#reminder-time");
    expect(await p.$eval("#reminder-time", (e) => (e as HTMLInputElement).value)).toBe("09:00");
    await p.$eval("#reminder-time", (e) => {
      const input = e as HTMLInputElement;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "07:45");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await p.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("Reminders at 07:45"));
    expect((await p.evaluate(() => fetch("/api/me/reminders?days=1").then((r) => r.json()))).time).toBe("07:45");
    await p.evaluate(() => fetch("/api/me/reminders", { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ time: "09:00" }) }));
    await closeAll(p);
    for (const [words, section, shows] of [["github token", "Connections", "GitHub"], ["members", "Collection settings", "Members"], ["api key", "AI assistants", "AI assistants"]] as const) {
      await p.keyboard.down("Meta");
      await p.keyboard.press("k");
      await p.keyboard.up("Meta");
      await p.waitForSelector(".palette input");
      await p.keyboard.type(words);
      await p.waitForFunction((t) => [...document.querySelectorAll(".palette .palette-title")].some((e) => e.textContent === t), {}, section);
      await p.evaluate((t) => [...document.querySelectorAll<HTMLElement>(".palette .palette-title")].find((e) => e.textContent === t)!.click(), section);
      await p.waitForSelector(".settings-nav [aria-current=page]");
      expect(await modalText(p)).toContain(shows);
      await closeAll(p);
    }
    await p.close();
  });

  test("on the iPhone the list of sections comes first; a section opens in its place, with a way back", async () => {
    const p = await open(`/v/${vaultId}`, true);
    await (await p.waitForSelector('button[aria-label="Files"]', { visible: true }))!.click();
    await Bun.sleep(400); // the drawer slides in
    await p.click("button.account");
    await p.waitForSelector(".settings-pane");
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Account");
    expect(await p.$(".settings-nav")).not.toBeNull();
    expect(await p.$eval(".settings-nav", (e) => getComputedStyle(e).display)).toBe("none");
    await p.click(".settings-back");
    await p.waitForFunction(() => !document.querySelector(".settings-pane"));
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Settings");
    const rows = await p.$$eval(".settings-nav button", (b) => b.map((x) => x.querySelector(".settings-nav-text")!.firstChild!.textContent));
    expect(rows).toEqual(["Account", "This collection", "Website", "AI assistants", "Connections", "Admin"]);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
    await p.waitForSelector(".settings-pane");
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Connections");
    expect((await (await p.$(".modal"))!.boundingBox())!.width).toBeLessThanOrEqual(390);
    await p.close();
  });
});

describe("share from iPhone", () => {
  beforeAll(freshBrowser);
  test("Settings → Connections makes a capture token that saves to the inbox, and revoking it stops it", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click("button.account");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Create token")); // after the vault list loads
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Create token")!.click());
    await p.waitForSelector(".capture-setup code");
    const line = await p.$$eval(".capture-setup code", (c) => c.map((e) => e.textContent ?? "").find((t) => t.startsWith("Bearer "))!);
    const share = (auth: string) => fetch(`${BASE}/api/capture`, { method: "POST", headers: { authorization: auth }, body: "Buy grout" });
    expect((await share(line)).status).toBe(200);
    await until(async () => (await paths()).includes("Inbox.md"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".capture-setup button")].find((b) => b.textContent === "Done")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".members li")].some((li) => li.textContent?.includes("last used")));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".members .danger-link")].find((b) => b.textContent === "Revoke")!.click());
    await p.click("[data-dialog-action]");
    await until(async () => (await share(line)).status === 401);
    await p.close();
  });
});

describe("the iPhone app (L8)", () => {
  test("in the app, Share from iPhone says the app set sharing up; in Safari it offers the Shortcut", async () => {
    const p = await open(`/health`, true);
    await p.setUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Safari/604.1 CommonplaceApp/1.0");
    await p.goto(`${BASE}/v/${vaultId}`);
    const shareText = async (page: Page) => {
      // On a phone the account button is in the folded-away file panel.
      await page.waitForSelector("button.account");
      await page.evaluate(() => document.querySelector<HTMLButtonElement>("button.account")!.click());
      await page.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
      await page.waitForFunction(() => [...document.querySelectorAll(".modal h3")].some((h) => h.textContent === "Share from iPhone"));
      return page.evaluate(() => [...document.querySelectorAll(".modal h3")].find((h) => h.textContent === "Share from iPhone")!.nextElementSibling!.textContent ?? "");
    };
    expect(await shareText(p)).toContain("This app set it up when you signed in");
    await p.close();
    const safari = await open(`/v/${vaultId}`, true);
    expect(await shareText(safari)).toContain("Apple Shortcut");
    await safari.close();
  });
});

describe("connect Claude (MCP)", () => {
  beforeAll(freshBrowser);
  test("Settings → Connections makes an MCP token and shows the Claude Code command; the token works, then revokes", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.click("button.account");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".modal button")].some((b) => b.textContent === "Create MCP token"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Create MCP token")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".capture-setup code")].some((c) => c.textContent?.startsWith("claude mcp add")));
    const cmd = await p.$$eval(".capture-setup code", (c) => c.map((e) => e.textContent ?? "").find((t) => t.startsWith("claude mcp add"))!);
    const token = /Bearer (cpm_[\w-]+)/.exec(cmd)![1]!;
    expect(cmd).toContain(`${BASE}/mcp`);
    const list = () =>
      fetch(`${BASE}/mcp`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect((await (await list()).json()).result.tools.length).toBe(18);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".capture-setup button")].find((b) => b.textContent === "Done")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".members li")].some((li) => li.textContent?.includes("read and write")));
    await p.evaluate(() =>
      [...document.querySelectorAll(".members li")]
        .find((li) => li.textContent?.includes("read and write"))!
        .querySelector<HTMLButtonElement>(".danger-link")!
        .click(),
    );
    await p.click("[data-dialog-action]");
    await until(async () => (await list()).status === 401);
    await p.close();
  });
});

describe("bring your own AI", () => {
  beforeAll(freshBrowser);
  const fake = startFakeAi(3296);
  afterAll(() => fake.stop());
  const noteText = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
  const typeAtEnd = async (p: Page, text: string) => {
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type(text);
  };
  const ask = async (p: Page, scope: string, text: string) => {
    const box = await p.waitForSelector(`${scope} .ai-input textarea`);
    await box!.click();
    await p.keyboard.type(text);
    await p.keyboard.press("Enter");
  };
  const replies = (p: Page, scope: string) => p.$$eval(`${scope} .ai-reply`, (r) => r.map((e) => e.textContent ?? "").join(" | "));

  test("/boyai adds an assistant with its own key; Test checks it works", async () => {
    const n = await note("Plan.md", "# Plan\n\n");
    const p = await openNote(n.id);
    await typeAtEnd(p, "/boyai");
    await p.waitForSelector(".cm-tooltip-autocomplete");
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".assistant-form");
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Bring your own AI");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".assistant-form [role=radio]")].find((b) => b.textContent === "Other")!.click());
    const fill = async (label: string, value: string) => {
      const input = await p.evaluateHandle((l) => [...document.querySelectorAll(".assistant-form label")].find((x) => x.querySelector(".field-label")?.textContent === l)!.querySelector("input"), label);
      await (input as any).click();
      await (input as any).evaluate((e: HTMLInputElement) => e.select());
      await p.keyboard.type(value);
    };
    expect(await p.$eval(".assistant-form input", (e) => (e as HTMLInputElement).value)).toBe("Assistant"); // the name follows the provider until you type one
    await fill("Name", "Claude");
    await fill("Base URL", `${fake.url}/v1`);
    await fill("Model", "test-model");
    await fill("API key", "fake-ui-key");
    // An unknown model needs its price for the £1 daily limit.
    expect(await p.$eval(".assistant-form", (e) => e.textContent)).toContain("Enter the model's price");
    const price = async (label: string, v: string) => {
      await p.click(`input[aria-label="${label}"]`);
      await p.keyboard.type(v);
    };
    await price("Price per million input tokens, in pounds", "0.5");
    await price("Price per million output tokens, in pounds", "2");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".assistant-form button")].find((b) => b.textContent === "Test")!.click());
    await p.waitForSelector(".assistant-form .ok");
    expect(await p.$eval(".assistant-form .ok", (e) => e.textContent)).toContain("It works");
    await p.click(".assistant-form button[type=submit]");
    await p.waitForSelector(".assistant-form", { hidden: true });
    const mine = await api("/me/assistants");
    expect(mine).toMatchObject([{ name: "Claude", provider: "compatible", model: "test-model", key_hint: "-key", price: { in: 0.5, out: 2 }, daily_cap: 1 }]);
    expect(JSON.stringify(mine)).not.toContain("fake-ui-key");
    expect(fake.seen.at(-1)!.headers.authorization).toBe("Bearer fake-ui-key");
    await p.close();
  });

  test("@Claude opens a chat under the line; it writes into the note live; ✓ keeps it as a callout", async () => {
    await note("Boiler.md", "# Boiler\n\nService due in March.\n");
    const n = await note("Plan 2.md", "# Plan 2\n\n");
    const p = await openNote(n.id);
    await typeAtEnd(p, "@Cl");
    await p.waitForFunction(() => [...document.querySelectorAll(".cm-completionLabel")].some((e) => e.textContent === "@Claude"));
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".cm-ai-inline .ai-chat");
    expect(await content(p)).not.toContain("@Cl"); // the mention itself is not left in the note
    fake.script.push({ text: "Looking.", calls: [{ name: "search_notes", input: { query: "boiler" } }] }, { calls: [{ name: "append_to_note", input: { note: "Plan 2", text: "- Boiler service in March ([[Boiler]])" } }] }, { text: "Added it." });
    // The box has focus: typing goes to it, not the note.
    await until(() => p.evaluate(() => document.activeElement?.closest(".cm-ai-inline") !== null));
    await p.keyboard.type("Add the boiler here");
    await p.keyboard.press("Enter");
    await until(async () => (await content(p)).includes("Boiler service in March"), 8000);
    await until(async () => (await replies(p, ".cm-ai-inline")).includes("Added it."));
    expect(await p.$$eval(".cm-ai-inline .ai-tool", (t) => t.map((e) => e.textContent?.trim()))).toEqual(["Searched for “boiler”: 1 found", "Changed Plan 2.md"]);
    expect(await p.$eval(".cm-ai-inline .ai-cost", (e) => e.textContent)).toBe("≈ under 1p");
    expect(await p.$eval(".cm-ai-inline .ai-cost", (e) => e.getAttribute("title"))).toContain("of its £1.00 limit");
    await p.click('.cm-ai-inline button[aria-label="Keep in the note"]');
    await p.waitForSelector(".cm-ai-inline", { hidden: true });
    await until(async () => (await noteText(n.id)).includes("> [!ai]- Claude,"), 8000);
    const text = await noteText(n.id);
    expect(text).toContain("> **Ui:** Add the boiler here");
    expect(text).toContain("> **Claude:** Looking.");
    await p.close();
  });

  test("⌘J opens the AI panel; a new page waits for Apply, with a diff, and Undo takes it back; Discard leaves the note", async () => {
    const n = await note("Plan 3.md", "# Plan 3\n\n- one\n");
    const p = await openNote(n.id);
    await p.keyboard.down("Meta");
    await p.keyboard.press("j");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".right-panel .ai-panel textarea");
    fake.script.push({ text: "Here's a page.", calls: [{ name: "create_note", input: { path: "Boiler summary", content: "# Boiler summary\n\nService in March.\n" } }] }, { text: "Done." });
    await ask(p, ".ai-panel", "Make a boiler page");
    await p.waitForSelector(".ai-change");
    expect(await p.$eval(".ai-change-head", (e) => e.textContent)).toContain("Create “Boiler summary”");
    expect(await p.$$eval(".ai-change .diff-add", (l) => l.length)).toBe(3);
    expect(await paths()).not.toContain("Boiler summary.md");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".ai-change button")].find((b) => b.textContent === "Apply")!.click());
    await until(async () => (await paths()).includes("Boiler summary.md"));
    await until(async () => (await replies(p, ".ai-panel")).includes("Done."));
    await clickToast(p, "Undo");
    await until(async () => !(await paths()).includes("Boiler summary.md"));

    fake.script.push({ calls: [{ name: "rewrite_note", input: { note: "Plan 3", content: "# Plan 3\n\n| one |\n" } }] }, { text: "Left it as it was." });
    await ask(p, ".ai-panel", "Make it a table");
    await p.waitForSelector(".ai-change .diff-del");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".ai-change button")].find((b) => b.textContent === "Discard")!.click());
    await until(async () => (await replies(p, ".ai-panel")).includes("Left it as it was."));
    expect(await noteText(n.id)).toBe("# Plan 3\n\n- one\n");
    await p.close();
  });

  test("it can drive the app: hiding the file panel through the command list", async () => {
    const n = await note("Plan 4.md", "# Plan 4\n");
    const p = await openNote(n.id);
    // The panel remembers it was left open on the AI tab.
    await p.waitForSelector(".ai-panel textarea");
    const tools = () => fake.seen.at(-1)!.body.tools.map((t: any) => t.function.name);
    fake.script.push({ calls: [{ name: "run_app_command", input: { command: "view.files" } }] }, { text: "Hidden." });
    await ask(p, ".ai-panel", "Hide the file panel");
    await until(() => p.$eval(".sidebar", (e) => getComputedStyle(e).visibility === "hidden"));
    await until(async () => (await replies(p, ".ai-panel")).includes("Hidden."));
    expect(tools()).toContain("run_app_command");
    expect(fake.seen.at(-1)!.body.messages.at(-1)).toMatchObject({ role: "tool", content: "Ran “Show or hide the file panel”" });
    await p.evaluate(() => (localStorage.setItem("cp:left", "1"), localStorage.setItem("cp:right", "1"), localStorage.setItem("cp:rightTab", "links")));
    await p.close();
  });

  test("on the iPhone the formatting bar is one row, and keeps no room for the home indicator while the keyboard is up (N16)", async () => {
    const n = await note("Phone bar.md", "# Phone bar\n");
    const p = await openNote(n.id, true);
    await p.waitForSelector(".format-bar.only-touch");
    // Headless Chrome has no keyboard or home indicator: the class main.tsx sets when the
    // keyboard takes the screen, and the rule it turns on, are what's checked here.
    await p.evaluate(() => document.documentElement.classList.add("keyboard-up"));
    const bar = await p.$eval(".format-bar", (e) => ({ pad: getComputedStyle(e).paddingBottom, h: e.getBoundingClientRect().height, b: e.querySelector("button")!.getBoundingClientRect().height }));
    expect(bar.pad).toBe("4px");
    expect(bar.h).toBeLessThan(bar.b * 1.5);
    await p.close();
  });

  test("on the iPhone, @Claude opens a bottom sheet over the formatting bar", async () => {
    const n = await note("Phone plan.md", "# Phone plan\n\n");
    const p = await openNote(n.id, true);
    await p.tap(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type("@Cl");
    await p.waitForFunction(() => [...document.querySelectorAll(".cm-completionLabel")].some((e) => e.textContent === "@Claude"));
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".ai-sheet .ai-chat");
    expect(await p.$(".cm-ai-inline")).toBeNull();
    const sheet = (await (await p.$(".ai-sheet"))!.boundingBox())!;
    expect(sheet.y + sheet.height).toBeGreaterThan(800); // at the bottom of the 844 pt screen
    await p.click('.ai-sheet button[aria-label="Discard"]');
    await p.waitForSelector(".ai-sheet", { hidden: true });
    await p.close();
  });

  test("Reflect on this week (F24): ⌘K hands the assistant the week's journal and a request, in the side panel", async () => {
    const rv = (await api("/vaults", { name: "Reflect UI" })).id;
    await api("/me/home", { vaultId: rv }, "PUT");
    const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await api("/journal", { text: "Fixed the fence; felt good.", vaultId: rv, day: day(new Date(Date.now() - 2 * 86_400_000)), time: "18:00" });
    await api("/journal", { text: "Long month, glad it's over.", vaultId: rv, day: day(new Date(Date.now() - 20 * 86_400_000)), time: "09:00" });
    fake.script.push({ text: "A steady, practical week." });
    const p = await open(`/v/${rv}`);
    await p.waitForSelector(".vault-home, .tree-row, main");
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("Reflect on this week");
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector(".ai-panel .ai-reply")?.textContent?.includes("A steady, practical week."));
    const sent = JSON.stringify(fake.seen.at(-1)!.body);
    expect(sent).toContain("Reflect on my journal for the past week");
    expect(sent).toContain("Fixed the fence; felt good.");
    expect(sent).not.toContain("Long month"); // older than the week
    await api("/me/home", { vaultId }, "PUT");
    await p.evaluate(() => localStorage.setItem("cp:rightTab", "links")); // as the tests after expect
    await p.close();
  });
});

describe("types (F16)", () => {
  beforeAll(freshBrowser);
  let sam = 0;
  const choose = async (p: Page, label: string) => {
    await p.waitForSelector("[data-dialog-input]");
    await p.keyboard.type(label);
    await Bun.sleep(100);
    await p.keyboard.press("Enter");
    await p.waitForSelector("[data-dialog-input]", { hidden: true });
  };
  const read = async (path: string) => {
    const n = ((await api(`/vaults/${vaultId}/notes`)) as any[]).find((x) => x.path === path);
    return n ? ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string) : null;
  };

  test("a type page: sidebar → table → edit a cell → save a view as .base", async () => {
    await note("Types/Person.md", "---\nicon: user\ncolour: blue\nproperties:\n  - name: role\n    kind: select\n    options: [Builder, Friend]\n  - name: phone\n    kind: text\n---\n# {{title}}\n\n## Notes\n");
    await note("Types/Meeting.md", "---\nicon: calendar\nproperties:\n  - name: attendees\n    kind: relation\n    type: Person\n    many: true\n---\n# {{title}}\n\n## Agenda\n");
    sam = (await note("People/Sam.md", "---\ntype: Person\nrole: Builder\n---\n# Sam\n")).id;
    await note("People/Alex.md", "---\ntype: Person\n---\n# Alex\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForFunction(() => [...document.querySelectorAll(".types-list .type-row")].some((b) => b.textContent?.includes("Person")));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".type-row")].find((b) => b.textContent?.includes("Person"))!.click());
    await p.waitForSelector(".type-table tbody tr");
    expect(await p.$$eval(".type-table tbody .type-row-title", (r) => r.map((e) => e.textContent))).toEqual(["Alex", "Sam"]);
    // Alex's role, from the select in the table.
    await p.select(".type-table tbody tr:first-child select", "Friend");
    await until(async () => (await read("People/Alex.md"))?.includes("role: Friend") ?? false);
    // Group by role, save the view, and it's a Bases (`.base`) file.
    await p.select('select[aria-label="Group by"]', "role");
    await p.waitForSelector(".type-group h3");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent?.includes("Save view"))!.click());
    await answer(p, "By role");
    await p.waitForFunction(() => [...document.querySelectorAll(".type-views [role=tab]")].some((t) => t.textContent === "By role"));
    const views = (await api(`/vaults/${vaultId}/types/Person`)).views as string;
    expect(views).toContain('type == "Person"');
    expect(views).toContain("groupBy:\n      property: note.role");
    await p.close();
  });

  test("New Person uses the type's template; the chip changes a note's type", async () => {
    const p = await open(`/v/${vaultId}/t/Person`);
    await p.waitForSelector(".type-table, .type-list");
    await p.waitForFunction(() => [...document.querySelectorAll("button.primary")].some((b) => b.textContent?.includes("New"))); // once the vault's types load
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>("button.primary")].find((b) => b.textContent?.includes("New"))!.click());
    await answer(p, "Jo");
    await p.waitForSelector(".cm-content");
    await until(async () => (await read("Jo.md")) === "---\ntype: Person\n---\n# Jo\n\n## Notes\n");
    await p.waitForSelector(".type-chip");
    expect(await p.$eval(".type-chip", (e) => e.textContent?.trim())).toBe("Person");
    await p.click(".type-chip");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Make it a Meeting")!.click());
    await until(async () => (await read("Jo.md"))?.startsWith("---\ntype: Meeting\n") ?? false);
    await p.close();
  });

  test("a relation picks from the right type; the other side says 'As attendees'", async () => {
    const m = await note("Meetings/Kickoff.md", "---\ntype: Meeting\n---\n# Kickoff\n");
    const p = await openNote(m.id);
    await p.waitForSelector('.prop-row[data-key="attendees"].prop-ghost .prop-relation-add');
    await p.click('.prop-row[data-key="attendees"] .prop-relation-add');
    await p.waitForSelector("[data-dialog-input]");
    const offered = await p.$$eval(".choose-option, .modal li", (o) => o.map((e) => e.textContent ?? ""));
    expect(offered.some((t) => t.includes("Sam"))).toBe(true);
    expect(offered.some((t) => t.includes("Kickoff"))).toBe(false); // not a Person
    await choose(p, "Sam");
    await until(async () => (await read("Meetings/Kickoff.md"))?.includes('attendees:\n  - "[[Sam]]"') ?? false, 8000);
    await p.close();
    const s = await openNote(sam);
    await s.waitForFunction(() => [...document.querySelectorAll(".relationships h4")].some((h) => h.textContent === "As attendees"));
    await s.close();
  });

  test("Add relationship (F27): a linked note comes first; the other side says 'Has part'", async () => {
    const guide = await note("Guides/Onboarding.md", "# Onboarding\n");
    const page = await note("Guides/Checklist.md", "# Checklist\n\nThe first week, from [[Onboarding]].\n");
    const p = await openNote(page.id);
    await p.waitForSelector(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("add relationship");
    await p.waitForFunction(() => [...document.querySelectorAll(".palette .palette-title")].some((e) => e.textContent === "Add relationship"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".palette .palette-title")].find((e) => e.textContent === "Add relationship")!.click());
    // The relationship builder (F31): the kind box has focus; type to filter, Enter to choose.
    await p.waitForSelector('.rel-builder [data-combo="kind"]:focus');
    expect(await p.$eval('.rel-builder [data-combo="first"]', (e) => (e as HTMLInputElement).value)).toBe("Checklist");
    await p.keyboard.type("part of");
    await Bun.sleep(100);
    await p.keyboard.press("Enter");
    // Then which note, focus having moved on: the one it links to in its text is offered first.
    await p.waitForSelector('.rel-builder [data-combo="second"]:focus');
    await p.waitForFunction(() => (document.querySelector(".combo-list li")?.textContent ?? "").includes("Onboarding"));
    await p.keyboard.press("Enter");
    // The sentence is read out as it's made; Enter on Add saves it.
    await p.waitForFunction(() => document.querySelector(".rel-said")?.textContent === "Checklist part of Onboarding");
    expect(await p.$eval(".rel-said", (e) => e.getAttribute("aria-live"))).toBe("polite");
    await p.waitForSelector(".rel-builder [data-dialog-action]:focus");
    await p.keyboard.press("Enter");
    await until(async () => (await read("Guides/Checklist.md"))?.startsWith('---\npart-of: "[[Onboarding]]"\n---\n') ?? false, 8000);
    // Shown as a relationship (pills), not text.
    await p.waitForSelector('.prop-row[data-key="part-of"] .link-pill');
    await p.close();
    const g = await openNote(guide.id);
    await g.waitForFunction(() => [...document.querySelectorAll(".relationships h4")].some((h) => h.textContent === "Has part"));
    await g.close();
  });

  test("own kinds of relationship (F31): offered first in Add relationship, and named the other way round on the other note", async () => {
    const kinds = await note("Relationships.md", "# Relationships\n\n| Relationship | Other direction | Meaning |\n| --- | --- | --- |\n| comes before | comes after | Happens first |\n");
    const loft = await note("Build/Ceiling.md", "# Ceiling\n");
    const roof = await note("Build/Joists.md", "# Joists\n\nThen the [[Ceiling]].\n");
    try {
      const p = await openNote(roof.id);
      await p.waitForSelector(".cm-content");
      await p.keyboard.down("Meta");
      await p.keyboard.press("k");
      await p.keyboard.up("Meta");
      await p.waitForSelector(".palette input");
      await p.keyboard.type("add relationship");
      await p.waitForFunction(() => [...document.querySelectorAll(".palette .palette-title")].some((e) => e.textContent === "Add relationship"));
      await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".palette .palette-title")].find((e) => e.textContent === "Add relationship")!.click());
      await p.waitForSelector('.rel-builder [data-combo="kind"]:focus');
      // The collection's own kind comes first, with its meaning.
      await p.waitForFunction(() => (document.querySelector(".combo-list li")?.textContent ?? "").includes("comes before"));
      expect(await p.$eval(".combo-list li", (e) => e.textContent)).toContain("Happens first");
      await p.keyboard.press("Enter");
      await p.waitForSelector('.rel-builder [data-combo="second"]:focus');
      await p.keyboard.type("Ceiling");
      await Bun.sleep(100);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector(".rel-said")?.textContent === "Joists comes before Ceiling");
      // Swap reads it from Ceiling: the other way round's name, the same relationship.
      await p.click('.rel-builder button[aria-label="Swap: read it from the other note"]');
      await p.waitForFunction(() => document.querySelector(".rel-said")?.textContent === "Ceiling comes after Joists");
      await p.click(".rel-builder [data-dialog-action]");
      await until(async () => (await read("Build/Joists.md"))?.startsWith('---\ncomes-before: "[[Ceiling]]"\n---\n') ?? false, 8000);
      // Undo takes it out again.
      await p.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent?.includes("Ceiling comes after Joists")));
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".toast-action")].find((b) => b.textContent === "Undo")!.click());
      await until(async () => !(await read("Build/Joists.md"))?.includes("comes-before"), 8000);
      // And again, from Ceiling's side, choosing the other way round: written into Joists all the same.
      await p.goto(`${BASE}/v/${vaultId}/n/${loft.id}`);
      await p.waitForSelector(".cm-content");
      await p.keyboard.down("Meta");
      await p.keyboard.press("k");
      await p.keyboard.up("Meta");
      await p.waitForSelector(".palette input");
      await p.keyboard.type("add relationship");
      await p.waitForFunction(() => [...document.querySelectorAll(".palette .palette-title")].some((e) => e.textContent === "Add relationship"));
      await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".palette .palette-title")].find((e) => e.textContent === "Add relationship")!.click());
      await p.waitForSelector('.rel-builder [data-combo="kind"]:focus');
      await p.keyboard.type("comes after");
      await Bun.sleep(100);
      await p.keyboard.press("Enter");
      await p.waitForSelector('.rel-builder [data-combo="second"]:focus');
      await p.keyboard.type("Joists");
      await Bun.sleep(300);
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector(".rel-said")?.textContent === "Ceiling comes after Joists");
      await p.keyboard.press("Enter");
      await until(async () => (await read("Build/Joists.md"))?.startsWith('---\ncomes-before: "[[Ceiling]]"\n---\n') ?? false, 8000);
      await p.close();
      const l = await openNote(loft.id);
      // The side panel's Relationships (step 4): read from Ceiling, under the other direction's name.
      const row = 'button[aria-label="Ceiling comes after Joists"]';
      await l.waitForSelector(`.relationships ${row}`);
      expect(await l.$eval(".relationships h4", (h) => h.textContent)).toBe("Comes after");
      const menu = (said: string) => `.relationships button[aria-label="Change “${said}”"]`;
      const pick = async (start: string) => {
        await l.waitForSelector(".menu-item:focus");
        await l.waitForFunction((t) => [...document.querySelectorAll(".menu-item")].some((m) => m.textContent?.startsWith(t)), {}, start);
        await l.evaluate((t) => [...document.querySelectorAll<HTMLElement>(".menu-item")].find((m) => m.textContent?.startsWith(t))!.click(), start);
      };
      const undo = async (what: string) => {
        await l.waitForFunction((w) => [...document.querySelectorAll(".toast")].some((t) => t.textContent?.includes(w)), {}, what);
        await l.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".toast-action")].filter((b) => b.textContent === "Undo").pop()!.click());
      };
      // Reverse, by keyboard: taken out of Joists, written into Ceiling as "comes after", the same relationship.
      await l.focus(menu("Ceiling comes after Joists"));
      await l.keyboard.press("Enter");
      await l.waitForSelector(".menu-item:focus");
      for (let i = 0; i < 3; i++) await l.keyboard.press("ArrowDown");
      expect(await l.evaluate(() => document.activeElement?.textContent)).toContain("Reverse: keep it in this note");
      await l.keyboard.press("Enter");
      await until(async () => (await read("Build/Ceiling.md"))?.startsWith('---\ncomes-after: "[[Joists]]"\n---\n') ?? false, 8000);
      await until(async () => !(await read("Build/Joists.md"))?.includes("comes-before"), 8000);
      await l.waitForSelector(`.relationships li[data-kept="here"] ${row}`);
      // One Undo puts both notes back.
      await undo("Reversed");
      await until(async () => !(await read("Build/Ceiling.md"))?.includes("comes-after"), 8000);
      await until(async () => (await read("Build/Joists.md"))?.includes('comes-before: "[[Ceiling]]"') ?? false, 8000);
      // Swap turns it round: Ceiling comes before Joists, kept in Ceiling.
      await l.waitForSelector(`.relationships li[data-kept="there"] ${row}`);
      await l.click(menu("Ceiling comes after Joists"));
      await pick("Swap: Ceiling comes before Joists");
      await until(async () => (await read("Build/Ceiling.md"))?.includes('comes-before: "[[Joists]]"') ?? false, 8000);
      await until(async () => !(await read("Build/Joists.md"))?.includes("comes-before"), 8000);
      await l.waitForSelector(`.relationships button[aria-label="Ceiling comes before Joists"]`);
      // Remove, and Undo.
      await l.click(menu("Ceiling comes before Joists"));
      await pick("Remove");
      await until(async () => !(await read("Build/Ceiling.md"))?.includes("comes-before"), 8000);
      await undo("Removed: Ceiling comes before Joists");
      await until(async () => (await read("Build/Ceiling.md"))?.includes('comes-before: "[[Joists]]"') ?? false, 8000);
      // Change… opens the builder on it; choosing another kind replaces it.
      await l.waitForSelector(menu("Ceiling comes before Joists"));
      await l.click(menu("Ceiling comes before Joists"));
      await pick("Change");
      await l.waitForFunction(() => document.querySelector(".rel-said")?.textContent === "Ceiling comes before Joists");
      await l.click('.rel-builder [data-combo="kind"]');
      await l.keyboard.type("depends on");
      await Bun.sleep(100);
      await l.keyboard.press("Enter");
      await l.waitForFunction(() => document.querySelector(".rel-said")?.textContent === "Ceiling depends on Joists");
      expect(await l.$eval(".rel-builder [data-dialog-action]", (b) => b.textContent)).toBe("Change");
      await l.click(".rel-builder [data-dialog-action]");
      await until(async () => {
        const c = (await read("Build/Ceiling.md")) ?? "";
        return c.includes('depends-on: "[[Joists]]"') && !c.includes("comes-before");
      }, 8000);
      await l.close();
    } finally {
      // Leave the collection as other tests expect it, pass or fail.
      for (const n of [kinds, loft, roof]) await api(`/vaults/${vaultId}/notes/${n.id}`, undefined, "DELETE");
    }
  });

  test("New type offers starters: one click adds Book, and existing types show as added", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".types-section");
    await p.click('button[aria-label="New type"]');
    await p.waitForSelector(".starters");
    // Person exists already (from the test above), so it shows as added.
    await p.waitForFunction(() => document.querySelector(".starter.colour-blue button")?.textContent?.includes("Added"));
    await p.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>(".starter button")].some((b) => b.textContent === "Add Book" && !b.disabled));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".starter button")].find((b) => b.textContent === "Add Book")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".starter")].some((s) => s.textContent?.includes("Book") && s.querySelector("button")?.textContent?.includes("Added")));
    const types = (await api(`/vaults/${vaultId}/types`)).types.map((t: any) => t.name);
    expect(types).toContain("Book");
    await p.keyboard.press("Escape");
    await p.close();
  });

  test("the type editor: add a choice property without writing YAML", async () => {
    const book = (await api(`/vaults/${vaultId}/types`)).types.find((t: any) => t.name === "Book");
    const p = await openNote(book.noteId);
    await p.waitForSelector(".type-editor .type-prop");
    expect(await p.$(".cm-type-def-line")).not.toBeNull(); // no second, raw properties form
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".type-editor button")].find((b) => b.textContent?.includes("Add a property"))!.click());
    await p.waitForFunction(() => document.querySelectorAll(".type-prop").length === 5);
    const last = ".type-prop:last-child";
    await p.click(`${last} .type-prop-name`);
    await p.evaluate((sel) => document.querySelector<HTMLInputElement>(`${sel} .type-prop-name`)!.select(), last);
    await p.keyboard.type("format");
    await p.select(`${last} select`, "select");
    await p.waitForSelector(`${last} .type-choices input`);
    await p.click(`${last} .type-choices input`);
    await p.keyboard.type("Paperback,Kindle");
    await p.keyboard.press("Enter");
    await until(async () => {
      const t = (await api(`/vaults/${vaultId}/types`)).types.find((x: any) => x.name === "Book");
      return JSON.stringify(t.properties.at(-1)) === JSON.stringify({ name: "format", kind: "select", options: ["Paperback", "Kindle"] });
    }, 8000);
    await p.close();
  });

  test("a daily note lists what was made that day", async () => {
    const today = dailyPath(new Date());
    const d = (await api(`/vaults/${vaultId}/notes`)).find((n: any) => n.path === today) ?? (await note(today, "# Today\n"));
    const p = await openNote(d.id);
    await p.waitForFunction(() => [...document.querySelectorAll(".right-panel h3")].some((h) => h.textContent === "This day"));
    expect(await p.$eval(".right-panel", (e) => e.textContent ?? "")).toContain("Kickoff");
    await p.close();
  });
});

describe("embeds and link cards (F2)", () => {
  beforeAll(freshBrowser);
  test("![[Note]] and ![[Note#Heading]] show the note in place, in Live Preview and reading view; loops stop", async () => {
    await note("Embed source.md", "# Embed source\n\nIntro line.\n\n## Part two\n\nOnly this part.\n\n## Part three\n\nNot this.\n");
    await note("Loop A.md", "# Loop A\n\n![[Loop B]]\n");
    await note("Loop B.md", "# Loop B\n\n![[Loop A]]\n");
    const host = await note("Embed host.md", "# Host\n\n![[Embed source]]\n\n![[Embed source#Part two]]\n\n![[Loop A]]\n\nEnd.\n");
    const p = await openNote(host.id);
    await p.waitForFunction(() => document.querySelectorAll(".cm-lp-embed > .note-embed-body").length === 3);
    const bodies = await p.$$eval(".cm-lp-embed", (b) => b.map((e) => e.textContent ?? ""));
    expect(bodies[0]).toContain("Intro line.");
    expect(bodies[1]).toContain("Only this part.");
    expect(bodies[1]).not.toContain("Not this.");
    // Loop A shows Loop B, which would show Loop A again: it stops there.
    await p.waitForFunction(() => (document.querySelectorAll(".cm-lp-embed")[2]?.textContent ?? "").includes("Already shown above"));
    // The source stays plain markdown.
    expect(((await api(`/vaults/${vaultId}/notes/${host.id}`)).content as string)).toContain("![[Embed source#Part two]]");
    // Reading view too, and the embed's title opens it.
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForFunction(() => document.querySelectorAll(".preview .note-embed-body").length >= 3);
    await p.click(".preview .note-embed-title");
    await until(async () => (await p.$eval(".note-title", (e) => e.textContent).catch(() => "")) === "Embed source");
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.close();
  });

  test("a link to a typed note on its own line is a card; inline links and untyped notes stay links; a type can turn cards off", async () => {
    await note("Types/Supplier.md", "---\nicon: building\ncolour: green\nproperties:\n  - name: trade\n    kind: text\n  - name: phone\n    kind: text\n---\n");
    await note("Acme Tiles.md", "---\ntype: Supplier\ntrade: Tiles\nphone: 01234 567890\n---\n# Acme Tiles\n");
    await note("Plain note.md", "# Plain\n");
    const host = await note("Card host.md", "# Cards\n\n[[Acme Tiles]]\n\nWe use [[Acme Tiles]] for tiles.\n\n[[Plain note]]\n");
    const p = await openNote(host.id);
    await p.waitForSelector(".cm-lp-card .link-card-box");
    expect(await p.$$eval(".link-card-box", (c) => c.length)).toBe(1);
    const card = await p.$eval(".link-card-box", (e) => e.textContent ?? "");
    expect(card).toContain("Acme Tiles");
    expect(card).toContain("Supplier");
    expect(card).toContain("Tiles");
    expect(card).toContain("01234 567890");
    // Turning cards off for the type leaves a plain link.
    const supplier = (await api(`/vaults/${vaultId}/types`)).types.find((t: any) => t.name === "Supplier");
    await fetch(`${BASE}/api/vaults/${vaultId}/types/Supplier`, { method: "PUT", headers: { cookie, origin: BASE, "content-type": "application/json" }, body: JSON.stringify({ icon: supplier.icon, colour: supplier.colour, properties: supplier.properties, cards: false }) });
    await until(async () => (await p.$$(".link-card-box")).length === 0, 8000);
    await p.close();
  });
});

describe("small wins", () => {
  beforeAll(freshBrowser);
  test("Tasks: every open to-do in one list; ticking one ticks it in its note", async () => {
    const n = await note("Errands.md", "# Errands\n\n- [ ] Post the parcel 📅 2026-01-02\n- [x] Buy stamps\n");
    const p = await open(`/v/${vaultId}/tasks`);
    await p.waitForSelector(".task-list li");
    const texts = await p.$$eval(".task-list li .task-text", (l) => l.map((e) => e.textContent));
    expect(texts).toContain("Post the parcel");
    expect(texts).not.toContain("Buy stamps"); // Open is the default
    expect(await p.evaluate(() => [...document.querySelectorAll(".task-list li")].find((l) => l.textContent?.includes("Post the parcel"))!.querySelector(".due.overdue")?.textContent)).toBe("2 Jan");
    await p.evaluate(() => ([...document.querySelectorAll(".task-list li")].find((l) => l.textContent?.includes("Post the parcel"))!.querySelector("input") as HTMLInputElement).click());
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).includes("- [x] Post the parcel"), 8000);
    await p.close();
  });

  test("bookmarks: ⋯ → Bookmark puts the note at the top of the sidebar", async () => {
    const n = await note("Starred.md", "# Starred\n");
    const p = await openNote(n.id);
    await p.click('button[aria-label="More"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Bookmark")!.click());
    await p.waitForFunction(() => [...document.querySelectorAll(".shortcuts .type-row")].some((b) => b.textContent?.includes("Starred")));
    await p.click('button[aria-label="More"]');
    expect(await p.$$eval(".menu-item", (m) => m.map((e) => e.textContent))).toContain("Remove bookmark");
    await p.keyboard.press("Escape");
    await p.close();
  });

  test("History shows what restoring a version would change, and restores it", async () => {
    const n = await note("Hist/Boiler log.md", "# Boiler log\n\nService booked.\nEngineer: Sam.\n");
    await api(`/vaults/${vaultId}/notes/${n.id}/content`, { content: "# Boiler log\n\nService done.\nEngineer: Sam.\nParts: valve.\n" }, "PUT");
    const p = await openNote(n.id);
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.keyboard.type("version history");
    await p.waitForFunction(() => document.querySelector('.palette [aria-selected="true"]')?.textContent?.startsWith("Version history"));
    await p.keyboard.press("Enter");
    await p.waitForSelector(".history-list button");
    await p.click(".history-list button");
    await p.waitForSelector(".history-preview .diff");
    const diff = await p.$eval(".history-preview .diff", (e) => e.textContent ?? "");
    expect(diff).toContain("+ Service booked.");
    expect(diff).toContain("− Service done.");
    expect(diff).toContain("− Parts: valve.");
    expect(await p.$eval(".history-head small", (e) => e.textContent)).toBe("Restoring brings back 1 line and takes away 2 lines");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".history-head button")].find((b) => b.textContent === "Full text")!.click());
    expect(await p.$eval(".history-preview pre", (e) => e.textContent)).toContain("Service booked.\nEngineer: Sam.");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".history-preview button")].find((b) => b.textContent === "Restore this version")!.click());
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).includes("Service booked."));
    await p.close();
  });

  test("saved searches: Save keeps a search in the sidebar; it runs again from there, and × removes it", async () => {
    await note("Saved/Heat pump quote.md", "# Heat pump quote\n\nAir source, 8 kW.\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-tabs button, .tabs button")].find((b) => b.textContent?.includes("Search"))!.click());
    await p.waitForSelector(".search-panel input");
    await p.type(".search-panel input", "air source");
    await p.waitForFunction(() => document.querySelector(".search-results")?.textContent?.includes("Heat pump quote"));
    await p.click(".search-save");
    await p.waitForSelector(".search-save.on");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-tabs button, .tabs button")].find((b) => b.textContent?.includes("Files"))!.click());
    await p.waitForSelector(".saved-search");
    expect(await p.$eval(".saved-search .type-row-name", (e) => e.textContent)).toBe("air source");
    await p.click(".saved-search .type-row");
    await p.waitForFunction(() => (document.querySelector(".search-panel input") as HTMLInputElement | null)?.value === "air source");
    await p.waitForFunction(() => document.querySelector(".search-results")?.textContent?.includes("Heat pump quote"));
    expect(await api(`/vaults/${vaultId}/searches`)).toEqual([expect.objectContaining({ query: "air source" })]);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-tabs button, .tabs button")].find((b) => b.textContent?.includes("Files"))!.click());
    await p.waitForSelector(".saved-search-x");
    await p.evaluate(() => document.querySelector<HTMLButtonElement>(".saved-search-x")!.click());
    await p.waitForFunction(() => !document.querySelector(".saved-search"));
    expect(await api(`/vaults/${vaultId}/searches`)).toEqual([]);
    await p.close();
  });

  test("focus mode: ⌘K turns it on, only the text shows, typing works, and Escape leaves it", async () => {
    const n = await note("Focus/Draft.md", "# Draft\n\n" + Array.from({ length: 80 }, (_, i) => `Line ${i}.`).join("\n") + "\n");
    const p = await openNote(n.id);
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.keyboard.type("focus mode");
    await p.waitForFunction(() => document.querySelector('.palette [aria-selected="true"]')?.textContent?.startsWith("Focus mode"));
    await p.keyboard.press("Enter");
    await p.waitForSelector(".app.focus-mode");
    await Bun.sleep(400); // the panels slide away
    expect(await p.$eval(".sidebar", (e) => getComputedStyle(e).visibility)).toBe("hidden");
    // Typewriter scrolling: the cursor's line sits near the middle of the screen.
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type(" The end.");
    await Bun.sleep(200);
    const mid = await p.evaluate(() => {
      const r = window.getSelection()!.getRangeAt(0).getBoundingClientRect();
      const s = document.querySelector(".cm-scroller")!.getBoundingClientRect();
      return Math.abs(r.top - (s.top + s.height / 2)) / s.height;
    });
    expect(mid).toBeLessThan(0.15);
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).includes("The end."));
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => !document.querySelector(".app.focus-mode"));
    expect(await p.evaluate(() => localStorage.getItem("cp:focus"))).toBe("0");
    await p.close();
  });

  test("Turn into a typed note: a line becomes a note of a type, with a link left in its place", async () => {
    await note("Types/Contact.md", "---\nicon: user\nproperties:\n  - name: phone\n    kind: text\n---\n# {{title}}\n\n## Notes\n");
    const n = await note("Typed/Monday.md", "# Monday\n\n- Ring the plumber\n- Priya Patel\n");
    const p = await openNote(n.id);
    await (await p.evaluateHandle(() => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.includes("Priya Patel"))) as any).click();
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.keyboard.type("turn into typed");
    await p.waitForFunction(() => document.querySelector('.palette [aria-selected="true"]')?.textContent?.startsWith("Turn into a typed note"));
    await p.keyboard.press("Enter");
    await p.waitForSelector(".choose-list li");
    await p.keyboard.type("contact");
    await p.keyboard.press("Enter");
    await until(async () => (await paths()).includes("Priya Patel.md"));
    const made = (await api(`/vaults/${vaultId}/notes`)).find((x: any) => x.path === "Priya Patel.md");
    expect((await api(`/vaults/${vaultId}/notes/${made.id}`)).content).toContain("type: Contact");
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).includes("- [[Priya Patel]]\n"));
    expect((await api(`/vaults/${vaultId}/notes/${n.id}`)).content).toContain("- Ring the plumber\n");
    await p.close();
  });

  test("an empty vault offers a short tour; it opens at Start here", async () => {
    const v = await api("/vaults", { name: "Brand new" });
    const p = await open(`/v/${v.id}`);
    await p.waitForSelector(".tour-offer button");
    await p.click(".tour-offer button");
    await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Find your way"));
    expect(await p.$eval(".note-title", (e) => e.textContent)).toBe("Start here");
    await p.close();
  });

  test("unlinked mentions: Link turns the words into a link here", async () => {
    const target = await note("Allotment.md", "# Allotment\n");
    const src = await note("Weekend.md", "Spent Saturday at the allotment.\n");
    const p = await openNote(target.id);
    if (!(await p.$(".app.right-open"))) await p.click('button[aria-label="Side panel"]');
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((b) => b.textContent?.includes("Links"))?.click());
    await p.waitForSelector(".mention-list li");
    await p.click(".mention-link");
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${src.id}`)).content as string) === "Spent Saturday at the [[Allotment|allotment]].\n", 8000);
    await p.close();
  });

  test("following a link to a missing note offers its types: create it as a Person", async () => {
    const n = await note("Who.md", "# Who\n\nMet [[Morgan Lee]] today.\n");
    const p = await openNote(n.id);
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForSelector(".preview a.internal-link.unresolved");
    await p.click(".preview a.internal-link.unresolved");
    await p.waitForSelector("[data-dialog-input]");
    expect(await p.$eval(".modal h2", (e) => e.textContent)).toBe("Create “Morgan Lee”");
    await p.keyboard.type("Person");
    await Bun.sleep(100);
    await p.keyboard.press("Enter");
    await until(async () => (await paths()).includes("Morgan Lee.md"));
    const made = ((await api(`/vaults/${vaultId}/notes`)) as any[]).find((x) => x.path === "Morgan Lee.md");
    expect(made.type).toBe("Person");
    await p.evaluate(() => localStorage.setItem("cp:mode", "edit"));
    await p.close();
  });
});

describe("writing blocks (F28)", () => {
  beforeAll(freshBrowser);
  const md = "# Plan\n\n[TOC]\n\n## Goals\n\nWhere we are: :status[On track]{.green}\n\n> [!note]- Details\n> Hidden text\n\n## Risks\n\nNone yet.\n";

  test("Live Preview: contents, a status label, and a callout that folds", async () => {
    const n = await note("Blocks/Plan.md", md);
    const p = await openNote(n.id);
    await p.waitForSelector(".cm-lp-toc .toc-link");
    expect(await p.$$eval(".cm-lp-toc .toc-link", (l) => l.map((e) => e.textContent))).toEqual(["Goals", "Risks"]);
    expect(await p.$eval(".cm-content .status.status-green", (e) => e.textContent)).toBe("On track");
    expect(await p.$eval(".cm-content", (e) => e.textContent)).not.toContain(":status[");
    // Closed: only the title shows; the chevron opens it, without changing the text.
    expect(await p.$eval(".cm-content", (e) => e.textContent)).not.toContain("Hidden text");
    await p.evaluate(() => document.querySelector(".cm-lp-fold")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    await p.waitForFunction(() => document.querySelector(".cm-content")!.textContent!.includes("Hidden text"));
    expect((await api(`/vaults/${vaultId}/notes/${n.id}`)).content).toBe(md);
    // A contents entry moves the cursor to its heading.
    await p.evaluate(() => [...document.querySelectorAll(".cm-lp-toc .toc-link")].find((a) => a.textContent === "Risks")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true })));
    // Its source shows, as on any line the cursor is on.
    await p.waitForFunction(() => document.querySelector(".cm-content")!.textContent!.includes("## Risks"));
    await p.close();
  });

  test("reading view: the same blocks, the callout as a <details>", async () => {
    const n = await note("Blocks/Plan read.md", md);
    const p = await openNote(n.id);
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForSelector(".preview .toc-link");
    expect(await p.$$eval(".preview .toc-link", (l) => l.map((e) => e.textContent))).toEqual(["Goals", "Risks"]);
    expect(await p.$eval(".preview .status.status-green", (e) => e.textContent)).toBe("On track");
    expect(await p.$eval(".preview details.callout", (e) => (e as HTMLDetailsElement).open)).toBe(false);
    expect(await p.$eval(".preview details.callout summary", (e) => e.textContent)).toBe("Details");
    // The view is remembered: put Live Preview back for the tests after.
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Live preview"]')!.click());
    await p.close();
  });

  test("a note's look: emoji icon, cover and wide page; a web address alone is a card; :rocket", async () => {
    const page = Bun.serve({
      port: 3288,
      fetch: () => new Response(`<head><meta property="og:title" content="Harbour walk"><meta property="og:description" content="Five miles by the sea."></head>`, { headers: { "content-type": "text/html" } }),
    });
    try {
      // A real picture for the cover (a missing one would log a 404).
      const form = new FormData();
      form.append("file", new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], "harbour.png", { type: "image/png" }));
      const up = await fetch(`${BASE}/api/vaults/${vaultId}/files`, { method: "POST", headers: { cookie, origin: BASE }, body: form });
      expect(((await up.json()) as { path: string }).path).toBe("attachments/harbour.png");
      const n = await note("Look.md", '---\nicon: 🚀\ncover: "[[attachments/harbour.png]]"\nwidth: wide\n---\n# Look\n\nhttp://localhost:3288/walk\n\n');
      const p = await openNote(n.id);
      await p.waitForSelector(".note-title .note-icon");
      expect(await p.$eval(".note-title .note-icon", (e) => e.textContent)).toBe("🚀");
      await p.waitForFunction(() => [...document.querySelectorAll(".tree-label")].some((l) => l.textContent === "🚀Look"));
      expect(await p.$eval(".note-cover img", (e) => (e as HTMLImageElement).src)).toContain("files?path=attachments%2Fharbour.png");
      expect(await p.$(".note-view.width-wide")).not.toBeNull();
      await p.waitForSelector(".cm-lp-webcard .web-card-title");
      expect(await p.$eval(".cm-lp-webcard .web-card-title", (e) => e.textContent)).toBe("Harbour walk");
      expect(await p.$eval(".cm-lp-webcard .web-card-site", (e) => e.textContent)).toBe("localhost");
      // :rocke offers the rocket; Enter writes the emoji itself.
      await p.focus(".cm-content");
      await p.keyboard.down("Meta");
      await p.keyboard.press("ArrowDown");
      await p.keyboard.up("Meta");
      await p.keyboard.type("Launch :rocke");
      await p.waitForFunction(() => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes("rocket"));
      await Bun.sleep(150);
      await p.keyboard.press("Enter");
      await until(async () => (await api(`/vaults/${vaultId}/notes/${n.id}`)).content.includes("Launch 🚀"), 8000);
      await p.close();
    } finally {
      page.stop(true);
    }
  });

  test("// offers dates and writes the one chosen as YYYY-MM-DD", async () => {
    const n = await note("Blocks/Due.md", "# Due\n\n");
    const p = await openNote(n.id);
    await p.waitForSelector(".cm-content", { visible: true });
    await p.click(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type("Due //tom");
    await p.waitForFunction(() => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes("Tomorrow"));
    await Bun.sleep(150); // CodeMirror ignores Enter for 75 ms after the list changes
    await p.keyboard.press("Enter");
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    await until(async () => (await api(`/vaults/${vaultId}/notes/${n.id}`)).content.includes(`Due ${iso}`), 8000);
    await p.close();
  });

  test("full-width editor: the text fills the space between the panels and follows them; remembered", async () => {
    const n = await note("Full width.md", "# Full width\n\nA line of text.\n");
    const p = await openNote(n.id);
    await p.waitForSelector(".app.ready");
    const text = () => p.$eval(".cm-content", (e) => e.getBoundingClientRect().width);
    const room = () => p.$eval(".cm-scroller", (e) => e.clientWidth);
    const fills = async () => Math.abs((await text()) - (await room())) < 2;
    const files = () => p.click('button[aria-label="Files"]');
    // With the file panel closed there's more room than the reading width uses.
    await files();
    await until(async () => (await room()) > 900);
    expect(await text()).toBeLessThanOrEqual(760);
    await p.click('button[aria-label="Full-width editor"]');
    await until(async () => (await text()) > 900 && (await fills()));
    expect(await p.$eval('button[aria-label="Full-width editor"]', (e) => e.getAttribute("aria-pressed"))).toBe("true");
    // Opening the panel again narrows it to fit, and it still fills its column.
    const wide = await text();
    await files();
    await until(async () => (await text()) < wide - 200 && (await fills()));
    // Kept after a reload; the button puts it back to normal.
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".app.full-width .cm-content");
    await files();
    await until(async () => (await room()) > 900 && (await fills()));
    await p.click('button[aria-label="Full-width editor"]');
    await until(async () => (await text()) <= 760);
    await files();
    await p.close();
  });
});

describe("weblinks", () => {
  beforeAll(freshBrowser);
  const page = Bun.serve({
    port: 3287,
    fetch: () => new Response(`<head><meta property="og:title" content="A Good Read"><meta property="og:description" content="Worth the time."></head>`, { headers: { "content-type": "text/html" } }),
  });
  afterAll(() => page.stop(true));
  test("⌘K → Save a web link makes a Weblink note with the page's title and summary", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".vault-home");
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("save a web link");
    await p.keyboard.press("Enter");
    await answer(p, "http://localhost:3287/read");
    await p.waitForSelector(".cm-content");
    await until(async () => (await content(p)).includes("Worth the time."));
    expect(await p.$eval(".type-chip", (e) => e.textContent?.trim())).toBe("Weblink");
    await p.close();
  });
});

describe("offline on the iPhone (F4)", () => {
  beforeAll(freshBrowser);
  test("with the server gone, the app opens from this device, takes edits, keeps them across a reload, and syncs when it's back", async () => {
    const step = (m: string) => process.env.UI_DEBUG && console.log("offline step:", m);
    const n = await note("Offline.md", "# Offline\n\nWritten online.\n");
    const p = await openNote(n.id, true);
    // The first visit installs the service worker; the next load is the one it controls and caches.
    await p.evaluate(async () => void (await navigator.serviceWorker.ready));
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await until(() => p.evaluate(() => !!navigator.serviceWorker.controller));
    await until(async () => (await content(p)).includes("Written online."));
    await Bun.sleep(800); // the note's copy reaches IndexedDB

    step("server stopping");
    serverDown = true;
    // The network going, not a tidy shutdown: the server is simply gone (its note saved already).
    server.kill("SIGKILL");
    await server.exited;
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await until(async () => (await content(p)).includes("Written online."));
    await until(() => p.$eval(".cm-content", (e) => e.getAttribute("contenteditable") === "true"));
    await p.tap(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.type(" Typed on the train.");
    await Bun.sleep(500);
    step("typed offline");
    await p.reload({ waitUntil: "load" }); // closing and reopening the app with no signal
    await p.waitForSelector(".cm-content");
    await until(async () => (await content(p)).includes("Typed on the train."));

    step("reopened offline");
    server = startServer();
    await until(async () => (await fetch(`${BASE}/health`).catch(() => null))?.ok ?? false, 20000);
    step("server back");
    serverDown = false;
    let last = "";
    await until(async () => {
      const c = (await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string;
      if (process.env.UI_DEBUG && c !== last) step(`server has: ${JSON.stringify(c)}; page shows: ${JSON.stringify(await content(p).catch((e) => String(e)))}; status: ${await p.$eval(".conn", (e) => e.className).catch(() => "?")}`);
      last = c;
      return c.includes("Typed on the train.");
    }, 20000);
    expect(((await api(`/vaults/${vaultId}/notes/${n.id}`)).content as string).match(/Written online\./g)!.length).toBe(1); // merged, not duplicated
    await p.close();
  }, 60000);
});

/** An app registered for MCP sign-in (F25), and the consent page's address for it. */
async function oauthClient(name: string) {
  const back = `${BASE}/oauth-test-callback`;
  const reg = await (await fetch(`${BASE}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: name, redirect_uris: [back.replace("localhost", "127.0.0.1")], token_endpoint_auth_method: "none" }) })).json();
  const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: back.replace("localhost", "127.0.0.1"), code_challenge: "c".repeat(43), code_challenge_method: "S256", state: "ui" });
  return `/oauth/authorize?${q}`;
}

describe("accessibility (axe)", () => {
  // WCAG 2.1 A and AA, on the main screens, laptop and iPhone, light and dark. Serious and
  // critical problems fail; A11Y_REPORT=1 prints every finding.
  const AXE = Bun.file(require.resolve("axe-core/axe.min.js")).text();
  async function audit(p: Page, where: string, scope?: string) {
    if (!(await p.evaluate(() => "axe" in window))) await p.evaluate(await AXE); // through the debugger, not an inline <script>: the app's CSP allows none
    const found = (await p.evaluate(
      (sel) =>
        (window as any).axe
          .run(sel ? document.querySelector(sel) : document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } })
          .then((r: any) => r.violations.map((v: any) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 3).map((n: any) => n.target.join(" ") + (n.any?.[0]?.data?.contrastRatio ? ` [${n.any[0].data.fgColor} on ${n.any[0].data.bgColor} = ${n.any[0].data.contrastRatio}, need ${n.any[0].data.expectedContrastRatio}]` : "")) }))),
      scope ?? null,
    )) as { id: string; impact: string; help: string; nodes: string[] }[];
    if (process.env.A11Y_REPORT) for (const v of found) console.log(`[${where}] ${v.impact} ${v.id}: ${v.help} — ${v.nodes.join(" | ")}`);
    return found.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${where}: ${v.id} (${v.nodes.join(" | ")})`);
  }

  test("the main screens have no serious problems, on the laptop and the iPhone, light and dark", async () => {
    await freshBrowser();
    const n = await note("A11y/Kitchen plan.md", "---\nstatus: in progress\nbudget: 7500\ntags: [home]\n---\n# Kitchen plan\n\nSee [[Pancakes]].\n\n- [ ] Choose tiles\n- [x] Get quotes\n\n| Item | Cost |\n|---|---:|\n| Units | £4,200 |\n\n> [!tip] Decision\n> Quartz.\n");
    await note("Types/Gadget.md", "---\nicon: box\nproperties:\n  - name: price\n    kind: number\n---\n# {{title}}\n").catch(() => {});
    await note("A11y/Kettle.md", "---\ntype: Gadget\nprice: 30\n---\n# Kettle\n");
    const problems: string[] = [];
    for (const phone of [false, true]) {
      for (const scheme of ["light", "dark"] as const) {
        const tag = `${phone ? "iPhone" : "laptop"} ${scheme}`;
        const p = await open(`/v/${vaultId}`, phone);
        await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await p.waitForSelector(phone ? ".vault-home, main" : ".tree-row");
        problems.push(...(await audit(p, `${tag} vault home`)));
        await p.goto(`${BASE}/v/${vaultId}/n/${n.id}`);
        await p.waitForSelector(".cm-content");
        await Bun.sleep(300);
        problems.push(...(await audit(p, `${tag} note`)));
        await p.goto(`${BASE}/v/${vaultId}/t/Gadget`);
        await p.waitForFunction(() => document.body.innerText.includes("Kettle"));
        problems.push(...(await audit(p, `${tag} type page`)));
        await p.goto(`${BASE}/v/${vaultId}/tasks`);
        await p.waitForFunction(() => document.body.innerText.includes("Choose tiles"));
        problems.push(...(await audit(p, `${tag} tasks`)));
        await p.goto(`${BASE}/v/${vaultId}/journal`);
        await p.waitForSelector(".journal-day, .journal-main .muted");
        problems.push(...(await audit(p, `${tag} journal`)));
        await p.goto(`${BASE}/v/${vaultId}/graph?type=Gadget`);
        await p.waitForSelector(".graph-bar");
        await p.click(".graph-bar button[aria-expanded]");
        await p.waitForSelector(".graph-filters");
        problems.push(...(await audit(p, `${tag} graph with filters`)));
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".graph-bar button")].find((b) => b.textContent?.includes("Timeline"))!.click());
        await p.waitForSelector(".graph-timeline");
        problems.push(...(await audit(p, `${tag} graph with the timeline`)));
        if (!phone) {
          await p.keyboard.down("Meta");
          await p.keyboard.press("k");
          await p.keyboard.up("Meta");
          await p.waitForSelector(".palette");
          await Bun.sleep(400); // after it fades in
          problems.push(...(await audit(p, `${tag} command palette`, ".palette")));
          await p.keyboard.press("Escape");
        }
        await p.close();
      }
    }
    // Settings, each section, on the laptop in both themes.
    for (const scheme of ["light", "dark"] as const) {
      const p = await open(`/v/${vaultId}`);
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await p.waitForSelector(".tree-row");
      await p.click('[aria-label="Settings"]');
      await p.waitForSelector(".settings-nav");
      for (const label of ["Account", "This collection", "Website", "AI assistants", "Connections", "Admin"]) {
        const b = await p.evaluateHandle((l) => [...document.querySelectorAll(".settings-nav button")].find((x) => x.textContent?.startsWith(l)), label);
        if (!(await (b as any).evaluate((x: unknown) => !!x))) continue;
        await (b as any).click();
        await Bun.sleep(300);
        problems.push(...(await audit(p, `laptop ${scheme} Settings → ${label}`, ".modal")));
      }
      await p.close();
    }
    // An app asking to sign in (F25), laptop and iPhone, light and dark.
    for (const phone of [false, true])
      for (const scheme of ["light", "dark"] as const) {
        const p = await open(await oauthClient("Claude"), phone);
        await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
        await p.waitForSelector(".consent h2");
        problems.push(...(await audit(p, `${phone ? "iPhone" : "laptop"} ${scheme} sign-in consent`)));
        await p.close();
      }
    // The help: its start, a page with pictures and one with tables, in both themes.
    for (const scheme of ["light", "dark"] as const) {
      const p = await open(`/v/${vaultId}`);
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await p.waitForSelector(".tree-row");
      await p.click('.sidebar-foot [aria-label="Help"]');
      await p.waitForSelector(".help-page h1");
      for (const label of ["Help", "Writing notes", "Keyboard shortcuts"]) {
        await p.evaluate((l) => [...document.querySelectorAll<HTMLButtonElement>(".help-nav button")].find((b) => b.textContent === l)!.click(), label);
        await p.waitForFunction((l) => document.querySelector(".help-page h1")?.textContent === l, {}, label);
        await Bun.sleep(300);
        problems.push(...(await audit(p, `laptop ${scheme} Help → ${label}`, ".modal")));
      }
      await p.close();
    }
    // An empty vault, with the tour on offer.
    const empty = await api("/vaults", { name: "Empty for axe" });
    for (const scheme of ["light", "dark"] as const) {
      const p = await open(`/v/${empty.id}`);
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await p.waitForSelector(".tour-offer");
      problems.push(...(await audit(p, `laptop ${scheme} empty vault`)));
      await p.close();
    }
    // Signed out: the sign-in page.
    const ctx = await browser.createBrowserContext(); // no session cookie
    const out = await ctx.newPage();
    await out.goto(`${BASE}/`);
    await out.waitForSelector("input[type=email], input[type=password]");
    problems.push(...(await audit(out, "sign-in")));
    await ctx.close();
    expect([...new Set(problems)]).toEqual([]);
  });
});

describe("website (F18)", () => {
  const button = (p: Page, text: string) => p.evaluate((t) => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === t)!.click(), text);
  const status = (url: string) => fetch(url).then((r) => r.status);

  test("choose a folder, see what will be public, publish, read the pages, take the site down and undo", async () => {
    await freshBrowser();
    const sv = (await api("/vaults", { name: "Our garden" })).id;
    await api(`/vaults/${sv}/notes`, { path: "Garden/Roses.md", content: "# Roses\n\nPrune them in [[Winter jobs]], but [[Secret|not this]].\n\n> [!tip] Feed\n> Monthly.\n\n- [x] Mulch\n\n```dataviewjs\ndv.list(dv.pages('\"Garden\"').sort((p) => p.file.name).file.link);\ndv.paragraph(\"Seen: \" + dv.pages().length);\n```\n" });
    await api(`/vaults/${sv}/notes`, { path: "Garden/Winter jobs.md", content: "## Mulch\n\nSpread it thick." });
    await api(`/vaults/${sv}/notes`, { path: "Private/Secret.md", content: "Not for the web." });

    const p = await open(`/v/${sv}`);
    await p.waitForSelector(".tree-row");
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("publish website");
    await p.waitForFunction(() => document.querySelector(".palette .palette-title")?.textContent === "Publish as a website");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector(".modal")?.textContent?.includes("3 notes and 0 files"));

    await p.click(".site-choice label:nth-child(2) input");
    await p.waitForSelector(".site-folders");
    await p.evaluate(() => [...document.querySelectorAll<HTMLLabelElement>(".site-folders label")].find((l) => l.textContent?.trim() === "Garden")!.click());
    await p.waitForFunction(() => document.querySelector(".modal")?.textContent?.includes("2 notes and 0 files"));

    // The builder: each feature switched on shows in the preview before anything is published.
    const preview = async () => (await (await p.$("iframe.site-preview"))!.contentFrame())!;
    await (await preview()).waitForSelector("h1");
    expect(await (await preview()).$(".site-sidebar")).toBeNull();
    const boxes = await p.$$eval(".site-features input", (b) => b.length);
    expect(boxes).toBe(7);
    for (let i = 0; i < boxes; i++) {
      await p.click(`.site-features li:nth-child(${i + 1}) input`);
      await p.waitForFunction((n) => document.querySelectorAll(".site-features input:checked").length === n && !document.querySelector(".site-features input:disabled"), {}, i + 1);
    }
    await (await preview()).waitForSelector(".site-sidebar");
    expect(await (await preview()).$$eval(".site-sidebar a", (as) => as.map((a) => a.textContent))).toEqual(["Roses", "Winter jobs"]);
    expect(await (await preview()).$(".site-theme")).not.toBeNull();
    await button(p, "Publish");
    await p.waitForSelector(".site-live a");
    const url = await p.$eval(".site-live a", (a) => (a as HTMLAnchorElement).href);
    expect(await p.$eval(".modal", (e) => e.textContent)).toContain("Nothing has changed since you published.");

    // The site, as a reader sees it: no script, so the page is read as it is served.
    const site = await open(url.replace(BASE, "") + "Garden/Roses");
    expect(await site.$eval("h1", (e) => e.textContent)).toBe("Roses");
    expect(await site.$eval(".callout-title", (e) => e.textContent)).toBe("Feed");
    expect(await site.$eval("main", (e) => e.textContent)).toContain("not this");
    expect(await site.$$eval("main a:not(.dataviewjs-block a)", (as) => as.map((a) => a.textContent))).toEqual(["Winter jobs"]);
    // What the dataviewjs block drew at Publish, from the published notes only.
    expect(await site.$$eval(".dataviewjs-block li", (l) => l.map((x) => x.textContent))).toEqual(["Roses", "Winter jobs"]);
    expect(await site.$eval(".dataviewjs-block", (e) => e.textContent)).toContain("Seen: 2"); // not the private note
    expect(await site.$eval("main", (e) => e.textContent)).not.toContain("Not for the web");
    expect(await site.$eval("body", (e) => getComputedStyle(e).fontFamily)).toContain("apple-system"); // the theme loaded
    await Promise.all([site.waitForNavigation(), site.click("main a.internal-link")]);
    expect(await site.$eval("h1", (e) => e.textContent)).toBe("Winter jobs");
    await site.click(".site-head nav a");
    await site.waitForFunction(() => document.querySelector("h1")?.textContent === "All pages");
    expect(await site.$eval("main", (e) => e.textContent)).not.toContain("Secret");
    await site.close();

    await button(p, "Take the site down");
    await until(async () => (await status(url)) === 404);
    await clickToast(p, "Undo");
    await until(async () => (await status(url)) === 200);
    await p.waitForFunction(() => !!document.querySelector(".site-live a"));
    await p.close();
  });

  test("the published pages have no serious accessibility problems, laptop and iPhone, light and dark", async () => {
    const [v] = ((await api("/vaults")) as { id: number; name: string }[]).filter((x) => x.name === "Our garden");
    const { site } = await api(`/vaults/${v!.id}/site`);
    const AXE = await Bun.file(require.resolve("axe-core/axe.min.js")).text();
    const problems: string[] = [];
    for (const phone of [false, true]) {
      for (const scheme of ["light", "dark"] as const) {
        for (const path of ["", "Garden/Roses"]) {
          opened++;
          const page = await browser.newPage();
          await page.setBypassCSP(true); // to run axe in a page that allows no script
          await page.setViewport(phone ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1200, height: 850 });
          await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
          await page.goto(`${BASE}/p/${site.slug}/${path}`);
          await page.addScriptTag({ content: AXE });
          const found = await page.evaluate(() =>
            (window as any).axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] } }).then((r: any) => r.violations.filter((v: any) => v.impact === "serious" || v.impact === "critical").map((v: any) => `${v.id} (${v.nodes.slice(0, 3).map((n: any) => n.target.join(" ")).join(" | ")})`)),
          );
          problems.push(...found.map((f: string) => `${phone ? "iPhone" : "laptop"} ${scheme} /${path}: ${f}`));
          if (phone) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
          await page.close();
        }
      }
    }
    expect(problems).toEqual([]);
  });
});

describe("editor usability, release 1", () => {
  beforeAll(freshBrowser);
  const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
  const endOfDoc = async (p: Page) => {
    await p.focus(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
  };
  const pick = async (p: Page, label: string) => {
    await p.waitForFunction((l) => document.querySelector(".cm-tooltip-autocomplete li[aria-selected]")?.textContent?.includes(l), {}, label);
    await Bun.sleep(150); // CodeMirror ignores Enter for 75 ms after the list changes
    await p.keyboard.press("Enter");
  };

  test("[[ offers a note's headings after # and finds notes by alias, keeping the alias as the words", async () => {
    await note("Usability/Bread.md", "---\naliases: [Sourdough]\n---\n# Bread\n\n## Starter\n\n## Bake\n");
    const n = await note("Usability/Links.md", "# Links\n");
    const p = await openNote(n.id);
    await endOfDoc(p);
    await p.keyboard.press("Enter");
    await p.keyboard.type("[[Bread#Ba");
    await pick(p, "Bake");
    await until(async () => (await raw(n.id)).includes("[[Bread#Bake]]"));
    await endOfDoc(p);
    await p.keyboard.press("Enter");
    await p.keyboard.type("[[Sourdo");
    await pick(p, "Sourdough");
    await until(async () => (await raw(n.id)).includes("[[Bread|Sourdough]]"));
    // [[# is this note's own headings.
    await endOfDoc(p);
    await p.keyboard.press("Enter");
    await p.keyboard.type("[[#Li");
    await pick(p, "Links");
    await until(async () => (await raw(n.id)).includes("[[#Links]]"));
    await p.close();
  });

  test("word count and reading time, and the selection's count", async () => {
    const n = await note("Usability/Count.md", "---\ntags: [x]\n---\n# Count\n\none two three\n");
    const p = await openNote(n.id);
    const stats = () => p.evaluate(() => document.querySelector(".note-stats")?.textContent ?? "");
    await until(async () => (await stats()) === "4 words · 1 min read");
    await p.focus(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("KeyA");
    await p.keyboard.up("Meta");
    await until(async () => (await stats()) === "4 of 4 words");
    await p.close();
  });

  test("a pasted picture is named after the note", async () => {
    const n = await note("Usability/Paste test.md", "# Paste test\n\n");
    const p = await openNote(n.id);
    await endOfDoc(p);
    await p.evaluate(() => {
      const png = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([png], "image.png", { type: "image/png" }));
      document.querySelector(".cm-content")!.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    });
    await until(async () => /!\[\[attachments\/Paste test\.(png|jpg|webp)\]\]/.test(await raw(n.id)), 10000);
    await p.close();
  });

  test("a note reopens where you left it", async () => {
    const lines = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of the long note.`).join("\n\n");
    const n = await note("Usability/Long.md", `# Long\n\n${lines}\n`);
    const p = await openNote(n.id);
    await p.waitForSelector(".cm-content");
    // Scroll well down, then click a line there (CodeMirror only draws the lines on screen).
    await p.$eval(".cm-scroller", (e) => (e.scrollTop = 2000));
    await Bun.sleep(200);
    const at = await p.evaluate(() => {
      const box = document.querySelector(".cm-scroller")!.getBoundingClientRect();
      const line = [...document.querySelectorAll(".cm-line")].find((l) => l.getBoundingClientRect().top > box.top + box.height / 2 && /^Line \d+/.test(l.textContent ?? ""))!;
      const r = line.getBoundingClientRect();
      return { x: r.left + 40, y: r.top + r.height / 2, text: line.textContent! };
    });
    await p.mouse.click(at.x, at.y);
    await Bun.sleep(600); // saved 400 ms after the last move
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await until(async () => (await p.$eval(".cm-scroller", (e) => e.scrollTop)) > 1500);
    await p.focus(".cm-content");
    await p.keyboard.type("XYZ");
    // Typed into the line that was clicked.
    await until(async () => (await raw(n.id)).split("\n").some((l) => l.includes("XYZ") && l.replace("XYZ", "") === at.text));
    await p.close();
  });

  test("code: coloured, its language picked from the bar, Copy in reading view", async () => {
    const n = await note("Usability/Code.md", "# Code\n\n```\nconst a = 1; // one\n```\n\nAfter.\n");
    const p = await openNote(n.id);
    await p.waitForSelector(".cm-lp-codebar .cm-lp-codelang");
    expect(await p.$eval(".cm-lp-codelang", (e) => e.textContent)).toBe("Plain text");
    expect(await p.$(".cm-content .tok-keyword")).toBeNull();
    await p.click(".cm-lp-codelang");
    await p.waitForSelector("[data-dialog-input]");
    await p.keyboard.type("TypeScript");
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).includes("```ts\nconst a"));
    await p.waitForFunction(() => document.querySelector(".cm-content .tok-keyword")?.textContent === "const");
    expect(await p.$eval(".cm-lp-codelang", (e) => e.textContent)).toBe("TypeScript");
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForSelector(".preview .code-block .tok-comment");
    expect(await p.$eval(".preview .code-lang", (e) => e.textContent)).toBe("TypeScript");
    const ctx = p.browserContext();
    await ctx.overridePermissions(BASE, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
    await p.click(".preview .code-copy");
    await until(async () => (await p.evaluate(() => navigator.clipboard.readText())) === "const a = 1; // one");
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Live preview"]')!.click());
    await p.close();
  });

  test("a click on a picture shows it on its own; Escape closes it", async () => {
    const form = new FormData();
    form.append("file", new File([Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="), (c) => c.charCodeAt(0))], "zoom.png", { type: "image/png" }));
    await fetch(`${BASE}/api/vaults/${vaultId}/files`, { method: "POST", body: form, headers: { cookie } });
    const n = await note("Usability/Zoom.md", "# Zoom\n\n![[attachments/zoom.png|200]]\n\nText.\n");
    const p = await openNote(n.id);
    await p.waitForSelector(".cm-lp-image");
    await p.click(".cm-lp-image");
    await p.waitForSelector(".lightbox img");
    expect(await p.$eval(".lightbox img", (e) => (e as HTMLImageElement).src)).toContain("zoom.png");
    await p.keyboard.press("Escape");
    await until(async () => (await p.$(".lightbox")) === null);
    // The note itself didn't change, and the line didn't open for editing.
    expect(await raw(n.id)).toBe("# Zoom\n\n![[attachments/zoom.png|200]]\n\nText.\n");
    await p.close();
  });
});

describe("editor usability, release 2", () => {
  beforeAll(freshBrowser);
  const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
  const command = async (p: Page, title: string) => {
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type(title);
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await p.waitForSelector(".palette", { hidden: true });
  };
  const shown = (p: Page, text: string) => p.$eval(".cm-content", (e, t) => e.textContent!.includes(t), text);

  test("headings and list items fold and unfold, without changing the note", async () => {
    const md = "# Plan\n\n## Alpha\n\nalpha text\n\n## Beta\n\nbeta text\n\n- parent\n  - child item\n- single\n";
    const n = await note("Usability/Fold.md", md);
    const p = await openNote(n.id);
    await p.waitForSelector(".cm-fold-chevron");
    // A chevron for each heading and the item with a child; none for the item without.
    const at = (text: string) =>
      p.evaluate((t) => {
        const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent!.replace("›", "").trim().endsWith(t))!;
        line.querySelector(".cm-fold-chevron")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      }, text);
    expect(await p.$$eval(".cm-foldable", (l) => l.length)).toBe(4);
    await at("Alpha");
    await until(async () => !(await shown(p, "alpha text")));
    expect(await shown(p, "beta text")).toBe(true);
    expect(await p.$eval(".cm-fold-placeholder", (e) => e.textContent)).toMatch(/^⋯ \d+ lines?$/);
    await p.click(".cm-fold-placeholder");
    await until(() => shown(p, "alpha text"));
    await at("parent");
    await until(async () => !(await shown(p, "child item")));
    expect(await shown(p, "single")).toBe(true);
    await command(p, "Unfold all");
    await until(() => shown(p, "child item"));
    await command(p, "Fold all headings");
    await until(async () => !(await shown(p, "alpha text")) && !(await shown(p, "beta text")));
    await command(p, "Unfold all");
    await until(async () => (await shown(p, "alpha text")) && (await shown(p, "beta text")));
    expect(await raw(n.id)).toBe(md);
    await p.close();
  });

  test("resting on a link shows the note, or its heading's section; in the editor and reading view", async () => {
    await note("Usability/Garden.md", "---\ntags: [x]\n---\n# Garden\n\nTomatoes and beans.\n\n## Shed\n\nThe shed needs a new roof.\n");
    const n = await note("Usability/Hover.md", "# Hover\n\nSee [[Garden]] and [[Garden#Shed]].\n");
    const p = await openNote(n.id);
    await p.waitForSelector(".cm-lp-wikilink");
    const hover = async (sel: string, i: number) => {
      const r = await p.$$eval(sel, (l, i) => {
        const b = l[i]!.getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      }, i);
      await p.mouse.move(r.x, r.y);
    };
    await hover(".cm-lp-wikilink", 0);
    await p.waitForSelector(".hover-preview .hover-preview-text");
    expect(await p.$eval(".hover-preview-title", (e) => e.textContent)).toBe("Garden");
    expect(await p.$eval(".hover-preview-text", (e) => e.textContent)).toContain("Tomatoes and beans.");
    expect(await p.$eval(".hover-preview-text", (e) => e.textContent)).not.toContain("tags");
    expect(await p.$(".hover-preview-text h1")).toBeNull(); // the title is already on the card
    await p.mouse.move(5, 5);
    await until(async () => (await p.$(".hover-preview")) === null);
    await hover(".cm-lp-wikilink", 1);
    await p.waitForFunction(() => document.querySelector(".hover-preview-title")?.textContent === "Garden › Shed");
    const shed = await p.$eval(".hover-preview-text", (e) => e.textContent!);
    expect(shed).toContain("new roof");
    expect(shed).not.toContain("Tomatoes");
    await p.mouse.move(5, 5);
    await until(async () => (await p.$(".hover-preview")) === null);
    // Reading view: the same card, floating.
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Reading view"]')!.click());
    await p.waitForSelector(".preview a.internal-link");
    await hover(".preview a.internal-link", 0);
    await p.waitForSelector(".hover-preview.floating .hover-preview-text");
    expect(await p.$eval(".hover-preview.floating", (e) => e.textContent)).toContain("Tomatoes and beans.");
    await p.keyboard.press("Escape");
    await until(async () => (await p.$(".hover-preview.floating")) === null);
    await p.evaluate(() => document.querySelector<HTMLButtonElement>('.segmented button[title="Live preview"]')!.click());
    await p.close();
  });
});

describe("editor usability, release 3", () => {
  beforeAll(freshBrowser);
  const raw = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;
  /** Select the last `n` characters of the note with the keyboard. */
  const selectLast = async (p: Page, n: number) => {
    await p.focus(".cm-content");
    await p.keyboard.down("Meta");
    await p.keyboard.press("ArrowDown");
    await p.keyboard.up("Meta");
    await p.keyboard.down("Shift");
    for (let i = 0; i < n; i++) await p.keyboard.press("ArrowLeft");
    await p.keyboard.up("Shift");
  };
  const key = async (p: Page, k: KeyInput, shift = false) => {
    await p.keyboard.down("Meta");
    if (shift) await p.keyboard.down("Shift");
    await p.keyboard.press(k);
    if (shift) await p.keyboard.up("Shift");
    await p.keyboard.up("Meta");
  };

  test("selected text gets a format bar; its buttons and ⌘B / ⌘I toggle, and it links words to a note", async () => {
    await note("Usability/Allotment.md", "# Allotment\n");
    const n = await note("Usability/Format.md", "# Format\n\nPlant the beans");
    const p = await openNote(n.id);
    await p.waitForSelector(".cm-content");
    await selectLast(p, 5);
    await p.waitForSelector(".cm-format-bar");
    expect(await p.$$eval(".cm-format-btn", (l) => l.map((b) => b.getAttribute("aria-label")))).toEqual(["Heading", "Bold", "Italic", "Strikethrough", "Highlight", "Inline code", "Link", "Colour"]);
    await p.click('.cm-format-btn[aria-label="Bold"]');
    await until(async () => (await raw(n.id)).endsWith("Plant the **beans**"));
    await p.waitForSelector('.cm-format-btn[aria-label="Bold"][aria-pressed="true"]');
    await key(p, "b");
    await until(async () => (await raw(n.id)).endsWith("Plant the beans"));
    await key(p, "i");
    await until(async () => (await raw(n.id)).endsWith("Plant the *beans*"));
    await key(p, "i");
    await key(p, "x", true);
    await until(async () => (await raw(n.id)).endsWith("Plant the ~~beans~~"));
    await key(p, "x", true);
    await until(async () => (await raw(n.id)).endsWith("Plant the beans"));
    // Escape hides it until the selection changes.
    await p.keyboard.press("Escape");
    await until(async () => (await p.$(".cm-format-bar")) === null);
    // Link: the words stay, now pointing at a note.
    await selectLast(p, 5);
    await p.waitForSelector(".cm-format-bar");
    await p.click('.cm-format-btn[aria-label="Link"]');
    await p.waitForSelector("[data-dialog-input]");
    await p.keyboard.type("Allotment");
    await Bun.sleep(150);
    await p.keyboard.press("Enter");
    await until(async () => (await raw(n.id)).endsWith("Plant the [[Allotment|beans]]"));
    await p.close();
  });

  test("not while dragging a selection with the mouse: it appears when the button is let go", async () => {
    const n = await note("Usability/Drag.md", "# Drag\n\nSow the onions in March\n");
    const p = await openNote(n.id);
    await p.waitForSelector(".cm-content");
    const r = await p.evaluate(() => {
      const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent === "Sow the onions in March")!;
      const b = line.getBoundingClientRect();
      return { x: b.left + 2, y: b.top + b.height / 2, w: Math.min(b.width, 160) };
    });
    await p.mouse.move(r.x, r.y);
    await p.mouse.down();
    await p.mouse.move(r.x + r.w, r.y, { steps: 5 });
    await Bun.sleep(150);
    expect(await p.$(".cm-format-bar")).toBeNull();
    await p.mouse.up();
    await p.waitForSelector(".cm-format-bar");
    await p.close();
  });
});

describe("guided tour", () => {
  beforeAll(freshBrowser);
  /** Walk the tour from its first card to Done, noting each step and whether it found its target. */
  const walk = async (p: Page) => {
    const seen: { id: string; spot: boolean }[] = [];
    for (let i = 0; i < 30; i++) {
      await p.waitForFunction(() => {
        const c = document.querySelector<HTMLElement>(".tour-card");
        return c && c.style.visibility !== "hidden";
      });
      const step = await p.$eval(".tour", (t) => ({ id: (t as HTMLElement).dataset.step!, spot: !!document.querySelector(".tour-spot"), next: document.querySelector(".tour-next")!.textContent }));
      seen.push({ id: step.id, spot: step.spot });
      await p.click(".tour-next");
      if (step.next === "Done") break;
      await p.waitForFunction((id) => (document.querySelector<HTMLElement>(".tour")?.dataset.step ?? "") !== id, {}, step.id);
    }
    await p.waitForSelector(".tour", { hidden: true });
    return seen;
  };

  test("offered on the home page; the laptop tour points at each part, then isn't offered again", async () => {
    await note("Tour test/Seeds.md", "---\ntags: [garden]\n---\n# Seeds\n\nSow in spring.\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tour-offer-card");
    await p.click(".tour-offer-card .primary");
    const seen = await walk(p);
    expect(seen.map((s) => s.id)).toEqual(["welcome", "make", "files", "note", "properties", "writing", "views", "width", "more", "side", "help", "commands"]);
    // Every step with something to point at found it.
    expect(seen.filter((s) => !s.spot).map((s) => s.id)).toEqual(["welcome", "commands"]);
    expect(await p.evaluate(() => JSON.parse(localStorage.getItem("cp:tour")!).done)).toBe(true);
    await p.goto(`${BASE}/v/${vaultId}`, { waitUntil: "load" });
    await p.waitForSelector(".quick-actions");
    expect(await p.$(".tour-offer-card")).toBeNull();
    await p.close();
  });

  test("What's new: the steps since this device last looked; Escape ends it", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.evaluate(() => localStorage.setItem("cp:tour", JSON.stringify({ done: true, version: "0.0.66" })));
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector('.tour-offer-card[aria-label="What\'s new"]');
    await p.click(".tour-offer-card .primary");
    await p.waitForSelector(".tour-card");
    const count = await p.$eval(".tour-count", (e) => e.textContent!);
    expect(count).toMatch(/^1 of [2-9]$/);
    expect(await p.$eval(".tour", (t) => (t as HTMLElement).dataset.step)).toBe("new-r2");
    await p.keyboard.press("Escape");
    await p.waitForSelector(".tour", { hidden: true });
    await p.goto(`${BASE}/v/${vaultId}`, { waitUntil: "load" });
    await p.waitForSelector(".quick-actions");
    expect(await p.$(".tour-offer-card")).toBeNull();
    await p.close();
  });

  test("typing \"tour\" in Search or Find a note offers the tour; so does Help", async () => {
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".quick-actions");
    const stop = async () => {
      await p.waitForSelector(".tour-card");
      await p.keyboard.press("Escape");
      await p.waitForSelector(".tour", { hidden: true });
    };
    // The file panel's Search tab.
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar .tabs button")].find((b) => b.textContent?.includes("Search"))!.click());
    await p.waitForSelector(".search-panel input");
    await p.type(".search-panel input", "tour");
    await p.waitForSelector(".search-commands button");
    expect(await p.$$eval(".search-commands button span", (l) => l.map((e) => e.textContent))).toContain("Take the tour");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".search-commands button")].find((b) => b.textContent?.includes("Take the tour"))!.click());
    await stop();
    // Find a note (⌘O, and the 🔍 button on the iPhone).
    await p.keyboard.down("Meta");
    await p.keyboard.press("o");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".switcher input");
    await p.keyboard.type("tour");
    await p.waitForSelector(".switcher-command");
    expect(await p.$eval(".switcher li.on", (e) => e.textContent)).toContain("Take the tour");
    await p.keyboard.press("Enter");
    await stop();
    // Help.
    await p.click('.sidebar-foot button[aria-label="Help"]');
    await p.waitForSelector(".help-tour .primary");
    await p.click(".help-tour .primary");
    await stop();
    expect(await p.$(".modal")).toBeNull();
    await p.close();
  });

  test("the iPhone tour starts with the Home Screen and uses the phone's controls", async () => {
    const p = await open(`/v/${vaultId}`, true);
    await p.evaluate(() => localStorage.removeItem("cp:tour"));
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".tour-offer-card");
    await p.click(".tour-offer-card .primary");
    const seen = await walk(p);
    expect(seen.map((s) => s.id)).toEqual(["welcome", "home-screen", "files", "find", "note", "properties", "writing", "format-bar", "views", "more", "side", "commands"]);
    expect(seen.find((s) => s.id === "files")!.spot).toBe(true);
    expect(seen.find((s) => s.id === "more")!.spot).toBe(true);
    await p.close();
  });
});

describe("review fixes (N13, client)", () => {
  beforeAll(freshBrowser);
  const searchTab = (p: Page) =>
    p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar-tabs button, .tabs button")].find((b) => b.textContent?.includes("Search"))!.click());
  const dbNames = (p: Page) => p.evaluate(async () => (await indexedDB.databases()).map((d) => d.name ?? ""));
  const clearBox = async (p: Page, sel: string) => {
    await p.$eval(sel, (e) => (e as HTMLInputElement).select());
    await p.keyboard.press("Backspace");
  };

  test("someone else signing in on this browser doesn't get the last person's offline copies; the same person keeps theirs", async () => {
    const me = (await api("/session")).user.id as number;
    const instance = (await api("/session")).instance as string;
    const n = await note("Private/Diary.md", "# Diary\n\nMine alone.\n");
    const r = await fetch(`${BASE}/api/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE },
      body: JSON.stringify({ email: "other@example.com", password: "password-other", name: "Other" }),
    });
    const otherCookie = r.headers.get("set-cookie")!.split(";")[0]!.split("=")[1]!;
    const ctx = await browser.createBrowserContext(); // a browser of its own: nothing left from other tests
    const p = await ctx.newPage();
    p.on("pageerror", (e) => errors.push(e instanceof Error ? e.message : String(e)));
    await p.setViewport({ width: 1200, height: 850 });
    // Copies from before they were named by person, and a cached read: nobody can say whose they are.
    await p.goto(`${BASE}/health`);
    await p.evaluate(async (legacy) => {
      await new Promise((ok) => (indexedDB.open(legacy).onsuccess = ok));
      await (await caches.open("cp-api-v1")).put("/api/vaults/999/notes", new Response("[]"));
    }, `cp-${instance}-${n.id}`);
    await p.setCookie({ name: "cp_session", value: cookie.split("=")[1]!, url: BASE });
    await p.goto(`${BASE}/v/${vaultId}/n/${n.id}`, { waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await until(async () => (await content(p)).includes("Mine alone."));
    const mine = `cp-${instance}-u${me}-${n.id}`;
    await until(async () => {
      const names = await dbNames(p);
      return names.includes(mine) && !names.includes(`cp-${instance}-${n.id}`);
    });
    expect(await p.evaluate(async () => !!(await (await caches.open("cp-api-v1")).match("/api/vaults/999/notes")))).toBe(false);

    // The same person coming back keeps their copy.
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    await Bun.sleep(300);
    expect(await dbNames(p)).toContain(mine);

    // Their session ends, and someone else signs in here: the first person's copies go.
    await p.setCookie({ name: "cp_session", value: otherCookie, url: BASE });
    await p.goto(`${BASE}/`, { waitUntil: "load" });
    await p.waitForSelector(".sidebar");
    await until(async () => !(await dbNames(p)).some((d) => d.includes(`-u${me}-`)));
    await ctx.close();
  });

  test("search: clearing the box mid-debounce or mid-request clears it for good; a failed search says so and can try again", async () => {
    await note("Search fixes/Boiler service.md", "# Boiler service\n\nAnnual check of the combi boiler.\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    await searchTab(p);
    await p.waitForSelector(".search-panel input");
    const meta = () => p.$eval(".search-meta span", (e) => e.textContent ?? "");
    const hits = () => p.$$eval(".search-results li", (l) => l.length);

    // Cleared before the debounce fires: not stuck on "Searching…".
    await p.type(".search-panel input", "combi");
    await clearBox(p, ".search-panel input");
    await Bun.sleep(400);
    expect(await meta()).not.toContain("Searching");

    // A slow reply to a search that's been cleared doesn't bring its results back.
    let mode: "slow" | "fail" | "pass" = "slow";
    let asked = 0;
    await p.setRequestInterception(true);
    p.on("request", (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (!req.url().includes("/search?")) return void req.continue();
      asked++;
      if (mode === "slow") return void setTimeout(() => void req.continue().catch(() => {}), 900);
      if (mode === "fail") return void req.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "Search is resting for a moment." }) });
      void req.continue();
    });
    await p.type(".search-panel input", "combi");
    await until(() => asked > 0);
    await clearBox(p, ".search-panel input");
    await Bun.sleep(1300);
    expect(await hits()).toBe(0);
    expect(await meta()).not.toContain("Searching");

    // A failed search shows why, with a way to try again.
    serverDown = true; // the refused request is expected here
    mode = "fail";
    await p.type(".search-panel input", "combi");
    await p.waitForFunction(() => document.querySelector(".search-error")?.textContent?.includes("Search is resting for a moment."));
    expect(await meta()).toBe("Couldn't search");
    mode = "pass";
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".search-error button")].find((b) => b.textContent === "Try again")!.click());
    await p.waitForFunction(() => document.querySelector(".search-results")?.textContent?.includes("Boiler service"));
    expect(await p.$(".search-error")).toBeNull();
    serverDown = false;
    await p.close();
  });

  test("the links panel starts empty for each note, and says when its links couldn't load", async () => {
    const a = await note("Links fixes/Alpha.md", "# Alpha\n\nSee [[Beta]].\n");
    const b = await note("Links fixes/Beta.md", "# Beta\n\nNothing here.\n");
    const p = await openNote(a.id);
    await p.waitForFunction(() => document.querySelector(".links-panel")?.textContent?.includes("Links fixes/Beta"));
    serverDown = true;
    await p.setBypassServiceWorker(true); // the worker would fetch the links itself, past the interception
    await p.setRequestInterception(true);
    p.on("request", (req) => {
      if (req.isInterceptResolutionHandled()) return;
      if (/\/notes\/\d+\/links$/.test(new URL(req.url()).pathname)) return void req.respond({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "The server is busy." }) });
      void req.continue();
    });
    await p.evaluate((u) => (history.pushState(null, "", u), dispatchEvent(new PopStateEvent("popstate"))), `/v/${vaultId}/n/${b.id}`);
    await p.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Beta");
    // Alpha's outgoing link must not stay up as Beta's.
    expect(await p.$eval(".links-panel", (e) => e.textContent ?? "")).not.toContain("Links fixes/Beta");
    await p.waitForFunction(() => document.querySelector(".links-panel")?.textContent?.includes("Couldn't load this note's links. The server is busy."));
    serverDown = false;
    await p.close();
  });

  test("keyboard: folder rows open and close, the title renames, and the quick switcher keeps and returns focus", async () => {
    await note("Keyfolder/Inside note.md", "# Inside note\n");
    const n = await note("Keyfolder/Renamed by keys.md", "Text.\n"); // no heading: the title is the file's name
    const p = await openNote(n.id);
    const toggle = 'button.tree-toggle[aria-expanded]';
    const expanded = () => p.evaluate(() => [...document.querySelectorAll(".tree-toggle")].find((b) => b.textContent === "Keyfolder")?.getAttribute("aria-expanded"));
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".tree-toggle")].find((b) => b.textContent === "Keyfolder")!.focus());
    expect(await p.evaluate((s) => document.activeElement?.matches(s), toggle)).toBe(true);
    const was = await expanded();
    await p.keyboard.press("Enter");
    await until(async () => (await expanded()) !== was);
    await p.keyboard.press("Space");
    await until(async () => (await expanded()) === was);

    // The title: a focusable button named for what it does; Enter renames, and focus comes back.
    expect(await p.$eval(".note-title .title-button", (e) => e.getAttribute("aria-label"))).toBe("Rename “Renamed by keys”");
    await p.focus(".note-title .title-button");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.activeElement?.classList.contains("title-input"));
    await p.$eval(".title-input", (e) => (e as HTMLInputElement).select());
    await p.keyboard.type("Renamed with keys");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector(".note-title")?.textContent === "Renamed with keys");
    await p.waitForFunction(() => document.activeElement?.classList.contains("title-button"));

    // ⌘O: a modal that keeps Tab inside, and Escape puts focus back where it was.
    await p.keyboard.down("Meta");
    await p.keyboard.press("o");
    await p.keyboard.up("Meta");
    await p.waitForSelector('.switcher[role="dialog"][aria-modal="true"] input');
    await p.waitForFunction(() => document.activeElement?.matches(".switcher input"));
    for (let i = 0; i < 5; i++) {
      await p.keyboard.press("Tab");
      expect(await p.evaluate(() => !!document.activeElement?.closest(".switcher"))).toBe(true);
    }
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => !document.querySelector(".switcher"));
    await p.waitForFunction(() => document.activeElement?.classList.contains("title-button"));
    expect((await api(`/vaults/${vaultId}/notes/${n.id}`)).path).toBe("Keyfolder/Renamed with keys.md");
    await p.close();
  });
});

describe("keyboard only", () => {
  test("find a note, edit it, open Settings and get back, without the mouse; Tab stays inside a dialog", async () => {
    await freshBrowser();
    await note("Keys/Keyboard note.md", "# Keyboard note\n\nStart.\n");
    const p = await open(`/v/${vaultId}`);
    await p.waitForSelector(".tree-row");
    const press = async (key: string, mod?: "Meta" | "Shift") => {
      if (mod) await p.keyboard.down(mod);
      await p.keyboard.press(key as any);
      if (mod) await p.keyboard.up(mod);
    };
    await press("o", "Meta");
    await p.waitForSelector(".switcher input");
    await p.keyboard.type("Keyboard note");
    await p.waitForFunction(() => document.querySelector('.switcher [aria-selected="true"]')?.textContent?.includes("Keyboard note"));
    await press("Enter");
    await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Start."));
    await p.waitForFunction(() => document.activeElement?.classList.contains("cm-content"));
    await press("End", "Meta");
    await p.keyboard.type(" Typed.");
    await p.waitForFunction(() => document.querySelector(".cm-content")?.textContent?.includes("Start. Typed."));
    await press("k", "Meta");
    await p.waitForSelector(".palette input");
    await p.keyboard.type("Account settings");
    await p.waitForFunction(() => document.querySelector('.palette [aria-selected="true"]')?.textContent?.startsWith("Account"));
    await press("Enter");
    await p.waitForSelector(".settings-nav");
    // Tab round the dialog many times: focus never leaves it.
    for (let i = 0; i < 40; i++) {
      await press("Tab");
      expect(await p.evaluate(() => !!document.activeElement?.closest(".modal"))).toBe(true);
    }
    await press("Tab", "Shift");
    expect(await p.evaluate(() => !!document.activeElement?.closest(".modal"))).toBe(true);
    await press("Escape");
    await p.waitForFunction(() => !document.querySelector(".settings-nav"));
    await p.close();
  });
});

describe("boards (F11)", () => {
  const boardText = (nodes: object[], edges: object[] = []) =>
    `{\n\t"nodes":[\n${nodes.map((n) => `\t\t${JSON.stringify(n)}`).join(",\n")}\n\t],\n\t"edges":[\n${edges.map((e) => `\t\t${JSON.stringify(e)}`).join(",\n")}\n\t]\n}`;
  const openBoard = async (id: number, phone = false) => {
    const page = await open(`/v/${vaultId}/n/${id}`, phone);
    await page.waitForSelector(".board-body-wrap[data-synced] .react-flow__node");
    return page;
  };
  const stored = async (id: number) => (await api(`/vaults/${vaultId}/notes/${id}`)).content as string;

  test("a board from another editor opens with its cards, arrows and group, and a note edited elsewhere updates its card", async () => {
    await freshBrowser();
    const kitchen = await note("Boards/Kitchen.md", "# Kitchen\n\nQuotes from three builders.\n");
    const text = boardText(
      [
        { id: "g", type: "group", label: "Plans", x: -60, y: -80, width: 900, height: 560 },
        { id: "t", type: "text", text: "**Budget**: £20k", x: 0, y: 0, width: 260, height: 120 },
        { id: "k", type: "file", file: "Boards/Kitchen.md", x: 400, y: 0, width: 400, height: 300, color: "4" },
      ],
      [{ id: "e", fromNode: "t", fromSide: "right", toNode: "k", toSide: "left", label: "pays for" }],
    );
    const b = await note("Boards/House.canvas", text);
    expect(b.path).toBe("Boards/House.canvas");
    const p = await openBoard(b.id);
    await p.waitForFunction(() => document.querySelector(".board-note .board-body")?.textContent?.includes("Quotes from three builders"));
    expect(await p.$eval(".board-text .board-body", (e) => e.innerHTML)).toContain("<strong>Budget</strong>");
    expect(await p.$eval(".board-group-label", (e) => e.textContent)).toBe("Plans");
    expect(await p.$eval(".react-flow__edge-text", (e) => e.textContent)).toBe("pays for");
    expect(await p.$$eval(".board-note.board-c4", (l) => l.length)).toBe(1);
    // The editor's view switch isn't shown.
    expect(await p.$(".note-header .segmented")).toBeNull();
    // The note changes elsewhere: the card follows.
    await api(`/vaults/${vaultId}/notes/${kitchen.id}/content`, { content: "# Kitchen\n\nBuilder chosen.\n" }, "PUT");
    await p.waitForFunction(() => document.querySelector(".board-note .board-body")?.textContent?.includes("Builder chosen"), { timeout: 15_000 });
    // Opened and left alone, the file is exactly as it was.
    await p.close();
    await Bun.sleep(1500);
    expect(await stored(b.id)).toBe(text);
  });

  test("New board from ⌘K; add a text card and a note card, join them, label the arrow, Undo", async () => {
    const idea = await note("Boards/Idea.md", "# Idea\n\nA shed.\n");
    const p = await openNote(idea.id);
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette li");
    await p.keyboard.type("new board");
    await p.keyboard.press("Enter");
    await answer(p, "Garden");
    await p.waitForSelector(".board-body-wrap[data-synced] .board-empty");
    const id = Number(p.url().split("/").pop());
    expect((await api(`/vaults/${vaultId}/notes/${id}`)).path).toBe("Garden.canvas");
    // In the file tree, with a board's icon.
    await p.waitForFunction(() => [...document.querySelectorAll(".tree-row")].some((r) => r.textContent === "Garden" && r.querySelector(".tree-board")));

    // A text card, written in place.
    await p.click('.board-toolbar button[aria-label="Add a card"]');
    await p.waitForSelector(".menu-item");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Text")!.click());
    await p.waitForSelector(".board-text-edit");
    await p.keyboard.type("Plant **roses**");
    await p.keyboard.press("Escape");
    await p.waitForFunction(() => document.querySelector(".board-text .board-body")?.innerHTML.includes("<strong>roses</strong>"));

    // A note card, from the picker.
    await p.click('.board-toolbar button[aria-label="Add a card"]');
    await p.waitForSelector(".menu-item");
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent === "Note or board…")!.click());
    await p.waitForSelector(".choose input");
    await p.keyboard.type("Idea");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector(".board-note .board-body")?.textContent?.includes("A shed"));

    // New cards land near the middle, overlapping: Tidy up moves them apart. (Clear the
    // selection first, with a click on an empty corner, so it tidies the whole board.)
    const pane = (await (await p.$(".react-flow__pane"))!.boundingBox())!;
    await p.mouse.click(pane.x + 24, pane.y + pane.height - 24);
    await p.keyboard.down("Meta");
    await p.keyboard.press("k");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".palette li");
    await p.keyboard.type("tidy up the board");
    await p.keyboard.press("Enter");
    await until(async () => {
      const [a, b] = await p.$$eval(".react-flow__node", (l) => l.map((e) => e.getBoundingClientRect()).map((r) => ({ l: r.left, r: r.right, t: r.top, b: r.bottom })));
      return !!a && !!b && (a.r < b.l || b.r < a.l || a.b < b.t || b.b < a.t);
    });
    // Join them: drag from the text card's right edge to the note card.
    await p.evaluate(() => document.querySelector<HTMLElement>('button[aria-label="Fit the board"]')!.click());
    await Bun.sleep(400);
    const from = await p.$eval(".react-flow__node-text .react-flow__handle-right", (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const to = await p.$eval(".react-flow__node-file .react-flow__handle-left", (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await p.mouse.move(from.x, from.y);
    await p.mouse.down();
    await p.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 5 });
    await p.mouse.move(to.x, to.y, { steps: 5 });
    await p.mouse.up();
    await p.waitForSelector(".react-flow__edge");
    await until(async () => (JSON.parse(await stored(id)).edges ?? []).length === 1, 8000);
    const saved = JSON.parse(await stored(id));
    expect(saved.nodes.map((n: any) => n.type).sort()).toEqual(["file", "text"]);
    expect(saved.nodes.find((n: any) => n.type === "file").file).toBe("Boards/Idea.md");
    expect(saved.edges[0]).toMatchObject({ fromSide: "right", toSide: "left" });

    // Label the arrow by double-clicking it.
    const mid = await p.$eval(".react-flow__edge-interaction", (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await p.mouse.click(mid.x, mid.y, { count: 2 });
    await answer(p, "feeds");
    await p.waitForFunction(() => document.querySelector(".react-flow__edge-text")?.textContent === "feeds");
    // Undo takes the label back.
    await p.focus(".board");
    await p.keyboard.down("Meta");
    await p.keyboard.press("z");
    await p.keyboard.up("Meta");
    await p.waitForFunction(() => !document.querySelector(".react-flow__edge-text"));
    // The note knows it's on the board.
    await until(async () => ((await api(`/vaults/${vaultId}/notes/${idea.id}/links`)).boards ?? []).some((b: any) => b.id === id));
    await p.close();
  });

  test("a note knows its boards and the arrows to it; an arrow becomes a relation; a board on a board opens", async () => {
    const a = await note("Boards/Roof.md", "# Roof\n");
    const z = await note("Boards/Loft.md", "# Loft\n");
    const inner = await note("Boards/Detail.canvas", boardText([{ id: "d", type: "text", text: "Detail", x: 0, y: 0, width: 200, height: 80 }]));
    const b = await note(
      "Boards/Build.canvas",
      boardText(
        [
          { id: "r", type: "file", file: "Boards/Roof.md", x: 0, y: 0, width: 300, height: 200 },
          { id: "l", type: "file", file: "Boards/Loft.md", x: 500, y: 0, width: 300, height: 200 },
          { id: "n", type: "file", file: "Boards/Detail.canvas", x: 0, y: 400, width: 300, height: 220 },
        ],
        [{ id: "e", fromNode: "r", toNode: "l", label: "comes before" }],
      ),
    );
    // The note's side panel: the board it's on, and the arrow to it.
    const p = await openNote(z.id);
    if (!(await p.$(".app.right-open"))) await p.click('button[aria-label="Side panel"]');
    await p.waitForFunction(() => [...document.querySelectorAll(".links-panel h3")].some((h) => h.textContent?.startsWith("On boards")));
    const panel = await p.$eval(".links-panel", (e) => e.textContent ?? "");
    expect(panel).toContain("Build");
    expect(panel).toContain("← Roof · comes before · on Build");
    // Not counted again as a backlink.
    expect(await p.$$eval(".links-panel section", (l) => l.find((s) => s.querySelector("h3")?.textContent?.startsWith("Backlinks"))?.textContent ?? "")).not.toContain("Build");

    // On the board: select the arrow and make it a relation of Roof.
    await p.goto(`${BASE}/v/${vaultId}/n/${b.id}`);
    await p.waitForSelector(".board-body-wrap[data-synced] .react-flow__edge");
    await p.waitForFunction(() => document.querySelector(".board-preview rect"));
    const mid = await p.$eval(".react-flow__edge-interaction", (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await p.mouse.click(mid.x, mid.y);
    await p.waitForSelector('.board-toolbar button[aria-label="Make this a relationship"]');
    await p.click('.board-toolbar button[aria-label="Make this a relationship"]');
    // The builder, with the arrow's notes; its label isn't a kind yet, so it's offered as a new one.
    await p.waitForSelector('.rel-builder [data-combo="kind"]:focus');
    expect(await p.$eval('.rel-builder [data-combo="first"]', (e) => (e as HTMLInputElement).value)).toBe("Roof");
    expect(await p.$eval('.rel-builder [data-combo="second"]', (e) => (e as HTMLInputElement).value)).toBe("Loft");
    expect(await p.$eval('.rel-builder [data-combo="kind"]', (e) => (e as HTMLInputElement).value)).toBe("comes before");
    await p.waitForFunction(() => document.querySelector(".combo-list li.on")?.textContent?.includes("New kind “comes before”"));
    await p.keyboard.press("Enter");
    const other = await p.waitForSelector("[data-dialog-input]");
    await other!.evaluate((e) => (e as HTMLInputElement).select());
    await p.keyboard.type("comes after");
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => document.querySelector(".rel-said")?.textContent === "Roof comes before Loft");
    await p.waitForSelector(".rel-builder [data-dialog-action]:focus");
    await p.keyboard.press("Enter");
    await until(async () => (await stored(a.id)).includes('comes-before: "[[Loft]]"'));
    // The new kind is in the collection's Relationships note, with both names.
    const kinds = (await api(`/vaults/${vaultId}/notes`)).find((n: any) => n.path === "Relationships.md");
    expect(await stored(kinds.id)).toContain("| comes before | comes after |  |");
    await api(`/vaults/${vaultId}/notes/${kinds.id}`, undefined, "DELETE");

    // The board card opens its board.
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".board-board .board-card-head")].find((h) => h.textContent?.includes("Detail"))!.click());
    await until(() => p.url().endsWith(`/n/${inner.id}`));
    await p.waitForSelector(".board-body-wrap[data-synced] .board-text");
    await p.close();
  });

  test("arrows by keyboard (F31): the list as sentences, Reverse with Undo, Connect to… without dragging", async () => {
    await note("Boards/Walls.md", "# Walls\n");
    await note("Boards/Floor.md", "# Floor\n");
    const b = await note(
      "Boards/Order.canvas",
      boardText(
        [
          { id: "w", type: "file", file: "Boards/Walls.md", x: 0, y: 0, width: 300, height: 200 },
          { id: "f", type: "file", file: "Boards/Floor.md", x: 500, y: 0, width: 300, height: 200 },
          { id: "t", type: "text", text: "Paint", x: 0, y: 400, width: 200, height: 80 },
        ],
        [{ id: "e", fromNode: "w", fromSide: "right", toNode: "f", toSide: "left", label: "before" }],
      ),
    );
    const p = await openBoard(b.id);
    const palette = async (words: string) => {
      await p.focus(".board");
      await p.keyboard.down("Meta");
      await p.keyboard.press("k");
      await p.keyboard.up("Meta");
      await p.waitForSelector(".palette li");
      await p.keyboard.type(words);
      await p.keyboard.press("Enter");
    };
    const edges = async () => JSON.parse(await stored(b.id)).edges as any[];

    // The arrows list says each arrow as a sentence; choosing one selects it.
    await palette("arrows on this board");
    await p.waitForSelector(".choose li");
    expect(await p.$$eval(".choose li", (l) => l.map((e) => e.textContent?.trim()))).toEqual(["Walls → before → Floor"]);
    await p.keyboard.press("Enter");
    await p.waitForSelector('.board-toolbar button[aria-label="Reverse the arrow"]');

    // Reverse: ends and sides change places, in the file too; Undo puts it back.
    await p.click('.board-toolbar button[aria-label="Reverse the arrow"]');
    await until(async () => (await edges())[0]?.fromNode === "f", 8000);
    expect((await edges())[0]).toMatchObject({ fromNode: "f", fromSide: "left", toNode: "w", toSide: "right", label: "before" });
    await p.waitForFunction(() => [...document.querySelectorAll(".toast")].some((t) => t.textContent?.includes("Floor → before → Walls")));
    await p.focus(".board");
    await p.keyboard.down("Meta");
    await p.keyboard.press("z");
    await p.keyboard.up("Meta");
    await until(async () => (await edges())[0]?.fromNode === "w", 8000);

    // Connect to…: select the text card, pick Floor from the list, and the arrow is drawn.
    await p.click('.react-flow__node[data-id="t"] .board-body');
    await palette("connect to");
    await p.waitForSelector(".choose input");
    await p.keyboard.type("Floor");
    await p.keyboard.press("Enter");
    await until(async () => (await edges()).length === 2, 8000);
    expect((await edges()).find((e) => e.fromNode === "t")).toMatchObject({ toNode: "f" });
    await p.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 2);
    await p.close();
  });

  test("two people move different cards at once; both moves stay", async () => {
    const b = await note(
      "Boards/Shared.canvas",
      boardText([
        { id: "a", type: "text", text: "A", x: 0, y: 0, width: 200, height: 80 },
        { id: "b", type: "text", text: "B", x: 400, y: 0, width: 200, height: 80 },
      ]),
    );
    const p1 = await openBoard(b.id);
    const p2 = await openBoard(b.id);
    const drag = async (p: Page, id: string, dy: number) => {
      const r = await p.$eval(`.react-flow__node[data-id="${id}"]`, (e) => {
        const b = e.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      });
      await p.mouse.move(r.x, r.y);
      await p.mouse.down();
      await p.mouse.move(r.x, r.y + dy / 2, { steps: 4 });
      await p.mouse.move(r.x, r.y + dy, { steps: 4 });
      await p.mouse.up();
    };
    // Headless Chrome only takes input in the tab in front, so one after the other, each page
    // still showing the other's card where it was.
    await p1.bringToFront();
    await drag(p1, "a", 120);
    await p2.bringToFront();
    await drag(p2, "b", 160);
    await until(async () => {
      const c = JSON.parse(await stored(b.id));
      return c.nodes.find((n: any) => n.id === "a").y > 50 && c.nodes.find((n: any) => n.id === "b").y > 50;
    }, 8000);
    // Each page shows the other's move (a page behind another draws when it comes to the front).
    await p1.bringToFront();
    const y = (p: Page, id: string) => p.$eval(`.react-flow__node[data-id="${id}"]`, (e) => (e as HTMLElement).style.transform);
    await until(async () => (await y(p1, "b")) === (await y(p2, "b")) && (await y(p1, "a")) === (await y(p2, "a")));
    await p1.close();
    await p2.close();
  });

  test("150 cards: the board opens and pans smoothly on the phone", async () => {
    const nodes = Array.from({ length: 150 }, (_, i) => ({ id: `n${i}`, type: "text", text: `Card ${i}\n\nSome words on it.`, x: (i % 15) * 300, y: Math.floor(i / 15) * 200, width: 260, height: 140 }));
    const edges = nodes.slice(1).map((n, i) => ({ id: `e${i}`, fromNode: `n${i}`, toNode: n.id }));
    const b = await note("Boards/Big.canvas", boardText(nodes, edges));
    const started = Date.now();
    const p = await openBoard(b.id, true);
    const openMs = Date.now() - started;
    // Pan with one finger: 60 moves, 16 ms apart. Slow drawing shows as the moves running late.
    const run = await p.evaluate(async () => {
      const pane = document.querySelector(".react-flow__pane")!;
      const view = document.querySelector<HTMLElement>(".react-flow__viewport")!;
      const before = view.style.transform;
      const r = pane.getBoundingClientRect();
      const t = (x: number, y: number) => new Touch({ identifier: 1, target: pane, clientX: x, clientY: y });
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const start = performance.now();
      pane.dispatchEvent(new TouchEvent("touchstart", { touches: [t(cx, cy)], changedTouches: [t(cx, cy)], bubbles: true, cancelable: true }));
      for (let i = 1; i <= 60; i++) {
        await new Promise((res) => setTimeout(res, 16));
        pane.dispatchEvent(new TouchEvent("touchmove", { touches: [t(cx - i * 5, cy - i * 3)], changedTouches: [t(cx - i * 5, cy - i * 3)], bubbles: true, cancelable: true }));
      }
      pane.dispatchEvent(new TouchEvent("touchend", { touches: [], changedTouches: [t(cx - 300, cy - 180)], bubbles: true, cancelable: true }));
      return { ms: performance.now() - start, moved: view.style.transform !== before };
    });
    console.log(`  150-card board: opened in ${openMs} ms; 60 pan moves took ${Math.round(run.ms)} ms (≥ 960 ms of waiting)`);
    expect(openMs).toBeLessThan(10_000);
    expect(run.moved).toBe(true);
    expect(run.ms).toBeLessThan(2500);
    await p.close();
  });
});

describe("collaboration and home", () => {
  beforeAll(freshBrowser);
  test("two pages edit the same note live", async () => {
    const n = await note("Shared.md", "start");
    const [a, b] = [await openNote(n.id), await openNote(n.id, true)];
    await a.bringToFront(); // headless Chrome stalls input to background tabs
    await a.click(".cm-content");
    await a.keyboard.down("Meta");
    await a.keyboard.press("ArrowDown");
    await a.keyboard.up("Meta");
    await a.keyboard.type(" typed live");
    await until(async () => (await content(b)).includes("start typed live"));
    await a.close();
    await b.close();
  });

  test("a vault with only folders doesn't say it's empty", async () => {
    const v = await api("/vaults", { name: "Folders only" });
    await api(`/vaults/${v.id}/folders`, { path: "Ideas" });
    const p = await open(`/v/${v.id}`);
    await p.waitForFunction(() => /No notes yet|This collection is empty/.test(document.querySelector(".vault-home")?.textContent ?? ""));
    const text = await p.$eval(".vault-home", (e) => e.textContent ?? "");
    expect(text).not.toContain("This collection is empty");
    expect(text).toContain("No notes yet");
    await p.close();
  });

  test("the sidebar toggle and ⌘\\ hide and show the file panel, remembered after a reload", async () => {
    const n = await note("Wide.md", "# Wide");
    const p = await openNote(n.id);
    const shown = () => p.$eval(".sidebar", (e) => getComputedStyle(e).visibility === "visible");
    const noteWidth = () => p.$eval(".main", (e) => e.getBoundingClientRect().width);
    expect(await shown()).toBe(true);
    const before = await noteWidth();
    await p.waitForSelector(".app.ready"); // the panels animate only once the first layout has settled
    // It slides: the column passes through widths between open and closed.
    const widths = await p.evaluate(async () => {
      document.querySelector<HTMLButtonElement>('button[aria-label="Files"]')!.click();
      const out: number[] = [];
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 30));
        out.push(parseFloat(getComputedStyle(document.querySelector(".app")!).getPropertyValue("--left")));
      }
      return out;
    });
    expect(widths.some((w) => w > 1 && w < 271)).toBe(true);
    await until(async () => !(await shown()) && (await noteWidth()) > before + 200);
    expect(await p.$eval('button[aria-label="Files"]', (e) => e.getAttribute("aria-expanded"))).toBe("false");
    await p.reload({ waitUntil: "load" });
    await p.waitForSelector(".cm-content");
    expect(await shown()).toBe(false);
    await p.keyboard.down("Meta");
    await p.keyboard.press("Backslash");
    await p.keyboard.up("Meta");
    await until(shown);
    expect(await p.evaluate(() => localStorage.getItem("cp:left"))).toBe("1");
    await p.close();
  });

  test("no page errors anywhere above", () => {
    expect(errors).toEqual([]);
  });
});

async function rowOfLine(p: Page, text: string) {
  const h = await p.evaluateHandle((t) => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.includes(t)), text);
  return (h as any).boundingBox() as Promise<{ x: number; y: number; width: number; height: number } | null>;
}
const lineText = (p: Page, text: string) =>
  p.evaluate((t) => [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.includes(t))?.textContent ?? null, text);

describe("the cloud library on the Mac (F23)", () => {
  // The test server plays both parts: it's the Mac, and the cloud library the Mac signs in to.
  test("sign in from Connections through the consent page; the menu's In the cloud group; a cloud note edits live; its settings say what's done where", async () => {
    const n = await note("Cloud check.md", "# Cloud check\n");
    const p = await open(`/v/${vaultId}`);
    try {
      await p.waitForSelector(".tree-row");
      await p.click('button[aria-label="Settings"]');
      await p.waitForSelector(".settings-nav");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
      await p.waitForSelector('.cloud-connect input[type="url"]');
      await p.type('.cloud-connect input[type="url"]', BASE);
      await p.click('.cloud-connect button[type="submit"]');
      await p.waitForFunction(() => document.querySelector(".consent h2")?.textContent?.startsWith("Sign in"));
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".consent-actions button")].find((b) => b.textContent === "Sign in")!.click());
      await p.waitForFunction(() => document.body.textContent?.includes("Signed in to the cloud library"));
      expect(new URL(p.url()).search).toBe(""); // the result was read and taken off the address
      await until(async () => (await p.$$eval('select[aria-label="Collection"] optgroup', (g) => g.map((x) => x.getAttribute("label")))).includes("In the cloud"));
      const main = ((await api("/vaults")) as { id: number; name: string; cloud?: boolean }[]).find((v) => v.id === vaultId)!;
      const cloud = ((await api("/vaults")) as { id: number; name: string; cloud?: boolean }[]).find((v) => v.cloud && v.name === main.name)!;
      expect(cloud.id).not.toBe(vaultId);

      const q = await open(`/v/${cloud.id}/n/${n.id}`);
      await q.waitForSelector(".note-body[data-synced]");
      expect(await content(q)).toContain("Cloud check");
      await q.click(".cm-content");
      await q.keyboard.press("End");
      await q.keyboard.down("Meta");
      await q.keyboard.press("ArrowDown");
      await q.keyboard.up("Meta");
      await q.keyboard.type("Typed through the Mac.");
      await until(async () => ((await api(`/vaults/${vaultId}/notes/${n.id}`)) as { content: string }).content.includes("Typed through the Mac."), 10_000);
      await q.click('button[aria-label="Settings"]');
      await q.waitForFunction(() => document.querySelector(".modal")?.textContent?.includes("Members, renaming, publishing as a website, GitHub and imports are done in the cloud library itself."));
      await q.close();
    } finally {
      await api("/cloud", undefined, "DELETE");
      await p.close();
    }
    expect(((await api("/vaults")) as { cloud?: boolean }[]).some((v) => v.cloud)).toBe(false);
  });
});

describe("the web clipper (F37)", () => {
  test("in Chrome: the extension's worker sends a selection and a page to the Inbox with a capture token", async () => {
    // A copy of clipper/ allowed to reach this test server (the real one asks for the address
    // when its options are saved, which a test can't answer).
    const dir = mkdtempSync(join(tmpdir(), "skein-clipper-"));
    await Bun.$`cp -R ${join(import.meta.dir, "../../clipper")}/. ${dir}`;
    const manifest = await Bun.file(join(dir, "manifest.json")).json();
    manifest.host_permissions = ["http://localhost/*"];
    await Bun.write(join(dir, "manifest.json"), JSON.stringify(manifest));
    const made = await api("/me/tokens", { vaultId, name: "Clipper test" });
    const b = await puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox", `--disable-extensions-except=${dir}`, `--load-extension=${dir}`] });
    try {
      const worker = await b.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("/background.js"), { timeout: 15000 });
      const id = new URL(worker.url()).host;
      const p = await b.newPage();
      await p.goto(`chrome-extension://${id}/options.html`);
      await p.evaluate((server, token) => (globalThis as any).chrome.storage.local.set({ server, token }), BASE, made.token);
      const send = (clip: unknown) => p.evaluate((c) => (globalThis as any).chrome.runtime.sendMessage({ type: "clip", clip: c }), clip);
      expect(await send({ kind: "selection", url: "https://example.com/bread", title: "Bread", selection: "Feed the starter" })).toEqual({ ok: true, message: "Saved it to Inbox" });
      expect(await send({ kind: "page", url: "https://example.com/soup", title: "Leek soup" })).toMatchObject({ ok: true });
      const inbox = ((await api(`/vaults/${vaultId}/notes`)) as { id: number; path: string }[]).find((n) => n.path === "Inbox.md")!;
      const text = (await api(`/vaults/${vaultId}/notes/${inbox.id}`)).content as string;
      expect(text).toContain("> Feed the starter");
      expect(text).toContain("— [Bread](https://example.com/bread)");
      expect(text).toContain("|Leek soup]]");
    } finally {
      await b.close();
      await api(`/me/tokens/${made.row.id}`, undefined, "DELETE");
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("share one note by link (F38)", () => {
  test("⋯ → Share by link…: confirm, the link is made, and the page shows the note with no script", async () => {
    const n = await note("Shared soup.md", "Leeks and potatoes.");
    const p = await open(`/v/${vaultId}/n/${n.id}`);
    try {
      await p.waitForSelector(".cm-content");
      await p.click('button[aria-label="More"]');
      await p.waitForSelector(".menu");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Share by link"))!.click());
      await p.waitForFunction(() => document.querySelector(".modal")?.textContent?.includes("Anyone with the link can read this note"));
      await p.click(".modal [data-dialog-action]");
      await p.waitForFunction(() => document.querySelector(".toast")?.textContent?.startsWith("Shared"));
      const s = await api(`/vaults/${vaultId}/notes/${n.id}/share`);
      expect(s.shared).toBe(true);
      const page = await fetch(`${BASE}${s.url}Shared%20soup`);
      expect(await page.text()).toContain("Leeks and potatoes.");
      // Again: now it offers the link and Stop sharing, which has Undo.
      await p.click('button[aria-label="More"]');
      await p.waitForSelector(".menu");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Share by link"))!.click());
      await p.waitForFunction(() => document.querySelector(".modal")?.textContent?.includes("is shared by link"));
      await p.evaluate(() => [...document.querySelectorAll<HTMLElement>(".modal [role=option], .modal button")].find((b) => b.textContent?.includes("Stop sharing"))!.click());
      await p.waitForFunction(() => document.querySelector(".toast")?.textContent?.includes("isn't shared any more"));
      expect((await fetch(`${BASE}${s.url}Shared%20soup`)).status).toBe(404);
    } finally {
      await p.close();
    }
  });
});


describe("notifications (F39)", () => {
  test("the bell counts what's new; its list opens the note someone mentioned you in, and Mark all read clears it", async () => {
    const me = (await api("/session")).user as { name: string };
    const r = await fetch(`${BASE}/api/register`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: "nina@example.com", password: "password-nina", name: "Nina" }) });
    const nina = r.headers.get("set-cookie")!.split(";")[0]!;
    const as = (path: string, body?: unknown) => fetch(`${BASE}/api${path}`, { method: body ? "POST" : "GET", headers: { cookie: nina, origin: BASE, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined }).then((x) => x.json());
    await api(`/vaults/${vaultId}/members`, { email: "nina@example.com", role: "editor" }, "PUT");
    const invite = ((await as("/invitations")) as { id: number; vault_id: number }[]).find((i) => i.vault_id === vaultId)!;
    await as(`/invitations/${invite.id}/accept`, {});
    await api("/me/notifications/read", { all: true });
    const n = await as(`/vaults/${vaultId}/notes`, { path: "Grout.md", content: `@${me.name} which colour?` });
    await until(async () => (await api("/me/notifications")).unread > 0);
    const p = await open(`/v/${vaultId}`);
    try {
      await p.waitForSelector(".bell-count");
      await p.click("button.bell");
      await p.waitForFunction(() => document.querySelector(".notification-list .unread")?.textContent?.includes("Nina mentioned you in “Grout”"));
      await p.evaluate(() => document.querySelector<HTMLButtonElement>(".notification-list .unread button")!.click());
      await p.waitForFunction((id) => location.pathname.endsWith(`/n/${id}`), {}, n.id);
      await until(async () => (await api("/me/notifications")).unread === 0);
      await p.waitForFunction(() => !document.querySelector(".bell-count"));
    } finally {
      await p.close();
    }
  });
});

describe("comments (L3)", () => {
  test("select words, ⋯ → Comment…: the words are marked and the thread is in the side panel; it stays on them while someone else edits", async () => {
    const n = await note("Comment anchor.md", "Line one.\nPick the blue tiles today.\n");
    const p = await open(`/v/${vaultId}/n/${n.id}`);
    try {
      await p.waitForSelector(".cm-content");
      await until(async () => (await content(p)).includes("blue tiles"));
      // Select "blue tiles" in the editor, as a person dragging over it would.
      await p.evaluate(() => {
        const walker = document.createTreeWalker(document.querySelector(".cm-content")!, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          const i = t.textContent!.indexOf("blue tiles");
          if (i < 0) continue;
          const r = document.createRange();
          r.setStart(t, i);
          r.setEnd(t, i + "blue tiles".length);
          getSelection()!.removeAllRanges();
          getSelection()!.addRange(r);
          return;
        }
      });
      await Bun.sleep(200);
      await p.click('button[aria-label="More"]');
      await p.waitForSelector(".menu");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Comment…"))!.click());
      await p.waitForSelector(".modal input");
      expect(await p.$eval(".modal", (e) => e.textContent ?? "")).toContain("On “blue tiles”");
      await p.keyboard.type("Or the green ones?");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => document.querySelector(".cm-commented")?.textContent === "blue tiles");
      await p.waitForFunction(() => document.querySelector(".comment-thread")?.textContent?.includes("Or the green ones?"));
      // Someone else adds words before the commented ones, then after them.
      await api(`/vaults/${vaultId}/notes/${n.id}/content`, { content: "Line one, and more.\nNow: pick the blue tiles today.\n" }, "PUT");
      await until(async () => (await content(p)).includes("Now: pick"));
      await api(`/vaults/${vaultId}/notes/${n.id}/content`, { content: "Line one, and more.\nNow: pick the blue tiles today, please.\n" }, "PUT");
      await until(async () => (await content(p)).includes("please"));
      await p.waitForFunction(() => document.querySelector(".cm-commented")?.textContent === "blue tiles", { timeout: 5000 });
      // Resolve: the mark goes; the thread folds away under "1 resolved".
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".comment-thread button")].find((b) => b.textContent === "Resolve")!.click());
      await p.waitForFunction(() => !document.querySelector(".cm-commented") && document.querySelector(".comments summary")?.textContent === "1 resolved");
    } finally {
      await p.close();
    }
  });
});
