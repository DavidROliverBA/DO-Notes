// AI-XF bundles (F9): a collection, or one folder of it, out as an AI-XF bundle that Longview and
// any other AI-XF reader takes as it is, and a bundle back in (see importBundle, transfer.ts).
// Spec: github.com/DavidROliverBA/ai-xf-format SPEC.md (v0.5; bundles say `ai-xf: "0.4"`).
//
// The one way relations are written stays Commonplace's (decided 2026-10-12): a property whose
// values are [[links]] (`attendees: ["[[Sam]]"]`). Export turns each into a typed link
// (`links: [{rel: attendees, to: sam-okafor}]`) and mirrors it as a body link (§6.4); import
// turns typed links back into properties. Frontmatter is written in AI-XF's canonical form on
// export only (src/aixfCanon.ts), never into the notes themselves.

import { posix } from "node:path";
import { strToU8, zipSync } from "fflate";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import pkg from "../package.json";
import { serialise, parse as canonParse } from "./aixfCanon";
import { idFor, kebabId } from "./aixfId";
import { isCanvasPath } from "./canvas";
import { sql } from "./db";
import { NOT_RELATIONS } from "./graphParts";
import { normalisePath, normaliseTarget, parseFrontmatter } from "./markdown";
import * as notes from "./notes";
import { withProperties } from "./props";
import { exportTree } from "./transfer";
import { linkTargets, RELS, TYPES_FOLDER } from "./types";
import { vaultKinds } from "./relationshipIndex";

export const MANIFEST = "manifest.ai-xf.yaml";
const AIXF_VERSION = "0.4";

/** Every core rel (§6.2) and registered extension with its inverse, both ways. */
const INVERSE: Record<string, string> = (() => {
  const pairs: [string, string][] = [
    ["relates-to", "relates-to"], ["part-of", "has-part"], ["depends-on", "depended-on-by"], ["references", "referenced-by"],
    ["derived-from", "source-of"], ["supersedes", "superseded-by"], ["contradicts", "contradicts"], ["supports", "supported-by"],
    ["merged-into", "merged-from"], ["split-from", "split-into"], ["imported", "exported-to"], ["authored-by", "author-of"],
    ["describes", "described-by"], ["depicts", "depicted-in"], ["remediates", "remediated-by"], ["discusses", "discussed-in"],
  ];
  const m: Record<string, string> = {};
  for (const [a, b] of pairs) ((m[a] = b), (m[b] = a));
  return m;
})();
export const inverseOf = (rel: string): string | null => INVERSE[rel] ?? null;

/** Keys AI-XF gives a meaning (§5.3, §5.4): never read as relations. */
const AIXF_KEYS = new Set(["type", "id", "title", "description", "resource", "tags", "aliases", "generated", "verified", "status", "stale_after", "sources", "usage_window", "provenance", "links", "media"]);
const AIXF_STATUS = new Set(["draft", "stable", "deprecated"]);
const TRUST_KEYS = ["provenance", "sources", "generated", "verified", "status", "stale_after"];

interface Row {
  id: number;
  path: string;
  title: string;
  content: string;
  frontmatter: Record<string, unknown>;
  link_names: string[] | null;
}

/** A link to something not in the collection that can still be written as a typed link: an id, or a namespace/id. */
const EXTERNAL = /^(?:[a-z0-9]+(?:-[a-z0-9]+)*\/)?[a-z0-9]+(?:-[a-z0-9]+)*$/;
/** index.md and log.md at a bundle's root are AI-XF's own (§3), not concepts: sent as they are. */
const RESERVED = new Set(["index.md", "log.md"]);
const prefixOf = (folder?: string) => (folder ? normalisePath(folder, null) + "/" : "");
const idOf = (r: Row) => (typeof r.frontmatter?.id === "string" ? (r.frontmatter.id as string) : null);

async function rowsIn(vaultId: number, folder?: string): Promise<Row[]> {
  const like = prefixOf(folder).replace(/[%_\\]/g, "\\$&") + "%";
  return sql<Row[]>`select id, path, title, content, frontmatter, link_names from notes where vault_id = ${vaultId} and path like ${like} and path ilike '%.md' order by path`;
}

/** The id a note gets for a bundle: a type note's says it's a type, so "Person" never clashes with a person. */
const idTitle = (r: Row) => (r.path.startsWith(`${TYPES_FOLDER}/`) ? `type ${r.title}` : r.title);

/** Notes in a collection (or folder) with no id yet, which a bundle needs (Level 1). */
export async function missingIds(vaultId: number, folder?: string): Promise<{ id: number; path: string }[]> {
  return (await conceptsIn(vaultId, folder)).filter((r) => !idOf(r)).map((r) => ({ id: r.id, path: r.path }));
}

/** The notes that are a bundle's concepts: all but its own index.md and log.md. */
async function conceptsIn(vaultId: number, folder?: string): Promise<Row[]> {
  const prefix = prefixOf(folder);
  return (await rowsIn(vaultId, folder)).filter((r) => !RESERVED.has(r.path.slice(prefix.length)));
}

/** Give every note without one its id, written into its properties (once; never changed after). */
export async function assignIds(vaultId: number, userId: number, folder?: string): Promise<number> {
  // From now on its new notes get an id as they're made.
  await sql`update vaults set aixf_ids = true where id = ${vaultId}`;
  const missing = (await conceptsIn(vaultId, folder)).filter((r) => !idOf(r));
  const taken = await notes.takenIds(vaultId);
  for (const r of missing) {
    const id = idFor(idTitle(r), taken);
    taken.add(id);
    // A function of the live text, so someone typing in it keeps what they typed.
    await notes.overwriteContent(r.id, (cur) => (parseFrontmatter(cur).data.id !== undefined ? cur : withProperties(cur, { id })), userId, "aixf");
  }
  return missing.length;
}

/** Resolve a [[link]] the way the server does (path, title, path suffix, then alias or id). */
function resolver(rows: Row[]) {
  const sans = (p: string) => p.replace(/\.md$/i, "").toLowerCase();
  const byPath = new Map(rows.map((r) => [sans(r.path), r]));
  const byTitle = new Map<string, Row>();
  const byName = new Map<string, Row>();
  for (const r of [...rows].sort((a, b) => a.path.length - b.path.length)) {
    if (!byTitle.has(r.title.toLowerCase())) byTitle.set(r.title.toLowerCase(), r);
    for (const n of r.link_names ?? []) if (!byName.has(n)) byName.set(n, r);
  }
  return (target: string): Row | undefined => {
    const t = normaliseTarget(target);
    return byPath.get(t) ?? byTitle.get(t) ?? rows.filter((r) => sans(r.path).endsWith("/" + t)).sort((a, b) => a.path.length - b.path.length)[0] ?? byName.get(t);
  };
}

/** A property that's a relation: every value a single [[link]] (§6: becomes a typed link). */
function relationTargets(key: string, value: unknown): string[] | null {
  if (NOT_RELATIONS.has(key.toLowerCase()) || AIXF_KEYS.has(key)) return null;
  const vals = Array.isArray(value) ? value : [value];
  if (!vals.length || !vals.every((v) => typeof v === "string" && /^\s*\[\[[^\]]+\]\]\s*$/.test(v))) return null;
  return linkTargets(value);
}

export interface BundleReport {
  concepts: number;
  links: number;
  /** Relation targets left out: not a note here, or outside the folder exported. */
  dropped: { note: string; target: string; why: string }[];
  /** Notes with no id (a viewer exporting): given one for this bundle only. */
  unnamed: number;
  /** Notes whose properties couldn't be read, sent as they are. */
  unreadable: string[];
}

/** The collection (or one folder) as an AI-XF bundle zip, Level 3. */
export async function exportBundle(vaultId: number, folder?: string): Promise<{ zip: Uint8Array; report: BundleReport }> {
  const prefix = prefixOf(folder);
  const rel = (path: string) => path.slice(prefix.length);
  const rows = await conceptsIn(vaultId, folder);
  const all = await rowsIn(vaultId);
  const resolve = resolver(all);
  const inBundle = new Set(rows.map((r) => r.id));
  const report: BundleReport = { concepts: 0, links: 0, dropped: [], unnamed: 0, unreadable: [] };

  // Ids for this bundle: each note's own; any without one (a viewer's export) gets one here only.
  const taken = await notes.takenIds(vaultId);
  const ids = new Map<number, string>();
  for (const r of rows) {
    let id = idOf(r);
    if (!id) {
      id = idFor(idTitle(r), taken);
      taken.add(id);
      report.unnamed++;
    }
    ids.set(r.id, id);
  }

  const byId = new Map(rows.map((r) => [ids.get(r.id)!.toLowerCase(), r]));
  const tree = await exportTree(vaultId, folder);
  delete tree[MANIFEST];
  const typesUsed = new Set<string>();
  const relsUsed = new Map<string, string>(); // rel → the property it came from
  for (const r of rows) {
    let fm: Record<string, unknown>;
    let body: string;
    try {
      const parsed = r.content.startsWith("---") ? canonParse(r.content) : { fm: {}, body: r.content };
      fm = { ...(parsed.fm as Record<string, unknown>) };
      body = parsed.body;
    } catch {
      report.unreadable.push(r.path);
      continue;
    }
    report.concepts++;
    const isType = r.path.startsWith(`${TYPES_FOLDER}/`);
    if (typeof fm.type !== "string" || !fm.type.trim()) fm.type = isType ? "Type" : "Note";
    typesUsed.add(fm.type as string);
    fm.id = ids.get(r.id)!;
    if (fm.title === undefined) fm.title = r.title;

    // Relations → typed links (§6.1), each mirrored in the body (§6.4).
    const links: Record<string, unknown>[] = Array.isArray(fm.links) ? [...(fm.links as Record<string, unknown>[])] : [];
    const have = new Set(links.map((l) => `${l?.rel}\u0000${l?.to}`));
    const mirror: Row[] = [];
    for (const [key, value] of Object.entries(fm)) {
      const targets = relationTargets(key, value);
      if (!targets) continue;
      delete fm[key];
      const relName = kebabId(key) || "relates-to";
      for (const t of targets) {
        const hit = resolve(t);
        let to: string;
        if (hit && inBundle.has(hit.id)) to = ids.get(hit.id)!;
        else if (hit && idOf(hit)) to = idOf(hit)!; // outside the folder exported: kept, by its id
        else if (EXTERNAL.test(t.trim())) to = t.trim(); // another bundle's id, or one not here yet (§9.2: tolerated)
        else {
          report.dropped.push({ note: r.path, target: t, why: hit ? "outside the folder exported, with no id" : "not a note in this collection" });
          continue;
        }
        if (have.has(`${relName}\u0000${to}`)) continue;
        have.add(`${relName}\u0000${to}`);
        links.push({ rel: relName, to });
        relsUsed.set(relName, key);
        if (hit && inBundle.has(hit.id)) mirror.push(hit);
        report.links++;
      }
    }
    for (const l of links) {
      if (typeof l?.rel === "string" && !relsUsed.has(l.rel)) relsUsed.set(l.rel, l.rel);
      // Typed links the note already had (an imported bundle's) are mirrored too.
      const target = typeof l?.to === "string" ? byId.get(l.to.toLowerCase()) : undefined;
      if (target && !mirror.includes(target)) mirror.push(target);
    }
    // A property whose name AI-XF gives another meaning (a project's `status: Paused`, where
    // AI-XF's is draft, stable or deprecated) travels under `commonplace:`, and comes back on import.
    const own: Record<string, unknown> = typeof fm.commonplace === "object" && fm.commonplace && !Array.isArray(fm.commonplace) ? { ...(fm.commonplace as Record<string, unknown>) } : {};
    if (fm.status !== undefined && !AIXF_STATUS.has(String(fm.status))) ((own.status = fm.status), delete fm.status);
    if (Object.keys(own).length) fm.commonplace = own;
    if (links.length) fm.links = links;
    if (!TRUST_KEYS.some((k) => fm[k] !== undefined)) fm.provenance = { source: "primary" };

    const here = posix.dirname(rel(r.path));
    const linked = new Set<string>();
    for (const m of body.matchAll(/\[[^\]]*\]\(<?([^)>]+)>?\)/g)) {
      const dest = decodeURI(m[1]!.split("#")[0]!.trim());
      linked.add(posix.normalize(posix.join(here, dest)));
    }
    const lines = mirror.filter((t, i, a) => a.indexOf(t) === i && !linked.has(rel(t.path))).map((t) => `- [${t.title}](<${posix.relative(here, rel(t.path))}>)`);
    if (lines.length) body = `${body.replace(/\s*$/, "")}\n\n## Related\n\n${lines.join("\n")}\n`;
    tree[rel(r.path)] = strToU8(serialise(fm as never, body));
  }

  // The manifest (§10.3): the collection keeps its own copy, so the namespace never changes and
  // keys added by hand survive (§10.2).
  const [v] = await sql`select name from vaults where id = ${vaultId}`;
  const kept = await collectionManifest(vaultId, v!.name as string);
  const ns = folder ? `${kept.namespace}-${kebabId(folder) || "folder"}` : (kept.namespace as string);
  const manifest = {
    ...kept,
    "ai-xf": AIXF_VERSION,
    name: folder ? `${v!.name} / ${folder}` : (kept.name ?? v!.name),
    namespace: ns,
    producer: `commonplace/${pkg.version}`,
    generated: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
    conformance: 3,
    vocabularies: { types: "vocab/types.json", rels: "vocab/rels.json" },
    counts: { concepts: report.concepts },
  };
  tree[MANIFEST] = strToU8(stringifyYaml(manifest));

  // The vocabularies (§9.3): the types and rels this bundle uses, with one-line definitions.
  const typeNotes = new Map(all.filter((r) => r.path.startsWith(`${TYPES_FOLDER}/`)).map((r) => [r.title, r]));
  const types = [...typesUsed].sort().map((name) => ({
    name,
    definition:
      typeof typeNotes.get(name)?.frontmatter?.description === "string"
        ? (typeNotes.get(name)!.frontmatter.description as string)
        : name === "Note"
          ? "A note with no particular type."
          : name === "Type"
            ? "A DO Notes type: the properties its notes have (Types/<name>.md)."
            : `A ${name} note.`,
  }));
  // The collection's own kinds (its Relationships note, F31) go whether used or not: they are its
  // vocabulary. Each says its other direction, so it comes back with both names.
  const { kinds } = await vaultKinds(vaultId);
  for (const k of kinds) if (k.source === "own" && !relsUsed.has(k.rel)) relsUsed.set(k.rel, k.rel);
  const rels = [...relsUsed].sort().map(([name, from]) => {
    const k = kinds.find((x) => x.rel === name);
    const core = RELS.find((x) => x.rel === name);
    // A relationship reversed into the other note (F31) is written under the other direction's
    // name (`comes-after`): it goes out as that name, its inverse the kind itself.
    const back = !k && !core && !inverseOf(name) ? kinds.find((x) => x.source === "own" && kebabId(x.inverse) === name) : undefined;
    if (back) return { name, label: back.inverse, definition: `The other direction of “${back.label}”${back.hint ? `: ${back.hint}` : ""}`, inverse: back.rel };
    const definition = k?.hint || (core ? core.hint : `From the DO Notes property “${from}”.`);
    const inverse = k?.source === "own" ? (k.inverse === k.label ? name : kebabId(k.inverse) || null) : inverseOf(name);
    return { name, ...(k && k.label !== name ? { label: k.label } : {}), definition, ...(inverse ? { inverse } : {}), ...(k?.source === "own" && k.inverse !== k.label ? { "inverse-label": k.inverse } : {}) };
  });
  tree["vocab/types.json"] = strToU8(JSON.stringify({ version: 1, values: types }, null, 2) + "\n");
  tree["vocab/rels.json"] = strToU8(JSON.stringify({ version: 1, values: rels }, null, 2) + "\n");

  const opts = Object.fromEntries(Object.entries(tree).map(([p, d]) => [p, [d, { level: /\.(md|json|yaml|csv|txt|svg|canvas)$/i.test(p) ? 6 : 0 }] as const]));
  return { zip: zipSync(opts as never), report };
}

/** The collection's own manifest.ai-xf.yaml, made on first export with a namespace from its name. */
async function collectionManifest(vaultId: number, name: string): Promise<Record<string, unknown>> {
  const [f] = await sql`select data from attachments where vault_id = ${vaultId} and path = ${MANIFEST}`;
  if (f) {
    try {
      const m = parseYaml(new TextDecoder().decode(f.data));
      if (m && typeof m === "object" && typeof (m as Record<string, unknown>).namespace === "string") return m as Record<string, unknown>;
    } catch {}
  }
  const fresh = { "ai-xf": AIXF_VERSION, name, namespace: kebabId(name) || `collection-${vaultId}` };
  const text = stringifyYaml(fresh);
  await sql`insert into attachments (vault_id, path, mime, size, data) values (${vaultId}, ${MANIFEST}, ${"application/yaml"}, ${text.length}, ${Buffer.from(text)})
            on conflict (vault_id, path) do update set data = excluded.data, size = excluded.size`;
  return fresh;
}
