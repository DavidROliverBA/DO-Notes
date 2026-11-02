# Backlog

What to work on next in Commonplace. Each item says why it matters, what "done" looks like, and
where the evidence is (a file and line, a commit, or something observed). Decisions already made
are recorded at the bottom, so they don't get re-argued.

Every item is judged against [PRINCIPLES.md](PRINCIPLES.md) (easy to use, one design language,
style and grace); its "done when" includes that checklist.

Sizes are rough: **S** an evening, **M** a few days, **L** a week or more.

Add new ideas under **Ideas** in a line or two; promote them to **Next** once it's clear what
done looks like. Finished items go to [CHANGELOG.md](CHANGELOG.md), and a finished item's
design moves to [design/](design/) (F12, F14, F16, F17, F19, F21, F22, F23, F24, F25, F26, F28 so far).

**Contents**

- [Now: risks and rough edges](#now-risks-and-rough-edges)
- [Next: in this order](#next-in-this-order)
- [Later](#later)
- [Ideas](#ideas)
- [Decided against](#decided-against)

---

## Now: risks and rough edges

Things that could lose data, stop the service, or that are visibly wrong today. These come
before features.

Nothing open: N12, the last item, was finished on 2026-11-01 (see the CHANGELOG).

---

## Next: in this order

**Decided 2026-11-01, after N12 and the [gap analysis](GAP-ANALYSIS.md).** Everything before this
is done (the earlier lists, F9 to F34, are in the CHANGELOG). The order follows what's felt every
week in a personal and household library shared by a few people: **get it into hands**, then
**be nudged**, then **capture from anywhere**, then **share and talk**, and only then the larger
builds. Each step is kept to its first useful slice, and the ones marked *design first* get a
`docs/design/<id>.md` and David's decisions before code.

**Phase 1 — Reach: the apps in hands**
1. **TestFlight (S, L8)** — the iPhone and Mac apps install from an invitation and update
   themselves, so the family can have them too. David creates the App Store Connect record (a unique
   name: **DO Notes**) after the trademark search (item 13).
2. ~~**F35 Reminders for dated tasks**~~ — done 2026-11-01 (see `docs/design/F35.md`): the biggest everyday gap: a task with a
   date tells you on the day, on the iPhone and the Mac. Builds the notification channel that F39
   reuses.
3. ~~**F36 Quick capture**~~ — done 2026-11-01: a home-screen and lock-screen widget on the iPhone, and on the Mac
   a hotkey window from anywhere and a menu-bar item (L8 step 3), all saving to the Inbox like
   sharing does.

**Phase 2 — Capture from anywhere**
4. ~~**F37 Web clipper**~~ — done 2026-11-01 (`clipper/`; Safari's needs the Xcode sign-in to build): a Safari extension (inside the Mac app) and a Chrome extension: save
   the page, a selection or a picture, with its source, to the Inbox or a Weblink note.
5. ~~**F33 step 2**~~ — any service with a token or none, done 2026-11-01; then the ~~**Floe preset**~~ (done) and
   ~~**F33 step 4**~~, "From your connections" in the side panel (done 2026-11-01). Steps 3 (any OAuth service) and
   5 (admin policy) wait for a service that needs them.
6. ~~**Text inside photos and PDFs, and voice notes**~~ — done 2026-11-01: one extraction pipeline:
   OCR and PDF text become searchable, and a recorded voice note is kept and transcribed.

**Phase 3 — Share and talk**
7. ~~**F38 Share one note by link**~~ — done 2026-11-01: a read-only, revocable link to one note (a snapshot, as
   publishing is), without publishing a site.
8. ~~**F39 Notifications and activity**~~ — done 2026-11-01 (`docs/design/F39.md`): an invitation, a mention, a
   change to a note you follow; a "since you last looked" feed in a shared collection; `@people`.
9. ~~**L3 Comments on notes**~~ — done 2026-11-01 (`docs/design/L3.md`): after F39, which tells people about them.

**Phase 4 — Trust and the rest**
10. ~~**F40 Two-step sign-in**~~ — done 2026-11-02: a code app (TOTP) with recovery codes after the
    password, and an account that signs in with passkeys only.
11. ~~**F30 step 4**~~ — Send to Longview, done 2026-11-02.
12. ~~**Siri: Open a note and Ask DO Notes**~~ — done 2026-11-02 (both open the app: `/find` and `/ask`).
13. ~~**Settle the name before version 1**~~ — decided 2026-11-02: **DO Notes** (David Oliver's
    initials; "Skein" was hard to say), shown everywhere people look; a work edition would get
    its own name. Code names stay `commonplace`, and the ball-of-thread icon stays. Still to do:
    a UK IPO and USPTO search (classes 9 and 42) before the App Store Connect record. A first web
    check found no app or trademark called "DO Notes" (nearest: ToDoNote, a Korean to-do app;
    DocNotes, a 2021 US filing).

**Phase 5 — Place notes by relationships**
14. **F42 Map and explorer (L, design first: `docs/design/F42.md`)** — retire folders: an
    explorer built from relationships, a stable map of areas, folders converted to hub notes,
    exports rebuilt from `part-of`; the map **replaces boards** (F11), which convert into boxes
    and still export as `.canvas`. Decided 2026-11-02 after the clickable mockup
    (`docs/design/F42-mockup.html`); waiting for David's go.

**Waiting until there's a reason:** the rest of F20 (once real collections show what repeats);
F18 steps 3–4 (themes and extras for published sites); imports from Notion, Apple Notes and
Confluence; email in; drawing and handwriting; L4, L6 and L7 (more than one server); Android and
Windows apps.

### F20 — Vault types and setup: who it's for, where it's kept, what's switched on

**The slim part is done** (v0.0.54): Setup at the top of Settings → This collection (where it's
kept, people, home, starter types), the five sets below as **starter-type sets** (15 new starter
types), a home collection per person (Share from iPhone's "Home collection" token follows it), and
the collection menu grouped by where each is kept. **Still to do**, when a few collections show
what repeats: the presets themselves (`kind`, `setup` jsonb), Features switches, Change type, Save
as a new type, Close the programme, the assistant knowing the type, and the People rules.

**Size** M · **Evidence** a vault today is a name, members and an optional GitHub repo
(`db/schema.sql` `vaults`); every vault starts the same and every feature shows everywhere.
Decided 2026-10-25.

A vault's **setup** is four choices, all in one place, Settings → This vault → **Setup**:

1. **People:** just me, or invited people (owner, editor, viewer as now).
2. **Where it's kept:** cloud (the server's database), cloud + GitHub, or a Mac vault (F22).
3. **Features:** journal (F24), website, AI assistant, search by meaning, and the timeline's date
   rules (F21).
4. **Starter types:** type notes added for the vault's kind, ordinary notes that can be removed.

A **vault type** is a named preset of those four. A preset, not a mode: choosing one fills in the
setup, and every choice stays changeable. Built in:

| | Personal | Household | Programme | Department | Reference |
|---|---|---|---|---|---|
| **For** | You alone | A few people sharing a home's notes | Work with a start and an end | A team's long-running knowledge | Material to read and publish |
| **Starter types** | Person, Book, Idea | Person, Home, Appointment, Document | Project, Meeting, Decision, Risk, Action, Stakeholder, Milestone | Team, Person, Process, Policy, Service, Meeting | Article, Topic, Source |
| **People** | Just me | Invited | Invited | Invited, many viewers | Invited, many viewers |
| **Journal** | On | Off | Off | Off | Off |
| **Website** | Off | Off | Off | Off | On |
| **Timeline dates** | Daily notes | Appointments, documents | Milestones, meetings, decisions, within start and end dates | Meetings | When made |

- **Change type** at any time: the new preset applies to the choices you haven't changed
  yourself; missing starter types are added; nothing is removed.
- **Save as a new type** keeps a setup as your own type (for example "Client engagement"),
  private to you. Shown with the built-in ones when making a vault.
- **Programme: Close the programme.** Everyone keeps read access; it drops to the bottom of the
  switcher. Reopen puts it back.
- **The switcher groups vaults** by where they're kept and their type, each with its icon.
- **A home vault:** one vault marked home, where Share from iPhone, quick journal entries and
  "copy to my notes" go unless you choose otherwise.
- **The assistant knows the vault's type**, so it can offer what fits (a RAID summary in a
  Programme, "reflect on this week" in Personal). Same tools as now.
- **Stored on the vault** (additive columns: `kind`, `setup` jsonb), never in a note, so notes stay
  plain Markdown; the export's `vault` record carries it, and import restores it.
- People: going from invited to just me means removing the others, with a warning; a Personal
  vault asks "this is a personal vault, invite anyway?" rather than refusing.

**Done when** a vault can be made from each built-in type and from a saved one, its type changed
and customised in Setup, the switcher groups vaults, the home vault receives shares, and it works
on the laptop and the iPhone in both themes. Help: a new page, `vaults.md`.

### F18 — Publish a vault to the web: a site builder with themes and features to switch on

**Size** L, in four steps that each ship on their own · **Evidence** nothing is public today;
it takes over the old L2 (share one note by link): publishing one note is a site of one. Hosted publishing services are the model to
beat: a whole vault as a site, each note its own page, with links, graph and search.

Turn a whole vault (or chosen folders) into a **website**: each note is its own page at a
readable address (`/p/<site>/<note-path>`), `[[wikilinks]]` become links between pages, and
pictures come along. It's built with a **builder**: pick a theme, then switch each feature on or
off and customise it, with a live preview beside the controls, before anything goes public.

**What's chosen in the builder:**
- **What's published:** the whole vault, or folders, with a `publish: false` property to keep any
  note out. Links to notes that aren't published show as plain text, never as a dead link or a
  leak of the title. A "what will be public" list to check before the first publish.
- **Theme:** a few to start (for example a clean reading theme, a notebook, a wiki or docs
  layout, a minimal blog), each a set of design tokens, so they stay in the design language.
  Customise: accent colour, fonts from the type scale, site title, logo, home page note.
- **Features, each on or off:** navigation sidebar (folder tree), table of contents, backlinks,
  hover previews, tags pages, search, graph, light and dark switch, "last updated" dates, an RSS
  feed for a folder, reading time. Some have options of their own (graph: local or whole site).
- **Who can see it:** public, or unlisted (not indexed by search engines; the default), with a
  site password as a later option.

**How it's served (decided 2026-10-12):** by this server, from a **snapshot taken when you
press Publish**: the chosen notes and pictures are rendered and stored as they were, so edits
stay private until you publish again. The builder shows "N notes changed since you published"
and what a republish would add, change or take down.
Members' emails, other people's private vaults, comments, history and properties marked
private are never in a page. The builder sits under Settings → This vault (F17).

**Site settings are a file in the vault (decided 2026-10-12):** `publish.json` at the vault's
top level holds the theme, features, options and what's included. The builder edits it; it
goes out with an export, comes back with an import, and in a GitHub vault (F14) it's committed
like any other file. The snapshot records which version of it was published.

**Steps** (step 1 done 2026-10-13, v0.0.32: `src/publish.ts`, Settings → Website; see the
CHANGELOG):
1. ~~Publish a vault with one theme: choose folders, exclude notes, unlisted link, unpublish.~~
   Still to do from step 1's list: properties marked private (pages show no properties yet), and
   a "publish this note" toggle in the note's ⋯ menu.
2. ~~The builder: feature toggles with the live preview.~~ Done 2026-10-18, v0.0.43: page list,
   contents, backlinks, tag pages, last updated, reading time, light and dark switch. Hover
   previews need script, which pages don't run, so they're left out; search, graph and RSS are
   step 4.
3. Themes and customisation (colours, fonts, logo, home page).
4. Extras: search, graph, RSS, and a **custom domain as an option (decided 2026-10-12)**: you
   enter a domain such as `notes.example.com`, the builder shows the DNS record to add, the
   domain is added to the Render service (by its API, or a step the admin does), and requests
   for that host are served the site. Without one, the site lives at `/p/<site>/`.

**Open question:** whether a custom domain can be added through Render's API with the
service's key, or must stay a manual admin step (Render issues the certificate either way).

**Done when** each step works on the laptop and the iPhone in both themes, the published pages
pass the accessibility checks in [PRINCIPLES.md](PRINCIPLES.md), and a test proves an excluded
note, its title and its attachments can't be reached by any URL.

### F33 — Connections: connect any service that meets the bar, with guidance

**Size** L, in six steps · **Evidence** asked for 2026-11-01, after F30 connected Longview and
Recall by hand · **Design** [design/F33.md](design/F33.md) (agreed 2026-11-01) · **Step 1 built 2026-11-01** (the core, Longview and Recall as presets, Review; see the CHANGELOG)

One connections manager for any MCP service that meets a stated bar (Streamable HTTP, a public
`https` address or the same Mac on the kit, OAuth with PKCE, a token, or no sign-in past a
warning), connected through a guided dialog: the address, what was found, signing in, choosing
its tools, a test. **Read-only** (decided 2026-11-01): tools that change things are never
offered. Read tools follow the web's send-out rule, for the assistant and in a **From your
connections** side-panel section (which sends only the note's title and type, once turned on).
A change to a service's tools holds it until reviewed. Longview and Recall become presets.
Everyone may add connections. Never offered over Commonplace's MCP server. Six steps.

### F30 — Longview as a connection: its knowledge base in the assistant, read-only

**Size** M for steps 1–2; steps 3–4 after F9 · **Evidence** asked for 2026-10-31; the overlap
measured that day (Longview's ideas inbox, I9: of ~20 news stories in 68 AI-tagged Recall cards,
9 were already in Longview, four by the same URL); Longview's read-scoped tokens
(`MCP_READ_TOKENS`, Longview backlog N11); the existing connection pattern (`src/web.ts`,
`user_search`, `src/secrets.ts`, `src/egress.ts`)

Longview is a memory of the AI world: events, entities, trends, all cited. Commonplace is where
personal notes about that world live. Today the only join is an AI client connected to both MCP
servers at once (L6 option A). Wanted: Longview as a connection in Commonplace, so the in-app
assistant can answer from it and a note can show what Longview knows about the things it mentions.

**Read-only by design.** The token is one of Longview's read tokens, so the tools that change
Longview (`save_url`, the source editors, candidate writes) aren't even offered to it. Nothing
in Commonplace can change Longview until step 4, which is a separate opt-in.

1. ~~**The connection (S)**~~ and 2. ~~**Longview tools for the in-app assistant (M)**~~ —
   built 2026-11-01 with Recall alongside (see the CHANGELOG and ARCHITECTURE: `src/outside.ts`):
   Settings → Connections → Longview (address and read token, write tokens refused) and Recall
   (OAuth, `kb:read`), and `longview_*` / `recall_*` tools for the in-app assistant only.
3. ~~**"In Longview" in the side panel**~~ — done 2026-11-01 as F33 step 4 (any connection, Longview included). **Was:** for the open note, the Longview events
   about the entities it names. `[[longview-ai/<id>]]` references (AI-XF namespaces, F9) open
   the event on Longview's search page.
4. ~~**Send to Longview (S, opt-in)**~~ — done 2026-11-02 (`src/sendLongview.ts`). **Was:** on a Weblink note, send its URL to Longview's `save_url`.
   Only the public URL goes, never the note. Needs a write token, kept as a second, separate
   credential, so a read-only connection stays read-only.

**Not now:** a general "connect any MCP server" connection. Recall came second (2026-11-01) and
fits the same small client, but each server's tools are still chosen and reviewed by hand
(`src/outside.ts`): an arbitrary server means trusting tools nobody has reviewed.

**Done when** a person connects Longview with a read token, the assistant answers "what does
Longview have on Gemini 4 Carbon?" with cited events, a write tool isn't available on that
connection, the token never reaches the browser or a log, and disconnecting removes it.

---

## Later

### L4 — More than one server instance

**Size** L · **Evidence** rooms and event streams live in server memory (`src/collab.ts`,
`src/events.ts`); `render.yaml` pins one instance

Only needed if one instance stops being enough. It needs a shared channel (Postgres
`LISTEN/NOTIFY` or Redis) for Yjs updates and events, plus sticky sessions or per-note routing.

### L6 — Federating several Commonplace instances: investigate and decide

**Size** S to decide; the work that follows is mostly F9 (the MCP server, once L1, shipped in v0.0.5) · **Evidence** AI-XF v0.5 §9
(namespaces, `namespace/id` references, `federation.ai-xf.yaml`, §9.8 serving a federation over
MCP); Longview's federate mode (`longview/docs/AI-XF.md`, pinned bundles, trust not inherited);
one instance already holds many vaults with per-vault roles (`src/vaults.ts`)

**Why more than one instance at all.** Within one household or team, separate vaults in one
instance already give separate spaces and permissions. Separate instances only make sense across
an ownership or trust boundary: a personal instance and a work one that must stay on work
infrastructure, or two families sharing selected notes. Federation should respect that
boundary, not erase it.

| Option | What it gives | Cost and risk | Provisional verdict |
|---|---|---|---|
| **A. Agent-level, over MCP** — each instance runs its own MCP server (`/mcp`, built); an AI client connects to several | Claude can search, read and answer across instances in one conversation | Small: the MCP server exists, so this needs only the spike below. No server-to-server trust: each instance keeps its own auth and data never moves | **Do it first.** It's the cheapest way to get the main benefit, and the safest for work data |
| **B. App-level, over AI-XF** — an instance subscribes to another's published bundle (read-only, refreshed on a schedule, under its namespace) | Cross-instance search, `[[ns/id]]` links and backlinks in the Commonplace UI | Medium: F9 steps 3–4 plus a subscription, refresh, and display of foreign notes as read-only. Copies the other side's data, so only for what its owner chose to publish | **Do after F9**, if A proves the need |
| **C. Server-to-server over MCP** — one instance calls another's MCP tools | Live cross-instance queries from the app | MCP is designed for AI clients calling tools, not app-to-app data access; it adds a protocol hop with no gain over B's HTTPS + bearer token | **No.** Use AI-XF over HTTPS for app-to-app |
| **D. Live multi-master sync** — vaults replicated between instances, edits merged | One vault editable in two places | Large: cross-server identity, auth, Yjs sync across servers, conflict and deletion semantics. Little gain over sharing a vault in one instance | **No** |

**Questions the investigation must answer:**
- Is there a real second instance? If every use is one household, this stays shelved, and
  multiple vaults are the answer.
- For A: does one MCP server per instance (with per-user bearer tokens) work well enough in
  Claude Code and claude.ai with two or three connected at once? Measure on a real question that
  spans both.
- For B: what does a publisher choose to share (a vault, a folder, a tag), and how is that kept
  from leaking private notes? AI-XF §7.5 withheld markers apply.
- Trust: a federated note must show where it came from and must not inherit the other side's
  verification (AI-XF §7.3a, §9.4).

**Done when** the conclusion (adopt A, A then B, or shelve) is written here with the evidence
from a spike: two local instances, one MCP server each, and one question answered across both.

### L7 — Scaling and high availability: what Render offers, and Render vs Supabase

**Size** S to decide · **Evidence** render.com/pricing and Render's Postgres docs; supabase.com/pricing
and its compute, disk and Multigres docs (all 2026-10-11)

**Where Commonplace is today:** web service Starter ($7), Postgres `0.1c-256mb` ($6) with 1 GB
($0.30), Hobby workspace ($0): **about $13 a month**, with 3 days of point-in-time recovery and
the daily GitHub backup (N3).

**The real limit is the app, not the database.** Commonplace runs as one server because live
editing keeps open notes in memory (L4). High availability on the database alone doesn't make
the app highly available; if the one web server is down, so is Commonplace. Do L4 first if
uptime ever matters, and database HA alongside it.

| | Render Postgres | Supabase |
|---|---|---|
| Entry price | $6/mo (0.1 CPU, 256 MB), Hobby workspace free | Pro $25/mo incl. $10 compute (Micro, 1 GB RAM) and 8 GB disk; Free tier pauses after a week idle |
| Next sizes | 0.5c-1g $19 · 1c-2g $40 · 1c-4g $55 · 2c-8g $100 | Small $15 · Medium $60 · Large $110 (on top of the $25) |
| Storage | $0.30/GB, grows in 5 GB steps or automatically, never shrinks | $0.125/GB after 8 GB, grows, never shrinks |
| Point-in-time recovery | Included: 3 days (Hobby), 7 days (Pro workspace, $25/mo) | Add-on: $100/mo per 7 days; daily backups 7 days on Pro |
| High availability | Yes, on any workspace: a standby in another zone, automatic failover after 30 s; needs ≥1 CPU; billed as a second copy | Not on Pro or Team; Multigres (3-node HA) is in alpha, not for production |
| Read replicas | Up to 5; needs ≥10 GB and ≥0.5 CPU; billed as a copy | Yes, billed as extra compute |
| Runs the Bun server? | Yes, same platform, private network | No; the web server stays on Render, the database goes over the internet |
| Extras | — | Auth, storage, realtime, generated APIs (Commonplace already does all of these itself) |

**Decided (2026-10-11): stay on Render** (see Decided against): at ~$13 a month it's cheaper
than Supabase on the database alone, includes 3-day point-in-time recovery, and offers HA that
Supabase doesn't yet. Render with database HA would be ~$90 a month (1c-2g twice, with L4).
Revisit if the data passes ~20 GB or Supabase's Multigres becomes generally available.

**Still open:** a named trigger (users, data size, an outage) for moving the database to
`1c-2g` with HA, done together with L4. Until then, stay as is.

### L8 — Commonplace as an iPhone app and a desktop app

**Size** L · **Evidence** PRINCIPLES.md §10; the capture Shortcut (2026-10-11) is the first
non-browser client; Safari can't receive shares (WebKit bug 194593)

Wrap the same web client rather than rewrite it: a **native Swift** shell for iOS (`ios/`;
Capacitor decided against, below) and **Tauri** for macOS and Windows.

1. ~~**iOS app (M)**~~ — built 2026-10-31 (see the CHANGELOG and ARCHITECTURE §7.12): the web
   client in a `WKWebView`, the share extension (links, text, photos), the icon, deep links
   and universal links. On David's iPhone (paid team, 2026-11-01), `APPLE_APP_IDS` set on
   Render, passkeys working in it. **Still to do:** TestFlight, and files other than photos in
   the share sheet.
2. ~~**Offline in the app (S)**~~ — checked on David's iPhone 2026-11-01 (N12): open, edit
   and merge offline all work. **Was:** the server's domain is app-bound, so the service worker runs;
   check offline open, edit and merge on the real iPhone (N12's 3b).
3. **Desktop app (M):** the Mac app is built (2026-11-01), as a native Swift app instead of
   Tauri (`ios/Mac/`, sharing the iPhone app's code; see the CHANGELOG): windows and tabs,
   menus, Settings for the server (cloud, kit or another), open at login, a share extension.
   **Still to do:** dragging files onto the Dock icon, a signed and notarised build to give to others, and
   Windows (Tauri, if ever).
4. **Device tokens (S):** the app makes and drops its own capture token ("iPhone app") at sign-in
   and sign-out; still to do, a full-scope device token if the app ever needs to work without
   the web's cookie.
5. **Siri and Shortcuts (S each):** ~~**Save to Commonplace**~~ built 2026-11-01 (an App
   Intent in `ios/Intents/`, on the iPhone and the Mac: what you say goes to the Inbox). ~~**Open a
   note**~~ and ~~**Ask DO Notes**~~ built 2026-11-02: both open the app (commonplace://find and
   commonplace://ask), so they need no token beyond the app's sign-in. **Not done, on purpose:**
   an answer Siri reads out without opening the app, which would need a token that can read
   notes and run the assistant from outside the app.

**Done when** the iPhone app is on TestFlight with a share extension that saves into the
inbox, the desktop app runs on macOS, both sign in with revocable device tokens, and neither
needed a feature the web app doesn't have.

---

## Ideas

One line each. Promote to **Next** with a "done when".

- **Boards, next (F11):** drag a note from the file panel onto a board; a board tool for agents
  (add cards and arrows, not raw JSON); boards in the standalone file; boards on published sites.

- **Hover preview on the iPhone (S):** a long press or a Preview button in the link's Open ↗
  bubble (release 2 did laptops).
- **Editor usability, later (each needs a design first):** image alignment and captions (no
  standard Markdown); @people (`@` calls assistants today); a side-by-side diff in Version
  history; upload progress for dropped files; inline comments are L3.
- **Import from Confluence (M, after F28):** a space or a page and its children, through
  Confluence's REST API with an API token in a header; parent pages become `part-of`
  relationships (F27), page properties become properties, @people become Person notes, macros map
  to F28's blocks, comments go in a section at the end. AI-XF's E11 experiment
  (`ai-xf-format/experiments/e11-migration`) has a mapping to start from.

- The assistant's web, next: another search provider (or the provider's own search for Anthropic and OpenAI), PDFs, and a remembered globe setting per assistant
- Three editions, as Longview has: the private repo (**DO Notes**, personal, deployed, with
  backups) feeds the public one (`commonplace-md`, a snapshot per release, MIT licensed, not a
  commercial product), which a work edition could start from in its own repository, with its own sign-in and hosting. Nothing from the work edition comes back.
- Folder and tag colours in the sidebar, stored per vault (other editors keep these in plugin
  settings, not in notes; see F10)
- Import from Apple Notes or Notion
- Per-vault theme or accent colour (F18's themes are tokens too; share them)
- **Recall and Longview, joined through Commonplace (M, after F9; 2026-10-31):** (the
  assistant reads both since 2026-11-01, F30) import new
  Recall cards (Recall's MCP server, read-only) as notes in a Reading collection; link their
  companies and models to Longview by AI-XF reference (`longview-ai/<id>`); send a chosen note's
  URL to Longview's `save_url`. The overlap was measured 2026-10-31, and the shape is in
  Longview's ideas inbox, I9. The Longview half is **F30**.
From the brainstorm of 2026-10-11 (sizes rough; each must meet [PRINCIPLES.md](PRINCIPLES.md)):

- **Media as objects (M, after F16, from Capacities):** pictures and PDFs get a page of their own,
  with properties, backlinks ("used in 3 notes") and a place for notes about them
- **Another name for the `type` key (S, from F16):** for an imported vault where `type:`
  already means something else; a vault option in Settings → This vault
- **Presence (S):** who's in the vault and which note they're in, and "follow" someone's cursor
- **Activity feed (M):** what changed in a shared vault since you last looked, per note and person
- **Typography settings (S):** font and size choices, within the design language's scales, in
  Settings → Account
- **Email in (M):** forward an email to a private address and it lands in the Inbox

---

## Decided against

- **Capacitor for the iPhone app (L8, 2026-10-31):** a native Swift shell instead. The share
  extension is Swift either way, the app is one web view, and Capacitor would add a Node
  toolchain, plugins and a build step for nothing the web client doesn't already do.

- **A ready-made Share from iPhone shortcut, for now (2026-10-31):** tried a shortcut file built in
  code and signed with `shortcuts sign` (no address or token in it; iOS asks for a setup code
  when it's added). Signing and the import sheet worked, but on macOS 27 **Add Shortcut** returned
  to the question instead of adding it, with nothing in the log, and Apple documents neither the
  format nor import questions. The approach others use is a shortcut built once in the app and
  shared as an iCloud link with an import question; the real fix is the iPhone app's share
  extension (L8). Building it by hand stays.

- **A Confluence-style page tree (2026-10-26):** pages are never both a page and a folder of
  child pages. A page says it's `part-of` another (F27, AI-XF's relationship), and the other
  shows it under Has part, so the structure lives in the Markdown, not in an order the app keeps.
- **Dragging table rows and columns (2026-10-26):** the Row and Column menus move them a step at a
  time, the same on a phone, where dragging inside a grid fights scrolling. (Wide tables already
  scroll sideways inside the note.)
- **Layouts and columns, and tables with merged cells (2026-10-26):** Markdown can't say either,
  so they'd be HTML other editors show badly. An import flattens layouts into one column and
  writes a merged table as plainly as it can.

- **Hover previews on published sites (F18, 2026-10-18):** they need script, and published pages
  run none (the CSP allows none, so nothing on a page can act as the app). Links go to the page.
- **Database storage autoscaling (2026-10-12):** kept off on purpose. While Commonplace is in
  development there's no reason to pass 1 GB, and storage never shrinks once added, so a
  runaway write would quietly raise the bill for good. The server guards the disk itself
  instead (`src/storage.ts`: new data refused at 90%, one version per agent burst, 100 versions
  a note, 5 MB a note). Revisit when real use approaches the limit; then raise `DB_DISK_GB`
  with the disk.
- **Copying a GitHub repo in from its zipball (F14, 2026-10-12):** the Git Trees and Blobs APIs
  fetch only the chosen folder and file types, give each file's sha for later updates, and let
  size limits apply before anything is downloaded.
- **A monthly schedule for F19 (2026-10-12):** a month of changes is too big a PR to review,
  and the branch drifts far from `main`. Hourly, daily or weekly.
- **A new PR every period while one is open (F19, 2026-10-12):** one open PR at a time; a new
  period's changes are added to it until it's merged.
- **A second way to write relations (F9, 2026-10-12):** AI-XF typed links (`links: [{rel,
  to}]`) are an export and import format, not an editor of their own; F16 relation properties
  are how notes are linked.
- **Writing AI-XF canonical frontmatter on every save (F9, 2026-10-12):** it would reorder
  frontmatter people wrote by hand; canonical form is written on export only.

- **Writing colours as `=={red}…==` or classes (2026-10-12):** Commonplace writes HTML
  (`<mark style="background: …">`, `<span style="color: …">`) because it shows in other Markdown editors,
  Typora and any HTML viewer with no plugin; the cost is that editors don't render markdown
  inside, so colour wraps plain text. Hilo's syntax and Highlightr's classes are read, not
  written, as they need a plugin to show.
- **Moving the database to Supabase** (2026-10-11) — Commonplace doesn't use Supabase's bundle
  (auth, storage, realtime, APIs); on the database alone Render is cheaper at this size, includes
  point-in-time recovery, offers HA that Supabase doesn't on Pro, keeps app and database on one
  private network, and runs Postgres 18 (unconfirmed on Supabase). Comparison in L7.
- **`alter extension vector update` at boot** — Render's upgrade already moved pgvector to 0.8.6,
  but the server's default version is 0.8.1, so a bare update tries to downgrade and fails; the
  deploy crashed on start (`1786788`, reverted in `0bd265b`). Leave extension versions to Render.
- **HTML5 drag and drop for the file tree** — iPhone Safari doesn't support it reliably; the tree
  uses pointer events with a long press on touch (`web/lib/useTreeDrag.tsx`).
- **Empty folders kept only in the browser** — they'd vanish on reload and be invisible to other
  members; they live in the `folders` table instead.
- **React StrictMode** — its double-mounted effects open and close each note's live socket twice
  (`web/main.tsx`).
- **Rebuilding a note's Yjs state from its text** — duplicates text when an offline client
  reconnects; external writes are diffed in (`src/ydoc.ts`, see `CLAUDE.md`).
