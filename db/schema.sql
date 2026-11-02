-- Commonplace schema. Postgres 18 + pgvector. Every statement is create-if-not-exists so
-- migrate.ts can run at every boot; changes are additive only (add column if not exists).

create extension if not exists vector;
create extension if not exists pg_trgm;

-- Accounts (src/auth.ts): argon2id password hashes; the first account to sign up is the admin.
create table if not exists users (
  id            bigserial primary key,
  email         text not null unique,          -- stored lower-cased
  name          text not null,
  password_hash text not null,
  is_admin      boolean not null default false,
  created_at    timestamptz not null default now()
);

-- Server-side sessions so a sign-out (or an admin removing a user) takes effect at once.
-- The cookie carries a random token; only its SHA-256 is stored.
create table if not exists sessions (
  token_hash  text primary key,
  user_id     bigint not null references users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);
create index if not exists sessions_user on sessions(user_id);

-- A vault is a shared workspace: a folder of notes, but with members.
create table if not exists vaults (
  id          bigserial primary key,
  name        text not null,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now()
);

-- Each person's home collection (F20): where Share from iPhone sends when its token says "home",
-- and where the app opens when there's no last-used collection. Cleared if the vault goes.
alter table users add column if not exists home_vault_id bigint references vaults(id) on delete set null;

-- Who can open a vault, and as what: owners manage it, editors write, viewers only read.
create table if not exists vault_members (
  vault_id  bigint not null references vaults(id) on delete cascade,
  user_id   bigint not null references users(id) on delete cascade,
  role      text not null check (role in ('owner', 'editor', 'viewer')),
  added_at  timestamptz not null default now(),
  primary key (vault_id, user_id)
);
create index if not exists vault_members_user on vault_members(user_id);

-- Invitations to a vault (N13). An owner invites an email; nothing is granted until that person
-- accepts, which is the only path into vault_members besides creating a vault. Keyed by email,
-- not user, so the reply never says whether an account exists and an invitation waits for someone
-- who signs up later. Membership checks read vault_members only, so a pending row grants nothing.
create table if not exists vault_invites (
  id          bigserial primary key,
  vault_id    bigint not null references vaults(id) on delete cascade,
  email       text not null,
  role        text not null check (role in ('owner', 'editor', 'viewer')),
  invited_by  bigint not null references users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (vault_id, email)
);
create index if not exists vault_invites_email on vault_invites(email);

-- Notes. `path` is the vault-relative file path including ".md" (e.g. "Projects/Plan.md"),
-- so export is a straight write of path → content. `content` is the markdown; `ydoc` is the
-- Yjs CRDT state that live editing works on. `content` is always the materialised text of
-- `ydoc`; a null `ydoc` means the note has never been opened live, and its first room builds it
-- from `content`. Writes from outside the editor diff into `ydoc`, never replace it.
create table if not exists notes (
  id            bigserial primary key,
  vault_id      bigint not null references vaults(id) on delete cascade,
  path          text not null,
  content       text not null default '',
  ydoc          bytea,
  title         text not null,               -- basename without .md
  tags          text[] not null default '{}',
  frontmatter   jsonb not null default '{}',
  version       bigint not null default 1,
  embedded_hash text,                        -- content hash the chunks were embedded from
  created_by    bigint references users(id) on delete set null,
  updated_by    bigint references users(id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  search        tsvector generated always as (
                  setweight(to_tsvector('simple', title), 'A') ||
                  setweight(to_tsvector('english', content), 'B')
                ) stored,
  unique (vault_id, path)
);
create index if not exists notes_search on notes using gin(search);
create index if not exists notes_tags on notes using gin(tags);
create index if not exists notes_title_trgm on notes using gin(lower(title) gin_trgm_ops);
create index if not exists notes_vault_updated on notes(vault_id, updated_at desc);
-- Lookups by path and title ignore case (findByPath, resolveLink); without these each is a scan
-- of the vault, which made a 10,000-note import quadratic.
create index if not exists notes_vault_lower_path on notes(vault_id, lower(path));
create index if not exists notes_vault_lower_title on notes(vault_id, lower(title));

-- Wikilinks and markdown links, re-derived on every save. `target` is the link text as
-- written, normalised (lower-case, no .md, no #heading) and resolved at query time, so a
-- link to a note that does not exist yet starts working the moment the note is created.
create table if not exists links (
  vault_id  bigint not null references vaults(id) on delete cascade,
  source_id bigint not null references notes(id) on delete cascade,
  target    text not null,
  primary key (source_id, target)
);
create index if not exists links_target on links(vault_id, target);

-- Heading-sized chunks of each note, embedded for semantic search and related notes.
-- 1024 dims for every provider: voyage-4-lite, mxbai-embed-large and the hash fallback produce it,
-- and relaxAI's 4096 are cut to the first 1024 (src/embed.ts).
create table if not exists note_chunks (
  id         bigserial primary key,
  note_id    bigint not null references notes(id) on delete cascade,
  vault_id   bigint not null references vaults(id) on delete cascade,
  ord        int not null,
  heading    text,
  body       text not null,
  embedding  vector(1024),
  provider   text not null
);
create index if not exists note_chunks_note on note_chunks(note_id);
create index if not exists note_chunks_embedding on note_chunks using hnsw (embedding vector_cosine_ops);

-- Point-in-time snapshots (Version history), taken at most every ten minutes while a note is
-- being edited and before overwrites from outside the editor (import, restore, agents, GitHub;
-- one per burst for agents). Multi-user editing needs an undo that survives other people's edits.
create table if not exists note_revisions (
  id         bigserial primary key,
  note_id    bigint not null references notes(id) on delete cascade,
  content    text not null,
  author_id  bigint references users(id) on delete set null,
  reason     text not null default 'edit',
  created_at timestamptz not null default now()
);
create index if not exists note_revisions_note on note_revisions(note_id, created_at desc);

-- Deleted notes, restorable with their history for 30 days (purged by notes.purgeTrash). Kept
-- out of `notes` so no search, link or export query has to filter them.
create table if not exists trashed_notes (
  id          bigserial primary key,
  vault_id    bigint not null references vaults(id) on delete cascade,
  path        text not null,
  content     text not null,
  ydoc        bytea,
  revisions   jsonb not null default '[]',
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null,
  deleted_by  bigint references users(id) on delete set null,
  deleted_at  timestamptz not null default now()
);
create index if not exists trashed_notes_vault on trashed_notes (vault_id, deleted_at desc);

-- Folders that exist on their own, so an empty folder persists. A folder that
-- holds notes or files is implied by their paths and needs no row.
create table if not exists folders (
  vault_id    bigint not null references vaults(id) on delete cascade,
  path        text not null,
  created_at  timestamptz not null default now(),
  primary key (vault_id, path)
);

-- Images and other non-markdown files from an imported vault (or uploaded later), so
-- ![[diagram.png]] renders and the export round-trips.
create table if not exists attachments (
  id          bigserial primary key,
  vault_id    bigint not null references vaults(id) on delete cascade,
  path        text not null,
  mime        text not null,
  size        int not null,
  data        bytea not null,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  unique (vault_id, path)
);

-- Bearer tokens for clients that aren't the browser (src/tokens.ts): the iPhone capture Shortcut,
-- MCP agents, native apps later (docs/PRINCIPLES.md §10). Stored as SHA-256 hashes; shown once.
-- A capture token can only append to its note, in its vault, as its owner.
create table if not exists api_tokens (
  id            bigserial primary key,
  user_id       bigint not null references users(id) on delete cascade,
  vault_id      bigint not null references vaults(id) on delete cascade,
  name          text not null,
  scope         text not null default 'capture',
  token_hash    text not null unique,
  note_path     text not null default 'Inbox.md',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create index if not exists api_tokens_user on api_tokens (user_id);
-- MCP tokens (scope 'mcp' or 'mcp:read') cover every vault the person can see: no vault.
alter table api_tokens alter column vault_id drop not null;

-- Sign-in for MCP clients (F25, src/oauth.ts). Anyone may register a client (as the MCP spec
-- expects of claude.ai and others); one nobody signs in with is dropped after a day. A sign-in
-- makes an ordinary 'mcp' or 'mcp:read' api_tokens row carrying the client, an access token that
-- expires, and a refresh token (hashes only), so Connections lists it and revoking it ends it.
create table if not exists oauth_clients (
  id            text primary key,
  name          text not null,
  redirect_uris text[] not null,
  secret_hash   text,
  created_at    timestamptz not null default now()
);
create table if not exists oauth_codes (
  code_hash     text primary key,
  client_id     text not null references oauth_clients(id) on delete cascade,
  user_id       bigint not null references users(id) on delete cascade,
  redirect_uri  text not null,
  challenge     text not null,
  scope         text not null,
  expires_at    timestamptz not null
);
alter table api_tokens add column if not exists client_id text references oauth_clients(id) on delete cascade;
alter table api_tokens add column if not exists expires_at timestamptz;
alter table api_tokens add column if not exists refresh_hash text unique;

-- Bring-your-own AI assistants (F13, src/assistants.ts). Per person, never shared with vault
-- members. The API key is encrypted with SECRETS_KEY (AES-256-GCM, src/secrets.ts) and never sent
-- back to the browser: the settings show only its last four characters.
create table if not exists user_assistants (
  id            bigserial primary key,
  user_id       bigint not null references users(id) on delete cascade,
  name          text not null,
  provider      text not null,
  base_url      text not null default '',
  model         text not null,
  key_enc       text not null,
  key_hint      text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);
create unique index if not exists user_assistants_name on user_assistants (user_id, lower(name));
-- Prices (£ per million tokens; null = the list price in src/prices.ts) and a daily £ limit,
-- £1 unless changed. ai_usage is the ledger the limit is checked against: one row per assistant
-- per day (the server's TIME_ZONE), added to after every model call.
alter table user_assistants add column if not exists price_in numeric;
alter table user_assistants add column if not exists price_out numeric;
alter table user_assistants add column if not exists daily_cap numeric default 1.00;
-- May this assistant use the web (search and read pages) when a conversation turns it on? Off
-- until its owner allows it.
alter table user_assistants add column if not exists web boolean not null default false;
-- Each person's own web search key (Brave Search), sealed with SECRETS_KEY like AI keys.
create table if not exists user_search (
  user_id    bigint primary key references users(id) on delete cascade,
  provider   text not null default 'brave',
  key_enc    text not null,
  key_hint   text not null,
  created_at timestamptz not null default now()
);
-- The ledger: tokens and £ per assistant per day.
create table if not exists ai_usage (
  assistant_id  bigint not null references user_assistants(id) on delete cascade,
  day           date not null,
  input_tokens  bigint not null default 0,
  output_tokens bigint not null default 0,
  cost_gbp      numeric not null default 0,
  calls         int not null default 0,
  primary key (assistant_id, day)
);

-- Types (F16, src/types.ts): a note's type, from `type:` in its frontmatter (`Person`,
-- `"[[Person]]"` or `[Person]` all mean Person), kept as a column so type pages are an indexed
-- lookup at any vault size.
alter table notes add column if not exists type_name text generated always as (
  nullif(btrim(split_part(coalesce(frontmatter->'type'->>0, frontmatter->>'type'), '|', 1), ' []"'), '')
) stored;
create index if not exists notes_type on notes (vault_id, lower(type_name)) where type_name is not null;

-- This database's identity (F4): browsers keep notes for offline under names that include it, so
-- if the database is ever replaced, their old copies can't be merged into unrelated notes that
-- happen to reuse the same ids.
create table if not exists server_info (key text primary key, value text not null);
insert into server_info (key, value) values ('instance', gen_random_uuid()::text) on conflict (key) do nothing;

-- Bookmarks (F7): each person's starred notes, shown at the top of their sidebar.
create table if not exists bookmarks (
  user_id    bigint not null references users(id) on delete cascade,
  vault_id   bigint not null references vaults(id) on delete cascade,
  note_id    bigint not null references notes(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, note_id)
);

-- GitHub vaults (F14, src/git.ts). Each person connects their own fine-grained token, sealed
-- with SECRETS_KEY like AI keys and never sent back to the browser.
create table if not exists user_github (
  user_id      bigint primary key references users(id) on delete cascade,
  token_sealed text not null,
  token_hint   text not null,
  login        text not null,
  created_at   timestamptz not null default now()
);

-- A vault copied from a repo (or one folder of it). Edits are a branch: `base_sha` is the commit
-- the vault was copied from (or last updated to), `branch`/`head_sha` are set once pushed, and
-- `merge_sha` is a newer base still to be merged into the branch on the next push.
create table if not exists vault_git (
  vault_id      bigint primary key references vaults(id) on delete cascade,
  repo          text not null,
  folder        text not null default '',
  base_branch   text not null,
  base_sha      text not null,
  base_tree     text not null,
  branch        text,
  head_sha      text,
  merge_sha     text,
  pr_number     int,
  pr_url        text,
  pr_state      text,
  pr_checked_at timestamptz,
  created_by    bigint references users(id) on delete set null,
  created_at    timestamptz not null default now()
);

-- Each file as it is at the base commit: where it lives in the repo, its git blob, an md5 of the
-- text or bytes as stored here (compared with md5() of the live row to find changes), and a
-- note's text, for diffs, reverts and three-way merges.
create table if not exists git_files (
  vault_id   bigint not null references vaults(id) on delete cascade,
  path       text not null,
  repo_path  text not null,
  git_sha    text not null,
  mode       text not null default '100644',
  hash       text not null,
  content    text,
  primary key (vault_id, path)
);

-- What the branch on GitHub holds for each changed path after the last push ('' = deleted).
create table if not exists git_pushed (
  vault_id bigint not null references vaults(id) on delete cascade,
  path     text not null,
  hash     text not null,
  primary key (vault_id, path)
);

-- How a vault's changes go to GitHub (F19): 'ask' (someone presses Push, as F14), 'review' (a PR
-- every hour, day or week), 'sync' (each note pushed to the working branch once idle) or
-- 'publish' (straight onto the base branch, on the schedule or once idle). Sent with `send_as`'s
-- token. `paused_why` null while paused means a person paused it; otherwise it's why sending stopped.
alter table vault_git add column if not exists send_mode text not null default 'ask';
alter table vault_git add column if not exists send_every text not null default 'day';
alter table vault_git add column if not exists send_at text not null default '18:00';
alter table vault_git add column if not exists send_day int not null default 5;
alter table vault_git add column if not exists send_soon boolean not null default false;
alter table vault_git add column if not exists send_as bigint references users(id) on delete set null;
alter table vault_git add column if not exists coauthor_emails boolean not null default false;
alter table vault_git add column if not exists next_run_at timestamptz;
alter table vault_git add column if not exists paused_at timestamptz;
alter table vault_git add column if not exists paused_why text;
alter table vault_git add column if not exists last_sent_at timestamptz;
alter table vault_git add column if not exists last_error text;
-- The git blob each pushed path holds on the branch, so a held note keeps its pushed version.
alter table git_pushed add column if not exists sha text;

-- Notes held back from pushes (F19) until someone releases them. Kept here, not as a property in
-- the note, which would itself be pushed.
create table if not exists git_held (
  vault_id   bigint not null references vaults(id) on delete cascade,
  path       text not null,
  held_by    bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (vault_id, path)
);

-- Notes changed both here and on GitHub that didn't merge line by line: the note keeps its text
-- here until someone picks a side; `theirs` is GitHub's (null = deleted there).
create table if not exists git_clashes (
  vault_id   bigint not null references vaults(id) on delete cascade,
  path       text not null,
  theirs     text,
  created_at timestamptz not null default now(),
  primary key (vault_id, path)
);

-- Saved searches: a search kept in the sidebar, run afresh each time it's opened (a smart
-- folder). Per person, like bookmarks; other editors keep the same thing as a "search" bookmark.
create table if not exists saved_searches (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  vault_id   bigint not null references vaults(id) on delete cascade,
  query      text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists saved_searches_one on saved_searches (user_id, vault_id, query);

-- Other names a link can use for a note (F9 step 1): its `aliases` (a list
-- or one string) and its AI-XF `id`, lowercased like stored link targets. Generated from the
-- frontmatter, so the markdown stays the only source; notes.linkKeys and resolveLink use it.
-- (AI-XF is a markdown exchange format; see F9 in docs/BACKLOG.md.)
create or replace function cp_link_names(fm jsonb) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct lower(btrim(x))) filter (where btrim(x) <> ''), '{}')
  from (
    select jsonb_array_elements_text(case jsonb_typeof(fm->'aliases') when 'array' then fm->'aliases' when 'string' then jsonb_build_array(fm->'aliases') else '[]'::jsonb end) as x
    union all
    select fm->>'id' where jsonb_typeof(fm->'id') = 'string'
  ) names
$$;
alter table notes add column if not exists link_names text[] generated always as (cp_link_names(frontmatter)) stored;
create index if not exists notes_link_names on notes using gin (link_names);

-- Published sites (F18, src/publish.ts). Publish takes a snapshot: the chosen notes rendered to
-- HTML and the files they show, copied as they were, so later edits stay private until the next
-- Publish. /p/<slug>/ serves only these tables, never notes or attachments, so nothing left out
-- can be reached by any URL. Unpublishing sets live = false and keeps the snapshot, for Undo.
create table if not exists sites (
  vault_id     bigint primary key references vaults(id) on delete cascade,
  slug         text not null unique,
  live         boolean not null default false,
  settings     jsonb not null default '{}', -- publish.json as it was published
  published_at timestamptz,
  published_by bigint references users(id) on delete set null
);
-- Each published note, rendered to HTML at Publish.
create table if not exists site_pages (
  vault_id   bigint not null references sites(vault_id) on delete cascade,
  path       text not null, -- the note's path without ".md": its address under /p/<slug>/
  note_path  text not null,
  title      text not null,
  html       text not null,
  source_md5 text not null, -- the note's text when published, for "changed since you published"
  primary key (vault_id, path)
);
-- What a page shows beside its text (F18 step 2): contents, backlinks, tags, date, word count.
alter table site_pages add column if not exists meta jsonb not null default '{}';
-- Copies of the files the published pages show, taken at Publish.
create table if not exists site_files (
  vault_id bigint not null references sites(vault_id) on delete cascade,
  path     text not null,
  mime     text not null,
  data     bytea not null,
  primary key (vault_id, path)
);

-- Folder vaults on the Mac (F22, src/folderSync.ts): a vault kept in step with a folder of
-- Markdown under FOLDERS_ROOT. `root` is relative to it. 'folder': the folder is the master copy
-- and wins any clash; 'both': a note changed on both sides that doesn't merge waits in
-- folder_clashes. `paused_why` null while paused means a person paused it.
create table if not exists vault_folder (
  vault_id   bigint primary key references vaults(id) on delete cascade,
  root       text not null,
  mode       text not null default 'both',
  created_by bigint references users(id) on delete set null,
  created_at timestamptz not null default now(),
  paused_at  timestamptz,
  paused_why text,
  last_sync  timestamptz,
  last_error text
);
-- Each file as both sides last agreed: `rel` is its path in the folder (a .markdown file keeps
-- its name), `disk_hash` the md5 of its bytes there and `db_hash` the md5 of the text or bytes
-- stored here (they differ when the file has a BOM or CRLF line endings). `mtime`/`size` let a
-- scan skip reading files that haven't changed; `content` is a note's text, for merges.
create table if not exists folder_files (
  vault_id  bigint not null references vaults(id) on delete cascade,
  path      text not null,
  rel       text not null,
  disk_hash text not null,
  db_hash   text not null,
  mtime     double precision not null default 0,
  size      bigint not null default 0,
  content   text,
  primary key (vault_id, path)
);
-- Notes changed both here and in the folder that didn't merge line by line ('both' mode): the
-- note keeps its text here until someone picks a side; `theirs` is the folder's (null = deleted).
create table if not exists folder_clashes (
  vault_id   bigint not null references vaults(id) on delete cascade,
  path       text not null,
  theirs     text,
  created_at timestamptz not null default now(),
  primary key (vault_id, path)
);

-- The cloud library, seen from the Mac (F23, src/remote.ts; only where CLOUD_LINK is set). One
-- link per person: the cloud's address and endpoints, and the device token pair, sealed with
-- SECRETS_KEY. Each cloud collection gets an id from the vaults sequence, so it can't be confused
-- with a collection here (it has no vaults row), and is kept so the menu lists it offline.
create table if not exists remote_links (
  id            bigserial primary key,
  user_id       bigint not null unique references users(id) on delete cascade,
  url           text not null,
  client_id     text not null,
  token_url     text not null,
  revoke_url    text,
  access        text not null,
  refresh       text not null,
  expires_at    timestamptz not null,
  cloud_user_id bigint,
  cloud_email   text,
  library       text,
  created_at    timestamptz not null default now()
);
create table if not exists remote_vaults (
  id           bigint primary key default nextval('vaults_id_seq'),
  link_id      bigint not null references remote_links(id) on delete cascade,
  remote_id    bigint not null,
  name         text not null,
  role         text not null,
  note_count   int not null default 0,
  member_count int not null default 1,
  unique (link_id, remote_id)
);

-- F9: new notes get an AI-XF id written into their properties (kept out of sight in the app).
-- On for every collection; a collection can turn it off. New collections take AIXF_IDS.
alter table vaults add column if not exists aixf_ids boolean not null default true;

-- F32: passkeys, to sign in with Face ID or Touch ID (WebAuthn). Only each passkey's public
-- half is kept here; the secret half stays on the person's device or in iCloud Keychain.
-- Removing one sets removed_at (so Undo can put it back); removed ones never sign in and are
-- deleted after a day.
create table if not exists passkeys (
  id            bigserial primary key,
  user_id       bigint not null references users(id) on delete cascade,
  credential_id text not null unique,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  name          text not null default '',
  rp_id         text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  removed_at    timestamptz
);
create index if not exists passkeys_user on passkeys(user_id);

-- F30: each person's connections to knowledge outside Commonplace, for the in-app assistant
-- only: Longview (an address and a read token) and Recall (signed in with OAuth, read scope).
-- Tokens are sealed with SECRETS_KEY and never sent to the browser.
create table if not exists user_connections (
  user_id     bigint not null references users(id) on delete cascade,
  kind        text not null,
  address     text not null,
  token_enc   text not null,
  token_hint  text not null default '',
  refresh_enc text,
  expires_at  timestamptz,
  token_url   text,
  client_id   text,
  created_at  timestamptz not null default now(),
  primary key (user_id, kind)
);
-- Commonplace as an OAuth client of another server (Recall): its registration there, one per
-- server and address it's reached at (the redirect). (oauth_clients is the other way round:
-- apps registered with Commonplace's own MCP sign-in, F25.)
create table if not exists outside_oauth_clients (
  issuer       text not null,
  redirect_uri text not null,
  client_id    text not null,
  created_at   timestamptz not null default now(),
  primary key (issuer, redirect_uri)
);

-- F33: the connections manager. Each person's connections to services that meet the bar
-- (docs/design/F33.md), read-only. A preset (Longview, Recall) fills in what it knows. Tokens
-- are sealed with SECRETS_KEY and never sent to the browser. status: ok, review (a tool the
-- person chose has changed since they reviewed it: nothing is offered until they look again).
create table if not exists connections (
  id             bigserial primary key,
  user_id        bigint not null references users(id) on delete cascade,
  name           text not null,
  slug           text not null,
  preset         text,
  address        text not null,
  auth           text not null,
  token_enc      text,
  token_hint     text not null default '',
  refresh_enc    text,
  expires_at     timestamptz,
  token_url      text,
  client_id      text,
  status         text not null default 'ok',
  server_name    text,
  synced_at      timestamptz,
  created_at     timestamptz not null default now(),
  unique (user_id, slug)
);
-- Each connection's tools as the service last listed them, sorted by what they say they do
-- (kind: read, unknown, changes; a tool that changes things is never enabled), with a hash of
-- what the model would see, and the one the person reviewed (reviewed: what it said then).
create table if not exists connection_tools (
  connection_id  bigint not null references connections(id) on delete cascade,
  name           text not null,
  title          text,
  description    text not null default '',
  input_schema   jsonb not null default '{}',
  annotations    jsonb,
  kind           text not null,
  enabled        boolean not null default false,
  hash           text not null,
  reviewed_hash  text,
  reviewed       jsonb,
  primary key (connection_id, name)
);
-- F30's two connections move across, once: each row leaves the old table as it arrives here (the
-- empty table stays until a later release).
with moved as (delete from user_connections returning *)
insert into connections (user_id, name, slug, preset, address, auth, token_enc, token_hint, refresh_enc, expires_at, token_url, client_id, created_at)
  select user_id, case kind when 'longview' then 'Longview' else 'Recall' end, kind, kind, address,
         case kind when 'longview' then 'token' else 'oauth' end, token_enc, token_hint, refresh_enc, expires_at, token_url, client_id, created_at
  from moved
  on conflict (user_id, slug) do nothing;

-- Reminders for dated tasks (F35, src/reminders.ts): on or off, and the time for a task that has
-- only a date. The apps schedule the alerts; nothing else is stored.
alter table users add column if not exists reminders_on boolean not null default true;
alter table users add column if not exists reminder_time text not null default '09:00';

-- "From your connections" in the side panel (F33 step 4, src/outsidePanel.ts): the read tool a
-- connection looks the open note up with, by its title; null (the default) keeps it out of the panel.
alter table connections add column if not exists panel_tool text;

-- The words inside a file (src/fileText.ts): a PDF's text read on the server, a photo's words or a
-- voice note's transcript read on the iPhone or Mac. Null: not read yet; '': read, none found.
-- Searched by src/search.ts, which shows the notes that use the file.
alter table attachments add column if not exists text text;
alter table attachments add column if not exists text_search tsvector generated always as (to_tsvector('english', coalesce(text, ''))) stored;
create index if not exists attachments_text_search on attachments using gin(text_search);

-- One note shared by link (F38, src/shareLink.ts): a snapshot of its page and the files it shows,
-- served at /s/<slug>/ with no script. `live` false keeps the snapshot for Undo.
create table if not exists shared_notes (
  id          bigserial primary key,
  vault_id    bigint not null references vaults(id) on delete cascade,
  note_id     bigint not null unique references notes(id) on delete cascade,
  slug        text not null unique,
  page        text not null,
  title       text not null,
  html        text not null,
  source_md5  text not null,
  live        boolean not null default true,
  created_by  bigint references users(id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create table if not exists shared_note_files (
  share_id  bigint not null references shared_notes(id) on delete cascade,
  path      text not null,
  mime      text not null,
  data      bytea not null,
  primary key (share_id, path)
);

-- Notifications and activity (F39, src/notifications.ts): what's new for each person (under the
-- bell, and alerts from the apps), the notes they follow, and when they last looked at a collection.
create table if not exists notifications (
  id          bigserial primary key,
  user_id     bigint not null references users(id) on delete cascade,
  kind        text not null,
  actor_id    bigint references users(id) on delete set null,
  vault_id    bigint references vaults(id) on delete cascade,
  note_id     bigint references notes(id) on delete cascade,
  text        text not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz
);
create index if not exists notifications_user on notifications(user_id, id desc);
create table if not exists note_follows (
  user_id  bigint not null references users(id) on delete cascade,
  note_id  bigint not null references notes(id) on delete cascade,
  primary key (user_id, note_id)
);
create table if not exists vault_seen (
  user_id  bigint not null references users(id) on delete cascade,
  vault_id bigint not null references vaults(id) on delete cascade,
  seen_at  timestamptz not null,
  primary key (user_id, vault_id)
);

-- Comments on notes (L3, src/comments.ts): kept beside the note, never in its Markdown. A thread
-- starts on quoted words, anchored by Yjs relative positions (base64), so it stays on them while
-- the text around it is edited; replies have a parent. Resolved threads are kept, folded away.
create table if not exists comments (
  id           bigserial primary key,
  vault_id     bigint not null references vaults(id) on delete cascade,
  note_id      bigint not null references notes(id) on delete cascade,
  author_id    bigint references users(id) on delete set null,
  parent_id    bigint references comments(id) on delete cascade,
  quote        text not null default '',
  anchor_from  text,
  anchor_to    text,
  body         text not null,
  created_at   timestamptz not null default now(),
  edited_at    timestamptz,
  resolved_at  timestamptz,
  resolved_by  bigint references users(id) on delete set null
);
create index if not exists comments_note on comments(note_id, created_at);

-- Two-step sign-in (F40, src/twoStep.ts): a code app's secret, sealed with SECRETS_KEY, and the
-- last 30-second step used so a code can't be used twice; single-use recovery codes, as hashes;
-- and an account that signs in with passkeys only (its password is one nobody knows).
alter table users add column if not exists totp_secret text;
alter table users add column if not exists totp_last_step bigint;
alter table users add column if not exists password_off boolean not null default false;
create table if not exists recovery_codes (
  id         bigserial primary key,
  user_id    bigint not null references users(id) on delete cascade,
  code_hash  text not null,
  used_at    timestamptz
);
create index if not exists recovery_codes_user on recovery_codes(user_id);

-- Send to Longview (F30 step 4, src/sendLongview.ts): a second Longview token, one that can save,
-- sealed, beside the read-only connection and used only for save_url.
alter table connections add column if not exists send_enc text;
alter table connections add column if not exists send_hint text;
