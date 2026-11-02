// Boards (F11): JSON Canvas `.canvas` files (jsoncanvas.org) kept as notes. Shared with the
// browser, so no server imports. The stored `content` is always the JSON Canvas text; the live
// Yjs document holds it as structure, so two people moving different cards merge:
//
//   doc.getMap("nodes")  id → Y.Map of the node's fields (unknown keys kept), plus `z` (its place
//                        in the drawing order, which JSON Canvas gives by array order); a text
//                        card's `text` is a Y.Text, so typing in one merges too
//   doc.getMap("edges")  the same for arrows
//   doc.getMap("canvas") any other top-level keys another editor wrote
//
// A change from outside the board (the folder, GitHub, an import, a restore) is patched in by id
// (`applyCanvasDiff`), never rebuilt, for the same reason notes diff their text (src/ydoc.ts).

import * as Y from "yjs";
import { extractLinks, normaliseTarget } from "./markdown";

export const isCanvasPath = (p: string) => /\.canvas$/i.test(p);

export type CanvasItem = Record<string, unknown> & { id: string };
export interface Canvas {
  nodes: CanvasItem[];
  edges: CanvasItem[];
  /** Top-level keys other than nodes and edges, kept as they were. */
  extra: Record<string, unknown>;
}

export const emptyCanvas = (): Canvas => ({ nodes: [], edges: [], extra: {} });

/** Read a .canvas file; null if it isn't a JSON object. Items without an id get one from their place. */
export function parseCanvas(text: string): Canvas | null {
  if (!text.trim()) return emptyCanvas();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { nodes, edges, ...extra } = raw as Record<string, unknown>;
  const items = (v: unknown, prefix: string) =>
    (Array.isArray(v) ? v : [])
      .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
      .map((x, i) => ({ ...x, id: typeof x.id === "string" && x.id ? x.id : `${prefix}${i}` }));
  return { nodes: items(nodes, "node-"), edges: items(edges, "edge-"), extra };
}

// The order Obsidian writes keys in; others follow, alphabetically.
const NODE_KEYS = ["id", "type", "text", "file", "subpath", "url", "label", "background", "backgroundStyle", "x", "y", "width", "height", "color"];
const EDGE_KEYS = ["id", "fromNode", "fromSide", "fromEnd", "toNode", "toSide", "toEnd", "color", "label"];

function ordered(item: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of keys) if (item[k] !== undefined) out[k] = item[k];
  for (const k of Object.keys(item).sort()) if (!(k in out) && item[k] !== undefined) out[k] = item[k];
  return out;
}

/** Write a board as Obsidian does (tab indent, one card or arrow per line), so changes diff cleanly. */
export function serialiseCanvas(c: Canvas): string {
  const list = (items: CanvasItem[], keys: string[]) => (items.length ? `[\n${items.map((i) => `\t\t${JSON.stringify(ordered(i, keys))}`).join(",\n")}\n\t]` : "[]");
  const parts = [`\t"nodes":${list(c.nodes, NODE_KEYS)}`, `\t"edges":${list(c.edges, EDGE_KEYS)}`];
  for (const k of Object.keys(c.extra).sort()) parts.push(`\t${JSON.stringify(k)}:${JSON.stringify(c.extra[k])}`);
  return `{\n${parts.join(",\n")}\n}`;
}

export const sameCanvas = (a: Canvas, b: Canvas) => serialiseCanvas(a) === serialiseCanvas(b);

// ── the live document ──────────────────────────────────────────────────────────────────────

export const canvasMaps = (doc: Y.Doc) => ({ nodes: doc.getMap<Y.Map<unknown>>("nodes"), edges: doc.getMap<Y.Map<unknown>>("edges"), extra: doc.getMap<unknown>("canvas") });

const plain = (v: unknown): unknown => (v instanceof Y.Text ? v.toString() : v instanceof Y.AbstractType ? v.toJSON() : v);

function readItems(map: Y.Map<Y.Map<unknown>>): CanvasItem[] {
  const rows: { z: number; item: CanvasItem }[] = [];
  map.forEach((m, id) => {
    const item: CanvasItem = { id };
    let z = 0;
    m.forEach((v, k) => {
      if (k === "z") z = typeof v === "number" ? v : 0;
      else if (k !== "id") item[k] = plain(v);
    });
    rows.push({ z, item });
  });
  rows.sort((a, b) => a.z - b.z || (a.item.id < b.item.id ? -1 : a.item.id > b.item.id ? 1 : 0));
  return rows.map((r) => r.item);
}

/** The board the document holds now. */
export function canvasFromDoc(doc: Y.Doc): Canvas {
  const { nodes, edges, extra } = canvasMaps(doc);
  const rest: Record<string, unknown> = {};
  extra.forEach((v, k) => (rest[k] = plain(v)));
  return { nodes: readItems(nodes), edges: readItems(edges), extra: rest };
}

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Splice `next` into a Y.Text over the changed middle (as ydoc.ts's applyTextDiff). */
export function spliceText(text: Y.Text, next: string): void {
  const cur = text.toString();
  if (cur === next) return;
  let start = 0;
  while (start < cur.length && start < next.length && cur[start] === next[start]) start++;
  let endCur = cur.length;
  let endNext = next.length;
  while (endCur > start && endNext > start && cur[endCur - 1] === next[endNext - 1]) {
    endCur--;
    endNext--;
  }
  if (endCur - start > 0) text.delete(start, endCur - start);
  if (endNext - start > 0) text.insert(start, next.slice(start, endNext));
}

/** Set one field of a card or arrow, keeping a text card's text a Y.Text. */
export function setField(m: Y.Map<unknown>, key: string, value: unknown): void {
  const cur = m.get(key);
  if (value === undefined) {
    if (m.has(key)) m.delete(key);
  } else if (key === "text" && typeof value === "string") {
    if (cur instanceof Y.Text) spliceText(cur, value);
    else {
      const t = new Y.Text();
      m.set(key, t);
      t.insert(0, value);
    }
  } else if (!same(plain(cur), value)) m.set(key, value);
}

function patchItems(map: Y.Map<Y.Map<unknown>>, items: CanvasItem[]) {
  const wanted = new Set(items.map((i) => i.id));
  for (const id of [...map.keys()]) if (!wanted.has(id)) map.delete(id);
  // Keep the drawing order: renumber only if it differs.
  const order = readItems(map).map((i) => i.id);
  const known = items.filter((i) => map.has(i.id)).map((i) => i.id);
  const reorder = order.join("\u0000") !== known.join("\u0000");
  items.forEach((item, i) => {
    let m = map.get(item.id);
    if (!m) {
      m = new Y.Map<unknown>();
      map.set(item.id, m);
      m.set("z", i);
    } else if (reorder && m.get("z") !== i) m.set("z", i);
    for (const k of [...m.keys()]) if (k !== "z" && k !== "id" && !(k in item)) m.delete(k);
    for (const [k, v] of Object.entries(item)) if (k !== "id" && k !== "z") setField(m, k, v);
  });
}

/** Make the document hold `next`, changing only what differs, by id. */
export function applyCanvasDiff(doc: Y.Doc, next: Canvas): void {
  const { nodes, edges, extra } = canvasMaps(doc);
  patchItems(nodes, next.nodes);
  patchItems(edges, next.edges);
  for (const k of [...extra.keys()]) if (!(k in next.extra)) extra.delete(k);
  for (const [k, v] of Object.entries(next.extra)) if (!same(extra.get(k), v)) extra.set(k, v);
}

/** The next drawing-order number: above everything on the board. */
export function topZ(map: Y.Map<Y.Map<unknown>>): number {
  let z = -1;
  map.forEach((m) => {
    const v = m.get("z");
    if (typeof v === "number" && v > z) z = v;
  });
  return z + 1;
}

// ── links ──────────────────────────────────────────────────────────────────────────────────

/** What a board links to: its note and board cards, and [[links]] in its text cards. */
export function canvasLinks(c: Canvas): string[] {
  const out = new Set<string>();
  for (const n of c.nodes) {
    if (n.type === "file" && typeof n.file === "string" && /\.(md|markdown|canvas)$/i.test(n.file)) {
      const t = normaliseTarget(n.file);
      if (t) out.add(t);
    }
    if (n.type === "text" && typeof n.text === "string") for (const t of extractLinks(n.text)) out.add(t);
  }
  for (const e of c.edges) if (typeof e.label === "string") for (const t of extractLinks(e.label)) out.add(t);
  return [...out];
}

/** Plain words on a board, for search and the AI: text cards, group labels and arrow labels. */
export function canvasText(c: Canvas): string {
  const bits: string[] = [];
  for (const n of c.nodes) for (const k of ["text", "label", "url"]) if (typeof n[k] === "string") bits.push(n[k] as string);
  for (const e of c.edges) if (typeof e.label === "string") bits.push(e.label);
  return bits.join("\n\n");
}
