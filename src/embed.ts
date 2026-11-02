// Embeddings for semantic search and related notes, stored as vector(1024) in note_chunks.
//
// Work is queued in-process and debounced: a note being typed into is embedded once it has been
// quiet for a few seconds, not on every keystroke. `embedded_hash` (provider + content) makes the
// job idempotent, and `backfill()` at boot catches anything missed while the server was down or
// after a provider switch. A failed embedding never fails a save — search falls back to keywords.

import { canvasText, isCanvasPath, parseCanvas } from "./canvas";
import { createHash } from "node:crypto";
import { sql } from "./db";
import { chunkNote } from "./markdown";
import { settings } from "./settings";

export const DIMS = 1024;

export function providerName(): string {
  switch (settings.embeddingProvider) {
    case "relaxai":
      return "relaxai-mistral-7b-1024";
    case "voyage":
      return "voyage-4-lite";
    case "ollama":
      return "mxbai-embed-large";
    case "hash":
      return "hash-1024";
    default:
      return "none";
  }
}

export const semanticEnabled = () => settings.embeddingProvider !== "none";

/**
 * Offline fallback: signed feature hashing of word unigrams and bigrams into 1024 dims. It is
 * lexical, not semantic — similarity means shared vocabulary — but needs no model or network, so
 * "related notes" and vector search work out of the box and in tests.
 */
export function hashEmbed(text: string): number[] {
  const v = new Float64Array(DIMS);
  const words = text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? [];
  const add = (tok: string, w: number) => {
    const h = createHash("md5").update(tok).digest();
    const i = h.readUInt32LE(0) % DIMS;
    v[i]! += (h[4]! & 1 ? 1 : -1) * w;
  };
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    add(w, 1);
    if (w.length > 5) add(w.slice(0, 5), 0.5); // crude stemming
    if (i > 0) add(words[i - 1] + " " + w, 0.7);
  }
  const norm = Math.hypot(...v) || 1;
  return Array.from(v, (x) => x / norm);
}

export async function embedTexts(texts: string[], kind: "document" | "query"): Promise<number[][]> {
  if (texts.length === 0) return [];
  switch (settings.embeddingProvider) {
    case "relaxai": {
      // Mistral-7b-embedding (UK datacentre, £0.20 a million tokens) returns 4096 dims; the
      // schema is vector(1024) with HNSW, which pgvector can't build above 2000. Keeping the
      // first 1024, renormalised, keeps the ranking: Longview measured it (2026-08-31) and so
      // did we (2026-10-11, a query's best match was the same at 1024 and 4096 dims).
      if (!settings.relaxApiKey) throw new Error("EMBEDDING_PROVIDER=relaxai needs RELAX_API_KEY");
      const res = await fetch(`${settings.relaxBaseUrl}/embeddings`, {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.relaxApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: texts, model: "Mistral-7b-embedding" }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(`relaxai ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      return body.data.sort((a, b) => a.index - b.index).map((d) => unit(d.embedding.slice(0, DIMS)));
    }
    case "voyage": {
      if (!settings.voyageApiKey) throw new Error("EMBEDDING_PROVIDER=voyage needs VOYAGE_API_KEY");
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { Authorization: `Bearer ${settings.voyageApiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ input: texts, model: "voyage-4-lite", input_type: kind, output_dimension: DIMS }),
      });
      if (!res.ok) throw new Error(`voyage ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      return body.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    }
    case "ollama": {
      // mxbai-embed-large wants this prefix on queries (not documents) for retrieval.
      const input = kind === "query" ? texts.map((t) => `Represent this sentence for searching relevant passages: ${t}`) : texts;
      const res = await fetch(`${settings.ollamaUrl}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: "mxbai-embed-large", input }),
      });
      if (!res.ok) throw new Error(`ollama ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return ((await res.json()) as { embeddings: number[][] }).embeddings;
    }
    case "hash":
      return texts.map(hashEmbed);
    default:
      return [];
  }
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;

/** Scaled to length 1, so cosine similarity is comparable after truncation. */
export function unit(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

function contentHash(content: string): string {
  return createHash("sha1").update(providerName()).update("\0").update(content).digest("hex");
}

/** (Re)embed one note if its content changed since the last embedding. */
export async function embedNote(noteId: number): Promise<"embedded" | "unchanged" | "gone" | "disabled"> {
  if (!semanticEnabled()) return "disabled";
  const [n] = await sql`select id, vault_id, path, title, content, embedded_hash from notes where id = ${noteId}`;
  if (!n) return "gone";
  const hash = contentHash(n.content);
  if (n.embedded_hash === hash) return "unchanged";
  // A board (F11) is found by the words on it, not its JSON.
  const board = isCanvasPath(n.path) ? parseCanvas(n.content) : null;
  const chunks = chunkNote(n.title, board ? canvasText(board) : n.content);
  const vectors: number[][] = [];
  for (let i = 0; i < chunks.length; i += 64) {
    vectors.push(...(await embedTexts(chunks.slice(i, i + 64).map((c) => c.body), "document")));
  }
  await sql.begin(async (tx) => {
    // The note may have changed while we were embedding; only write if it's still the same text.
    const [cur] = await tx`select content from notes where id = ${noteId} for update`;
    if (!cur || contentHash(cur.content) !== hash) return;
    await tx`delete from note_chunks where note_id = ${noteId}`;
    for (const [i, c] of chunks.entries()) {
      await tx`insert into note_chunks (note_id, vault_id, ord, heading, body, embedding, provider)
               values (${noteId}, ${n.vault_id}, ${c.ord}, ${c.heading}, ${c.body}, ${toVector(vectors[i]!)}::vector, ${providerName()})`;
    }
    await tx`update notes set embedded_hash = ${hash} where id = ${noteId}`;
  });
  return "embedded";
}

const pending = new Map<number, Timer>();
const DEBOUNCE_MS = Number(process.env.EMBED_DEBOUNCE_MS ?? 4000);
let chain: Promise<unknown> = Promise.resolve();

/** Embed a note once it has been quiet for `delay` ms; queued embeddings run one at a time. */
export function scheduleEmbedding(noteId: number, delay = DEBOUNCE_MS): void {
  if (!semanticEnabled()) return;
  clearTimeout(pending.get(noteId));
  pending.set(
    noteId,
    setTimeout(() => {
      pending.delete(noteId);
      // One at a time: a vault import can queue thousands, and the provider has rate limits.
      chain = chain.then(() => embedNote(noteId)).catch((err) => console.warn(`embedding note ${noteId} failed: ${err.message}`));
    }, delay),
  );
}

/** Queue every note whose embedding is missing or stale (e.g. after switching provider). */
export async function backfill(): Promise<number> {
  if (!semanticEnabled()) return 0;
  const rows = await sql`select id, content, embedded_hash from notes`;
  let n = 0;
  for (const r of rows) {
    if (r.embedded_hash !== contentHash(r.content)) {
      scheduleEmbedding(r.id, 500 + n * 10);
      n++;
    }
  }
  return n;
}
