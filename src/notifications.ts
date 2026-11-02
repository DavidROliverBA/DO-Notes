// Notifications and activity (F39, docs/design/F39.md): what's new for a person, shown under the
// bell in DO Notes and as alerts by the iPhone and Mac apps when they refresh (no push service). Made
// for: a mention of you (@Name or [[Full Name]]) newly written in a note or comment you can see;
// an invitation to a collection, and your invitation accepted; someone else changing a note you
// follow (at most once an hour per note); a comment on your note, or a reply to yours (L3). Never
// for what you did yourself. "Since you last looked" lists the notes others changed in a
// collection since you marked it seen.

import { sql } from "./db";
import { namesPerson } from "./reminders";

export type Kind = "mention" | "invite" | "accepted" | "follow" | "comment";

const FOLLOW_GAP_MS = 60 * 60_000;
const KEEP = 200;

export async function notify(n: { userId: number; kind: Kind; actorId: number | null; vaultId?: number | null; noteId?: number | null; text: string }): Promise<void> {
  if (n.actorId !== null && n.actorId === n.userId) return;
  await sql`insert into notifications (user_id, kind, actor_id, vault_id, note_id, text)
            values (${n.userId}, ${n.kind}, ${n.actorId}, ${n.vaultId ?? null}, ${n.noteId ?? null}, ${n.text.slice(0, 300)})`;
  // Keep the newest few hundred each.
  await sql`delete from notifications where user_id = ${n.userId} and id not in (select id from notifications where user_id = ${n.userId} order by id desc limit ${KEEP})`;
}

/** The line a mention shows: the words around it, as plain text. */
function around(content: string, name: string): string {
  const first = name.trim().split(/\s+/)[0]!;
  const i = Math.max(content.toLowerCase().indexOf(`@${first.toLowerCase()}`), content.toLowerCase().indexOf(`[[${name.toLowerCase()}`));
  const line = i >= 0 ? content.slice(content.lastIndexOf("\n", i) + 1, content.indexOf("\n", i) < 0 ? undefined : content.indexOf("\n", i)) : "";
  return line.replace(/[#>*_`~-]+\s*/g, "").replace(/\s+/g, " ").trim().slice(0, 160);
}

/** After a note is saved: mentions newly written in it, and followers told (not the one who wrote). */
export async function afterEdit(noteId: number, vaultId: number, before: string, after: string, actorId: number | null): Promise<void> {
  const [note] = await sql`select title from notes where id = ${noteId}`;
  if (!note) return;
  const [actor] = actorId ? await sql`select name from users where id = ${actorId}` : [];
  const who = actor?.name ?? "Someone";
  const members = await sql`select u.id, u.name from vault_members m join users u on u.id = m.user_id where m.vault_id = ${vaultId}`;
  for (const m of members) {
    if (Number(m.id) === actorId) continue;
    if (namesPerson(after, m.name) && !namesPerson(before, m.name)) {
      await notify({ userId: Number(m.id), kind: "mention", actorId, vaultId, noteId, text: `${who} mentioned you in “${note.title}”: ${around(after, m.name)}` });
    }
  }
  const followers = await sql`
    select f.user_id from note_follows f join vault_members m on m.user_id = f.user_id and m.vault_id = ${vaultId}
    where f.note_id = ${noteId} and f.user_id <> ${actorId ?? 0}
      and not exists (select 1 from notifications n where n.user_id = f.user_id and n.note_id = ${noteId} and n.kind = 'follow' and n.created_at > now() - ${`${FOLLOW_GAP_MS / 1000} seconds`}::interval)`;
  for (const f of followers) await notify({ userId: Number(f.user_id), kind: "follow", actorId, vaultId, noteId, text: `${who} changed “${note.title}”` });
}

export async function follow(userId: number, noteId: number, on: boolean): Promise<boolean> {
  if (on) await sql`insert into note_follows (user_id, note_id) values (${userId}, ${noteId}) on conflict do nothing`;
  else await sql`delete from note_follows where user_id = ${userId} and note_id = ${noteId}`;
  return on;
}

export async function following(userId: number, noteId: number): Promise<boolean> {
  return (await sql`select 1 from note_follows where user_id = ${userId} and note_id = ${noteId}`).length > 0;
}

/** The bell's list: the newest first, with who and where, and how many are unread. Only for
 *  collections the person is still in. */
export async function list(userId: number, since = 0) {
  const rows = await sql`
    select n.id, n.kind, n.text, n.vault_id, n.note_id, n.created_at, n.read_at, u.name as actor
    from notifications n left join users u on u.id = n.actor_id
    where n.user_id = ${userId} and n.id > ${since}
      and (n.vault_id is null or n.kind = 'invite' or exists (select 1 from vault_members m where m.vault_id = n.vault_id and m.user_id = ${userId}))
    order by n.id desc limit 50`;
  const [{ unread }] = (await sql`select count(*)::int as unread from notifications where user_id = ${userId} and read_at is null`) as unknown as [{ unread: number }];
  return {
    unread,
    items: rows.map((r) => ({ id: Number(r.id), kind: r.kind as Kind, text: r.text, vaultId: r.vault_id ? Number(r.vault_id) : null, noteId: r.note_id ? Number(r.note_id) : null, actor: r.actor ?? null, at: new Date(r.created_at).toISOString(), read: !!r.read_at })),
  };
}

export async function markRead(userId: number, ids: number[] | "all"): Promise<void> {
  if (ids === "all") await sql`update notifications set read_at = now() where user_id = ${userId} and read_at is null`;
  else if (ids.length) await sql`update notifications set read_at = now() where user_id = ${userId} and id in ${sql(ids)} and read_at is null`;
}

/** Since you last looked: notes others made or changed in a collection since you marked it seen
 *  (the first time, the last week), newest first, with who. */
export async function activity(userId: number, vaultId: number) {
  const [seen] = await sql`select seen_at from vault_seen where user_id = ${userId} and vault_id = ${vaultId}`;
  const since = seen?.seen_at ? new Date(seen.seen_at) : new Date(Date.now() - 7 * 86_400_000);
  const rows = await sql`
    select n.id, n.title, n.path, n.updated_at, n.created_at, u.name as by
    from notes n left join users u on u.id = n.updated_by
    where n.vault_id = ${vaultId} and n.updated_at > ${since} and n.updated_by is distinct from ${userId}
    order by n.updated_at desc limit 50`;
  return {
    since: since.toISOString(),
    notes: rows.map((r) => ({ id: Number(r.id), title: r.title, path: r.path, by: r.by ?? null, at: new Date(r.updated_at).toISOString(), made: new Date(r.created_at) > since })),
  };
}

export async function markSeen(userId: number, vaultId: number): Promise<void> {
  await sql`insert into vault_seen (user_id, vault_id, seen_at) values (${userId}, ${vaultId}, now()) on conflict (user_id, vault_id) do update set seen_at = now()`;
}
