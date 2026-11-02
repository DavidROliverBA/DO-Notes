// An AI-XF bundle coming in (F9 step 3; the way out is src/aixf.ts). Every key a concept has is
// kept as it is (§5.5, §7.3a: `verified`, `provenance`, `sources`, a producer's own map), except
// that typed links become relation properties, Commonplace's one way to write a relation:
// `links: [{rel: depends-on, to: garden-office}]` → `depends-on: "[[Garden office]]"`. Export
// writes them back as typed links, so a bundle goes out as it came in.

import { strFromU8 } from "fflate";
import { parse as parseYaml } from "yaml";
import { parseFrontmatter } from "./markdown";
import { withProperties } from "./props";
import { kebabId } from "./aixfId";
import { inverseOf } from "./aixf";

export const MANIFEST = "manifest.ai-xf.yaml";
const RESERVED = new Set(["index.md", "log.md"]);
/** Keys AI-XF gives a meaning, which a rel can't be written as. */
const TAKEN = new Set(["type", "id", "title", "description", "resource", "tags", "aliases", "generated", "verified", "status", "stale_after", "sources", "usage_window", "provenance", "links", "media", "commonplace"]);
/** What a typed link may carry and still become a property; anything more keeps the links. */
const PLAIN_LINK = new Set(["rel", "to", "by", "at"]);
/** The `## Related` section an exporter writes to mirror its links (§6.4): just Markdown links. */
const RELATED = /\n+## Related\n\n((?:- \[[^\]\n]*\]\([^)\n]*\)\n?)+)\s*$/;

export interface BundleImport {
  concepts: number;
  /** Typed links now relation properties. */
  links: number;
  /** References to concepts in other bundles (`namespace/id`), linked as [[namespace/id]]. */
  crossBundle: number;
  /** Links whose target isn't in the bundle, kept as [[to]]. */
  unresolved: number;
  /** Types the bundle names that had no type note, made for it. */
  types: string[];
}

interface Concept {
  path: string;
  title: string;
  id: string | null;
  aliases: string[];
  type: string | null;
}

const posixDir = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
function joinPath(dir: string, rel: string): string {
  const out: string[] = dir ? dir.split("/") : [];
  for (const seg of rel.split("/")) {
    if (seg === "..") out.pop();
    else if (seg && seg !== ".") out.push(seg);
  }
  return out.join("/");
}

/** Read a bundle's concepts, so links can be turned into [[links]] as each file comes in. */
export function readBundle(items: { path: string; data: Uint8Array }[], prefix: string) {
  const concepts = new Map<string, Concept>();
  for (const f of items) {
    if (!/\.md$/i.test(f.path) || RESERVED.has(f.path)) continue;
    let fm: Record<string, unknown> = {};
    try {
      fm = parseFrontmatter(strFromU8(f.data)).data as Record<string, unknown>;
    } catch {}
    const stem = f.path.split("/").pop()!.replace(/\.md$/i, "");
    concepts.set(f.path, {
      path: f.path,
      title: stem, // a note's title here is its file name
      id: typeof fm.id === "string" ? fm.id : null,
      aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : typeof fm.aliases === "string" ? [fm.aliases] : [],
      type: typeof fm.type === "string" ? fm.type : null,
    });
  }
  const byId = new Map<string, Concept>();
  const byAlias = new Map<string, Concept>();
  const titles = new Map<string, number>();
  for (const c of concepts.values()) {
    if (c.id) byId.set(c.id.toLowerCase(), c);
    for (const a of c.aliases) if (!byAlias.has(a.toLowerCase())) byAlias.set(a.toLowerCase(), c);
    titles.set(c.title.toLowerCase(), (titles.get(c.title.toLowerCase()) ?? 0) + 1);
  }
  // A link by name when the name is the note's alone in the bundle, else by its path.
  const linkTo = (c: Concept) => (titles.get(c.title.toLowerCase())! > 1 ? `[[${(prefix + c.path).replace(/\.md$/i, "")}]]` : `[[${c.title}]]`);

  const vocab = items.find((f) => f.path === "vocab/types.json");
  const typeDefs = new Map<string, string>();
  if (vocab)
    try {
      for (const v of JSON.parse(strFromU8(vocab.data)).values ?? []) if (v?.name) typeDefs.set(String(v.name), String(v.definition ?? ""));
    } catch {}

  // The bundle's kinds of relationship (F31): AI-XF's own are every collection's already, so only
  // the others come in, with their other direction's name when the bundle gives one.
  const words = (id: string) => id.replace(/-/g, " ");
  const relKinds: { label: string; inverse: string; hint: string }[] = [];
  const relVocab = items.find((f) => f.path === "vocab/rels.json");
  if (relVocab)
    try {
      const values: any[] = JSON.parse(strFromU8(relVocab.data)).values ?? [];
      // An entry that is only another's other direction (`comes-after`, written by a reversed
      // relationship) comes in as that kind's second name, not as a kind of its own.
      const named = new Map(values.filter((v) => typeof v?.name === "string").map((v) => [v.name as string, v]));
      const secondName = (v: any) => typeof v.inverse === "string" && v.inverse !== v.name && named.get(v.inverse)?.inverse === v.name && /^The other direction of /.test(v.definition ?? "");
      for (const v of values) {
        const name = typeof v?.name === "string" ? v.name : "";
        if (!name || inverseOf(name) || TAKEN.has(name) || secondName(v)) continue;
        const label = typeof v.label === "string" && v.label.trim() ? v.label.trim() : words(name);
        const inv = typeof v.inverse === "string" && v.inverse !== name ? (typeof v["inverse-label"] === "string" ? v["inverse-label"] : words(v.inverse)) : label;
        relKinds.push({ label, inverse: inv, hint: typeof v.definition === "string" ? v.definition : "" });
      }
    } catch {}

  const report: BundleImport = { concepts: 0, links: 0, crossBundle: 0, unresolved: 0, types: [] };

  /** A concept's text as it should be stored here. */
  function convert(path: string, text: string): string {
    const me = concepts.get(path);
    if (!me) return text;
    report.concepts++;
    const { data } = parseFrontmatter(text);
    const fm = data as Record<string, unknown>;
    const edits: Record<string, unknown> = {};
    const props = new Map<string, string[]>();
    let keepLinks = false;
    for (const l of Array.isArray(fm.links) ? (fm.links as Record<string, unknown>[]) : []) {
      const rel = typeof l?.rel === "string" ? l.rel : "";
      const to = typeof l?.to === "string" ? l.to.trim() : "";
      if (!rel || !to || TAKEN.has(rel) || Object.keys(l).some((k) => !PLAIN_LINK.has(k))) {
        keepLinks = true;
        continue;
      }
      let target: string;
      if (to.startsWith("ai-xf://")) {
        target = `[[${to.slice(8)}]]`;
        report.crossBundle++;
      } else if (/\.md$/i.test(to) || to.startsWith("./") || to.startsWith("../")) {
        const c = concepts.get(joinPath(posixDir(path), to)) ?? concepts.get(joinPath("", to));
        target = c ? linkTo(c) : `[[${to.replace(/\.md$/i, "")}]]`;
        if (!c) report.unresolved++;
      } else if (to.includes("/")) {
        target = `[[${to}]]`;
        report.crossBundle++;
      } else {
        const c = byId.get(to.toLowerCase()) ?? byAlias.get(to.toLowerCase());
        target = c ? linkTo(c) : `[[${to}]]`;
        if (!c) report.unresolved++;
      }
      props.set(rel, [...(props.get(rel) ?? []), target]);
      report.links++;
    }
    for (const [rel, targets] of props) {
      const was = fm[rel];
      const all = [...(Array.isArray(was) ? was.map(String) : typeof was === "string" ? [was] : []), ...targets].filter((t, i, a) => a.indexOf(t) === i);
      edits[rel] = all.length === 1 ? all[0] : all;
    }
    if (props.size && !keepLinks) edits.links = null;
    // Properties Commonplace sent under its own name come back (a project's `status: Paused`).
    if (fm.commonplace && typeof fm.commonplace === "object" && !Array.isArray(fm.commonplace)) {
      for (const [k, v] of Object.entries(fm.commonplace as Record<string, unknown>)) edits[k] = v;
      edits.commonplace = null;
    }
    // A Commonplace type note sent as a concept of type Type comes back a type note.
    if (/^Types\//.test(path) && fm.type === "Type") edits.type = null;
    let out = Object.keys(edits).length ? withProperties(text, edits) : text;
    // The body links that only mirrored the typed links: the properties say it now.
    if (props.size) out = out.replace(RELATED, "\n");
    return out;
  }

  /** Type notes to make: types the bundle's concepts have that it doesn't define. */
  function missingTypes(existing: Set<string>): { name: string; content: string }[] {
    const defined = new Set([...existing, ...[...concepts.values()].filter((c) => /^Types\//.test(c.path)).map((c) => c.title)]);
    const used = new Set([...concepts.values()].map((c) => c.type).filter((t): t is string => !!t && t !== "Note" && t !== "Type"));
    const out = [...used].filter((t) => !defined.has(t) && !/[\\/:*?"<>|#^[\]]/.test(t)).sort();
    report.types = out;
    return out.map((name) => {
      const d = typeDefs.get(name);
      return { name, content: `---\nid: type-${kebabId(name) || "type"}\nicon: shapes\ncolour: grey\n${d ? `description: ${JSON.stringify(d)}\n` : ""}properties: []\n---\n# {{title}}\n` };
    });
  }

  return { convert, missingTypes, relKinds, report };
}

/** Whether a set of files is an AI-XF bundle (a manifest at its root that says so). */
export function isBundle(items: { path: string; data: Uint8Array }[]): boolean {
  const m = items.find((f) => f.path === MANIFEST);
  if (!m) return false;
  try {
    const y = parseYaml(strFromU8(m.data));
    return !!y && typeof y === "object" && ("ai-xf" in y || "name" in y);
  } catch {
    return false;
  }
}
