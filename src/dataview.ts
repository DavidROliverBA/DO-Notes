// Dataview queries, read the way the Dataview plugin reads them: ```dataview blocks (TABLE, LIST
// and TASK, with FROM, WHERE, SORT, GROUP BY, FLATTEN and LIMIT), inline `= expressions`, and
// the common `$= dv.pages(…).where(p => …).length` pattern, translated rather than run.
//
// Nothing here runs a note's code: queries are parsed and interpreted, with a step budget and
// regular expressions screened for patterns that could hang. Pure functions with no server or
// browser dependencies: the server runs queries for the app and at Publish, the standalone
// file runs them in the browser, and both give the same answers.
//
// Dates are wall-clock times in the reader's time zone (`offset`, minutes east of UTC), held as
// if they were UTC, so "today" and file times mean the same on the server as in the browser.

import { findWikiLinks, maskCode, normaliseTarget, parseFrontmatter, titleFromPath } from "./markdown";
import { resolveLocal } from "../web/lib/links";
import type { NoteSummary } from "../web/lib/api";

// ── values ────────────────────────────────────────────────────────────────────────────────

export class Link {
  constructor(
    /** What was written: a path or a name, without `#subpath`. */
    readonly target: string,
    readonly display: string | null = null,
    readonly embed = false,
    readonly subpath: string | null = null,
  ) {}
  withDisplay(d: string | null) {
    return new Link(this.target, d, this.embed, this.subpath);
  }
}

/** A date: wall-clock milliseconds, read with the UTC getters. */
export class DDate {
  constructor(readonly ms: number) {}
  get d() {
    return new Date(this.ms);
  }
  get hasTime() {
    return this.ms % 86_400_000 !== 0;
  }
}

const UNITS = ["years", "months", "weeks", "days", "hours", "minutes", "seconds", "milliseconds"] as const;
type Unit = (typeof UNITS)[number];
// Luxon's "casual" conversions, as Dataview uses.
const UNIT_MS: Record<Unit, number> = { years: 365 * 864e5, months: 30 * 864e5, weeks: 7 * 864e5, days: 864e5, hours: 36e5, minutes: 6e4, seconds: 1e3, milliseconds: 1 };

export class Dur {
  constructor(readonly parts: Partial<Record<Unit, number>>) {}
  get ms() {
    return UNITS.reduce((n, u) => n + (this.parts[u] ?? 0) * UNIT_MS[u], 0);
  }
  static fromMs(ms: number) {
    return new Dur({ milliseconds: ms });
  }
  scale(k: number) {
    return new Dur(Object.fromEntries(Object.entries(this.parts).map(([u, v]) => [u, v! * k])));
  }
}

export type Fn = { params: string[]; body: Expr; scope: Scope };
export type Value = null | boolean | number | string | Link | DDate | Dur | Value[] | Fn | { [k: string]: Value };

const isObj = (v: Value): v is { [k: string]: Value } => v !== null && typeof v === "object" && !Array.isArray(v) && !(v instanceof Link) && !(v instanceof DDate) && !(v instanceof Dur) && !isFn(v);
const isFn = (v: Value): v is Fn => v !== null && typeof v === "object" && "params" in (v as object) && "body" in (v as object) && "scope" in (v as object);

export function typeOf(v: Value): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return "boolean";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (v instanceof Link) return "link";
  if (v instanceof DDate) return "date";
  if (v instanceof Dur) return "duration";
  if (Array.isArray(v)) return "array";
  if (isFn(v)) return "function";
  return "object";
}

export class DvError extends Error {}

// ── parsing dates, durations and the values notes hold ───────────────────────────────────

const ISO = /^(\d{4})-(\d{2})(?:-(\d{2}))?(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/;

/** "2026-07-27", "2026-07-27T10:30", "2026-07": a date; null when it isn't one. */
export function parseIsoDate(s: string, offset: number): DDate | null {
  const m = ISO.exec(s.trim());
  if (!m) return null;
  const [y, mo, d, h, mi, se, ms] = [m[1], m[2], m[3] ?? "1", m[4] ?? "0", m[5] ?? "0", m[6] ?? "0", (m[7] ?? "0").padEnd(3, "0")].map(Number) as number[];
  if (mo! < 1 || mo! > 12 || d! < 1 || d! > 31) return null;
  let t = Date.UTC(y!, mo! - 1, d!, h!, mi!, se!, ms!);
  if (m[8]) {
    // A stated zone: the instant, then the reader's wall clock.
    const z = m[8] === "Z" ? 0 : (m[8][0] === "-" ? -1 : 1) * (Number(m[8].slice(1, 3)) * 60 + Number(m[8].slice(-2)));
    t = t - z * 6e4 + offset * 6e4;
  }
  return new DDate(t);
}

// The reader's time zone: an IANA name ("Europe/London") when known, so each instant gets the
// offset of its own date (summer time or not); otherwise a fixed offset in minutes.
const zoneFormats = new Map<string, Intl.DateTimeFormat>();
function tzOffset(tz: string, t: number): number | null {
  let f = zoneFormats.get(tz);
  if (!f) {
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch {
      return null;
    }
    zoneFormats.set(tz, f);
  }
  const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const wall = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((wall - Math.floor(t / 1000) * 1000) / 6e4);
}
/** An instant as the reader's wall clock. */
export function toWall(t: number, offset: number, tz?: string): number {
  return t + ((tz ? tzOffset(tz, t) : null) ?? offset) * 6e4;
}

const DUR_UNIT: [RegExp, Unit][] = [
  [/^(y|yr|yrs|year|years)$/, "years"],
  [/^(mo|mos|month|months)$/, "months"],
  [/^(w|wk|wks|week|weeks)$/, "weeks"],
  [/^(d|day|days)$/, "days"],
  [/^(h|hr|hrs|hour|hours)$/, "hours"],
  [/^(m|min|mins|minute|minutes)$/, "minutes"],
  [/^(s|sec|secs|second|seconds)$/, "seconds"],
  [/^(ms|millisecond|milliseconds)$/, "milliseconds"],
];

/** "7 days", "1 day, 2 hours", "1d2h": a duration; null when it isn't one. */
export function parseDuration(s: string): Dur | null {
  const text = s.trim().toLowerCase();
  if (!text) return null;
  const parts: Partial<Record<Unit, number>> = {};
  const re = /(-?\d+(?:\.\d+)?)\s*([a-z]+)\s*(?:,|and)?\s*/gy;
  let at = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const unit = DUR_UNIT.find(([r]) => r.test(m![2]!))?.[1];
    if (!unit) return null;
    parts[unit] = (parts[unit] ?? 0) + Number(m[1]);
    at = re.lastIndex;
  }
  return at === text.length && at > 0 ? new Dur(parts) : null;
}

const LINK_TEXT = /^(!?)\[\[([^\[\]|\n]+?)(?:\\?\|([^\[\]\n]*))?\]\]$/;

function linkFromText(s: string): Link | null {
  const m = LINK_TEXT.exec(s.trim());
  if (!m) return null;
  const [target, sub] = m[2]!.split("#") as [string, string | undefined];
  return new Link(target.trim(), m[3]?.trim() || null, m[1] === "!", sub ?? null);
}

/** A frontmatter value: links and dates in strings become links and dates, as in Dataview. */
function fromYaml(v: unknown, offset: number): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return linkFromText(v) ?? parseIsoDate(v, offset) ?? v;
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (v instanceof Date) return new DDate(v.getTime());
  if (Array.isArray(v)) return v.map((x) => fromYaml(x, offset));
  // YAML reads [[Note]] unquoted as a list inside a list.
  if (typeof v === "object") return Object.fromEntries(Object.entries(v as object).map(([k, x]) => [k, fromYaml(x, offset)]));
  return String(v);
}

/** An inline field's value: a literal, or a comma-separated list of them, or the text itself. */
function inlineValue(raw: string, offset: number): Value {
  const one = (s: string): Value | undefined => {
    const t = s.trim();
    if (!t) return null;
    if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if (t === "true" || t === "false") return t === "true";
    if (/^"(?:[^"\\]|\\.)*"$/.test(t)) return t.slice(1, -1).replace(/\\(.)/g, "$1");
    return linkFromText(t) ?? parseIsoDate(t, offset) ?? parseDuration(t) ?? undefined;
  };
  const whole = one(raw);
  if (whole !== undefined) return whole;
  if (raw.includes(",")) {
    const parts = raw.split(",").map(one);
    if (parts.every((p) => p !== undefined)) return parts as Value[];
  }
  return raw.trim();
}

// ── pages ─────────────────────────────────────────────────────────────────────────────────

export interface PageInput {
  path: string;
  content: string;
  /** When it was made and last changed: instants, in ms. */
  ctime: number;
  mtime: number;
}

interface ListItem {
  line: number;
  /** The line of the item it sits under, or null at the top. */
  parent: number | null;
  children: ListItem[];
  text: string;
  /** " " / "x" / … for a task, null for a plain list item. */
  status: string | null;
  symbol: string;
  section: string | null;
  tags: string[];
  links: Link[];
  fields: [string, string][];
  blockId: string | null;
}

/** What a note says, read once per version (no time zone: that's applied per query). */
export interface PageData {
  path: string;
  size: number;
  ctime: number;
  mtime: number;
  frontmatter: Record<string, unknown>;
  /** Inline `key:: value` fields of the page (not of its list items). */
  fields: [string, string][];
  /** Tags as written, with '#': frontmatter's and inline. */
  tags: string[];
  links: Link[];
  aliases: string[];
  items: ListItem[];
}

const TAG_RE = /(^|[\s(,;])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(?:\[(.)\]\s?)?(.*)$/;
/** `[key:: value]` and `(key:: value)` anywhere; `key:: value` alone on a line. */
const BRACKET_FIELD = /[\[(]([^\[\]()\n:]+?)::\s*([^\]\)\n]*)[\])]/g;
const LINE_FIELD = /^\s*(?:[-*+]\s+(?:\[.\]\s+)?)?(?:\*\*|__)?([\p{L}\p{N}_][\p{L}\p{N}_ \-/]*?)(?:\*\*|__)?::\s*(.*)$/u;
const EMOJI: [RegExp, string][] = [
  [/📅\s*(\d{4}-\d{2}-\d{2})/u, "due"],
  [/⏳\s*(\d{4}-\d{2}-\d{2})/u, "scheduled"],
  [/🛫\s*(\d{4}-\d{2}-\d{2})/u, "start"],
  [/➕\s*(\d{4}-\d{2}-\d{2})/u, "created"],
  [/✅\s*(\d{4}-\d{2}-\d{2})/u, "completion"],
];

function tagsIn(text: string): string[] {
  return [...text.matchAll(TAG_RE)].map((m) => "#" + m[2]!.replace(/\/+$/, ""));
}

function frontList(v: unknown): string[] {
  if (Array.isArray(v)) return v.filter((x) => x !== null && x !== undefined).map(String);
  if (typeof v === "string") return v.split(/[,\s]+/).filter(Boolean);
  return [];
}

export function readPage(input: PageInput): PageData {
  const { data, body } = parseFrontmatter(input.content);
  const startLine = input.content.slice(0, input.content.length - body.length).split("\n").length - 1;
  const masked = maskCode(body).split("\n");
  const lines = body.split("\n");
  const tags = new Set<string>();
  for (const t of [...frontList(data.tags), ...frontList(data.tag)]) if (t.replace(/^#/, "")) tags.add("#" + t.replace(/^#/, ""));
  const fields: [string, string][] = [];
  const items: ListItem[] = [];
  const stack: { indent: number; item: ListItem }[] = [];
  let section: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = masked[i]!;
    for (const t of tagsIn(m)) tags.add(t);
    const h = /^#{1,6}\s+(.*?)\s*#*$/.exec(m);
    if (h) section = h[1]!;
    const li = LIST_RE.exec(m);
    if (li) {
      const indent = li[1]!.replace(/\t/g, "    ").length;
      while (stack.length && stack.at(-1)!.indent >= indent) stack.pop();
      const real = LIST_RE.exec(lines[i]!)!;
      const text = real[4]!;
      const own: [string, string][] = [...text.matchAll(BRACKET_FIELD)].map((f) => [f[1]!.trim(), f[2]!.trim()]);
      for (const [re, key] of EMOJI) {
        const e = re.exec(text);
        if (e) own.push([key, e[1]!]);
      }
      const item: ListItem = {
        line: startLine + i,
        parent: stack.length ? stack.at(-1)!.item.line : null,
        children: [],
        text,
        status: real[3] ?? null,
        symbol: real[2]!,
        section,
        tags: tagsIn(li[4]!),
        links: findWikiLinks(text).map((l) => new Link(l.target.split("#")[0]!, l.alias ?? null, l.embed, l.target.split("#")[1] ?? null)),
        fields: own,
        blockId: / \^([\w-]+)\s*$/.exec(text)?.[1] ?? null,
      };
      stack.at(-1)?.item.children.push(item);
      stack.push({ indent, item });
      items.push(item);
      continue;
    }
    if (m.trim()) stack.length = 0;
    const lf = LINE_FIELD.exec(m);
    if (lf && !/^\s*[-*+]/.test(m)) fields.push([lf[1]!.trim(), lines[i]!.slice(lines[i]!.indexOf("::") + 2).trim()]);
    else for (const f of m.matchAll(BRACKET_FIELD)) fields.push([f[1]!.trim(), lines[i]!.slice(f.index! + f[0].indexOf("::") + 2, f.index! + f[0].length - 1).trim()]);
  }
  const links: Link[] = [];
  const seen = new Set<string>();
  for (const l of findWikiLinks(maskCode(input.content))) {
    const [target, sub] = l.target.split("#") as [string, string | undefined];
    const key = normaliseTarget(target) + "#" + (sub ?? "");
    if (!target.trim() || seen.has(key)) continue;
    seen.add(key);
    links.push(new Link(target.trim(), null, l.embed, sub ?? null));
  }
  // Links in frontmatter values count as outgoing links, as in Dataview.
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      for (const l of findWikiLinks(v)) {
        const target = l.target.split("#")[0]!.trim();
        if (target && !seen.has(normaliseTarget(target) + "#")) {
          seen.add(normaliseTarget(target) + "#");
          links.push(new Link(target));
        }
      }
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(data);
  return {
    path: input.path,
    size: input.content.length,
    ctime: input.ctime,
    mtime: input.mtime,
    frontmatter: data,
    fields,
    tags: [...tags],
    links,
    aliases: [...frontList(data.aliases), ...frontList(data.alias)],
    items,
  };
}

// ── the vault: pages, link resolution, backlinks ──────────────────────────────────────────

const canon = (k: string) => k.trim().toLowerCase().replace(/[*_~`]/g, "").replace(/\s+/g, "-");

export class Vault {
  readonly byPath = new Map<string, PageData>();
  private summaries: NoteSummary[];
  private inlinks = new Map<string, Set<string>>();
  private resolved = new Map<string, string | null>();
  private objects = new Map<string, Map<string, Record<string, Value>>>();

  constructor(readonly pages: PageData[]) {
    for (const p of pages) this.byPath.set(p.path, p);
    this.summaries = pages.map((p, i) => ({
      id: i,
      path: p.path,
      title: titleFromPath(p.path),
      tags: [],
      updated_at: "",
      aliases: p.aliases.map((a) => a.toLowerCase()),
    }));
    for (const p of pages) {
      for (const l of p.links) {
        const to = this.resolve(l.target);
        if (!to || to === p.path) continue;
        let s = this.inlinks.get(to);
        if (!s) this.inlinks.set(to, (s = new Set()));
        s.add(p.path);
      }
    }
  }

  /** The page a link names, by the app's rules (path, title, path suffix, alias). */
  resolve(target: string): string | null {
    let r = this.resolved.get(target);
    if (r === undefined) {
      r = resolveLocal(this.summaries, target)?.path ?? null;
      this.resolved.set(target, r);
    }
    return r;
  }

  linkPath(l: Link): string {
    return this.resolve(l.target) ?? l.target;
  }

  inlinksOf(path: string): string[] {
    return [...(this.inlinks.get(path) ?? [])];
  }

  /** A page as Dataview sees it: its fields, then `file`. Built once per page and time zone. */
  object(path: string, offset: number, tz?: string): Record<string, Value> | null {
    const p = this.byPath.get(path);
    if (!p) return null;
    const zone = `${offset}|${tz ?? ""}`;
    let byZone = this.objects.get(zone);
    if (!byZone) this.objects.set(zone, (byZone = new Map()));
    let o = byZone.get(path);
    if (o) return o;
    o = {};
    for (const [k, v] of Object.entries(p.frontmatter)) o[k] = fromYaml(v, offset);
    for (const [k, raw] of p.fields) addField(o, k, inlineValue(raw, offset));
    const name = titleFromPath(p.path);
    const self = new Link(p.path.replace(/\.md$/i, ""), null);
    const day = parseIsoDate(/\d{4}-\d{2}-\d{2}/.exec(name)?.[0] ?? "", offset) ?? (o.date instanceof DDate ? o.date : null);
    const wall = (t: number) => new DDate(toWall(t, offset, tz));
    const startOfDay = (t: number) => new DDate(Math.floor(toWall(t, offset, tz) / 864e5) * 864e5);
    const etags = p.tags;
    const all = new Set<string>();
    for (const t of etags) {
      const parts = t.slice(1).split("/");
      for (let i = 1; i <= parts.length; i++) all.add("#" + parts.slice(0, i).join("/"));
    }
    const items = p.items.map((it) => listObject(it, p.path, offset, o!));
    const byLine = new Map(items.map((x) => [x.line as number, x]));
    for (const it of p.items) byLine.get(it.line)!.children = it.children.map((c) => byLine.get(c.line)!);
    for (const it of items) it.subtasks = it.children ?? [];
    o.file = {
      name,
      basename: name,
      path: p.path,
      folder: p.path.includes("/") ? p.path.slice(0, p.path.lastIndexOf("/")) : "",
      ext: "md",
      link: self,
      size: p.size,
      ctime: wall(p.ctime),
      cday: startOfDay(p.ctime),
      mtime: wall(p.mtime),
      mday: startOfDay(p.mtime),
      tags: [...all],
      etags: [...etags],
      inlinks: this.inlinksOf(p.path).map((q) => new Link(q.replace(/\.md$/i, ""))),
      outlinks: p.links.map((l) => new Link(this.linkPath(l).replace(/\.md$/i, ""), null, l.embed, l.subpath)),
      aliases: p.aliases,
      tasks: items.filter((x) => x.task),
      lists: items,
      frontmatter: fromYaml(p.frontmatter, offset),
      day,
      starred: false,
    };
    byZone.set(path, o);
    return o;
  }

  /** The pages a FROM names. */
  select(source: Source | null, thisPath: string | null): string[] {
    if (!source) return this.pages.map((p) => p.path);
    return [...this.matchSource(source, thisPath)];
  }

  private matchSource(s: Source, thisPath: string | null): Set<string> {
    const all = () => new Set(this.pages.map((p) => p.path));
    switch (s.k) {
      case "folder": {
        const f = s.path.replace(/^\/+|\/+$/g, "");
        if (!f) return all();
        const out = new Set<string>();
        const file = f.toLowerCase().endsWith(".md") ? f : f + ".md";
        for (const p of this.pages) if (p.path === file || p.path.startsWith(f + "/")) out.add(p.path);
        return out;
      }
      case "tag": {
        const t = s.tag.toLowerCase();
        return new Set(this.pages.filter((p) => p.tags.some((x) => x.toLowerCase() === t || x.toLowerCase().startsWith(t + "/"))).map((p) => p.path));
      }
      case "link": {
        const to = s.target ? this.resolve(s.target) : thisPath;
        if (!to) return new Set();
        if (s.outgoing) {
          const p = this.byPath.get(to);
          return new Set((p?.links ?? []).map((l) => this.resolve(l.target)).filter((x): x is string => !!x));
        }
        return new Set(this.inlinksOf(to));
      }
      case "not": {
        const no = this.matchSource(s.e, thisPath);
        return new Set([...all()].filter((p) => !no.has(p)));
      }
      case "and": {
        const b = this.matchSource(s.r, thisPath);
        return new Set([...this.matchSource(s.l, thisPath)].filter((p) => b.has(p)));
      }
      case "or":
        return new Set([...this.matchSource(s.l, thisPath), ...this.matchSource(s.r, thisPath)]);
    }
  }
}

function addField(o: Record<string, Value>, k: string, v: Value) {
  if (!(k in o)) o[k] = v;
  else o[k] = Array.isArray(o[k]) ? [...(o[k] as Value[]), v] : [o[k]!, v];
}

function listObject(it: ListItem, path: string, offset: number, page: Record<string, Value>): Record<string, Value> {
  // A task's fields first; anything else falls back to its page's.
  const o: Record<string, Value> = Object.create(page);
  for (const [k, raw] of it.fields) addField(o, k, inlineValue(raw, offset));
  const completed = it.status === "x" || it.status === "X";
  const visual = it.text.replace(BRACKET_FIELD, "").replace(/\s+\^[\w-]+\s*$/, "").trim();
  Object.assign(o, {
    text: it.text,
    visual,
    line: it.line,
    lineCount: 1,
    path,
    symbol: it.symbol,
    section: new Link(path.replace(/\.md$/i, ""), null, false, it.section),
    link: new Link(path.replace(/\.md$/i, ""), null, false, it.blockId ? "^" + it.blockId : it.section),
    tags: it.tags,
    outlinks: it.links,
    parent: it.parent,
    blockId: it.blockId,
    task: it.status !== null,
    status: it.status,
    checked: it.status !== null && it.status !== " ",
    completed,
    fullyCompleted: completed,
    annotated: it.fields.length > 0,
    real: true,
    children: [],
  } satisfies Record<string, Value>);
  return o;
}

// ── tokens ────────────────────────────────────────────────────────────────────────────────

type Tok =
  | { t: "num"; v: number; at: number; end: number }
  | { t: "str"; v: string; at: number; end: number }
  | { t: "id"; v: string; at: number; end: number }
  | { t: "op"; v: string; at: number; end: number }
  | { t: "link"; v: Link; at: number; end: number }
  | { t: "tag"; v: string; at: number; end: number }
  | { t: "lit"; v: Value; at: number; end: number }
  | { t: "datekw"; v: string; at: number; end: number }
  | { t: "eof"; v: ""; at: number; end: number };

const ID_START = /[\p{L}\p{Emoji_Presentation}_]/u;
const ID_PART = /[\p{L}\p{Emoji_Presentation}\p{N}_\-]/u;
const OPS = ["===", "!==", "=>", "==", "!=", "<=", ">=", "&&", "||", "?.", "=", "<", ">", "+", "-", "*", "/", "%", "!", "&", "|", "(", ")", "[", "]", "{", "}", ",", ".", ":"];

function lex(src: string, offset: number): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    // `// comment` to the end of the line.
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    const at = i;
    if (c === '"' || c === "'") {
      let s = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\" && i + 1 < src.length) {
          const n = src[++i]!;
          s += n === "n" ? "\n" : n === "t" ? "\t" : n;
        } else s += src[i];
        i++;
      }
      if (i >= src.length) throw new DvError(`a string starting at ${at + 1} isn't closed`);
      i++;
      out.push({ t: "str", v: s, at, end: i });
      continue;
    }
    if (/\d/.test(c)) {
      const m = /^\d+(\.\d+)?/.exec(src.slice(i))!;
      i += m[0].length;
      out.push({ t: "num", v: Number(m[0]), at, end: i });
      continue;
    }
    if (c === "[" && src[i + 1] === "[") {
      const close = src.indexOf("]]", i);
      if (close < 0) throw new DvError(`a link starting at ${at + 1} isn't closed`);
      const l = linkFromText(src.slice(i, close + 2));
      if (!l) throw new DvError(`can't read the link at ${at + 1}`);
      i = close + 2;
      out.push({ t: "link", v: l, at, end: i });
      continue;
    }
    if (c === "#" && /[\p{L}\p{N}_\-/]/u.test(src[i + 1] ?? "")) {
      const m = /^#[\p{L}\p{N}_\-/]+/u.exec(src.slice(i))!;
      i += m[0].length;
      out.push({ t: "tag", v: m[0], at, end: i });
      continue;
    }
    if (ID_START.test(c)) {
      let j = i + 1;
      while (j < src.length && (ID_PART.test(src[j]!) || /\p{M}/u.test(src[j]!))) {
        // `a-b` is a name, but `a - b` and `a->` are not.
        if (src[j] === "-" && !ID_PART.test(src[j + 1] ?? " ")) break;
        j++;
      }
      const word = src.slice(i, j);
      // date(today), dur(7 days): literals, read before the brackets are parsed.
      if ((word === "date" || word === "dur") && src[j] === "(") {
        const close = src.indexOf(")", j);
        const inner = close > j ? src.slice(j + 1, close) : "";
        const kw = inner.trim();
        // A keyword (today, sow…) is worked out when the query runs, at its "now".
        if (word === "date" && /^(now|today|tomorrow|yesterday|sow|eow|som|eom|soy|eoy)$/.test(kw)) {
          i = close + 1;
          out.push({ t: "datekw", v: kw, at, end: i });
          continue;
        }
        const lit = word === "date" ? (/^\d{4}-\d{2}/.test(kw) ? parseIsoDate(kw, offset) : null) : /["'(]/.test(inner) ? null : parseDuration(inner);
        if (lit) {
          i = close + 1;
          out.push({ t: "lit", v: lit, at, end: i });
          continue;
        }
      }
      i = j;
      out.push({ t: "id", v: word, at, end: i });
      continue;
    }
    const op = OPS.find((o) => src.startsWith(o, i));
    if (!op) throw new DvError(`unexpected "${c}" at ${at + 1}`);
    i += op.length;
    out.push({ t: "op", v: op, at, end: i });
  }
  out.push({ t: "eof", v: "", at: src.length, end: src.length });
  return out;
}

/** date(today) and friends, or an unquoted ISO date; null for anything else. */
function dateKeyword(s: string, offset: number, now = Date.now(), tz?: string): DDate | null {
  const wall = toWall(now, offset, tz);
  const day = Math.floor(wall / 864e5) * 864e5;
  const d = new Date(day);
  const dow = (d.getUTCDay() + 6) % 7; // Monday first, as Luxon's weeks
  const som = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  switch (s) {
    case "now":
      return new DDate(wall);
    case "today":
      return new DDate(day);
    case "tomorrow":
      return new DDate(day + 864e5);
    case "yesterday":
      return new DDate(day - 864e5);
    case "sow":
      return new DDate(day - dow * 864e5);
    case "eow":
      return new DDate(day + (7 - dow) * 864e5 - 1);
    case "som":
      return new DDate(som);
    case "eom":
      return new DDate(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1) - 1);
    case "soy":
      return new DDate(Date.UTC(d.getUTCFullYear(), 0, 1));
    case "eoy":
      return new DDate(Date.UTC(d.getUTCFullYear() + 1, 0, 1) - 1);
  }
  return /^\d{4}-\d{2}/.test(s) ? parseIsoDate(s, offset) : null;
}

// ── syntax ────────────────────────────────────────────────────────────────────────────────

export type Expr =
  | { k: "lit"; v: Value }
  | { k: "var"; name: string }
  | { k: "this" }
  | { k: "field"; obj: Expr; key: string }
  | { k: "index"; obj: Expr; idx: Expr }
  | { k: "call"; name: string; args: Expr[] }
  | { k: "method"; obj: Expr; name: string; args: Expr[] }
  | { k: "bin"; op: string; l: Expr; r: Expr }
  | { k: "neg"; e: Expr }
  | { k: "not"; e: Expr }
  | { k: "list"; items: Expr[] }
  | { k: "obj"; entries: [string, Expr][] }
  | { k: "lambda"; params: string[]; body: Expr };

export type Source =
  | { k: "folder"; path: string }
  | { k: "tag"; tag: string }
  | { k: "link"; target: string | null; outgoing: boolean }
  | { k: "not"; e: Source }
  | { k: "and"; l: Source; r: Source }
  | { k: "or"; l: Source; r: Source };

type Clause =
  | { k: "where"; e: Expr }
  | { k: "sort"; keys: { e: Expr; desc: boolean }[] }
  | { k: "group"; e: Expr; name: string }
  | { k: "flatten"; e: Expr; name: string }
  | { k: "limit"; e: Expr };

export interface Query {
  kind: "table" | "list" | "task" | "calendar";
  withoutId: boolean;
  fields: { e: Expr; name: string }[];
  source: Source | null;
  clauses: Clause[];
}

const CLAUSE = new Set(["from", "where", "sort", "group", "flatten", "limit"]);
const STOP = new Set([...CLAUSE, "as", "asc", "desc", "ascending", "descending"]);

class Parser {
  i = 0;
  constructor(
    readonly src: string,
    readonly toks: Tok[],
  ) {}
  get peek() {
    return this.toks[this.i]!;
  }
  next() {
    return this.toks[this.i++]!;
  }
  isWord(w: string, at = 0) {
    const t = this.toks[this.i + at]!;
    return t.t === "id" && t.v.toLowerCase() === w;
  }
  isOp(o: string) {
    return this.peek.t === "op" && this.peek.v === o;
  }
  eatOp(o: string) {
    if (!this.isOp(o)) throw this.fail(`expected "${o}"`);
    this.i++;
  }
  eatWord(w: string) {
    if (!this.isWord(w)) throw this.fail(`expected ${w.toUpperCase()}`);
    this.i++;
  }
  fail(what: string) {
    const t = this.peek;
    const line = this.src.slice(0, t.at).split("\n").length;
    const shown = t.t === "eof" ? "the end of the query" : `"${this.src.slice(t.at, t.end)}"`;
    return new DvError(`${what}, but found ${shown} (line ${line})`);
  }

  expr(): Expr {
    return this.or();
  }
  or(): Expr {
    let l = this.and();
    while (this.isWord("or") || this.isOp("|") || this.isOp("||")) {
      this.next();
      l = { k: "bin", op: "or", l, r: this.and() };
    }
    return l;
  }
  and(): Expr {
    let l = this.cmp();
    while (this.isWord("and") || this.isOp("&") || this.isOp("&&")) {
      this.next();
      l = { k: "bin", op: "and", l, r: this.cmp() };
    }
    return l;
  }
  cmp(): Expr {
    let l = this.add();
    const ops: Record<string, string> = { "=": "=", "==": "=", "===": "=", "!=": "!=", "!==": "!=", "<": "<", ">": ">", "<=": "<=", ">=": ">=" };
    while (this.peek.t === "op" && ops[this.peek.v]) {
      const op = ops[this.next().v as string]!;
      l = { k: "bin", op, l, r: this.add() };
    }
    return l;
  }
  add(): Expr {
    let l = this.mul();
    while (this.isOp("+") || this.isOp("-")) {
      const op = this.next().v as string;
      l = { k: "bin", op, l, r: this.mul() };
    }
    return l;
  }
  mul(): Expr {
    let l = this.unary();
    while (this.isOp("*") || this.isOp("/") || this.isOp("%")) {
      const op = this.next().v as string;
      l = { k: "bin", op, l, r: this.unary() };
    }
    return l;
  }
  unary(): Expr {
    if (this.isOp("!")) {
      this.next();
      return { k: "not", e: this.unary() };
    }
    if (this.isOp("-")) {
      this.next();
      return { k: "neg", e: this.unary() };
    }
    return this.postfix(this.primary());
  }
  postfix(e: Expr): Expr {
    for (;;) {
      if (this.isOp(".") || this.isOp("?.")) {
        this.next();
        const t = this.next();
        if (t.t !== "id") throw this.fail("expected a field name after the dot");
        if (this.isOp("(")) e = { k: "method", obj: e, name: t.v, args: this.args() };
        else e = { k: "field", obj: e, key: t.v };
      } else if (this.isOp("[")) {
        this.next();
        const idx = this.expr();
        this.eatOp("]");
        e = { k: "index", obj: e, idx };
      } else return e;
    }
  }
  args(): Expr[] {
    this.eatOp("(");
    const out: Expr[] = [];
    while (!this.isOp(")")) {
      out.push(this.expr());
      if (!this.isOp(")")) this.eatOp(",");
    }
    this.eatOp(")");
    return out;
  }
  primary(): Expr {
    const t = this.peek;
    if (t.t === "num" || t.t === "str" || t.t === "lit") {
      this.next();
      return { k: "lit", v: t.v as Value };
    }
    if (t.t === "link") {
      this.next();
      return { k: "lit", v: t.v };
    }
    if (t.t === "datekw") {
      this.next();
      return { k: "call", name: "date", args: [{ k: "lit", v: t.v }] };
    }
    if (t.t === "op" && t.v === "(") {
      // (a, b) => body, or a bracketed expression.
      const save = this.i;
      const params = this.tryParams();
      if (params) return { k: "lambda", params, body: this.expr() };
      this.i = save + 1;
      const e = this.expr();
      this.eatOp(")");
      return e;
    }
    if (t.t === "op" && t.v === "[") {
      this.next();
      const items: Expr[] = [];
      while (!this.isOp("]")) {
        items.push(this.expr());
        if (!this.isOp("]")) this.eatOp(",");
      }
      this.next();
      return { k: "list", items };
    }
    if (t.t === "op" && t.v === "{") {
      this.next();
      const entries: [string, Expr][] = [];
      while (!this.isOp("}")) {
        const k = this.next();
        if (k.t !== "id" && k.t !== "str") throw this.fail("expected a key");
        this.eatOp(":");
        entries.push([k.v as string, this.expr()]);
        if (!this.isOp("}")) this.eatOp(",");
      }
      this.next();
      return { k: "obj", entries };
    }
    if (t.t === "id") {
      const w = t.v;
      if (STOP.has(w.toLowerCase()) || w.toLowerCase() === "and" || w.toLowerCase() === "or") throw this.fail("expected a value");
      this.next();
      if (this.isOp("=>")) {
        this.next();
        return { k: "lambda", params: [w], body: this.expr() };
      }
      if (w === "true" || w === "false") return { k: "lit", v: w === "true" };
      if (w === "null" || w === "undefined") return { k: "lit", v: null };
      if (w === "this") return { k: "this" };
      if (this.isOp("(")) return { k: "call", name: w, args: this.args() };
      return { k: "var", name: w };
    }
    throw this.fail("expected a value");
  }
  /** `(a, b) =>`: the parameter names, or null (and nothing read) when it isn't a lambda. */
  tryParams(): string[] | null {
    const save = this.i;
    this.next();
    const names: string[] = [];
    while (this.peek.t === "id") {
      names.push(this.next().v as string);
      if (this.isOp(",")) this.next();
      else break;
    }
    if (this.isOp(")") && this.toks[this.i + 1]?.t === "op" && this.toks[this.i + 1]!.v === "=>") {
      this.i += 2;
      return names;
    }
    this.i = save;
    return null;
  }

  name(): string {
    const t = this.next();
    if (t.t === "id" || t.t === "str") return t.v as string;
    this.i--;
    throw this.fail("expected a name");
  }
  text(from: number, to: number) {
    return this.src.slice(this.toks[from]!.at, this.toks[to - 1]!.end).trim();
  }

  source(): Source {
    let l = this.sourceAnd();
    while (this.isWord("or") || this.isOp("|") || this.isOp("||")) {
      this.next();
      l = { k: "or", l, r: this.sourceAnd() };
    }
    return l;
  }
  sourceAnd(): Source {
    let l = this.sourceAtom();
    while (this.isWord("and") || this.isOp("&") || this.isOp("&&")) {
      this.next();
      l = { k: "and", l, r: this.sourceAtom() };
    }
    return l;
  }
  sourceAtom(): Source {
    const t = this.peek;
    if (this.isOp("-") || this.isOp("!")) {
      this.next();
      return { k: "not", e: this.sourceAtom() };
    }
    if (this.isOp("(")) {
      this.next();
      const s = this.source();
      this.eatOp(")");
      return s;
    }
    if (t.t === "str") {
      this.next();
      return { k: "folder", path: t.v };
    }
    if (t.t === "tag") {
      this.next();
      return { k: "tag", tag: t.v };
    }
    if (t.t === "link") {
      this.next();
      return { k: "link", target: t.v.target || null, outgoing: false };
    }
    if (this.isWord("outgoing") || this.isWord("incoming")) {
      const outgoing = this.next().v === "outgoing";
      this.eatOp("(");
      const l = this.next();
      if (l.t !== "link") throw this.fail("expected a [[link]]");
      this.eatOp(")");
      return { k: "link", target: l.v.target || null, outgoing };
    }
    throw this.fail(`expected a folder in quotes, a #tag or a [[link]]`);
  }

  query(): Query {
    const head = this.next();
    const kind = head.t === "id" ? head.v.toLowerCase() : "";
    if (kind !== "table" && kind !== "list" && kind !== "task" && kind !== "calendar") {
      this.i--;
      throw this.fail("a query starts with TABLE, LIST, TASK or CALENDAR");
    }
    const q: Query = { kind, withoutId: false, fields: [], source: null, clauses: [] };
    if (this.isWord("without") && (this.toks[this.i + 1]!.t === "id" && (this.toks[this.i + 1]!.v as string).toLowerCase() === "id")) {
      this.i += 2;
      q.withoutId = true;
    }
    const atClause = () => this.peek.t === "eof" || (this.peek.t === "id" && CLAUSE.has((this.peek.v as string).toLowerCase()));
    if (kind === "table" || kind === "list" || kind === "calendar") {
      while (!atClause()) {
        const from = this.i;
        const e = this.expr();
        const to = this.i;
        let name = this.text(from, to);
        if (this.isWord("as")) {
          this.next();
          name = this.name();
        }
        q.fields.push({ e, name });
        if (kind !== "table") break;
        if (this.isOp(",")) this.next();
        else break;
      }
    }
    if (this.isWord("from")) {
      this.next();
      q.source = this.source();
    }
    while (this.peek.t !== "eof") {
      const w = this.peek.t === "id" ? (this.peek.v as string).toLowerCase() : "";
      if (w === "where") {
        this.next();
        q.clauses.push({ k: "where", e: this.expr() });
      } else if (w === "sort") {
        this.next();
        const keys: { e: Expr; desc: boolean }[] = [];
        do {
          if (this.isOp(",")) this.next();
          const e = this.expr();
          let desc = false;
          if (this.isWord("desc") || this.isWord("descending")) (this.next(), (desc = true));
          else if (this.isWord("asc") || this.isWord("ascending")) this.next();
          keys.push({ e, desc });
        } while (this.isOp(","));
        q.clauses.push({ k: "sort", keys });
      } else if (w === "group" && this.isWord("by", 1)) {
        this.i += 2;
        const from = this.i;
        const e = this.expr();
        let name = this.text(from, this.i);
        if (this.isWord("as")) (this.next(), (name = this.name()));
        q.clauses.push({ k: "group", e, name });
      } else if (w === "flatten") {
        this.next();
        const from = this.i;
        const e = this.expr();
        let name = this.text(from, this.i);
        if (this.isWord("as")) (this.next(), (name = this.name()));
        q.clauses.push({ k: "flatten", e, name });
      } else if (w === "limit") {
        this.next();
        q.clauses.push({ k: "limit", e: this.expr() });
      } else if (w === "from") throw this.fail("FROM comes straight after the fields");
      else throw this.fail("expected WHERE, SORT, GROUP BY, FLATTEN or LIMIT");
    }
    return q;
  }
}

export function parseQuery(src: string, offset = 0): Query {
  return new Parser(src, lex(src, offset)).query();
}

export function parseExpression(src: string, offset = 0): Expr {
  const p = new Parser(src, lex(src, offset));
  const e = p.expr();
  if (p.peek.t !== "eof") throw p.fail("expected the end of the expression");
  return e;
}

// ── evaluating ────────────────────────────────────────────────────────────────────────────

interface Scope {
  vars: Record<string, Value>;
  parent: Scope | null;
}

interface Ctx {
  vault: Vault;
  offset: number;
  tz?: string;
  now: number;
  thisObj: Record<string, Value> | null;
  thisPath: string | null;
  steps: number;
}

const BUDGET = 3_000_000;

/** A field of an object, by its name or Dataview's simplified form ("Due Date" → due-date). */
function getField(o: Record<string, Value>, key: string): Value {
  if (key in o) return o[key] ?? null;
  const c = canon(key);
  for (const k in o) if (canon(k) === c) return o[k] ?? null;
  return null;
}

function field(v: Value, key: string, ctx: Ctx): Value {
  if (v === null || v === undefined) return null;
  if (Array.isArray(v)) {
    // `rows.file.link`: each element's field, flattened, as Dataview does.
    if (key === "length") return v.length;
    const out: Value[] = [];
    for (const x of v) {
      const f = field(x, key, ctx);
      if (Array.isArray(f)) out.push(...f);
      else out.push(f);
    }
    return out;
  }
  if (typeof v === "string") return key === "length" ? v.length : null;
  if (v instanceof Link) {
    // A link's field is the linked page's.
    const to = ctx.vault.resolve(v.target);
    const o = to ? ctx.vault.object(to, ctx.offset, ctx.tz) : null;
    if (key === "path") return o ? ((o.file as any).path as string) : v.target;
    if (key === "display") return v.display;
    if (key === "embed") return v.embed;
    if (key === "subpath") return v.subpath;
    return o ? getField(o, key) : null;
  }
  if (v instanceof DDate) {
    const d = v.d;
    const m: Record<string, number> = {
      year: d.getUTCFullYear(),
      month: d.getUTCMonth() + 1,
      day: d.getUTCDate(),
      hour: d.getUTCHours(),
      minute: d.getUTCMinutes(),
      second: d.getUTCSeconds(),
      millisecond: d.getUTCMilliseconds(),
      weekday: ((d.getUTCDay() + 6) % 7) + 1,
      week: isoWeek(d),
      weekyear: d.getUTCFullYear(),
      quarter: Math.floor(d.getUTCMonth() / 3) + 1,
      ts: v.ms - ctx.offset * 6e4,
    };
    return m[key] ?? null;
  }
  if (v instanceof Dur) {
    const all = shiftAll(v.ms);
    if (key in UNIT_MS) return all[key as Unit] ?? 0;
    return null;
  }
  if (isObj(v)) return getField(v, key);
  return null;
}

function isoWeek(d: Date): number {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  return Math.ceil(((t.getTime() - Date.UTC(t.getUTCFullYear(), 0, 1)) / 864e5 + 1) / 7);
}

export function truthy(v: Value): boolean {
  if (v === null || v === undefined) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "string") return v.length > 0;
  if (v instanceof Link) return !!v.target;
  if (v instanceof DDate) return v.ms !== 0;
  if (v instanceof Dur) return v.ms !== 0;
  if (Array.isArray(v)) return v.length > 0;
  if (isFn(v)) return true;
  return Object.keys(v).length > 0;
}

/** Dataview's ordering: null first, then by type name, then by value. */
export function compare(a: Value, b: Value, vault: Vault): number {
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (ta !== tb) return ta < tb ? -1 : 1;
  switch (ta) {
    case "string":
      return (a as string).localeCompare(b as string);
    case "number":
      return (a as number) - (b as number);
    case "boolean":
      return a === b ? 0 : a ? 1 : -1;
    case "date":
      return (a as DDate).ms - (b as DDate).ms;
    case "duration":
      return (a as Dur).ms - (b as Dur).ms;
    case "link": {
      const pa = vault.linkPath(a as Link).replace(/\.md$/i, "").toLowerCase();
      const pb = vault.linkPath(b as Link).replace(/\.md$/i, "").toLowerCase();
      if (pa !== pb) return pa < pb ? -1 : 1;
      return ((a as Link).subpath ?? "").localeCompare((b as Link).subpath ?? "");
    }
    case "array": {
      const x = a as Value[];
      const y = b as Value[];
      for (let i = 0; i < Math.min(x.length, y.length); i++) {
        const c = compare(x[i]!, y[i]!, vault);
        if (c) return c;
      }
      return x.length - y.length;
    }
    case "object": {
      const ka = Object.keys(a as object).sort();
      const kb = Object.keys(b as object).sort();
      const c = compare(ka, kb, vault);
      if (c) return c;
      for (const k of ka) {
        const d = compare((a as any)[k], (b as any)[k], vault);
        if (d) return d;
      }
      return 0;
    }
  }
  return 0;
}

function addDur(d: DDate, dur: Dur, sign: 1 | -1): DDate {
  const p = dur.parts;
  const t = new Date(d.ms);
  const months = sign * ((p.years ?? 0) * 12 + (p.months ?? 0));
  if (months) {
    const day = t.getUTCDate();
    t.setUTCDate(1);
    t.setUTCMonth(t.getUTCMonth() + months);
    const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
    t.setUTCDate(Math.min(day, last));
  }
  const rest = UNITS.slice(2).reduce((n, u) => n + (p[u] ?? 0) * UNIT_MS[u], 0);
  return new DDate(t.getTime() + sign * rest);
}

function binary(op: string, a: Value, b: Value, vault: Vault): Value {
  switch (op) {
    case "=":
      return compare(a, b, vault) === 0;
    case "!=":
      return compare(a, b, vault) !== 0;
    case "<":
      return compare(a, b, vault) < 0;
    case ">":
      return compare(a, b, vault) > 0;
    case "<=":
      return compare(a, b, vault) <= 0;
    case ">=":
      return compare(a, b, vault) >= 0;
  }
  if (a === null || b === null) return null;
  const ta = typeOf(a);
  const tb = typeOf(b);
  if (op === "+") {
    if (ta === "number" && tb === "number") return (a as number) + (b as number);
    if (ta === "string" || tb === "string") return display(a, vault) + display(b, vault);
    if (ta === "date" && tb === "duration") return addDur(a as DDate, b as Dur, 1);
    if (ta === "duration" && tb === "date") return addDur(b as DDate, a as Dur, 1);
    if (ta === "duration" && tb === "duration") return Dur.fromMs((a as Dur).ms + (b as Dur).ms);
    if (ta === "array" && tb === "array") return [...(a as Value[]), ...(b as Value[])];
  }
  if (op === "-") {
    if (ta === "number" && tb === "number") return (a as number) - (b as number);
    if (ta === "date" && tb === "duration") return addDur(a as DDate, b as Dur, -1);
    if (ta === "date" && tb === "date") return Dur.fromMs((a as DDate).ms - (b as DDate).ms);
    if (ta === "duration" && tb === "duration") return Dur.fromMs((a as Dur).ms - (b as Dur).ms);
  }
  if (op === "*") {
    if (ta === "number" && tb === "number") return (a as number) * (b as number);
    if (ta === "duration" && tb === "number") return (a as Dur).scale(b as number);
    if (ta === "number" && tb === "duration") return (b as Dur).scale(a as number);
  }
  if (op === "/") {
    if (ta === "number" && tb === "number") return (a as number) / (b as number);
    if (ta === "duration" && tb === "number") return (a as Dur).scale(1 / (b as number));
  }
  if (op === "%" && ta === "number" && tb === "number") return (a as number) % (b as number);
  throw new DvError(`can't do ${ta} ${op} ${tb}`);
}

function lookup(scope: Scope | null, name: string): { found: boolean; v: Value } {
  for (let s = scope; s; s = s.parent) {
    if (name in s.vars) return { found: true, v: s.vars[name] ?? null };
  }
  return { found: false, v: null };
}

function evaluate(e: Expr, row: Record<string, Value>, scope: Scope | null, ctx: Ctx): Value {
  if (++ctx.steps > BUDGET) throw new DvError("this query is too big to run");
  switch (e.k) {
    case "lit":
      return e.v;
    case "this":
      return ctx.thisObj;
    case "var": {
      const l = lookup(scope, e.name);
      if (l.found) return l.v;
      if (e.name === "dv") return { __dv: true };
      return getField(row, e.name);
    }
    case "field": {
      const o = evaluate(e.obj, row, scope, ctx);
      return field(o, e.key, ctx);
    }
    case "index": {
      const o = evaluate(e.obj, row, scope, ctx);
      const i = evaluate(e.idx, row, scope, ctx);
      if (Array.isArray(o) && typeof i === "number") return o[i < 0 ? o.length + i : i] ?? null;
      if (typeof i === "string") return field(o, i, ctx);
      if (typeof o === "string" && typeof i === "number") return o[i] ?? null;
      return null;
    }
    case "not":
      return !truthy(evaluate(e.e, row, scope, ctx));
    case "neg": {
      const v = evaluate(e.e, row, scope, ctx);
      if (typeof v === "number") return -v;
      if (v instanceof Dur) return v.scale(-1);
      if (v === null) return null;
      throw new DvError(`can't negate ${typeOf(v)}`);
    }
    case "bin": {
      if (e.op === "and") return truthy(evaluate(e.l, row, scope, ctx)) && truthy(evaluate(e.r, row, scope, ctx));
      if (e.op === "or") return truthy(evaluate(e.l, row, scope, ctx)) || truthy(evaluate(e.r, row, scope, ctx));
      return binary(e.op, evaluate(e.l, row, scope, ctx), evaluate(e.r, row, scope, ctx), ctx.vault);
    }
    case "list":
      return e.items.map((x) => evaluate(x, row, scope, ctx));
    case "obj":
      return Object.fromEntries(e.entries.map(([k, x]) => [k, evaluate(x, row, scope, ctx)]));
    case "lambda":
      return { params: e.params, body: e.body, scope: { vars: { __row: row as any }, parent: scope } } satisfies Fn;
    case "call": {
      const l = lookup(scope, e.name);
      if (l.found && isFn(l.v)) return apply(l.v, e.args.map((a) => evaluate(a, row, scope, ctx)), ctx);
      return callFn(e.name, e.args, row, scope, ctx);
    }
    case "method": {
      // dv.pages("folder"): the pages a FROM would give.
      if (e.obj.k === "var" && e.obj.name === "dv" && !lookup(scope, "dv").found) {
        if (e.name !== "pages") throw new DvError(`dv.${e.name} isn't supported; only dv.pages`);
        const src = e.args.length ? evaluate(e.args[0]!, row, scope, ctx) : "";
        return pagesFrom(typeof src === "string" ? src : "", ctx);
      }
      const name = METHODS[e.name] ?? e.name.toLowerCase();
      return callFn(name, [e.obj, ...e.args], row, scope, ctx);
    }
  }
}

/** JavaScript's names for the same functions, so `$= dv.pages().where(…)` translates. */
const METHODS: Record<string, string> = {
  where: "filter",
  filter: "filter",
  map: "map",
  includes: "contains",
  some: "any",
  every: "all",
  join: "join",
  startsWith: "startswith",
  endsWith: "endswith",
  toLowerCase: "lower",
  toUpperCase: "upper",
  sort: "sort",
  reverse: "reverse",
  slice: "slice",
  flat: "flat",
  split: "split",
  replace: "replace",
  trim: "trim",
  first: "first",
  last: "last",
  distinct: "unique",
};

function pagesFrom(src: string, ctx: Ctx): Value[] {
  let source: Source | null = null;
  if (src.trim()) {
    try {
      source = new Parser(src, lex(src, ctx.offset)).source();
    } catch {
      // dv.pages("Projects"): a folder written without its quotes.
      source = { k: "folder", path: src.trim() };
    }
  }
  return ctx.vault.select(source, ctx.thisPath).map((p) => ctx.vault.object(p, ctx.offset, ctx.tz)!);
}

function apply(f: Fn, args: Value[], ctx: Ctx): Value {
  const vars: Record<string, Value> = {};
  f.params.forEach((p, i) => (vars[p] = args[i] ?? null));
  const row = (f.scope.vars.__row as unknown as Record<string, Value>) ?? {};
  return evaluate(f.body, row, { vars, parent: f.scope }, ctx);
}

// ── functions ─────────────────────────────────────────────────────────────────────────────

const str = (v: Value, vault: Vault) => (typeof v === "string" ? v : display(v, vault));

/** A pattern from a note, refused if it looks like it could take forever. */
function regex(pattern: Value, flags = ""): RegExp {
  if (typeof pattern !== "string") throw new DvError("a pattern must be text");
  if (pattern.length > 300 || /\([^)]*[+*}][^)]*\)\s*[+*{]/.test(pattern) || /(\\[1-9])/.test(pattern)) throw new DvError("that pattern could be slow, so it isn't run");
  try {
    return new RegExp(pattern, flags);
  } catch (e) {
    throw new DvError(`the pattern doesn't read: ${(e as Error).message}`);
  }
}
const capText = (s: string) => (s.length > 200_000 ? s.slice(0, 200_000) : s);

function containsValue(hay: Value, needle: Value, vault: Vault, mode: "normal" | "insensitive" | "exact"): boolean {
  if (hay === null) return false;
  if (typeof hay === "string") {
    if (typeof needle !== "string") return false;
    return mode === "insensitive" ? hay.toLowerCase().includes(needle.toLowerCase()) : hay.includes(needle);
  }
  if (Array.isArray(hay)) {
    if (mode === "exact") return hay.some((x) => compare(x, needle, vault) === 0);
    return hay.some((x) => containsValue(x, needle, vault, mode) || compare(x, needle, vault) === 0);
  }
  if (isObj(hay)) return typeof needle === "string" && needle in hay;
  if (mode === "insensitive" && typeof needle === "string" && hay instanceof Link) return false;
  return compare(hay, needle, vault) === 0;
}

const vectorised = (f: (v: Value) => Value) => (v: Value): Value => (Array.isArray(v) ? v.map(f) : f(v));

function callFn(name: string, argExprs: Expr[], row: Record<string, Value>, scope: Scope | null, ctx: Ctx): Value {
  const lname = name.toLowerCase();
  const ev = (i: number) => (argExprs[i] ? evaluate(argExprs[i]!, row, scope, ctx) : null);
  const args = () => argExprs.map((_, i) => ev(i));
  const v = ctx.vault;
  const fnArg = (x: Value): Fn => {
    if (!isFn(x)) throw new DvError(`${name} needs a function like (x) => …`);
    return x;
  };
  const list = (x: Value): Value[] => (Array.isArray(x) ? x : x === null ? [] : [x]);
  switch (lname) {
    // Constructors
    case "object": {
      const a = args();
      const o: Record<string, Value> = {};
      for (let i = 0; i + 1 < a.length; i += 2) o[String(a[i])] = a[i + 1]!;
      return o;
    }
    case "list":
    case "array": {
      const a = args();
      return a.length === 1 && Array.isArray(a[0]) ? a[0] : a;
    }
    case "date": {
      const [x, fmt] = [ev(0), ev(1)];
      if (x instanceof DDate) return x;
      if (x instanceof Link) return parseIsoDate(titleFromPath(x.target), ctx.offset) ?? (field(x, "file", ctx) as any)?.day ?? null;
      if (typeof x === "string") return typeof fmt === "string" ? parseWithFormat(x, fmt) : (dateKeyword(x.trim(), ctx.offset, ctx.now, ctx.tz) ?? parseIsoDate(x, ctx.offset));
      return null;
    }
    case "dur": {
      const x = ev(0);
      if (x instanceof Dur) return x;
      return typeof x === "string" ? parseDuration(x) : null;
    }
    case "number":
      return vectorised((x) => {
        if (typeof x === "number") return x;
        const m = typeof x === "string" ? /-?\d+(\.\d+)?/.exec(x) : null;
        return m ? Number(m[0]) : null;
      })(ev(0));
    case "string":
      return str(ev(0), v);
    case "link": {
      const [x, d] = [ev(0), ev(1)];
      const dsp = d === null ? null : str(d, v);
      if (x instanceof Link) return x.withDisplay(dsp ?? x.display);
      if (typeof x === "string") return (linkFromText(x) ?? new Link(x.replace(/\.md$/i, ""))).withDisplay(dsp);
      return null;
    }
    case "embed": {
      const x = ev(0);
      const on = argExprs.length > 1 ? truthy(ev(1)) : true;
      return x instanceof Link ? new Link(x.target, x.display, on, x.subpath) : null;
    }
    case "elink": {
      const [u, d] = [ev(0), ev(1)];
      return { __elink: str(u, v), display: d === null ? str(u, v) : str(d, v) };
    }
    case "typeof":
      return typeOf(ev(0));
    // Numbers
    case "round": {
      const [x, d] = [ev(0), ev(1)];
      const k = 10 ** (typeof d === "number" ? d : 0);
      return vectorised((y) => (typeof y === "number" ? Math.round(y * k) / k : null))(x);
    }
    case "trunc":
      return vectorised((y) => (typeof y === "number" ? Math.trunc(y) : null))(ev(0));
    case "floor":
      return vectorised((y) => (typeof y === "number" ? Math.floor(y) : null))(ev(0));
    case "ceil":
      return vectorised((y) => (typeof y === "number" ? Math.ceil(y) : null))(ev(0));
    case "min":
    case "max": {
      const a = args();
      const xs = (a.length === 1 && Array.isArray(a[0]) ? a[0] : a).filter((x) => x !== null);
      if (!xs.length) return null;
      return xs.reduce((m, x) => ((lname === "min" ? compare(x, m, v) < 0 : compare(x, m, v) > 0) ? x : m));
    }
    case "sum":
    case "product": {
      const xs: Value[] = list(ev(0)).filter((x) => x !== null);
      if (!xs.length) return lname === "sum" ? 0 : 1;
      return xs.reduce((m, x) => binary(lname === "sum" ? "+" : "*", m, x, v));
    }
    case "average":
    case "avg": {
      const xs: Value[] = list(ev(0)).filter((x) => x !== null);
      if (!xs.length) return null;
      return binary("/", xs.reduce((m, x) => binary("+", m, x, v)), xs.length, v);
    }
    case "minby":
    case "maxby": {
      const xs = list(ev(0));
      const f = fnArg(ev(1));
      if (!xs.length) return null;
      let best: Value = xs[0]!;
      let bk: Value = apply(f, [best], ctx);
      for (const x of xs.slice(1)) {
        const k = apply(f, [x], ctx);
        if (lname === "minby" ? compare(k, bk, v) < 0 : compare(k, bk, v) > 0) (best = x), (bk = k);
      }
      return best;
    }
    case "reduce": {
      const [xs, op] = [list(ev(0)), ev(1)];
      if (!xs.length) return null;
      if (typeof op === "string") return xs.reduce((m, x) => binary(op, m, x, v));
      const f = fnArg(op);
      return xs.reduce((m, x) => apply(f, [m, x], ctx));
    }
    // Lists and objects
    case "contains":
    case "icontains":
    case "econtains": {
      const [h, n] = [ev(0), ev(1)];
      return containsValue(h, n, v, lname === "icontains" ? "insensitive" : lname === "econtains" ? "exact" : "normal");
    }
    case "containsword": {
      const [h, n] = [ev(0), ev(1)];
      const word = (s: Value) => typeof s === "string" && typeof n === "string" && new RegExp(`(^|[^\\p{L}\\p{N}_])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}_])`, "iu").test(s);
      return Array.isArray(h) ? h.map(word) : word(h);
    }
    case "extract": {
      const [o = null, ...keys] = args();
      if (!isObj(o)) return null;
      return Object.fromEntries(keys.map((k) => [String(k), getField(o, String(k))]));
    }
    case "sort": {
      const xs = [...list(ev(0))];
      const f = argExprs[1] ? fnArg(ev(1)) : null;
      const keyed = xs.map((x) => ({ x, k: f ? apply(f, [x], ctx) : x }));
      keyed.sort((a, b) => compare(a.k, b.k, v));
      return keyed.map((a) => a.x);
    }
    case "reverse": {
      const x = ev(0);
      return typeof x === "string" ? [...x].reverse().join("") : [...list(x)].reverse();
    }
    case "length": {
      const x = ev(0);
      if (x === null) return 0;
      if (typeof x === "string" || Array.isArray(x)) return x.length;
      if (isObj(x)) return Object.keys(x).length;
      return 0;
    }
    case "nonnull":
      return list(ev(0)).filter((x) => x !== null);
    case "all":
    case "any":
    case "none": {
      const a = args();
      let xs: Value[];
      let f: Fn | null = null;
      if (a.length >= 2 && isFn(a[1]!)) (xs = list(a[0]!)), (f = a[1] as Fn);
      else xs = a.length === 1 ? list(a[0]!) : a;
      const test = (x: Value) => truthy(f ? apply(f, [x], ctx) : x);
      if (lname === "all") return xs.every(test);
      if (lname === "any") return xs.some(test);
      return !xs.some(test);
    }
    case "join": {
      const [xs, sep] = [ev(0), ev(1)];
      return list(xs)
        .map((x) => str(x, v))
        .join(typeof sep === "string" ? sep : ", ");
    }
    case "filter": {
      const xs = list(ev(0));
      const f = fnArg(ev(1));
      return xs.filter((x) => truthy(apply(f, [x], ctx)));
    }
    case "map": {
      const xs = list(ev(0));
      const f = fnArg(ev(1));
      return xs.map((x) => apply(f, [x], ctx));
    }
    case "flat": {
      const [xs, d] = [list(ev(0)), ev(1)];
      return (xs as any[]).flat(typeof d === "number" ? d : 1) as Value[];
    }
    case "slice": {
      const [xs, s, e2] = [ev(0), ev(1), ev(2)];
      if (typeof xs === "string") return xs.slice(typeof s === "number" ? s : 0, typeof e2 === "number" ? e2 : undefined);
      return list(xs).slice(typeof s === "number" ? s : 0, typeof e2 === "number" ? e2 : undefined);
    }
    case "unique": {
      const out: Value[] = [];
      for (const x of list(ev(0))) if (!out.some((y) => compare(x, y, v) === 0)) out.push(x);
      return out;
    }
    case "firstvalue":
      return list(ev(0)).find((x) => x !== null) ?? null;
    case "first":
      return list(ev(0))[0] ?? null;
    case "last":
      return list(ev(0)).at(-1) ?? null;
    // Text
    case "regextest": {
      const [p, s] = [ev(0), ev(1)];
      return typeof s === "string" && regex(p).test(capText(s));
    }
    case "regexmatch": {
      const [p, s] = [ev(0), ev(1)];
      return typeof s === "string" && new RegExp(`^(?:${regex(p).source})$`).test(capText(s));
    }
    case "regexreplace": {
      const [s, p, r] = [ev(0), ev(1), ev(2)];
      return vectorised((x) => (typeof x === "string" ? capText(x).replace(regex(p, "g"), str(r, v)) : null))(s);
    }
    case "replace": {
      const [s, p, r] = [ev(0), ev(1), ev(2)];
      return vectorised((x) => (typeof x === "string" ? x.split(str(p, v)).join(str(r, v)) : null))(s);
    }
    case "lower":
      return vectorised((x) => (typeof x === "string" ? x.toLowerCase() : x))(ev(0));
    case "upper":
      return vectorised((x) => (typeof x === "string" ? x.toUpperCase() : x))(ev(0));
    case "trim":
      return vectorised((x) => (typeof x === "string" ? x.trim() : x))(ev(0));
    case "split": {
      const [s, d, n] = [ev(0), ev(1), ev(2)];
      if (typeof s !== "string") return null;
      const parts = capText(s).split(regex(d));
      return typeof n === "number" ? parts.slice(0, n) : parts;
    }
    case "startswith":
    case "endswith": {
      const [s, p] = [ev(0), ev(1)];
      if (typeof s !== "string" || typeof p !== "string") return false;
      return lname === "startswith" ? s.startsWith(p) : s.endsWith(p);
    }
    case "padleft":
    case "padright": {
      const [s, n, p] = [ev(0), ev(1), ev(2)];
      const t = str(s, v);
      const len = typeof n === "number" ? Math.min(n, 10_000) : 0;
      return lname === "padleft" ? t.padStart(len, typeof p === "string" ? p : " ") : t.padEnd(len, typeof p === "string" ? p : " ");
    }
    case "substring": {
      const [s, a, b] = [ev(0), ev(1), ev(2)];
      return typeof s === "string" ? s.substring(typeof a === "number" ? a : 0, typeof b === "number" ? b : undefined) : null;
    }
    case "truncate": {
      const [s, n, suf] = [ev(0), ev(1), ev(2)];
      if (typeof s !== "string" || typeof n !== "number") return s;
      const tail = typeof suf === "string" ? suf : "...";
      return s.length > n ? s.slice(0, Math.max(0, n - tail.length)) + tail : s;
    }
    // Utility
    case "default": {
      const [x, d] = [ev(0), ev(1)];
      return Array.isArray(x) ? x.map((y) => y ?? d) : (x ?? d);
    }
    case "ldefault": {
      const [x, d] = [ev(0), ev(1)];
      return x ?? d;
    }
    case "choice": {
      // choice(cond, a, b); and, as an extension, choice(c1, a, c2, b, …, otherwise).
      for (let i = 0; i + 1 < argExprs.length; i += 2) if (truthy(ev(i))) return ev(i + 1);
      return argExprs.length % 2 ? ev(argExprs.length - 1) : null;
    }
    case "striptime": {
      const x = ev(0);
      return x instanceof DDate ? new DDate(Math.floor(x.ms / 864e5) * 864e5) : null;
    }
    case "dateformat": {
      const [x, f] = [ev(0), ev(1)];
      return x instanceof DDate && typeof f === "string" ? formatDate(x, f) : null;
    }
    case "durationformat": {
      const [x, f] = [ev(0), ev(1)];
      return x instanceof Dur && typeof f === "string" ? formatDuration(x, f) : null;
    }
    case "localtime":
      return ev(0);
    case "meta": {
      const x = ev(0);
      if (!(x instanceof Link)) return null;
      return { display: x.display, embed: x.embed, path: v.linkPath(x), subpath: x.subpath, type: x.subpath ? (x.subpath.startsWith("^") ? "block" : "header") : "file" };
    }
    case "currencyformat": {
      const [n, c] = [ev(0), ev(1)];
      if (typeof n !== "number") return null;
      try {
        return new Intl.NumberFormat("en-GB", { style: "currency", currency: typeof c === "string" ? c : "GBP" }).format(n);
      } catch {
        return String(n);
      }
    }
    case "display":
      return display(ev(0), v);
    case "hash": {
      const s = args()
        .map((x) => str(x, v))
        .join("\u0000");
      let h = 0x811c9dc5;
      for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
      return h;
    }
  }
  throw new DvError(`there's no function called ${name}`);
}

// ── showing values ────────────────────────────────────────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Luxon's format tokens (yyyy, MM, dd, EEEE, HH, h, mm, a, 'quoted text'…). */
export function formatDate(d: DDate, fmt: string): string {
  const t = d.d;
  const y = t.getUTCFullYear();
  const mo = t.getUTCMonth();
  const day = t.getUTCDate();
  const h = t.getUTCHours();
  const mi = t.getUTCMinutes();
  const s = t.getUTCSeconds();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const tokens: Record<string, () => string> = {
    yyyy: () => String(y),
    yy: () => p2(y % 100),
    y: () => String(y),
    MMMM: () => MONTHS[mo]!,
    MMM: () => MONTHS[mo]!.slice(0, 3),
    MM: () => p2(mo + 1),
    M: () => String(mo + 1),
    LLLL: () => MONTHS[mo]!,
    LLL: () => MONTHS[mo]!.slice(0, 3),
    LL: () => p2(mo + 1),
    L: () => String(mo + 1),
    dd: () => p2(day),
    d: () => String(day),
    EEEE: () => DAYS[t.getUTCDay()]!,
    EEE: () => DAYS[t.getUTCDay()]!.slice(0, 3),
    cccc: () => DAYS[t.getUTCDay()]!,
    ccc: () => DAYS[t.getUTCDay()]!.slice(0, 3),
    HH: () => p2(h),
    H: () => String(h),
    hh: () => p2(h % 12 || 12),
    h: () => String(h % 12 || 12),
    mm: () => p2(mi),
    m: () => String(mi),
    ss: () => p2(s),
    s: () => String(s),
    a: () => (h < 12 ? "AM" : "PM"),
    WW: () => p2(isoWeek(t)),
    W: () => String(isoWeek(t)),
    kkkk: () => String(y),
  };
  const keys = Object.keys(tokens).sort((a, b) => b.length - a.length);
  let out = "";
  for (let i = 0; i < fmt.length; ) {
    if (fmt[i] === "'") {
      const end = fmt.indexOf("'", i + 1);
      out += end < 0 ? fmt.slice(i + 1) : fmt.slice(i + 1, end);
      i = end < 0 ? fmt.length : end + 1;
      continue;
    }
    const k = keys.find((k) => fmt.startsWith(k, i));
    if (k) {
      out += tokens[k]!();
      i += k.length;
    } else out += fmt[i++];
  }
  return out;
}

function parseWithFormat(s: string, fmt: string): DDate | null {
  const parts: Record<string, number> = {};
  const re = fmt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/yyyy|MM|dd|HH|mm|ss|M|d|H/g, (k) => {
    parts[k] = Object.keys(parts).length + 1;
    return k.length === 4 ? "(\\d{4})" : k.length === 2 ? "(\\d{2})" : "(\\d{1,2})";
  });
  const m = new RegExp(`^${re}$`).exec(s.trim());
  if (!m) return null;
  const g = (a: string, b: string, dflt: number) => Number(m[parts[a] ?? parts[b] ?? -1] ?? dflt);
  return new DDate(Date.UTC(g("yyyy", "yyyy", 1970), g("MM", "M", 1) - 1, g("dd", "d", 1), g("HH", "H", 0), g("mm", "mm", 0), g("ss", "ss", 0)));
}

/** A duration split into years, months, weeks, days… by the casual rules, zeros left out. */
function shiftAll(ms: number): Partial<Record<Unit, number>> {
  const out: Partial<Record<Unit, number>> = {};
  let rest = Math.abs(ms);
  const sign = ms < 0 ? -1 : 1;
  for (const u of UNITS) {
    const n = Math.floor(rest / UNIT_MS[u]);
    if (n) out[u] = n * sign;
    rest -= n * UNIT_MS[u];
  }
  return out;
}

function humanDuration(d: Dur): string {
  const named = Object.entries(d.parts).filter(([, v]) => v);
  // As written ("7 days") when it was written; split up when it was worked out.
  const parts = named.length && !("milliseconds" in d.parts) ? d.parts : shiftAll(d.ms);
  const text = UNITS.filter((u) => parts[u])
    .map((u) => `${parts[u]} ${Math.abs(parts[u]!) === 1 ? u.slice(0, -1) : u}`)
    .join(", ");
  return text || "0 seconds";
}

function formatDuration(d: Dur, fmt: string): string {
  const all = shiftAll(d.ms);
  const map: Record<string, number> = { y: all.years ?? 0, M: all.months ?? 0, w: all.weeks ?? 0, d: all.days ?? 0, h: all.hours ?? 0, m: all.minutes ?? 0, s: all.seconds ?? 0, S: all.milliseconds ?? 0 };
  return fmt.replace(/'([^']*)'|([yMwdhmsS])\2*/g, (t, lit, k) => (lit !== undefined ? lit : String(map[k] ?? 0).padStart(t.length, "0")));
}

/** A value as text, the way Dataview shows it. */
export function display(v: Value, vault: Vault): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof DDate) return formatDate(v, v.hasTime ? "h:mm a - MMMM dd, yyyy" : "MMMM dd, yyyy");
  if (v instanceof Dur) return humanDuration(v);
  if (v instanceof Link) {
    const p = vault.linkPath(v).replace(/\.md$/i, "");
    return `${v.embed ? "!" : ""}[[${p}${v.subpath ? "#" + v.subpath : ""}${v.display ? "|" + v.display : ""}]]`;
  }
  if (Array.isArray(v)) return v.map((x) => display(x, vault)).join(", ");
  if (isFn(v)) return "<function>";
  if ("__elink" in v) return String(v.__elink);
  if ("file" in v && isObj(v.file) && (v.file as any).link instanceof Link) return display((v.file as any).link, vault);
  return "{ " + Object.entries(v).map(([k, x]) => `${k}: ${display(x, vault)}`).join(", ") + " }";
}

// ── results: plain data, for the browser and for published pages ─────────────────────────

export type Out =
  | null
  | boolean
  | number
  | string
  | { t: "link"; path: string; display: string; embed: boolean; subpath: string | null; resolved: boolean }
  | { t: "elink"; url: string; display: string }
  | { t: "date"; text: string }
  | { t: "dur"; text: string }
  | { t: "list"; items: Out[] }
  | { t: "obj"; entries: [string, Out][] };

export interface TaskOut {
  path: string;
  line: number;
  text: string;
  status: string | null;
  children: TaskOut[];
}

export interface ListOut {
  value: Out;
  /** The page or group it's for, unless WITHOUT ID. */
  id?: Out;
  children?: ListOut[];
}

export type Result =
  | { kind: "table"; idHeader: string | null; headers: string[]; rows: Out[][]; total: number }
  | { kind: "list"; items: ListOut[]; total: number }
  | { kind: "task"; groups: { key: Out; tasks: TaskOut[] }[]; total: number; shown: number }
  | { kind: "calendar"; days: { day: string; value: Out }[]; total: number; today: string }
  | { kind: "value"; value: Out }
  | { kind: "error"; message: string };

/** At most this many rows are sent; the count still says how many there were. */
export const MAX_ROWS = 2000;

function out(v: Value, vault: Vault, depth = 0): Out {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return Number.isNaN(v) ? null : v;
  if (v instanceof Link) {
    const resolved = vault.resolve(v.target);
    const name = titleFromPath(resolved ?? v.target);
    return { t: "link", path: (resolved ?? v.target).replace(/\.md$/i, ""), display: v.display ?? (v.subpath && !v.subpath.startsWith("^") ? `${name} > ${v.subpath}` : name), embed: v.embed, subpath: v.subpath, resolved: !!resolved };
  }
  if (v instanceof DDate || v instanceof Dur) return { t: v instanceof DDate ? "date" : "dur", text: display(v, vault) };
  if (Array.isArray(v)) return { t: "list", items: depth > 4 ? [] : v.slice(0, 500).map((x) => out(x, vault, depth + 1)) };
  if (isFn(v)) return "<function>";
  if ("__elink" in v) return { t: "elink", url: String(v.__elink), display: String(v.display ?? v.__elink) };
  if ("file" in v && isObj(v.file) && (v.file as any).link instanceof Link) return out((v.file as any).link, vault);
  return { t: "obj", entries: depth > 4 ? [] : Object.entries(v).slice(0, 100).map(([k, x]) => [k, out(x, vault, depth + 1)]) };
}

interface RunOpts {
  /** The note the query is in (its path), for `this` and [[]]. */
  thisPath: string | null;
  /** Minutes east of UTC: the reader's time zone, if `tz` (its IANA name) isn't given or known. */
  offset: number;
  tz?: string;
  now?: number;
}

function ctxFor(vault: Vault, o: RunOpts): Ctx {
  return { vault, offset: o.offset, tz: o.tz, now: o.now ?? Date.now(), thisObj: o.thisPath ? vault.object(o.thisPath, o.offset, o.tz) : null, thisPath: o.thisPath, steps: 0 };
}

/** Run a ```dataview block. Errors come back as a result, never thrown. */
export function runQuery(src: string, vault: Vault, o: RunOpts): Result {
  try {
    const q = parseQuery(src, o.offset);
    return execute(q, vault, ctxFor(vault, o));
  } catch (e) {
    if (e instanceof DvError) return { kind: "error", message: e.message };
    if (e instanceof RangeError) return { kind: "error", message: "this query is too big to run" };
    throw e;
  }
}

/** Is this inline code a query: `= expression`, or `$= dv.pages(…)…` in the form we translate? */
export function inlineQuery(code: string): string | null {
  const m = /^(\$?)=\s*([\s\S]+)$/.exec(code.trim());
  if (!m) return null;
  if (m[1] && !/^dv\.pages\(/.test(m[2]!.trim())) return null;
  try {
    parseExpression(m[2]!);
    return m[2]!;
  } catch {
    // `= ` that isn't an expression stays as code; so does JavaScript we can't read.
    return m[1] ? null : m[2]!;
  }
}

/** Evaluate an inline `= expression` on its note. */
export function runInline(expr: string, vault: Vault, o: RunOpts): Result {
  try {
    const e = parseExpression(expr, o.offset);
    const ctx = ctxFor(vault, o);
    return { kind: "value", value: out(evaluate(e, ctx.thisObj ?? {}, null, ctx), vault) };
  } catch (e) {
    if (e instanceof DvError) return { kind: "error", message: e.message };
    if (e instanceof RangeError) return { kind: "error", message: "this expression is too big to run" };
    throw e;
  }
}

type Row = Record<string, Value>;

function execute(q: Query, vault: Vault, ctx: Ctx): Result {
  const pages = vault.select(q.source, ctx.thisPath);
  let rows: Row[] = [];
  if (q.kind === "task") {
    for (const p of pages) for (const t of (vault.object(p, ctx.offset, ctx.tz)!.file as any).tasks as Row[]) rows.push(t);
  } else rows = pages.map((p) => vault.object(p, ctx.offset, ctx.tz)!);
  let grouped: string | null = null;
  for (const c of q.clauses) {
    switch (c.k) {
      case "where":
        rows = rows.filter((r) => truthy(evaluate(c.e, r, null, ctx)));
        break;
      case "sort": {
        const keyed = rows.map((r) => ({ r, ks: c.keys.map((k) => evaluate(k.e, r, null, ctx)) }));
        keyed.sort((a, b) => {
          for (let i = 0; i < c.keys.length; i++) {
            const d = compare(a.ks[i]!, b.ks[i]!, vault);
            if (d) return c.keys[i]!.desc ? -d : d;
          }
          return 0;
        });
        rows = keyed.map((x) => x.r);
        break;
      }
      case "group": {
        const groups: { key: Value; rows: Row[] }[] = [];
        for (const r of rows) {
          const key = evaluate(c.e, r, null, ctx);
          let g = groups.find((x) => compare(x.key, key, vault) === 0);
          if (!g) groups.push((g = { key, rows: [] }));
          g.rows.push(r);
        }
        groups.sort((a, b) => compare(a.key, b.key, vault));
        rows = groups.map((g) => ({ key: g.key, rows: g.rows, [c.name]: g.key }));
        grouped = c.name;
        break;
      }
      case "flatten": {
        const next: Row[] = [];
        for (const r of rows) {
          const v = evaluate(c.e, r, null, ctx);
          for (const x of Array.isArray(v) ? (v.length ? v : [null]) : [v]) {
            const copy: Row = Object.assign(Object.create(Object.getPrototypeOf(r)), r);
            copy[c.name] = x;
            next.push(copy);
          }
        }
        rows = next;
        break;
      }
      case "limit": {
        const n = evaluate(c.e, {}, null, ctx);
        if (typeof n !== "number") throw new DvError("LIMIT needs a number");
        rows = rows.slice(0, Math.max(0, n));
        break;
      }
    }
  }
  const total = rows.length;
  const shown = rows.slice(0, MAX_ROWS);
  const idOf = (r: Row): Out => (grouped !== null ? out(r.key ?? null, vault) : out((r.file as any)?.link ?? null, vault));

  if (q.kind === "calendar") {
    // Each row on the day its date falls (rows without a date are left out), in date order.
    const f = q.fields[0];
    if (!f) throw new DvError("CALENDAR needs a date to place each note by, such as CALENDAR file.cday");
    const days: { day: string; ms: number; value: Out }[] = [];
    for (const r of rows) {
      const d = evaluate(f.e, r, null, ctx);
      for (const x of Array.isArray(d) ? d : [d]) if (x instanceof DDate) days.push({ day: formatDate(x, "yyyy-MM-dd"), ms: x.ms, value: idOf(r) });
    }
    days.sort((a, b) => a.ms - b.ms);
    const today = formatDate(new DDate(Math.floor(toWall(ctx.now, ctx.offset, ctx.tz) / 864e5) * 864e5), "yyyy-MM-dd");
    return { kind: "calendar", days: days.slice(0, MAX_ROWS * 5).map(({ day, value }) => ({ day, value })), total: days.length, today };
  }
  if (q.kind === "table") {
    return {
      kind: "table",
      idHeader: q.withoutId ? null : (grouped ?? "File"),
      headers: q.fields.map((f) => f.name),
      rows: shown.map((r) => [...(q.withoutId ? [] : [idOf(r)]), ...q.fields.map((f) => out(evaluate(f.e, r, null, ctx), vault))]),
      total,
    };
  }
  if (q.kind === "list") {
    const f = q.fields[0];
    if (grouped !== null) {
      return {
        kind: "list",
        items: shown.map((g) => ({
          value: out(g.key ?? null, vault),
          children: (g.rows as Row[]).map((r) => ({ value: f ? out(evaluate(f.e, r, null, ctx), vault) : out((r.file as any)?.link ?? null, vault) })),
        })),
        total,
      };
    }
    return {
      kind: "list",
      items: shown.map((r) => {
        if (!f) return { value: idOf(r) };
        const value = out(evaluate(f.e, r, null, ctx), vault);
        return q.withoutId ? { value } : { id: idOf(r), value };
      }),
      total,
    };
  }
  // TASK: the tasks that matched, each with what's under it, grouped by note (or GROUP BY).
  const tree = (t: Row): TaskOut => ({
    path: t.path as string,
    line: t.line as number,
    text: t.text as string,
    status: (t.status as string | null) ?? null,
    children: ((t.children as Row[]) ?? []).map(tree),
  });
  const tops = (ts: Row[]) => {
    const picked = new Set(ts.map((t) => `${t.path}:${t.line}`));
    const lines = new Map<string, Row>();
    for (const t of ts) lines.set(`${t.path}:${t.line}`, t);
    return ts.filter((t) => {
      // Shown under its parent instead, when its parent matched too.
      for (let p = t.parent as number | null; p !== null; ) {
        if (picked.has(`${t.path}:${p}`)) return false;
        const up = ((vault.object(t.path as string, ctx.offset, ctx.tz)!.file as any).lists as Row[]).find((x) => x.line === p);
        p = (up?.parent as number | null) ?? null;
      }
      return true;
    });
  };
  if (grouped !== null) {
    return { kind: "task", groups: shown.map((g) => ({ key: out(g.key ?? null, vault), tasks: tops(g.rows as Row[]).map(tree) })), total, shown: shown.length };
  }
  const byFile = new Map<string, Row[]>();
  for (const t of shown) {
    const k = t.path as string;
    if (!byFile.has(k)) byFile.set(k, []);
    byFile.get(k)!.push(t);
  }
  return {
    kind: "task",
    groups: [...byFile].map(([path, ts]) => ({ key: out(new Link(path.replace(/\.md$/i, "")), vault), tasks: tops(ts).map(tree) })),
    total,
    shown: shown.length,
  };
}

// ── for dataviewjs (web/sandbox/dvjs.ts): the same pages, values and functions ────────────

/** The pages a source names ("" for all), as page objects. */
export function pagesFor(src: string, vault: Vault, thisPath: string | null, offset: number, tz?: string): Record<string, Value>[] {
  return pagesFrom(src, ctxFor(vault, { thisPath, offset, tz })) as Record<string, Value>[];
}

/** Call one of the query language's functions on values (dv.func.*). */
export function callFunction(name: string, args: Value[], vault: Vault, thisPath: string | null, offset: number, tz?: string): Value {
  const ctx = ctxFor(vault, { thisPath, offset, tz });
  return callFn(name, args.map((v) => ({ k: "lit", v }) as Expr), ctx.thisObj ?? {}, null, ctx);
}

export const parseInlineValue = (raw: string, offset: number): Value => inlineValue(raw, offset);
export const toOut = (v: Value, vault: Vault): Out => out(v, vault);
