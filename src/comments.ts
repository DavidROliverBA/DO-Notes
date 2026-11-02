// Comments on notes (L3, docs/design/L3.md): threads beside a note, never in its Markdown. A
// thread starts on the words someone selected (`quote`), anchored by Yjs relative positions the
// browser makes from the live text (`anchor_from`, `anchor_to`), so it stays on those words while
// anyone edits around them; replies hang off it. Editors and owners comment and resolve; viewers
// read. A comment tells the note's writer, a reply the thread's starter, and @Name anyone named
// (F39). Exports carry them beside each note (.comments/<path>.md).

import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { emit } from "./events";
import { notify } from "./notifications";
import { namesPerson } from "./reminders";

const MAX_BODY = 5000;

export interface CommentRow {
  id: number;
  parentId: number | null;
  author: string | null;
  authorId: number | null;
  quote: string;
  from: string | null;
  to: string | null;
  body: string;
  at: string;
  edited: boolean;
  resolved: boolean;
}

export async function listComments(vaultId: number, noteId: number): Promise<CommentRow[]> {
  const rows = await sql`
    select c.*, u.name as author from comments c left join users u on u.id = c.author_id
    where c.vault_id = ${vaultId} and c.note_id = ${noteId} order by c.created_at, c.id`;
  return rows.map((r) => ({
    id: Number(r.id),
    parentId: r.parent_id ? Number(r.parent_id) : null,
    author: r.author ?? null,
    authorId: r.author_id ? Number(r.author_id) : null,
    quote: r.quote,
    from: r.anchor_from,
    to: r.anchor_to,
    body: r.body,
    at: new Date(r.created_at).toISOString(),
    edited: !!r.edited_at,
    resolved: !!r.resolved_at,
  }));
}

export async function addComment(vaultId: number, noteId: number, user: User, b: { body: string; quote?: string; from?: string; to?: string; parentId?: number }): Promise<CommentRow[]> {
  const body = b.body.trim();
  if (!body) throw new HttpError(400, "Write something to comment");
  const [note] = await sql`select title, created_by from notes where id = ${noteId} and vault_id = ${vaultId}`;
  if (!note) throw new HttpError(404, "Note not found");
  let parent: { author_id: number | null } | undefined;
  if (b.parentId) {
    [parent] = (await sql`select author_id from comments where id = ${b.parentId} and note_id = ${noteId} and parent_id is null`) as unknown as { author_id: number | null }[];
    if (!parent) throw new HttpError(404, "That comment has gone");
  }
  await sql`
    insert into comments (vault_id, note_id, author_id, parent_id, quote, anchor_from, anchor_to, body)
    values (${vaultId}, ${noteId}, ${user.id}, ${b.parentId ?? null}, ${b.parentId ? "" : (b.quote ?? "").slice(0, 500)}, ${b.parentId ? null : (b.from ?? null)}, ${b.parentId ? null : (b.to ?? null)}, ${body.slice(0, MAX_BODY)})`;
  // F39: the note's writer, the thread's starter, and anyone named.
  const short = body.replace(/\s+/g, " ").slice(0, 120);
  const told = new Set<number>();
  const tell = async (id: number | null, text: string, kind: "comment" | "mention") => {
    if (!id || id === user.id || told.has(id)) return;
    told.add(id);
    await notify({ userId: id, kind, actorId: user.id, vaultId, noteId, text });
  };
  const members = await sql`select u.id, u.name from vault_members m join users u on u.id = m.user_id where m.vault_id = ${vaultId}`;
  for (const m of members) if (namesPerson(body, m.name)) await tell(Number(m.id), `${user.name} mentioned you in a comment on “${note.title}”: ${short}`, "mention");
  if (parent) await tell(parent.author_id ? Number(parent.author_id) : null, `${user.name} replied on “${note.title}”: ${short}`, "comment");
  await tell(note.created_by ? Number(note.created_by) : null, `${user.name} commented on “${note.title}”: ${short}`, "comment");
  emit(vaultId, { type: "comments.changed", noteId, by: user.id });
  return listComments(vaultId, noteId);
}

/** Resolve or reopen a thread (any editor), or change your own comment's words. */
export async function changeComment(vaultId: number, noteId: number, commentId: number, user: User, b: { resolved?: boolean; body?: string }): Promise<CommentRow[]> {
  const [c] = await sql`select author_id, parent_id from comments where id = ${commentId} and note_id = ${noteId} and vault_id = ${vaultId}`;
  if (!c) throw new HttpError(404, "That comment has gone");
  if (b.body !== undefined) {
    if (Number(c.author_id) !== user.id) throw new HttpError(403, "Only its writer can change a comment");
    if (!b.body.trim()) throw new HttpError(400, "A comment needs words");
    await sql`update comments set body = ${b.body.trim().slice(0, MAX_BODY)}, edited_at = now() where id = ${commentId}`;
  }
  if (b.resolved !== undefined) {
    const thread = c.parent_id ? Number(c.parent_id) : commentId;
    await sql`update comments set resolved_at = ${b.resolved ? sql`now()` : null}, resolved_by = ${b.resolved ? user.id : null} where id = ${thread}`;
  }
  emit(vaultId, { type: "comments.changed", noteId, by: user.id });
  return listComments(vaultId, noteId);
}

/** A note's comments as Markdown, for exports: each thread under its quote, replies beneath. */
export function commentsMarkdown(title: string, rows: CommentRow[]): string {
  const threads = rows.filter((r) => !r.parentId);
  const line = (r: CommentRow) => `**${r.author ?? "Someone"}**, ${r.at.slice(0, 16).replace("T", " ")}: ${r.body.replace(/\n/g, "\n  ")}`;
  return (
    `# Comments on ${title}\n\n` +
    threads
      .map((t) => {
        const replies = rows.filter((r) => r.parentId === t.id).map((r) => `  - ${line(r)}`);
        return [t.quote ? `> ${t.quote.replace(/\n/g, "\n> ")}` : "", `- ${line(t)}${t.resolved ? " *(resolved)*" : ""}`, ...replies].filter(Boolean).join("\n");
      })
      .join("\n\n") +
    "\n"
  );
}
