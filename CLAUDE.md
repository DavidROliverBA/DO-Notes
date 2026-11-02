# CLAUDE.md — Commonplace

Multi-user Markdown editor. Bun server (`src/`), React + CodeMirror client (`web/`,
bundled by Bun from `web/index.html`, no build step), Postgres + pgvector (`db/schema.sql`).
README.md describes the system and docs/ARCHITECTURE.md how it is built (components, data model,
key flows, decisions); read it before structural changes, and keep it current when they land.

## Conventions

- **bun, not npm/node.** `bun run dev`, `bun test`, `bunx tsc --noEmit`.
- **Schema is create-if-not-exists** and runs at every boot (`src/migrate.ts`). Additive changes
  only: `add column if not exists`, never destructive DDL.
- **Markdown is the source of truth.** Every write goes through `notes.persist()` (re-derives
  tags/links/frontmatter in the same transaction). Writes from outside the editor go through
  `notes.overwriteContent()` so they reach open live rooms.
- **Offline copies (F4)** live in IndexedDB as `cp-<instance>-u<userId>-<noteId>` (`web/lib/offline.ts`);
  `instance` comes from `server_info`, so a replaced database never merges with old copies, and
  when someone else signs in on the browser, `claimDevice` drops the last person's copies and
  cached reads first. The
  service worker (`web/sw.js`) is network-first and caches only the reads listed in `API_KEEP`;
  never add writes, the event stream, AI or exports to it.
- **Never replace a note's Yjs state with one rebuilt from text** — diff into it
  (`ydoc.ts: applyTextDiff / rebaseStoredDoc`). Rebuilding duplicates text when an offline client
  reconnects. `test/markdown.test.ts` has the regression test.
- **`src/markdown.ts` is shared with the browser.** Keep it free of server imports.
- **Viewer = read-only on every path**, including WebSocket sync messages (`collab.ts`). Any new
  write route must call `vaultCtx(ctx, "editor")`; return 404 (not 403) for non-members.
- **Embeddings are vector(1024)** for every provider. Changing dims means a migration plus a
  re-embed — don't do it casually.
- **Non-browser clients use bearer tokens** (`src/tokens.ts`: hashed, scoped, revocable; never in
  URLs). AI tools are defined once in `src/tools.ts` (served over MCP by `src/mcp.ts`); a new
  capability for agents goes there, running as the user with their vault roles. A write tool
  needs a `preview` (what it would change, without writing) so the in-app assistant (`src/ai.ts`)
  can ask before changing anything beyond the open note. Nothing deletes. Appends from outside the editor pass a function to `overwriteContent` so they apply to
  the live text and can't undo someone's typing.
- **AI keys are people's own** (`src/assistants.ts`): sealed with `SECRETS_KEY`, never returned to
  the browser, sent to providers only in headers. Provider formats stay in `src/llm.ts`; the rest
  of the app uses its neutral `Msg` shape. Tests use the fake provider in `test/fakeAi.ts`.
  Model prices (£ per million, with the date checked) are in `src/prices.ts`: update the table
  and its date together. Each call is recorded in `ai_usage`, which the daily £ limit reads.
- **The assistant's web** (`src/web.ts`): in-app only (never in `tools.ts`, so never over MCP),
  and only when the assistant is allowed it and the conversation turns it on. Pages go through
  `safeFetch`; searches use the person's own sealed Brave key. A web request runs without asking
  only when what it sends is text the person typed (`fromPerson`) or a link a search returned;
  every other one asks, the first included, since it could carry note text. Once a conversation
  has used the web, all changes ask first too (`ai.ts`). Keep that rule for any new tool that
  sends data out.
- **GitHub vaults** (F14, `src/git.ts`): REST API only, no git binary, no clone URLs; the
  token goes in the `Authorization` header and never into a URL, log or response. A push builds
  its tree on the base tree, so files that weren't copied in (code, dot-folders) can't change.
  Writes to notes go through `createNote` / `overwriteContent` like any other, and an update
  never writes conflict markers into a note: clashes wait in `git_clashes`. Tests use
  `test/fakeGitHub.ts`. Automatic sending (F19, `src/gitAuto.ts`) reuses `update`, `push` and
  `publish`: it always merges first, pauses on a clash or refusal (never forces), leaves held
  notes out, and sends with the chosen owner's token; branch protection is GitHub's to enforce.
- **Types are notes** (F16, `src/types.ts`): `Types/X.md` defines a type in its frontmatter; a
  note is an X when it says `type: X`; relations are `[[wikilinks]]` in properties. The type is
  a generated column (`notes.type_name`). Never store type data outside the markdown, so a vault
  exports as plain, portable Markdown; saved views are `.base` files beside the type.
- **Storage guard** (N9, `src/storage.ts`): the database disk is fixed and autoscaling is off on
  purpose. Any new path that adds data (notes, files, imports, syncs) calls `assertRoom(bytes)`
  first; `createNote` and `overwriteContent` already do, and check the 5 MB note cap. Live typing
  is never refused. Automated writers (agents, GitHub) keep one version per burst, not per call.
- **Published sites** (F18, `src/publish.ts`): `/p/<slug>/` serves only the snapshot tables
  (`site_pages`, `site_files`), never `notes` or `attachments`; anything new on a page must be
  written into the snapshot at Publish, and must leave out what isn't published (titles
  included). Pages run no script: keep the CSP, and never let a note's HTML attributes through.
  One note shared by link (F38, `src/shareLink.ts`, `/s/<slug>/`) follows the same rules: a
  snapshot of the page and its files, no script, other notes as plain words.
  The builder's preview (`previewSite`) is the one reader of live notes: owners only, drawn by
  the same `respond`, showing only what Publish would include, in a frame with no scripts.
- **Sharing is by invitation** (N13, `src/vaults.ts`): adding someone writes `vault_invites`;
  only Accept writes `vault_members`, which every access check reads, so a pending invite grants
  nothing. Never reveal whether an email has an account.
- **Outgoing requests to addresses people give** (weblinks, assistants' base URLs) go through
  `src/egress.ts` (`vetAddresses` + `pinnedFetch`), never a bare `fetch`, so they can't reach
  private addresses. The app's CSP allows no inline script: keep it that way.
- **A note's code runs only in the dataviewjs sandbox** (`src/sandbox.ts`): an opaque-origin
  frame whose policy allows no network. Never run note code elsewhere (not the app's page, not
  the server, not published sites), and never give that frame `allow-same-origin`, popups,
  forms or a connect-src. What it may ask the app for is the short list in
  `web/lib/dataviewjs.ts`; check every new message there. Publish runs blocks in that frame in
  the owner's browser over published notes only; what comes back is untrusted and goes through
  `cleanFrozen` (`src/publish.ts`) before it reaches a page.
- No secrets in the repo; `.env` is gitignored and `.env.example` documents the shape.

## Words

The product is called **DO Notes** (2026-11-02; it was **Skein** from F34, 2026-11-01, which was
hard to say): that's the name people see, in the app, help, icons and messages. The repository,
code, bundle ids, the `commonplace://` scheme, user-agent markers (`CommonplaceApp/`), the
database, routes, storage keys, paths such as `~/Commonplace` and the Render service keep
**commonplace**: never rename those.

The repository is copied to the public `commonplace-md` at each release, so nothing in it names a
real person but David, an employer, the live server's address or the Apple team id: those live
in `.env`, `ios/Config/Local.xcconfig` and Render, which aren't in git. Made-up names only in
tests, mockups and screenshots.

People see **library** (the whole server, named in Settings → Admin; `server_info.library`) and
**collections** (separate sets of notes with their own members). The code, database, API routes
(`/api/vaults`), URLs, storage keys and MCP tool names (`list_vaults`) still say **vault**: never
rename those, and don't show the word "vault" on screen or in help, except to say that other editors
call a collection a vault.

## Principles

`docs/PRINCIPLES.md` is the design bar: easy to use, one consistent design language, style and
grace. Every UI change follows it and its checklist — tokens and shared components only, no
browser `alert`/`confirm`/`prompt`, works on the iPhone, light and dark, undo over confirm.

- **Every user action goes in `web/lib/commands.ts`** (title, icon, keywords, when it applies),
  so the ⌘K palette, the note's ⋯ menu and the `/` menu stay one list. Screens `provide()` what
  they can do.
- **Every setting goes in Settings** (`web/components/Settings.tsx`, F17), in one of its
  sections; open it at a section with `openSettings()` from `web/lib/settings.ts`. View state
  (sort, mode, panels, filters) stays where it acts.
- **Shared UI lives in `web/ui/`** (`Modal`, `Menu`, `overlays.tsx` for `confirmDialog`,
  `promptDialog`, `toast`, `toastError`; see `web/ui/README.md`). Reuse them; if a screen needs
  something new and general, add it there.
- **Styles:** values only from `web/styles/tokens.css`; one file per area in `web/styles/`, all
  listed in `web/styles.css`. `test/design.test.ts` enforces this.
- **Look before you ship UI:** `bun run screens` and check the laptop and phone shots in both
  themes.

## Help

`docs/help/*.md` is the user guide, shown in the app, the standalone file and on GitHub. When a
feature changes what someone sees or does, update its help page in the same change, and retake
the pictures with `bun run help:shots` (the shots are listed in `test/ui/screens.ts`).
`test/help.test.ts` fails on a missing page, link or picture, or a command shortcut the
shortcuts page doesn't list. Mark a page `standalone: true` only if it holds for the standalone
file; its pictures go inside that file, so keep them few.

## Backlog

`docs/BACKLOG.md` is the list of what to do next, with **Now** (risks) before features. When
finishing an item, add it to `docs/CHANGELOG.md` with the date and release or commit, move its
design (if it had one) to `docs/design/<id>.md`, and take it out of the backlog; record rejected
approaches under **Decided against**. New ideas go under **Ideas** in one line.

## Verification

`bun run typecheck` and `bun test` must pass, and `bun run test:ui` for any UI change (the e2e
suite needs `docker compose up -d db` and a `commonplace_test` database, created by `db/init/` on a fresh container — see README).
