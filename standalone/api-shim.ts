// Stands in for web/lib/api.ts in the standalone build (build.ts swaps it in): the shared client
// code that asks the server (embeds, Dataview, the graph, Tasks, bookmarks, saved searches,
// pasted pictures) is answered from the open folders instead. `/vaults/:id` is a folder's id.

import { type PageData, readPage, type Result, runInline, runQuery, Vault } from "../src/dataview";
import { DAILY, NOT_RELATIONS, noteWhen, targetsIn } from "../src/graphParts";
import { extractLinks, isAttachmentPath, parseFrontmatter } from "../src/markdown";
import { type Task, TASK as TASK_LINE, tasksIn } from "../src/tasks";
import { resolveLocal } from "../web/lib/links";
import { searchNotes } from "./search";
import { addAttachment, attachmentUrl, getNote, notesOf, noteFor, openFolders, setContent } from "./vault";

export type { Note, NoteSummary, Role, User, Vault, Session } from "../web/lib/api";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

// Each folder's pages for Dataview, each read again only when its text or path changes.
const pages = new Map<number, { content: string; path: string; page: PageData }>();
const dvVaults = new Map<number, { vault: Vault; ids: string }>();

function folderVault(folder: number): Vault {
  let changed = false;
  const list = notesOf(folder);
  for (const n of list) {
    const e = getNote(n.id);
    if (!e) continue;
    const had = pages.get(n.id);
    if (had && had.content === e.content && had.path === n.path) continue;
    const t = Date.parse(n.updated_at) || Date.now();
    pages.set(n.id, { content: e.content, path: n.path, page: readPage({ path: n.path, content: e.content, ctime: Date.parse(n.created_at ?? "") || t, mtime: t }) });
    changed = true;
  }
  const ids = list.map((n) => n.id).join(",");
  const had = dvVaults.get(folder);
  if (had && !changed && had.ids === ids) return had.vault;
  for (const id of [...pages.keys()]) if (!getNote(id)) pages.delete(id);
  const vault = new Vault(list.flatMap((n) => pages.get(n.id)?.page ?? []));
  dvVaults.set(folder, { vault, ids });
  return vault;
}

/** The graph (as src/graph.ts makes it): every note, and every link between two of them, with
 *  the property a link comes from. A folder has no types and no record of when a note was made,
 *  so the timeline uses the day it last changed. */
function graph(folder: number) {
  const list = notesOf(folder);
  const edges = new Map<string, { source: number; target: number; label: string | null }>();
  for (const n of list) {
    const content = getNote(n.id)?.content ?? "";
    const via = new Map<number, string[]>();
    for (const [prop, value] of Object.entries(parseFrontmatter(content).data)) {
      if (NOT_RELATIONS.has(prop.toLowerCase())) continue;
      for (const t of targetsIn(value)) {
        const hit = resolveLocal(list, t);
        if (hit && hit.id !== n.id) via.set(hit.id, [...new Set([...(via.get(hit.id) ?? []), prop])]);
      }
    }
    for (const t of extractLinks(content)) {
      if (isAttachmentPath(t)) continue;
      const hit = resolveLocal(list, t);
      if (!hit || hit.id === n.id) continue;
      const key = `${n.id} ${hit.id}`;
      const label = via.get(hit.id)?.sort().join(", ") ?? null;
      if (!edges.get(key)?.label) edges.set(key, { source: n.id, target: hit.id, label });
    }
  }
  return {
    nodes: list.map((n) => ({
      id: n.id,
      title: n.title,
      path: n.path,
      type: n.type ?? null,
      tags: n.tags,
      daily: DAILY.test(n.path),
      ...noteWhen({ path: n.path, frontmatter: parseFrontmatter(getNote(n.id)?.content ?? "").data, made: n.updated_at.slice(0, 10) }, null),
    })),
    edges: [...edges.values()],
    types: [],
  };
}

function tasks(folder: number): Task[] {
  const out: Task[] = [];
  for (const n of [...notesOf(folder)].sort((a, b) => b.updated_at.localeCompare(a.updated_at))) {
    for (const t of tasksIn(getNote(n.id)?.content ?? "")) out.push({ noteId: n.id, path: n.path, title: n.title, type: n.type ?? null, ...t });
  }
  return out;
}

// Bookmarks and saved searches stay in this browser, by the folder's name and the notes' paths
// (a note's id is new each time the folder is opened).
const storeKey = (key: string, folder: number) => `cp-standalone-${key}:${openFolders().find((f) => f.id === folder)?.name ?? ""}`;
const kept = <T>(key: string, folder: number, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(storeKey(key, folder)) ?? "null") ?? fallback;
  } catch {
    return fallback;
  }
};
const keep = (key: string, folder: number, value: unknown) => {
  try {
    localStorage.setItem(storeKey(key, folder), JSON.stringify(value));
  } catch {
    // Not kept (a private window): it lasts while the tab is open.
  }
};
function bookmarks(folder: number): number[] {
  const list = notesOf(folder);
  return kept<string[]>("bookmarks", folder, []).flatMap((p) => list.find((n) => n.path === p)?.id ?? []);
}
const searches = (folder: number) => kept<string[]>("searches", folder, []).map((query, i) => ({ id: i + 1, query }));

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const method = opts.method ?? (opts.body || opts.form ? "POST" : "GET");
  // Assistants need the server: there are none here.
  if (path === "/me/assistants") return [] as T;
  const m = /^\/vaults\/(\d+)(\/.*)?$/.exec(path);
  if (!m) throw new ApiError(501, "That needs the DO Notes server.");
  const v = Number(m[1]);
  const rest = m[2] ?? "";

  const note = /^\/notes\/(\d+)$/.exec(rest);
  if (note && method === "GET") {
    const n = noteFor(Number(note[1]));
    if (!n || n.vault_id !== v) throw new ApiError(404, "That note isn't in this folder.");
    return n as T;
  }
  // Types (F16) are a server feature; a plain folder has none defined.
  if (rest === "/types") return { types: [], undefined: [] } as T;
  if (rest === "/dataview" && method === "POST") {
    const b = opts.body as { noteId: number | null; offset: number; tz?: string; items: { kind: "query" | "inline"; source: string }[] };
    const dv = folderVault(v);
    const thisPath = b.noteId === null ? null : (notesOf(v).find((n) => n.id === b.noteId)?.path ?? null);
    return b.items.map((it) => (it.kind === "query" ? runQuery(it.source, dv, { thisPath, offset: b.offset, tz: b.tz }) : runInline(it.source, dv, { thisPath, offset: b.offset, tz: b.tz }))) as Result[] as T;
  }
  // dataviewjs (web/lib/dataviewjs.ts): the folder's pages, and a note's or file's text.
  if (rest === "/dataview/pages") return folderVault(v).pages as T;
  if (rest.startsWith("/dataview/file?")) {
    const want = new URLSearchParams(rest.slice(rest.indexOf("?") + 1)).get("path") ?? "";
    const isNote = /\.md$/i.test(want) || !/\.[a-z0-9]{1,8}$/i.test(want);
    const found = isNote ? folderVault(v).resolve(want.replace(/\.md$/i, "")) : null;
    const hit = found ? notesOf(v).find((n) => n.path === found) : undefined;
    if (hit) return { text: getNote(hit.id)?.content ?? "" } as T;
    const url = await attachmentUrl(want, v);
    if (!url) throw new ApiError(404, `There's no file at ${want}`);
    return { text: await (await fetch(url)).text() } as T;
  }
  // Ticking a task (in a Dataview result, or on the Tasks page): flip that line, found by its
  // number and text.
  const task = /^\/notes\/(\d+)\/tasks$/.exec(rest);
  if (task && method === "PATCH") {
    const id = Number(task[1]);
    const b = opts.body as { line: number; text: string; done: boolean };
    const e = getNote(id);
    if (!e) throw new ApiError(404, "That note isn't in this folder.");
    const lines = e.content.split("\n");
    let at = b.line;
    const isIt = (i: number) => TASK_LINE.test(lines[i] ?? "") && (lines[i] ?? "").includes(b.text);
    if (!isIt(at)) at = lines.findIndex((_, i) => isIt(i));
    if (at < 0) throw new ApiError(409, "That task has changed since the list was loaded.");
    lines[at] = lines[at]!.replace(TASK_LINE, (_, a, _b, c, d) => `${a}${b.done ? "x" : " "}${c}${d}`);
    setContent(id, lines.join("\n"));
    // An open editor holds its own copy of the text: tell it to start again from this one.
    window.dispatchEvent(new CustomEvent("cp-note-replaced", { detail: id }));
    return undefined as T;
  }
  // A pasted, dropped or picked picture: saved in the folder's attachments/.
  if (rest === "/files" && method === "POST" && opts.form) {
    const file = opts.form.get("file");
    if (!(file instanceof File)) throw new ApiError(400, "There's no file to save.");
    return { path: await addAttachment(file, file.name) } as T;
  }
  if (rest === "/graph") return graph(v) as T;
  if (rest === "/tasks") return tasks(v) as T;
  if (rest.startsWith("/search?")) {
    const q = new URLSearchParams(rest.slice(rest.indexOf("?") + 1)).get("q") ?? "";
    return { hits: searchNotes(notesOf(v), q, 1000).map((h) => ({ id: h.n.id })) } as T;
  }
  if (rest === "/bookmarks") return bookmarks(v) as T;
  const mark = /^\/bookmarks\/(\d+)$/.exec(rest);
  if (mark) {
    const n = notesOf(v).find((x) => x.id === Number(mark[1]));
    const paths = kept<string[]>("bookmarks", v, []).filter((p) => p !== n?.path);
    keep("bookmarks", v, method === "PUT" && n ? [...paths, n.path] : paths);
    return bookmarks(v) as T;
  }
  if (rest === "/searches") {
    if (method === "POST") {
      const q = String((opts.body as { query: string }).query).trim();
      const list = kept<string[]>("searches", v, []);
      if (q && !list.includes(q)) keep("searches", v, [...list, q]);
    }
    return searches(v) as T;
  }
  const saved = /^\/searches\/(\d+)$/.exec(rest);
  if (saved && method === "DELETE") {
    keep(
      "searches",
      v,
      kept<string[]>("searches", v, []).filter((_, i) => i + 1 !== Number(saved[1])),
    );
    return searches(v) as T;
  }
  throw new ApiError(501, "That needs the DO Notes server.");
}
