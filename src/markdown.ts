// Extended Markdown analysis (wikilinks, embeds, tags, callouts): frontmatter, tags, links, headings and chunks.
// Pure functions with no server dependencies — the web client imports this file too, so a
// wikilink means the same thing in the editor, the renderer and the link index.

import { parse as parseYaml } from "yaml";

export interface Frontmatter {
  data: Record<string, unknown>;
  /** The markdown after the closing `---`. */
  body: string;
  /** Raw YAML text, or "" when there is no frontmatter block. */
  raw: string;
}

const FM = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseFrontmatter(md: string): Frontmatter {
  const m = FM.exec(md);
  if (!m) return { data: {}, body: md, raw: "" };
  let data: Record<string, unknown> = {};
  try {
    const parsed = parseYaml(m[1]!);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Malformed YAML is kept verbatim in the note; it just contributes no properties.
  }
  return { data, body: md.slice(m[0].length), raw: m[1]! };
}

/** Replace fenced and inline code with spaces (same length) so offsets survive. */
export function maskCode(md: string): string {
  const blank = (s: string) => s.replace(/[^\n]/g, " ");
  return md
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?(?:^\1[^\n]*$|(?![\s\S]))/gm, blank)
    .replace(/`[^`\n]+`/g, blank);
}

const TAG = /(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

function frontmatterList(v: unknown): string[] {
  if (Array.isArray(v)) return v.map(String);
  if (typeof v === "string") return v.split(/[,\s]+/);
  return [];
}

/** Tags from frontmatter (`tags:` / `tag:`) and inline `#tags`, lower-cased, without '#'. */
export function extractTags(md: string): string[] {
  const { data, body } = parseFrontmatter(md);
  const tags = new Set<string>();
  for (const t of [...frontmatterList(data.tags), ...frontmatterList(data.tag)]) {
    const clean = t.trim().replace(/^#/, "").toLowerCase();
    if (clean) tags.add(clean);
  }
  for (const m of maskCode(body).matchAll(TAG)) tags.add(m[2]!.toLowerCase().replace(/\/+$/, ""));
  return [...tags].filter(Boolean).sort();
}

export interface WikiLink {
  /** Text inside the brackets before any `|alias`, e.g. "Projects/Plan#Goals". */
  target: string;
  alias?: string;
  embed: boolean;
  from: number;
  to: number;
}

export const WIKILINK = /(!?)\[\[([^\[\]|\n]+?)(?:\\?\|([^\[\]\n]*))?\]\]/g;

export function findWikiLinks(md: string): WikiLink[] {
  const masked = maskCode(md);
  const out: WikiLink[] = [];
  for (const m of masked.matchAll(WIKILINK)) {
    // Read the real text back from the unmasked source at the same offsets.
    const raw = md.slice(m.index!, m.index! + m[0].length);
    const mm = /^(!?)\[\[([^\[\]|\n]+?)(?:\\?\|([^\[\]\n]*))?\]\]$/.exec(raw)!;
    out.push({
      target: mm[2]!.trim(),
      alias: mm[3]?.trim() || undefined,
      embed: mm[1] === "!",
      from: m.index!,
      to: m.index! + m[0].length,
    });
  }
  return out;
}

/** "Projects/Plan.md#Goals" → "projects/plan". The form links are indexed and resolved by. */
export function normaliseTarget(target: string): string {
  let t = target.split("#")[0]!.split("^")[0]!.trim();
  try {
    t = decodeURIComponent(t);
  } catch {}
  return t.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\.md$/i, "").toLowerCase();
}

const MD_LINK = /(!?)\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;

/** Normalised targets of every note link (wikilinks and relative markdown links). */
export function extractLinks(md: string): string[] {
  const targets = new Set<string>();
  for (const l of findWikiLinks(md)) {
    if (l.embed && isAttachmentPath(l.target)) continue;
    const t = normaliseTarget(l.target);
    if (t) targets.add(t);
  }
  for (const m of maskCode(md).matchAll(MD_LINK)) {
    const href = m[2]!;
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("#")) continue;
    if (isAttachmentPath(href.split("#")[0]!)) continue;
    const t = normaliseTarget(href);
    if (t) targets.add(t);
  }
  return [...targets];
}

// .base files (Bases: saved views, F16) travel with the vault like attachments. .canvas files are
// boards (F11, src/canvas.ts), kept as notes.
const ATTACHMENT_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|heic|pdf|mp3|m4a|wav|ogg|mp4|mov|webm|csv|zip|txt|base)$/i;

/** A vault's site settings (F18): a file at the top level, so it travels with the vault. */
export const SITE_SETTINGS = "publish.json";

/** A collection's AI-XF manifest (F9): kept at the top level, so its namespace never changes. */
export const AIXF_MANIFEST = "manifest.ai-xf.yaml";

export function isAttachmentPath(p: string): boolean {
  const path = p.split("#")[0]!.trim();
  return ATTACHMENT_EXT.test(path) || path === SITE_SETTINGS || path === AIXF_MANIFEST;
}

export interface Heading {
  level: number;
  text: string;
  line: number;
}

/** Words in some text: runs between spaces with a letter or digit in them, so markdown's own
 *  marks (#, -, >, |) don't count. Used for the note's word count and a page's reading time. */
export function countWords(text: string): number {
  return text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}
/** Minutes to read that many words, at 220 a minute; at least one. */
export const readingMinutes = (words: number) => Math.max(1, Math.round(words / 220));

/** Inline markdown as plain text, for the outline: "New **bold** [[Note|alias]]" → "New bold alias". */
export function plainInline(s: string): string {
  return s
    .replace(/!?\[\[([^\[\]|]+?)(?:\\?\|([^\[\]]*))?\]\]/g, (_, target: string, alias?: string) => alias?.trim() || target.replace(/#\^?/, " › ").trim())
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|~~|==)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])[*_](?=\S)(.+?)(?<=\S)[*_](?![\w*])/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

export function headings(md: string): Heading[] {
  const out: Heading[] = [];
  maskCode(md)
    .split("\n")
    .forEach((line, i) => {
      const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
      if (m) out.push({ level: m[1]!.length, text: plainInline(m[2]!), line: i });
    });
  return out;
}

/** Where the section under a heading is: from its heading line to the next heading at its level
 *  or above, as character offsets. null if no heading has that text; ambiguous: the first. */
export function sectionRange(md: string, heading: string): { from: number; to: number; count: number } | null {
  const want = plainInline(heading.replace(/^#+\s*/, "")).trim().toLowerCase();
  const hs = headings(md);
  const matches = hs.filter((h) => h.text.toLowerCase() === want);
  if (!matches.length) return null;
  const i = hs.indexOf(matches[0]!);
  const end = hs.slice(i + 1).find((h) => h.level <= hs[i]!.level);
  const lines = md.split("\n");
  const offset = (line: number) => lines.slice(0, line).reduce((n, l) => n + l.length + 1, 0);
  return { from: offset(hs[i]!.line), to: end ? offset(end.line) : md.length, count: matches.length };
}

export interface Chunk {
  ord: number;
  heading: string | null;
  body: string;
}

/**
 * Split a note into heading-sized chunks for embedding. Each chunk carries the note title and
 * its heading so a chunk read alone still says what it is about. Small sections merge into the
 * next; long ones split at paragraph boundaries near `max` characters.
 */
export function chunkNote(title: string, md: string, max = 1800): Chunk[] {
  const { body } = parseFrontmatter(md);
  const sections: { heading: string | null; text: string }[] = [];
  let current: { heading: string | null; text: string } = { heading: null, text: "" };
  const masked = maskCode(body).split("\n");
  body.split("\n").forEach((line, i) => {
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(masked[i]!);
    if (m) {
      if (current.text.trim()) sections.push(current);
      current = { heading: m[2]!, text: "" };
    } else current.text += line + "\n";
  });
  if (current.text.trim() || sections.length === 0) sections.push(current);

  const pieces: { heading: string | null; text: string }[] = [];
  for (const s of sections) {
    if (s.text.length <= max) {
      pieces.push(s);
      continue;
    }
    let buf = "";
    for (const para of s.text.split(/\n{2,}/)) {
      if (buf && buf.length + para.length > max) {
        pieces.push({ heading: s.heading, text: buf });
        buf = "";
      }
      // A single giant paragraph is hard-split rather than embedded truncated.
      for (let i = 0; i < para.length; i += max) {
        const part = para.slice(i, i + max);
        if (buf.length + part.length > max && buf) {
          pieces.push({ heading: s.heading, text: buf });
          buf = "";
        }
        buf += (buf ? "\n\n" : "") + part;
      }
    }
    if (buf.trim()) pieces.push({ heading: s.heading, text: buf });
  }

  const merged: { heading: string | null; text: string }[] = [];
  for (const p of pieces) {
    const prev = merged[merged.length - 1];
    if (prev && prev.text.trim().length < 200 && prev.text.length + p.text.length < max) {
      prev.text += (p.heading ? `\n## ${p.heading}\n` : "\n") + p.text;
    } else merged.push({ ...p });
  }
  return merged
    .filter((p) => p.text.trim() || p.heading)
    .map((p, ord) => ({
      ord,
      heading: p.heading,
      body: `${title}${p.heading ? ` › ${p.heading}` : ""}\n\n${p.text.trim()}`,
    }));
}

/** "Projects/Plan.md" → "Plan"; a board, "Plan.canvas", is "Plan" too. */
export function titleFromPath(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.(md|canvas)$/i, "");
}

/**
 * Canonical vault path: forward slashes, no leading/trailing slash, no empty or dot segments,
 * ending ".md" when `ext` says so (a board's ".canvas" is kept, F11). Throws on anything that would escape the vault on export.
 */
export function normalisePath(input: string, ext: ".md" | null = ".md"): string {
  const parts = input
    .replace(/\\/g, "/")
    .split("/")
    .map((p) => p.trim())
    .filter((p) => p && p !== ".");
  if (parts.length === 0) throw new Error("Path is empty");
  if (parts.some((p) => p === ".." || /[\u0000-\u001f<>:"|?*]/.test(p))) throw new Error(`Invalid path: ${input}`);
  let path = parts.join("/");
  if (ext && !path.toLowerCase().endsWith(ext) && !/\.canvas$/i.test(path)) path += ext;
  if (path.length > 512) throw new Error("Path is too long");
  return path;
}

/** Rewrite wikilinks whose normalised target `matches` to point at `replacement`, keeping any
 *  #heading and |alias. */
export function rewriteWikiLinks(md: string, matches: (normalisedTarget: string) => boolean, replacement: string): string {
  let out = "";
  let last = 0;
  for (const l of findWikiLinks(md)) {
    if (!matches(normaliseTarget(l.target))) continue;
    const hash = l.target.includes("#") ? l.target.slice(l.target.indexOf("#")) : "";
    out += md.slice(last, l.from) + `${l.embed ? "!" : ""}[[${replacement}${hash}${l.alias ? `|${l.alias}` : ""}]]`;
    last = l.to;
  }
  return out + md.slice(last);
}
