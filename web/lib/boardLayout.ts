// Board layouts (F11 step 4): Tidy up, Arrange the group and Mind map from here. Each writes card
// positions into the board's Yjs maps; the caller wraps it in one transaction, so it's one Undo.

import type * as Y from "yjs";

type Cards = Y.Map<Y.Map<unknown>>;
const GRID = 20;
const GAP = 40;
const num = (v: unknown, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const snap = (v: number) => Math.round(v / GRID) * GRID;

interface Box {
  id: string;
  m: Y.Map<unknown>;
  x: number;
  y: number;
  w: number;
  h: number;
}
const box = (id: string, m: Y.Map<unknown>): Box => ({ id, m, x: num(m.get("x")), y: num(m.get("y")), w: num(m.get("width"), 250), h: num(m.get("height"), 60) });
const overlaps = (a: Box, b: Box) => a.x < b.x + b.w + GAP / 2 && b.x < a.x + a.w + GAP / 2 && a.y < b.y + b.h + GAP / 2 && b.y < a.y + a.h + GAP / 2;

function write(b: Box) {
  if (num(b.m.get("x")) !== b.x) b.m.set("x", b.x);
  if (num(b.m.get("y")) !== b.y) b.m.set("y", b.y);
}

/** Snap cards to a grid and move apart any that overlap: the selection, or every card. */
export function tidy(nodes: Cards, only: Set<string> | null): void {
  const boxes: Box[] = [];
  nodes.forEach((m, id) => {
    if (m.get("type") !== "group" && (!only || only.has(id))) boxes.push(box(id, m));
  });
  boxes.sort((a, b) => a.y - b.y || a.x - b.x);
  for (const b of boxes) ((b.x = snap(b.x)), (b.y = snap(b.y)));
  // Each card, in reading order, steps right past anything already placed that it covers.
  const placed: Box[] = [];
  for (const b of boxes) {
    for (let guard = 0; guard < 200; guard++) {
      const hit = placed.find((p) => overlaps(p, b));
      if (!hit) break;
      b.x = snap(hit.x + hit.w + GAP);
    }
    placed.push(b);
  }
  boxes.forEach(write);
}

/** Lay the cards inside a group out in a grid, and fit the group around them. */
export function arrange(nodes: Cards, groupId: string): void {
  const g = nodes.get(groupId);
  if (!g) return;
  const gb = box(groupId, g);
  const cards: Box[] = [];
  nodes.forEach((m, id) => {
    if (id === groupId) return;
    const b = box(id, m);
    if (b.x >= gb.x && b.y >= gb.y && b.x + b.w <= gb.x + gb.w && b.y + b.h <= gb.y + gb.h) cards.push(b);
  });
  if (!cards.length) return;
  cards.sort((a, b) => a.y - b.y || a.x - b.x);
  const cols = Math.ceil(Math.sqrt(cards.length));
  const cw = Math.max(...cards.map((c) => c.w));
  const rowH: number[] = [];
  cards.forEach((c, i) => (rowH[Math.floor(i / cols)] = Math.max(rowH[Math.floor(i / cols)] ?? 0, c.h)));
  const top = gb.y + GAP + GRID; // room for the group's label
  cards.forEach((c, i) => {
    const row = Math.floor(i / cols);
    c.x = gb.x + GAP + (i % cols) * (cw + GAP);
    c.y = top + rowH.slice(0, row).reduce((s, h) => s + h + GAP, 0);
    write(c);
  });
  g.set("width", GAP * 2 + cols * cw + (cols - 1) * GAP);
  g.set("height", top - gb.y + rowH.reduce((s, h) => s + h + GAP, 0));
}

/**
 * A mind map from one card: what it's joined to (by arrows either way) fans out to its right,
 * each branch below the last, its own branches further right.
 */
export function mindMap(nodes: Cards, edges: Cards, rootId: string): void {
  const root = nodes.get(rootId);
  if (!root) return;
  const near = new Map<string, string[]>();
  edges.forEach((e) => {
    const a = e.get("fromNode") as string;
    const b = e.get("toNode") as string;
    if (!nodes.has(a) || !nodes.has(b)) return;
    near.set(a, [...(near.get(a) ?? []), b]);
    near.set(b, [...(near.get(b) ?? []), a]);
  });
  // A tree by breadth-first search, so each card hangs from its nearest way to the root.
  const kids = new Map<string, string[]>();
  const seen = new Set([rootId]);
  const queue = [rootId];
  while (queue.length) {
    const id = queue.shift()!;
    for (const n of near.get(id) ?? []) {
      if (seen.has(n) || nodes.get(n)?.get("type") === "group") continue;
      seen.add(n);
      kids.set(id, [...(kids.get(id) ?? []), n]);
      queue.push(n);
    }
  }
  const boxes = new Map([...seen].map((id) => [id, box(id, nodes.get(id)!)]));
  const height = new Map<string, number>();
  const measure = (id: string): number => {
    const own = boxes.get(id)!.h;
    const below = (kids.get(id) ?? []).reduce((s, k) => s + measure(k), 0) + Math.max(0, (kids.get(id)?.length ?? 0) - 1) * GAP;
    const h = Math.max(own, below);
    height.set(id, h);
    return h;
  };
  measure(rootId);
  const place = (id: string, x: number, top: number) => {
    const b = boxes.get(id)!;
    b.x = snap(x);
    b.y = snap(top + (height.get(id)! - b.h) / 2);
    write(b);
    let y = top + (height.get(id)! - ((kids.get(id) ?? []).reduce((s, k) => s + height.get(k)!, 0) + Math.max(0, (kids.get(id)?.length ?? 0) - 1) * GAP)) / 2;
    for (const k of kids.get(id) ?? []) {
      place(k, x + b.w + GAP * 3, y);
      y += height.get(k)! + GAP;
    }
  };
  const r = boxes.get(rootId)!;
  place(rootId, r.x, r.y + r.h / 2 - height.get(rootId)! / 2);
}
