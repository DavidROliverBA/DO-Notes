// Screenshots of the main screens on a laptop and an iPhone, in light and dark, for checking the
// design against docs/PRINCIPLES.md. Not a test: `bun run screens [out-dir]` (default ./screens,
// gitignored). `bun run screens --help` also writes the help's pictures (docs/help/images/, light
// only), including one of the standalone file. `bun run readme:shot` only makes the README's
// picture (docs/images/hero.webp): the app on a laptop in dark and an iPhone in light, framed. Like the UI tests it needs Chrome and the docker database, on which it drops and
// recreates its own scratch database, `commonplace_screens`.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import postgres from "postgres";
import puppeteer, { type Page } from "puppeteer-core";
import { startFakeAi } from "../fakeAi";
import { startFakeGitHub, TOKEN } from "../fakeGitHub";
import { demoFiles } from "../../scripts/demo";
import { chromePath } from "./chrome";

const PORT = 3399;
const BASE = `http://localhost:${PORT}`;
const ADMIN_DB = process.env.UI_ADMIN_DATABASE_URL ?? "postgres://commonplace:commonplace@localhost:5434/commonplace";
const DB = ADMIN_DB.replace(/\/[^/]+$/, "/commonplace_screens");
const OUT = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "screens";
const HELP = process.argv.includes("--help");
const HELP_DIR = "docs/help/images";
const README = process.argv.includes("--readme");
/** The shots the help pages show (docs/help/*.md), and their names there. */
const HELP_SHOTS: Record<string, string> = {
  "laptop-light-1-home": "vault-home",
  "laptop-light-2-note": "live-preview",
  "laptop-light-2c-focus-mode": "focus-mode",
  "laptop-light-3-menu": "note-menu",
  "laptop-light-3b-slash": "slash-menu",
  "laptop-light-3c-palette": "command-palette",
  "laptop-light-3e-block-menu": "block-menu",
  "laptop-light-4-files": "file-panel",
  "laptop-light-6-toast": "undo-toast",
  "laptop-light-7b-settings": "settings",
  "laptop-light-7c-website": "website-settings",
  "laptop-light-7d-website-builder": "website-builder",
  "laptop-light-8-ai-panel": "ai-panel",
  "laptop-light-8c-inline": "ai-inline",
  "laptop-light-9-boyai": "add-assistant",
  "laptop-light-10-type-page": "type-page",
  "laptop-light-10b-typed-note": "typed-note",
  "laptop-light-10c-type-editor": "type-editor",
  "laptop-light-10d-new-type": "new-type",
  "laptop-light-11-embed-card": "embeds",
  "laptop-light-12-tasks": "tasks",
  "laptop-light-12c-journal": "journal",
  "laptop-light-12b-mentions": "links-panel",
  "laptop-light-13-branch-bar": "github-branch-bar",
  "laptop-light-13b-changes": "github-changes",
  "laptop-light-13c-pull-request": "github-pull-request",
  "laptop-light-13d-auto-bar": "github-auto-bar",
  "laptop-light-13f-sending": "github-sending",
  "laptop-light-14-site-page": "published-page",
  "laptop-light-15-graph": "graph",
  "laptop-light-15b-graph-filters": "graph-filters",
  "laptop-light-15d-graph-tab": "graph-tab",
  "laptop-light-15e-graph-timeline": "graph-timeline",
  "laptop-light-16-diagram": "diagram-and-query",
  "laptop-light-17-search": "search",
  "laptop-light-18-history": "history",
  "phone-light-2-note": "phone-note",
  "phone-light-4-files": "phone-files",
  "phone-light-7-share-setup": "phone-share-setup",
};
if (HELP) mkdirSync(HELP_DIR, { recursive: true });
mkdirSync(OUT, { recursive: true });

const admin = postgres(ADMIN_DB, { onnotice: () => {} });
await admin.unsafe("drop database if exists commonplace_screens with (force)");
await admin.unsafe("create database commonplace_screens");
await admin.end();
const fake = startFakeAi(3394);
const fakeGh = startFakeGitHub(3385);
const server = Bun.spawn(["bun", "src/server.ts"], {
  env: { ...process.env, DATABASE_URL: DB, PORT: String(PORT), ALLOW_SIGNUP: "true", SETUP_TOKEN: "", EMBEDDING_PROVIDER: "hash", SECRETS_KEY: "screens-key", ALLOW_LOCAL_AI: "true", GITHUB_API_URL: "http://localhost:3385", NODE_ENV: "production" },
  stdout: "ignore",
  stderr: "inherit",
});

try {
  for (let i = 0; i < 200 && !(await fetch(`${BASE}/health`).catch(() => null))?.ok; i++) await Bun.sleep(100);
  const r = await fetch(`${BASE}/api/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: BASE },
    body: JSON.stringify({ email: "screens@example.com", password: "password-screens", name: "Sam" }),
  });
  const cookie = r.headers.get("set-cookie")!.split(";")[0]!;
  const api = async (path: string, body?: unknown, method?: string) => {
    const res = await fetch(`${BASE}/api${path}`, { method: method ?? (body ? "POST" : "GET"), headers: { cookie, "content-type": "application/json", origin: BASE }, body: body ? JSON.stringify(body) : undefined });
    return res.json();
  };
  const vaultId = (await api("/vaults"))[0].id;
  // An invitation waiting for Sam (N13), so the file panel shots show the card.
  const pr = await fetch(`${BASE}/api/register`, { method: "POST", headers: { "content-type": "application/json", origin: BASE }, body: JSON.stringify({ email: "priya@example.com", password: "password-priya", name: "Priya" }) });
  const priya = pr.headers.get("set-cookie")!.split(";")[0]!;
  const asPriya = (path: string, body: unknown, method = "POST") => fetch(`${BASE}/api${path}`, { method, headers: { cookie: priya, "content-type": "application/json", origin: BASE }, body: JSON.stringify(body) }).then((x) => x.json());
  const garden = await asPriya("/vaults", { name: "Garden" });
  await asPriya(`/vaults/${garden.id}/members`, { email: "screens@example.com", role: "editor" }, "PUT");
  for (const f of ["Projects", "Projects/Kitchen", "Recipes"]) await api(`/vaults/${vaultId}/folders`, { path: f });
  const contractors = await api(`/vaults/${vaultId}/notes`, { path: "Projects/Contractors.md", content: "# Contractors\n\nBuilders and trades." });
  await api(`/vaults/${vaultId}/notes`, { path: "Diary.md", content: "# Diary\n\nRang the contractors about the worktops.\n\n- [ ] Pay the deposit 📅 2026-10-09\n- [ ] Order tiles 📅 2026-10-30\n" });
  const kitchen = await api(`/vaults/${vaultId}/notes`, {
    path: "Projects/Kitchen/Kitchen plan.md",
    content:
      "---\ntags: [home, kitchen]\nstatus: in progress\nbudget: 7500\ndue: 2026-11-30\n---\n# Kitchen plan\n\nAgreed with [[Contractors|our builders]]: **quartz** worktops, *oak* floor, and ==new lighting==.\n\n> [!tip] Decision\n> Go with the quartz.\n\n## Tasks\n- [x] Get quotes\n- [ ] Choose tiles\n- [ ] Book the electrician\n\n## Costs\n\n| Item | Cost |\n|---|---:|\n| Units | £4,200 |\n| Worktops | £1,900 |\n",
  });
  await api(`/vaults/${vaultId}/notes`, { path: "Recipes/Pancakes.md", content: "# Pancakes\n\n- 100 g flour\n- 2 eggs\n- 300 ml milk" });
  // Types (F16): People and Meetings, related.
  const personType = await api(`/vaults/${vaultId}/notes`, { path: "Types/Person.md", content: "---\nicon: user\ncolour: blue\nproperties:\n  - name: role\n    kind: select\n    options: [Builder, Electrician, Designer, Friend]\n  - name: company\n    kind: text\n  - name: phone\n    kind: text\n  - name: met\n    kind: date\n---\n# {{title}}\n\n## Notes\n" });
  await api(`/vaults/${vaultId}/notes`, { path: "Types/Meeting.md", content: "---\nicon: calendar\ncolour: amber\nproperties:\n  - name: date\n    kind: date\n  - name: attendees\n    kind: relation\n    type: Person\n    many: true\n---\n# {{title}}\n\n## Agenda\n\n## Actions\n" });
  for (const [name, role, company, phone] of [["Sam Okafor", "Builder", "Okafor & Sons", "07700 900123"], ["Priya Shah", "Designer", "Shah Interiors", "07700 900456"], ["Tom Reed", "Electrician", "Reed Electrical", ""]])
    await api(`/vaults/${vaultId}/notes`, { path: `People/${name}.md`, content: `---\ntype: Person\nrole: ${role}\ncompany: ${company}\n${phone ? `phone: ${phone}\n` : ""}---\n# ${name}\n` });
  // Earlier meetings, for the graph's timeline.
  await api(`/vaults/${vaultId}/notes`, { path: "Meetings/Survey visit.md", content: '---\ntype: Meeting\ndate: 2026-07-14\nattendees:\n  - "[[Sam Okafor]]"\n---\n# Survey visit\n' });
  await api(`/vaults/${vaultId}/notes`, { path: "Meetings/Quote review.md", content: '---\ntype: Meeting\ndate: 2026-08-21\nattendees:\n  - "[[Sam Okafor]]"\n  - "[[Priya Shah]]"\n---\n# Quote review\n\nAfter the [[Survey visit]].\n' });
  const kickoff = await api(`/vaults/${vaultId}/notes`, { path: "Meetings/Kitchen kickoff.md", content: '---\ntype: Meeting\ndate: 2026-10-08\nattendees:\n  - "[[Sam Okafor]]"\n  - "[[Priya Shah]]"\n---\n# Kitchen kickoff\n\n## Agenda\n- Worktops\n- Lighting\n' });
  const timeline = await api(`/vaults/${vaultId}/notes`, {
    path: "Projects/Kitchen/Timeline.md",
    content: '# Timeline\n\n```mermaid\nflowchart LR\n  Q[Quotes] --> O[Order units] --> F[Fit] --> D[Done]\n```\n\nEvery project, from its properties:\n\n```dataview\nTABLE status, due, budget\nFROM "Projects"\nWHERE status\n```\n',
  });
  const overview = await api(`/vaults/${vaultId}/notes`, { path: "Projects/Kitchen/Overview.md", content: "# Kitchen overview\n\nThe builder:\n\n[[Sam Okafor]]\n\nWhat's left, from the plan:\n\n![[Kitchen plan#Tasks]]\n" });
  // The journal (F24): a few days of entries, one from a year ago for On this day.
  const today = new Date();
  const dayOf = (back: number, years = 0) => {
    const d = new Date(today.getFullYear() - years, today.getMonth(), today.getDate() - back);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  for (const [day, time, text] of [
    [dayOf(0, 1), "18:30", "Got the keys. The kitchen is worse than it looked at the viewing."],
    [dayOf(2), "20:15", "Sam came round about the worktops. **Quartz** it is."],
    [dayOf(1), "07:50", "Coffee on the step before anyone was up."],
    [dayOf(0), "08:05", "Tiles to choose this week. Priya sent three samples."],
    [dayOf(0), "21:40", "Long walk by the harbour; the light was lovely."],
  ] as const)
    await api("/journal", { text, day, time, vaultId });

  await api("/me/assistants", { name: "Claude", provider: "compatible", baseUrl: `${fake.url}/v1`, model: "claude-opus-5-5", apiKey: "screens-fake-key", web: true });
  // One AI exchange: a search, an answer with a link, and a page proposed for approval.
  const aiScript = () =>
    fake.script.push(
      { text: "Let me check your notes.", calls: [{ name: "search_notes", input: { query: "kitchen" } }] },
      {
        text: "Your [[Kitchen plan]] has two tasks left: **choose tiles** and **book the electrician**. Shall I make a checklist page?",
        calls: [{ name: "create_note", input: { path: "Projects/Kitchen/Checklist", content: "# Kitchen checklist\n\n- [ ] Choose tiles\n- [ ] Book the electrician\n\nFrom [[Kitchen plan]].\n" } }],
      },
    );

  // A GitHub vault (F14) with two notes changed.
  await api("/me/github", { token: TOKEN }, "PUT");
  const ghVault = (await api("/vaults/github", { repo: "sam/house", branch: "main", folder: "docs" })).vault.id;
  const ghNotes = (await api(`/vaults/${ghVault}/notes`)) as { id: number; path: string }[];
  const ghBoiler = ghNotes.find((n) => n.path === "Boiler.md")!.id;
  await api(`/vaults/${ghVault}/notes/${ghBoiler}/content`, { content: "# Boiler\n\nServiced in May by Sam Okafor.\n\n- filter\n- pressure\n- flue checked\n" }, "PUT");
  await api(`/vaults/${ghVault}/notes/${ghNotes.find((n) => n.path === "Garden.md")!.id}/content`, { content: "# Garden\n\nPlant bulbs in October.\n" }, "PUT");

  // The same repo again, sending a weekly pull request on its own (F19), with one note held back.
  const ghAuto = (await api("/vaults/github", { repo: "sam/house", branch: "main", folder: "docs", name: "House (weekly review)" })).vault.id;
  const ghAutoNotes = (await api(`/vaults/${ghAuto}/notes`)) as { id: number; path: string }[];
  const ghAutoBoiler = ghAutoNotes.find((n) => n.path === "Boiler.md")!.id;
  await api(`/vaults/${ghAuto}/notes/${ghAutoBoiler}/content`, { content: "# Boiler\n\nServiced in May by Sam Okafor.\n\n- filter\n- pressure\n" }, "PUT");
  await api(`/vaults/${ghAuto}/notes/${ghAutoNotes.find((n) => n.path === "Garden.md")!.id}/content`, { content: "# Garden\n\nPlant bulbs, maybe.\n" }, "PUT");
  await api(`/vaults/${ghAuto}/git/auto`, { mode: "review", every: "week", day: 5, at: "17:00" }, "PUT");
  await api(`/vaults/${ghAuto}/git/hold`, { path: "Garden.md", held: true });

  // A published site (F18): Projects and Recipes, then a later edit, so Settings → Website has a
  // change to list.
  const features = { sidebar: true, contents: true, backlinks: true, tags: true, updated: true, readingTime: true, themeSwitch: true };
  await api(`/vaults/${vaultId}/site/settings`, { include: ["Projects", "Recipes"], features }, "PUT");
  const { slug } = await api(`/vaults/${vaultId}/site/publish`, {});
  await api(`/vaults/${vaultId}/notes`, { path: "Recipes/Flapjacks.md", content: "# Flapjacks\n\n- oats\n- golden syrup" });

  /** The README's picture: the kitchen plan with the file panel and a widened Graph tab on a
   *  laptop in dark, the same note on an iPhone in light, framed on the accent colour. */
  async function readmeShot() {
    await api(`/vaults/${vaultId}/notes/${kitchen.id}/content`, {
      content: (await api(`/vaults/${vaultId}/notes/${kitchen.id}`)).content.replace("and ==new lighting==.", "and ==new lighting==. Settled at the [[Kitchen kickoff]] with [[Priya Shah]] and [[Tom Reed]]."),
    }, "PUT");
    const b = await launch();
    const take = async (device: "laptop" | "phone") => {
      const p = await b.newPage();
      await p.setViewport(device === "phone" ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1440, height: 900, deviceScaleFactor: 2 });
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: device === "phone" ? "light" : "dark" }]);
      await p.setCookie({ name: "cp_session", value: cookie.split("=")[1]!, url: BASE });
      await p.goto(`${BASE}/v/${vaultId}`, { waitUntil: "load" });
      await p.evaluate(() => localStorage.setItem("cp:right-w", "440"));
      await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      if (device === "laptop") {
        // Join Priya's vault, so the file panel opens on the vault rather than the invitation.
        const join = await p.$$(".sidebar button").then(async (bs) => { for (const x of bs) if ((await x.evaluate((e) => e.textContent)) === "Join collection") return x; });
        if (join) (await join.click(), await Bun.sleep(600), await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" }), await p.waitForSelector(".cm-content"));
        if (!(await p.$(".app.left-open"))) await p.click('button[aria-label="Files"]');
        if (!(await p.$(".app.right-open"))) await p.click('button[aria-label="Side panel"]');
        await p.waitForSelector(".right-tabs [role=tab]");
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((t) => t.textContent?.includes("Graph"))?.click());
        await p.waitForSelector(".local-graph .graph-canvas");
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".local-graph button")].find((t) => t.textContent === "Show more")?.click());
        await Bun.sleep(3500);
      } else await Bun.sleep(1200);
      const png = Buffer.from(await p.screenshot({ type: "png" })).toString("base64");
      await p.close();
      return `data:image/png;base64,${png}`;
    };
    const [laptop, phone] = [await take("laptop"), await take("phone")];
    const p = await b.newPage();
    await p.setViewport({ width: 1800, height: 1000, deviceScaleFactor: 1.5 });
    await p.setContent(`<!doctype html><style>
      body { margin: 0; width: 1800px; height: 1000px; overflow: hidden; font-family: -apple-system, system-ui, sans-serif;
        background: radial-gradient(1300px 700px at 15% 0%, #8b7cf0 0%, transparent 60%), radial-gradient(900px 700px at 100% 100%, #2b8a8a 0%, transparent 55%), #1d1640; }
      .win { position: absolute; left: 60px; top: 70px; width: 1320px; border-radius: 14px; overflow: hidden; background: #15131c;
        box-shadow: 0 40px 90px rgba(0,0,0,.55), 0 0 0 1px rgba(255,255,255,.12); }
      .bar { height: 34px; display: flex; align-items: center; gap: 8px; padding: 0 14px; background: #24212e; }
      .bar i { width: 12px; height: 12px; border-radius: 50%; display: block; }
      .bar span { flex: 1; text-align: center; color: #9b97a8; font-size: 13px; margin-right: 52px; }
      .win img { display: block; width: 100%; }
      .phone { position: absolute; right: 60px; bottom: 44px; width: 340px; padding: 12px; border-radius: 56px; background: #0b0a0f;
        box-shadow: 0 40px 90px rgba(0,0,0,.6), 0 0 0 2px #3a3646; }
      .phone img { display: block; width: 100%; border-radius: 44px; }
    </style>
    <div class="win"><div class="bar"><i style="background:#ff5f57"></i><i style="background:#febc2e"></i><i style="background:#28c840"></i><span>DO Notes</span></div><img src="${laptop}"></div>
    <div class="phone"><img src="${phone}"></div>`, { waitUntil: "load" });
    mkdirSync("docs/images", { recursive: true });
    await p.screenshot({ path: "docs/images/hero.webp", type: "webp", quality: 82 });
    await b.close();
    console.log("README picture in docs/images/hero.webp");
  }

  // A fresh browser for each device and theme: headless Chrome stalls after many pages.
  const launch = () => puppeteer.launch({ executablePath: chromePath(), headless: true, args: ["--no-sandbox"] });
  let browser = await launch();
  const shot = async (p: Page, name: string) => {
    if (process.env.SHOTS_LOG) console.log("shot", name);
    await Bun.sleep(350); // let animations settle
    await p.screenshot({ path: join(OUT, `${name}.png`) });
    if (HELP && HELP_SHOTS[name]) await p.screenshot({ path: join(HELP_DIR, `${HELP_SHOTS[name]}.webp`) as `${string}.webp`, type: "webp", quality: 72 });
  };
  if (README) await readmeShot();
  // F28's writing blocks: an icon, contents, status labels, a folding callout.
  const blocks = await api(`/vaults/${vaultId}/notes`, {
    path: "Projects/Kitchen/Kitchen timeline.md",
    content: "---\nicon: 🧱\n---\n# Kitchen timeline\n\n[TOC]\n\n## Now\n\nWorktops :status[Ordered]{.blue} · Tiles :status[Choosing]{.amber} · Electrics :status[Done]{.green}\n\nFitter booked for 2026-11-09\n\n> [!info]- Why quartz\n> Harder wearing than wood, and the samples matched the floor.\n\n## Next\n\n- [ ] Book the tiler\n\n```sql\nselect item, cost from quotes -- cheapest first\nwhere room = 'kitchen' order by cost limit 3;\n```\n",
  });
  for (const device of README ? [] : (["laptop", "phone"] as const)) {
    for (const scheme of HELP ? (["light"] as const) : (["light", "dark"] as const)) {
      await browser.close();
      browser = await launch();
      const p = await browser.newPage();
      await p.setViewport(device === "phone" ? { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : { width: 1280, height: 800 });
      await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: scheme }]);
      await p.setCookie({ name: "cp_session", value: cookie.split("=")[1]!, url: BASE });
      const tag = `${device}-${scheme}`;

      await p.goto(`${BASE}/v/${vaultId}`, { waitUntil: "load" });
      await p.waitForSelector(".vault-home");
      // The guided tour: its offer, and a step pointing at the properties. Then it's been seen, so
      // the shots after (and the help's home picture) don't show the offer.
      await p.waitForSelector(".tour-offer-card");
      await shot(p, `${tag}-1b-tour-offer`);
      await p.click(".tour-offer-card .primary");
      await p.waitForFunction(() => document.querySelector<HTMLElement>(".tour")?.dataset.step === "welcome");
      for (let i = 0; i < 20 && (await p.$eval(".tour", (t) => (t as HTMLElement).dataset.step)) !== "properties"; i++) {
        const was = await p.$eval(".tour", (t) => (t as HTMLElement).dataset.step);
        await p.click(".tour-next");
        await p.waitForFunction((w) => document.querySelector<HTMLElement>(".tour")?.dataset.step !== w, {}, was);
      }
      await p.waitForFunction(() => document.querySelector<HTMLElement>(".tour-card")?.style.visibility !== "hidden" && !!document.querySelector(".tour-spot"));
      await Bun.sleep(400);
      await shot(p, `${tag}-1c-tour-step`);
      await p.keyboard.press("Escape");
      await p.waitForSelector(".tour", { hidden: true });
      await p.goto(`${BASE}/v/${vaultId}`, { waitUntil: "load" });
      await p.waitForSelector(".vault-home");
      await shot(p, `${tag}-1-home`);

      await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      await Bun.sleep(800);
      await shot(p, `${tag}-2-note`);

      await p.goto(`${BASE}/v/${vaultId}/n/${blocks.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-lp-toc");
      await Bun.sleep(500);
      await shot(p, `${tag}-2e-blocks`);
      await p.$eval(".cm-scroller", (e) => (e.scrollTop = e.scrollHeight));
      await Bun.sleep(300);
      await shot(p, `${tag}-2f-code`);
      await p.$eval(".cm-scroller", (e) => (e.scrollTop = 0));
      await p.evaluate(() => {
        const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent === "Now")!;
        line.querySelector(".cm-fold-chevron")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      });
      await p.waitForSelector(".cm-fold-placeholder");
      await shot(p, `${tag}-2g-fold`);
      // Notes reopen where they were left: start the kitchen note at the top for the shots after.
      await p.evaluate(() => localStorage.removeItem("cp:places"));
      await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      if (device === "laptop") {
        // Hover preview: rest on the first [[link]].
        const at = await p.$eval(".cm-lp-wikilink", (e) => {
          const b = e.getBoundingClientRect();
          return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
        });
        await p.mouse.move(at.x, at.y);
        await p.waitForSelector(".hover-preview .hover-preview-text");
        await Bun.sleep(200);
        await shot(p, `${tag}-2h-hover`);
        await p.mouse.move(5, 5);
        await p.waitForSelector(".hover-preview", { hidden: true });
        // The format bar over selected words.
        const words = await p.evaluate(() => {
          const line = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.startsWith("Agreed with"))!;
          const b = line.getBoundingClientRect();
          return { x: b.right - 2, y: b.top + b.height / 2 };
        });
        await p.mouse.click(words.x, words.y);
        await p.keyboard.press("ArrowLeft"); // before the full stop
        await p.keyboard.down("Shift");
        await p.keyboard.down("Alt");
        await p.keyboard.press("ArrowLeft");
        await p.keyboard.press("ArrowLeft");
        await p.keyboard.up("Alt");
        await p.keyboard.up("Shift");
        await p.waitForSelector(".cm-format-bar");
        await Bun.sleep(200);
        await shot(p, `${tag}-2i-format-bar`);
        await p.keyboard.press("ArrowRight"); // no selection, so no bar
        await p.waitForSelector(".cm-format-bar", { hidden: true });
      }

      // A table's bar and its Column menu, on the Costs table.
      await p.$eval('.cm-table-edit td[data-r="1"][data-c="1"]', (e) => e.scrollIntoView({ block: "center" }));
      await p.click('.cm-table-edit td[data-r="1"][data-c="1"]');
      await p.waitForSelector(".table-bar", { visible: true });
      await shot(p, `${tag}-2j-table-bar`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".table-bar button")].find((b) => b.getAttribute("aria-label") === "Column")!.click());
      await p.waitForSelector(".menu");
      await Bun.sleep(200);
      await shot(p, `${tag}-2k-table-menu`);
      await p.keyboard.press("Escape");
      await p.evaluate(() => localStorage.removeItem("cp:places"));
      await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      await Bun.sleep(500);

      await p.click('button[aria-label="More"]');
      await p.waitForSelector(".menu");
      await shot(p, `${tag}-3-menu`);
      await p.keyboard.press("Escape");

      // The / menu, at the end of the note.
      await p.click(".cm-content");
      await p.keyboard.down("Meta");
      await p.keyboard.press("ArrowDown");
      await p.keyboard.up("Meta");
      await p.keyboard.press("Enter");
      await p.keyboard.type("/");
      await p.waitForSelector(".cm-tooltip-autocomplete");
      await shot(p, `${tag}-3b-slash`);
      await p.keyboard.press("Escape");

      // The block handle (F12): by the hovered block on a laptop, the cursor's on a phone; its menu.
      const row = await p.evaluate(() => {
        const r = [...document.querySelectorAll(".cm-line")].find((l) => l.textContent?.includes("Choose tiles"))!.getBoundingClientRect();
        return { x: r.x + 40, y: r.y + r.height / 2 };
      });
      if (device === "phone") await p.touchscreen.tap(row.x, row.y);
      else await p.mouse.move(row.x, row.y);
      await p.waitForSelector(".cm-block-handle:not([hidden])");
      await shot(p, `${tag}-3d-handle`);
      await p.click(".cm-block-grip");
      await p.waitForSelector(".menu");
      await shot(p, `${tag}-3e-block-menu`);
      if (device === "phone") await p.click(".menu-cancel");
      else await p.keyboard.press("Escape");
      await p.keyboard.press("Backspace");
      await p.keyboard.press("Backspace");
      if (device === "laptop") {
        await p.keyboard.down("Meta");
        await p.keyboard.press("k");
        await p.keyboard.up("Meta");
        await p.waitForSelector(".palette li");
        await shot(p, `${tag}-3c-palette`);
        await p.keyboard.press("Escape");
        // Both panels hidden (F15), then back.
        await p.click('button[aria-label="Files"]');
        await p.click('button[aria-label="Side panel"]');
        await Bun.sleep(400);
        await shot(p, `${tag}-2b-focus`);
        await p.click('button[aria-label="Files"]');
        await p.click('button[aria-label="Side panel"]');
        await Bun.sleep(400);
        // Focus mode: only the text.
        await p.evaluate(() => localStorage.setItem("cp:focus", "1"));
        await p.reload({ waitUntil: "load" });
        await p.waitForSelector(".app.focus-mode .cm-content");
        await Bun.sleep(600);
        await shot(p, `${tag}-2c-focus-mode`);
        await p.evaluate(() => localStorage.setItem("cp:focus", "0"));
        await p.reload({ waitUntil: "load" });
        await p.waitForSelector(".cm-content");
        await Bun.sleep(400);
      }

      // The AI: the side panel with a change to approve, then the @name box (a sheet on a phone).
      if (device === "laptop") {
        await p.keyboard.down("Meta");
        await p.keyboard.press("j");
        await p.keyboard.up("Meta");
      } else {
        // Typing scrolled the note and the header tucked away: focus brings it back.
        await p.focus('button[aria-label="Side panel"]');
        await p.waitForSelector(".app:not(.chrome-hidden)");
        await Bun.sleep(400);
        await p.click('button[aria-label="Side panel"]');
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((b) => b.textContent?.includes("AI"))?.click());
      }
      const box = await p.waitForSelector(".ai-panel textarea");
      await p.click(".ai-panel .ai-web"); // the web on for this conversation: the globe lights up
      aiScript();
      await box!.click();
      await p.keyboard.type("What's left on the kitchen?");
      await p.keyboard.press("Enter");
      await p.waitForSelector(".ai-change");
      await shot(p, `${tag}-8-ai-panel`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".ai-change button")].find((b) => b.textContent === "Discard")!.click());
      await Bun.sleep(300);
      if (device === "phone") await p.click('button[aria-label="Close the side panel"]');
      else {
        await p.keyboard.down("Meta");
        await p.keyboard.press("j");
        await p.keyboard.up("Meta");
      }
      await p.click(".cm-content");
      await p.keyboard.down("Meta");
      await p.keyboard.press("ArrowDown");
      await p.keyboard.up("Meta");
      await p.keyboard.press("Enter");
      await p.keyboard.type("@Cl");
      await p.waitForSelector(".cm-tooltip-autocomplete");
      await shot(p, `${tag}-8b-mention`);
      await Bun.sleep(150);
      await p.keyboard.press("Enter");
      await p.waitForSelector(".ai-chat textarea");
      fake.script.push({ text: "Quartz worktops, an oak floor and new lighting, agreed with [[Contractors]]." });
      await p.keyboard.type("Summarise the decisions");
      await p.keyboard.press("Enter");
      await p.waitForFunction(() => [...document.querySelectorAll(".ai-reply")].some((e) => e.textContent?.includes("Quartz")));
      await shot(p, `${tag}-8c-inline`);
      await p.click('button[aria-label="Discard"]');

      // Types: a type page, and a typed note with its chip and properties.
      await p.goto(`${BASE}/v/${vaultId}/t/Person`, { waitUntil: "load" });
      await p.waitForSelector(".type-table, .type-cards, .type-list");
      await shot(p, `${tag}-10-type-page`);
      await p.goto(`${BASE}/v/${vaultId}/tasks`, { waitUntil: "load" });
      await p.waitForSelector(".task-list li");
      await shot(p, `${tag}-12-tasks`);
      await p.goto(`${BASE}/v/${vaultId}/journal`, { waitUntil: "load" });
      await p.waitForSelector(".journal-day");
      await shot(p, `${tag}-12c-journal`);
      // The timeline (F21): the meetings from July to September, the later ones faded.
      await p.goto(`${BASE}/v/${vaultId}/graph?type=Meeting&from=2026-07-01&to=2026-09-30`, { waitUntil: "load" });
      await p.waitForSelector(".graph-timeline");
      await Bun.sleep(3500);
      await shot(p, `${tag}-15e-graph-timeline`);
      if (device === "laptop") {
        await p.goto(`${BASE}/v/${vaultId}/graph`, { waitUntil: "load" });
        await p.waitForSelector(".graph-canvas");
        await Bun.sleep(3500);
        await shot(p, `${tag}-15-graph`);
        // The filters panel, and the graph centred on a note with its property labels.
        await p.click(".graph-bar button[aria-expanded]");
        await p.waitForSelector(".graph-filters");
        await shot(p, `${tag}-15b-graph-filters`);
        await p.goto(`${BASE}/v/${vaultId}/graph?note=${kickoff.id}`, { waitUntil: "load" });
        await p.waitForSelector(".graph-canvas");
        await Bun.sleep(3500);
        await shot(p, `${tag}-15c-graph-around`);
        await p.goto(`${BASE}/v/${vaultId}/n/${timeline.id}`, { waitUntil: "load" });
        await p.waitForFunction(() => !!document.querySelector(".mermaid-diagram")?.shadowRoot?.querySelector("svg"));
        await p.waitForSelector(".dataview-block table");
        await shot(p, `${tag}-16-diagram`);
        await p.keyboard.down("Meta");
        await p.keyboard.down("Shift");
        await p.keyboard.press("f");
        await p.keyboard.up("Shift");
        await p.keyboard.up("Meta");
        const q = await p.waitForSelector(".search-panel input");
        await q!.type("worktops");
        await p.waitForSelector(".search-results li");
        await Bun.sleep(400);
        await shot(p, `${tag}-17-search`);
        await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" });
        await p.waitForSelector(".cm-content");
        await p.click('button[aria-label="More"]');
        await p.waitForSelector(".menu");
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Version history"))!.click());
        await p.waitForSelector(".history");
        await Bun.sleep(400);
        await shot(p, `${tag}-18-history`);
        await p.keyboard.press("Escape");
      }
      if (device === "laptop") {
        await p.goto(`${BASE}/v/${vaultId}/n/${contractors.id}`, { waitUntil: "load" });
        await p.waitForSelector(".cm-content");
        if (!(await p.$(".app.right-open"))) await p.click('button[aria-label="Side panel"]');
        await p.waitForSelector(".right-tabs [role=tab]");
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((b) => b.textContent?.includes("Links"))?.click());
        await p.waitForSelector(".mention-list li");
        await shot(p, `${tag}-12b-mentions`);
      }
      // GitHub vault: the branch bar on a note, the changes page with a diff, the PR form.
      await p.goto(`${BASE}/v/${ghVault}/n/${ghBoiler}`, { waitUntil: "load" });
      await p.waitForSelector(".branch-count");
      await Bun.sleep(400);
      await shot(p, `${tag}-13-branch-bar`);
      if (device === "phone") {
        // On the iPhone the bar is in the Files drawer, with a dot on the Files button.
        await p.click(".note-header .panel-toggle");
        await p.waitForSelector(".sidebar .branch-count");
        await Bun.sleep(400);
        await shot(p, `${tag}-13a-branch-drawer`);
        // Searching folds away what's above the box.
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar .tabs button")].find((b) => b.textContent === "Search")!.click());
        await p.waitForSelector(".search-panel input");
        await p.focus(".search-panel input");
        await p.keyboard.type("flue");
        await Bun.sleep(800);
        await shot(p, `${tag}-13g-search-drawer`);
        await p.$eval(".search-panel input", (e) => {
          const i = e as HTMLInputElement;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(i, "");
          i.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".sidebar .tabs button")].find((b) => b.textContent === "Files")!.click());
        await p.evaluate(() => document.querySelector<HTMLElement>(".scrim")?.click());
      }
      await p.goto(`${BASE}/v/${ghVault}/changes`, { waitUntil: "load" });
      await p.waitForSelector(".change-edited");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".change-edited button")].find((b) => b.textContent === "Diff")?.click());
      await p.waitForSelector(".change .diff");
      await shot(p, `${tag}-13b-changes`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".changes-page button.primary")].pop()?.click());
      await p.waitForSelector(".pr-form");
      await shot(p, `${tag}-13c-pull-request`);
      await p.keyboard.press("Escape");
      // Sending on its own (F19): the bar's line, a held change, and the choice in Settings.
      await p.goto(`${BASE}/v/${ghAuto}/n/${ghAutoBoiler}`, { waitUntil: "load" });
      await p.waitForSelector(".branch-auto");
      await Bun.sleep(400);
      await shot(p, `${tag}-13d-auto-bar`);
      if (device === "phone") {
        await p.click(".note-header .panel-toggle");
        await p.waitForSelector(".sidebar .branch-auto");
        await Bun.sleep(400);
        await shot(p, `${tag}-13h-auto-drawer`);
        await p.evaluate(() => document.querySelector<HTMLElement>(".scrim")?.click());
        await Bun.sleep(300);
      }
      await p.goto(`${BASE}/v/${ghAuto}/changes`, { waitUntil: "load" });
      await p.waitForSelector(".change-held");
      await shot(p, `${tag}-13e-held`);
      if (device === "phone") {
        await p.click(".panel-toggle");
        await Bun.sleep(400);
      }
      await p.click('.branch-bar button[aria-label="Branch"]');
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("How changes are sent"))!.click());
      await p.waitForSelector(".send-modes");
      await p.evaluate(() => document.querySelector(".send-modes")!.closest(".settings-section")!.scrollIntoView());
      await Bun.sleep(300);
      await shot(p, `${tag}-13f-sending`);
      await p.keyboard.press("Escape");

      await p.goto(`${BASE}/v/${vaultId}/n/${overview.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-lp-embed .note-embed-body li");
      await p.waitForSelector(".link-card-box");
      await shot(p, `${tag}-11-embed-card`);
      await p.goto(`${BASE}/v/${vaultId}/n/${personType.id}`, { waitUntil: "load" });
      await p.waitForSelector(".type-editor .type-prop");
      await shot(p, `${tag}-10c-type-editor`);
      if (device === "laptop") {
        await p.click('button[aria-label="New type"]');
        await p.waitForSelector(".starters");
        await shot(p, `${tag}-10d-new-type`);
        await p.keyboard.press("Escape");
      }
      // The side panel's Graph tab: the meeting with its attendees, labelled.
      await p.goto(`${BASE}/v/${vaultId}/n/${kickoff.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      if (!(await p.$(".app.right-open"))) await p.click('button[aria-label="Side panel"]');
      await p.waitForSelector(".right-tabs [role=tab]");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((b) => b.textContent?.includes("Graph"))?.click());
      await p.waitForSelector(".local-graph .graph-canvas");
      await Bun.sleep(3000);
      await shot(p, `${tag}-15d-graph-tab`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".right-tabs [role=tab]")].find((b) => b.textContent?.includes("Links"))?.click());
      if (device === "phone") await p.evaluate(() => document.querySelector<HTMLButtonElement>('button[aria-label="Close the side panel"]')?.click());
      await p.goto(`${BASE}/v/${vaultId}/n/${kickoff.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      await Bun.sleep(800);
      await shot(p, `${tag}-10b-typed-note`);
      await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      await Bun.sleep(500);

      if (device === "phone") {
        await p.click('button[aria-label="Files"]');
        await Bun.sleep(400);
      }
      await p.waitForSelector(".tree-row.folder");
      await shot(p, `${tag}-4-files`);
      await p.evaluate(() => document.querySelector<HTMLButtonElement>('.sidebar-actions button[aria-label="New folder"]')?.click());
      await p.waitForSelector("[data-dialog-input]");
      await shot(p, `${tag}-5-dialog`);
      await p.keyboard.press("Escape");

      await p.evaluate(() => document.querySelector<HTMLButtonElement>('.sidebar-actions button[title^="New note"]')?.click());
      await p.waitForSelector(".cm-content");
      await Bun.sleep(600);
      if (device === "phone") await p.evaluate(() => document.querySelector<HTMLElement>(".scrim")?.click());
      await p.click('button[aria-label="More"]');
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".menu-item")].find((b) => b.textContent?.includes("Move to Trash"))?.click());
      await p.waitForSelector(".toast");
      await shot(p, `${tag}-6-toast`);

      if (device === "phone") {
        await p.click('button[aria-label="Files"]');
        await Bun.sleep(400);
      }
      await p.click("button.account");
      await p.waitForSelector(".settings-nav");
      // Settings → Account → Reminders (F35).
      if (device === "phone") await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Account"))?.click());
      await p.waitForSelector("#reminder-time");
      await p.evaluate(() => document.querySelector("#reminder-time")!.closest("section")!.scrollIntoView({ block: "center" }));
      await shot(p, `${tag}-7a-reminders`);
      // Two-step sign-in (F40): setting up the code app.
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".two-step button")].find((b) => b.textContent?.includes("Turn on two-step"))!.click());
      await p.waitForSelector(".two-step-setup img");
      await p.evaluate(() => document.querySelector(".two-step")!.scrollIntoView({ block: "center" }));
      await shot(p, `${tag}-7a2-two-step`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".two-step-setup button")].find((b) => b.textContent === "Cancel")!.click());
      if (device === "phone") await p.click(".settings-back");
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Connections"))!.click());
      await p.waitForFunction(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].some((b) => b.textContent === "Create token"));
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".modal button")].find((b) => b.textContent === "Create token")!.click());
      await p.waitForSelector(".capture-setup");
      await p.evaluate(() => document.querySelector(".capture-setup")!.scrollIntoView());
      await shot(p, `${tag}-7-share-setup`);
      // Settings (F17): the iPhone's list of sections, the laptop's vault section.
      if (device === "phone") await p.click(".settings-back");
      else await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("This collection"))!.click());
      await Bun.sleep(300);
      await shot(p, `${tag}-7b-settings`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find((b) => b.textContent?.startsWith("Website"))!.click());
      await p.waitForSelector(".site-live");
      await shot(p, `${tag}-7c-website`);
      // The builder: its features and the preview.
      await p.evaluate(() => document.querySelector(".site-features")!.scrollIntoView());
      await p.waitForFunction(() => !!document.querySelector<HTMLIFrameElement>("iframe.site-preview")?.contentDocument?.querySelector("h1"));
      await Bun.sleep(300);
      await shot(p, `${tag}-7d-website-builder`);
      await p.keyboard.press("Escape");
      await p.evaluate(() => document.querySelector<HTMLElement>(".modal-backdrop")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
      await p.keyboard.down("Meta");
      await p.keyboard.press("k");
      await p.keyboard.up("Meta");
      if (device === "laptop") {
        await p.waitForSelector(".palette input");
        await p.keyboard.type("add an ai");
        await p.keyboard.press("Enter");
        await p.waitForSelector(".assistant-form");
        await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".assistant-form [role=radio]")].find((b) => b.textContent === "relaxAI")!.click());
        await shot(p, `${tag}-9-boyai`);
      }
      // Help: its start, and a page with pictures (on a phone, the topics first).
      await p.goto(`${BASE}/v/${vaultId}/n/${kitchen.id}`, { waitUntil: "load" });
      await p.waitForSelector(".cm-content");
      if (device === "phone") {
        await p.click('button[aria-label="Files"]');
        await Bun.sleep(400);
      }
      await p.click('.sidebar-foot [aria-label="Help"]');
      await p.waitForSelector(".help-nav button");
      await Bun.sleep(500);
      await shot(p, `${tag}-19-help`);
      await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".help-nav button")].find((b) => b.textContent === "Links and embeds")!.click());
      await p.waitForFunction(() => document.querySelector<HTMLImageElement>(".help-page img")?.complete); // the first; the rest load lazily
      await Bun.sleep(300);
      await shot(p, `${tag}-19b-help-page`);
      await p.keyboard.press("Escape");
      // The published site, as a reader sees it.
      await p.goto(`${BASE}/p/${slug}/Projects/Kitchen/Kitchen%20plan`, { waitUntil: "load" });
      await shot(p, `${tag}-14-site-page`);
      await p.goto(`${BASE}/p/${slug}/`, { waitUntil: "load" });
      await shot(p, `${tag}-14b-site-home`);
      await p.close();
    }
  }
  // The standalone file with the allotment demo folder open, for the help's page about it.
  if (HELP && !README) {
    const build = Bun.spawnSync(["bun", "standalone/build.ts"]);
    if (build.exitCode !== 0) throw new Error(build.stderr.toString());
    const html = Bun.file("standalone/dist/commonplace.html");
    const file = Bun.serve({ port: PORT + 1, fetch: () => new Response(html, { headers: { "Content-Type": "text/html" } }) });
    const files = Object.fromEntries(Object.entries(demoFiles("allotment")).map(([k, v]) => [k, new TextDecoder().decode(v)]));
    const p = await browser.newPage();
    await p.setViewport({ width: 1280, height: 800 });
    await p.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
    await p.goto(`http://localhost:${PORT + 1}/`);
    await p.waitForSelector(".login-card");
    await p.screenshot({ path: join(HELP_DIR, "standalone-welcome.webp") as `${string}.webp`, type: "webp", quality: 72 });
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
    }, files);
    await p.evaluate(() => [...document.querySelectorAll<HTMLButtonElement>(".login-card button")].find((b) => b.textContent?.includes("Open a folder"))!.click());
    await p.waitForSelector(".sidebar .tree-row.note");
    await p.keyboard.down("Meta");
    await p.keyboard.press("o");
    await p.keyboard.up("Meta");
    await p.waitForSelector(".switcher input");
    await p.keyboard.type("Plot plan");
    await Bun.sleep(200);
    await p.keyboard.press("Enter");
    await p.waitForFunction(() => !!document.querySelector(".mermaid-diagram")?.shadowRoot?.querySelector("svg"));
    await Bun.sleep(600);
    await p.screenshot({ path: join(HELP_DIR, "standalone.webp") as `${string}.webp`, type: "webp", quality: 72 });
    file.stop(true);
  }
  await browser.close();
  if (!README) console.log(`Screenshots in ${OUT}/`);
} finally {
  fake.stop();
  fakeGh.stop();
  server.kill();
}
