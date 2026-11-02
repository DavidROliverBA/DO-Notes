// Boards (F11 step 3): what a note's side panel says about the boards it's on, and the arrows
// drawn to and from it there. Read from the boards' JSON Canvas, which the links table already
// narrows to the boards with this note on them.

import { sql } from "./db";
import * as notes from "./notes";
import { isCanvasPath, parseCanvas } from "./canvas";
import { titleFromPath } from "./markdown";

const NOTE_FILE = /\.(md|markdown)$/i;

export interface BoardArrow {
  /** The note at the other end. */
  id: number;
  title: string;
  /** "from": its arrow points at this note; "to": this note's points at it. */
  direction: "from" | "to";
  label: string | null;
  board: { id: number; title: string };
}

export async function boardsFor(vaultId: number, noteId: number): Promise<{ boards: { id: number; title: string }[]; arrows: BoardArrow[] }> {
  const me = await notes.getNote(vaultId, noteId);
  const boards = (await notes.backlinks(vaultId, noteId)).filter((b) => isCanvasPath(b.path));
  const arrows: BoardArrow[] = [];
  for (const b of boards) {
    const [row] = await sql`select content from notes where id = ${b.id}`;
    const c = row ? parseCanvas(row.content) : null;
    if (!c) continue;
    const files = new Map(c.nodes.filter((n) => n.type === "file" && typeof n.file === "string").map((n) => [n.id, n.file as string]));
    const mine = new Set([...files].filter(([, f]) => f.toLowerCase() === me.path.toLowerCase()).map(([id]) => id));
    for (const e of c.edges) {
      const into = mine.has(e.toNode as string);
      if (!into && !mine.has(e.fromNode as string)) continue;
      const other = files.get((into ? e.fromNode : e.toNode) as string);
      if (!other || !NOTE_FILE.test(other) || other.toLowerCase() === me.path.toLowerCase()) continue;
      const hit = await notes.findByPath(vaultId, other);
      if (!hit) continue;
      arrows.push({ id: hit.id, title: titleFromPath(hit.path), direction: into ? "from" : "to", label: typeof e.label === "string" && e.label ? e.label : null, board: { id: b.id, title: b.title } });
    }
  }
  return { boards: boards.map((b) => ({ id: b.id, title: b.title })), arrows };
}
