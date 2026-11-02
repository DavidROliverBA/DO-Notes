// The graph (after Capacities): every note with its type, tags and whether it's a daily note, and
// every link between notes. A link that comes from a property (`attendees: [[Sam]]`) carries the
// property's name as its label, so the graph says why two notes are joined. The vault's types
// come too, for their icons and colours. Each note has a date for the timeline (F21), from the
// note itself where it says one, since imported notes were all "made" on the day of the import.
// The browser does the rest: centring, depth, filters, the timeline's range.

import { sql } from "./db";
import { DAILY, NOT_RELATIONS, NOT_WHEN, noteWhen, targetsIn } from "./graphParts";
import { linkKeys } from "./notes";
import { settings } from "./settings";
import { listTypes } from "./typeIndex";

export { noteWhen };

export async function graph(vaultId: number) {
  const rows = await sql<{ id: number; title: string; path: string; type: string | null; tags: string[]; frontmatter: Record<string, unknown>; made: string }[]>`
    select id, title, path, type_name as type, tags, frontmatter,
           to_char(created_at at time zone ${settings.timeZone}, 'YYYY-MM-DD') as made
    from notes where vault_id = ${vaultId}`;
  // Which property each source note links a target through: "source key" → property names.
  const via = new Map<string, string[]>();
  for (const r of rows) {
    for (const [prop, value] of Object.entries(r.frontmatter ?? {})) {
      if (NOT_RELATIONS.has(prop.toLowerCase())) continue;
      for (const t of targetsIn(value)) {
        const k = `${r.id} ${t}`;
        const names = via.get(k) ?? [];
        if (!names.includes(prop)) via.set(k, [...names, prop]);
      }
    }
  }
  const links = await sql<{ source: number; target: number; key: string }[]>`
    with k as (${linkKeys(vaultId)})
    select distinct l.source_id as source, k.id as target, l.target as key
    from links l join k on k.k = l.target
    where l.vault_id = ${vaultId} and l.source_id <> k.id`;
  const edges = new Map<string, { source: number; target: number; label: string | null }>();
  for (const l of links) {
    const id = `${l.source} ${l.target}`;
    const label = via.get(`${l.source} ${l.key}`)?.sort().join(", ") ?? null; // jsonb keeps no order: alphabetical
    const had = edges.get(id);
    if (!had || (!had.label && label)) edges.set(id, { source: Number(l.source), target: Number(l.target), label });
  }
  const { types } = await listTypes(vaultId);
  const datePropOf = new Map(types.map((t) => [t.name.toLowerCase(), t.timeline ?? t.properties.find((p) => p.kind === "date" && !NOT_WHEN.test(p.name))?.name ?? null]));
  return {
    nodes: rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      path: r.path,
      type: r.type,
      tags: r.tags,
      daily: DAILY.test(r.path),
      ...noteWhen(r, datePropOf.get((r.type ?? "").toLowerCase()) ?? null),
    })),
    edges: [...edges.values()],
    types: types.map((t) => ({ name: t.name, icon: t.icon, colour: t.colour })),
  };
}
