// GFM tables as data (F8): parse a table's markdown into cells, change it, and write it back with
// the pipes lined up. Cell text stays markdown (`**bold**`, `[[links]]`); a `|` inside a cell is
// written `\|`, as GFM requires.

export type Align = "left" | "center" | "right" | null;

export interface Table {
  header: string[];
  align: Align[];
  rows: string[][];
}

/** Split one table line into cells, honouring `\|` and pipes inside `code`. */
export function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const cells: string[] = [];
  let cur = "";
  let code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && s[i + 1] === "|") {
      cur += "\\|";
      i++;
    } else if (c === "`") {
      code = !code;
      cur += c;
    } else if (c === "|" && !code) {
      cells.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  cells.push(cur.trim());
  return cells;
}

const SEP = /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/;

/** A table from its markdown lines, or null if they aren't one. */
export function parseTable(md: string): Table | null {
  const lines = md.replace(/\n+$/, "").split("\n");
  if (lines.length < 2 || !SEP.test(lines[1]!)) return null;
  const header = splitRow(lines[0]!);
  const align = splitRow(lines[1]!).map((c): Align => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : null;
  });
  const width = header.length;
  const fit = (cells: string[]) => [...cells, ...Array(Math.max(0, width - cells.length)).fill("")].slice(0, width);
  return { header, align: fit(align as string[]) as Align[], rows: lines.slice(2).map((l) => fit(splitRow(l))) };
}

/** Display width, so pipes line up for wide characters too (CJK and emoji count as two). */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1;
  return w;
}
const pad = (s: string, n: number, a: Align) => {
  const gap = Math.max(0, n - width(s));
  if (a === "right") return " ".repeat(gap) + s;
  if (a === "center") return " ".repeat(Math.floor(gap / 2)) + s + " ".repeat(Math.ceil(gap / 2));
  return s + " ".repeat(gap);
};

/** The table's markdown, columns padded to line up. */
export function formatTable(t: Table): string {
  const cols = t.header.length;
  const esc = (s: string) => s.replace(/\n/g, " ").replace(/(?<!\\)\|/g, "\\|").trim();
  const header = t.header.map(esc);
  const rows = t.rows.map((r) => r.map(esc));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(3, width(header[c] ?? ""), ...rows.map((r) => width(r[c] ?? ""))));
  const line = (cells: string[]) => `| ${cells.map((c, i) => pad(c ?? "", widths[i]!, t.align[i] ?? null)).join(" | ")} |`;
  const sep = `| ${widths
    .map((w, i) => {
      const a = t.align[i];
      const dashes = "-".repeat(Math.max(1, w - (a === "center" ? 2 : a ? 1 : 0)));
      return a === "center" ? `:${dashes}:` : a === "right" ? `${dashes}:` : a === "left" ? `:${dashes}` : dashes;
    })
    .join(" | ")} |`;
  return [line(header), sep, ...rows.map(line)].join("\n");
}

// Edits: each returns a new table.
export const setCell = (t: Table, row: number, col: number, text: string): Table =>
  row < 0 ? { ...t, header: t.header.map((c, i) => (i === col ? text : c)) } : { ...t, rows: t.rows.map((r, i) => (i === row ? r.map((c, j) => (j === col ? text : c)) : r)) };
export const addRow = (t: Table, at: number): Table => ({ ...t, rows: [...t.rows.slice(0, at), t.header.map(() => ""), ...t.rows.slice(at)] });
export const deleteRow = (t: Table, at: number): Table => ({ ...t, rows: t.rows.filter((_, i) => i !== at) });
export const addColumn = (t: Table, at: number): Table => ({
  header: [...t.header.slice(0, at), "", ...t.header.slice(at)],
  align: [...t.align.slice(0, at), null, ...t.align.slice(at)],
  rows: t.rows.map((r) => [...r.slice(0, at), "", ...r.slice(at)]),
});
export const deleteColumn = (t: Table, at: number): Table =>
  t.header.length <= 1 ? t : { header: t.header.filter((_, i) => i !== at), align: t.align.filter((_, i) => i !== at), rows: t.rows.map((r) => r.filter((_, i) => i !== at)) };
export const setAlign = (t: Table, col: number, a: Align): Table => ({ ...t, align: t.align.map((x, i) => (i === col ? a : x)) });
export const moveRow = (t: Table, from: number, to: number): Table => {
  if (to < 0 || to >= t.rows.length || from === to) return t;
  const rows = [...t.rows];
  rows.splice(to, 0, rows.splice(from, 1)[0]!);
  return { ...t, rows };
};
export const moveColumn = (t: Table, from: number, to: number): Table => {
  if (to < 0 || to >= t.header.length || from === to) return t;
  const move = <T>(xs: T[]) => {
    const ys = [...xs];
    ys.splice(to, 0, ys.splice(from, 1)[0]!);
    return ys;
  };
  return { header: move(t.header), align: move(t.align), rows: t.rows.map(move) };
};

/** A cell's value for sorting: a number when it reads as one (£4,200, 12%, -3.5), else its words. */
function sortKey(cell: string): number | string {
  const plain = cell.replace(/[*_`~=]|\[\[([^\]|]*\|)?|\]\]/g, "").trim();
  const n = /^[-+]?[£$€¥]?\s*-?[\d,]*\.?\d+\s*%?$/.test(plain) ? Number(plain.replace(/[£$€¥,%\s+]/g, "")) : NaN;
  return Number.isFinite(n) ? n : plain.toLowerCase();
}
/** Rows sorted by a column: numbers by size, then words A to Z (or the reverse); empty cells last. */
export const sortBy = (t: Table, col: number, dir: "asc" | "desc"): Table => {
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  const keyed = t.rows.map((r, i) => ({ r, i, k: sortKey(r[col] ?? "") }));
  keyed.sort((a, b) => {
    const ea = a.k === "";
    const eb = b.k === "";
    if (ea || eb) return ea === eb ? a.i - b.i : ea ? 1 : -1;
    const na = typeof a.k === "number";
    const nb = typeof b.k === "number";
    const c = na && nb ? (a.k as number) - (b.k as number) : na !== nb ? (na ? -1 : 1) : collator.compare(String(a.k), String(b.k));
    return (dir === "asc" ? c : -c) || a.i - b.i;
  });
  return { ...t, rows: keyed.map((x) => x.r) };
};

/** Cells copied from a spreadsheet (tab-separated lines), or null if the text isn't that: at
 *  least two cells, and every line with the same number of them. */
export function parseGrid(text: string): string[][] | null {
  const lines = text.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n");
  if (!lines.some((l) => l.includes("\t"))) return null;
  const grid = lines.map((l) => l.split("\t").map((c) => c.replace(/^"(.*)"$/s, "$1").replace(/""/g, '"').replace(/\s+/g, " ").trim()));
  const cols = grid[0]!.length;
  if (grid.some((r) => r.length !== cols) || cols * grid.length < 2) return null;
  return grid;
}

/** A pasted range as a new table: its first line is the header. */
export function tableFromGrid(grid: string[][]): Table {
  const header = grid[0]!;
  const rows = grid.length > 1 ? grid.slice(1) : [header.map(() => "")];
  return { header, align: header.map(() => null), rows };
}

/** A pasted range written into the table from cell (row, col) across and down, adding rows and
 *  columns where it runs past the edge. */
export function pasteGrid(t: Table, row: number, col: number, grid: string[][]): Table {
  let next = t;
  const width = col + grid[0]!.length;
  while (next.header.length < width) next = addColumn(next, next.header.length);
  while (next.rows.length < row + grid.length) next = addRow(next, next.rows.length);
  grid.forEach((cells, i) => cells.forEach((text, j) => (next = setCell(next, row + i, col + j, text))));
  return next;
}
