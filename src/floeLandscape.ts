// Landscapes from Floe, kept up to date (F41, docs/design/F41.md). A landscape comes in from the
// person's Floe connection (F33) into a folder, and later Update from Floe rewrites only what
// Floe owns in each note (src/floeMerge.ts), matched by `floe-id` and `floe-landscape`, so the
// person's writing survives. Renames follow (with links), removed objects are marked, never
// deleted. Every change is previewed first, and applies only if Floe hasn't changed since.
//
// The notes come from Floe's own exporter (GET /api/landscapes/:id/export?format=notes, the zip
// behind ⋯ → Export as folder of notes), with the connection's read-only token in the
// Authorization header and through the egress checks; the diagrams from its MCP tools. Nothing
// is sent to Floe but a landscape's id, and nothing in Floe changes.

import { strFromU8, unzipSync } from "fflate";
import { HttpError } from "./auth";
import { sql } from "./db";
import { emit } from "./events";
import { findBlocks, newBlock, renderBlock, resolve } from "./floeDiagrams";
import { dayLabel, insideLandscape, isRemoved, markRemoved, mergeNote, OVERVIEW_KEYS, shortHash } from "./floeMerge";
import { normalisePath, parseFrontmatter, titleFromPath } from "./markdown";
import { McpClient, McpError, outsideFetch } from "./mcpClient";
import { createNote, findByPath, freeNotePath, getNote, overwriteContent, renameNote } from "./notes";
import { open } from "./secrets";
import { assertRoom } from "./storage";
import { addNamedStarters } from "./transfer";

const NEEDS = "Connect Floe first: Settings → Connections.";
const AGAIN = "Floe needs connecting again: Settings → Connections.";
const MAX_ZIP = 20 * 1024 * 1024;
const MAX_FILE = 1024 * 1024;
const MAX_FILES = 3000;
const MAX_DIAGRAMS = 30;
const FLOE_ID = /^[\w-]{1,100}$/;

interface FloeConnection {
  id: number;
  address: string;
  auth: "token" | "oauth" | "none";
  token_enc: string | null;
}

async function connection(userId: number): Promise<FloeConnection> {
  const [c] = await sql<FloeConnection[]>`select id, address, auth, token_enc from connections where user_id = ${userId} and preset = 'floe' order by id limit 1`;
  if (!c) throw new HttpError(400, NEEDS);
  return c;
}

function token(c: FloeConnection): string {
  if (c.auth === "none" || !c.token_enc) return "";
  try {
    return open(c.token_enc);
  } catch {
    throw new HttpError(409, AGAIN);
  }
}

/** Floe's web address: its MCP address without /mcp. */
export function webOf(address: string): string {
  const u = new URL(address);
  u.pathname = u.pathname.replace(/\/mcp\/?$/, "/");
  u.search = "";
  u.hash = "";
  return u.toString().replace(/\/+$/, "");
}

function floeError(e: unknown): HttpError {
  if (e instanceof HttpError) return e;
  if (e instanceof McpError) return e.status === 401 ? new HttpError(409, AGAIN) : new HttpError(502, `Floe: ${e.message}`);
  return new HttpError(502, "Couldn't reach Floe");
}

async function call<T>(c: FloeConnection, tool: string, args: Record<string, unknown>): Promise<T> {
  try {
    return (await new McpClient(new URL(c.address), token(c)).call(tool, args)) as T;
  } catch (e) {
    throw floeError(e);
  }
}

function floeId(raw: unknown, what = "landscape"): string {
  const id = String(raw ?? "").trim();
  if (!FLOE_ID.test(id)) throw new HttpError(400, `That isn't a Floe ${what}`);
  return id;
}
const landscapeId = (raw: unknown) => floeId(raw);

// ── what the browser asks ─────────────────────────────────────────────────────────────────

/** Whether Floe is connected, and its web address for Open in Floe. */
export async function floeState(userId: number) {
  const [c] = await sql`select address from connections where user_id = ${userId} and preset = 'floe' order by id limit 1`;
  return { connected: !!c, web: c ? webOf(c.address) : null };
}

export async function landscapes(userId: number): Promise<{ id: string; name: string }[]> {
  const r = await call<{ landscapes?: { id: string; name: string }[] }>(await connection(userId), "list_landscapes", {});
  return (r?.landscapes ?? []).map((l) => ({ id: String(l.id), name: String(l.name) }));
}

export async function diagrams(userId: number, rawId: string): Promise<{ id: string; name: string }[]> {
  const r = await call<{ diagrams?: { id: string; name: string }[] }>(await connection(userId), "get_landscape", { landscapeId: landscapeId(rawId) });
  return (r?.diagrams ?? []).map((d) => ({ id: String(d.id), name: String(d.name) }));
}

export async function diagram(userId: number, rawId: string): Promise<{ text: string }> {
  const r = await call<{ text?: string } | string>(await connection(userId), "get_diagram", { diagramId: floeId(rawId, "diagram"), format: "mermaid" });
  const text = typeof r === "string" ? r : String(r?.text ?? "");
  if (!text.trim()) throw new HttpError(502, "Floe sent an empty diagram");
  return { text };
}

// ── the landscape's notes, from Floe's exporter ───────────────────────────────────────────

interface FloeFile {
  path: string;
  content: string;
}

async function exportFiles(c: FloeConnection, id: string): Promise<FloeFile[]> {
  const u = new URL(c.address);
  u.pathname = u.pathname.replace(/\/mcp\/?$/, "") + `/api/landscapes/${encodeURIComponent(id)}/export`;
  u.search = "?format=notes";
  const t = token(c);
  let res: Response;
  try {
    res = await outsideFetch(u, { headers: { ...(t ? { authorization: `Bearer ${t}` } : {}), accept: "application/zip" }, timeoutMs: 60_000 });
  } catch (e) {
    throw floeError(e);
  }
  if (res.status === 401 || res.status === 403) throw new HttpError(409, "Floe refused the token: connect it again in Settings → Connections.");
  if (res.status === 404) throw new HttpError(404, "Floe has no such landscape, or this token can't see it");
  if (!res.ok) throw new HttpError(502, `Floe answered ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > MAX_ZIP) throw new HttpError(413, "That landscape is too large to bring in (over 20 MB)");
  const zip = new Uint8Array(await res.arrayBuffer());
  if (zip.byteLength > MAX_ZIP) throw new HttpError(413, "That landscape is too large to bring in (over 20 MB)");
  let count = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(zip, {
      filter: (e) => {
        if (!/\.md$/i.test(e.name) || e.name.split("/").some((s) => s.startsWith(".") || s === "")) return false;
        if (++count > MAX_FILES || e.originalSize > MAX_FILE) throw new HttpError(413, "That landscape is too large to bring in");
        return true;
      },
    });
  } catch (e) {
    throw e instanceof HttpError ? e : new HttpError(502, "Floe didn't send a folder of notes");
  }
  const files = Object.entries(entries)
    .map(([path, data]) => ({ path: path.replace(/\\/g, "/"), content: strFromU8(data).replace(/\r\n/g, "\n") }))
    .filter((f) => f.path.includes("/"))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  if (!files.length) throw new HttpError(502, "Floe sent no notes for that landscape");
  return files;
}

/** What Floe's notes are now, as a short hash: the overview keeps it, to tell when Floe changed. */
const filesHash = (files: FloeFile[]) => shortHash(files.map((f) => `${f.path}\n${f.content}`).join("\n\u0000"));

const isOverview = (fm: Record<string, unknown>) => String(fm.type ?? "").toLowerCase() === "landscape" && fm["floe-id"] === undefined;
const like = (folder: string) => folder.replace(/[%_\\]/g, "\\$&") + "/%";
const dirOf = (path: string) => (path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "");
const baseOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

interface Row {
  id: number;
  path: string;
  content: string;
  frontmatter: Record<string, unknown>;
}

export interface Preview {
  landscape: { id: string; name: string };
  folder: string;
  /** Not here yet: this brings it in. */
  bring: boolean;
  /** What Floe's notes were when previewed; Update applies only if they still are. */
  hash: string;
  upToDate: boolean;
  notes: number;
  new: number;
  changed: number;
  renamed: { from: string; to: string }[];
  removed: string[];
  /** Notes whose Floe part the person had changed: Floe's replaces it. */
  edited: string[];
  /** Notes from an earlier plain import, given a Floe region now, their text kept below it. */
  adopted: string[];
  /** Notes with writing of the person's own, kept. */
  kept: number;
  types: string[];
  diagrams: number;
  overview: string;
}

interface Plan {
  preview: Preview;
  apply: (userId: number) => Promise<Applied>;
}

export interface Applied {
  created: number;
  changed: number;
  renamed: number;
  removed: number;
  typesAdded: string[];
  overview: string;
  /** Renames left undone because a note already had the name. */
  clashes: string[];
}

async function plan(userId: number, vaultId: number, rawId: string, wantedFolder?: string): Promise<Plan> {
  const id = landscapeId(rawId);
  const c = await connection(userId);
  const files = await exportFiles(c, id);
  const hash = filesHash(files);
  const name = files[0]!.path.split("/")[0]!;

  // The overview: by its landscape, else (an earlier plain import) the landscape note in the folder.
  const overviewFile = files.find((f) => isOverview(parseFrontmatter(f.content).data));
  let [overview] = await sql<Row[]>`select id, path, content, frontmatter from notes where vault_id = ${vaultId}
    and frontmatter->>'floe-landscape' = ${id} and not (frontmatter ? 'floe-id') order by id limit 1`;
  const folder = overview ? dirOf(overview.path) : normalisePath(wantedFolder?.trim() || `Architecture/${name}`, null);
  if (!overview && overviewFile) {
    const at = normalisePath(`${folder}/${insideLandscape(overviewFile.path)}`);
    const [there] = await sql<Row[]>`select id, path, content, frontmatter from notes where vault_id = ${vaultId} and lower(path) = lower(${at})`;
    if (there && isOverview(there.frontmatter ?? {})) overview = there;
  }

  // Its notes: by floe-landscape anywhere in the collection, or untagged ones (a plain import) in the folder.
  const rows = await sql<(Row & { fid: string })[]>`select id, path, content, frontmatter, frontmatter->>'floe-id' as fid from notes
    where vault_id = ${vaultId} and frontmatter ? 'floe-id'
      and (frontmatter->>'floe-landscape' = ${id} or (not (frontmatter ? 'floe-landscape') and path like ${like(folder)}))
    order by id`;
  const byFid = new Map<string, (typeof rows)[number]>();
  for (const r of rows) if (!byFid.has(r.fid)) byFid.set(r.fid, r);

  const extra = { "floe-landscape": id };
  const named = new Set<string>(overviewFile ? ["landscape"] : []);
  const creates: { path: string; content: string }[] = [];
  const changes: { row: Row; floe: string }[] = [];
  const renames: { row: Row; to: string }[] = [];
  const edited: string[] = [];
  const adopted: string[] = [];
  let kept = 0;
  const seen = new Set<string>();
  for (const f of files) {
    if (f === overviewFile) continue;
    const fm = parseFrontmatter(f.content).data;
    const fid = fm["floe-id"] === undefined ? "" : String(fm["floe-id"]);
    if (!fid) continue;
    seen.add(fid);
    if (fm.type) named.add(String(fm.type).toLowerCase());
    const target = normalisePath(`${folder}/${insideLandscape(f.path)}`);
    const row = byFid.get(fid);
    if (!row) {
      creates.push({ path: target, content: mergeNote(null, f.content, extra).content });
      continue;
    }
    const m = mergeNote(row.content, f.content, extra);
    // Moved out of the folder by the person: it stays where they put it, with Floe's name.
    const to = row.path === target ? row.path : row.path.startsWith(folder + "/") ? target : `${dirOf(row.path) ? dirOf(row.path) + "/" : ""}${baseOf(target)}`;
    if (to !== row.path) renames.push({ row, to });
    if (m.content !== row.content) {
      changes.push({ row, floe: f.content });
      if (m.edited) edited.push(row.path);
      if (m.adopted) adopted.push(row.path);
    }
    if (m.personal && (to !== row.path || m.content !== row.content)) kept++;
  }
  const removed = rows.filter((r) => byFid.get(r.fid) === r && !seen.has(r.fid) && !isRemoved(r.frontmatter));

  // The overview: Floe's own, then a Diagrams section with each diagram, filled.
  const list = (await call<{ diagrams?: { id: string; name: string }[] }>(c, "get_landscape", { landscapeId: id }))?.diagrams ?? [];
  const blocks: string[] = [];
  for (const d of list.slice(0, MAX_DIAGRAMS)) {
    const r = await call<{ text?: string } | string>(c, "get_diagram", { diagramId: String(d.id), format: "mermaid" });
    const text = typeof r === "string" ? r : String(r?.text ?? "");
    if (text.trim()) blocks.push(`### ${String(d.name).replace(/\n/g, " ")}\n\n${newBlock({ id: String(d.id), landscape: name, diagram: String(d.name) }, text)}`);
  }
  const ovFloe = parseFrontmatter(overviewFile?.content ?? "---\ntype: landscape\n---\n");
  const ovText = `---\n${ovFloe.raw || "type: landscape"}\n---\n${[ovFloe.body.trim(), blocks.length ? `## Diagrams\n\n${blocks.join("\n\n")}` : ""].filter(Boolean).join("\n\n")}\n`;
  const today = new Date().toISOString().slice(0, 10);
  const ovExtra = (day: string) => ({ "floe-landscape": id, "floe-updated": day, "floe-hash": hash });
  const ovPath = overview?.path ?? normalisePath(`${folder}/${overviewFile ? insideLandscape(overviewFile.path) : `${name}.md`}`);
  const kept0 = overview ? String(overview.frontmatter?.["floe-updated"] ?? today) : today;
  const ovSame = overview ? mergeNote(overview.content, ovText, ovExtra(kept0), OVERVIEW_KEYS).content === overview.content : false;
  const anything = creates.length + changes.length + renames.length + removed.length > 0 || !ovSame;

  const types = await addNamedStarters(vaultId, userId, named, { created: 0, errors: [] }, true);
  const preview: Preview = {
    landscape: { id, name },
    folder,
    bring: !overview,
    hash,
    upToDate: !anything,
    notes: files.length - (overviewFile ? 1 : 0),
    new: creates.length,
    changed: changes.length,
    renamed: renames.map((r) => ({ from: titleFromPath(r.row.path), to: titleFromPath(r.to) })),
    removed: removed.map((r) => titleFromPath(r.path)),
    edited: edited.map(titleFromPath),
    adopted: adopted.map(titleFromPath),
    kept,
    types,
    diagrams: blocks.length,
    overview: ovPath,
  };

  const apply = async (uid: number): Promise<Applied> => {
    await assertRoom(creates.reduce((n, x) => n + x.content.length, ovText.length));
    const report = { created: 0, errors: [] as { path: string; error: string }[] };
    const typesAdded = await addNamedStarters(vaultId, uid, named, report);
    const clashes: string[] = [];
    let renamed = 0;
    // Renames first, so links to the old names are rewritten before Floe's text arrives.
    for (const r of renames) {
      const taken = await findByPath(vaultId, r.to);
      if (taken && taken.id !== r.row.id) {
        clashes.push(titleFromPath(r.to));
        continue;
      }
      await renameNote(vaultId, r.row.id, r.to, uid, true);
      renamed++;
    }
    let created = 0;
    for (const x of creates) {
      const path = (await findByPath(vaultId, x.path)) ? await freeNotePath(vaultId, x.path) : x.path;
      await createNote(vaultId, uid, path, x.content);
      created++;
    }
    // Each against the live text, so someone typing in the note keeps what they type.
    for (const x of changes) await overwriteContent(x.row.id, (cur) => mergeNote(cur, x.floe, extra).content, uid, "floe");
    const day = dayLabel(new Date());
    for (const r of removed) await overwriteContent(r.id, (cur) => markRemoved(cur, day), uid, "floe");
    let overviewPath = ovPath;
    if (!overview) overviewPath = (await createNote(vaultId, uid, (await findByPath(vaultId, ovPath)) ? await freeNotePath(vaultId, ovPath) : ovPath, mergeNote(null, ovText, ovExtra(today), OVERVIEW_KEYS).content)).path;
    else if (anything) await overwriteContent(overview.id, (cur) => mergeNote(cur, ovText, ovExtra(today), OVERVIEW_KEYS).content, uid, "floe");
    emit(vaultId, { type: "vault.changed" });
    return { created, changed: changes.length, renamed, removed: removed.length, typesAdded, overview: overviewPath, clashes };
  };
  return { preview, apply };
}

/** What bringing in or updating would do. */
export async function previewLandscape(userId: number, vaultId: number, landscape: string, folder?: string): Promise<Preview> {
  return (await plan(userId, vaultId, landscape, folder)).preview;
}

/** Bring in or update, if Floe is as it was when previewed (`hash`). */
export async function applyLandscape(userId: number, vaultId: number, landscape: string, hash: string, folder?: string): Promise<Applied> {
  const p = await plan(userId, vaultId, landscape, folder);
  if (p.preview.hash !== hash) throw new HttpError(409, "Floe changed while you were looking: update again to see what changed.");
  return p.apply(userId);
}

/** Has Floe changed since the overview was last updated? One request to Floe (F41 decision 3). */
export async function landscapeStatus(userId: number, vaultId: number, landscape: string) {
  const id = landscapeId(landscape);
  const [ov] = await sql<Row[]>`select id, path, content, frontmatter from notes where vault_id = ${vaultId}
    and frontmatter->>'floe-landscape' = ${id} and not (frontmatter ? 'floe-id') order by id limit 1`;
  if (!ov) throw new HttpError(404, "That landscape isn't in this collection");
  const files = await exportFiles(await connection(userId), id);
  const updated = ov.frontmatter?.["floe-updated"];
  return { changed: filesHash(files) !== String(ov.frontmatter?.["floe-hash"] ?? ""), updated: updated ? String(updated) : null };
}

// ── diagram blocks in any note ────────────────────────────────────────────────────────────

/** Refresh every `%% floe:` diagram block in a note from Floe. */
export async function refreshDiagrams(userId: number, vaultId: number, noteId: number) {
  const note = await getNote(vaultId, noteId);
  const found = findBlocks(note.content);
  if (!found.length) return { updated: 0, problems: [] as string[] };
  const c = await connection(userId);
  const index: { id: string; landscape: string; diagram: string }[] = [];
  for (const l of (await call<{ landscapes?: { id: string; name: string }[] }>(c, "list_landscapes", {}))?.landscapes ?? []) {
    for (const d of (await call<{ diagrams?: { id: string; name: string }[] }>(c, "get_landscape", { landscapeId: String(l.id) }))?.diagrams ?? []) {
      index.push({ id: String(d.id), landscape: String(l.name), diagram: String(d.name) });
    }
  }
  const swaps: [string, string][] = [];
  const problems: string[] = [];
  for (const b of found) {
    const ref = resolve(index, b.ref);
    if (typeof ref === "string") {
      problems.push(ref);
      continue;
    }
    const r = await call<{ text?: string } | string>(c, "get_diagram", { diagramId: ref.id, format: "mermaid" });
    const text = typeof r === "string" ? r : String(r?.text ?? "");
    const next = renderBlock(b.text, ref, text);
    if (text.trim() && next !== b.text) swaps.push([b.text, next]);
  }
  if (swaps.length) {
    await overwriteContent(noteId, (cur) => swaps.reduce((t, [from, to]) => (t.includes(from) ? t.replace(from, () => to) : t), cur), userId, "floe");
  }
  return { updated: swaps.length, problems };
}

