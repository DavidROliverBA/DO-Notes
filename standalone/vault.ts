// The folders being edited, each a collection: every .md file read into memory (so links,
// backlinks, tags and search need no server), the other files kept as handles for images. Several
// can be open at once; one is current, and everything below acts on it unless given another.
// Two ways in:
//
// - A real folder (Chrome and Edge, through the File System Access API): edits are written back
//   to the files a moment after typing stops. The folders are remembered, to reopen with a click.
// - Files picked or dropped (Safari and Firefox, which can't write to a folder): edits stay in
//   this tab, and "Download changes" saves them as a zip of the changed files.

import { zipSync, strToU8 } from "fflate";
import { extractTags, findWikiLinks, isAttachmentPath, normalisePath, normaliseTarget, parseFrontmatter, rewriteWikiLinks, titleFromPath } from "../src/markdown";
import type { Note, NoteSummary } from "../web/lib/api";
import { resolveLocal } from "../web/lib/links";

type Dir = FileSystemDirectoryHandle;

interface Entry {
  folder: number;
  summary: NoteSummary;
  content: string;
  /** Worked out when first asked for and dropped when the text changes: its [[link]] targets,
   *  and its text lowercased for search. */
  links?: string[];
  lower?: string;
  /** Changed in this tab and not yet written (or, without a folder, not yet downloaded). */
  dirty: boolean;
}

interface Folder {
  id: number;
  name: string;
  /** The folder on disk, or null for files read into the tab. */
  root: Dir | null;
  /** Attachments by lowercased path: a handle in folder mode, the File itself otherwise. */
  files: Map<string, { path: string; get: () => Promise<File> }>;
  /** Its notes, sorted by path, rebuilt when notes come, go or change their tags, type or aliases. */
  list: NoteSummary[];
}

const notes = new Map<number, Entry>();
const folders = new Map<number, Folder>();
let current: Folder | null = null;
let seq = 0;
let folderSeq = 0;
// Two signals. The note list changes when notes come, go, move, or change their tags, type or
// aliases, or another folder becomes current: everything built from it (the tree, link lookups,
// backlinks) rebuilds then, and not on every keystroke. Status is the cheap one: what's unsaved.
const listeners = new Set<() => void>();
const EMPTY: NoteSummary[] = [];
const emit = (folder = current?.id) => {
  const f = folder === undefined ? undefined : folders.get(folder);
  if (f) f.list = [...notes.values()].filter((e) => e.folder === f.id).map((e) => e.summary);
  listeners.forEach((l) => l());
  emitStatus();
};
const statusListeners = new Set<() => void>();
let status = 0;
const emitStatus = () => {
  status++;
  statusListeners.forEach((f) => f());
};

export const subscribe = (f: () => void) => (listeners.add(f), () => void listeners.delete(f));
export const subscribeStatus = (f: () => void) => (statusListeners.add(f), () => void statusListeners.delete(f));
export const statusVersion = () => status;
/** The current folder's notes. */
export const allNotes = () => current?.list ?? EMPTY;
/** A folder's notes (the current one's without an id). */
export const notesOf = (folder?: number) => (folder === undefined ? allNotes() : (folders.get(folder)?.list ?? EMPTY));
export const vaultName = () => current?.name ?? "";
/** The current folder's id: the collection id the shared client code asks the server about. */
export const vaultId = () => current?.id ?? 0;
/** True when edits go straight back to the files on disk. */
export const canWrite = () => !!current?.root;
export const getNote = (id: number) => notes.get(id);
export const isOpen = () => current !== null;

/** The open folders, in the order they were opened. */
export const openFolders = () => [...folders.values()].map((f) => ({ id: f.id, name: f.name, writes: !!f.root, dirty: dirtyIn(f.id) }));

const dirtyIn = (folder: number) => {
  let n = 0;
  for (const e of notes.values()) if (e.folder === folder && e.dirty) n++;
  return n;
};
/** Unsaved notes in the current folder (or, with `all`, in every open folder). */
export const dirtyCount = (all = false) => (all ? [...folders.keys()].reduce((n, id) => n + dirtyIn(id), 0) : current ? dirtyIn(current.id) : 0);

/** A note's [[link]] targets, without #headings. */
export function linksOf(id: number): string[] {
  const e = notes.get(id);
  if (!e) return [];
  return (e.links ??= findWikiLinks(e.content).map((l) => l.target.split("#")[0]!.trim()));
}
export function lowerOf(id: number): string {
  const e = notes.get(id);
  return e ? (e.lower ??= e.content.toLowerCase()) : "";
}

export const supportsFolders = () => typeof (window as any).showDirectoryPicker === "function";

function summarise(id: number, path: string, content: string, updated: number): NoteSummary {
  const { data } = parseFrontmatter(content);
  const raw = data.aliases ?? data.alias;
  const aliases = (Array.isArray(raw) ? raw : raw ? [raw] : []).map((a) => String(a).toLowerCase());
  return {
    id,
    path,
    title: titleFromPath(path),
    tags: extractTags(content),
    type: typeof data.type === "string" ? data.type : null,
    updated_at: new Date(updated).toISOString(),
    aliases: aliases.length ? aliases : null,
    names: aliases.length ? (Array.isArray(raw) ? raw : [raw]).map((a) => String(a).trim()).filter(Boolean) : null,
    icon: typeof data.icon === "string" && !/^Types\/[^/]+\.md$/i.test(path) ? data.icon : null,
    width: data.width === "wide" || data.width === "full" ? data.width : null,
    cover: typeof data.cover === "string" ? data.cover : null,
  };
}

function addFolder(label: string, root: Dir | null): Folder {
  const f: Folder = { id: ++folderSeq, name: label || "Folder", root, files: new Map(), list: [] };
  folders.set(f.id, f);
  return f;
}

/** Make another open folder the current one. */
export function switchTo(id: number) {
  const f = folders.get(id);
  if (!f || f === current) return;
  current = f;
  emit();
}

/** Close a folder (its pending writes go first); the next open one becomes current. */
export async function closeFolder(id: number): Promise<void> {
  const f = folders.get(id);
  if (!f) return;
  if (f.root) await flush(undefined, id);
  for (const [nid, e] of notes) if (e.folder === id) (clearTimeout(timers.get(nid)), notes.delete(nid));
  for (const [k, u] of blobUrls) if (k.startsWith(`${id}:`)) (URL.revokeObjectURL(u), blobUrls.delete(k));
  folders.delete(id);
  if (current === f) current = [...folders.values()].at(-1) ?? null;
  emit();
}

const SKIP = /^(\.|node_modules$)/; // hidden folders (.git, app settings) and dependencies

/** Open a folder chosen with the system picker: every .md file, and the rest as attachments. If
 *  it's open already, it becomes current instead of being read twice. */
export async function openFolder(dir: Dir): Promise<void> {
  for (const f of folders.values()) {
    if (f.root && (await f.root.isSameEntry(dir))) {
      current = f;
      void remember(dir);
      return emit();
    }
  }
  const folder = addFolder(dir.name, dir);
  try {
    // List every folder at once, then read the notes many at a time: one by one, a vault of
    // thousands takes seconds.
    const md: { path: string; fh: FileSystemFileHandle }[] = [];
    const walk = async (d: Dir, prefix: string): Promise<void> => {
      const sub: Promise<void>[] = [];
      for await (const [entryName, h] of (d as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
        if (SKIP.test(entryName)) continue;
        const path = prefix ? `${prefix}/${entryName}` : entryName;
        if (h.kind === "directory") sub.push(walk(h as Dir, path));
        else {
          const fh = h as FileSystemFileHandle;
          if (/\.md$/i.test(entryName)) md.push({ path, fh });
          else if (isAttachmentPath(path)) folder.files.set(path.toLowerCase(), { path, get: () => fh.getFile() });
        }
      }
      await Promise.all(sub);
    };
    await walk(dir, "");
    md.sort((a, b) => a.path.localeCompare(b.path));
    const read = await pool(md, 32, async ({ fh }) => {
      const f = await fh.getFile();
      return { content: await f.text(), modified: f.lastModified };
    });
    md.forEach(({ path }, i) => {
      const id = ++seq;
      const { content, modified } = read[i]!;
      notes.set(id, { folder: folder.id, summary: summarise(id, path, content, modified), content, dirty: false });
    });
  } catch (e) {
    folders.delete(folder.id);
    throw e;
  }
  current = folder;
  void remember(dir);
  emit();
}

/** `work` on each item, at most `limit` at once; results in the items' order. */
async function pool<T, R>(items: T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const run = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await work(items[i]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
  return out;
}

/** Read files picked or dropped without folder access: kept in this tab only. */
export async function openFiles(picked: File[], label: string): Promise<void> {
  const folder = addFolder(label, null);
  const md: { path: string; f: File }[] = [];
  for (const f of picked) {
    // A folder pick gives "Folder/sub/note.md"; drop the folder's own name.
    const rel = ((f as any).webkitRelativePath || f.name).split("/");
    if (rel.length > 1) rel.shift();
    const path = rel.join("/");
    if (path.split("/").some((p: string) => SKIP.test(p))) continue;
    if (/\.md$/i.test(path)) md.push({ path, f });
    else if (isAttachmentPath(path)) folder.files.set(path.toLowerCase(), { path, get: async () => f });
  }
  md.sort((a, b) => a.path.localeCompare(b.path));
  const texts = await pool(md, 32, ({ f }) => f.text());
  md.forEach(({ path, f }, i) => {
    const id = ++seq;
    notes.set(id, { folder: folder.id, summary: summarise(id, path, texts[i]!, f.lastModified), content: texts[i]!, dirty: false });
  });
  current = folder;
  emit();
}

/** A note as the shared client code expects it (embeds fetch notes through web/lib/api). */
export function noteFor(id: number): Note | undefined {
  const e = notes.get(id);
  if (!e) return undefined;
  return { ...e.summary, vault_id: e.folder, content: e.content, frontmatter: parseFrontmatter(e.content).data, version: 1, updated_by_name: null, role: "editor" };
}

// ── writing ───────────────────────────────────────────────────────────────────────────

async function fileHandle(root: Dir, path: string, create: boolean): Promise<FileSystemFileHandle> {
  const parts = path.split("/");
  let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p, { create });
  return d.getFileHandle(parts.at(-1)!, { create });
}

async function writeFile(root: Dir, path: string, data: string | Blob) {
  const w = await (await fileHandle(root, path, true)).createWritable();
  await w.write(data);
  await w.close();
}

async function removeFile(root: Dir, path: string) {
  const parts = path.split("/");
  let d = root;
  for (const p of parts.slice(0, -1)) d = await d.getDirectoryHandle(p);
  await d.removeEntry(parts.at(-1)!);
}

const rootOf = (e: Entry) => folders.get(e.folder)?.root ?? null;

const timers = new Map<number, ReturnType<typeof setTimeout>>();
const summaryTimers = new Map<number, ReturnType<typeof setTimeout>>();
const sameList = (a: string[] | null | undefined, b: string[] | null | undefined) => (a ?? []).join("\n") === (b ?? []).join("\n");
let saveError: ((e: unknown) => void) | null = null;
export const onSaveError = (f: (e: unknown) => void) => void (saveError = f);

/** The editor's text changed: keep it, and write it to disk shortly. */
export function setContent(id: number, content: string) {
  const e = notes.get(id);
  if (!e || e.content === content) return;
  e.content = content;
  e.links = e.lower = undefined;
  const wasDirty = e.dirty;
  e.dirty = true;
  clearTimeout(timers.get(id));
  if (rootOf(e)) timers.set(id, setTimeout(() => void flush(id), 500));
  if (!wasDirty) emitStatus();
  // Tags, type and aliases are read again once typing pauses; the list changes only if they did.
  clearTimeout(summaryTimers.get(id));
  summaryTimers.set(
    id,
    setTimeout(() => {
      const cur = notes.get(id);
      if (!cur) return;
      const next = summarise(id, cur.summary.path, cur.content, Date.now());
      const changed = !sameList(next.tags, cur.summary.tags) || next.type !== cur.summary.type || next.icon !== cur.summary.icon || next.width !== cur.summary.width || next.cover !== cur.summary.cover || !sameList(next.aliases, cur.summary.aliases);
      if (changed) {
        cur.summary = next;
        emit(cur.folder);
      } else cur.summary.updated_at = next.updated_at;
    }, 400),
  );
}

/** Write one note now, or every pending one (in one folder, or in all of them). */
export async function flush(id?: number, folder?: number): Promise<void> {
  const ids = id !== undefined ? [id] : [...notes.keys()].filter((i) => folder === undefined || notes.get(i)!.folder === folder);
  for (const i of ids) {
    const e = notes.get(i);
    const root = e && rootOf(e);
    if (!e?.dirty || !root) continue;
    clearTimeout(timers.get(i));
    const content = e.content;
    try {
      await writeFile(root, e.summary.path, content);
      if (e.content === content) e.dirty = false;
      emitStatus();
    } catch (err) {
      saveError?.(err);
    }
  }
  emit();
}

const exists = (path: string) => allNotes().some((n) => n.path.toLowerCase() === path.toLowerCase());

/** A new note at `path` (".md" added) in the current folder; a number is appended if the name
 *  is taken. */
export async function createNote(input: string, content = ""): Promise<NoteSummary> {
  if (!current) throw new Error("Open a folder first.");
  let path = normalisePath(input);
  for (let n = 2; exists(path); n++) path = normalisePath(`${input.replace(/\.md$/i, "")} ${n}`);
  const id = ++seq;
  notes.set(id, { folder: current.id, summary: summarise(id, path, content, Date.now()), content, dirty: !current.root });
  if (current.root) await writeFile(current.root, path, content);
  emit();
  return notes.get(id)!.summary;
}

/** Notes in the same folder whose [[links]] lead to this one. */
export function backlinksOf(id: number): NoteSummary[] {
  const e = notes.get(id);
  if (!e) return [];
  const list = notesOf(e.folder);
  return list.filter((n) => n.id !== id && linksOf(n.id).some((t) => resolveLocal(list, t)?.id === id));
}

/** Move a note to a new path. Links to it in the other notes are rewritten, as the app does: the
 *  bare title, or the path when another note has the same title. Returns how many notes changed. */
export async function renameNote(id: number, input: string): Promise<{ note: NoteSummary; relinked: number }> {
  const e = notes.get(id)!;
  const to = normalisePath(input);
  if (to === e.summary.path) return { note: e.summary, relinked: 0 };
  const from = e.summary.path;
  const caseOnly = to.toLowerCase() === from.toLowerCase();
  if (!caseOnly && exists(to)) throw new Error(`There's already a note at ${to}`);
  // Find the linkers before the rename, while their links still lead to the old name.
  const linkers = backlinksOf(id);
  const oldKeys = new Set([e.summary.title.toLowerCase(), from.replace(/\.md$/i, "").toLowerCase()].map(normaliseTarget));
  const root = rootOf(e);
  if (root) {
    await flush(id);
    if (caseOnly) {
      // On a Mac the two names are one file: writing the new one and deleting the old would
      // delete the note. Go through a temporary name instead.
      const tmp = `${from}.renaming`;
      await writeFile(root, tmp, e.content);
      await removeFile(root, from);
      await writeFile(root, to, e.content);
      await removeFile(root, tmp);
    } else {
      await writeFile(root, to, e.content);
      await removeFile(root, from);
    }
  }
  e.summary = summarise(id, to, e.content, Date.now());
  const title = titleFromPath(to);
  const replacement = notesOf(e.folder).filter((n) => n.title.toLowerCase() === title.toLowerCase()).length > 1 ? to.replace(/\.md$/i, "") : title;
  let relinked = 0;
  for (const l of linkers) {
    const src = notes.get(l.id)!;
    const next = rewriteWikiLinks(src.content, (t) => oldKeys.has(t) || [...oldKeys].some((k) => k.endsWith("/" + t)), replacement);
    if (next === src.content) continue;
    setContent(l.id, next);
    relinked++;
    // An open editor holds its own copy of the text: tell it to start again from this one.
    window.dispatchEvent(new CustomEvent("cp-note-replaced", { detail: l.id }));
  }
  emit(e.folder);
  return { note: e.summary, relinked };
}

export async function deleteNote(id: number): Promise<void> {
  const e = notes.get(id);
  if (!e) return;
  clearTimeout(timers.get(id));
  const root = rootOf(e);
  if (root) await removeFile(root, e.summary.path);
  notes.delete(id);
  emit(e.folder);
}

/** Save a pasted or dropped file next to the notes, in attachments/ (under `name` when given);
 *  returns its path. */
export async function addAttachment(file: File, name?: string): Promise<string> {
  if (!current) throw new Error("Open a folder first.");
  const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
  const given = name ?? file.name;
  const base = given && !/^image\.\w+$/i.test(given) ? given.replace(/[\\/]/g, " ") : `Pasted image ${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}.${ext}`;
  let path = `attachments/${base}`;
  for (let n = 2; current.files.has(path.toLowerCase()); n++) path = `attachments/${base.replace(/(\.\w+)?$/, ` ${n}$1`)}`;
  if (current.root) await writeFile(current.root, path, file);
  current.files.set(path.toLowerCase(), { path, get: async () => file });
  return path;
}

/** Every changed note of the current folder (without folder access) as one zip, to save. */
export function changesZip(): Blob {
  const out: Record<string, Uint8Array> = {};
  for (const e of notes.values()) if (e.folder === current?.id && e.dirty) out[e.summary.path] = strToU8(e.content);
  return new Blob([zipSync(out)], { type: "application/zip" });
}
export function markAllSaved() {
  for (const e of notes.values()) if (e.folder === current?.id) e.dirty = false;
  emit();
}

// ── attachments ───────────────────────────────────────────────────────────────────────

const blobUrls = new Map<string, string>();
const TYPES: Record<string, string> = {
  svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", bmp: "image/bmp",
  pdf: "application/pdf", mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4", mov: "video/quicktime", webm: "video/webm",
};

/** A URL for an attachment a note names: its path, or (as wikilinks allow) just its name. */
export async function attachmentUrl(path: string, folder = current?.id): Promise<string | null> {
  const f = folder === undefined ? undefined : folders.get(folder);
  if (!f) return null;
  const key = path.toLowerCase().replace(/^\.?\//, "");
  const hit = f.files.get(key) ?? [...f.files.values()].find((x) => x.path.toLowerCase().endsWith("/" + key));
  if (!hit) return null;
  let url = blobUrls.get(`${f.id}:${hit.path}`);
  if (!url) {
    const file = await hit.get();
    // Files read from a folder can come without a type, and an SVG won't show without one.
    const ext = hit.path.split(".").pop()!.toLowerCase();
    url = URL.createObjectURL(file.type ? file : new Blob([file], { type: TYPES[ext] ?? "application/octet-stream" }));
    blobUrls.set(`${f.id}:${hit.path}`, url);
  }
  return url;
}

// ── the folders, to reopen with one click ──────────────────────────────────────────────

const DB = "commonplace-standalone";
function idb(): Promise<IDBDatabase> {
  return new Promise((ok, fail) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore("handles");
    r.onsuccess = () => ok(r.result);
    r.onerror = () => fail(r.error);
  });
}
async function get<T>(key: string): Promise<T | null> {
  const db = await idb();
  return new Promise((ok) => {
    const r = db.transaction("handles").objectStore("handles").get(key);
    r.onsuccess = () => ok((r.result as T) ?? null);
    r.onerror = () => ok(null);
  });
}
async function put(key: string, value: unknown) {
  const db = await idb();
  db.transaction("handles", "readwrite").objectStore("handles").put(value, key);
}

const MAX_REMEMBERED = 12;

/** The folders opened before, the last one first (older versions kept only the last). */
export async function rememberedFolders(): Promise<Dir[]> {
  try {
    const list = (await get<Dir[]>("folders")) ?? [];
    const last = await get<Dir>("last");
    if (last && !(await someSame(list, last))) list.unshift(last);
    return list;
  } catch {
    return [];
  }
}
async function someSame(list: Dir[], d: Dir) {
  for (const x of list) if (await x.isSameEntry(d)) return true;
  return false;
}
async function remember(dir: Dir) {
  try {
    const rest: Dir[] = [];
    for (const d of await rememberedFolders()) if (!(await d.isSameEntry(dir))) rest.push(d);
    await put("folders", [dir, ...rest].slice(0, MAX_REMEMBERED));
    await put("last", null);
  } catch {
    // Not kept (a private window): the folder is just picked again next time.
  }
}
/** Take a folder off the list on the welcome screen (its files are left alone). */
export async function forgetFolder(dir: Dir) {
  try {
    const rest: Dir[] = [];
    for (const d of await rememberedFolders()) if (!(await d.isSameEntry(dir))) rest.push(d);
    await put("folders", rest);
    await put("last", null);
  } catch {
    // Nothing kept to forget.
  }
}
