// GitHub vaults (F14): a repo (or a folder of it) copied in as a vault, edited here as a branch,
// finished with a pull request. Nothing reaches the base branch without a PR, unless an owner
// chooses to publish straight to it (F19, src/gitAuto.ts, which also sends on a schedule).
//
//   copy in    the tree at the branch's head; markdown, canvases and attachments only (code,
//              dot-folders such as app settings and .github/ stay on GitHub). Each file's base is kept in git_files.
//   changes    notes and files whose md5 differs from their base, added or deleted; an added
//              file identical to a deleted one is a move. Worked out on request, never stored.
//   push       blobs → a tree on the base tree (so everything not copied is untouched) → a commit
//              → the branch's ref; the first push opens the PR. Later pushes add commits to it.
//   update     the base branch's newer files come in: unchanged notes update in place, notes
//              changed on both sides merge line by line (src/merge3.ts), and real clashes wait
//              in git_clashes for someone to pick a side.
//   cancel     every change goes back to the base through overwriteContent (open editors update
//              live, history keeps the edits); the pushed branch is deleted unless a PR is open.

import { createHash } from "node:crypto";
import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { emit } from "./events";
import { flushNote, kick } from "./collab";
import { blob, branchHead, clientFor, enc, type GitHub, repoPath, treeAt, type TreeEntry } from "./github";
import { merge3 } from "./merge3";
import { createNote, deleteNote as trashNote, findByPath, overwriteContent, renameNote } from "./notes";
import { settings } from "./settings";
import { assertRoom, MAX_NOTE_BYTES } from "./storage";
import { asText, importable, isNotePath, md5, pool, vaultPathFor } from "./syncCore";
import { mimeFor } from "./transfer";
import { createVault, type Vault } from "./vaults";

const MAX_FILES = 5000;
const MAX_NOTE = MAX_NOTE_BYTES;
const MAX_FILE = 25 * 1024 * 1024;

/** To Trash, closing its live room first so Trash holds the latest text (as the API does). */
async function deleteNote(vaultId: number, noteId: number, userId: number) {
  kick({ noteId }, "note deleted");
  await flushNote(noteId);
  await trashNote(vaultId, noteId, userId);
}

const cleanFolder = (f: string) => f.trim().replace(/^\/+|\/+$/g, "");
const prefixOf = (folder: string) => (folder ? `${folder}/` : "");

export interface VaultGit {
  vault_id: number;
  repo: string;
  folder: string;
  base_branch: string;
  base_sha: string;
  base_tree: string;
  branch: string | null;
  head_sha: string | null;
  merge_sha: string | null;
  pr_number: number | null;
  pr_url: string | null;
  pr_state: string | null;
  pr_checked_at: Date | null;
  send_mode: SendMode;
  send_every: "hour" | "day" | "week";
  send_at: string;
  send_day: number;
  send_soon: boolean;
  send_as: number | null;
  coauthor_emails: boolean;
  next_run_at: Date | null;
  paused_at: Date | null;
  paused_why: string | null;
  last_sent_at: Date | null;
  last_error: string | null;
}

export type SendMode = "ask" | "review" | "sync" | "publish";

export async function gitRow(vaultId: number): Promise<VaultGit> {
  const [g] = await sql<VaultGit[]>`select * from vault_git where vault_id = ${vaultId}`;
  if (!g) throw new HttpError(404, "This collection isn't from GitHub");
  return g;
}

// ── copying a repo in ────────────────────────────────────────────────────────────────────

function wanted(entries: TreeEntry[], folder: string) {
  const prefix = prefixOf(folder);
  return entries.filter((e) => e.type === "blob" && e.path.startsWith(prefix) && importable(e.path.slice(prefix.length)));
}

/** Folders that hold notes, for the picker: the whole repo first, then the busiest folders. */
export async function folders(gh: GitHub, repo: string, branch: string) {
  const head = await branchHead(gh, repo, branch);
  const notes = wanted(await treeAt(gh, repo, head.tree), "").filter((e) => isNotePath(e.path));
  const count = new Map<string, number>();
  for (const e of notes) {
    const parts = e.path.split("/").slice(0, -1);
    for (let i = 1; i <= parts.length; i++) count.set(parts.slice(0, i).join("/"), (count.get(parts.slice(0, i).join("/")) ?? 0) + 1);
  }
  const list = [...count].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40);
  return [{ folder: "", notes: notes.length }, ...list.map(([folder, notes]) => ({ folder, notes }))];
}

export interface CopyReport {
  vault: Vault;
  notes: number;
  files: number;
  skipped: { path: string; why: string }[];
}

export async function copyIn(user: User, opts: { repo: string; branch: string; folder?: string; name?: string }): Promise<CopyReport> {
  const gh = await clientFor(user.id);
  const folder = cleanFolder(opts.folder ?? "");
  const head = await branchHead(gh, opts.repo, opts.branch);
  const entries = await treeAt(gh, opts.repo, head.tree);
  const prefix = prefixOf(folder);
  if (folder && !entries.some((e) => e.path.startsWith(prefix))) throw new HttpError(404, `There's no folder ${folder} on ${opts.branch}`);
  const files = wanted(entries, folder);
  const skipped: CopyReport["skipped"] = [];
  const take = files.filter((e) => {
    const limit = isNotePath(e.path) ? MAX_NOTE : MAX_FILE;
    if ((e.size ?? 0) > limit) skipped.push({ path: e.path, why: `larger than ${limit / 1048576} MB` });
    return (e.size ?? 0) <= limit;
  });
  if (take.length > MAX_FILES) throw new HttpError(413, `That has ${take.length} notes and files; the limit is ${MAX_FILES}. Pick a folder.`);
  const total = take.reduce((n, e) => n + (e.size ?? 0), 0);
  if (total > settings.maxImportBytes) throw new HttpError(413, `That's ${Math.round(total / 1048576)} MB of notes and files; the limit is ${settings.maxImportBytes / 1048576} MB. Pick a folder.`);
  await assertRoom(total);

  const name = opts.name?.trim() || (folder ? `${opts.repo.split("/")[1]} / ${folder}` : opts.repo.split("/")[1]!);
  const vault = await createVault(user, name.slice(0, 200));
  let notes = 0;
  let count = 0;
  try {
    let started = 0;
    await pool(take, 8, async (e) => {
      // As in importFiles: fresh statistics as the vault grows, so its lookups stay indexed.
      if (++started % 1000 === 0) await sql`analyze notes, links, attachments, git_files`;
      const rel = e.path.slice(prefix.length);
      const vp = vaultPathFor(rel);
      if (!vp) return void skipped.push({ path: e.path, why: "its name can't be a collection path" });
      const data = await blob(gh, opts.repo, e.sha);
      if (isNotePath(rel)) {
        const text = asText(data);
        try {
          await createNote(vault.id, user.id, vp, text);
        } catch (err) {
          if (err instanceof HttpError && err.status === 409) return void skipped.push({ path: e.path, why: `${vp} is already taken` });
          throw err;
        }
        await sql`insert into git_files (vault_id, path, repo_path, git_sha, mode, hash, content)
                  values (${vault.id}, ${vp}, ${e.path}, ${e.sha}, ${e.mode}, ${md5(text)}, ${text})`;
        notes++;
      } else {
        await sql`insert into attachments (vault_id, path, mime, size, data, created_by)
                  values (${vault.id}, ${vp}, ${mimeFor(vp)}, ${data.byteLength}, ${data}, ${user.id}) on conflict do nothing`;
        await sql`insert into git_files (vault_id, path, repo_path, git_sha, mode, hash)
                  values (${vault.id}, ${vp}, ${e.path}, ${e.sha}, ${e.mode}, ${md5(data)}) on conflict do nothing`;
        count++;
      }
    });
    await sql`insert into vault_git (vault_id, repo, folder, base_branch, base_sha, base_tree, created_by)
              values (${vault.id}, ${opts.repo}, ${folder}, ${opts.branch}, ${head.sha}, ${head.tree}, ${user.id})`;
  } catch (err) {
    await sql`delete from vaults where id = ${vault.id}`;
    throw err;
  }
  emit(vault.id, { type: "vault.changed" });
  return { vault: { ...vault, note_count: notes }, notes, files: count, skipped };
}

// ── what's changed ───────────────────────────────────────────────────────────────────────

export type ChangeKind = "added" | "edited" | "deleted" | "moved";
export interface Change {
  path: string;
  kind: ChangeKind;
  /** A move's old path. */
  from?: string;
  note: boolean;
  noteId: number | null;
  /** md5 now ('' when deleted). */
  hash: string;
  /** Where it goes in the repo. */
  repoPath: string;
  mode: string;
  /** Not on the pushed branch yet. */
  unpushed: boolean;
  /** Held back from pushes until someone releases it (F19). */
  held: boolean;
  /** When the note last changed (null for a deletion): automatic pushes wait for it to go quiet. */
  updatedAt: Date | null;
}

interface Row {
  path: string;
  cur_hash: string | null;
  base_hash: string | null;
  is_note: boolean;
  note_id: number | null;
  repo_path: string | null;
  mode: string | null;
  updated_at: Date | null;
  updated_by: number | null;
}

async function changeRows(vaultId: number): Promise<Row[]> {
  return sql<Row[]>`
    with cur as (
      select path, md5(content) as hash, true as is_note, id as note_id, updated_at, updated_by from notes where vault_id = ${vaultId}
      union all
      select path, md5(data), false, null, created_at, created_by from attachments where vault_id = ${vaultId}
    ), base as (
      select path, hash, repo_path, mode, content is not null as is_note from git_files where vault_id = ${vaultId}
    )
    select coalesce(c.path, b.path) as path, c.hash as cur_hash, b.hash as base_hash,
           coalesce(c.is_note, b.is_note) as is_note, c.note_id, b.repo_path, b.mode, c.updated_at, c.updated_by
    from cur c full join base b on b.path = c.path
    where c.path is null or b.path is null or c.hash <> b.hash
    order by c.updated_at nulls last, 1`;
}

/** Every note and file that differs from its base, with deletions paired up into moves. */
export async function changes(vaultId: number, g?: VaultGit): Promise<Change[]> {
  const git = g ?? (await gitRow(vaultId));
  const rows = await changeRows(vaultId);
  const pushed = new Map((await sql`select path, hash from git_pushed where vault_id = ${vaultId}`).map((r) => [r.path as string, r.hash as string]));
  const held = await heldPaths(vaultId);
  const deleted = rows.filter((r) => r.cur_hash === null);
  const usedAsMove = new Set<string>();
  const out: Change[] = [];
  for (const r of rows) {
    if (r.cur_hash === null) continue; // deletions after, unless they turn out to be moves
    let kind: ChangeKind = r.base_hash === null ? "added" : "edited";
    let from: string | undefined;
    if (kind === "added") {
      const d = deleted.find((x) => x.base_hash === r.cur_hash && x.is_note === r.is_note && !usedAsMove.has(x.path));
      if (d) {
        kind = "moved";
        from = d.path;
        usedAsMove.add(d.path);
      }
    }
    const repoPath = r.repo_path ?? prefixOf(git.folder) + r.path;
    out.push({ path: r.path, kind, from, note: r.is_note, noteId: r.note_id, hash: r.cur_hash, repoPath, mode: r.mode ?? "100644", unpushed: pushed.get(r.path) !== r.cur_hash, held: held.has(r.path) || (!!from && held.has(from)), updatedAt: r.updated_at });
  }
  for (const d of deleted) {
    if (usedAsMove.has(d.path)) continue; // a move's old path is listed with the move, not as a deletion
    out.push({ path: d.path, kind: "deleted", note: d.is_note, noteId: null, hash: "", repoPath: d.repo_path!, mode: d.mode ?? "100644", unpushed: pushed.get(d.path) !== "", held: held.has(d.path), updatedAt: null });
  }
  return out;
}

async function heldPaths(vaultId: number): Promise<Set<string>> {
  return new Set((await sql`select path from git_held where vault_id = ${vaultId}`).map((r) => r.path as string));
}

/** Hold a note back from pushes, or release it (F19). */
export async function hold(vaultId: number, user: User, path: string, held: boolean): Promise<Status> {
  if (held) await sql`insert into git_held (vault_id, path, held_by) values (${vaultId}, ${path}, ${user.id}) on conflict do nothing`;
  else await sql`delete from git_held where vault_id = ${vaultId} and path = ${path}`;
  emit(vaultId, { type: "vault.changed" });
  return status(vaultId, user.id);
}

/** Paths pushed earlier that have since gone back to their base: the branch still differs. */
function revertedSincePush(list: Change[], pushed: Map<string, string>, moves: Set<string>, held: Set<string>): number {
  const now = new Set(list.map((c) => c.path));
  return [...pushed.keys()].filter((p) => !now.has(p) && !moves.has(p) && !held.has(p)).length;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "edits";

const BRANCH = /^(?!\/|.*(?:\.\.|\/\/|@\{|\.lock$|\/$|\.$))[\w./-]{1,100}$/;
function checkBranch(name: string): string {
  const b = name.trim();
  if (!BRANCH.test(b)) throw new HttpError(400, "A branch name is letters, numbers, - _ . and /, with no spaces or ..");
  return b;
}

export interface Status {
  repo: string;
  folder: string;
  baseBranch: string;
  baseSha: string;
  branch: string;
  /** Pushed to GitHub yet. */
  pushed: boolean;
  pr: { number: number; url: string; state: string } | null;
  changes: Change[];
  clashes: { path: string; deletedThere: boolean }[];
  /** Changes not on the branch on GitHub yet (including ones undone since the last push). */
  unpushed: number;
  /** People who changed these notes, for the commit's Co-authored-by lines. */
  authors: { id: number; name: string; email: string }[];
  /** A newer base is merged into the branch on the next push. */
  mergePending: boolean;
  /** Changes held back from pushes. */
  held: number;
  /** How changes go to GitHub (F19). */
  auto: AutoStatus;
}

export interface AutoStatus {
  mode: SendMode;
  every: VaultGit["send_every"];
  at: string;
  day: number;
  soon: boolean;
  coauthorEmails: boolean;
  sendAs: { id: number; name: string } | null;
  /** Why automatic sending has stopped: a person paused it, a clash, the sender, or GitHub. */
  paused: { by: "person" | "clashes" | "sender" | "github"; message: string } | null;
  nextRunAt: Date | null;
  lastSentAt: Date | null;
  lastError: string | null;
  /** Changes an automatic push would send now (not held; deletions wait when publishing). */
  waiting: number;
  /** Deletions that wait for a person when publishing straight to the branch. */
  deletionsWaiting: number;
}

/** Whether automatic pushes leave this change out: held, or a deletion when publishing. */
export const leftOut = (c: Change, mode: SendMode) => c.held || (mode === "publish" && c.kind === "deleted");

function pausedOf(g: VaultGit, clashes: number): AutoStatus["paused"] {
  if (!g.paused_at) return null;
  if (!g.paused_why) return { by: "person", message: "Automatic pushes are paused" };
  if (g.paused_why === "clashes") return { by: "clashes", message: `Automatic pushes are paused: ${clashes === 1 ? "1 note" : `${clashes} notes`} to settle` };
  if (g.paused_why.startsWith("sender:")) return { by: "sender", message: g.paused_why.slice(7) };
  return { by: "github", message: g.paused_why.replace(/^github:/, "") };
}

export async function status(vaultId: number, userId?: number): Promise<Status> {
  let g = await gitRow(vaultId);
  // The PR's state, at most once a minute, with whoever is looking's token.
  if (g.pr_number && g.pr_state === "open" && userId && (!g.pr_checked_at || Date.now() - +g.pr_checked_at > 60_000)) {
    try {
      const gh = await clientFor(userId);
      const pr = await gh.get(`${repoPath(g.repo)}/pulls/${g.pr_number}`);
      const state = pr.merged ? "merged" : pr.state;
      g = (await sql<VaultGit[]>`update vault_git set pr_state = ${state}, pr_checked_at = now() where vault_id = ${vaultId} returning *`)[0] ?? g;
    } catch {
      // not connected, or GitHub unreachable: show what we knew
    }
  }
  const list = await changes(vaultId, g);
  const pushed = new Map((await sql`select path, hash from git_pushed where vault_id = ${vaultId}`).map((r) => [r.path as string, r.hash as string]));
  const moves = new Set(list.filter((c) => c.from).map((c) => c.from!));
  const clashes = await sql`select path, theirs is null as deleted_there from git_clashes where vault_id = ${vaultId} order by path`;
  const ids = [...new Set((await changeRows(vaultId)).map((r) => r.updated_by).filter((x): x is number => x != null))];
  const authors = ids.length ? await sql<{ id: number; name: string; email: string }[]>`select id, name, email from users where id in ${sql(ids)} order by name` : [];
  const held = await heldPaths(vaultId);
  const [sender] = g.send_as ? await sql<{ id: number; name: string }[]>`select id, name from users where id = ${g.send_as}` : [];
  const sendable = list.filter((c) => !leftOut(c, g.send_mode));
  let branch = g.branch;
  if (!branch) {
    const first = list.find((c) => c.note) ?? list[0];
    branch = `commonplace/${slug(first ? first.path.split("/").pop()!.replace(/\.md$/i, "") : "edits")}`;
  }
  return {
    repo: g.repo,
    folder: g.folder,
    baseBranch: g.base_branch,
    baseSha: g.base_sha,
    branch,
    pushed: !!g.head_sha,
    pr: g.pr_number ? { number: g.pr_number, url: g.pr_url!, state: g.pr_state ?? "open" } : null,
    changes: list,
    clashes: clashes.map((c) => ({ path: c.path, deletedThere: c.deleted_there })),
    unpushed: g.head_sha ? list.filter((c) => c.unpushed && !c.held).length + revertedSincePush(list, pushed, moves, held) + (g.merge_sha ? 1 : 0) : list.filter((c) => !c.held).length,
    authors,
    mergePending: !!g.merge_sha,
    held: list.filter((c) => c.held).length,
    auto: {
      mode: g.send_mode,
      every: g.send_every,
      at: g.send_at,
      day: g.send_day,
      soon: g.send_soon,
      coauthorEmails: g.coauthor_emails,
      sendAs: sender ?? null,
      paused: pausedOf(g, clashes.length),
      nextRunAt: g.next_run_at,
      lastSentAt: g.last_sent_at,
      lastError: g.last_error,
      waiting: sendable.filter((c) => c.unpushed).length,
      deletionsWaiting: g.send_mode === "publish" ? list.filter((c) => c.kind === "deleted" && !c.held).length : 0,
    },
  };
}

/** The base and current text of a changed note, for its diff (files: just whether they differ). */
export async function diff(vaultId: number, path: string) {
  const [base] = await sql`select content, repo_path from git_files where vault_id = ${vaultId} and path = ${path}`;
  const cur = await findByPath(vaultId, path);
  const [clash] = await sql`select theirs from git_clashes where vault_id = ${vaultId} and path = ${path}`;
  const [n] = cur ? await sql`select content from notes where id = ${cur.id}` : [];
  return { path, before: base?.content ?? null, after: n?.content ?? null, theirs: clash ? (clash.theirs as string | null) : undefined, note: isNotePath(path) };
}

// ── undoing changes ──────────────────────────────────────────────────────────────────────

async function revertOne(vaultId: number, user: User, g: VaultGit, c: Change, gh: () => Promise<GitHub>): Promise<void> {
  if (c.kind === "moved") {
    if (c.note) await renameNote(vaultId, c.noteId!, c.from!, user.id, false);
    else await sql`update attachments set path = ${c.from!} where vault_id = ${vaultId} and path = ${c.path}`;
  } else if (c.kind === "added") {
    if (c.note) await deleteNote(vaultId, c.noteId!, user.id); // to Trash: recoverable
    else await sql`delete from attachments where vault_id = ${vaultId} and path = ${c.path}`;
  } else {
    const [base] = await sql`select content, git_sha from git_files where vault_id = ${vaultId} and path = ${c.path}`;
    if (!base) return;
    if (c.note) {
      if (c.kind === "edited") await overwriteContent(c.noteId!, base.content, user.id, "github-revert");
      else await createNote(vaultId, user.id, c.path, base.content);
    } else {
      const data = await blob(await gh(), g.repo, base.git_sha);
      await sql`insert into attachments (vault_id, path, mime, size, data, created_by) values (${vaultId}, ${c.path}, ${mimeFor(c.path)}, ${data.byteLength}, ${data}, ${user.id})
                on conflict (vault_id, path) do update set data = excluded.data, size = excluded.size`;
    }
  }
  await sql`delete from git_clashes where vault_id = ${vaultId} and path in ${sql([c.path, ...(c.from ? [c.from] : [])])}`;
}

/** Put one note or file back as it is on GitHub. */
export async function revert(vaultId: number, user: User, path: string): Promise<Status> {
  const g = await gitRow(vaultId);
  const c = (await changes(vaultId, g)).find((x) => x.path === path || x.from === path);
  if (!c) throw new HttpError(404, "That's the same as on GitHub already");
  await revertOne(vaultId, user, g, c, () => clientFor(user.id));
  emit(vaultId, { type: "vault.changed" });
  return status(vaultId, user.id);
}

/** Every change back to the base, and the branch dropped (deleted on GitHub unless a PR is open). */
export async function cancel(vaultId: number, user: User): Promise<{ reverted: number; prKept: string | null }> {
  const g = await gitRow(vaultId);
  const list = await changes(vaultId, g);
  let client: GitHub | null = null;
  const gh = async () => (client ??= await clientFor(user.id));
  // Moves first, so a deleted path is free before anything is recreated there.
  for (const c of [...list.filter((x) => x.kind === "moved"), ...list.filter((x) => x.kind !== "moved")]) await revertOne(vaultId, user, g, c, gh);
  const prOpen = g.pr_number && g.pr_state === "open";
  if (g.head_sha && g.branch && !prOpen) {
    try {
      await (await gh()).req("DELETE", `${repoPath(g.repo)}/git/refs/heads/${enc(g.branch)}`);
    } catch {
      // already gone, or not ours to delete: the vault no longer uses it either way
    }
  }
  await sql`update vault_git set branch = null, head_sha = null, merge_sha = null, pr_number = null, pr_url = null, pr_state = null where vault_id = ${vaultId}`;
  await sql`delete from git_pushed where vault_id = ${vaultId}`;
  await sql`delete from git_clashes where vault_id = ${vaultId}`;
  emit(vaultId, { type: "vault.changed" });
  return { reverted: list.length, prKept: prOpen ? g.pr_url : null };
}

/** Name the branch before it's pushed. */
export async function renameBranch(vaultId: number, name: string): Promise<void> {
  const g = await gitRow(vaultId);
  if (g.head_sha) throw new HttpError(409, "The branch is on GitHub already; rename it there");
  await sql`update vault_git set branch = ${checkBranch(name)} where vault_id = ${vaultId}`;
}

// ── push and pull request ────────────────────────────────────────────────────────────────

/** Commit the changes onto the branch (creating it on the first push), then open the PR if
 *  there isn't one and a title was given. Held notes stay out, as does anything `send` refuses;
 *  whatever stays out keeps the version an earlier push put on the branch. */
export async function push(vaultId: number, user: User, opts: { message: string; title?: string; body?: string; branch?: string; send?: (c: Change) => boolean }): Promise<Status> {
  const g = await gitRow(vaultId);
  if (g.send_mode === "publish") throw new HttpError(409, `This collection publishes straight to ${g.base_branch}: use Send now`);
  const [{ n: clashCount }] = (await sql`select count(*)::int as n from git_clashes where vault_id = ${vaultId}`) as any;
  if (clashCount) throw new HttpError(409, `Settle the ${clashCount === 1 ? "clash" : `${clashCount} clashes`} in Review changes first`);
  if (g.pr_state === "merged") throw new HttpError(409, `Pull request #${g.pr_number} was merged: Update from ${g.base_branch} first, then your new changes go on a new branch`);
  const st = await status(vaultId, user.id);
  const gh = await clientFor(user.id);
  const repo = repoPath(g.repo);
  // Pushed, but the pull request didn't open (GitHub refused it): open it now, nothing to send.
  if (g.head_sha && !st.unpushed && !g.pr_number && opts.title?.trim()) {
    await openPr(vaultId, gh, repo, g.branch!, g.base_branch, opts);
    return status(vaultId, user.id);
  }
  const sent = st.changes.filter((c) => !c.held && (opts.send?.(c) ?? true));
  if (!g.head_sha && !sent.length) throw new HttpError(400, st.held ? `Nothing to send: ${st.held === 1 ? "the one change is" : `all ${st.held} changes are`} held back` : "Nothing has changed yet");
  if (g.head_sha && !st.unpushed) throw new HttpError(400, "Everything is on GitHub already");
  const message = opts.message.trim();
  if (!message) throw new HttpError(400, "Write a commit message");
  const branch = g.head_sha ? g.branch! : checkBranch(opts.branch ?? st.branch);

  const entries: TreeItem[] = [];
  const shas = new Map<string, string | null>(); // what each sent path now holds on the branch
  for (const c of sent) {
    if (c.kind === "moved") {
      const [old] = await sql`select repo_path, mode from git_files where vault_id = ${vaultId} and path = ${c.from!}`;
      if (old) entries.push({ path: old.repo_path, mode: old.mode, type: "blob", sha: null });
      shas.set(c.from!, null);
    }
    const e = await entryFor(vaultId, gh, repo, c);
    entries.push(e.item);
    shas.set(c.path, e.sha);
  }
  // Left out this time (held, or still being typed in): the branch keeps what an earlier push
  // put there, rather than going back to the base. Paths reverted since then go back unless held.
  const pushedRows = await sql<{ path: string; hash: string; sha: string | null }[]>`select path, hash, sha from git_pushed where vault_id = ${vaultId}`;
  const held = await heldPaths(vaultId);
  const changed = new Map(st.changes.map((c) => [c.path, c]));
  const keep = pushedRows.filter((r) => !shas.has(r.path) && (changed.has(r.path) || st.changes.some((c) => c.from === r.path) || held.has(r.path)));
  // Rows from before blob shas were recorded (v0.0.45) have none: read what the branch holds now,
  // or the note would quietly go back to the base version on the branch.
  let onBranch: Map<string, string> | null = null;
  for (const r of keep) {
    const rp = changed.get(r.path)?.repoPath ?? (await repoPathOf(vaultId, g, r.path));
    if (r.hash === "") {
      entries.push({ path: rp, mode: "100644", type: "blob", sha: null });
      continue;
    }
    if (!r.sha && g.head_sha) {
      onBranch ??= new Map((await treeAt(gh, g.repo, (await branchHead(gh, g.repo, g.branch!)).tree)).map((e) => [e.path, e.sha]));
      r.sha = onBranch.get(rp) ?? null;
    }
    if (r.sha) entries.push({ path: rp, mode: changed.get(r.path)?.mode ?? "100644", type: "blob", sha: r.sha });
  }
  const tree = entries.length ? (await gh.post<{ sha: string }>(`${repo}/git/trees`, { base_tree: g.base_tree, tree: entries })).sha : g.base_tree;
  const parents = g.head_sha ? [g.head_sha, ...(g.merge_sha ? [g.merge_sha] : [])] : [g.base_sha];
  const commit = await gh.post<{ sha: string }>(`${repo}/git/commits`, { message, tree, parents });
  if (!g.head_sha) {
    try {
      await gh.post(`${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) throw new HttpError(409, `There's already a branch called ${branch} on GitHub: choose another name`);
      throw err;
    }
  } else {
    try {
      await gh.req("PATCH", `${repo}/git/refs/heads/${enc(branch)}`, { sha: commit.sha, force: false });
    } catch (err) {
      if (err instanceof HttpError && err.status === 409) throw new HttpError(409, `${branch} has changed on GitHub since the last push from here, so this push would overwrite it. Merge or close the pull request there, then Cancel the branch here and start again.`);
      throw err;
    }
  }
  // The branch is on GitHub now: record that before asking for the pull request, so a refused
  // PR leaves a vault that knows its branch (and can try the PR again), not one that tries to
  // create the branch a second time.
  await sql.begin(async (tx) => {
    await tx`update vault_git set branch = ${branch}, head_sha = ${commit.sha}, merge_sha = null, last_sent_at = now() where vault_id = ${vaultId}`;
    await tx`delete from git_pushed where vault_id = ${vaultId}`;
    const snap = [
      ...keep.map((r) => ({ vault_id: vaultId, path: r.path, hash: r.hash, sha: r.sha })),
      ...sent.map((c) => ({ vault_id: vaultId, path: c.path, hash: c.hash, sha: shas.get(c.path) ?? null })),
      ...sent.filter((c) => c.from).map((c) => ({ vault_id: vaultId, path: c.from!, hash: "", sha: null })),
    ];
    if (snap.length) await tx`insert into git_pushed ${tx(snap)} on conflict do nothing`;
  });
  if (!g.pr_number && opts.title?.trim()) await openPr(vaultId, gh, repo, branch, g.base_branch, opts);
  return status(vaultId, user.id);
}

type TreeItem = { path: string; mode: string; type: "blob"; sha?: string | null; content?: string };

/** git's own id for a blob, so a note's pushed version is known without asking GitHub. */
const blobSha = (data: string | Uint8Array) => {
  const bytes = typeof data === "string" ? new TextEncoder().encode(data) : data;
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
};

/** The tree entry that puts a change on a branch, and the blob it leaves there (null: deleted). */
async function entryFor(vaultId: number, gh: GitHub, repo: string, c: Change): Promise<{ item: TreeItem; sha: string | null; content?: string }> {
  if (c.kind === "deleted") return { item: { path: c.repoPath, mode: c.mode, type: "blob", sha: null }, sha: null };
  if (c.note) {
    const [n] = await sql`select content from notes where id = ${c.noteId}`;
    return { item: { path: c.repoPath, mode: c.mode, type: "blob", content: n!.content }, sha: blobSha(n!.content), content: n!.content };
  }
  const [a] = await sql`select data from attachments where vault_id = ${vaultId} and path = ${c.path}`;
  const b = await gh.post<{ sha: string }>(`${repo}/git/blobs`, { content: Buffer.from(a!.data).toString("base64"), encoding: "base64" });
  return { item: { path: c.repoPath, mode: c.mode, type: "blob", sha: b.sha }, sha: b.sha };
}

async function repoPathOf(vaultId: number, g: VaultGit, path: string): Promise<string> {
  const [f] = await sql`select repo_path from git_files where vault_id = ${vaultId} and path = ${path}`;
  return f?.repo_path ?? prefixOf(g.folder) + path;
}

/** Publish straight to the base branch (F19): one commit on its head, no pull request. What's
 *  sent becomes the new base here, so it no longer shows as a change. */
export async function publish(vaultId: number, user: User, opts: { message: string; send: (c: Change) => boolean }): Promise<Status> {
  const g = await gitRow(vaultId);
  if (g.head_sha) throw new HttpError(409, `Finish or cancel the branch ${g.branch} first`);
  const [{ n: clashCount }] = (await sql`select count(*)::int as n from git_clashes where vault_id = ${vaultId}`) as any;
  if (clashCount) throw new HttpError(409, `Settle the ${clashCount === 1 ? "clash" : `${clashCount} clashes`} in Review changes first`);
  const list = await changes(vaultId, g);
  const sent = list.filter((c) => !c.held && opts.send(c));
  if (!sent.length) return status(vaultId, user.id);
  const gh = await clientFor(user.id);
  const repo = repoPath(g.repo);
  const entries: TreeItem[] = [];
  const done: { c: Change; sha: string | null; content?: string }[] = [];
  for (const c of sent) {
    if (c.kind === "moved") {
      const [old] = await sql`select repo_path, mode from git_files where vault_id = ${vaultId} and path = ${c.from!}`;
      if (old) entries.push({ path: old.repo_path, mode: old.mode, type: "blob", sha: null });
    }
    const e = await entryFor(vaultId, gh, repo, c);
    entries.push(e.item);
    done.push({ c, sha: e.sha, content: e.content });
  }
  const tree = (await gh.post<{ sha: string }>(`${repo}/git/trees`, { base_tree: g.base_tree, tree: entries })).sha;
  const commit = await gh.post<{ sha: string }>(`${repo}/git/commits`, { message: opts.message.trim() || "Update notes", tree, parents: [g.base_sha] });
  try {
    await gh.req("PATCH", `${repo}/git/refs/heads/${enc(g.base_branch)}`, { sha: commit.sha, force: false });
  } catch (err) {
    // Moved on since the last update: the next run updates first and tries again. Never forced.
    if (err instanceof HttpError && err.status === 409 && /fast.?forward/i.test(err.message)) throw new HttpError(409, `${g.base_branch} changed on GitHub meanwhile; the next try brings that in first`);
    throw err;
  }
  await sql.begin(async (tx) => {
    for (const { c, sha, content } of done) {
      if (c.from) await tx`delete from git_files where vault_id = ${vaultId} and path = ${c.from}`;
      if (c.kind === "deleted") await tx`delete from git_files where vault_id = ${vaultId} and path = ${c.path}`;
      else
        await tx`insert into git_files (vault_id, path, repo_path, git_sha, mode, hash, content) values (${vaultId}, ${c.path}, ${c.repoPath}, ${sha!}, ${c.mode}, ${content === undefined ? c.hash : md5(content)}, ${content ?? null})
                 on conflict (vault_id, path) do update set repo_path = excluded.repo_path, git_sha = excluded.git_sha, mode = excluded.mode, hash = excluded.hash, content = excluded.content`;
    }
    await tx`update vault_git set base_sha = ${commit.sha}, base_tree = ${tree}, last_sent_at = now() where vault_id = ${vaultId}`;
  });
  emit(vaultId, { type: "vault.changed" });
  return status(vaultId, user.id);
}

async function openPr(vaultId: number, gh: GitHub, repo: string, branch: string, base: string, opts: { title?: string; body?: string }): Promise<void> {
  let p: { number: number; html_url: string; state: string };
  try {
    p = await gh.post(`${repo}/pulls`, { title: opts.title!.trim(), body: opts.body ?? "", head: branch, base });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    throw new HttpError(err instanceof HttpError ? err.status : 502, `Your changes are on GitHub, on branch ${branch}, but the pull request didn't open. ${why} Press Open pull request to try again.`);
  }
  await sql`update vault_git set pr_number = ${p.number}, pr_url = ${p.html_url}, pr_state = ${p.state}, pr_checked_at = now() where vault_id = ${vaultId}`;
}

// ── update from the base branch ──────────────────────────────────────────────────────────

export interface UpdateReport {
  upToDate: boolean;
  updated: number;
  merged: number;
  added: number;
  removed: number;
  clashes: number;
  /** Changed here and deleted or changed there (files), so kept as they are here. */
  kept: number;
}

export async function update(vaultId: number, user: User): Promise<UpdateReport> {
  const g = await gitRow(vaultId);
  const gh = await clientFor(user.id);
  const report: UpdateReport = { upToDate: false, updated: 0, merged: 0, added: 0, removed: 0, clashes: 0, kept: 0 };
  // A merged PR means the branch is done with, whatever else happened.
  let prState = g.pr_state;
  if (g.pr_number && prState === "open") {
    const pr = await gh.get(`${repoPath(g.repo)}/pulls/${g.pr_number}`);
    prState = pr.merged ? "merged" : pr.state;
  }
  const head = await branchHead(gh, g.repo, g.base_branch);
  if (head.sha === g.base_sha) {
    if (prState !== g.pr_state) await sql`update vault_git set pr_state = ${prState}, pr_checked_at = now() where vault_id = ${vaultId}`;
    return { ...report, upToDate: true };
  }
  const prefix = prefixOf(g.folder);
  const theirs = new Map(wanted(await treeAt(gh, g.repo, head.tree), g.folder).map((e) => [e.path, e]));
  const ours = new Map((await sql`select * from git_files where vault_id = ${vaultId}`).map((f) => [f.repo_path as string, f]));

  // What our pushes put on the branch: once that PR is merged, the base holds exactly this, so
  // edits made here since then win outright rather than clashing with themselves.
  const pushed = new Map((await sql`select path, hash, sha from git_pushed where vault_id = ${vaultId}`).map((r) => [r.path as string, r as { hash: string; sha: string | null }]));
  const clash = (path: string, text: string | null) =>
    sql`insert into git_clashes (vault_id, path, theirs) values (${vaultId}, ${path}, ${text}) on conflict (vault_id, path) do update set theirs = excluded.theirs, created_at = now()`;

  for (const [rp, e] of theirs) {
    const f = ours.get(rp);
    if (f && f.git_sha === e.sha) continue;
    const vp = f?.path ?? vaultPathFor(rp.slice(prefix.length));
    if (!vp) continue;
    if ((e.size ?? 0) > (isNotePath(rp) ? MAX_NOTE : MAX_FILE)) continue;
    if (!isNotePath(rp)) await assertRoom(e.size ?? 0); // notes are checked as they're written
    const data = await blob(gh, g.repo, e.sha);
    if (isNotePath(rp)) {
      const text = asText(data);
      const local = await findByPath(vaultId, vp);
      if (!local) {
        if (f) {
          // Deleted here, changed there.
          await clash(vp, text);
          report.clashes++;
        } else {
          await createNote(vaultId, user.id, vp, text);
          report.added++;
        }
      } else {
        const [n] = await sql`select content from notes where id = ${local.id}`;
        const mine = n!.content as string;
        const p = pushed.get(vp);
        const ourPush = !!p && p.hash !== "" && (p.sha === e.sha || p.hash === md5(text));
        const r = ourPush ? { clean: true, text: mine } : merge3(f?.content ?? (mine === text ? text : ""), mine, text);
        if (!r.clean) {
          await clash(vp, text);
          report.clashes++;
        } else if (r.text !== mine) {
          await overwriteContent(local.id, r.text, user.id, "github");
          if (f && md5(mine) === f.hash) report.updated++;
          else report.merged++;
        }
      }
      await sql`insert into git_files (vault_id, path, repo_path, git_sha, mode, hash, content) values (${vaultId}, ${vp}, ${rp}, ${e.sha}, ${e.mode}, ${md5(text)}, ${text})
                on conflict (vault_id, path) do update set repo_path = excluded.repo_path, git_sha = excluded.git_sha, mode = excluded.mode, hash = excluded.hash, content = excluded.content`;
    } else {
      const [local] = await sql`select md5(data) as hash from attachments where vault_id = ${vaultId} and path = ${vp}`;
      if (!local ? !f : !f || local.hash === f.hash) {
        await sql`insert into attachments (vault_id, path, mime, size, data, created_by) values (${vaultId}, ${vp}, ${mimeFor(vp)}, ${data.byteLength}, ${data}, ${user.id})
                  on conflict (vault_id, path) do update set data = excluded.data, size = excluded.size`;
        if (local) report.updated++;
        else report.added++;
      } else report.kept++;
      await sql`insert into git_files (vault_id, path, repo_path, git_sha, mode, hash) values (${vaultId}, ${vp}, ${rp}, ${e.sha}, ${e.mode}, ${md5(data)})
                on conflict (vault_id, path) do update set repo_path = excluded.repo_path, git_sha = excluded.git_sha, mode = excluded.mode, hash = excluded.hash, content = null`;
    }
  }
  // Deleted there: gone here too, unless changed here (then it stays, as an added note).
  for (const [rp, f] of ours) {
    if (theirs.has(rp)) continue;
    if (f.content !== null) {
      const local = await findByPath(vaultId, f.path);
      const [n] = local ? await sql`select content from notes where id = ${local.id}` : [];
      if (local && md5(n!.content) === f.hash) {
        await deleteNote(vaultId, local.id, user.id);
        report.removed++;
      } else if (local) report.kept++;
    } else {
      const [a] = await sql`select md5(data) as hash from attachments where vault_id = ${vaultId} and path = ${f.path}`;
      if (a && a.hash === f.hash) {
        await sql`delete from attachments where vault_id = ${vaultId} and path = ${f.path}`;
        report.removed++;
      } else if (a) report.kept++;
    }
    await sql`delete from git_files where vault_id = ${vaultId} and path = ${f.path}`;
  }

  const done = prState === "merged" || prState === "closed" || !g.head_sha;
  await sql`update vault_git set base_sha = ${head.sha}, base_tree = ${head.tree}, pr_state = ${prState}, pr_checked_at = now(),
              merge_sha = ${done ? null : head.sha}
            where vault_id = ${vaultId}`;
  if (done && g.head_sha) {
    await sql`update vault_git set branch = null, head_sha = null, pr_number = null, pr_url = null, pr_state = null where vault_id = ${vaultId}`;
    await sql`delete from git_pushed where vault_id = ${vaultId}`;
  }
  emit(vaultId, { type: "vault.changed" });
  return report;
}

/** Settle a clash: keep the note as it is here, or take GitHub's version. */
export async function resolve(vaultId: number, user: User, path: string, take: "mine" | "theirs"): Promise<Status> {
  const [c] = await sql`select theirs from git_clashes where vault_id = ${vaultId} and path = ${path}`;
  if (!c) throw new HttpError(404, "That clash is settled already");
  if (take === "theirs") {
    const local = await findByPath(vaultId, path);
    if (c.theirs === null) {
      if (local) await deleteNote(vaultId, local.id, user.id);
    } else if (local) await overwriteContent(local.id, c.theirs, user.id, "github");
    else await createNote(vaultId, user.id, path, c.theirs);
  }
  await sql`delete from git_clashes where vault_id = ${vaultId} and path = ${path}`;
  emit(vaultId, { type: "vault.changed" });
  return status(vaultId, user.id);
}
