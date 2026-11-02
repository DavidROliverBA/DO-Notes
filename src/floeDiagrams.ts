// Floe diagrams in notes (F41 step 4; the script is scripts/floe-diagrams.ts): a ```mermaid
// block whose first line is `%% floe: <landscape> / <diagram> · <id>` shows that Floe diagram,
// filled with Floe's Mermaid C4. Shared by the server (Update from Floe), the browser (the `/`
// menu's Floe diagram…) and the script. No server imports.

/** What a `%% floe:` line names: an id, or a landscape and diagram by name, or both. */
export interface DiagramRef {
  id: string | null;
  landscape: string | null;
  diagram: string | null;
}

export interface FloeBlock {
  /** The whole fenced block, fences included, exactly as it is in the note. */
  text: string;
  ref: DiagramRef;
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*mermaid[ \t]*\r?\n([\s\S]*?)^\1\2[ \t]*$/gm;
const MARK = /^[ \t]*%%[ \t]*floe:[ \t]*(.*?)[ \t]*(?:%%)?[ \t]*$/;

export function parseRef(spec: string): DiagramRef | null {
  const s = spec.trim();
  if (!s) return null;
  const [names, id] = s.includes("·") ? (s.split("·", 2).map((x) => x.trim()) as [string, string]) : s.includes("/") ? [s, ""] : ["", s];
  let landscape: string | null = null;
  let diagram: string | null = null;
  if (names) {
    const cut = names.lastIndexOf("/");
    if (cut < 0) return id ? { id, landscape: null, diagram: null } : null;
    landscape = names.slice(0, cut).trim() || null;
    diagram = names.slice(cut + 1).trim() || null;
  }
  if (!id && !(landscape && diagram)) return null;
  return { id: id || null, landscape, diagram };
}

/** The Floe blocks in a note, in order. A mermaid block counts when its first line is `%% floe: …`. */
export function findBlocks(content: string): FloeBlock[] {
  const out: FloeBlock[] = [];
  for (const m of content.matchAll(FENCE)) {
    const first = m[3]!.split(/\r?\n/, 1)[0]!;
    const mark = MARK.exec(first);
    const ref = mark ? parseRef(mark[1]!) : null;
    if (ref) out.push({ text: m[0], ref });
  }
  return out;
}

/** The block as it should be: same fences and indent, the canonical `%% floe:` line, then the diagram. */
export function renderBlock(old: string, ref: { id: string; landscape: string; diagram: string }, mermaid: string): string {
  const m = /^([ \t]*)(`{3,}|~{3,})/.exec(old)!;
  const [indent, fence] = [m[1]!, m[2]!];
  const body = [listLine(ref), ...mermaid.trimEnd().split(/\r?\n/)];
  return [`${indent}${fence}mermaid`, ...body.map((l) => (l ? indent + l : l)), `${indent}${fence}`].join("\n");
}

/** The line that names a diagram in a block, as --list prints it and a refresh writes it. */
export function listLine(d: { id: string; landscape: string; diagram: string }): string {
  return `%% floe: ${d.landscape.replace(/[·/]/g, "-")} / ${d.diagram.replace(/[·/]/g, "-")} · ${d.id}`;
}

export function resolve(index: { id: string; landscape: string; diagram: string }[], ref: DiagramRef): { id: string; landscape: string; diagram: string } | string {
  if (ref.id) {
    const hit = index.find((d) => d.id === ref.id);
    if (hit) return hit;
    if (!ref.landscape) return `no diagram with id ${ref.id}`;
  }
  const same = (a: string, b: string | null) => a.trim().toLowerCase() === b?.trim().toLowerCase();
  const hits = index.filter((d) => same(d.landscape, ref.landscape) && same(d.diagram, ref.diagram));
  if (hits.length === 1) return hits[0]!;
  return hits.length ? `${hits.length} diagrams are called "${ref.landscape} / ${ref.diagram}"; use the id` : `no diagram "${ref.landscape} / ${ref.diagram}"`;
}

/** A new block for a diagram, filled. */
export function newBlock(ref: { id: string; landscape: string; diagram: string }, mermaid: string): string {
  return renderBlock("```mermaid\n```", ref, mermaid);
}

/** Floe's page for a diagram: its web address (the MCP address without /mcp) and the diagram's route. */
export function floeDiagramUrl(web: string, landscapeId: string, diagramId: string): string {
  return `${web.replace(/\/+$/, "")}/#/l/${encodeURIComponent(landscapeId)}/d/${encodeURIComponent(diagramId)}`;
}
