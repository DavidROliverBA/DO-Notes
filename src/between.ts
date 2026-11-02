// Copying and moving notes from one vault to another (a GitHub vault is a vault like any other):
// one note or a whole folder, with the pictures and files its notes embed, and the type notes
// they use when the other vault hasn't got that type yet. Clashing paths keep both ("Plan 1").
// A move carries each note's history across and then sends the original to Trash, so it can be
// put back; files are only ever copied, never removed. Used by the app (POST /send) and by the
// assistant's copy_to_vault tool (src/tools.ts), always as the person, with their roles in both.

import { createHash } from "node:crypto";
import { HttpError, type User } from "./auth";
import { flushNote, kick } from "./collab";
import { sql } from "./db";
import { findWikiLinks, isAttachmentPath, normalisePath, normaliseTarget, parseFrontmatter, rewriteWikiLinks, titleFromPath } from "./markdown";
import * as notes from "./notes";
import { assertRoom } from "./storage";
import { mimeFor as mimeOf } from "./transfer";
import { typeOf, TYPES_FOLDER } from "./types";
import { viewsPath } from "./typeIndex";
import * as vaults from "./vaults";

export interface SendRequest {
  from: number;
  to: number;
  /** Notes to send, by id; or else `folder`, everything in it (and below). */
  notes?: number[];
  folder?: string;
  /** The folder in the other vault to put them in ("" is the top level). */
  into: string;
  move: boolean;
}

interface PlannedNote {
  id: number;
  path: string;
  to: string;
  content: string;
}
interface PlannedFile {
  path: string;
  to: string;
  size: number;
}

export interface SendPlan {
  from: { id: number; name: string };
  to: { id: number; name: string };
  move: boolean;
  notes: PlannedNote[];
  files: PlannedFile[];
  /** Type notes (Types/X.md) the other vault lacks, copied so the notes keep their type. */
  types: { path: string; content: string }[];
  /** Notes staying behind that link to a moved note: their links will no longer find it. */
  linkedFrom: number;
}

export interface SendReport {
  from: number;
  to: number;
  move: boolean;
  /** Each note made in the other vault (type notes included), for Undo. */
  created: { id: number; path: string; from: string | null }[];
  files: string[];
  /** The originals in Trash after a move, for Undo. */
  trashIds: number[];
}

const MAX_NOTES = 2000;
const parentOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const nameOf = (p: string) => p.slice(p.lastIndexOf("/") + 1);
const within = (into: string, rel: string) => (into ? `${into}/${rel}` : rel);

/** The vault a send goes to: 404 for one that isn't yours, as everywhere. */
async function vaultOf(user: User, id: number, min: vaults.Role) {
  await vaults.requireRole(id, user, min);
  const v = (await vaults.listVaults(user.id)).find((x) => x.id === id)!;
  return { id: v.id, name: v.name };
}

/** The attachment an embed means, resolved as the app shows it (src/api.ts /files). */
async function attachmentFor(vaultId: number, target: string) {
  const p = target.split("#")[0]!.trim();
  const [f] = await sql<{ path: string; size: number }[]>`
    select path, size from attachments
    where vault_id = ${vaultId} and (lower(path) = lower(${p}) or lower(path) like ${"%/" + p.toLowerCase().replace(/[%_\\]/g, "\\$&")})
    order by (lower(path) = lower(${p})) desc, length(path) limit 1`;
  return f ?? null;
}

/** Where a file lands: its own path if that's free, else "x 1.png" and so on; `copy` is false when
 *  the same bytes are already at that path (at its own name or a renamed one), so embeds point
 *  there and nothing is copied twice. */
async function freeFilePath(from: number, src: string, to: number, path: string, taken: Set<string>): Promise<{ at: string; copy: boolean }> {
  for (let i = 0; ; i++) {
    const p = i ? path.replace(/( \d+)?(\.[^.]+)$/, ` ${i}$2`) : path;
    if (taken.has(p.toLowerCase())) continue;
    const [there] = await sql`select md5(data) as h from attachments where vault_id = ${to} and lower(path) = lower(${p})`;
    if (!there) return { at: p, copy: true };
    const [mine] = await sql`select md5(data) as h from attachments where vault_id = ${from} and path = ${src}`;
    if (there.h === mine?.h) return { at: p, copy: false }; // already there
  }
}

/** What a send would do, worked out without writing. Notes are read live (unsaved typing too). */
export async function planSend(user: User, r: SendRequest): Promise<SendPlan> {
  if (r.from === r.to) throw new HttpError(400, "That's the collection they're in already");
  const from = await vaultOf(user, r.from, r.move ? "editor" : "viewer");
  const to = await vaultOf(user, r.to, "editor");
  const into = r.into ? normalisePath(r.into, null) : "";

  let picked: { id: number; path: string }[];
  let folder = "";
  if (r.notes?.length) {
    picked = await sql`select id, path from notes where vault_id = ${from.id} and id in ${sql(r.notes)} order by path`;
    if (picked.length !== new Set(r.notes).size) throw new HttpError(404, "Note not found");
  } else if (r.folder) {
    folder = normalisePath(r.folder, null);
    const like = folder.toLowerCase().replace(/[%_\\]/g, "\\$&") + "/%";
    picked = await sql`select id, path from notes where vault_id = ${from.id} and lower(path) like ${like} order by path`;
  } else throw new HttpError(400, "Say which notes or folder");
  if (picked.length > MAX_NOTES) throw new HttpError(400, `That's more than ${MAX_NOTES} notes: send a smaller folder`);
  // A folder keeps its name and layout inside `into`; a note goes straight in.
  const relOf = (p: string) => (folder ? `${nameOf(folder)}/${p.slice(folder.length + 1)}` : nameOf(p));

  const plan: SendPlan = { from, to, move: r.move, notes: [], files: [], types: [], linkedFrom: 0 };
  const takenNotes = new Set<string>();
  const freeNote = async (path: string) => {
    let p = await notes.freeNotePath(to.id, path);
    for (let i = 1; takenNotes.has(p.toLowerCase()); i++) p = await notes.freeNotePath(to.id, path.replace(/(\.md|\.canvas)$/i, ` ${i}$1`));
    takenNotes.add(p.toLowerCase());
    return p;
  };
  for (const n of picked) {
    await flushNote(n.id);
    const { content } = await notes.getNote(from.id, n.id);
    plan.notes.push({ id: n.id, path: n.path, to: await freeNote(within(into, relOf(n.path))), content });
  }

  // Files: everything under a sent folder, and whatever the notes embed.
  const takenFiles = new Set<string>();
  const files = new Map<string, PlannedFile | null>();
  /** Where each file is in the other collection afterwards, copied or already there. */
  const landsAt = new Map<string, string>();
  const addFile = async (path: string, size: number, dest: string) => {
    if (files.has(path)) return;
    const { at, copy } = await freeFilePath(from.id, path, to.id, dest, takenFiles);
    if (copy) takenFiles.add(at.toLowerCase());
    files.set(path, copy ? { path, to: at, size } : null);
    landsAt.set(path, at);
  };
  if (folder) {
    const like = folder.toLowerCase().replace(/[%_\\]/g, "\\$&") + "/%";
    for (const f of await sql<{ path: string; size: number }[]>`select path, size from attachments where vault_id = ${from.id} and lower(path) like ${like} order by path`) {
      await addFile(f.path, f.size, within(into, relOf(f.path)));
    }
  }
  for (const n of plan.notes) {
    for (const l of findWikiLinks(n.content)) {
      if (!l.embed || !isAttachmentPath(l.target)) continue;
      const f = await attachmentFor(from.id, l.target);
      if (!f) continue;
      await addFile(f.path, f.size, f.path); // kept where it was, so other notes find it too
      const at = landsAt.get(f.path)!;
      // Renamed to avoid a different file of the same name (or found already there under another
      // name): point the embed at where it is.
      if (at !== f.path) n.content = rewriteWikiLinks(n.content, (t) => t === normaliseTarget(l.target), at);
    }
  }
  // A folder lands under a new path, so links between its notes that spell out the path
  // ([[Work/Projects/Plan]]) follow them; links by name alone still find them by title.
  for (const n of plan.notes) {
    for (const m of plan.notes) {
      const old = m.path.replace(/\.md$/i, "");
      const now = m.to.replace(/\.md$/i, "");
      if (old.toLowerCase() === now.toLowerCase() || !old.includes("/")) continue;
      n.content = rewriteWikiLinks(n.content, (t) => t === normaliseTarget(old), now);
    }
  }

  // Types the other vault hasn't got, so a Meeting arrives as a Meeting.
  const typeNames = new Set(plan.notes.map((n) => typeOf(parseFrontmatter(n.content).data)).filter((t): t is string => !!t));
  for (const t of typeNames) {
    const path = normalisePath(`${TYPES_FOLDER}/${t}`);
    if (plan.notes.some((n) => n.to.toLowerCase() === path.toLowerCase())) continue;
    if (await notes.findByPath(to.id, path)) continue;
    const def = await notes.findByPath(from.id, path);
    if (!def) continue;
    await flushNote(def.id);
    plan.types.push({ path, content: (await notes.getNote(from.id, def.id)).content });
    const views = await sql<{ size: number }[]>`select size from attachments where vault_id = ${from.id} and path = ${viewsPath(t)}`;
    if (views.length) await addFile(viewsPath(t), views[0]!.size, viewsPath(t));
  }
  plan.files = [...files.values()].filter((f): f is PlannedFile => !!f);

  if (r.move) {
    const ids = new Set(plan.notes.map((n) => n.id));
    const linkers = new Set<number>();
    for (const n of plan.notes) for (const l of await notes.backlinks(from.id, n.id)) if (!ids.has(l.id)) linkers.add(l.id);
    plan.linkedFrom = linkers.size;
  }
  return plan;
}

/** One line saying what a plan does, for the assistant's preview and the app's dialog. */
export function describePlan(p: SendPlan): string {
  const what = p.notes.length === 1 ? `“${titleFromPath(p.notes[0]!.path)}”` : `${p.notes.length} notes`;
  const where = p.notes.length === 1 ? parentOf(p.notes[0]!.to) : "";
  const extras = [p.files.length ? `${p.files.length} file${p.files.length === 1 ? "" : "s"}` : "", p.types.length ? `the ${p.types.map((t) => titleFromPath(t.path)).join(", ")} type${p.types.length === 1 ? "" : "s"}` : ""].filter(Boolean);
  const links = p.linkedFrom ? `; ${p.linkedFrom} note${p.linkedFrom === 1 ? "" : "s"} left in ${p.from.name} link to ${p.notes.length === 1 ? "it" : "them"}` : "";
  return `${p.move ? "Move" : "Copy"} ${what} to ${p.to.name}${where ? ` (${where})` : ""}${extras.length ? `, with ${extras.join(" and ")}` : ""}${p.move ? `; the original${p.notes.length === 1 ? "" : "s"} go${p.notes.length === 1 ? "es" : ""} to Trash` : ""}${links}`;
}

/** Copy (or move) as planned. Plans again first, so it acts on the notes as they are now. */
export async function send(user: User, r: SendRequest): Promise<SendReport> {
  // A move closes the notes' live rooms first, so nobody types into an original on its way out.
  if (r.move) for (const n of (await planSend(user, r)).notes) kick({ noteId: n.id }, "note deleted");
  const p = await planSend(user, r);
  if (!p.notes.length) throw new HttpError(400, "There are no notes to send");
  // A move carries each note's history too (note_revisions), so that counts towards the room.
  const history = p.move
    ? Number((await sql`select coalesce(sum(octet_length(content)), 0)::bigint as b from note_revisions where note_id in ${sql(p.notes.map((n) => n.id))}`)[0]!.b)
    : 0;
  await assertRoom(p.notes.reduce((s, n) => s + Buffer.byteLength(n.content), 0) + p.files.reduce((s, f) => s + f.size, 0) + history);
  const report: SendReport = { from: p.from.id, to: p.to.id, move: p.move, created: [], files: [], trashIds: [] };

  for (const f of p.files) {
    await sql`insert into attachments (vault_id, path, mime, size, data, created_by)
              select ${p.to.id}, ${f.to}, mime, size, data, ${user.id} from attachments where vault_id = ${p.from.id} and path = ${f.path}
              on conflict (vault_id, path) do nothing`;
    report.files.push(f.to);
  }
  for (const t of p.types) {
    const made = await notes.createNote(p.to.id, user.id, t.path, t.content, false);
    report.created.push({ id: made.id, path: made.path, from: null });
  }
  for (const n of p.notes) {
    const made = await notes.createNote(p.to.id, user.id, n.to, await notes.keepIdIn(p.to.id, n.to, n.content), false);
    report.created.push({ id: made.id, path: made.path, from: n.path });
    if (!p.move) continue;
    // The note's history goes with it, and it keeps when and by whom it was made.
    await sql.begin(async (tx) => {
      await tx`update notes set created_by = o.created_by, created_at = o.created_at from notes o where o.id = ${n.id} and notes.id = ${made.id}`;
      await tx`insert into note_revisions (note_id, content, author_id, reason, created_at)
               select ${made.id}, content, author_id, reason, created_at from note_revisions where note_id = ${n.id} order by id`;
    });
    report.trashIds.push(await notes.deleteNote(p.from.id, n.id, user.id));
  }
  return report;
}

// ── between servers (F23): the Mac's Commonplace and the cloud's ─────────────────────────────
// A send across two servers is two calls the Mac makes in the person's name: bundle() on the
// side the notes come from, receive() on the side they go to, then (for a move) each original to
// Trash where it was. Same rules as send(): clashing paths keep both, files land once, the types
// the notes use come too, and a move carries each note's history.

const MAX_BUNDLE_BYTES = 100 * 1024 * 1024;

export interface Bundle {
  /** Each note, at its path relative to where it lands ("Plan.md", or "Folder/Sub/Plan.md"). */
  notes: { id: number; path: string; rel: string; content: string; created_at: string; revisions: { content: string; reason: string; created_at: string }[] }[];
  /** Files under a sent folder (at `rel`, inside it) and those the notes embed (`rel` null: kept
   *  at their own path, so other notes find them too). Bytes as base64. */
  files: { path: string; rel: string | null; data: string }[];
  types: { path: string; content: string }[];
}

/** Everything a send would take from this vault, for another server to receive. */
export async function bundle(user: User, vaultId: number, pick: { notes?: number[]; folder?: string; move?: boolean }): Promise<Bundle> {
  await vaults.requireRole(vaultId, user, pick.move ? "editor" : "viewer");
  let picked: { id: number; path: string }[];
  let folder = "";
  if (pick.notes?.length) {
    picked = await sql`select id, path from notes where vault_id = ${vaultId} and id in ${sql(pick.notes)} order by path`;
    if (picked.length !== new Set(pick.notes).size) throw new HttpError(404, "Note not found");
  } else if (pick.folder) {
    folder = normalisePath(pick.folder, null);
    picked = await sql`select id, path from notes where vault_id = ${vaultId} and lower(path) like ${folder.toLowerCase().replace(/[%_\\]/g, "\\$&") + "/%"} order by path`;
  } else throw new HttpError(400, "Say which notes or folder");
  if (picked.length > MAX_NOTES) throw new HttpError(400, `That's more than ${MAX_NOTES} notes: send a smaller folder`);
  const relOf = (p: string) => (folder ? `${nameOf(folder)}/${p.slice(folder.length + 1)}` : nameOf(p));

  const out: Bundle = { notes: [], files: [], types: [] };
  let bytes = 0;
  for (const n of picked) {
    await flushNote(n.id);
    const note = await notes.getNote(vaultId, n.id);
    const revisions = pick.move ? await sql<{ content: string; reason: string; created_at: string }[]>`select content, reason, created_at from note_revisions where note_id = ${n.id} order by id` : [];
    out.notes.push({ id: n.id, path: n.path, rel: relOf(n.path), content: note.content, created_at: note.created_at ? new Date(note.created_at).toISOString() : "", revisions: [...revisions] });
    bytes += Buffer.byteLength(note.content);
  }
  const seen = new Set<string>();
  const addFile = async (path: string, rel: string | null) => {
    if (seen.has(path)) return;
    seen.add(path);
    const [f] = await sql`select data from attachments where vault_id = ${vaultId} and path = ${path}`;
    if (!f) return;
    bytes += f.data.length;
    if (bytes > MAX_BUNDLE_BYTES) throw new HttpError(413, "That's more than 100 MB: send a smaller folder");
    out.files.push({ path, rel, data: Buffer.from(f.data).toString("base64") });
  };
  if (folder) for (const f of await sql`select path from attachments where vault_id = ${vaultId} and lower(path) like ${folder.toLowerCase().replace(/[%_\\]/g, "\\$&") + "/%"} order by path`) await addFile(f.path, relOf(f.path));
  for (const n of out.notes)
    for (const l of findWikiLinks(n.content)) {
      if (!l.embed || !isAttachmentPath(l.target)) continue;
      const f = await attachmentFor(vaultId, l.target);
      if (f) await addFile(f.path, null);
    }
  const typeNames = new Set(out.notes.map((n) => typeOf(parseFrontmatter(n.content).data)).filter((t): t is string => !!t));
  for (const t of typeNames) {
    const def = await notes.findByPath(vaultId, normalisePath(`${TYPES_FOLDER}/${t}`));
    if (!def) continue;
    await flushNote(def.id);
    out.types.push({ path: def.path, content: (await notes.getNote(vaultId, def.id)).content });
    await addFile(viewsPath(t), null);
  }
  return out;
}

/** Take a bundle from another server into `vaultId` (inside `into`), as send() would. */
export async function receive(user: User, vaultId: number, b: Bundle & { into: string; move: boolean }): Promise<Omit<SendReport, "from" | "trashIds">> {
  await vaults.requireRole(vaultId, user, "editor");
  const into = b.into ? normalisePath(b.into, null) : "";
  const files = b.files.map((f) => ({ ...f, bytes: new Uint8Array(Buffer.from(f.data, "base64")) }));
  await assertRoom(b.notes.reduce((s, n) => s + Buffer.byteLength(n.content) + n.revisions.reduce((r, x) => r + Buffer.byteLength(x.content), 0), 0) + files.reduce((s, f) => s + f.bytes.byteLength, 0));
  const report: Omit<SendReport, "from" | "trashIds"> = { to: vaultId, move: b.move, created: [], files: [] };

  // Files: each lands once; one already there with the same bytes is used where it is.
  const landsAt = new Map<string, string>();
  const taken = new Set<string>();
  for (const f of files) {
    const want = f.rel !== null ? within(into, f.rel) : normalisePath(f.path, null);
    for (let i = 0; ; i++) {
      const p = i ? want.replace(/( \d+)?(\.[^.]+)$/, ` ${i}$2`) : want;
      if (taken.has(p.toLowerCase())) continue;
      const [there] = await sql`select md5(data) as h from attachments where vault_id = ${vaultId} and lower(path) = lower(${p})`;
      if (there && there.h !== md5hex(f.bytes)) continue;
      taken.add(p.toLowerCase());
      landsAt.set(f.path, p);
      if (!there) {
        await sql`insert into attachments (vault_id, path, mime, size, data, created_by) values (${vaultId}, ${p}, ${mimeOf(p)}, ${f.bytes.byteLength}, ${f.bytes}, ${user.id}) on conflict (vault_id, path) do nothing`;
        report.files.push(p);
      }
      break;
    }
  }
  for (const t of b.types) {
    if (await notes.findByPath(vaultId, t.path)) continue;
    if (b.notes.some((n) => within(into, n.rel).toLowerCase() === t.path.toLowerCase())) continue;
    const made = await notes.createNote(vaultId, user.id, t.path, t.content, false);
    report.created.push({ id: made.id, path: made.path, from: null });
  }
  for (const n of b.notes) {
    let content = n.content;
    for (const [from, at] of landsAt) if (from !== at) content = rewriteWikiLinks(content, (t) => t === normaliseTarget(from) || t === normaliseTarget(nameOf(from)), at);
    const at = await notes.freeNotePath(vaultId, within(into, n.rel));
    const made = await notes.createNote(vaultId, user.id, at, await notes.keepIdIn(vaultId, at, content), false);
    report.created.push({ id: made.id, path: made.path, from: n.path });
    if (!b.move) continue;
    await sql.begin(async (tx) => {
      if (n.created_at) await tx`update notes set created_at = ${n.created_at} where id = ${made.id}`;
      for (const r of n.revisions) await tx`insert into note_revisions (note_id, content, author_id, reason, created_at) values (${made.id}, ${r.content}, ${user.id}, ${r.reason}, ${r.created_at})`;
    });
  }
  return report;
}

const md5hex = (b: Uint8Array) => createHash("md5").update(b).digest("hex");
