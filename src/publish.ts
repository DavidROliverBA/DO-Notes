// Publish a vault as a website (F18 step 1). An owner chooses what's published (the whole vault
// or folders; a note with `publish: false` stays out) in publish.json at the vault's top level, so
// the choice travels with an export or a GitHub repo. Publish takes a snapshot: each chosen note
// rendered to HTML and every file those pages show, copied into site_pages and site_files. The
// site at /p/<slug>/ is served from the snapshot alone, never from notes or attachments, so a note
// that isn't published, its title and its files can't be reached by any URL, and edits stay private
// until the next Publish.
//
// Pages carry no script at all, and the CSP says so: a note's raw HTML is cut down to a few
// formatting tags without attributes, and the page is sandboxed, so nothing on it runs as the app.
// A dataviewjs block's script runs in the publisher's browser, in the same sandbox as in the app,
// over the published notes only; what it drew comes back with Publish and is cleaned here.
// Links between pages are relative, so the same snapshot can later be served at a custom domain.

import { randomBytes } from "node:crypto";
import { Marked, type Tokens } from "marked";
import { z } from "zod";
import { resolveLocal } from "../web/lib/links";
import { hiloColour } from "../web/lib/colours";
import { HttpError, isSecure, type User } from "./auth";
import { sql } from "./db";
import { codeBlockHtml } from "./codeHighlight";
import { countWords, extractLinks, extractTags, findWikiLinks, headings, isAttachmentPath, maskCode, normalisePath, parseFrontmatter, plainInline, readingMinutes, sectionRange, SITE_SETTINGS } from "./markdown";
import { STATUS_RE, statusColour, TOC_RE, tocHtml } from "./blocks";
import { listNotes } from "./notes";
import { assertRoom } from "./storage";
import { inlineQuery, type PageData, readPage, runInline, runQuery, Vault } from "./dataview";
import { dataviewFile } from "./dataviewVault";
import { renderResult, renderValue, type RenderOpts } from "./dataviewRender";

// ── settings (publish.json) ────────────────────────────────────────────────────────────────

/** What the builder switches on (F18 step 2). Each is off until chosen, so a site published
 *  before the builder looks the same after it. */
export const FEATURES = ["sidebar", "contents", "backlinks", "tags", "updated", "readingTime", "themeSwitch"] as const;
export type Feature = (typeof FEATURES)[number];
const Features = z.object(Object.fromEntries(FEATURES.map((f) => [f, z.boolean().optional()])) as Record<Feature, z.ZodOptional<z.ZodBoolean>>);
export type SiteFeatures = z.infer<typeof Features>;

const Settings = z.looseObject({
  /** Folders to publish; empty: the whole vault. */
  include: z.array(z.string().max(512)).max(1000).default([]),
  /** The site's name; the vault's name when unset. */
  title: z.string().max(200).optional(),
  features: Features.optional(),
});
export type SiteSettings = z.infer<typeof Settings>;

export async function readSettings(vaultId: number): Promise<{ settings: SiteSettings; error?: string }> {
  const [f] = await sql`select data from attachments where vault_id = ${vaultId} and path = ${SITE_SETTINGS}`;
  if (!f) return { settings: { include: [] } };
  try {
    return { settings: Settings.parse(JSON.parse(new TextDecoder().decode(f.data))) };
  } catch {
    // Never fall back to "everything": a broken file must not publish more than was chosen.
    return { settings: { include: [] }, error: `${SITE_SETTINGS} isn't valid, so nothing can be published until it's fixed or what's published is chosen again.` };
  }
}

/** Set the published folders and features in publish.json, keeping any other keys in it. */
export async function saveSettings(vaultId: number, userId: number, change: { include?: string[]; features?: SiteFeatures }): Promise<SiteSettings> {
  const { settings, error } = await readSettings(vaultId);
  // A broken file is replaced only by choosing what's published again: saving a feature alone
  // would otherwise turn it into "the whole vault".
  if (error && !change.include) throw new HttpError(400, error);
  const base: SiteSettings = error ? { include: [] } : settings;
  const next: SiteSettings = { ...base };
  if (change.include) next.include = [...new Set(change.include.map((f) => normalisePath(f, null)))].sort();
  if (change.features) next.features = { ...base.features, ...change.features };
  const data = new TextEncoder().encode(JSON.stringify(next, null, 2) + "\n");
  await assertRoom(data.byteLength);
  await sql`insert into attachments (vault_id, path, mime, size, data, created_by)
            values (${vaultId}, ${SITE_SETTINGS}, 'application/json', ${data.byteLength}, ${data}, ${userId})
            on conflict (vault_id, path) do update set data = excluded.data, size = excluded.size, mime = excluded.mime`;
  return next;
}

// ── what's published ──────────────────────────────────────────────────────────────────────

interface Chosen {
  id: number;
  path: string;
  title: string;
  content: string;
  md5: string;
  created_at: Date;
  updated_at: Date;
}

/** The notes the settings choose, and those kept out by `publish: false`. */
async function choose(vaultId: number, s: SiteSettings): Promise<{ pages: Chosen[]; held: string[] }> {
  const rows = await sql<(Chosen & { held: boolean })[]>`
    select id, path, title, content, md5(content) as md5, created_at, updated_at,
           coalesce(frontmatter->'publish' = 'false'::jsonb or lower(frontmatter->>'publish') in ('false', 'no'), false) as held
    from notes where vault_id = ${vaultId} order by lower(path)`;
  const inFolders = (p: string) => !s.include.length || s.include.some((f) => p.startsWith(f + "/"));
  const chosen = rows.filter((r) => inFolders(r.path));
  return { pages: chosen.filter((r) => !r.held), held: chosen.filter((r) => r.held).map((r) => r.path) };
}

/** "Projects/Plan.md" → "Projects/Plan": the page's address under the site. */
const pagePath = (notePath: string) => notePath.replace(/\.md$/i, "");

const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** A file a note refers to, resolved as the app does: relative to the note, the exact path, then
 *  the shortest path ending with it (links go by file name). */
function resolveFile(files: string[], notePath: string, target: string): string | undefined {
  const t = safeDecode(target.split("#")[0]!.split("?")[0]!).trim().replace(/^\.?\//, "");
  if (!t) return undefined;
  const dir = notePath.includes("/") ? notePath.slice(0, notePath.lastIndexOf("/")) : "";
  const parts: string[] = [];
  for (const seg of `${dir}/${t}`.split("/")) seg === ".." ? parts.pop() : seg && seg !== "." && parts.push(seg);
  const relative = parts.join("/").toLowerCase();
  const want = t.toLowerCase();
  let best: string | undefined;
  for (const f of files) {
    const l = f.toLowerCase();
    if (l === relative || l === want) return f;
    if (l.endsWith("/" + want) && (!best || f.length < best.length)) best = f;
  }
  return best;
}

/** Hidden text: %%comments%% (an unclosed one hides the rest), ^block-ids, and a daily note's
 *  `## Journal` section (F24: the journal is private, even on a site of the whole collection). */
function stripHidden(md: string): string {
  const masked = maskCode(md);
  const cuts: [number, number][] = [];
  for (const m of masked.matchAll(/%%[\s\S]*?(?:%%|$(?![\s\S]))/g)) cuts.push([m.index!, m.index! + m[0].length]);
  for (const m of masked.matchAll(/[ \t]\^[\w-]+[ \t]*$/gm)) cuts.push([m.index!, m.index! + m[0].length]);
  const headings = [...masked.matchAll(/^#{1,2}[ \t].*$/gm)];
  headings.forEach((h, i) => {
    if (/^##[ \t]+journal[ \t]*$/i.test(h[0])) cuts.push([h.index!, headings[i + 1]?.index ?? masked.length]);
  });
  cuts.sort((a, b) => a[0] - b[0]);
  let out = "";
  let at = 0;
  for (const [from, to] of cuts) {
    if (from < at) continue; // inside a comment already cut
    out += md.slice(at, from);
    at = to;
  }
  return out + md.slice(at);
}

const MD_LINK = /(!?)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EXTERNAL = /^([a-z][a-z0-9+.-]*:|\/\/)/i;

/** Every vault file a note's visible text shows or links to. */
function fileRefs(files: string[], notePath: string, md: string): string[] {
  const body = stripHidden(parseFrontmatter(md).body);
  const out: string[] = [];
  for (const l of findWikiLinks(body)) if (isAttachmentPath(l.target)) out.push(l.target);
  for (const m of maskCode(body).matchAll(MD_LINK)) if (!EXTERNAL.test(m[2]!) && !m[2]!.startsWith("#") && isAttachmentPath(safeDecode(m[2]!))) out.push(m[2]!);
  return out.map((t) => resolveFile(files, notePath, t)).filter((f): f is string => !!f);
}

// ── rendering ─────────────────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const encodePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");
/** From a page to the site's root: "./" at the top, "../../" two folders down. */
const rootFrom = (page: string) => "../".repeat(page.split("/").length - 1) || "./";

export function headingId(text: string): string {
  return (
    plainInline(text)
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-") || "section"
  );
}

// Raw HTML in a note keeps a few formatting tags, never attributes; script-like elements go with
// their content, everything else leaves its text.
const KEEP = new Set(["b", "i", "em", "strong", "u", "s", "del", "ins", "sub", "sup", "kbd", "mark", "small", "span", "div", "p", "br", "hr", "details", "summary", "center"]);
const DROP = new Set(["script", "style", "iframe", "object", "embed", "template", "noscript", "textarea", "select", "svg", "math", "title", "head", "frameset", "frame"]);
function cleanHtml(src: string): string {
  let out = "";
  let skip: string | null = null;
  for (const m of src.matchAll(/<!--[\s\S]*?(?:-->|$(?![\s\S]))|<(\/?)([a-zA-Z][\w-]*)\b[^>]*>|[^<]+|</g)) {
    const [all, close, tag] = m;
    if (all.startsWith("<!--")) continue;
    if (tag) {
      const t = tag.toLowerCase();
      if (skip) {
        if (close && t === skip) skip = null;
      } else if (DROP.has(t)) {
        if (!close && !all.endsWith("/>")) skip = t;
      } else if (KEEP.has(t)) out += t === "br" || t === "hr" ? (close ? "" : `<${t}>`) : `<${close}${t}>`;
      continue;
    }
    if (!skip) out += all.replace(/&(?!(?:[a-z]+|#\d+|#x[\da-f]+);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  return out;
}

// ── what a dataviewjs block drew, frozen at Publish ──────────────────────────────────────

/** What a frozen block may keep: the tags Dataview's views and a script's dv.el use. */
const FROZEN_TAGS = new Set([...KEEP, "a", "h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "blockquote", "pre", "code", "input", "label"]);
const unesc = (s: string) => s.replace(/&(quot|#39|lt|gt|amp);/g, (_, e) => ({ quot: '"', "#39": "'", lt: "<", gt: ">", amp: "&" })[e as string]!);

/** A frozen block's HTML, with only the tags above and a few safe attributes: classes (letters,
 *  digits and dashes), table spans, labels, done checkboxes (always disabled), web links, and
 *  links to notes, which become links to their pages, or plain words when not published. */
export function cleanFrozen(src: string, note: (target: string) => string | null): string {
  let out = "";
  let skip: string | null = null;
  const open: string[] = [];
  for (const m of src.matchAll(/<!--[\s\S]*?(?:-->|$(?![\s\S]))|<(\/?)([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>|[^<]+|</g)) {
    const [all, close, tag, rest = ""] = m;
    if (all.startsWith("<!--")) continue;
    if (!tag) {
      if (!skip) out += all.replace(/&(?!(?:[a-z]+|#\d+|#x[\da-f]+);)/gi, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      continue;
    }
    const t = tag.toLowerCase();
    if (skip) {
      if (close && t === skip) skip = null;
      continue;
    }
    if (DROP.has(t) || t === "button") {
      if (!close && !all.endsWith("/>")) skip = t;
      continue;
    }
    if (!FROZEN_TAGS.has(t)) continue;
    if (close) {
      // A link to a note that isn't published was kept as words: its closing tag goes too.
      if (t === "a" && open.pop() === "") continue;
      if (t !== "br" && t !== "hr" && t !== "input") out += `</${t}>`;
      continue;
    }
    const attrs = new Map<string, string>();
    for (const a of rest.matchAll(/([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) attrs.set(a[1]!.toLowerCase(), unesc(a[2] ?? a[3] ?? a[4] ?? ""));
    const keep: string[] = [];
    const cls = (attrs.get("class") ?? "").split(/\s+/).filter((c) => /^[\w-]+$/.test(c));
    if (cls.length) keep.push(`class="${esc(cls.join(" "))}"`);
    if (attrs.has("aria-label")) keep.push(`aria-label="${esc(attrs.get("aria-label")!.slice(0, 200))}"`);
    if (t === "th" || t === "td") for (const k of ["colspan", "rowspan"]) if (/^\d{1,3}$/.test(attrs.get(k) ?? "")) keep.push(`${k}="${attrs.get(k)}"`);
    if (t === "th" && /^(col|row)$/.test(attrs.get("scope") ?? "")) keep.push(`scope="${attrs.get("scope")}"`);
    if (t === "input") {
      if (attrs.get("type") !== "checkbox") continue;
      out += `<input type="checkbox"${keep.length ? " " + keep.join(" ") : ""} disabled${attrs.has("checked") ? " checked" : ""}>`;
      continue;
    }
    if (t === "a") {
      const target = attrs.get("data-dv-open");
      const href = attrs.get("href") ?? "";
      let link: string | null = null;
      if (target) link = note(target);
      else if (/^https?:\/\//i.test(href)) link = href;
      open.push(link === null ? "" : "a");
      if (link === null) continue;
      keep.push(`href="${esc(link)}"`);
      if (!target) keep.push(`rel="noopener noreferrer nofollow"`);
    }
    out += t === "br" || t === "hr" ? `<${t}>` : `<${t}${keep.length ? " " + keep.join(" ") : ""}>`;
  }
  return out;
}

const frozenKey = (path: string, code: string) => `${path}\n${code}`;

/** Every ```dataviewjs block on the pages Publish would make, with the published notes (all
 *  their scripts may see), for the publisher's browser to run (web/lib/dataviewjs.ts). */
export async function dataviewjsToFreeze(vaultId: number): Promise<{ blocks: { path: string; code: string }[]; pages: PageData[] }> {
  const p = await plan(vaultId);
  if (p.error) throw new HttpError(400, p.error);
  const blocks: { path: string; code: string }[] = [];
  const lexer = new Marked({ gfm: true });
  for (const n of p.pages) {
    const seen = new Set<string>();
    lexer.walkTokens(lexer.lexer(stripHidden(parseFrontmatter(n.content).body)), (t) => {
      if (t.type !== "code" || (t as Tokens.Code).lang?.trim().split(/\s/)[0]!.toLowerCase() !== "dataviewjs") return;
      const code = (t as Tokens.Code).text;
      if (!seen.has(code)) blocks.push({ path: n.path, code });
      seen.add(code);
    });
  }
  return { blocks, pages: blocks.length ? publishedVault(p).pages : [] };
}

/** dv.io.load and dv.view while freezing: a published note, a file the site carries, or a view's
 *  .js or .css (code, not content). Nothing else of the vault reaches a published page. */
export async function dataviewjsFreezeFile(vaultId: number, path: string): Promise<string> {
  const p = await plan(vaultId);
  if (p.error) throw new HttpError(400, p.error);
  const clean = path.replace(/^\/+/, "");
  const isNote = /\.md$/i.test(clean) || !/\.[a-z0-9]{1,8}$/i.test(clean);
  if (isNote) {
    const hit = publishedVault(p).resolve(clean.replace(/\.md$/i, ""));
    const n = hit && p.pages.find((x) => x.path === hit);
    if (n) return n.content;
  }
  if (p.files.includes(clean) || /\.(js|css)$/i.test(clean)) return dataviewFile(vaultId, clean);
  throw new HttpError(404, `${path} isn't published, so a published page can't show it`);
}

const publishedVault = (p: Plan) => new Vault(p.pages.map((n) => readPage({ path: n.path, content: n.content, ctime: new Date(n.created_at).getTime(), mtime: new Date(n.updated_at).getTime() })));

interface RenderCtx {
  /** Every note in the vault, so a link resolves as it does in the app. */
  all: Parameters<typeof resolveLocal>[0];
  /** Published notes by id. */
  published: Map<number, Chosen>;
  /** Files the snapshot holds. */
  files: string[];
  /** Dataview queries see the published notes only, so a result can't show what isn't public. */
  dv: Vault;
  /** The publisher's time zone: minutes east of UTC, and its name when known. */
  offset: number;
  tz?: string;
  /** What each dataviewjs block drew, by note path and code (frozenKey). */
  frozen: Map<string, string>;
  features: SiteFeatures;
}

/** A heading in a page's contents list. */
interface TocEntry {
  level: number;
  id: string;
  text: string;
}

/** What a page shows beside its text, worked out at Publish (site_pages.meta). */
export interface PageMeta {
  toc?: TocEntry[];
  /** Published pages that link here. */
  backlinks?: { path: string; title: string }[];
  tags?: string[];
  /** When the note was last changed (ISO). */
  updated?: string;
  words?: number;
}

/** `toc`, when given, collects the page's second- and third-level headings. */
function renderNote(note: Chosen, from: string, c: RenderCtx, depth = 0, toc?: TocEntry[]): string {
  const root = rootFrom(from);
  const ids = new Map<string, number>();
  const pageHref = (n: Chosen, hash = "") => root + encodePath(pagePath(n.path)) + hash;
  const fileHref = (f: string) => root + encodePath(f);
  const anchor = (target: string) => {
    const h = target.includes("#") ? target.slice(target.indexOf("#") + 1) : "";
    return h && !h.startsWith("^") ? "#" + encodeURIComponent(headingId(h)) : "";
  };
  const published = (target: string) => {
    const hit = resolveLocal(c.all, target);
    return hit ? c.published.get(hit.id) : undefined;
  };
  const fileEmbed = (path: string, alt?: string) => {
    const href = esc(fileHref(path));
    const size = /^(\d+)(?:x(\d+))?$/.exec(alt ?? "");
    if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i.test(path)) return `<img src="${href}" alt="${esc(size ? "" : (alt ?? ""))}" loading="lazy"${size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ""}` : ""}>`;
    if (/\.(mp3|m4a|wav|ogg)$/i.test(path)) return `<audio controls src="${href}"></audio>`;
    if (/\.(mp4|mov|webm)$/i.test(path)) return `<video controls src="${href}"></video>`;
    return `<a href="${href}">${esc(alt || path.split("/").pop()!)}</a>`;
  };
  /** ![[Note]] or ![[Note#Heading]], as a block: the other page's text, one level deep. */
  const noteEmbed = (target: string): string | null => {
    const n = published(target);
    if (!n || depth > 0) return null;
    const body = stripHidden(parseFrontmatter(n.content).body);
    const h = target.includes("#") ? target.slice(target.indexOf("#") + 1) : "";
    let part = body;
    if (h.startsWith("^")) part = body.split("\n").find((l) => l.trimEnd().endsWith(h)) ?? body;
    else if (h) {
      const r = sectionRange(body, h);
      if (r) part = body.slice(r.from, r.to);
    }
    return `<div class="site-embed"><a class="internal-link" href="${esc(pageHref(n, anchor(target)))}">${esc(n.title)}</a>${renderNote({ ...n, content: part }, from, c, depth + 1)}</div>`;
  };

  // Dataview results, worked out now and kept as they are until the next Publish.
  const dvOpts: RenderOpts = {
    canTick: false,
    calendar: "all",
    inline: (md) => marked.parseInline(md, { async: false }) as string,
    link(path, display) {
      const n = published(path);
      return n ? `<a class="internal-link" href="${esc(pageHref(n))}">${esc(display)}</a>` : esc(display);
    },
  };

  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start: (src: string) => src.match(/!?\[\[/)?.index,
        tokenizer(src: string) {
          const m = /^(!?)\[\[([^\[\]|\n]+?)(?:\\?\|([^\[\]\n]*))?\]\]/.exec(src);
          if (m) return { type: "wikilink", raw: m[0], embed: m[1] === "!", target: m[2]!.trim(), alias: m[3]?.trim() };
        },
        renderer(t: any) {
          const target: string = t.target;
          if (isAttachmentPath(target)) {
            const f = resolveFile(c.files, note.path, target);
            if (!f) return esc(t.alias && !/^\d+(x\d+)?$/.test(t.alias) ? t.alias : target.split("/").pop()!);
            return t.embed ? fileEmbed(f, t.alias) : `<a href="${esc(fileHref(f))}">${esc(t.alias || target)}</a>`;
          }
          // What the note says, never the title of a note that isn't published.
          const label = esc(t.alias || target.replace(/#\^?/, " › "));
          const n = published(target);
          if (!n) return label;
          return `<a class="internal-link" href="${esc(pageHref(n, anchor(target)))}">${t.embed ? "↪ " : ""}${label}</a>`;
        },
      },
      {
        name: "highlight",
        level: "inline",
        start: (src: string) => src.indexOf("=="),
        tokenizer(src: string) {
          const m = /^==(?=\S)([^=\n]+?)==/.exec(src);
          if (!m) return;
          const hilo = hiloColour(m[1]!);
          return { type: "highlight", raw: m[0], colour: hilo?.name ?? null, tokens: this.lexer.inlineTokens(hilo ? hilo.text : m[1]!) };
        },
        renderer(t: any) {
          return `<mark${t.colour ? ` class="hl-${t.colour}"` : ""}>${this.parser.parseInline(t.tokens)}</mark>`;
        },
      },
      {
        // :status[Done]{.green}: a coloured label (F28).
        name: "status",
        level: "inline",
        start: (src: string) => src.indexOf(":status["),
        tokenizer(src: string) {
          const m = STATUS_RE.exec(src);
          if (m) return { type: "status", raw: m[0], label: m[1]!, colour: statusColour(m[2]) };
        },
        renderer(t: any) {
          return `<span class="status status-${t.colour}">${esc(t.label)}</span>`;
        },
      },
      {
        name: "tag",
        level: "inline",
        start: (src: string) => src.match(/(^|\s)#[\p{L}_\-/]/u)?.index,
        tokenizer(src: string) {
          const m = /^(\s?)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(src);
          if (m) return { type: "tag", raw: m[0], lead: m[1], tag: m[2] };
        },
        renderer(t: any) {
          if (c.features.tags) return `${t.lead}<a class="tag" href="${esc(root + "_site/tags/" + encodeURIComponent(String(t.tag).toLowerCase()))}">#${esc(t.tag)}</a>`;
          return `${t.lead}<span class="tag">#${esc(t.tag)}</span>`;
        },
      },
    ],
    renderer: {
      code({ text, lang }: Tokens.Code) {
        const kind = lang?.trim().split(/\s/)[0]!.toLowerCase();
        if (kind === "dataviewjs") {
          // What the script drew at Publish; without it (it didn't run), the code as written.
          const html = c.frozen.get(frozenKey(note.path, text));
          if (html === undefined) return false;
          return `<div class="dataviewjs-block">${cleanFrozen(html, (target) => {
            const n = published(target);
            return n ? pageHref(n, anchor(target)) : null;
          })}</div>\n`;
        }
        // A diagram shows as its source (pages run no script); other code, coloured.
        if (kind === "mermaid") return false;
        if (kind !== "dataview") return codeBlockHtml(text, lang, esc, false);
        return `<div class="dataview-block">${renderResult(runQuery(text, c.dv, { thisPath: note.path, offset: c.offset, tz: c.tz }), dvOpts)}</div>\n`;
      },
      codespan({ text }: Tokens.Codespan) {
        const raw = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const expr = inlineQuery(raw);
        if (expr === null) return false;
        const r = runInline(expr, c.dv, { thisPath: note.path, offset: c.offset, tz: c.tz });
        return `<span class="dataview-inline">${r.kind === "value" ? renderValue(r.value, dvOpts) : renderResult(r, dvOpts, true)}</span>`;
      },
      html({ text }: Tokens.HTML | Tokens.Tag) {
        return cleanHtml(text);
      },
      heading({ tokens, depth: level }: Tokens.Heading) {
        const inner = this.parser.parseInline(tokens);
        const base = headingId(tokens.map((t) => t.raw).join(""));
        const n = ids.get(base) ?? 0;
        ids.set(base, n + 1);
        const id = n ? `${base}-${n}` : base;
        if (toc && depth === 0 && (level === 2 || level === 3)) toc.push({ level, id, text: plainInline(tokens.map((t) => t.raw).join("")) });
        return `<h${level} id="${esc(id)}">${inner}</h${level}>\n`;
      },
      checkbox({ checked }: Tokens.Checkbox) {
        return `<input type="checkbox" class="task" disabled${checked ? " checked" : ""} aria-label="${checked ? "Done" : "To do"}"> `;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        if (/^(https?|mailto):/i.test(href)) return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""} rel="noopener noreferrer nofollow">${text}</a>`;
        if (EXTERNAL.test(href)) return text; // javascript:, data: and the like: just the words
        if (href.startsWith("#")) return `<a href="#${encodeURIComponent(headingId(safeDecode(href.slice(1))))}">${text}</a>`;
        if (isAttachmentPath(safeDecode(href))) {
          const f = resolveFile(c.files, note.path, href);
          return f ? `<a href="${esc(fileHref(f))}">${text}</a>` : text;
        }
        const n = published(safeDecode(href));
        return n ? `<a class="internal-link" href="${esc(pageHref(n, anchor(safeDecode(href))))}">${text}</a>` : text;
      },
      image({ href, title, text }: Tokens.Image) {
        if (/^https?:/i.test(href) || /^data:image\/(png|jpe?g|gif|webp);/i.test(href)) return `<img src="${esc(href)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy">`;
        const f = EXTERNAL.test(href) ? undefined : resolveFile(c.files, note.path, href);
        return f ? fileEmbed(f, text) : esc(text);
      },
      paragraph({ tokens, raw }: Tokens.Paragraph) {
        if (TOC_RE.test(raw)) return tocHtml(headings(body), (h) => "#" + encodeURIComponent(headingId(h.text)), esc) + "\n";
        // A note embed alone in its paragraph becomes a block holding the other page's text.
        const only = tokens.filter((x) => !(x.type === "text" && !x.raw.trim()));
        const one = only.length === 1 ? (only[0] as any) : null;
        if (one?.type === "wikilink" && one.embed && !isAttachmentPath(one.target)) {
          const block = noteEmbed(one.target);
          if (block) return block + "\n";
        }
        return `<p>${this.parser.parseInline(tokens)}</p>\n`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const inner = this.parser.parse(tokens);
        const m = /^<p>\[!([\w-]+)\]([+-]?)[ \t]*([^\n<]*)(?:\n|<br>)?/i.exec(inner);
        if (!m) return `<blockquote>${inner}</blockquote>`;
        const type = m[1]!.toLowerCase();
        const title = m[3]!.trim() || type[0]!.toUpperCase() + type.slice(1);
        let rest = inner.slice(m[0].length);
        rest = /^\s*<\/p>/.test(rest) ? rest.replace(/^\s*<\/p>/, "") : `<p>${rest}`;
        // [!type]- folds closed and [!type]+ open (F28's Expand), with no script: <details>.
        if (m[2]) return `<details class="callout" data-callout="${esc(type)}"${m[2] === "+" ? " open" : ""}><summary class="callout-title">${esc(title)}</summary><div class="callout-body">${rest}</div></details>`;
        return `<div class="callout" data-callout="${esc(type)}"><div class="callout-title">${esc(title)}</div><div class="callout-body">${rest}</div></div>`;
      },
    },
  });

  let body = stripHidden(parseFrontmatter(note.content).body);
  // The page shows the title; a first heading that only repeats it is dropped.
  if (depth === 0) {
    const first = /^\s*#\s+(.+?)\s*#*\s*(?:\n|$)/.exec(body);
    if (first && plainInline(first[1]!).toLowerCase() === note.title.toLowerCase()) body = body.slice(first[0].length);
  }
  return marked.parse(body, { async: false }) as string;
}

// ── publish, state, take down ─────────────────────────────────────────────────────────────

interface Plan {
  settings: SiteSettings;
  pages: Chosen[];
  held: string[];
  files: string[];
}

async function plan(vaultId: number): Promise<Plan & { error?: string }> {
  const { settings, error } = await readSettings(vaultId);
  if (error) return { settings, error, pages: [], held: [], files: [] };
  const { pages, held } = await choose(vaultId, settings);
  const all = (await sql<{ path: string }[]>`select path from attachments where vault_id = ${vaultId} and path <> ${SITE_SETTINGS}`).map((f) => f.path);
  const files = new Set<string>();
  for (const p of pages) for (const f of fileRefs(all, p.path, p.content)) files.add(f);
  return { settings, pages, held, files: [...files].sort() };
}

/** Published pages that link to each published note, by note id, from the text a page shows. */
function backlinkMap(pages: Chosen[], all: RenderCtx["all"]): Map<number, Chosen[]> {
  const byId = new Map(pages.map((n) => [n.id, n]));
  const out = new Map<number, Chosen[]>();
  for (const n of pages) {
    for (const t of extractLinks(stripHidden(parseFrontmatter(n.content).body))) {
      const hit = resolveLocal(all, t);
      const to = hit && byId.get(hit.id);
      if (!to || to.id === n.id) continue;
      const list = out.get(to.id) ?? [];
      if (!list.includes(n)) list.push(n);
      out.set(to.id, list);
    }
  }
  return out;
}

/** A page's details apart from its contents list (which comes from rendering it). */
function pageMeta(n: Chosen, backlinks: Map<number, Chosen[]>): PageMeta {
  const { raw, body } = parseFrontmatter(n.content);
  const shown = stripHidden(body);
  const fm = raw ? `---\n${raw}\n---\n` : "";
  return {
    backlinks: (backlinks.get(n.id) ?? []).map((b) => ({ path: pagePath(b.path), title: b.title })).sort((a, b) => a.title.localeCompare(b.title)),
    tags: extractTags(fm + shown),
    updated: new Date(n.updated_at).toISOString(),
    words: countWords(shown),
  };
}

const newSlug = () => randomBytes(8).readBigUInt64BE().toString(36).padStart(12, "0").slice(0, 12);

export async function publish(vaultId: number, user: User, offset = 0, tz?: string, frozen: { path: string; code: string; html: string }[] = []): Promise<{ slug: string; pages: number; files: number }> {
  const p = await plan(vaultId);
  if (p.error) throw new HttpError(400, p.error);
  if (!p.pages.length) throw new HttpError(400, "Nothing to publish: the chosen folders have no notes, or every note says publish: false.");
  const [vault] = await sql`select name from vaults where id = ${vaultId}`;
  const dv = publishedVault(p);
  const ctx: RenderCtx = {
    all: (await listNotes(vaultId)) as RenderCtx["all"],
    published: new Map(p.pages.map((n) => [n.id, n])),
    files: p.files,
    dv,
    offset,
    tz,
    frozen: new Map(frozen.map((f) => [frozenKey(f.path, f.code), f.html])),
    features: p.settings.features ?? {},
  };
  const backlinks = backlinkMap(p.pages, ctx.all);
  const rows = p.pages.map((n) => {
    const toc: TocEntry[] = [];
    const html = renderNote(n, pagePath(n.path), ctx, 0, toc);
    return { vault_id: vaultId, path: pagePath(n.path), note_path: n.path, title: n.title, html, source_md5: n.md5, meta: sql.json({ ...pageMeta(n, backlinks), toc } as any) };
  });
  const [{ bytes }] = (await sql`select coalesce(sum(size), 0)::float8 as bytes from attachments where vault_id = ${vaultId} and path = any(${p.files})`) as unknown as [{ bytes: number }];
  await assertRoom(bytes + rows.reduce((n, r) => n + r.html.length, 0));

  // As published, with the publisher's time zone for the dates pages show.
  const settings = { ...p.settings, title: p.settings.title || vault!.name, ...(tz ? { tz } : {}) };
  const slug = await sql.begin(async (tx) => {
    const [s] = await tx`insert into sites (vault_id, slug) values (${vaultId}, ${newSlug()})
                         on conflict (vault_id) do update set vault_id = excluded.vault_id returning slug`;
    await tx`delete from site_pages where vault_id = ${vaultId}`;
    await tx`delete from site_files where vault_id = ${vaultId}`;
    for (let i = 0; i < rows.length; i += 500) await tx`insert into site_pages ${tx(rows.slice(i, i + 500))} on conflict do nothing`;
    await tx`insert into site_files (vault_id, path, mime, data)
             select vault_id, path, mime, data from attachments where vault_id = ${vaultId} and path = any(${p.files})`;
    await tx`update sites set live = true, settings = ${tx.json(settings as any)}, published_at = now(), published_by = ${user.id} where vault_id = ${vaultId}`;
    return s!.slug as string;
  });
  return { slug, pages: rows.length, files: p.files.length };
}

/** Take the site down (keeping the snapshot, so Undo puts the same pages back), or put it back. */
export async function setLive(vaultId: number, live: boolean): Promise<void> {
  const r = await sql`update sites set live = ${live} where vault_id = ${vaultId} and published_at is not null returning 1`;
  if (!r.length) throw new HttpError(404, "This collection hasn't been published");
}

const LIST_MAX = 500;

const sameFeatures = (a: SiteFeatures | undefined, b: SiteFeatures | undefined) => FEATURES.every((f) => !!a?.[f] === !!b?.[f]);

/** Everything the Website settings show: the choice, what would be public, and what a republish
 *  would add, change or take down. */
export async function siteState(vaultId: number) {
  const p = await plan(vaultId);
  const folders = [...new Set((await sql<{ path: string }[]>`select path from notes where vault_id = ${vaultId}`).flatMap((n) => n.path.split("/").slice(0, -1).map((_, i, a) => a.slice(0, i + 1).join("/"))))].sort((a, b) => a.localeCompare(b));
  const [site] = await sql`
    select s.slug, s.live, s.settings, s.published_at, u.name as published_by,
           (select count(*)::int from site_pages sp where sp.vault_id = s.vault_id) as pages,
           (select count(*)::int from site_files sf where sf.vault_id = s.vault_id) as files
    from sites s left join users u on u.id = s.published_by where s.vault_id = ${vaultId} and s.published_at is not null`;
  let changes = null;
  if (site) {
    const was = new Map((await sql<{ note_path: string; source_md5: string }[]>`select note_path, source_md5 from site_pages where vault_id = ${vaultId}`).map((r) => [r.note_path, r.source_md5]));
    const now = new Set(p.pages.map((n) => n.path));
    changes = {
      added: p.pages.filter((n) => !was.has(n.path)).map((n) => n.path),
      changed: p.pages.filter((n) => was.has(n.path) && was.get(n.path) !== n.md5).map((n) => n.path),
      removed: [...was.keys()].filter((path) => !now.has(path)).sort(),
      settings: JSON.stringify(site.settings.include ?? []) !== JSON.stringify(p.settings.include) || !sameFeatures(site.settings.features, p.settings.features),
    };
    for (const k of ["added", "changed", "removed"] as const) changes[k] = changes[k].slice(0, LIST_MAX);
  }
  return {
    settings: p.settings,
    error: p.error ?? null,
    folders,
    notes: p.pages.slice(0, LIST_MAX).map((n) => n.path),
    noteCount: p.pages.length,
    held: p.held.slice(0, LIST_MAX),
    files: p.files.slice(0, LIST_MAX),
    fileCount: p.files.length,
    site: site ? { slug: site.slug as string, live: site.live as boolean, publishedAt: site.published_at as string, publishedBy: (site.published_by as string | null) ?? null, pages: site.pages as number, files: site.files as number } : null,
    changes,
  };
}

// ── serving /p/<slug>/… ───────────────────────────────────────────────────────────────────

const PAGE_HEADERS = {
  "Content-Type": "text/html; charset=utf-8",
  // No script, no forms, no framing; sandboxed, so a page never acts as the app's origin.
  "Content-Security-Policy":
    "default-src 'none'; style-src 'self'; img-src 'self' https: data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; sandbox allow-popups allow-popups-to-escape-sandbox allow-top-navigation-by-user-activation",
  // Unlisted (the default): search engines are asked to leave it out.
  "X-Robots-Tag": "noindex, nofollow",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  // Taking a site down or republishing shows at once.
  "Cache-Control": "no-cache",
};


// The preview (F18 step 2) is the app's own page, framed by Settings → Website: it needs the
// owner's cookie on each request, so it isn't sandboxed by its header (the frame is, without
// scripts), and no script runs on it either way.
const PREVIEW_HEADERS = {
  ...PAGE_HEADERS,
  "Content-Security-Policy": "default-src 'none'; style-src 'self'; img-src 'self' https: data:; media-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'",
  "X-Frame-Options": "SAMEORIGIN",
  "Cache-Control": "no-store",
};

let css: string | null = null;
async function stylesheet(): Promise<string> {
  if (css) return css;
  const part = (f: string) => Bun.file(new URL(`../web/styles/${f}`, import.meta.url)).text();
  const [tokens, ...rest] = await Promise.all(["tokens.css", "markdown.css", "site.css"].map(part));
  return (css = [tokens!, ...rest].join("\n"));
}

interface SitePage {
  path: string;
  title: string;
  meta: PageMeta;
}

/** A site to draw: the published snapshot, or the preview of what Publish would make. */
interface SiteView {
  /** The site's root as a URL path, ending in "/". */
  base: string;
  title: string;
  features: SiteFeatures;
  /** The publisher's time zone, for dates. */
  tz?: string;
  headers: Record<string, string>;
  pages: () => Promise<SitePage[]>;
  page: (path: string) => Promise<(SitePage & { html: string }) | null>;
  file: (path: string) => Promise<{ mime: string; data: Uint8Array } | null>;
}

type Theme = "light" | "dark";
const THEME_COOKIE = "site-theme";
const themeFrom = (req: Request): Theme | null => {
  const m = new RegExp(`(?:^|;\\s*)${THEME_COOKIE}=(light|dark)(?:;|$)`).exec(req.headers.get("cookie") ?? "");
  return (m?.[1] as Theme | undefined) ?? null;
};

function dateText(iso: string, tz?: string): string {
  const opts: Intl.DateTimeFormatOptions = { day: "numeric", month: "long", year: "numeric" };
  try {
    return new Date(iso).toLocaleDateString("en-GB", { ...opts, timeZone: tz || "UTC" });
  } catch {
    return new Date(iso).toLocaleDateString("en-GB", { ...opts, timeZone: "UTC" });
  }
}

/** Every page in a tree of folders, the open page marked. */
function sidebar(pages: SitePage[], from: string): string {
  const root = rootFrom(from);
  interface Folder {
    pages: SitePage[];
    folders: Map<string, Folder>;
  }
  const top: Folder = { pages: [], folders: new Map() };
  for (const p of pages) {
    let at = top;
    for (const seg of p.path.split("/").slice(0, -1)) {
      if (!at.folders.has(seg)) at.folders.set(seg, { pages: [], folders: new Map() });
      at = at.folders.get(seg)!;
    }
    at.pages.push(p);
  }
  const list = (f: Folder): string =>
    `<ul>${[...f.folders.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, sub]) => `<li><span class="site-folder">${esc(name)}</span>${list(sub)}</li>`)
      .join("")}${[...f.pages]
      .sort((a, b) => a.title.localeCompare(b.title))
      .map((p) => `<li><a href="${esc(root + encodePath(p.path))}"${p.path === from ? ' aria-current="page"' : ""}>${esc(p.title)}</a></li>`)
      .join("")}</ul>`;
  return `<nav class="site-sidebar" aria-label="Pages">${list(top)}</nav>`;
}

function shell(view: SiteView, from: string, title: string, main: string, opts: { isPage?: boolean; theme: Theme | null; pages: SitePage[] | null }): string {
  const root = rootFrom(from);
  const f = view.features;
  // A page's folders, as words: folders have no pages of their own (yet).
  const crumbs = opts.isPage ? from.split("/").slice(0, -1) : [];
  const themeLink = (to: string, label: string, on: boolean) => `<a href="${esc(`${root}_site/theme?to=${to}&back=${encodeURIComponent(from)}`)}"${on ? ' aria-current="true"' : ""}>${label}</a>`;
  const switcher = f.themeSwitch
    ? `<span class="site-theme" role="group" aria-label="Colours">${themeLink("light", "Light", opts.theme === "light")}${themeLink("dark", "Dark", opts.theme === "dark")}${themeLink("auto", "Auto", !opts.theme)}</span>`
    : "";
  return `<!doctype html>
<html lang="en"${opts.theme ? ` data-theme="${opts.theme}"` : ""}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="${opts.theme ?? "light dark"}">
<title>${esc(title === view.title ? title : `${title} · ${view.title}`)}</title>
<link rel="stylesheet" href="${root}_site/style.css">
</head>
<body class="site${opts.pages ? " site-with-sidebar" : ""}">
<a class="site-skip" href="#main">Skip to the text</a>
<header class="site-head">
<a class="site-name" href="${root}">${esc(view.title)}</a>
<nav aria-label="Site"><a href="${root}_site/pages">All pages</a>${f.tags ? `<a href="${root}_site/tags">Tags</a>` : ""}${switcher}</nav>
</header>
<div class="site-body">
<main id="main" class="site-main markdown">
${crumbs.length ? `<p class="site-crumbs">${crumbs.map(esc).join(" › ")}</p>\n` : ""}${main}
</main>
${opts.pages ? sidebar(opts.pages, from) : ""}
</div>
</body>
</html>`;
}

/** A page: its title, the details the site shows, its text, tags and the pages linking here. */
function pageMain(view: SiteView, p: SitePage & { html: string }, from: string): string {
  const f = view.features;
  const m = p.meta;
  const root = rootFrom(from);
  const facts = [
    f.updated && m.updated ? `Updated <time datetime="${esc(m.updated)}">${esc(dateText(m.updated, view.tz))}</time>` : "",
    f.readingTime && m.words !== undefined ? `${readingMinutes(m.words)} min read` : "",
  ].filter(Boolean);
  let out = `<h1>${esc(p.title)}</h1>\n`;
  if (facts.length) out += `<p class="site-facts">${facts.join(" · ")}</p>\n`;
  if (f.contents && (m.toc?.length ?? 0) >= 2)
    out += `<nav class="site-toc" aria-label="On this page"><p class="site-toc-title">On this page</p><ul>${m.toc!.map((t) => `<li class="site-toc-${t.level}"><a href="#${esc(encodeURIComponent(t.id))}">${esc(t.text)}</a></li>`).join("")}</ul></nav>\n`;
  out += p.html;
  if (f.tags && m.tags?.length) out += `\n<p class="site-tags">${m.tags.map((t) => `<a class="tag" href="${esc(root + "_site/tags/" + encodeURIComponent(t))}">#${esc(t)}</a>`).join(" ")}</p>`;
  if (f.backlinks && m.backlinks?.length)
    out += `\n<section class="site-backlinks" aria-label="Linked from"><p class="site-backlinks-title">Linked from</p><ul>${m.backlinks.map((b) => `<li><a class="internal-link" href="${esc(root + encodePath(b.path))}">${esc(b.title)}</a></li>`).join("")}</ul></section>`;
  return out;
}

const notFound = (headers: Record<string, string> = PAGE_HEADERS) =>
  new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Not found</title></head><body><main><h1>This page isn't here</h1><p>It may have been taken down, or the link is wrong.</p></main></body></html>`,
    { status: 404, headers },
  );

/** A top-level note called index, Home or README is the site's home page. */
const HOME = ["index", "home", "readme"];

function pagesList(pages: { path: string; title: string }[], from: string): string {
  const root = rootFrom(from);
  const groups = new Map<string, typeof pages>();
  for (const p of pages) {
    const folder = p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) : "";
    groups.set(folder, [...(groups.get(folder) ?? []), p]);
  }
  const list = (ps: typeof pages) => `<ul>${ps.map((p) => `<li><a class="internal-link" href="${esc(root + encodePath(p.path))}">${esc(p.title)}</a></li>`).join("")}</ul>`;
  return [...groups.entries()]
    .sort(([a], [b]) => (a === "" ? -1 : b === "" ? 1 : a.localeCompare(b)))
    .map(([folder, ps]) => (folder ? `<h2>${esc(folder.split("/").join(" › "))}</h2>` : "") + list(ps))
    .join("\n");
}

/** Answer a request for `path` (decoded, below the site's root) from a site. */
async function respond(view: SiteView, req: Request, path: string): Promise<Response> {
  const f = view.features;
  const theme = f.themeSwitch ? themeFrom(req) : null;
  const html = (body: string) => new Response(body, { headers: view.headers });

  if (path === "_site/style.css") return new Response(await stylesheet(), { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
  if (path === "_site/theme" && f.themeSwitch) {
    // Light, dark or the device's own, kept in a cookie for this site: pages run no script.
    const url = new URL(req.url);
    const to = url.searchParams.get("to");
    const back = url.searchParams.get("back") ?? "";
    const safeBack = back.split("/").some((s) => s === ".." || s === ".") || /^\/|:|\\/.test(back) ? "" : back;
    const secure = isSecure(req) ? "; Secure" : "";
    const value = to === "light" || to === "dark" ? `${THEME_COOKIE}=${to}; Max-Age=31536000` : `${THEME_COOKIE}=; Max-Age=0`;
    return new Response(null, { status: 303, headers: { Location: view.base + encodePath(safeBack), "Set-Cookie": `${value}; Path=${view.base}; HttpOnly; SameSite=Lax${secure}`, "Cache-Control": "no-store" } });
  }

  const pages = f.sidebar ? await view.pages() : null;
  const page = (from: string, title: string, main: string, isPage = false) => html(shell(view, from, title, main, { isPage, theme, pages }));
  if (path === "" || path === "_site/pages") {
    const all = pages ?? (await view.pages());
    const homePath = path === "" ? HOME.map((h) => all.find((p) => p.path.toLowerCase() === h)).find(Boolean)?.path : undefined;
    const home = homePath ? await view.page(homePath) : null;
    if (home) return page("", view.title, pageMain(view, home, ""));
    const from = path === "" ? "" : "_site/pages";
    const title = path === "" ? view.title : "All pages";
    return page(from, title, `<h1>${esc(title)}</h1>\n${pagesList(all, from)}`);
  }
  if (f.tags && (path === "_site/tags" || path.startsWith("_site/tags/"))) {
    const all = pages ?? (await view.pages());
    const from = path;
    const root = rootFrom(from);
    if (path === "_site/tags") {
      const counts = new Map<string, number>();
      for (const p of all) for (const t of p.meta.tags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1);
      const list = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
      const main = list.length ? `<ul class="site-tag-list">${list.map(([t, n]) => `<li><a class="tag" href="${esc(root + "_site/tags/" + encodeURIComponent(t))}">#${esc(t)}</a> <span class="site-count">${n}</span></li>`).join("")}</ul>` : "<p>No page has a tag.</p>";
      return page(from, "Tags", `<h1>Tags</h1>\n${main}`);
    }
    const tag = path.slice("_site/tags/".length).toLowerCase();
    const tagged = all.filter((p) => p.meta.tags?.includes(tag));
    if (!tagged.length) return notFound(view.headers);
    return page(from, `#${tag}`, `<h1>#${esc(tag)}</h1>\n${pagesList(tagged, from)}`);
  }

  const p = await view.page(path);
  if (p) return page(path, p.title, pageMain(view, p, path), true);
  const file = await view.file(path);
  if (file)
    return new Response(new Uint8Array(file.data), {
      headers: { "Content-Type": file.mime, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" },
    });
  return notFound(view.headers);
}

export async function serveSite(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const url = new URL(req.url);
  const m = /^\/p\/([a-z0-9]{6,32})(\/.*)?$/.exec(url.pathname);
  if (!m) return notFound();
  if (m[2] === undefined) return new Response(null, { status: 308, headers: { Location: `/p/${m[1]}/` } });
  const [site] = await sql`select vault_id, settings from sites where slug = ${m[1]!} and live`;
  if (!site) return notFound();
  let path: string;
  try {
    path = decodeURIComponent(m[2].slice(1));
  } catch {
    return notFound();
  }
  const vaultId = site.vault_id as number;
  let list: Promise<SitePage[]> | null = null;
  const view: SiteView = {
    base: `/p/${m[1]}/`,
    title: String(site.settings.title ?? "") || "Notes",
    features: (site.settings.features as SiteFeatures | undefined) ?? {},
    tz: typeof site.settings.tz === "string" ? site.settings.tz : undefined,
    headers: PAGE_HEADERS,
    pages: () => (list ??= sql<SitePage[]>`select path, title, meta from site_pages where vault_id = ${vaultId} order by lower(path)`.then((r) => [...r])),
    page: async (path) => ((await sql`select path, title, html, meta from site_pages where vault_id = ${vaultId} and path = ${path}`)[0] as (SitePage & { html: string }) | undefined) ?? null,
    file: async (path) => ((await sql`select mime, data from site_files where vault_id = ${vaultId} and path = ${path}`)[0] as { mime: string; data: Uint8Array } | undefined) ?? null,
  };
  return respond(view, req, path);
}

/** The preview in Settings → Website: what Publish would make now, from the notes as they are and
 *  publish.json, for the owner only. Scripts (dataviewjs) show as code until Publish runs them. */
export async function previewSite(vaultId: number, req: Request): Promise<Response> {
  const base = `/api/vaults/${vaultId}/site/preview/`;
  let path: string;
  try {
    path = decodeURIComponent(new URL(req.url).pathname.slice(base.length));
  } catch {
    return notFound(PREVIEW_HEADERS);
  }
  const p = await plan(vaultId);
  if (p.error || !p.pages.length) {
    const why = p.error ?? "Nothing to show yet: the chosen folders have no notes, or every note says publish: false.";
    return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview</title></head><body><p>${esc(why)}</p></body></html>`, { headers: PREVIEW_HEADERS });
  }
  const [vault] = await sql`select name from vaults where id = ${vaultId}`;
  const features = p.settings.features ?? {};
  const ctx: RenderCtx = {
    all: (await listNotes(vaultId)) as RenderCtx["all"],
    published: new Map(p.pages.map((n) => [n.id, n])),
    files: p.files,
    dv: publishedVault(p),
    offset: 0,
    frozen: new Map(),
    features,
  };
  const backlinks = backlinkMap(p.pages, ctx.all);
  const byPath = new Map(p.pages.map((n) => [pagePath(n.path), n]));
  const view: SiteView = {
    base,
    title: p.settings.title || vault!.name,
    features,
    headers: PREVIEW_HEADERS,
    pages: async () => p.pages.map((n) => ({ path: pagePath(n.path), title: n.title, meta: pageMeta(n, backlinks) })),
    page: async (path) => {
      const n = byPath.get(path);
      if (!n) return null;
      const toc: TocEntry[] = [];
      const html = renderNote(n, path, ctx, 0, toc);
      return { path, title: n.title, html, meta: { ...pageMeta(n, backlinks), toc } };
    },
    file: async (path) => (p.files.includes(path) ? (((await sql`select mime, data from attachments where vault_id = ${vaultId} and path = ${path}`)[0] as { mime: string; data: Uint8Array } | undefined) ?? null) : null),
  };
  return respond(view, req, path);
}

// ── one note by link (F38, src/shareLink.ts) ────────────────────────────────────────────────

/** One note drawn as a published page would be. Nothing else is shared, so a link to any other
 *  note shows as plain words, and only the files this note shows come along. */
export async function renderSingle(vaultId: number, noteId: number, tz?: string): Promise<{ title: string; page: string; html: string; files: string[]; md5: string }> {
  const [n] = await sql<Chosen[]>`select id, path, title, content, md5(content) as md5, created_at, updated_at from notes where id = ${noteId} and vault_id = ${vaultId}`;
  if (!n) throw new HttpError(404, "Note not found");
  const all = (await sql<{ path: string }[]>`select path from attachments where vault_id = ${vaultId} and path <> ${SITE_SETTINGS}`).map((f) => f.path);
  const files = fileRefs(all, n.path, n.content);
  const ctx: RenderCtx = {
    all: (await listNotes(vaultId)) as RenderCtx["all"],
    published: new Map([[n.id, n]]),
    files,
    dv: new Vault([readPage({ path: n.path, content: n.content, ctime: new Date(n.created_at).getTime(), mtime: new Date(n.updated_at).getTime() })]),
    offset: 0,
    tz,
    frozen: new Map(),
    features: {},
  };
  return { title: n.title, page: pagePath(n.path), html: renderNote(n, pagePath(n.path), ctx), files, md5: n.md5 };
}

/** The shared note's page: its title, when it was shared, its text. No script, as a site's. */
export function sharedPage(page: string, title: string, html: string, updated: Date): string {
  const root = rootFrom(page);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<meta name="color-scheme" content="light dark">
<title>${esc(title)}</title>
<link rel="stylesheet" href="${root}_share/style.css">
</head>
<body class="site">
<div class="site-body">
<main id="main" class="site-main markdown">
<h1>${esc(title)}</h1>
<p class="site-facts">Shared from DO Notes · <time datetime="${esc(updated.toISOString())}">${esc(dateText(updated.toISOString()))}</time></p>
${html}
</main>
</div>
</body>
</html>`;
}

export { PAGE_HEADERS as SHARE_PAGE_HEADERS, stylesheet as siteStylesheet, encodePath as encodeSitePath };
