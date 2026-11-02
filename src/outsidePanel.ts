// "From your connections" in the side panel (F33 step 4, docs/design/F33.md): for the open note,
// what each connected service has on it. Off for each connection until the person turns it on in
// Review, because it sends something of the note out without asking each time; what it sends is
// fixed and said there: the note's title, never its text. One read tool per connection: the
// preset's, or a read tool with a single text input. Answers are shown as links (title, address,
// date), never as HTML, and kept for ten minutes per note.

import { HttpError } from "./auth";
import { clientFor, type ConnectionRow, type ToolRow, wrap } from "./connections";
import { sql } from "./db";
import { presetFor } from "./presets";

const CACHE_MS = 10 * 60_000;
const MOST = 5;

export interface PanelItem {
  title: string;
  url: string | null;
  date: string | null;
}

/** The input a tool's search words go in: the preset's, else its one text input. */
export function inputFor(c: Pick<ConnectionRow, "preset">, t: Pick<ToolRow, "name" | "input_schema" | "kind">): string | null {
  if (t.kind !== "read") return null;
  const p = presetFor(c.preset)?.tools[t.name];
  if (p) return p.panel ?? null;
  const schema = t.input_schema as { properties?: Record<string, { type?: string }>; required?: string[] };
  const texts = Object.entries(schema.properties ?? {}).filter(([, v]) => v?.type === "string").map(([k]) => k);
  const required = schema.required ?? [];
  if (required.length > 1 || required.some((r) => !texts.includes(r))) return null;
  if (required.length === 1) return required[0]!;
  return texts.length === 1 ? texts[0]! : null;
}

async function own(userId: number, id: number): Promise<ConnectionRow> {
  const [c] = await sql<ConnectionRow[]>`select * from connections where id = ${id} and user_id = ${userId}`;
  if (!c) throw new HttpError(404, "No such connection");
  return c;
}

/** Review's side-panel choice: the tools that could look a note up, and the one in use. */
export async function panelChoice(userId: number, id: number) {
  const c = await own(userId, id);
  const tools = await sql<ToolRow[]>`select * from connection_tools where connection_id = ${c.id} and enabled order by name`;
  const candidates = tools.filter((t) => inputFor(c, t)).map((t) => ({ name: t.name, title: t.title ?? t.name }));
  return { tool: c.panel_tool && candidates.some((x) => x.name === c.panel_tool) ? c.panel_tool : null, candidates };
}

export async function setPanel(userId: number, id: number, tool: string | null) {
  const c = await own(userId, id);
  if (tool) {
    const [t] = await sql<ToolRow[]>`select * from connection_tools where connection_id = ${c.id} and name = ${tool} and enabled`;
    if (!t || !inputFor(c, t)) throw new HttpError(400, `${tool} can't look up a note: choose a read tool that's on and takes words to search for`);
  }
  await sql`update connections set panel_tool = ${tool} where id = ${c.id}`;
  for (const k of cache.keys()) if (k.startsWith(`${userId}:`)) cache.delete(k);
  return panelChoice(userId, id);
}

const isWeb = (u: unknown): u is string => typeof u === "string" && /^https?:\/\//i.test(u);
const first = (o: Record<string, unknown>, keys: string[]) => keys.map((k) => o[k]).find((v) => typeof v === "string" && v.trim()) as string | undefined;

/** The first list in an answer whose entries have titles: Longview's events, Recall's cards, a
 *  search's results. Each as a title, a web address if it has one, and a date. */
export function itemsIn(answer: unknown): PanelItem[] {
  const queue: unknown[] = [answer];
  for (let seen = 0; queue.length && seen < 200; seen++) {
    const v = queue.shift();
    if (Array.isArray(v)) {
      const items = v
        .filter((x): x is Record<string, unknown> => !!x && typeof x === "object" && !Array.isArray(x))
        .map((x) => {
          const title = first(x, ["title", "name", "headline", "label"]);
          const url = [x.url, x.source_url, x.link, x.href].find(isWeb) ?? null;
          const date = first(x, ["date", "published", "published_at", "created_at", "updated_at"]) ?? null;
          return title ? { title: title.replace(/\s+/g, " ").trim().slice(0, 200), url, date: date ? date.slice(0, 10) : null } : null;
        })
        .filter((x): x is PanelItem => !!x);
      if (items.length) return items.slice(0, MOST);
      queue.push(...v);
    } else if (v && typeof v === "object") queue.push(...Object.values(v));
  }
  return [];
}

const cache = new Map<string, { at: number; items: PanelItem[] }>();

/** For the open note: each connection in the panel, looked up by the note's title. */
export async function lookup(user: { id: number }, vaultId: number, noteId: number) {
  const [note] = await sql`select title, type_name from notes where id = ${noteId} and vault_id = ${vaultId}`;
  if (!note) throw new HttpError(404, "Note not found");
  const query = String(note.title).trim();
  const rows = await sql<(ConnectionRow & ToolRow)[]>`
    select c.*, t.name as tool_name, t.input_schema, t.kind from connections c
    join connection_tools t on t.connection_id = c.id and t.name = c.panel_tool and t.enabled
    where c.user_id = ${user.id} and c.status = 'ok' order by c.created_at`;
  const now = Date.now();
  for (const [k, v] of cache) if (now - v.at > CACHE_MS) cache.delete(k);
  return Promise.all(
    rows.map(async (r) => {
      const c = r as unknown as ConnectionRow & { tool_name: string };
      const key = `${user.id}:${c.id}:${noteId}:${query}`;
      const hit = cache.get(key);
      if (hit) return { id: Number(c.id), name: c.name, items: hit.items, problem: null };
      const input = inputFor(c, { name: c.tool_name, input_schema: r.input_schema, kind: r.kind });
      if (!input || !query) return { id: Number(c.id), name: c.name, items: [], problem: null };
      const fixed = presetFor(c.preset)?.tools[c.tool_name]?.fixed ?? {};
      try {
        const items = itemsIn(await (await clientFor(c)).call(c.tool_name, { ...fixed, [input]: query }));
        cache.set(key, { at: now, items });
        return { id: Number(c.id), name: c.name, items, problem: null };
      } catch (e) {
        const w = wrap(c, e);
        return { id: Number(c.id), name: c.name, items: [], problem: w.status === 409 ? w.message : `Couldn't reach ${c.name}` };
      }
    }),
  );
}
