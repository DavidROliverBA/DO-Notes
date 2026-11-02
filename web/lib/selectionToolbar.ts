// The format toolbar over selected text, on a laptop (a phone has its bar above the keyboard):
// heading, bold, italic, strikethrough, highlight, code, link and colour, each a command from
// web/lib/commands.ts, so it does exactly what ⌘K and the keys do. It waits until the mouse is
// let go, so it doesn't follow a drag, and Escape hides it until the selection changes.

import { type EditorState, StateEffect, StateField } from "@codemirror/state";
import { EditorView, showTooltip, type Tooltip, ViewPlugin } from "@codemirror/view";
import { iconElement } from "../ui/Icon";
import { menuAt } from "../ui/Menu";
import { COMMANDS, currentCtx } from "./commands";
import { hasMark, type Mark } from "./format";

const setSelecting = StateEffect.define<boolean>();
const dismiss = StateEffect.define<null>();

interface Bar {
  selecting: boolean;
  dismissed: boolean;
  tip: Tooltip | null;
}

function run(id: string) {
  COMMANDS.find((c) => c.id === id)?.run(currentCtx());
}

/** One line of prose selected, not code or the properties: worth formatting. */
function wantsBar(state: EditorState): boolean {
  const r = state.selection.main;
  if (r.empty || state.readOnly || state.selection.ranges.length > 1) return false;
  const text = state.sliceDoc(r.from, r.to);
  if (!text.trim()) return false;
  const fm = /^---\r?\n[\s\S]*?\r?\n---/.exec(state.sliceDoc(0, 20_000));
  return !(fm && r.from < fm[0].length);
}

const BUTTONS: { label: string; mark?: Mark; id: string; content: string | { icon: string }; cls?: string }[] = [
  { label: "Bold", mark: "**", id: "format.bold", content: "B", cls: "b" },
  { label: "Italic", mark: "*", id: "format.italic", content: "I", cls: "i" },
  { label: "Strikethrough", mark: "~~", id: "format.strikethrough", content: "S", cls: "s" },
  { label: "Highlight", mark: "==", id: "format.highlight", content: "ab", cls: "hl" },
  { label: "Inline code", mark: "`", id: "format.inline-code", content: { icon: "code" } },
  { label: "Link…", id: "format.link", content: { icon: "link" } },
  { label: "Colour…", id: "format.colour", content: "A", cls: "colour" },
];

function barDOM(view: EditorView) {
  const dom = document.createElement("div");
  dom.className = "cm-format-bar";
  dom.setAttribute("role", "toolbar");
  dom.setAttribute("aria-label", "Format");
  // Clicks here mustn't take the selection away.
  dom.addEventListener("mousedown", (e) => e.preventDefault());
  const add = (label: string, content: string | { icon: string }, onClick: (b: HTMLButtonElement) => void, cls = "") => {
    const b = dom.appendChild(document.createElement("button"));
    b.type = "button";
    b.className = `cm-format-btn ${cls}`.trim();
    b.title = label;
    b.setAttribute("aria-label", label.replace("…", ""));
    if (typeof content === "string") b.textContent = content;
    else b.append(iconElement(content.icon, 16) ?? "");
    b.addEventListener("click", () => onClick(b));
    return b;
  };
  add(
    "Heading",
    "H₁",
    (b) =>
      menuAt(b, "Heading", [
        ...[1, 2, 3].map((n) => ({ label: `Heading ${n}`, icon: "heading", onSelect: () => run(`insert.h${n}`) })),
        { label: "Normal text", icon: "text", onSelect: () => currentCtx().note?.editor?.setBlock("") },
      ]),
    "heading",
  );
  const marks: [HTMLButtonElement, Mark][] = [];
  for (const btn of BUTTONS) {
    const b = add(btn.label, btn.content, () => run(btn.id), btn.cls);
    if (btn.mark) {
      b.setAttribute("aria-pressed", "false");
      marks.push([b, btn.mark]);
    }
  }
  const refresh = (state: EditorState) => {
    for (const [b, mark] of marks) b.setAttribute("aria-pressed", String(hasMark(state, mark)));
  };
  refresh(view.state);
  return { dom, refresh };
}

const barField = StateField.define<Bar>({
  create: () => ({ selecting: false, dismissed: false, tip: null }),
  update(bar, tr) {
    let { selecting, dismissed } = bar;
    for (const e of tr.effects) {
      if (e.is(setSelecting)) selecting = e.value;
      if (e.is(dismiss)) dismissed = true;
    }
    if (tr.selection) dismissed = false;
    const want = !selecting && !dismissed && wantsBar(tr.state);
    if (!want) return bar.tip || bar.selecting !== selecting || bar.dismissed !== dismissed ? { selecting, dismissed, tip: null } : bar;
    const r = tr.state.selection.main;
    // The same tooltip object while the selection's start stays put, so it isn't redrawn.
    if (bar.tip && bar.tip.pos === r.from && !tr.docChanged && bar.selecting === selecting) return bar;
    return {
      selecting,
      dismissed,
      tip: {
        pos: r.from,
        end: r.to,
        above: true,
        arrow: false,
        create: (view) => {
          const { dom, refresh } = barDOM(view);
          return { dom, update: (u) => refresh(u.state) };
        },
      },
    };
  },
  provide: (f) => showTooltip.compute([f], (s) => s.field(f).tip),
});

// Not while the mouse is down (selecting by dragging), and Escape hides it.
const pointer = ViewPlugin.define((view) => {
  const up = () => {
    document.removeEventListener("mouseup", up, true);
    if (view.state.field(barField).selecting) view.dispatch({ effects: setSelecting.of(false) });
  };
  const down = (e: MouseEvent) => {
    if (e.button !== 0 || (e.target as HTMLElement).closest(".cm-format-bar")) return;
    view.dispatch({ effects: setSelecting.of(true) });
    document.addEventListener("mouseup", up, true);
  };
  view.contentDOM.addEventListener("mousedown", down);
  return {
    destroy() {
      view.contentDOM.removeEventListener("mousedown", down);
      document.removeEventListener("mouseup", up, true);
    },
  };
});

const escape = EditorView.domEventHandlers({
  keydown(e, view) {
    if (e.key !== "Escape" || !view.state.field(barField).tip) return false;
    view.dispatch({ effects: dismiss.of(null) });
    return true;
  },
});

/** The toolbar, on devices with a mouse or trackpad. */
export function selectionToolbar() {
  return matchMedia("(hover: hover) and (pointer: fine)").matches ? [barField, pointer, escape] : [];
}

