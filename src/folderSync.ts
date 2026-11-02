// Folder vaults on the Mac (F22): a vault kept in step with a folder of Markdown under
// FOLDERS_ROOT (the laptop kit mounts the person's COMMONPLACE_FOLDERS there). Edits made in the
// folder by any editor come in; edits made here go out to the files.
//
//   base      folder_files: each file as both sides last agreed (its md5 on disk and as stored
//             here, and a note's text for merges). A side whose hash differs from the base has
//             changed; a file deleted on one side and added under another name with the same
//             hash is a move.
//   in        changed in the folder only: created, overwritten (through overwriteContent, so
//             open editors update live), renamed, or to Trash.
//   out       changed here only: written to a temp file then renamed into place; deleted notes
//             go to the folder's .trash/, never removed.
//   both      merged line by line (src/merge3.ts); if that fails, 'folder' mode takes the
//             folder's text (this side's survives in the note's history) and 'both' mode holds
//             the note in folder_clashes until someone picks a side. Never conflict markers.
//   when      file events (a hint: a Docker mount doesn't always pass them on), the vault's own
//             events, and a rescan every FOLDER_SCAN_MS. One pass at a time per vault.
//
// Safety: only files under the vault's root are touched; symlinks, dot-folders (.obsidian,
// .trash) and node_modules are skipped; a root that vanishes or turns up empty pauses the vault
// instead of sending everything to Trash.

import { existsSync, type FSWatcher, watch } from "node:fs";
import { access, constants, mkdir, readdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join } from "node:path";
import { HttpError, type User } from "./auth";
import { flushNote, kick } from "./collab";
import { sql } from "./db";
import { emit, subscribe } from "./events";
import { normalisePath } from "./markdown";
import { merge3 } from "./merge3";
import { createNote, deleteNote as trashNote, overwriteContent, renameNote } from "./notes";
import { settings } from "./settings";
import { assertRoom, MAX_NOTE_BYTES } from "./storage";
import { asText, importable, isNotePath, md5, vaultPathFor } from "./syncCore";
import { MAX_FILE_BYTES, mimeFor } from "./transfer";
import { requireRole } from "./vaults";

export type FolderMode = "folder" | "both";

interface Link {
  vault_id: number;
  root: string;
  mode: FolderMode;
  created_by: number | null;
  paused_at: Date | null;
  paused_why: string | null;
  last_sync: Date | null;
  last_error: string | null;
}

interface Base {
  path: string;
  rel: string;
  disk_hash: string;
  db_hash: string;
  mtime: number;
  size: number;
  content: string | null;
}

interface OnDisk {
  path: string;
  rel: string;
  mtime: number;
  size: number;
}

interface Here {
  path: string;
  hash: string;
  noteId: number | null;
}

// ── where folders live ───────────────────────────────────────────────────────────────────────

let usable: boolean | null = null;
/** Folder vaults are offered only where FOLDERS_ROOT is set and writable (the laptop kit). */
export async function available(): Promise<boolean> {
  if (usable !== null) return usable;
  if (!settings.foldersRoot) return (usable = false);
  try {
    await access(settings.foldersRoot, constants.R_OK | constants.W_OK);
    usable = (await stat(settings.foldersRoot)).isDirectory();
  } catch {
    usable = false;
  }
  return usable;
}

/** "Work/Notes" from what someone typed; never empty, never outside FOLDERS_ROOT. */
export function cleanRoot(raw: string): string {
  const r = raw.trim().replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!r) throw new HttpError(400, "Choose a folder");
  if (r.split("/").some((s) => s === ".." || s === "." || s.startsWith("."))) throw new HttpError(400, "That folder can't be used");
  return r;
}

/** The real path of a vault's folder, which must sit inside FOLDERS_ROOT (symlinks resolved). */
async function dirOf(root: string): Promise<string> {
  const top = await realpath(settings.foldersRoot);
  let dir: string;
  try {
    dir = await realpath(join(top, root));
  } catch {
    throw new HttpError(404, `The folder ${label(root)} isn't there`);
  }
  if (!dir.startsWith(top + "/")) throw new HttpError(400, "That folder can't be used");
  if (!(await stat(dir)).isDirectory()) throw new HttpError(400, `${label(root)} isn't a folder`);
  return dir;
}

export const label = (root: string) => `${settings.foldersLabel.replace(/\/+$/, "")}/${root}`;

/** Folders under FOLDERS_ROOT, two levels deep, for the picker; those in use are marked. */
export async function listFolders(): Promise<{ root: string; label: string; vaultId: number | null }[]> {
  if (!(await available())) return [];
  const used = new Map((await sql`select root, vault_id from vault_folder`).map((r) => [r.root as string, Number(r.vault_id)]));
  const out: { root: string; label: string; vaultId: number | null }[] = [];
  const walk = async (rel: string, depth: number) => {
    let entries;
    try {
      entries = await readdir(join(settings.foldersRoot, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      out.push({ root: r, label: label(r), vaultId: used.get(r) ?? null });
      if (depth < 2) await walk(r, depth + 1);
    }
  };
  await walk("", 1);
  return out;
}

// ── reading both sides ───────────────────────────────────────────────────────────────────────

const key = (p: string) => p.toLowerCase();

/** Every note and attachment file under `dir`, by vault path (lower-cased). */
async function scanDisk(dir: string): Promise<Map<string, OnDisk>> {
  const out = new Map<string, OnDisk>();
  const walk = async (rel: string) => {
    for (const e of await readdir(rel ? join(dir, rel) : dir, { withFileTypes: true })) {
      if (e.name.startsWith(".") || e.name === "node_modules" || e.isSymbolicLink()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) await walk(r);
      else if (e.isFile() && importable(r)) {
        const vp = vaultPathFor(r);
        if (!vp) continue;
        const st = await stat(join(dir, r));
        out.set(key(vp), { path: vp, rel: r, mtime: st.mtimeMs, size: st.size });
      }
    }
  };
  await walk("");
  return out;
}

async function scanHere(vaultId: number): Promise<Map<string, Here>> {
  const rows = await sql`
    select path, md5(content) as hash, id as note_id from notes where vault_id = ${vaultId}
    union all
    select path, md5(data), null from attachments where vault_id = ${vaultId}`;
  return new Map(rows.map((r) => [key(r.path), { path: r.path, hash: r.hash, noteId: r.note_id === null ? null : Number(r.note_id) }]));
}

async function bases(vaultId: number): Promise<Map<string, Base>> {
  const rows = await sql<Base[]>`select path, rel, disk_hash, db_hash, mtime, size, content from folder_files where vault_id = ${vaultId}`;
  return new Map(rows.map((r) => [key(r.path), { ...r, mtime: Number(r.mtime), size: Number(r.size) }]));
}

async function saveBase(vaultId: number, b: Base) {
  await sql`delete from folder_files where vault_id = ${vaultId} and lower(path) = lower(${b.path})`;
  await sql`insert into folder_files (vault_id, path, rel, disk_hash, db_hash, mtime, size, content)
            values (${vaultId}, ${b.path}, ${b.rel}, ${b.disk_hash}, ${b.db_hash}, ${b.mtime}, ${b.size}, ${b.content})`;
}
const dropBase = (vaultId: number, path: string) => sql`delete from folder_files where vault_id = ${vaultId} and lower(path) = lower(${path})`;

// ── writing to the folder ────────────────────────────────────────────────────────────────────

/** A path under `dir`, refusing anything that would leave it. */
function inside(dir: string, rel: string): string {
  const full = join(dir, rel);
  if (!full.startsWith(dir + "/")) throw new Error(`refusing to write outside the folder: ${rel}`);
  return full;
}

/** Write a file whole: to a hidden temp file beside it, then renamed into place, so an editor
 *  watching the folder never reads half a file. Returns what the base records. */
async function writeFileAtomic(dir: string, rel: string, bytes: Uint8Array): Promise<{ mtime: number; size: number }> {
  const full = inside(dir, rel);
  await mkdir(dirname(full), { recursive: true });
  const tmp = join(dirname(full), `.${basename(full)}.cp-${process.pid}-${Date.now()}`);
  await writeFile(tmp, bytes);
  await rename(tmp, full);
  const st = await stat(full);
  return { mtime: st.mtimeMs, size: st.size };
}

/** A file deleted here goes to the folder's .trash/ (skipped by scans), never removed. */
async function trashFile(dir: string, rel: string): Promise<void> {
  const from = inside(dir, rel);
  if (!existsSync(from)) return;
  let to = inside(dir, `.trash/${rel}`);
  if (existsSync(to)) {
    const ext = extname(to);
    to = `${to.slice(0, to.length - ext.length)} ${Date.now()}${ext}`;
  }
  await mkdir(dirname(to), { recursive: true });
  await rename(from, to);
}

async function moveFile(dir: string, fromRel: string, toRel: string): Promise<{ mtime: number; size: number }> {
  const to = inside(dir, toRel);
  await mkdir(dirname(to), { recursive: true });
  await rename(inside(dir, fromRel), to);
  const st = await stat(to);
  return { mtime: st.mtimeMs, size: st.size };
}

// ── writing here ─────────────────────────────────────────────────────────────────────────────

async function toTrash(vaultId: number, noteId: number, actor: number) {
  kick({ noteId }, "note deleted");
  await flushNote(noteId);
  await trashNote(vaultId, noteId, actor);
}

/** Into the note, then saved at once: with an editor open the text lands in its live room, and
 *  the next pass must see it in the database, not the room's older save. */
async function overwriteNow(noteId: number, text: string, actor: number) {
  await overwriteContent(noteId, text, actor, "folder");
  await flushNote(noteId);
}

async function putFile(vaultId: number, path: string, data: Uint8Array, actor: number) {
  await assertRoom(data.byteLength);
  await sql`insert into attachments (vault_id, path, mime, size, data, created_by) values (${vaultId}, ${path}, ${mimeFor(path)}, ${data.byteLength}, ${data}, ${actor})
            on conflict (vault_id, path) do update set data = excluded.data, size = excluded.size`;
}

/** The person changes are made as: whoever linked the folder, or else an owner. */
async function actorFor(link: Link): Promise<number> {
  if (link.created_by) return Number(link.created_by);
  const [o] = await sql`select user_id from vault_members where vault_id = ${link.vault_id} and role = 'owner' order by user_id limit 1`;
  if (!o) throw new Error("no owner");
  return Number(o.user_id);
}

// ── one pass ─────────────────────────────────────────────────────────────────────────────────

export interface SyncReport {
  in: number;
  out: number;
  merged: number;
  clashes: number;
  skipped: string[];
}

class Paused extends Error {}

/** Bring the vault and its folder into step. `rebuild` ('folder' mode): the folder is the whole
 *  truth, so notes here that aren't in it go to Trash and every note takes the folder's text. */
async function syncOnce(link: Link, opts: { rebuild?: boolean } = {}): Promise<SyncReport> {
  const vaultId = link.vault_id;
  const report: SyncReport = { in: 0, out: 0, merged: 0, clashes: 0, skipped: [] };
  let dir: string;
  try {
    dir = await dirOf(link.root);
  } catch {
    throw new Paused(`the folder ${label(link.root)} isn't there`);
  }
  const actor = await actorFor(link);
  if (opts.rebuild) await sql`delete from folder_files where vault_id = ${vaultId}`;
  const base = await bases(vaultId);
  const disk = await scanDisk(dir);
  if (disk.size === 0 && base.size > 0) throw new Paused(`the folder ${label(link.root)} is empty`);

  // Notes with unsaved typing in an open editor are saved first, so the comparison sees it.
  const diskHash = new Map<string, string>();
  const diskBytes = new Map<string, Uint8Array>();
  for (const [k, d] of disk) {
    const b = base.get(k);
    if (b && b.rel === d.rel && b.mtime === d.mtime && b.size === d.size) {
      diskHash.set(k, b.disk_hash);
      continue;
    }
    if (d.size > (isNotePath(d.rel) ? MAX_NOTE_BYTES : MAX_FILE_BYTES)) {
      report.skipped.push(d.rel);
      disk.delete(k);
      continue;
    }
    const bytes = new Uint8Array(await readFile(join(dir, d.rel)));
    diskBytes.set(k, bytes);
    diskHash.set(k, md5(bytes));
  }
  const readDisk = async (k: string) => diskBytes.get(k) ?? new Uint8Array(await readFile(join(dir, disk.get(k)!.rel)));

  let here = await scanHere(vaultId);
  const changedOnDisk = [...new Set([...disk.keys(), ...base.keys()])].filter((k) => diskHash.get(k) !== base.get(k)?.disk_hash);
  for (const k of changedOnDisk) {
    const id = here.get(k)?.noteId;
    if (id) await flushNote(id);
  }
  if (changedOnDisk.length) here = await scanHere(vaultId);

  const clashes = new Set((await sql`select lower(path) as k from folder_clashes where vault_id = ${vaultId}`).map((r) => r.k as string));
  const keys = new Set([...disk.keys(), ...here.keys(), ...base.keys()]);
  const dChanged = (k: string) => diskHash.get(k) !== base.get(k)?.disk_hash;
  const hChanged = (k: string) => here.get(k)?.hash !== base.get(k)?.db_hash;
  const done = new Set<string>();

  // Moves: gone from one place and the same bytes under a new name, on one side only.
  for (const k of keys) {
    const b = base.get(k);
    if (!b || clashes.has(k)) continue;
    const note = b.content !== null;
    if (!disk.has(k) && here.has(k) && !hChanged(k)) {
      const to = [...keys].find((t) => !done.has(t) && !base.has(t) && !here.has(t) && disk.has(t) && diskHash.get(t) === b.disk_hash && isNotePath(disk.get(t)!.rel) === note);
      if (!to) continue;
      const d = disk.get(to)!;
      const h = here.get(k)!;
      try {
        if (note) await renameNote(vaultId, h.noteId!, d.path, actor, false);
        else await sql`update attachments set path = ${d.path} where vault_id = ${vaultId} and path = ${h.path}`;
      } catch {
        continue; // the new name is taken here: handled below as a deletion and an addition
      }
      await dropBase(vaultId, b.path);
      await saveBase(vaultId, { ...b, path: d.path, rel: d.rel, mtime: d.mtime, size: d.size });
      done.add(k).add(to);
      report.in++;
    } else if (!here.has(k) && disk.has(k) && !dChanged(k)) {
      const to = [...keys].find((t) => !done.has(t) && !base.has(t) && !disk.has(t) && here.has(t) && here.get(t)!.hash === b.db_hash && (here.get(t)!.noteId !== null) === note);
      if (!to) continue;
      const h = here.get(to)!;
      const rel = h.path;
      const st = await moveFile(dir, b.rel, rel);
      await dropBase(vaultId, b.path);
      await saveBase(vaultId, { ...b, path: h.path, rel, ...st });
      done.add(k).add(to);
      report.out++;
    }
  }

  const takeFolder = async (k: string) => {
    const d = disk.get(k);
    const h = here.get(k);
    if (!d) {
      if (h?.noteId) await toTrash(vaultId, h.noteId, actor);
      else if (h) await sql`delete from attachments where vault_id = ${vaultId} and path = ${h.path}`;
      const b = base.get(k);
      if (b) await dropBase(vaultId, b.path);
      return;
    }
    const bytes = await readDisk(k);
    const isNote = isNotePath(d.rel);
    const text = isNote ? asText(bytes) : null;
    if (isNote) {
      if (h?.noteId) await overwriteNow(h.noteId, text!, actor);
      else await createNote(vaultId, actor, d.path, text!);
    } else await putFile(vaultId, h?.path ?? d.path, bytes, actor);
    await saveBase(vaultId, { path: h?.path ?? d.path, rel: d.rel, disk_hash: diskHash.get(k)!, db_hash: md5(text ?? bytes), mtime: d.mtime, size: d.size, content: text });
  };

  const takeHere = async (k: string) => {
    const h = here.get(k);
    const b = base.get(k);
    if (!h) {
      const rel = disk.get(k)?.rel ?? b?.rel;
      if (rel) await trashFile(dir, rel);
      if (b) await dropBase(vaultId, b.path);
      return;
    }
    const rel = disk.get(k)?.rel ?? (b && key(b.path) === k ? b.rel : h.path);
    if (h.noteId !== null) {
      const [n] = await sql`select content from notes where id = ${h.noteId}`;
      const text = String(n!.content);
      const bytes = new TextEncoder().encode(text);
      const st = await writeFileAtomic(dir, rel, bytes);
      await saveBase(vaultId, { path: h.path, rel, disk_hash: md5(bytes), db_hash: md5(text), ...st, content: text });
    } else {
      const [a] = await sql`select data from attachments where vault_id = ${vaultId} and path = ${h.path}`;
      const bytes = new Uint8Array(a!.data);
      const st = await writeFileAtomic(dir, rel, bytes);
      await saveBase(vaultId, { path: h.path, rel, disk_hash: md5(bytes), db_hash: md5(bytes), ...st, content: null });
    }
  };

  for (const k of keys) {
    if (done.has(k) || clashes.has(k)) continue;
    const d = dChanged(k);
    const h = hChanged(k);
    if (!d && !h) continue;
    try {
      if (opts.rebuild) {
        if (disk.has(k)) await takeFolder(k);
        else if (here.get(k)?.noteId) await toTrash(vaultId, here.get(k)!.noteId!, actor);
        report.in++;
      } else if (d && !h) {
        await takeFolder(k);
        report.in++;
      } else if (h && !d) {
        await takeHere(k);
        report.out++;
      } else {
        // Changed on both sides (or new on both, with no base yet).
        const onDisk = disk.get(k);
        const mine = here.get(k);
        if (!onDisk && !mine) {
          await dropBase(vaultId, base.get(k)!.path);
          continue;
        }
        const isNote = onDisk ? isNotePath(onDisk.rel) : mine!.noteId !== null;
        const theirs = onDisk && isNote ? asText(await readDisk(k)) : null;
        if (onDisk && mine && (isNote ? md5(theirs!) === mine.hash : diskHash.get(k) === mine.hash)) {
          // Both sides arrived at the same thing.
          await saveBase(vaultId, { path: mine.path, rel: onDisk.rel, disk_hash: diskHash.get(k)!, db_hash: mine.hash, mtime: onDisk.mtime, size: onDisk.size, content: theirs });
          continue;
        }
        if (onDisk && mine && isNote) {
          const [n] = await sql`select content from notes where id = ${mine.noteId}`;
          const ours = String(n!.content);
          const m = merge3(base.get(k)?.content ?? "", ours, theirs!);
          if (m.clean) {
            if (m.text !== ours) await overwriteNow(mine.noteId!, m.text, actor);
            const bytes = new TextEncoder().encode(m.text);
            const st = m.text !== theirs ? await writeFileAtomic(dir, onDisk.rel, bytes) : { mtime: onDisk.mtime, size: onDisk.size };
            await saveBase(vaultId, { path: mine.path, rel: onDisk.rel, disk_hash: m.text !== theirs ? md5(bytes) : diskHash.get(k)!, db_hash: md5(m.text), ...st, content: m.text });
            report.merged++;
            continue;
          }
        }
        if (link.mode === "folder" || !isNote) {
          await takeFolder(k);
          report.in++;
        } else {
          await sql`insert into folder_clashes (vault_id, path, theirs) values (${vaultId}, ${mine?.path ?? onDisk!.path}, ${theirs})
                    on conflict (vault_id, path) do update set theirs = excluded.theirs, created_at = now()`;
          report.clashes++;
        }
      }
    } catch (err) {
      if (err instanceof HttpError && (err.status === 413 || err.status === 409 || err.status === 400)) report.skipped.push(disk.get(k)?.rel ?? k);
      else throw err;
    }
  }
  if (report.in || report.merged) emit(vaultId, { type: "vault.changed" });
  return report;
}

// ── one pass at a time per vault ─────────────────────────────────────────────────────────────

const running = new Map<number, Promise<SyncReport | null>>();

async function linkOf(vaultId: number): Promise<Link | null> {
  const [l] = await sql<Link[]>`select * from vault_folder where vault_id = ${vaultId}`;
  return l ? { ...l, vault_id: Number(l.vault_id) } : null;
}

/** Run a pass for the vault, after any already running. Null if it isn't linked or is paused. */
export function syncNow(vaultId: number, opts: { rebuild?: boolean; force?: boolean } = {}): Promise<SyncReport | null> {
  const prev = running.get(vaultId) ?? Promise.resolve(null);
  const next = prev
    .catch(() => null)
    .then(async () => {
      const link = await linkOf(vaultId);
      if (!link || (link.paused_at && !opts.force)) return null;
      try {
        const r = await syncOnce(link, opts);
        await sql`update vault_folder set last_sync = now(), last_error = null, paused_at = case when ${!!opts.force} then null else paused_at end, paused_why = case when ${!!opts.force} then null else paused_why end where vault_id = ${vaultId}`;
        return r;
      } catch (err) {
        if (err instanceof Paused) {
          await sql`update vault_folder set paused_at = now(), paused_why = ${err.message} where vault_id = ${vaultId}`;
          emit(vaultId, { type: "vault.changed" });
          return null;
        }
        console.error(`folder sync for vault ${vaultId} failed:`, err);
        await sql`update vault_folder set last_error = ${String((err as Error).message ?? err).slice(0, 500)} where vault_id = ${vaultId}`;
        return null;
      }
    });
  running.set(vaultId, next);
  void next.finally(() => running.get(vaultId) === next && running.delete(vaultId));
  return next;
}

// ── watching ─────────────────────────────────────────────────────────────────────────────────

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const watchers = new Map<number, { fs: FSWatcher | null; off: () => void }>();

function soon(vaultId: number, ms: number) {
  clearTimeout(timers.get(vaultId));
  timers.set(vaultId, setTimeout(() => {
    timers.delete(vaultId);
    void syncNow(vaultId);
  }, ms));
}

async function startWatching(link: Link) {
  stopWatching(link.vault_id);
  let fsw: FSWatcher | null = null;
  try {
    const dir = await dirOf(link.root);
    fsw = watch(dir, { recursive: true }, (_e, name) => {
      // Our own temp files, and anything in a dot-folder, aren't news.
      if (name && String(name).split(/[\\/]/).some((s) => s.startsWith("."))) return;
      soon(link.vault_id, 400);
      // A recursive watch on Linux (the container) doesn't follow folders made after it
      // started, so a new folder restarts it; until then the rescan covers it.
      if (name)
        void stat(join(dir, String(name))).then(
          (st) => st.isDirectory() && watchers.get(link.vault_id)?.fs === fsw && void startWatching(link),
          () => {},
        );
    });
    fsw.on("error", () => {});
  } catch {}
  const off = subscribe(link.vault_id, (e) => {
    if (e.type !== "vault.changed") soon(link.vault_id, 1500);
  });
  watchers.set(link.vault_id, { fs: fsw, off });
}

function stopWatching(vaultId: number) {
  const w = watchers.get(vaultId);
  w?.fs?.close();
  w?.off();
  watchers.delete(vaultId);
  clearTimeout(timers.get(vaultId));
  timers.delete(vaultId);
}

/** At boot (src/server.ts): watch every linked folder and rescan them all now and then. */
export async function startFolderSync(): Promise<void> {
  if (!(await available())) return;
  for (const l of await sql<Link[]>`select * from vault_folder`) await startWatching({ ...l, vault_id: Number(l.vault_id) });
  const tick = async () => {
    for (const r of await sql`select vault_id from vault_folder where paused_at is null`) await syncNow(Number(r.vault_id));
  };
  void tick();
  setInterval(() => void tick(), settings.folderScanMs).unref();
}

// ── what people do ───────────────────────────────────────────────────────────────────────────

export interface FolderStatus {
  root: string;
  label: string;
  mode: FolderMode;
  paused: boolean;
  pausedWhy: string | null;
  lastSync: Date | null;
  lastError: string | null;
  clashes: { path: string; mine: string | null; theirs: string | null; base: string | null }[];
}

export async function status(vaultId: number): Promise<FolderStatus | null> {
  const link = await linkOf(vaultId);
  if (!link) return null;
  const clashes = await sql`
    select c.path, c.theirs, n.content as mine, f.content as base from folder_clashes c
    left join notes n on n.vault_id = c.vault_id and lower(n.path) = lower(c.path)
    left join folder_files f on f.vault_id = c.vault_id and lower(f.path) = lower(c.path)
    where c.vault_id = ${vaultId} order by c.path`;
  return {
    root: link.root,
    label: label(link.root),
    mode: link.mode,
    paused: !!link.paused_at,
    pausedWhy: link.paused_why,
    lastSync: link.last_sync,
    lastError: link.last_error,
    clashes: clashes.map((c) => ({ path: c.path, mine: c.mine ?? null, theirs: c.theirs ?? null, base: c.base ?? null })),
  };
}

/** Keep a vault in a folder. One side must be empty to start: an empty folder gets the vault's
 *  notes, an empty vault gets the folder's. Choosing the mode again just changes it. */
export async function link(vaultId: number, user: User, rawRoot: string, mode: FolderMode, opts: { create?: boolean } = {}): Promise<FolderStatus> {
  if (!(await available())) throw new HttpError(400, "Folders aren't available on this server");
  await requireRole(vaultId, user, "owner");
  const root = cleanRoot(rawRoot);
  const existing = await linkOf(vaultId);
  if (existing) {
    if (existing.root !== root) throw new HttpError(409, "This collection is already kept in another folder; stop keeping it there first");
    await sql`update vault_folder set mode = ${mode} where vault_id = ${vaultId}`;
    return (await status(vaultId))!;
  }
  for (const r of await sql`select root from vault_folder`) {
    const other = String(r.root);
    if (other === root || root.startsWith(other + "/") || other.startsWith(root + "/")) throw new HttpError(409, `${label(root)} overlaps a folder another collection is kept in`);
  }
  if (opts.create) await mkdir(join(settings.foldersRoot, root), { recursive: true });
  const dir = await dirOf(root);
  const files = (await scanDisk(dir)).size;
  const [{ n }] = (await sql`select (select count(*) from notes where vault_id = ${vaultId}) + (select count(*) from attachments where vault_id = ${vaultId}) as n`) as any;
  if (files > 0 && Number(n) > 0) throw new HttpError(409, "Both the folder and the collection have notes. Choose an empty folder, or start a new collection from this one.");
  await sql`insert into vault_folder (vault_id, root, mode, created_by) values (${vaultId}, ${root}, ${mode}, ${user.id})`;
  const l = (await linkOf(vaultId))!;
  await syncNow(vaultId);
  await startWatching(l);
  return (await status(vaultId))!;
}

/** Stop keeping a vault in its folder. The notes stay here, the files stay in the folder. */
export async function unlink(vaultId: number, user: User): Promise<void> {
  await requireRole(vaultId, user, "owner");
  stopWatching(vaultId);
  await running.get(vaultId)?.catch(() => null);
  await sql.begin(async (tx) => {
    await tx`delete from folder_clashes where vault_id = ${vaultId}`;
    await tx`delete from folder_files where vault_id = ${vaultId}`;
    await tx`delete from vault_folder where vault_id = ${vaultId}`;
  });
}

export async function setPaused(vaultId: number, user: User, paused: boolean): Promise<FolderStatus | null> {
  await requireRole(vaultId, user, "owner");
  if (paused) await sql`update vault_folder set paused_at = now(), paused_why = null where vault_id = ${vaultId}`;
  else await syncNow(vaultId, { force: true });
  return status(vaultId);
}

/** 'folder' mode: rebuild this side from the folder (it is the master copy). */
export async function rebuild(vaultId: number, user: User): Promise<SyncReport | null> {
  await requireRole(vaultId, user, "owner");
  const link = await linkOf(vaultId);
  if (!link) throw new HttpError(404, "This collection isn't kept in a folder");
  if (link.mode !== "folder") throw new HttpError(400, "Only a collection whose master copy is the folder can be rebuilt from it");
  return syncNow(vaultId, { rebuild: true, force: true });
}

/** Settle a clash: keep this side's note (written to the folder) or take the folder's. */
export async function resolve(vaultId: number, user: User, path: string, take: "mine" | "theirs"): Promise<void> {
  await requireRole(vaultId, user, "editor");
  const link = await linkOf(vaultId);
  if (!link) throw new HttpError(404, "This collection isn't kept in a folder");
  const [c] = await sql`select path, theirs from folder_clashes where vault_id = ${vaultId} and lower(path) = lower(${path})`;
  if (!c) throw new HttpError(404, "No clash for that note");
  const dir = await dirOf(link.root);
  const [n] = await sql`select id, path, content from notes where vault_id = ${vaultId} and lower(path) = lower(${path})`;
  const [b] = await sql`select rel from folder_files where vault_id = ${vaultId} and lower(path) = lower(${path})`;
  const rel: string = b?.rel ?? normalisePath(c.path);
  if (take === "mine") {
    if (n) {
      const bytes = new TextEncoder().encode(String(n.content));
      const st = await writeFileAtomic(dir, rel, bytes);
      await saveBase(vaultId, { path: n.path, rel, disk_hash: md5(bytes), db_hash: md5(String(n.content)), ...st, content: String(n.content) });
    } else {
      await trashFile(dir, rel);
      await dropBase(vaultId, c.path);
    }
  } else if (c.theirs === null) {
    if (n) await toTrash(vaultId, Number(n.id), user.id);
    await dropBase(vaultId, c.path);
  } else {
    const text = String(c.theirs);
    if (n) await overwriteNow(Number(n.id), text, user.id);
    else await createNote(vaultId, user.id, c.path, text);
    const full = inside(dir, rel);
    const bytes = new Uint8Array(await readFile(full));
    const st = await stat(full);
    await saveBase(vaultId, { path: n?.path ?? c.path, rel, disk_hash: md5(bytes), db_hash: md5(text), mtime: st.mtimeMs, size: st.size, content: text });
  }
  await sql`delete from folder_clashes where vault_id = ${vaultId} and lower(path) = lower(${path})`;
  emit(vaultId, { type: "vault.changed" });
}

/** A database collection written out as files into an empty folder, once ("Export to folder"). */
export async function exportTo(vaultId: number, user: User, rawRoot: string): Promise<{ files: number; label: string }> {
  if (!(await available())) throw new HttpError(400, "Folders aren't available on this server");
  await requireRole(vaultId, user, "viewer");
  const root = cleanRoot(rawRoot);
  await mkdir(join(settings.foldersRoot, root), { recursive: true });
  const dir = await dirOf(root);
  if ((await readdir(dir)).some((n) => !n.startsWith("."))) throw new HttpError(409, `${label(root)} isn't empty`);
  const { exportTree } = await import("./transfer");
  const tree = await exportTree(vaultId);
  let files = 0;
  for (const [rel, bytes] of Object.entries(tree)) {
    if (rel.endsWith("/")) await mkdir(inside(dir, rel.slice(0, -1)), { recursive: true });
    else {
      await writeFileAtomic(dir, rel, bytes);
      files++;
    }
  }
  return { files, label: label(root) };
}

