// Yjs helpers shared by the live rooms (collab.ts) and offline writes (notes.ts).

import * as Y from "yjs";
import { HttpError } from "./auth";
import { applyCanvasDiff, canvasFromDoc, parseCanvas, sameCanvas, serialiseCanvas } from "./canvas";

/** Apply `next` to a Y.Text as a single splice over the changed middle, so cursors elsewhere survive. */
export function applyTextDiff(text: Y.Text, next: string): void {
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
  // Don't split a surrogate pair.
  if (start > 0 && /[\uD800-\uDBFF]/.test(cur[start - 1]!)) start--;
  // ...at either end: a shared low surrogate would otherwise be left orphaned.
  if (endCur < cur.length && /[\uDC00-\uDFFF]/.test(cur[endCur]!)) {
    endCur++;
    endNext++;
  }
  if (endCur - start > 0) text.delete(start, endCur - start);
  if (endNext - start > 0) text.insert(start, next.slice(start, endNext));
}

/** Build the Yjs doc for a note from its stored state, or from its text if it has none yet. A board
 *  (F11, `.canvas`) holds its cards as maps rather than text (src/canvas.ts). */
export function loadDoc(content: string, ydoc: Uint8Array | null, board = false): Y.Doc {
  const doc = new Y.Doc();
  if (ydoc) Y.applyUpdate(doc, ydoc);
  if (board) {
    // A file another editor broke stays as it is, and the board shows it can't be read.
    const stored = parseCanvas(content);
    if (stored && !sameCanvas(canvasFromDoc(doc), stored)) doc.transact(() => applyCanvasDiff(doc, stored), "server");
    return doc;
  }
  const text = doc.getText("content");
  // Belt and braces: the stored text is authoritative if the two ever disagree.
  if (text.toString() !== content) doc.transact(() => applyTextDiff(text, content), "server");
  return doc;
}

/** The note's text as the document has it now. A board keeps `previous` byte for byte while its
 *  cards are unchanged, so a .canvas from another editor round-trips exactly. */
export function docContent(doc: Y.Doc, board: boolean, previous: string): string {
  if (!board) return doc.getText("content").toString();
  const now = canvasFromDoc(doc);
  const before = parseCanvas(previous);
  if (before ? sameCanvas(before, now) : !now.nodes.length && !now.edges.length && !Object.keys(now.extra).length) return previous;
  return serialiseCanvas(now);
}

/** Change the document to hold `next` as a minimal edit. */
export function applyContent(doc: Y.Doc, board: boolean, next: string): void {
  if (!board) return applyTextDiff(doc.getText("content"), next);
  const c = parseCanvas(next);
  if (!c) throw new HttpError(400, "That isn't a board: a .canvas file holds JSON Canvas (jsoncanvas.org)");
  applyCanvasDiff(doc, c);
}

/** Text change for a note with no open room: diff it into the stored CRDT state. */
export function rebaseStoredDoc(content: string, ydoc: Uint8Array | null, next: string, board = false): Uint8Array {
  const doc = loadDoc(content, ydoc, board);
  doc.transact(() => applyContent(doc, board, next), "server");
  return Y.encodeStateAsUpdate(doc);
}
