// The kinds of relationship a collection uses (F31 step 2). One list, kept as a Markdown note at
// the collection's root (`Relationships.md`, beside `Types/`), so it travels with the files: a
// table of each kind's name, its name in the other direction, and what it means. The list a
// person sees is that note's kinds, then the relations the types define, then AI-XF's core kinds
// (src/types.ts RELS). Export writes it as `vocab/rels.json`; import adds a bundle's kinds to it.
// Shared with the browser: no server imports.

import { kebabId } from "./aixfId";
import { RELS, type Rel } from "./types";

export const RELATIONSHIPS_NOTE = "Relationships.md";

export interface Kind extends Rel {
  /** Where it comes from: the collection's own note, a type's relation property, or AI-XF. */
  source: "own" | "type" | "core";
  /** For a type's relation: the type that defines it. */
  type?: string;
}

const HEAD = /^\s*\|?\s*relationship\s*\|/i;
const RULE = /^\s*\|?\s*:?-{2,}/;

function cells(line: string): string[] {
  const t = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, "|").trim());
}

const symmetric = (s: string) => !s || /^[-—–]+$/.test(s);

/** The kinds the note's table lists, in its order. Rows without a name, and repeats, are skipped. */
export function parseRelationships(md: string): Kind[] {
  const out: Kind[] = [];
  const seen = new Set<string>();
  let inTable = false;
  for (const line of md.split("\n")) {
    if (HEAD.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.trim().startsWith("|")) {
      inTable = false;
      continue;
    }
    if (RULE.test(line)) continue;
    const [name = "", other = "", meaning = ""] = cells(line);
    const rel = kebabId(name);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push({ rel, label: name, inverse: symmetric(other) ? name : other, hint: meaning, source: "own" });
  }
  return out;
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const row = (k: { label: string; inverse: string; hint: string }) => `| ${esc(k.label)} | ${k.inverse === k.label ? "—" : esc(k.inverse)} | ${esc(k.hint)} |`;

/** A new Relationships note with these kinds. */
export function newRelationshipsNote(kinds: { label: string; inverse: string; hint: string }[] = []): string {
  return [
    "# Relationships",
    "",
    "The kinds of relationship notes in this collection have, beyond the ones every collection has. Each has a name, a name for the other direction (— when it reads the same both ways) and what it means.",
    "",
    "| Relationship | Other direction | Meaning |",
    "| --- | --- | --- |",
    ...kinds.map(row),
    "",
  ].join("\n");
}

/** The note with these kinds added at the end of its table; ones it has (by name) are left as
 *  they are. Everything else in the note stays as written. */
export function addRelationships(md: string, kinds: { label: string; inverse: string; hint: string }[]): string {
  const have = new Set(parseRelationships(md).map((k) => k.rel));
  const fresh = kinds.filter((k, i, a) => kebabId(k.label) && !have.has(kebabId(k.label)) && a.findIndex((o) => kebabId(o.label) === kebabId(k.label)) === i);
  if (!fresh.length) return md;
  const lines = md.split("\n");
  const head = lines.findIndex((l) => HEAD.test(l));
  if (head < 0) return `${md.replace(/\s*$/, "")}\n\n${newRelationshipsNote(fresh).split("\n").slice(4).join("\n")}`;
  let end = head + 1;
  while (end < lines.length && lines[end]!.trim().startsWith("|")) end++;
  lines.splice(end, 0, ...fresh.map(row));
  return lines.join("\n");
}

/** Every kind, once: the collection's own first (they win over a core kind of the same name),
 *  then the types' relation properties, then AI-XF's core kinds. */
export function relationshipKinds(own: Kind[], typeRelations: { name: string; type: string; target?: string }[]): Kind[] {
  const out: Kind[] = [];
  const seen = new Set<string>();
  const add = (k: Kind) => {
    if (!k.rel || seen.has(k.rel)) return;
    seen.add(k.rel);
    out.push(k);
  };
  own.forEach(add);
  for (const t of typeRelations) {
    const core = RELS.find((r) => r.rel === kebabId(t.name));
    add(core ? { ...core, source: "type", type: t.type } : { rel: kebabId(t.name), label: t.name, inverse: `As ${t.name}`, hint: t.target ? `A ${t.type}'s ${t.name}: a ${t.target}` : `A ${t.type}'s ${t.name}`, source: "type", type: t.type });
  }
  RELS.forEach((r) => add({ ...r, source: "core" }));
  return out;
}

/** The kind a property key names (`comes-before`, `Comes before`), or null. */
export function kindNamed(kinds: Kind[], key: string): Kind | null {
  const k = kebabId(key);
  return kinds.find((x) => x.rel === k) ?? null;
}

/** The kind a property key names, read either way (F31 step 4): `comes-before` is that kind
 *  forwards; `comes-after`, its other direction's name, is it backwards (as a reversed relation
 *  is written in the other note). A kind's own name wins over another's other direction. */
export function phraseNamed(kinds: Kind[], key: string): { kind: Kind; back: boolean } | null {
  const own = kindNamed(kinds, key);
  if (own) return { kind: own, back: false };
  const k = kebabId(key);
  const other = kinds.find((x) => kebabId(x.inverse) === k);
  return other ? { kind: other, back: true } : null;
}

/** Whether a kind has a real name for its other direction (a type's own relation has only "As …"),
 *  so a relationship of it can be written in the other note. */
export const reversible = (k: Kind) => !(k.source === "type" && k.inverse === `As ${k.label}`);
