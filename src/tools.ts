// The tools an AI can use on Commonplace: the librarian's (search, read, list), the author's
// (create, append, rewrite) and the organiser's (edit, properties, move, split). Defined once here:
// served over MCP (src/mcp.ts) to Claude Code and other agents, and called in-process by the
// in-app assistant (src/ai.ts). Every tool runs as its user with their vault roles: a viewer's
// tools can read but not write, and a read-only token sees only the read tools.
//
// Each write tool can `preview` its change (what the note is now, and what it would become)
// without writing, so the app can show a diff and ask before anything outside the open note
// changes. Nothing deletes outright: merge_notes moves the duplicate to Trash, and so does
// copy_to_vault's move, where it can be restored.

import { isCanvasPath, parseCanvas } from "./canvas";
import { z } from "zod";
import { HttpError, type User } from "./auth";
import * as between from "./between";
import * as journal from "./journal";
import { flushNote, kick } from "./collab";
import { normalisePath, parseFrontmatter, rewriteWikiLinks, sectionRange, titleFromPath } from "./markdown";
import { withProperties } from "./props";
import * as notes from "./notes";
import { search } from "./search";
import { listTypes } from "./typeIndex";
import { linkTargets, PROP_KINDS, type TypeDef, TYPES_FOLDER, withTypeShape } from "./types";
import * as vaults from "./vaults";

export interface ToolCtx {
  user: User;
  /** False for a read-only token: write tools are hidden and refused. */
  canWrite: boolean;
  /** The vault a call means when it doesn't say (the in-app assistant's current vault). */
  defaultVault?: number;
  /** The reason saved with the version kept before each write: "mcp" or "ai". */
  reason?: string;
}

/** What a write would do, worked out without doing it. */
export interface Preview {
  summary: string;
  /** The note it changes (null when it makes one). */
  noteId: number | null;
  path: string;
  before: string | null;
  after: string | null;
}

export interface Tool {
  name: string;
  title: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  writes: boolean;
  run(ctx: ToolCtx, args: any): Promise<unknown>;
  preview?(ctx: ToolCtx, args: any): Promise<Preview>;
}

const vaultArg = z
  .union([z.number().int(), z.string()])
  .optional()
  .describe("The collection's id or name. Leave out if you have only one collection (list_vaults shows them).");
const noteArg = z.string().min(1).describe('The note, as a path ("Projects/Kitchen.md") or a title or [[wikilink]] target ("Kitchen").');

/** The vault a call means, checked against the user's role. */
async function vaultFor(ctx: ToolCtx, v: number | string | undefined, write: boolean) {
  const mine = await vaults.listVaults(ctx.user.id);
  if (v === undefined && ctx.defaultVault) v = ctx.defaultVault;
  const hit =
    v === undefined
      ? mine.length === 1
        ? mine[0]
        : undefined
      : mine.find((x) => x.id === Number(v)) ?? mine.find((x) => x.name.toLowerCase() === String(v).trim().toLowerCase());
  if (!hit) throw new HttpError(404, v === undefined ? `You have ${mine.length} collections: say which (${mine.map((x) => x.name).join(", ")})` : `No collection called “${v}”`);
  if (write && !vaults.canWrite(hit.role)) throw new HttpError(403, `“${hit.name}” is read-only for you`);
  return hit;
}

/** A note by its path, or else by link text resolved as a [[wikilink]] would be; 404 if neither. */
export async function noteFor(vaultId: number, target: string) {
  const t = target.replace(/^\[\[|\]\]$/g, "").trim();
  const hit = (await notes.findByPath(vaultId, normalisePath(t))) ?? (await notes.resolveLink(vaultId, t));
  if (!hit) throw new HttpError(404, `No note “${t}”. search_notes or list_notes can find it.`);
  return notes.getNote(vaultId, hit.id);
}

/** A note as it is right now, including typing not yet saved from its live room. */
async function liveNote(vaultId: number, target: string) {
  const n = await noteFor(vaultId, target);
  await flushNote(n.id);
  return notes.getNote(vaultId, n.id);
}

/** The section under a heading (src/markdown.ts sectionRange), or a tool error saying why not. */
function sectionOf(md: string, heading: string): { from: number; to: number } {
  const r = sectionRange(md, heading);
  if (!r) throw new HttpError(400, `No heading “${heading}” in that note (read_note shows its headings)`);
  if (r.count > 1) throw new HttpError(400, `More than one heading is called “${heading}”`);
  return r;
}

const ensureNewline = (s: string) => (s.endsWith("\n") ? s : s + "\n");
const createSummary = (path: string) => `Create “${titleFromPath(path)}”${path.includes("/") ? ` in ${path.slice(0, path.lastIndexOf("/"))}` : ""}`;

/** A write tool made of one change to one note: `next` maps its text now to its text after. */
function noteChange(summary: (title: string) => string, next: (a: any, cur: string, title: string) => string) {
  const plan = async (ctx: ToolCtx, a: any) => {
    const v = await vaultFor(ctx, a.vault, true);
    const n = await liveNote(v.id, a.note);
    const after = next(a, n.content, n.title);
    if (isCanvasPath(n.path) && !parseCanvas(after)) throw new HttpError(400, `“${n.title}” is a board (JSON Canvas): change it with rewrite_note and the whole board's JSON`);
    return { v, n, after };
  };
  return {
    preview: async (ctx: ToolCtx, a: any): Promise<Preview> => {
      const { n, after } = await plan(ctx, a);
      return { summary: summary(n.title), noteId: n.id, path: n.path, before: n.content, after };
    },
    run: async (ctx: ToolCtx, a: any) => {
      const { v, n } = await plan(ctx, a); // checks it would work before writing
      // A function of the live text, so it applies to whatever is there at that moment.
      await notes.overwriteContent(n.id, (cur) => next(a, cur, n.title), ctx.user.id, ctx.reason ?? "mcp");
      return { vault: v.name, changed: n.path };
    },
  };
}

const plain = (html: string) =>
  html
    .replace(/<\/?mark>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

const append = noteChange(
  (t) => `Add to the end of “${t}”`,
  (a, cur) => `${cur.replace(/\s*$/, "")}${cur.trim() ? "\n\n" : ""}${a.text.replace(/\s*$/, "")}\n`,
);

const edit = noteChange(
  (t) => `Edit “${t}”`,
  (a, cur, title) => {
    const at = cur.indexOf(a.find);
    if (at < 0) throw new HttpError(400, `That text isn't in “${title}” (read_note shows what is)`);
    if (cur.indexOf(a.find, at + 1) >= 0) throw new HttpError(400, `That text appears more than once in “${title}”: include more around it`);
    return cur.slice(0, at) + a.replace + cur.slice(at + a.find.length);
  },
);

const rewrite = noteChange(
  (t) => `Rewrite “${t}”`,
  (a, cur) => {
    if (!a.section) return ensureNewline(a.content);
    const s = sectionOf(cur, a.section);
    const tail = cur.slice(s.to);
    return cur.slice(0, s.from) + (tail ? ensureNewline(a.content.replace(/\s*$/, "")) + "\n" : ensureNewline(a.content)) + tail;
  },
);

const properties = noteChange(
  (t) => `Change the properties of “${t}”`,
  (a, cur) => withProperties(cur, a.properties),
);

async function planMove(ctx: ToolCtx, a: any) {
  const v = await vaultFor(ctx, a.vault, true);
  const n = await noteFor(v.id, a.note);
  const path = normalisePath(a.to);
  const clash = await notes.findByPath(v.id, path);
  if (clash && clash.id !== n.id) throw new HttpError(409, `A note already exists at ${path}`);
  return { v, n, path };
}

async function planSplit(ctx: ToolCtx, a: any) {
  const v = await vaultFor(ctx, a.vault, true);
  const n = await liveNote(v.id, a.note);
  const path = normalisePath(a.to);
  if (await notes.findByPath(v.id, path)) throw new HttpError(409, `A note already exists at ${path}`);
  const at = sectionOf(n.content, a.section);
  const section = n.content.slice(at.from, at.to);
  const [heading, ...rest] = section.split("\n");
  const body = ensureNewline(rest.join("\n").replace(/^\s*\n/, "").replace(/\s*$/, ""));
  const title = titleFromPath(path);
  // An embed, so the original still reads in full where the section was (F2).
  const stub = `${heading}\n\n![[${title}]]\n${at.to < n.content.length ? "\n" : ""}`;
  return { v, n, path, at, body, stub };
}

/** A type as the model sees it: compact, with what each property takes. */
function typeSummary(t: TypeDef) {
  return {
    name: t.name,
    notes: t.count,
    properties: t.properties.map((p) => ({
      name: p.name,
      kind: p.kind,
      ...(p.options ? { options: p.options } : {}),
      ...(p.kind === "relation" ? { links_to: p.type ?? "any note", many: !!p.many } : {}),
    })),
  };
}

const setType = noteChange(
  (t) => `Set the type of “${t}”`,
  (a, cur) => withProperties(cur, { type: a.type, ...a.set }),
);

async function planSetType(ctx: ToolCtx, a: any) {
  const v = await vaultFor(ctx, a.vault, true);
  const { types } = await listTypes(v.id);
  const t = types.find((x) => x.name.toLowerCase() === String(a.type).toLowerCase());
  if (!t) throw new HttpError(400, `There's no ${a.type} type. Types here: ${types.map((x) => x.name).join(", ") || "none yet"}. create_type makes one.`);
  const set: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(a.properties as Record<string, unknown>)) {
    const p = t.properties.find((x) => x.name.toLowerCase() === k.toLowerCase());
    if (p?.kind === "select" && val !== null && p.options?.length && !p.options.includes(String(val)))
      throw new HttpError(400, `${t.name}'s ${p.name} is one of: ${p.options.join(", ")}`);
    if (p?.kind === "relation" && val !== null && !linkTargets(val).length) throw new HttpError(400, `${p.name} takes [[links]], e.g. "[[${String(val)}]]"`);
    set[p?.name ?? k] = val;
  }
  return { v, t, set: { ...set }, type: t.name };
}

async function planCreateType(ctx: ToolCtx, a: any) {
  const v = await vaultFor(ctx, a.vault, true);
  const name = String(a.name).trim();
  if (/[\\/#^[\]|:]/.test(name)) throw new HttpError(400, "A type's name can't contain / \\ # ^ [ ] | or :");
  const { types } = await listTypes(v.id);
  if (types.some((t) => t.name.toLowerCase() === name.toLowerCase())) throw new HttpError(409, `There's already a ${name} type`);
  const path = normalisePath(`${TYPES_FOLDER}/${name}`);
  if (await notes.findByPath(v.id, path)) throw new HttpError(409, `A note already exists at ${path}`);
  const content = withTypeShape(ensureNewline(a.template), { icon: a.icon, colour: a.colour, properties: a.properties });
  return { v, path, content };
}

/** The kept note with the duplicate folded in: its missing properties, then its text. */
function mergedText(keep: string, dup: { title: string; content: string; frontmatter: Record<string, unknown> }): string {
  const fm = /^---\r?\n[\s\S]*?\r?\n?---[ \t]*(?:\r?\n|$)/;
  const keepProps = (fm.exec(keep) ? parseFrontmatter(keep).data : {}) as Record<string, unknown>;
  const missing = Object.fromEntries(Object.entries(dup.frontmatter).filter(([k, v]) => k !== "type" && !(k in keepProps) && v !== null && v !== ""));
  let text = Object.keys(missing).length ? withProperties(keep, missing) : keep;
  const body = dup.content.replace(fm, "").replace(/^\s*#\s+.*\n/, "").trim();
  if (body) text = `${text.replace(/\s*$/, "")}\n\n## From ${dup.title}\n\n${body}\n`;
  return text;
}

async function planMerge(ctx: ToolCtx, a: any) {
  const v = await vaultFor(ctx, a.vault, true);
  const keep = await liveNote(v.id, a.keep);
  const dup = await liveNote(v.id, a.merge);
  if (keep.id === dup.id) throw new HttpError(400, "That's the same note");
  const tk = (keep.frontmatter as any)?.type ?? null;
  const td = (dup.frontmatter as any)?.type ?? null;
  if (String(tk ?? "").toLowerCase() !== String(td ?? "").toLowerCase()) throw new HttpError(400, `“${keep.title}” and “${dup.title}” are different types; set them to the same type first`);
  const linkers = (await notes.backlinks(v.id, dup.id)).filter((l) => l.id !== keep.id);
  const dupKeys = new Set([dup.title.toLowerCase(), dup.path.replace(/\.md$/i, "").toLowerCase()]);
  return { v, keep, dup, linkers, dupKeys };
}

export const TOOLS: Tool[] = [
  {
    name: "list_vaults",
    title: "List collections",
    description: "The collections (separate sets of notes; the tools call them vaults) you can see, with your role in each and how many notes they hold.",
    input: z.object({}),
    writes: false,
    run: async (ctx) => ({ vaults: (await vaults.listVaults(ctx.user.id)).map((v) => ({ id: v.id, name: v.name, role: v.role, notes: v.note_count })) }),
  },
  {
    name: "search_notes",
    title: "Search notes",
    description:
      "Find notes by meaning and keywords (hybrid search). Supports tag:name and path:folder filters in the query. Returns titles, paths and a short snippet; use read_note for the full text.",
    input: z.object({
      query: z.string().min(1).describe('What to look for, e.g. "boiler service" or "tag:kitchen quotes"'),
      vault: vaultArg,
      limit: z.number().int().min(1).max(50).default(10),
    }),
    writes: false,
    run: async (ctx, a) => {
      const v = await vaultFor(ctx, a.vault, false);
      const { hits, semantic } = await search(v.id, a.query, a.limit);
      return { vault: v.name, semantic, results: hits.map((h) => ({ title: h.title, path: h.path, snippet: plain(h.snippet), via: h.via })) };
    },
  },
  {
    name: "read_note",
    title: "Read a note",
    description: "A note's full markdown, with its properties, tags, what links to it and what it links to.",
    input: z.object({ note: noteArg, vault: vaultArg }),
    writes: false,
    run: async (ctx, a) => {
      const v = await vaultFor(ctx, a.vault, false);
      const n = await noteFor(v.id, a.note);
      const [back, out] = await Promise.all([notes.backlinks(v.id, n.id), notes.outgoing(v.id, n.id)]);
      return {
        vault: v.name,
        path: n.path,
        title: n.title,
        ...(isCanvasPath(n.path) ? { kind: "board (JSON Canvas: cards in nodes, arrows in edges)" } : {}),
        tags: n.tags,
        updated_at: n.updated_at,
        backlinks: back.map((b) => b.path),
        links: out.map((o) => o.path ?? `${o.target} (not created yet)`),
        content: n.content,
      };
    },
  },
  {
    name: "list_notes",
    title: "List notes",
    description: "Notes in a collection, most recently edited first, optionally only those in one folder.",
    input: z.object({
      vault: vaultArg,
      folder: z.string().optional().describe('Only notes under this folder, e.g. "Projects"'),
      limit: z.number().int().min(1).max(500).default(50),
    }),
    writes: false,
    run: async (ctx, a) => {
      const v = await vaultFor(ctx, a.vault, false);
      const prefix = a.folder ? a.folder.replace(/^\/+|\/+$/g, "").toLowerCase() + "/" : "";
      const all = (await notes.listNotes(v.id)).filter((n) => n.path.toLowerCase().startsWith(prefix));
      all.sort((x, y) => new Date(y.updated_at).getTime() - new Date(x.updated_at).getTime());
      return { vault: v.name, total: all.length, notes: all.slice(0, a.limit).map((n) => ({ path: n.path, title: n.title, tags: n.tags, updated_at: n.updated_at })) };
    },
  },
  {
    name: "list_tags",
    title: "List tags",
    description: "Every tag in a collection, with how many notes use it.",
    input: z.object({ vault: vaultArg }),
    writes: false,
    run: async (ctx, a) => {
      const v = await vaultFor(ctx, a.vault, false);
      return { vault: v.name, tags: await notes.tagCounts(v.id) };
    },
  },
  {
    name: "create_note",
    title: "Create a note",
    description: 'Make a new note. Use folders in the path ("Projects/Kitchen") and [[wikilinks]] to connect it; frontmatter between --- lines becomes properties.',
    input: z.object({
      path: z.string().min(1).describe('Where, e.g. "Projects/Kitchen plan" (.md is added)'),
      content: z.string().max(1_000_000).default(""),
      vault: vaultArg,
    }),
    writes: true,
    run: async (ctx, a) => {
      const v = await vaultFor(ctx, a.vault, true);
      const n = await notes.createNote(v.id, ctx.user.id, a.path, await notes.withNewId(v.id, a.path, a.content));
      return { vault: v.name, created: n.path, id: n.id };
    },
    preview: async (ctx, a) => {
      const v = await vaultFor(ctx, a.vault, true);
      const path = normalisePath(a.path);
      if (await notes.findByPath(v.id, path)) throw new HttpError(409, `A note already exists at ${path}`);
      return { summary: createSummary(path), noteId: null, path, before: null, after: a.content };
    },
  },
  {
    name: "append_to_note",
    title: "Add to a note",
    description: "Add text to the end of a note. Safe while someone is editing it: it merges with their typing. Creates the note if it doesn't exist and create is true.",
    input: z.object({
      note: noteArg,
      text: z.string().min(1).max(200_000),
      create: z.boolean().default(false).describe("Make the note if it doesn't exist"),
      vault: vaultArg,
    }),
    writes: true,
    run: async (ctx, a) => {
      const v = await vaultFor(ctx, a.vault, true);
      try {
        await noteFor(v.id, a.note);
      } catch (e) {
        if (!(a.create && e instanceof HttpError && e.status === 404)) throw e;
        const created = await notes.createNote(v.id, ctx.user.id, a.note, await notes.withNewId(v.id, a.note, ensureNewline(a.text)));
        return { vault: v.name, created: created.path, id: created.id };
      }
      await append.run(ctx, a);
      return { vault: v.name, appended_to: (await noteFor(v.id, a.note)).path };
    },
    preview: async (ctx, a) => {
      const v = await vaultFor(ctx, a.vault, true);
      try {
        await noteFor(v.id, a.note);
      } catch (e) {
        if (!(a.create && e instanceof HttpError && e.status === 404)) throw e;
        const path = normalisePath(a.note);
        return { summary: createSummary(path), noteId: null, path, before: null, after: ensureNewline(a.text) };
      }
      return append.preview(ctx, a);
    },
  },
  {
    name: "add_journal_entry",
    title: "Add a journal entry",
    description:
      "Write an entry in the person's journal: today's daily note in their home collection (or the collection named), under ## Journal with the time. Use it when they ask to journal, note how their day went, or add to today's journal. Safe while they're typing in today's note.",
    input: z.object({
      text: z.string().min(1).max(20_000).describe("The entry, in the person's own words where they gave them"),
      day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("YYYY-MM-DD; today if left out"),
      time: z.string().regex(/^\d{2}:\d{2}$/).optional().describe("HH:MM, 24-hour; now if left out"),
      vault: z.union([z.number().int(), z.string()]).optional().describe("Leave out for the person's home collection"),
    }),
    writes: true,
    run: async (ctx, a) => {
      const vaultId = a.vault === undefined ? null : (await vaultFor(ctx, a.vault, true)).id;
      const r = await journal.addEntry(ctx.user, { text: a.text, day: a.day, time: a.time, vaultId });
      return { added_to: r.path, day: r.day, time: r.time };
    },
    preview: async (ctx, a) => {
      const vaultId = a.vault === undefined ? null : (await vaultFor(ctx, a.vault, true)).id;
      const p = await journal.planEntry(ctx.user, { text: a.text, day: a.day, time: a.time, vaultId });
      const before = p.existing ? (await notes.getNote(p.vaultId, p.existing.id)).content : null;
      return { summary: `Add a journal entry for ${p.day} at ${p.time}`, noteId: p.existing?.id ?? null, path: p.path, before, after: journal.addToJournal(before ?? "", p.time, p.text) };
    },
  },
  {
    name: "edit_note",
    title: "Edit a note",
    description:
      "Replace one exact piece of a note's text with another. `find` must appear exactly once (include surrounding words if needed). The previous text is kept in the note's history.",
    input: z.object({
      note: noteArg,
      find: z.string().min(1).describe("Text that is in the note now, exactly once"),
      replace: z.string().describe("What it becomes"),
      vault: vaultArg,
    }),
    writes: true,
    ...edit,
  },
  {
    name: "rewrite_note",
    title: "Rewrite a note",
    description:
      "Replace a whole note, or one section of it, with new text: for reformatting (tidy headings, turn a list into a table, fix markdown) or rewriting. With `section`, only that heading's section changes, and `content` should start with the heading line. Keep the note's facts and links unless asked to change them. The previous text is kept in the note's history.",
    input: z.object({
      note: noteArg,
      content: z.string().max(1_000_000).describe("The new text (with its --- properties --- block if rewriting a whole note that has one)"),
      section: z.string().optional().describe('Only rewrite the section under this heading, e.g. "Tasks"'),
      vault: vaultArg,
    }),
    writes: true,
    ...rewrite,
  },
  {
    name: "set_properties",
    title: "Set properties",
    description: 'Set or remove a note\'s properties (YAML frontmatter), e.g. {"status": "done", "tags": ["kitchen", "quotes"]}. null removes a property. Other properties and the text are left as they are.',
    input: z.object({
      note: noteArg,
      properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])),
      vault: vaultArg,
    }),
    writes: true,
    ...properties,
  },
  {
    name: "move_note",
    title: "Move or rename a note",
    description: 'Move a note to another folder or rename it (e.g. to "Projects/Kitchen/Quotes"). Links to it from other notes are updated. For sorting an inbox and organising folders.',
    input: z.object({ note: noteArg, to: z.string().min(1).describe('The new path, e.g. "Archive/2025/Old plan"'), vault: vaultArg }),
    writes: true,
    run: async (ctx, a) => {
      const { v, n, path } = await planMove(ctx, a);
      const moved = await notes.renameNote(v.id, n.id, path, ctx.user.id, true);
      return { vault: v.name, moved: n.path, to: moved.path };
    },
    preview: async (ctx, a) => {
      const { v, n, path } = await planMove(ctx, a);
      const linkers = await notes.backlinks(v.id, n.id);
      const links = linkers.length ? `, updating links in ${linkers.length} note${linkers.length === 1 ? "" : "s"}` : "";
      return { summary: `Move “${n.title}” to ${path}${links}`, noteId: n.id, path: n.path, before: n.path, after: path };
    },
  },
  {
    name: "split_note",
    title: "Split a section into its own note",
    description: "Move one section of a note into a new note of its own, leaving an embed (![[New note]]) where the section was, so the original still reads in full. For breaking up a long note.",
    input: z.object({
      note: noteArg,
      section: z.string().describe("The heading of the section to move out"),
      to: z.string().min(1).describe('The new note\'s path, e.g. "Projects/Kitchen/Budget"'),
      vault: vaultArg,
    }),
    writes: true,
    run: async (ctx, a) => {
      const p = await planSplit(ctx, a);
      const created = await notes.createNote(p.v.id, ctx.user.id, p.path, await notes.withNewId(p.v.id, p.path, p.body));
      await notes.overwriteContent(
        p.n.id,
        (cur) => {
          const s = sectionOf(cur, a.section);
          return cur.slice(0, s.from) + p.stub + cur.slice(s.to);
        },
        ctx.user.id,
        ctx.reason ?? "mcp",
      );
      return { vault: p.v.name, created: created.path, id: created.id, changed: p.n.path };
    },
    preview: async (ctx, a) => {
      const p = await planSplit(ctx, a);
      return {
        summary: `Move “${a.section}” out of “${p.n.title}” into a new note, ${p.path}`,
        noteId: p.n.id,
        path: p.n.path,
        before: p.n.content,
        after: p.n.content.slice(0, p.at.from) + p.stub + p.n.content.slice(p.at.to),
      };
    },
  },
  {
    name: "list_types",
    title: "List types",
    description:
      "The collection's types (Person, Meeting, Book…): what kinds of thing its notes are, each with its properties (and their kinds, choices and the type a link points at) and how many notes it has. Also types notes use that nobody has defined yet.",
    input: z.object({ vault: vaultArg }),
    writes: false,
    run: async (ctx, a) => {
      const v = await vaultFor(ctx, a.vault, false);
      const r = await listTypes(v.id);
      return { vault: v.name, types: r.types.map(typeSummary), undefined_types: r.undefined };
    },
  },
  {
    name: "set_type",
    title: "Set a note's type",
    description:
      'Say what a note is (a Person, a Meeting…) and optionally fill in its properties, e.g. {"note": "Sam", "type": "Person", "properties": {"role": "Trade", "organisation": "[[Acme]]"}}. Choices must be one of the type\'s options; links are [[wikilinks]]. For filing an inbox into types. The type must exist (create_type makes one).',
    input: z.object({
      note: noteArg,
      type: z.string().min(1).describe("A type's name, as list_types shows it"),
      properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])).default({}),
      vault: vaultArg,
    }),
    writes: true,
    run: async (ctx, a) => {
      const { v, set } = await planSetType(ctx, a);
      return { ...(await setType.run(ctx, { ...a, vault: v.id, set })), type: a.type };
    },
    preview: async (ctx, a) => {
      const { v, set, type } = await planSetType(ctx, a);
      const pv = await setType.preview(ctx, { ...a, vault: v.id, set });
      const title = pv.path.replace(/\.md$/, "").split("/").pop();
      const keys = Object.keys(set).filter((k) => set[k] !== null);
      return { ...pv, summary: `Make “${title}” a ${type}${keys.length ? ` (${keys.join(", ")})` : ""}` };
    },
  },
  {
    name: "create_type",
    title: "Create a type",
    description:
      'Make a new type when several notes are the same kind of thing ("these 14 notes are recipes"). Give it a singular name, properties (name, kind, and options for a choice or type for a link), an icon and a colour, and a template (markdown for new notes of the type; {{title}} is filled in). Kinds: ' +
      PROP_KINDS.join(", ") +
      ". Icons: user, users, building, calendar, briefcase, book, bookmark, lightbulb, file, tag. Colours: purple, blue, green, amber, red, grey.",
    input: z.object({
      name: z.string().min(1).max(80).describe('Singular: "Recipe", not "Recipes"'),
      properties: z
        .array(
          z.object({
            name: z.string().min(1).max(80),
            kind: z.enum(PROP_KINDS as [string, ...string[]]),
            options: z.array(z.string()).optional(),
            type: z.string().optional(),
            many: z.boolean().optional(),
          }),
        )
        .max(30)
        .default([]),
      icon: z.string().default("file"),
      colour: z.enum(["purple", "blue", "green", "amber", "red", "grey"]).default("purple"),
      template: z.string().max(20_000).default("# {{title}}\n"),
      vault: vaultArg,
    }),
    writes: true,
    run: async (ctx, a) => {
      const p = await planCreateType(ctx, a);
      const n = await notes.createNote(p.v.id, ctx.user.id, p.path, p.content);
      return { vault: p.v.name, created: n.path, id: n.id, type: a.name };
    },
    preview: async (ctx, a) => {
      const p = await planCreateType(ctx, a);
      const props = a.properties.map((x: any) => x.name).join(", ");
      return { summary: `Create the ${a.name} type${props ? ` (${props})` : ""}`, noteId: null, path: p.path, before: null, after: p.content };
    },
  },
  {
    name: "copy_to_vault",
    title: "Copy or move notes to another collection",
    description:
      "Copy a note, or a whole folder, into another of your collections (a GitHub collection too), with the pictures and files its notes embed and any type the other collection lacks. With move, each note takes its history along and the original goes to Trash (restorable for 30 days). A name already taken there keeps both (\"Plan 1\").",
    input: z.object({
      note: noteArg.optional().describe("The note to send; or leave out and give folder"),
      folder: z.string().optional().describe('A folder to send with everything in it, e.g. "Projects/Kitchen"'),
      vault: vaultArg.describe("The collection it's in now (id or name)"),
      to_vault: z.union([z.number().int(), z.string()]).describe("The collection to send it to (id or name; list_vaults shows them)"),
      into: z.string().default("").describe('The folder there to put it in; leave out for the top level'),
      move: z.boolean().default(false).describe("Move instead of copy: the original goes to Trash"),
    }),
    writes: true,
    run: async (ctx, a) => {
      const r = await planCopy(ctx, a);
      const out = await between.send(ctx.user, r);
      return { vault: r.toName, copied: out.created.filter((c) => c.from).map((c) => c.path), moved: a.move, files: out.files.length };
    },
    preview: async (ctx, a) => {
      const r = await planCopy(ctx, a);
      const p = await between.planSend(ctx.user, r);
      const one = p.notes.length === 1 ? p.notes[0]! : null;
      return { summary: between.describePlan(p), noteId: null, path: one?.to ?? r.into, before: one ? `${p.from.name}: ${one.path}` : null, after: one ? `${p.to.name}: ${one.to}` : p.notes.map((n) => n.to).join("\n") };
    },
  },
  {
    name: "merge_notes",
    title: "Merge duplicate notes",
    description:
      "Fold a duplicate into the note to keep: its text goes at the end of the kept note under its title, properties the kept note lacks are copied over, every link to the duplicate is changed to point at the kept note, and the duplicate goes to Trash (restorable for 30 days). For notes about the same thing, of the same type (or both untyped).",
    input: z.object({ keep: noteArg, merge: noteArg.describe("The duplicate to fold in"), vault: vaultArg }),
    writes: true,
    run: async (ctx, a) => {
      const p = await planMerge(ctx, a);
      await notes.overwriteContent(p.keep.id, (cur) => mergedText(cur, p.dup), ctx.user.id, ctx.reason ?? "mcp");
      let relinked = 0;
      for (const l of p.linkers) {
        const src = await notes.getNote(p.v.id, l.id);
        const next = rewriteWikiLinks(src.content, (t) => p.dupKeys.has(t) || [...p.dupKeys].some((k) => k.endsWith("/" + t)), p.keep.title);
        if (next !== src.content) {
          await notes.overwriteContent(src.id, next, ctx.user.id, ctx.reason ?? "mcp");
          relinked++;
        }
      }
      kick({ noteId: p.dup.id }, "note deleted");
      await flushNote(p.dup.id);
      const trashId = await notes.deleteNote(p.v.id, p.dup.id, ctx.user.id);
      return { vault: p.v.name, changed: p.keep.path, merged: p.dup.path, relinked, trashId };
    },
    preview: async (ctx, a) => {
      const p = await planMerge(ctx, a);
      const links = p.linkers.length ? `, ${p.linkers.length} note${p.linkers.length === 1 ? "" : "s"} relinked` : "";
      return {
        summary: `Merge “${p.dup.title}” into “${p.keep.title}”${links}; “${p.dup.title}” goes to Trash`,
        noteId: p.keep.id,
        path: p.keep.path,
        before: p.keep.content,
        after: mergedText(p.keep.content, p.dup),
      };
    },
  },
];

/** copy_to_vault's arguments as a send between vaults (src/between.ts). */
async function planCopy(ctx: ToolCtx, a: any) {
  if (!a.note === !a.folder) throw new HttpError(400, "Give either a note or a folder");
  const from = await vaultFor(ctx, a.vault, a.move);
  const to = await vaultFor(ctx, a.to_vault, true);
  const n = a.note ? await noteFor(from.id, a.note) : null;
  return { from: from.id, to: to.id, toName: to.name, notes: n ? [n.id] : undefined, folder: a.folder, into: a.into ?? "", move: !!a.move };
}

/** The tools this caller may see. */
export const toolsFor = (ctx: ToolCtx) => TOOLS.filter((t) => ctx.canWrite || !t.writes);

/** Run a tool by name with validated arguments. */
export async function callTool(ctx: ToolCtx, name: string, args: unknown): Promise<unknown> {
  const tool = toolsFor(ctx).find((t) => t.name === name);
  if (!tool) throw new HttpError(404, `No tool called ${name}`);
  const parsed = tool.input.safeParse(args ?? {});
  if (!parsed.success) throw new HttpError(400, parsed.error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; "));
  return tool.run(ctx, parsed.data);
}

/** JSON Schema for a tool's input, for MCP's tools/list. */
export function inputSchema(t: Tool): Record<string, unknown> {
  const s = z.toJSONSchema(t.input, { io: "input" }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
