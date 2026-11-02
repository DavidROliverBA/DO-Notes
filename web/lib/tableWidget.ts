// Tables you edit cell by cell (F8), in Live Preview. Click a cell to edit its markdown; Tab and
// Shift-Tab move between cells, Enter moves down, and Tab in the last cell adds a row. The bar
// above the table has Row and Column menus (insert, move, delete, sort), alignment and the
// markdown; a range pasted from a spreadsheet fills the cells from the one it's pasted into.
// Every change rewrites the table with its pipes lined up (web/lib/tableModel.ts), as one
// minimal edit to the note, so it merges with live typing and undoes in one step.

import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import { type EditorView, WidgetType } from "@codemirror/view";
import { minimalChange } from "./frontmatter";
import { addColumn, addRow, type Align, deleteColumn, deleteRow, formatTable, moveColumn, moveRow, parseGrid, parseTable, pasteGrid, setAlign, setCell, sortBy, type Table } from "./tableModel";
import { iconElement } from "../ui/Icon";
import { type MenuItem, menuAt } from "../ui/Menu";

/** Where focus goes after a change that redraws the table (a new row or column). */
let refocus: { r: number; c: number } | null = null;
/** True while a table's cells are being replaced: a cell losing focus then isn't an edit. */
let redrawing = false;

/** The table at `pos`: its range in the document and its parsed cells. */
function tableAt(state: EditorState, pos: number): { from: number; to: number; table: Table } | null {
  let found: { from: number; to: number } | null = null;
  syntaxTree(state).iterate({
    from: pos,
    to: Math.min(pos + 1, state.doc.length),
    enter: (n) => {
      if (n.name === "Table") {
        found = { from: state.doc.lineAt(n.from).from, to: state.doc.lineAt(n.to).to };
        return false;
      }
    },
  });
  if (!found) return null;
  const { from, to } = found as { from: number; to: number };
  const table = parseTable(state.doc.sliceString(from, to));
  return table ? { from, to, table } : null;
}

const cellText = (t: Table, r: number, c: number) => (r < 0 ? t.header[c] : t.rows[r]?.[c]) ?? "";

function caretToEnd(el: HTMLElement) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  getSelection()?.removeAllRanges();
  getSelection()?.addRange(range);
}

export class TableEditWidget extends WidgetType {
  constructor(
    readonly src: string,
    /** A cell's markdown as HTML, for showing it when not being edited. */
    readonly renderInline: (md: string) => string,
    readonly onOpenLink: (target: string) => void,
  ) {
    super();
  }
  eq(o: TableEditWidget) {
    return o.src === this.src;
  }
  ignoreEvent() {
    return true;
  }

  /** Apply `edit` to the table as it is in the document now, and refocus a cell if asked. */
  private commit(view: EditorView, dom: HTMLElement, edit: (t: Table) => Table, focus?: { r: number; c: number }) {
    if (view.state.readOnly) return;
    const at = tableAt(view.state, view.posAtDOM(dom));
    if (!at) return;
    // Whatever is being typed in a cell goes into the same edit, so a new row or column, or a
    // move to another cell, never loses it.
    let base = at.table;
    const active = document.activeElement as HTMLElement | null;
    if (active && dom.contains(active) && active.dataset.r !== undefined) {
      const r = Number(active.dataset.r);
      const c = Number(active.dataset.c);
      const typed = (active.textContent ?? "").replace(/\s+/g, " ").trim();
      if (typed !== active.dataset.was && cellText(base, r, c) !== typed) base = setCell(base, r, c, typed);
      active.dataset.was = typed;
    }
    const next = formatTable(edit(base));
    const old = view.state.doc.sliceString(at.from, at.to);
    if (focus) refocus = focus;
    const c = minimalChange(old, next);
    if (c) view.dispatch({ changes: { from: at.from + c.from, to: at.from + c.to, insert: c.insert }, userEvent: "input.table" });
    else if (focus) this.focusCell(dom, focus);
  }

  /** Focus a cell: at once when the table is on the page (so typing straight after a new row or
   *  column lands in it), else as soon as CodeMirror has placed it. */
  private focusCell(dom: HTMLElement, at: { r: number; c: number }) {
    refocus = null;
    const go = () => {
      const cell = dom.querySelector<HTMLElement>(`[data-r="${at.r}"][data-c="${at.c}"]`);
      if (!cell) return;
      cell.focus();
      caretToEnd(cell);
    };
    if (dom.isConnected) go();
    else requestAnimationFrame(go);
  }

  toDOM(view: EditorView) {
    const dom = document.createElement("div");
    dom.className = "cm-lp-block cm-lp-table cm-table-edit markdown";
    this.fill(view, dom);
    return dom;
  }

  /** Same rows and columns: refresh the cells nobody is editing, and keep the DOM (and focus). */
  updateDOM(dom: HTMLElement, view: EditorView) {
    const t = parseTable(this.src);
    const rows = dom.querySelectorAll("tbody tr").length;
    const cols = dom.querySelectorAll("thead th").length;
    if (!t || t.rows.length !== rows || t.header.length !== cols || refocus) {
      this.fill(view, dom);
      return true;
    }
    for (const cell of dom.querySelectorAll<HTMLElement>("[data-r]")) {
      if (cell === document.activeElement) continue;
      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      cell.innerHTML = this.renderInline(cellText(t, r, c));
      cell.style.textAlign = t.align[c] ?? "";
    }
    return true;
  }

  private fill(view: EditorView, dom: HTMLElement) {
    const t = parseTable(this.src)!;
    redrawing = true;
    try {
      dom.replaceChildren();
    } finally {
      redrawing = false;
    }
    const ro = view.state.readOnly;

    // The bar for the focused cell's row and column.
    const bar = document.createElement("div");
    bar.className = "table-bar";
    const pos = () => ({ r: Number(dom.dataset.r ?? 0), c: Number(dom.dataset.c ?? 0) });
    const btn = (icon: string, label: string, run: () => void) => {
      const b = document.createElement("button");
      b.type = "button";
      b.title = label;
      b.setAttribute("aria-label", label);
      const svg = iconElement(icon, 14);
      if (svg) b.append(svg);
      b.append(document.createTextNode(label.split(" ")[0] === "Align" ? "" : ` ${label}`));
      b.onmousedown = (e) => e.preventDefault(); // keep the cell's focus
      b.onclick = run;
      return b;
    };
    const align = (a: Align, label: string, glyph: string) => {
      const b = btn("list", label, () => this.commit(view, dom, (x) => setAlign(x, pos().c, a), pos()));
      b.replaceChildren(document.createTextNode(glyph));
      b.classList.add("align");
      return b;
    };
    // Row and Column open menus, so the bar stays short enough for a phone.
    const menu = (icon: string, label: string, items: () => MenuItem[]) => {
      const b = btn(icon, label, () => {
        const at = pos();
        menuAt(b, label, items(), (refocus) => refocus && this.focusCell(dom, at));
      });
      b.setAttribute("aria-haspopup", "menu");
      b.classList.add("table-menu");
      return b;
    };
    const go = (edit: (x: Table, at: { r: number; c: number }) => Table, focus: (at: { r: number; c: number }) => { r: number; c: number }) => () => {
      const at = pos();
      this.commit(view, dom, (x) => edit(x, at), focus(at));
    };
    bar.append(
      menu("rows", "Row", () => {
        const { r } = pos();
        const rows = x0().rows.length;
        return [
          { label: "Insert row above", icon: "plus", hidden: r < 0, onSelect: go((x, a) => addRow(x, a.r), (a) => a) },
          { label: "Insert row below", icon: "plus", onSelect: go((x, a) => addRow(x, a.r + 1), (a) => ({ r: a.r + 1, c: a.c })) },
          { label: "Move row up", icon: "arrow-up", hidden: r < 1, onSelect: go((x, a) => moveRow(x, a.r, a.r - 1), (a) => ({ r: a.r - 1, c: a.c })) },
          { label: "Move row down", icon: "arrow-down", hidden: r < 0 || r >= rows - 1, onSelect: go((x, a) => moveRow(x, a.r, a.r + 1), (a) => ({ r: a.r + 1, c: a.c })) },
          { label: "Delete row", icon: "trash", danger: true, hidden: r < 0, onSelect: go((x, a) => deleteRow(x, a.r), (a) => ({ r: Math.max(-1, Math.min(a.r, rows - 2)), c: a.c })) },
        ];
      }),
      menu("columns", "Column", () => {
        const { c } = pos();
        const cols = x0().header.length;
        return [
          { label: "Insert column left", icon: "plus", onSelect: go((x, a) => addColumn(x, a.c), (a) => a) },
          { label: "Insert column right", icon: "plus", onSelect: go((x, a) => addColumn(x, a.c + 1), (a) => ({ r: a.r, c: a.c + 1 })) },
          { label: "Move column left", icon: "arrow-left", hidden: c < 1, onSelect: go((x, a) => moveColumn(x, a.c, a.c - 1), (a) => ({ r: a.r, c: a.c - 1 })) },
          { label: "Move column right", icon: "arrow-right", hidden: c >= cols - 1, onSelect: go((x, a) => moveColumn(x, a.c, a.c + 1), (a) => ({ r: a.r, c: a.c + 1 })) },
          { label: "Sort A to Z", icon: "sort", onSelect: go((x, a) => sortBy(x, a.c, "asc"), (a) => ({ r: -1, c: a.c })) },
          { label: "Sort Z to A", icon: "sort", onSelect: go((x, a) => sortBy(x, a.c, "desc"), (a) => ({ r: -1, c: a.c })) },
          { label: "Delete column", icon: "trash", danger: true, hidden: cols <= 1, onSelect: go((x, a) => deleteColumn(x, a.c), (a) => ({ r: a.r, c: Math.max(0, a.c - 1) })) },
        ];
      }),
      align("left", "Align left", "⇤"),
      align("center", "Align centre", "↔"),
      align("right", "Align right", "⇥"),
      btn("code", "Markdown", () => {
        const at = tableAt(view.state, view.posAtDOM(dom));
        view.focus();
        if (at) view.dispatch({ selection: { anchor: at.from } });
      }),
    );
    const x0 = () => parseTable(this.src)!;
    if (!ro) dom.append(bar);

    const table = document.createElement("table");
    const cell = (tag: "th" | "td", r: number, c: number) => {
      const el = document.createElement(tag);
      el.dataset.r = String(r);
      el.dataset.c = String(c);
      el.style.textAlign = t.align[c] ?? "";
      el.innerHTML = this.renderInline(cellText(t, r, c));
      if (ro) return el;
      el.contentEditable = "plaintext-only";
      el.spellcheck = true;
      // Editing shows the cell's markdown; leaving it writes the table back.
      el.onfocus = () => {
        dom.dataset.r = String(r);
        dom.dataset.c = String(c);
        const now = tableAt(view.state, view.posAtDOM(dom));
        const md = now ? cellText(now.table, r, c) : cellText(t, r, c);
        // What it said when focused: leaving it writes back only if that was changed, so a
        // move or sort made meanwhile is never undone by a cell's older text.
        el.dataset.was = md;
        if (el.textContent !== md) {
          el.textContent = md;
          caretToEnd(el);
        }
      };
      el.onblur = () => {
        if (redrawing || !el.isConnected) return;
        const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
        // After the event, never inside CodeMirror's own update.
        setTimeout(() => {
          if (!dom.isConnected) return;
          const now = tableAt(view.state, view.posAtDOM(dom));
          if (now && text !== el.dataset.was && cellText(now.table, r, c) !== text) this.commit(view, dom, (x) => setCell(x, r, c, text));
          else if (document.activeElement !== el) el.innerHTML = this.renderInline(text);
        });
      };
      el.onkeydown = (e) => {
        // Select all selects this cell, not the whole note.
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
          e.preventDefault();
          const range = document.createRange();
          range.selectNodeContents(el);
          getSelection()?.removeAllRanges();
          getSelection()?.addRange(range);
          return;
        }
        const rows = t.rows.length;
        const cols = t.header.length;
        const go = (nr: number, nc: number) => {
          e.preventDefault();
          dom.querySelector<HTMLElement>(`[data-r="${nr}"][data-c="${nc}"]`)?.focus();
        };
        if (e.key === "Tab" && !e.shiftKey) {
          if (c < cols - 1) return go(r, c + 1);
          if (r < rows - 1) return go(r + 1, 0);
          // The last cell: a new row, in one edit with what was just typed.
          e.preventDefault();
          const text = (el.textContent ?? "").trim();
          this.commit(view, dom, (x) => addRow(setCell(x, r, c, text), rows), { r: rows, c: 0 });
        } else if (e.key === "Tab" && e.shiftKey) {
          if (c > 0) return go(r, c - 1);
          if (r > -1) return go(r - 1, cols - 1);
          e.preventDefault();
        } else if (e.key === "Enter" && !e.shiftKey) {
          if (r < rows - 1) return go(r + 1, c);
          e.preventDefault();
          const text = (el.textContent ?? "").trim();
          this.commit(view, dom, (x) => addRow(setCell(x, r, c, text), rows), { r: rows, c });
        } else if (e.key === "Escape") {
          e.preventDefault();
          el.blur();
          view.focus();
        }
      };
      // A range copied from a spreadsheet fills the cells from here, across and down.
      el.onpaste = (e) => {
        const grid = parseGrid(e.clipboardData?.getData("text/plain") ?? "");
        if (!grid) return;
        e.preventDefault();
        this.commit(view, dom, (x) => pasteGrid(x, r, c, grid), { r: r + grid.length - 1, c: c + grid[0]!.length - 1 });
      };
      // A link in a cell that isn't being edited opens with ⌘/Ctrl-click, as in the editor.
      el.onmousedown = (e) => {
        const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
        if (a && (e.metaKey || e.ctrlKey) && document.activeElement !== el) {
          e.preventDefault();
          this.onOpenLink(a.dataset.target!);
        }
      };
      return el;
    };
    const thead = table.createTHead().insertRow();
    t.header.forEach((_, c) => thead.append(cell("th", -1, c)));
    const tbody = table.createTBody();
    t.rows.forEach((row, r) => {
      const tr = tbody.insertRow();
      row.forEach((_, c) => tr.append(cell("td", r, c)));
    });
    dom.append(table);
    if (refocus) this.focusCell(dom, refocus);
  }
}
