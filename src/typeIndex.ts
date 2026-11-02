// The server side of types (F16; the format is in src/types.ts): the vault's types and how many
// notes each has, the notes of one type with their properties (for type pages) and its saved
// views, which property a backlink comes through ("Attendee of"), what was made and changed on a
// day, and the type editor's saves and renames. Every change is written into the markdown.

import { HttpError } from "./auth";
import { sql } from "./db";
import { normalisePath, normaliseTarget } from "./markdown";
import * as notes from "./notes";
import { settings } from "./settings";
import { assertRoom } from "./storage";
import { withProperties } from "./props";
import { isTypePath, linkTargets, readTypeDef, type TypeDef, TYPES_FOLDER, type TypeShape, withTypeShape } from "./types";

/** The vault's types, defined (a note in Types/) or not yet (notes say `type: X` but there's no
 *  Types/X.md, as in a vault imported from another Markdown editor). */
export async function listTypes(vaultId: number): Promise<{ types: TypeDef[]; undefined: { name: string; count: number }[] }> {
  const [defs, counts] = await Promise.all([
    sql`select id, path, title, frontmatter from notes where vault_id = ${vaultId} and path ilike ${TYPES_FOLDER + "/%"}`,
    sql`select type_name as name, count(*)::int as n from notes where vault_id = ${vaultId} and type_name is not null group by type_name`,
  ]);
  const count = new Map<string, number>();
  for (const c of counts) count.set(String(c.name).toLowerCase(), (count.get(String(c.name).toLowerCase()) ?? 0) + Number(c.n));
  const types = defs
    .filter((d) => isTypePath(d.path))
    .map((d) => readTypeDef(d.title, d.frontmatter ?? {}, { noteId: Number(d.id), path: d.path, count: count.get(String(d.title).toLowerCase()) ?? 0 }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const known = new Set(types.map((t) => t.name.toLowerCase()));
  const undef = [...counts]
    .filter((c) => !known.has(String(c.name).toLowerCase()))
    .map((c) => ({ name: String(c.name), count: Number(c.n) }))
    .sort((a, b) => b.count - a.count);
  return { types, undefined: undef };
}

export interface TypedNote {
  id: number;
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  created_at: string;
  updated_at: string;
  /** Notes linking here: zero means an orphan. */
  backlinks: number;
}

/** The notes of one type, with their properties, for its page; and its saved views (a .base). */
export async function typeNotes(vaultId: number, name: string): Promise<{ notes: TypedNote[]; views: string | null }> {
  const typedHere = sql`and lower(n.type_name) = lower(${name})`;
  const rows = await sql`
    with k as (${notes.linkKeys(vaultId, typedHere)}),
    back as (
      select k.id, count(distinct l.source_id)::int as n
      from k join links l on l.vault_id = ${vaultId} and l.target = k.k and l.source_id <> k.id
      group by k.id
    )
    select n.id, n.path, n.title, n.tags, n.frontmatter, n.created_at, n.updated_at, coalesce(back.n, 0) as backlinks
    from notes n left join back on back.id = n.id
    where n.vault_id = ${vaultId} ${typedHere}
    order by lower(n.title)`;
  const [base] = await sql`select data from attachments where vault_id = ${vaultId} and lower(path) = lower(${viewsPath(name)})`;
  return { notes: rows.map((r) => ({ ...r, id: Number(r.id) }) as TypedNote), views: base ? Buffer.from(base.data).toString("utf8") : null };
}

/** A type's saved views live beside its note, as Bases (`.base`) files: Types/Person.base. */
export const viewsPath = (type: string) => normalisePath(`${TYPES_FOLDER}/${type}.base`, null);

export async function saveViews(vaultId: number, userId: number, type: string, yaml: string): Promise<void> {
  if (yaml.length > 100_000) throw new HttpError(413, "That view is too large");
  const path = viewsPath(type);
  const data = new TextEncoder().encode(yaml);
  await assertRoom(data.length);
  await sql`
    insert into attachments (vault_id, path, mime, size, data, created_by)
    values (${vaultId}, ${path}, 'text/yaml; charset=utf-8', ${data.length}, ${data}, ${userId})
    on conflict (vault_id, path) do update set data = excluded.data, size = excluded.size`;
}

/** Backlinks with the property each comes through, when it's a relation ("attendees"), so a
 *  Person page can say "Attendee of: 2 meetings". A link in the text has property null. */
export async function backlinksWithProperty(vaultId: number, noteId: number) {
  const me = await notes.getNote(vaultId, noteId);
  const keys = new Set([me.title.toLowerCase(), me.path.replace(/\.md$/i, "").toLowerCase()]);
  const pointsHere = (t: string) => {
    const n = normaliseTarget(t);
    return keys.has(n) || [...keys].some((k) => k.endsWith("/" + n));
  };
  const back = await notes.backlinks(vaultId, noteId);
  if (!back.length) return [];
  const rows = await sql`select id, frontmatter, type_name from notes where id in ${sql(back.map((b) => b.id))}`;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return back.map((b) => {
    const r = byId.get(Number(b.id));
    const fm = (r?.frontmatter ?? {}) as Record<string, unknown>;
    const properties = Object.entries(fm)
      .filter(([k, v]) => k !== "type" && linkTargets(v).some(pointsHere))
      .map(([k]) => k);
    return { ...b, type: (r?.type_name as string | null) ?? null, properties };
  });
}

/** The notes this note's properties link to, each with the property it's in (F31): this note's
 *  side of its relationships, as `backlinksWithProperty` is the other notes' side. */
export async function relationsFrom(vaultId: number, noteId: number) {
  const me = await notes.getNote(vaultId, noteId);
  const fm = (me.frontmatter ?? {}) as Record<string, unknown>;
  const out: { property: string; id: number; path: string; title: string; type: string | null }[] = [];
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(fm)) {
    if (k === "type") continue;
    for (const t of linkTargets(v)) {
      const hit = await notes.resolveLink(vaultId, t);
      if (!hit || Number(hit.id) === noteId || /\.canvas$/i.test(hit.path) || seen.has(`${k}\u0000${hit.id}`)) continue;
      seen.add(`${k}\u0000${hit.id}`);
      out.push({ property: k, id: Number(hit.id), path: hit.path, title: "", type: null });
    }
  }
  if (!out.length) return out;
  const rows = await sql`select id, title, type_name from notes where id in ${sql([...new Set(out.map((r) => r.id))])}`;
  const byId = new Map(rows.map((r) => [Number(r.id), r]));
  return out.map((r) => ({ ...r, title: (byId.get(r.id)?.title as string) ?? r.path, type: (byId.get(r.id)?.type_name as string | null) ?? null }));
}

/** Notes made and changed on a day (in the server's time zone), for a daily note's side panel:
 *  the day threads itself without any links written into it. */
export async function dayActivity(vaultId: number, day: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) throw new HttpError(400, "A day is YYYY-MM-DD");
  const tz = settings.timeZone;
  const [made, changed] = await Promise.all([
    sql`select id, path, title, type_name as type from notes
        where vault_id = ${vaultId} and (created_at at time zone ${tz})::date = ${day}::date
        order by created_at`,
    sql`select n.id, n.path, n.title, n.type_name as type from notes n
        where n.vault_id = ${vaultId} and (n.created_at at time zone ${tz})::date <> ${day}::date
          and ((n.updated_at at time zone ${tz})::date = ${day}::date
               or exists (select 1 from note_revisions r where r.note_id = n.id and (r.created_at at time zone ${tz})::date = ${day}::date))
        order by n.updated_at desc limit 100`,
  ]);
  const shape = (r: any) => ({ id: Number(r.id), path: r.path as string, title: r.title as string, type: (r.type as string | null) ?? null });
  return { made: made.map(shape), changed: changed.map(shape) };
}

/** The type editor's save: the type note's icon, colour and properties, merged into live typing;
 *  everything else in the note (its template, other keys) stays. */
export async function updateType(vaultId: number, userId: number, name: string, shape: TypeShape): Promise<void> {
  const def = (await listTypes(vaultId)).types.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!def) throw new HttpError(404, `There's no ${name} type`);
  const seen = new Set<string>();
  for (const p of shape.properties) {
    const n = p.name.trim();
    if (!n) throw new HttpError(400, "Every property needs a name");
    if (n.toLowerCase() === "type") throw new HttpError(400, "“type” is taken: it's what says a note is a " + def.name);
    if (seen.has(n.toLowerCase())) throw new HttpError(400, `There are two properties called “${n}”`);
    seen.add(n.toLowerCase());
  }
  await notes.overwriteContent(
    def.noteId,
    (cur) => {
      try {
        return withTypeShape(cur, { ...shape, properties: shape.properties.map((p) => ({ ...p, name: p.name.trim() })) });
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    },
    userId,
    "edit",
  );
}

/** Rename a type everywhere: its note (and links to it), every note's `type:`, other types'
 *  relations that point at it, and its saved views. Returns how many notes changed. */
export async function renameType(vaultId: number, userId: number, from: string, to: string): Promise<number> {
  const name = to.trim();
  if (!name || /[\\/#^[\]|:]/.test(name)) throw new HttpError(400, "A type's name can't contain / \\ # ^ [ ] | or :");
  const { types } = await listTypes(vaultId);
  const def = types.find((t) => t.name.toLowerCase() === from.toLowerCase());
  if (!def) throw new HttpError(404, `There's no ${from} type`);
  if (name === def.name) return 0;
  if (types.some((t) => t.name.toLowerCase() === name.toLowerCase() && t.noteId !== def.noteId)) throw new HttpError(409, `There's already a ${name} type`);
  // Which notes are of this type, before the rename's link update rewrites `type: "[[Person]]"`.
  const typed = await sql`select id from notes where vault_id = ${vaultId} and lower(type_name) = lower(${def.name})`;
  await notes.renameNote(vaultId, def.noteId, `${TYPES_FOLDER}/${name}`, userId, true);
  for (const t of typed) await notes.overwriteContent(Number(t.id), (cur) => withProperties(cur, { type: name }), userId, "edit");
  for (const other of types.filter((t) => t.noteId !== def.noteId && t.properties.some((p) => p.type?.toLowerCase() === def.name.toLowerCase()))) {
    const properties = other.properties.map((p) => (p.type?.toLowerCase() === def.name.toLowerCase() ? { ...p, type: name } : p));
    await notes.overwriteContent(other.noteId, (cur) => withTypeShape(cur, { icon: other.icon, colour: other.colour, properties, cards: other.cards }), userId, "edit");
  }
  const [base] = await sql`select id, data from attachments where vault_id = ${vaultId} and lower(path) = lower(${viewsPath(def.name)})`;
  if (base) {
    const yaml = Buffer.from(base.data).toString("utf8").replaceAll(`type == ${JSON.stringify(def.name)}`, `type == ${JSON.stringify(name)}`);
    await sql`update attachments set path = ${viewsPath(name)}, data = ${new TextEncoder().encode(yaml)} where id = ${base.id}`;
  }
  return typed.length;
}
