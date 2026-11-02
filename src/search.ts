// Hybrid search: Postgres full-text (title-weighted) + pgvector cosine over note chunks, fused
// with Reciprocal Rank Fusion so neither score scale dominates. Supports `tag:x` (or `#x`) and
// `path:x` filters inline in the query. If embeddings are disabled or the provider fails, it
// degrades to keyword-only rather than erroring.

import { sql } from "./db";
import { embedTexts, providerName, semanticEnabled, toVector } from "./embed";
import { settings } from "./settings";

export interface SearchHit {
  id: number;
  path: string;
  title: string;
  snippet: string;
  score: number;
  via: ("keyword" | "semantic" | "title")[];
}

interface Parsed {
  text: string;
  tags: string[];
  path: string | null;
}

/** Split a query into its free text and its `tag:` / `#tag` / `path:` filters. */
export function parseQuery(q: string): Parsed {
  const tags: string[] = [];
  let path: string | null = null;
  const text = q
    .replace(/(?:^|\s)tag:#?([^\s]+)/gi, (_, t) => {
      tags.push(t.toLowerCase());
      return " ";
    })
    .replace(/(?:^|\s)#([\p{L}\p{N}_\-/]+)/gu, (_, t) => {
      tags.push(t.toLowerCase());
      return " ";
    })
    .replace(/(?:^|\s)path:("[^"]+"|[^\s]+)/gi, (_, p) => {
      path = p.replace(/"/g, "");
      return " ";
    })
    .trim()
    .replace(/\s+/g, " ");
  return { text, tags, path };
}

const RRF_K = 60;

/**
 * Nearest-neighbour search always returns *something*, so semantic hits need a floor or every
 * note in a small vault comes back as "similar". Cosine scales differ by model, hence per
 * provider; a hit must also be within reach of the best one.
 */
const SEMANTIC_FLOOR: Record<string, number> = { relaxai: 0.6, voyage: 0.3, ollama: 0.45, hash: 0.12 };
const RELATIVE_FLOOR = 0.6;
/** relaxAI's scores are bunched (unrelated notes score 0.5–0.7 against a query, the right one
 *  0.6–0.8; measured 2026-10-11), so a hit must also be close to the best, not just a share of it. */
const GAP_FROM_TOP: Record<string, number> = { relaxai: 0.04 };
/** For Related (note against note) the bunching is worse: unrelated notes reach 0.70. */
const RELATED_FLOOR: Record<string, number> = { relaxai: 0.75 };

export async function search(vaultId: number, q: string, limit = 30): Promise<{ hits: SearchHit[]; semantic: boolean }> {
  const { text, tags, path } = parseQuery(q);
  const tagFilter = tags.length ? sql`and n.tags @> ${tags}` : sql``;
  const pathFilter = path ? sql`and n.path ilike ${"%" + path.replace(/[%_\\]/g, "\\$&") + "%"}` : sql``;

  if (!text) {
    // Filter-only query: list matches, most recent first.
    const rows = await sql`
      select n.id, n.path, n.title, left(regexp_replace(n.content, '^---[\\s\\S]*?---\\s*', ''), 160) as snippet
      from notes n where n.vault_id = ${vaultId} ${tagFilter} ${pathFilter}
      order by n.updated_at desc limit ${limit}`;
    return { hits: rows.map((r: any) => ({ ...r, snippet: escapeHtml(r.snippet), score: 0, via: [] })), semantic: false };
  }

  const keyword = await sql`
    select n.id, n.path, n.title,
      ts_headline('english', replace(replace(replace(n.content, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), websearch_to_tsquery('english', ${text}),
        'MaxFragments=2, MaxWords=18, MinWords=6, StartSel=<mark>, StopSel=</mark>') as snippet
    from notes n
    where n.vault_id = ${vaultId} and n.search @@ websearch_to_tsquery('english', ${text}) ${tagFilter} ${pathFilter}
    order by ts_rank_cd(n.search, websearch_to_tsquery('english', ${text})) desc
    limit 50`;

  // Fuzzy title matches catch partial words and typos that full-text stemming misses.
  const titles = await sql`
    select n.id, n.path, n.title, '' as snippet
    from notes n
    where n.vault_id = ${vaultId} and (lower(n.title) like ${"%" + text.toLowerCase().replace(/[%_\\]/g, "\\$&") + "%"}
          or similarity(lower(n.title), ${text.toLowerCase()}) > 0.3) ${tagFilter} ${pathFilter}
    order by similarity(lower(n.title), ${text.toLowerCase()}) desc
    limit 20`;

  // The words inside files (src/fileText.ts: PDFs, photos, voice notes): a match finds the notes
  // that show or link the file, with "In <file>:" and the words around it.
  const inFiles = (
    await sql`
    with files as (
      select a.path, a.text, ts_rank_cd(a.text_search, websearch_to_tsquery('english', ${text})) as rank
      from attachments a
      where a.vault_id = ${vaultId} and a.text_search @@ websearch_to_tsquery('english', ${text})
      order by rank desc limit 10
    )
    select distinct on (n.id) n.id, n.path, n.title, f.path as file, f.rank,
      ts_headline('english', replace(replace(replace(f.text, '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), websearch_to_tsquery('english', ${text}),
        'MaxFragments=1, MaxWords=18, MinWords=6, StartSel=<mark>, StopSel=</mark>') as snippet
    from files f join notes n on n.vault_id = ${vaultId} and strpos(lower(n.content), lower(regexp_replace(f.path, '^.*/', ''))) > 0
    where true ${tagFilter} ${pathFilter}
    order by n.id, f.rank desc`
  )
    .sort((a: any, b: any) => b.rank - a.rank)
    .map((r: any) => ({ ...r, snippet: `In ${escapeHtml(String(r.file).split("/").pop()!)}: ${r.snippet}` }));

  let semantic: any[] = [];
  let usedSemantic = false;
  if (semanticEnabled()) {
    try {
      const [v] = await embedTexts([text], "query");
      if (v?.length) {
        usedSemantic = true;
        semantic = await sql`
          with nearest as (
            select c.note_id, c.body, 1 - (c.embedding <=> ${toVector(v)}::vector) as sim
            from note_chunks c
            where c.vault_id = ${vaultId} and c.provider = ${providerName()}
            order by c.embedding <=> ${toVector(v)}::vector
            limit 80
          ), best as (
            select distinct on (note_id) note_id, body, sim from nearest order by note_id, sim desc
          )
          select n.id, n.path, n.title, b.body as snippet, b.sim
          from best b join notes n on n.id = b.note_id
          where true ${tagFilter} ${pathFilter}
          order by b.sim desc limit 30`;
        const top = semantic[0]?.sim ?? 0;
        const p = settings.embeddingProvider;
        const floor = Math.max(SEMANTIC_FLOOR[p] ?? 0.3, top * RELATIVE_FLOOR, GAP_FROM_TOP[p] ? top - GAP_FROM_TOP[p] : 0);
        semantic = semantic.filter((r) => r.sim >= floor);
      }
    } catch (err) {
      console.warn(`search: semantic unavailable, keyword only — ${(err as Error).message}`);
    }
  }

  const fused = new Map<number, SearchHit>();
  const add = (rows: any[], via: SearchHit["via"][number], weight: number) => {
    rows.forEach((r, rank) => {
      const hit: SearchHit = fused.get(r.id) ?? { id: r.id, path: r.path, title: r.title, snippet: "", score: 0, via: [] };
      hit.score += weight / (RRF_K + rank + 1);
      hit.via.push(via);
      if (!hit.snippet && r.snippet) hit.snippet = via === "semantic" ? semanticSnippet(r.snippet) : r.snippet;
      fused.set(r.id, hit);
    });
  };
  add(titles, "title", 1.2);
  add(keyword, "keyword", 1);
  add(inFiles, "keyword", 0.9);
  add(semantic, "semantic", 1);
  const hits = [...fused.values()].sort((a, b) => b.score - a.score).slice(0, limit);
  return { hits, semantic: usedSemantic };
}

/** Chunk bodies start "Title › Heading\n\n"; show the text, escaped, without that header. */
function semanticSnippet(body: string): string {
  const text = body
    .split("\n\n")
    .slice(1)
    .join(" ")
    // Read as prose: [[Target|alias]] → alias, drop emphasis, list and heading markers.
    .replace(/!?\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, t, a) => a ?? t)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|==|~~|`)/g, "")
    .replace(/(^|\s)(#{1,6}|[-*+]|\d+\.)\s/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
  return escapeHtml(text.slice(0, 220) + (text.length > 220 ? "…" : ""));
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Notes nearest in meaning to this one: mean of its chunk vectors vs. other notes' chunks. */
export async function related(vaultId: number, noteId: number, limit = 8) {
  if (!semanticEnabled()) return [];
  const floor = RELATED_FLOOR[settings.embeddingProvider] ?? SEMANTIC_FLOOR[settings.embeddingProvider] ?? 0.3;
  const provider = providerName();
  const rows = await sql`
    with me as (select avg(embedding) as v from note_chunks where note_id = ${noteId} and provider = ${provider}),
    nearest as (
      select c.note_id, 1 - (c.embedding <=> me.v) as sim
      from note_chunks c, me
      where c.vault_id = ${vaultId} and c.note_id <> ${noteId} and me.v is not null and c.provider = ${provider}
      order by c.embedding <=> me.v
      limit 60
    )
    select n.id, n.path, n.title, max(x.sim)::float as similarity
    from nearest x join notes n on n.id = x.note_id
    group by n.id, n.path, n.title
    order by similarity desc limit ${limit}`;
  return rows.filter((r) => r.similarity >= floor);
}

/** Title prefix/fuzzy lookup for the quick switcher and [[ autocomplete. */
export async function suggest(vaultId: number, q: string, limit = 20) {
  const t = q.trim().toLowerCase();
  if (!t) {
    return sql`select id, path, title from notes where vault_id = ${vaultId} order by updated_at desc limit ${limit}`;
  }
  return sql`
    select id, path, title from notes
    where vault_id = ${vaultId}
      and (lower(path) like ${"%" + t.replace(/[%_\\]/g, "\\$&") + "%"} or similarity(lower(title), ${t}) > 0.2)
    order by (lower(title) like ${t.replace(/[%_\\]/g, "\\$&") + "%"}) desc, similarity(lower(title), ${t}) desc, length(path)
    limit ${limit}`;
}
