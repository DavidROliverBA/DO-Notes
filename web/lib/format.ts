// Inline formatting that toggles: ⌘B wraps the selection in ** and, on text already bold, takes
// them off again; the same for italic, strikethrough, highlight and inline code. The commands
// (web/lib/commands.ts), the selection toolbar and the keys all come here.

import { EditorSelection, type EditorState, type TransactionSpec } from "@codemirror/state";
import { type EditorView, keymap } from "@codemirror/view";

export type Mark = "**" | "*" | "~~" | "==" | "`";

export const MARKS: { mark: Mark; label: string; key?: string }[] = [
  { mark: "**", label: "Bold", key: "Mod-b" },
  { mark: "*", label: "Italic", key: "Mod-i" },
  { mark: "~~", label: "Strikethrough", key: "Mod-Shift-x" },
  { mark: "==", label: "Highlight" },
  { mark: "`", label: "Inline code", key: "Mod-e" },
];

/** How many of `ch` run back from `pos` (or forward, with dir 1). */
function run(state: EditorState, pos: number, ch: string, dir: -1 | 1): number {
  let n = 0;
  const line = state.doc.lineAt(pos);
  for (let p = pos; dir < 0 ? p > line.from : p < line.to; p += dir) {
    if (state.sliceDoc(dir < 0 ? p - 1 : p, dir < 0 ? p : p + 1) !== ch) break;
    n++;
  }
  return n;
}

/** Is the range wrapped in the mark, just outside it (`**|x|**`) or just inside (`|**x**|`)?
 *  `*` and `**` share a character: a run of 2 is bold, 1 italic, 3 both. */
function wrapped(state: EditorState, from: number, to: number, mark: Mark): { outside: boolean } | null {
  const ch = mark[0]!;
  const fits = (n: number) => (ch !== "*" ? n >= mark.length : mark === "**" ? n === 2 || n === 3 : n === 1 || n === 3);
  if (fits(run(state, from, ch, -1)) && fits(run(state, to, ch, 1))) return { outside: true };
  const text = state.sliceDoc(from, to);
  if (text.length > mark.length * 2 && fits(run(state, from, ch, 1)) && fits(run(state, to, ch, -1)) && text.startsWith(mark) && text.endsWith(mark)) return { outside: false };
  return null;
}

/** Whether the main selection is in the mark (for the toolbar's pressed buttons). */
export function hasMark(state: EditorState, mark: Mark): boolean {
  const r = state.selection.main;
  return !r.empty && wrapped(state, r.from, r.to, mark) !== null;
}

/** Wrap each selection in the mark, or unwrap it if it's already wrapped. */
export function toggleMark(state: EditorState, mark: Mark): TransactionSpec {
  const n = mark.length;
  return state.changeByRange((r) => {
    const w = wrapped(state, r.from, r.to, mark);
    if (w?.outside)
      return {
        changes: [
          { from: r.from - n, to: r.from },
          { from: r.to, to: r.to + n },
        ],
        range: EditorSelection.range(r.from - n, r.to - n),
      };
    if (w)
      return {
        changes: [
          { from: r.from, to: r.from + n },
          { from: r.to - n, to: r.to },
        ],
        range: EditorSelection.range(r.from, r.to - 2 * n),
      };
    // Spaces at the edges stay outside: "**word** " not "**word **", which wouldn't be bold.
    const text = state.sliceDoc(r.from, r.to);
    const from = r.from + (text.length - text.trimStart().length);
    const to = Math.max(from, r.to - (text.length - text.trimEnd().length));
    return {
      changes: [
        { from, insert: mark },
        { from: to, insert: mark },
      ],
      range: EditorSelection.range(from + n, to + n),
    };
  });
}

export function runMark(view: EditorView, mark: Mark): boolean {
  if (view.state.readOnly) return false;
  view.dispatch(toggleMark(view.state, mark), { userEvent: "input.format", scrollIntoView: true });
  return true;
}

export const formatKeymap = keymap.of(MARKS.filter((m) => m.key).map((m) => ({ key: m.key!, run: (v: EditorView) => runMark(v, m.mark), preventDefault: true })));
