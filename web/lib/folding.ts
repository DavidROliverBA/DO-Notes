// Folding headings and lists: a heading folds down to the next heading at its level or above, a
// list item folds its children (the Markdown language works out both). A view only, like a
// callout's chevron: the note never changes. A chevron after the heading or item shows on hover
// (on the cursor's line on a phone) and stays while folded; the folded part shows as "⋯ 12
// lines", which opens it again. ⌘⌥[ and ⌘⌥] fold and unfold where the cursor is; ⌘K has Fold
// all headings and Unfold all.

import { codeFolding, foldable, foldEffect, foldedRanges, foldKeymap, unfoldAll, unfoldEffect } from "@codemirror/language";
import type { EditorState, Range, StateEffect } from "@codemirror/state";
import { Decoration, type DecorationSet, type EditorView, keymap, ViewPlugin, type ViewUpdate, WidgetType } from "@codemirror/view";

const HEADING = /^#{1,6}\s/;
const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/;

/** What a line would fold, if it's a heading or a list item with something under it. */
function foldRange(state: EditorState, lineFrom: number): { from: number; to: number } | null {
  const line = state.doc.lineAt(lineFrom);
  if (!HEADING.test(line.text) && !LIST_ITEM.test(line.text)) return null;
  const r = foldable(state, line.from, line.to);
  // Trailing blank lines alone aren't worth a fold.
  return r && state.sliceDoc(r.from, r.to).trim() ? r : null;
}

function foldedAt(state: EditorState, at: number): { from: number; to: number } | null {
  let hit: { from: number; to: number } | null = null;
  foldedRanges(state).between(at, at, (from, to) => {
    if (from === at) hit = { from, to };
  });
  return hit;
}

class ChevronWidget extends WidgetType {
  constructor(
    readonly at: number,
    readonly folded: boolean,
  ) {
    super();
  }
  eq(o: ChevronWidget) {
    return o.at === this.at && o.folded === this.folded;
  }
  toDOM(view: EditorView) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `cm-fold-chevron${this.folded ? " folded" : ""}`;
    // Drawn by CSS (::before), so it's never part of the line's text.
    b.setAttribute("aria-label", this.folded ? "Unfold" : "Fold");
    b.setAttribute("aria-expanded", String(!this.folded));
    b.addEventListener("mousedown", (e) => {
      e.preventDefault();
      toggleAt(view, this.at);
    });
    return b;
  }
  ignoreEvent() {
    return true;
  }
}

function toggleAt(view: EditorView, lineFrom: number): boolean {
  const line = view.state.doc.lineAt(lineFrom);
  const folded = foldedAt(view.state, line.to);
  if (folded) {
    view.dispatch({ effects: unfoldEffect.of(folded) });
    return true;
  }
  const r = foldRange(view.state, line.from);
  if (!r) return false;
  // A cursor inside would open it again straight away: put it on the heading.
  const sel = view.state.selection.main;
  const inside = sel.head > r.from && sel.head <= r.to;
  view.dispatch({ effects: foldEffect.of(r), selection: inside ? { anchor: line.to } : undefined });
  return true;
}

const chevrons = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = this.build(view);
    }
    update(u: ViewUpdate) {
      const folds = u.transactions.some((t) => t.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect)));
      if (u.docChanged || u.viewportChanged || u.selectionSet || folds) this.decorations = this.build(u.view);
    }
    build(view: EditorView): DecorationSet {
      const { state } = view;
      const head = state.doc.lineAt(state.selection.main.head).number;
      const out: Range<Decoration>[] = [];
      for (const { from, to } of view.visibleRanges) {
        for (let pos = from; pos <= to; ) {
          const line = state.doc.lineAt(pos);
          const folded = !!foldedAt(state, line.to);
          if (folded || foldRange(state, line.from)) {
            out.push(Decoration.widget({ widget: new ChevronWidget(line.from, folded), side: -1 }).range(line.to));
            out.push(Decoration.line({ class: `cm-foldable${folded ? " cm-folded" : ""}${line.number === head ? " cm-fold-here" : ""}` }).range(line.from));
          }
          pos = line.to + 1;
        }
      }
      return Decoration.set(out, true);
    }
  },
  { decorations: (v) => v.decorations },
);

/** Fold every heading's section (top-level headings first, so the outline is what's left). */
export function foldHeadings(view: EditorView): boolean {
  const { state } = view;
  const effects: StateEffect<unknown>[] = [];
  const done: { from: number; to: number }[] = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!HEADING.test(line.text)) continue;
    const r = foldRange(state, line.from);
    // Inside a section already folded: leave it, or unfolding the outer one shows it folded.
    if (!r || done.some((d) => r.from >= d.from && r.to <= d.to) || foldedAt(state, r.from)) continue;
    done.push(r);
    effects.push(foldEffect.of(r));
  }
  if (!effects.length) return false;
  const sel = state.selection.main.head;
  const inFold = done.find((d) => sel > d.from && sel <= d.to);
  view.dispatch({ effects, selection: inFold ? { anchor: inFold.from } : undefined });
  return true;
}
export const unfoldEverything = (view: EditorView) => unfoldAll(view);

export function folding() {
  return [
    codeFolding({
      preparePlaceholder: (state, range) => state.doc.lineAt(range.to).number - state.doc.lineAt(range.from).number,
      placeholderDOM: (_view, onclick, lines: number) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "cm-fold-placeholder";
        b.textContent = `⋯ ${lines} ${lines === 1 ? "line" : "lines"}`;
        b.setAttribute("aria-label", "Unfold");
        b.onclick = onclick;
        b.onmousedown = (e) => e.preventDefault();
        return b;
      },
    }),
    chevrons,
    // ⌘⌥[ and ⌘⌥] (Ctrl-Shift-[ and ] elsewhere): fold and unfold where the cursor is.
    keymap.of(foldKeymap.filter((k) => k.key === "Ctrl-Shift-[" || k.key === "Ctrl-Shift-]")),
  ];
}
