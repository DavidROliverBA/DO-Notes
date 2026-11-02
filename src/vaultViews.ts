// Small views across a vault: every task in one list, mentions of a note that don't link to it
// yet (with one-click linking), and a person's saved searches and bookmarks. Each change to a
// note goes through overwriteContent with a function, so it merges with whoever is typing in it.

import { HttpError } from "./auth";
import { sql } from "./db";
import { maskCode, parseFrontmatter } from "./markdown";
import * as notes from "./notes";
import { type Task, TASK, tasksIn } from "./tasks";

export { type Task, tasksIn };

// ── tasks ─────────────────────────────────────────────────────────────────────────────────

export async function vaultTasks(vaultId: number): Promise<Task[]> {
  const rows = await sql`
    select id, path, title, type_name, content from notes
    where vault_id = ${vaultId} and content ~ '\\[[ xX]\\]' order by updated_at desc limit 2000`;
  const out: Task[] = [];
  for (const r of rows) for (const t of tasksIn(r.content)) out.push({ noteId: Number(r.id), path: r.path, title: r.title, type: r.type_name ?? null, ...t });
  return out.slice(0, 5000);
}

/** Tick or untick one task. It's found by its line and text; if the line moved, by its text alone. */
export async function setTask(vaultId: number, noteId: number, userId: number, line: number, text: string, done: boolean): Promise<void> {
  await notes.getNote(vaultId, noteId);
  await notes.overwriteContent(
    noteId,
    (cur) => {
      const lines = cur.split("\n");
      const tasks = tasksIn(cur);
      const hit = tasks.find((t) => t.line === line && t.text === text) ?? (tasks.filter((t) => t.text === text).length === 1 ? tasks.find((t) => t.text === text) : undefined);
      if (!hit) throw new HttpError(409, "That task has changed since the list was loaded. Reload and try again.");
      lines[hit.line] = lines[hit.line]!.replace(TASK, (_, a, _b, c, d) => `${a}${done ? "x" : " "}${c}${d}`);
      return lines.join("\n");
    },
    userId,
  );
}

// ── unlinked mentions ─────────────────────────────────────────────────────────────────────

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Where a title appears in text as a whole word, outside links, code and frontmatter. */
function mentionAt(content: string, title: string): number {
  const fm = parseFrontmatter(content);
  const start = content.length - fm.body.length;
  // Blank out code and existing links so they never count.
  const masked = maskCode(content).replace(/!?\[\[[^\]\n]*\]\]|\[[^\]\n]*\]\([^)\n]*\)/g, (m) => " ".repeat(m.length));
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRe(title)}(?![\\p{L}\\p{N}_])`, "iu");
  const m = re.exec(masked.slice(start));
  return m ? start + m.index : -1;
}

/** Notes that mention this one by its title without linking to it, with the words around it. */
export async function unlinkedMentions(vaultId: number, noteId: number) {
  const me = await notes.getNote(vaultId, noteId);
  if (me.title.length < 3) return [];
  const linkers = new Set((await notes.backlinks(vaultId, noteId)).map((b) => Number(b.id)));
  const rows = await sql`
    select id, path, title, content from notes
    where vault_id = ${vaultId} and id <> ${noteId} and position(lower(${me.title}) in lower(content)) > 0
    order by updated_at desc limit 200`;
  const out: { id: number; path: string; title: string; snippet: string }[] = [];
  for (const r of rows) {
    if (linkers.has(Number(r.id))) continue;
    const at = mentionAt(r.content, me.title);
    if (at < 0) continue;
    const from = Math.max(0, at - 60);
    const snippet = (from ? "…" : "") + r.content.slice(from, at + me.title.length + 60).replace(/\s+/g, " ").trim() + "…";
    out.push({ id: Number(r.id), path: r.path, title: r.title, snippet });
    if (out.length >= 30) break;
  }
  return out;
}

/** Turn the first unlinked mention of this note in `sourceId` into a [[link]], keeping its words. */
export async function linkMention(vaultId: number, noteId: number, sourceId: number, userId: number): Promise<void> {
  const me = await notes.getNote(vaultId, noteId);
  await notes.getNote(vaultId, sourceId);
  await notes.overwriteContent(
    sourceId,
    (cur) => {
      const at = mentionAt(cur, me.title);
      if (at < 0) throw new HttpError(409, `That note doesn't mention “${me.title}” any more`);
      const said = cur.slice(at, at + me.title.length);
      return cur.slice(0, at) + (said === me.title ? `[[${me.title}]]` : `[[${me.title}|${said}]]`) + cur.slice(at + me.title.length);
    },
    userId,
  );
}

// ── saved searches ────────────────────────────────────────────────────────────────────────

export async function savedSearches(userId: number, vaultId: number): Promise<{ id: number; query: string }[]> {
  const rows = await sql`select id, query from saved_searches where user_id = ${userId} and vault_id = ${vaultId} order by created_at, id`;
  return rows.map((r) => ({ id: Number(r.id), query: r.query as string }));
}

export async function saveSearch(userId: number, vaultId: number, query: string) {
  const q = query.trim();
  if (!q) throw new HttpError(400, "Search for something first");
  const [{ n }] = (await sql`select count(*)::int as n from saved_searches where user_id = ${userId} and vault_id = ${vaultId}`) as any;
  if (n >= 50) throw new HttpError(400, "That's 50 saved searches already: remove one first");
  await sql`insert into saved_searches (user_id, vault_id, query) values (${userId}, ${vaultId}, ${q}) on conflict do nothing`;
  return savedSearches(userId, vaultId);
}

export async function removeSearch(userId: number, vaultId: number, id: number) {
  await sql`delete from saved_searches where id = ${id} and user_id = ${userId} and vault_id = ${vaultId}`;
  return savedSearches(userId, vaultId);
}

// ── bookmarks ─────────────────────────────────────────────────────────────────────────────

export async function bookmarks(userId: number, vaultId: number): Promise<number[]> {
  const rows = await sql`select note_id from bookmarks where user_id = ${userId} and vault_id = ${vaultId} order by created_at`;
  return rows.map((r) => Number(r.note_id));
}

export async function setBookmark(userId: number, vaultId: number, noteId: number, on: boolean): Promise<number[]> {
  await notes.getNote(vaultId, noteId);
  if (on) await sql`insert into bookmarks (user_id, vault_id, note_id) values (${userId}, ${vaultId}, ${noteId}) on conflict do nothing`;
  else await sql`delete from bookmarks where user_id = ${userId} and note_id = ${noteId}`;
  return bookmarks(userId, vaultId);
}
