// Runs inside the dataviewjs sandbox (src/sandbox.ts): a frame with no network, no cookies and
// no way into the app, which the note's script runs in. The app sends the vault's pages (what any
// member can read) and the code; this builds Dataview's `dv` API on the shared query engine
// (src/dataview.ts), runs the code, and draws into the frame. Everything that reaches the app goes
// through postMessage and is checked there (web/lib/dataviewjs.ts): open a note, tick a task,
// read a file, open a web link, and the frame's height.

import DOMPurify from "dompurify";
import * as luxon from "luxon";
import { DateTime, Duration } from "luxon";
import { Marked } from "marked";
import {
  callFunction,
  compare as ecompare,
  DDate,
  Dur,
  Link as ELink,
  type Out,
  type PageData,
  pagesFor,
  parseInlineValue,
  type Result,
  runInline,
  runQuery,
  toOut,
  type Value,
  Vault,
} from "../../src/dataview";
import { type CalendarState, calendarStart, esc, renderResult, renderValue, type RenderOpts } from "../../src/dataviewRender";
import { GUARD, guardLoops } from "./loopGuard";

// ── the run ───────────────────────────────────────────────────────────────────────────────

let vault = new Vault([]);
let offset = 0;
let tz: string | undefined;
let thisPath: string | null = null;
/** Drawing for a published page (Publish freezes what the script draws): no ticking, no buttons. */
let capture = false;
const root = document.getElementById("root")!;
const post = (msg: Record<string, unknown>) => parent.postMessage({ dvjs: 1, ...msg }, "*");

// ── values: Dataview's Link, Luxon dates and durations, DataArray ────────────────────────

export class Link {
  constructor(
    public path: string,
    public display: string | undefined,
    public embed: boolean,
    public subpath: string | undefined,
    public type: "file" | "header" | "block",
  ) {}
  static file(path: string, embed = false, display?: string) {
    return new Link(path, display, embed, undefined, "file");
  }
  withDisplay(display?: string) {
    return new Link(this.path, display, this.embed, this.subpath, this.type);
  }
  toEmbed() {
    return new Link(this.path, this.display, true, this.subpath, this.type);
  }
  fromEmbed() {
    return new Link(this.path, this.display, false, this.subpath, this.type);
  }
  equals(o: Link) {
    return o instanceof Link && o.path === this.path && o.subpath === this.subpath;
  }
  wikiTarget() {
    return this.path.replace(/\.md$/i, "") + (this.subpath ? `#${this.subpath}` : "");
  }
  markdown() {
    return `${this.embed ? "!" : ""}[[${this.wikiTarget()}${this.display ? `|${this.display}` : ""}]]`;
  }
  fileName() {
    return this.path.split("/").pop()!.replace(/\.md$/i, "");
  }
  toString() {
    return this.markdown();
  }
}

const converted = new WeakMap<object, unknown>();

/** An engine value as dataviewjs sees it. */
function toJs(v: Value): any {
  if (v === null || v === undefined || typeof v !== "object") return v ?? null;
  if (v instanceof ELink) {
    const path = vault.resolve(v.target) ?? v.target;
    return new Link(path, v.display ?? undefined, v.embed, v.subpath ?? undefined, v.subpath ? (v.subpath.startsWith("^") ? "block" : "header") : "file");
  }
  if (v instanceof DDate) {
    // A wall-clock time, read as the same time here (so summer time can't move it).
    const d = v.d;
    return DateTime.fromObject({ year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes(), second: d.getUTCSeconds(), millisecond: d.getUTCMilliseconds() });
  }
  if (v instanceof Dur) return Duration.fromObject(v.parts);
  if (converted.has(v)) return converted.get(v);
  if (Array.isArray(v)) {
    const out: any[] = [];
    const a = arr(out);
    converted.set(v, a);
    for (const x of v) out.push(toJs(x));
    return a;
  }
  if ("params" in v && "body" in v) return null;
  const o: Record<string, any> = {};
  converted.set(v, o);
  // Own fields only: a task's fall-back to its page's fields is the query language's, not Dataview JS's.
  for (const k of Object.keys(v)) o[k] = toJs((v as any)[k]);
  return o;
}

/** A dataviewjs value as the engine sees it. */
function fromJs(v: any, depth = 0): Value {
  if (v === null || v === undefined) return null;
  if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Link) return new ELink(v.path.replace(/\.md$/i, ""), v.display ?? null, v.embed, v.subpath ?? null);
  if (DateTime.isDateTime(v)) return new DDate(v.toMillis() + v.offset * 6e4);
  if (Duration.isDuration(v)) return new Dur(v.toObject() as any);
  if (v instanceof Date) return new DDate(v.getTime() - v.getTimezoneOffset() * 6e4);
  if (depth > 20) return null;
  if (isDataArray(v)) return v.values.map((x: any) => fromJs(x, depth + 1));
  if (Array.isArray(v)) return v.map((x) => fromJs(x, depth + 1));
  if (typeof v === "function" || v instanceof Node) return null;
  const o: Record<string, Value> = {};
  for (const k of Object.keys(v)) o[k] = fromJs(v[k], depth + 1);
  return o;
}

const compare = (a: any, b: any) => ecompare(fromJs(a), fromJs(b), vault);

const IS_DA = Symbol("dataArray");
const isDataArray = (v: any): v is DataArrayImpl => !!v && typeof v === "object" && v[IS_DA] === true;
const toArray = (v: any): any[] => (isDataArray(v) ? v.values : Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]);
const keyFn = (k: any): ((x: any) => any) => (typeof k === "function" ? k : typeof k === "string" ? (x: any) => x?.[k] : (x: any) => x);

class DataArrayImpl {
  [IS_DA] = true;
  constructor(readonly values: any[]) {}
  get length() {
    return this.values.length;
  }
  where(p: (v: any, i: number, a: any) => unknown) {
    return arr(this.values.filter((v, i) => p(v, i, this)));
  }
  filter(p: (v: any, i: number, a: any) => unknown) {
    return this.where(p);
  }
  map(f: (v: any, i: number, a: any) => any) {
    return arr(this.values.map((v, i) => f(v, i, this)));
  }
  flatMap(f: (v: any, i: number, a: any) => any) {
    return arr(this.values.flatMap((v, i) => toArray(f(v, i, this))));
  }
  mutate(f: (v: any, i: number, a: any) => void) {
    this.values.forEach((v, i) => f(v, i, this));
    return this;
  }
  limit(n: number) {
    return arr(this.values.slice(0, n));
  }
  slice(s?: number, e?: number) {
    return arr(this.values.slice(s, e));
  }
  concat(o: any) {
    return arr([...this.values, ...toArray(o)]);
  }
  indexOf(v: any, from?: number) {
    return this.values.findIndex((x, i) => i >= (from ?? 0) && compare(x, v) === 0);
  }
  find(p: (v: any, i: number, a: any) => unknown) {
    return this.values.find((v, i) => p(v, i, this));
  }
  findIndex(p: (v: any, i: number, a: any) => unknown) {
    return this.values.findIndex((v, i) => p(v, i, this));
  }
  includes(v: any) {
    return this.indexOf(v) >= 0;
  }
  join(sep = ", ") {
    return this.values.map(text).join(sep);
  }
  sort(key?: any, direction: "asc" | "desc" = "asc", comparator?: (a: any, b: any) => number) {
    const k = keyFn(key);
    const cmp = comparator ?? compare;
    const sign = direction === "desc" ? -1 : 1;
    return arr([...this.values].map((v) => ({ v, k: k(v) })).sort((a, b) => sign * cmp(a.k, b.k)).map((x) => x.v));
  }
  sortInPlace(key?: any, direction: "asc" | "desc" = "asc", comparator?: (a: any, b: any) => number) {
    const sorted = this.sort(key, direction, comparator).values;
    this.values.splice(0, this.values.length, ...sorted);
    return this;
  }
  groupBy(key: any, comparator?: (a: any, b: any) => number) {
    const k = keyFn(key);
    const cmp = comparator ?? compare;
    const groups: { key: any; rows: any[] }[] = [];
    for (const v of this.values) {
      const kv = k(v);
      const g = groups.find((x) => cmp(x.key, kv) === 0);
      if (g) g.rows.push(v);
      else groups.push({ key: kv, rows: [v] });
    }
    return arr(groups.sort((a, b) => cmp(a.key, b.key)).map((g) => ({ key: g.key, rows: arr(g.rows) })));
  }
  groupIn(key: any, comparator?: (a: any, b: any) => number) {
    return this.groupBy(key, comparator);
  }
  distinct(key?: any, comparator?: (a: any, b: any) => number) {
    const k = keyFn(key);
    const cmp = comparator ?? compare;
    const out: any[] = [];
    const keys: any[] = [];
    for (const v of this.values) {
      const kv = k(v);
      if (!keys.some((x) => cmp(x, kv) === 0)) (keys.push(kv), out.push(v));
    }
    return arr(out);
  }
  every(p: (v: any) => unknown) {
    return this.values.every((v) => p(v));
  }
  some(p: (v: any) => unknown) {
    return this.values.some((v) => p(v));
  }
  none(p: (v: any) => unknown) {
    return !this.values.some((v) => p(v));
  }
  first() {
    return this.values[0];
  }
  last() {
    return this.values.at(-1);
  }
  /** Each element's field, flattened: `pages.file.name`. */
  to(key: string) {
    const out: any[] = [];
    for (const v of this.values) {
      const f = v?.[key];
      if (f === undefined) continue;
      if (isDataArray(f) || Array.isArray(f)) out.push(...toArray(f));
      else out.push(f);
    }
    return arr(out);
  }
  into(key: string) {
    return this.to(key);
  }
  expand(key: string) {
    const out: any[] = [];
    const walk = (v: any) => {
      out.push(v);
      for (const c of toArray(v?.[key])) walk(c);
    };
    this.values.forEach(walk);
    return arr(out);
  }
  forEach(f: (v: any, i: number, a: any) => void) {
    this.values.forEach((v, i) => f(v, i, this));
  }
  array() {
    return [...this.values];
  }
  [Symbol.iterator]() {
    return this.values[Symbol.iterator]();
  }
  sum() {
    return this.values.reduce((a, b) => a + (typeof b === "number" ? b : 0), 0);
  }
  avg() {
    const n = this.values.filter((v) => typeof v === "number");
    return n.length ? n.reduce((a, b) => a + b, 0) / n.length : null;
  }
  min() {
    return this.values.length ? this.values.reduce((a, b) => (compare(b, a) < 0 ? b : a)) : null;
  }
  max() {
    return this.values.length ? this.values.reduce((a, b) => (compare(b, a) > 0 ? b : a)) : null;
  }
  toString() {
    return this.join(", ");
  }
}

/** A DataArray: its methods, `pages[0]`, and any other name reads that field from each element. */
function arr(values: any[]): any {
  return new Proxy(new DataArrayImpl(values), {
    get(t, p, r) {
      if (typeof p === "symbol" || p in t) {
        const v = Reflect.get(t, p, t);
        return typeof v === "function" ? v.bind(r) : v;
      }
      if (/^\d+$/.test(p)) return t.values[Number(p)];
      return t.to(p);
    },
    has: (t, p) => p in t || (typeof p === "string" && /^\d+$/.test(p) && Number(p) < t.values.length),
  });
}

// ── drawing ───────────────────────────────────────────────────────────────────────────────

const marked = new Marked({ gfm: true, breaks: false });
marked.use({
  extensions: [
    {
      name: "wikilink",
      level: "inline",
      start: (src: string) => src.match(/!?\[\[/)?.index,
      tokenizer(src: string) {
        const m = /^(!?)\[\[([^\[\]|\n]+?)(?:\\?\|([^\[\]\n]*))?\]\]/.exec(src);
        if (m) return { type: "wikilink", raw: m[0], target: m[2]!.trim(), alias: m[3]?.trim() };
      },
      renderer(t: any) {
        const resolved = vault.resolve(t.target.split("#")[0]);
        return `<a class="internal-link${resolved ? "" : " unresolved"}" data-dv-open="${esc(t.target)}" href="#">${esc(t.alias || t.target)}</a>`;
      },
    },
  ],
});
const clean = (html: string) => DOMPurify.sanitize(html, { ADD_ATTR: ["data-dv-open", "data-dv-day", "data-dv-month", "data-path", "data-line", "data-text"], FORBID_TAGS: ["form", "iframe", "object", "embed"] });
const mdInline = (s: string) => clean(marked.parseInline(s, { async: false }) as string);
const mdBlock = (s: string) => clean(marked.parse(s, { async: false }) as string);

const opts = (calendar?: CalendarState): RenderOpts => ({
  canTick: !capture,
  calendar: capture ? "all" : calendar,
  inline: mdInline,
  link: (path, display, resolved, subpath) => `<a class="internal-link${resolved ? "" : " unresolved"}" data-dv-open="${esc(path + (subpath ? `#${subpath}` : ""))}" href="#">${esc(display)}</a>`,
});

const outOf = (v: any): Out => toOut(fromJs(v), vault);
/** A value as HTML, the way Dataview shows it. */
const show = (v: any): string => (v instanceof Node ? (v as Element).outerHTML ?? esc(v.textContent ?? "") : renderValue(outOf(v), opts()));
/** A value as text: links as their markdown, dates in Dataview's format. */
function text(v: any): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "string") return v;
  if (v instanceof Link) return v.markdown();
  const o = outOf(v);
  if (o === null) return "null";
  if (typeof o !== "object") return String(o);
  if (o.t === "date" || o.t === "dur") return o.text;
  if (o.t === "list") return toArray(v).map(text).join(", ");
  return String(v);
}

function el(tag: string, html: string, o: { cls?: string | string[]; attr?: Record<string, string>; container?: HTMLElement } = {}): HTMLElement {
  const e = document.createElement(/^[a-z][a-z0-9-]*$/i.test(tag) ? tag : "div");
  if (o.cls) e.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
  for (const [k, v] of Object.entries(o.attr ?? {})) if (!/^on/i.test(k)) e.setAttribute(k, v);
  e.innerHTML = html;
  (o.container ?? root).append(e);
  return e;
}

// Calendars from dv.execute keep their month and day here, as in the app.
const calendars = new WeakMap<HTMLElement, { r: Extract<Result, { kind: "calendar" }>; s: CalendarState }>();
function drawResult(r: Result, container: HTMLElement) {
  const box = el("div", "", { cls: "dataview-block", container });
  if (r.kind === "calendar" && !capture) {
    const s = calendarStart(r);
    calendars.set(box, { r, s });
    box.innerHTML = clean(renderResult(r, opts(s)));
  } else box.innerHTML = clean(renderResult(r, opts()));
}

function tasksOut(tasks: any[]): any[] {
  const keys = new Set(tasks.map((t) => `${t.path}:${t.line}`));
  const tree = (t: any): any => ({ path: t.path, line: t.line, text: t.text ?? "", status: t.status ?? null, children: toArray(t.children).map(tree) });
  return tasks.filter((t) => t.parent === null || t.parent === undefined || !keys.has(`${t.path}:${t.parent}`)).map(tree);
}

// ── the dv API ────────────────────────────────────────────────────────────────────────────

let loads = 0;
const waiting = new Map<number, { ok: (s: string) => void; fail: (e: Error) => void }>();
/** A note's or file's text, from the app (only what this reader can read). */
function load(path: string): Promise<string> {
  const id = ++loads;
  return new Promise((ok, fail) => {
    waiting.set(id, { ok, fail });
    post({ type: "load", id, path: String(path) });
  });
}

function parseCsv(textIn: string): any {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < textIn.length; i++) {
    const c = textIn[i]!;
    if (quoted) {
      if (c === '"' && textIn[i + 1] === '"') (cell += '"'), i++;
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (row.push(cell), (cell = ""));
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && textIn[i + 1] === "\n") i++;
      row.push(cell);
      rows.push(row);
      (row = []), (cell = "");
    } else cell += c;
  }
  if (cell || row.length) (row.push(cell), rows.push(row));
  const [head, ...body] = rows.filter((r) => r.some((c) => c.trim()));
  if (!head) return arr([]);
  return arr(body.map((r) => Object.fromEntries(head.map((h, i) => [h, toJs(parseInlineValue(r[i] ?? "", offset))]))));
}

function outToJs(o: Out): any {
  if (o === null || typeof o !== "object") return o;
  switch (o.t) {
    case "link":
      return new Link(vault.resolve(o.path) ?? o.path, o.display, o.embed, o.subpath ?? undefined, o.subpath ? (o.subpath.startsWith("^") ? "block" : "header") : "file");
    case "elink":
      return o.url;
    case "date":
    case "dur":
      return o.text;
    case "list":
      return arr(o.items.map(outToJs));
    case "obj":
      return Object.fromEntries(o.entries.map(([k, v]) => [k, outToJs(v)]));
  }
}

function resultValue(r: Result): any {
  switch (r.kind) {
    case "table":
      return { type: "table", headers: r.idHeader === null ? r.headers : [r.idHeader, ...r.headers], values: arr(r.rows.map((row) => arr(row.map(outToJs)))), idMeaning: { type: "path" } };
    case "list":
      return { type: "list", values: arr(r.items.map((i) => (i.id !== undefined ? arr([outToJs(i.id), outToJs(i.value)]) : outToJs(i.value)))) };
    case "task":
      return { type: "task", values: arr(r.groups.flatMap((g) => g.tasks)) };
    case "calendar":
      return { type: "calendar", values: arr(r.days.map((d) => ({ date: DateTime.fromISO(d.day), link: outToJs(d.value) }))) };
    case "value":
      return outToJs(r.value);
    case "error":
      return null;
  }
}

function markdownTable(headers: any[], rows: any[]): string {
  const cell = (v: any) => text(v).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const hs = toArray(headers).map(cell);
  return [`| ${hs.join(" | ")} |`, `| ${hs.map(() => "---").join(" | ")} |`, ...toArray(rows).map((r) => `| ${toArray(r).map(cell).join(" | ")} |`)].join("\n") + "\n";
}

// The loop guard (./loopGuard.ts): a script that holds the thread this long without a break is
// stopped, rather than freezing the page. A timer marks each moment the thread is free.
const LIMIT_MS = 5000;
let freeAt = performance.now();
let stopped = false;
setInterval(() => (freeAt = performance.now()), 250);
function guard() {
  if (stopped || performance.now() - freeAt > LIMIT_MS) {
    stopped = true;
    throw new Error(`This script ran for over ${LIMIT_MS / 1000} seconds without a break, so it was stopped. Is there a loop that never ends?`);
  }
}

async function runCode(code: string, input: unknown, container: HTMLElement): Promise<void> {
  const dv = makeDv(container);
  // As Dataview runs it: the block's text as an async function body, given dv and input.
  const fn = new Function("dv", "input", "luxon", "app", "moment", GUARD, `"use strict";\nreturn (async () => {\n${guardLoops(code)}\n})();`);
  await fn(dv, input, luxon, undefined, undefined, guard);
}

function makeDv(container: HTMLElement) {
  const page = (p: string) => {
    const path = vault.resolve(String(p).replace(/\.md$/i, "")) ?? String(p);
    const o = vault.object(path, offset, tz);
    return o ? toJs(o) : undefined;
  };
  const dv: Record<string, any> = {
    container,
    luxon,
    settings: { renderNullAs: "\\-", taskCompletionTracking: false, defaultDateFormat: "MMMM dd, yyyy", defaultDateTimeFormat: "h:mm a - MMMM dd, yyyy" },
    component: { register() {}, registerEvent() {}, addChild() {} },
    current: () => (thisPath ? page(thisPath) : undefined),
    page,
    pages: (src = "") => arr(pagesFor(String(src), vault, thisPath, offset, tz).map(toJs)),
    pagePaths: (src = "") => arr(pagesFor(String(src), vault, thisPath, offset, tz).map((p) => (p.file as any).path)),
    array: (v: any) => (isDataArray(v) ? v : arr(Array.isArray(v) ? v : [v])),
    isArray: (v: any) => isDataArray(v) || Array.isArray(v),
    fileLink: (path: string, embed = false, display?: string) => new Link(path, display, embed, undefined, "file"),
    sectionLink: (path: string, section: string, embed = false, display?: string) => new Link(path, display, embed, section, "header"),
    blockLink: (path: string, block: string, embed = false, display?: string) => new Link(path, display, embed, block, "block"),
    date: (v: any) => {
      if (DateTime.isDateTime(v)) return v;
      if (v instanceof Link) return page(v.path)?.file?.day ?? null;
      return toJs(callFunction("date", [fromJs(v)], vault, thisPath, offset, tz));
    },
    duration: (v: any) => (Duration.isDuration(v) ? v : toJs(callFunction("dur", [fromJs(v)], vault, thisPath, offset, tz))),
    compare,
    equal: (a: any, b: any) => compare(a, b) === 0,
    clone: (v: any) => toJs(fromJs(v)),
    parse: (v: string) => toJs(parseInlineValue(String(v), offset)),
    func: new Proxy({}, { get: (_t, name: string) => (...args: any[]) => toJs(callFunction(name, args.map((a) => fromJs(a)), vault, thisPath, offset, tz)) }),
    // Drawing
    el: (tag: string, value: any, o?: { cls?: string | string[]; attr?: Record<string, string>; container?: HTMLElement }) => el(tag, typeof value === "string" ? mdInline(value) : show(value), { container, ...o }),
    header: (level: number, value: any) => el(`h${Math.min(6, Math.max(1, Number(level) || 1))}`, typeof value === "string" ? mdInline(value) : show(value), { container }),
    paragraph: (value: any) => el("div", typeof value === "string" ? mdBlock(value) : `<p>${show(value)}</p>`, { container }),
    span: (value: any) => el("span", typeof value === "string" ? mdInline(value) : show(value), { container }),
    list: (values: any) => el("ul", toArray(values).map((v) => `<li>${show(v)}</li>`).join(""), { cls: "dv-result-list", container }),
    table: (headers: any, rows: any) => {
      const hs = toArray(headers).map((h) => `<th>${typeof h === "string" ? mdInline(h) : show(h)}</th>`).join("");
      const body = toArray(rows).map((r) => `<tr>${toArray(r).map((c) => `<td>${show(c)}</td>`).join("")}</tr>`).join("");
      return el("div", `<table><thead><tr>${hs}</tr></thead><tbody>${body}</tbody></table>`, { cls: "dv-table", container });
    },
    taskList: (tasks: any, groupByFile = true) => {
      const ts = toArray(tasks);
      const groups: { key: Out; tasks: any[] }[] = [];
      if (groupByFile) {
        const by = new Map<string, any[]>();
        for (const t of ts) by.set(t.path, [...(by.get(t.path) ?? []), t]);
        for (const [path, list] of by) groups.push({ key: toOut(new ELink(path.replace(/\.md$/i, "")), vault), tasks: tasksOut(list) });
      } else groups.push({ key: null, tasks: tasksOut(ts) });
      const html = groupByFile
        ? renderResult({ kind: "task", groups, total: ts.length, shown: ts.length }, opts())
        : renderResult({ kind: "task", groups, total: ts.length, shown: ts.length }, opts()).replace(/<div class="dv-group-head">[\s\S]*?<\/div>/, "");
      return el("div", html, { container });
    },
    markdownTable,
    markdownList: (values: any) => toArray(values).map((v) => `- ${text(v)}`).join("\n") + "\n",
    markdownTaskList: (tasks: any) => toArray(tasks).map((t) => `- [${t.status ?? " "}] ${t.text}`).join("\n") + "\n",
    // Queries in the query language, over the same pages
    execute: (source: string) => drawResult(runQuery(String(source), vault, { thisPath, offset, tz }), container),
    executeJs: (code: string) => runCode(String(code), undefined, container).catch((e) => showError(e, container)),
    query: async (source: string) => {
      const r = runQuery(String(source), vault, { thisPath, offset, tz });
      return r.kind === "error" ? { successful: false, error: r.message } : { successful: true, value: resultValue(r) };
    },
    tryQuery: async (source: string) => {
      const r = runQuery(String(source), vault, { thisPath, offset, tz });
      if (r.kind === "error") throw new Error(r.message);
      return resultValue(r);
    },
    queryMarkdown: async (source: string) => {
      const r = runQuery(String(source), vault, { thisPath, offset, tz });
      if (r.kind === "error") return { successful: false, error: r.message };
      const v = resultValue(r);
      return { successful: true, value: v.type === "table" ? markdownTable(v.headers, v.values) : dv.markdownList(v.values) };
    },
    evaluate: (expr: string) => {
      const r = runInline(String(expr), vault, { thisPath, offset, tz });
      return r.kind === "error" ? { successful: false, error: r.message } : { successful: true, value: resultValue(r) };
    },
    tryEvaluate: (expr: string) => {
      const r = runInline(String(expr), vault, { thisPath, offset, tz });
      if (r.kind === "error") throw new Error(r.message);
      return resultValue(r);
    },
    io: {
      load: (path: string) => load(path),
      csv: async (path: string) => parseCsv(await load(path)),
      normalize: (path: string) => vault.resolve(String(path).replace(/\.md$/i, "")) ?? String(path),
    },
    // dv.view("views/x", input): views/x.js (or views/x/view.js, with its view.css) from the vault.
    view: async (path: string, input?: unknown) => {
      const p = String(path).replace(/\.js$/i, "");
      let code: string;
      let css = "";
      try {
        code = await load(`${p}.js`);
      } catch {
        code = await load(`${p}/view.js`);
        css = await load(`${p}/view.css`).catch(() => "");
      }
      if (css) el("style", "", { container }).textContent = css;
      await runCode(code, input, container);
    },
  };
  return dv;
}

function showError(e: unknown, container: HTMLElement = root) {
  const msg = e instanceof Error ? `${e.name === "Error" ? "" : e.name + ": "}${e.message}` : String(e);
  el("div", esc(`Evaluation Error: ${msg}`), { cls: "dv-error", container });
}

// ── talking to the app ────────────────────────────────────────────────────────────────────

let run = 0;
window.addEventListener("message", async (e) => {
  if (e.source !== parent) return;
  const m = e.data;
  if (!m || m.dvjs !== 1) return;
  if (m.type === "loaded") {
    const w = waiting.get(m.id);
    waiting.delete(m.id);
    if (w) m.ok ? w.ok(String(m.text)) : w.fail(new Error(String(m.error ?? "couldn't read that file")));
    return;
  }
  if (m.type === "ping") return post({ type: "pong" });
  if (m.type === "theme") return void (document.documentElement.dataset.theme = m.theme === "dark" ? "dark" : "light");
  if (m.type !== "run") return;
  const mine = ++run;
  const pages = (m.pages as PageData[]).map((p) => {
    // Links arrive as plain objects; make them links again.
    const relink = (l: any) => new ELink(l.target, l.display ?? null, !!l.embed, l.subpath ?? null);
    p.links = p.links.map(relink);
    for (const it of p.items) it.links = it.links.map(relink);
    return p;
  });
  vault = new Vault(pages);
  offset = Number(m.offset) || 0;
  tz = typeof m.tz === "string" ? m.tz : undefined;
  if (m.theme === "dark" || m.theme === "light") document.documentElement.dataset.theme = m.theme;
  thisPath = typeof m.thisPath === "string" ? m.thisPath : null;
  capture = m.capture === true;
  stopped = false;
  freeAt = performance.now();
  root.replaceChildren();
  try {
    await runCode(String(m.code), undefined, root);
  } catch (err) {
    if (mine === run) showError(err);
  }
  // For Publish: what the script drew, once it has finished.
  if (capture && mine === run) post({ type: "done", html: root.innerHTML });
});

// Links, tasks and calendars in what the script drew.
document.addEventListener("click", (e) => {
  const t = e.target as HTMLElement;
  const nav = t.closest<HTMLElement>("[data-dv-month], [data-dv-day]");
  if (nav) {
    e.preventDefault();
    const box = nav.closest<HTMLElement>(".dataview-block");
    const c = box && calendars.get(box);
    if (!box || !c) return;
    const day = nav.dataset.dvDay ?? null;
    c.s = nav.dataset.dvMonth ? { month: nav.dataset.dvMonth, day: null } : { month: c.s.month, day: c.s.day === day ? null : day };
    box.innerHTML = clean(renderResult(c.r, opts(c.s)));
    return;
  }
  const box = t.closest<HTMLInputElement>("input.dv-task");
  if (box) {
    post({ type: "tick", path: box.dataset.path, line: Number(box.dataset.line), text: box.dataset.text, done: box.checked });
    return;
  }
  const a = t.closest<HTMLAnchorElement>("a");
  if (!a) return;
  e.preventDefault();
  if (a.dataset.dvOpen) post({ type: "open", target: a.dataset.dvOpen });
  else if (/^https?:\/\//i.test(a.getAttribute("href") ?? "")) post({ type: "external", url: a.getAttribute("href") });
});

new ResizeObserver(() => post({ type: "height", h: Math.ceil(document.documentElement.scrollHeight) })).observe(document.documentElement);
post({ type: "ready" });
