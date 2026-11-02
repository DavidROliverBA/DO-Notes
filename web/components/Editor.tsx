// CodeMirror 6 bound to a shared Y.Text: every keystroke is a CRDT update, other people's
// cursors and selections are drawn from awareness, and undo only undoes your own changes.
// On top: Live Preview (web/lib/livePreview.ts) or plain source, autocompletion for [[links]],
// #tags, the `/` menu and `@name` assistants, files pasted or dropped in (photos shrunk, uploaded,
// then embedded), the block handle, and typewriter scrolling for focus mode. NoteView drives it
// through EditorHandle.

import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap, type CompletionContext, snippet, startCompletion } from "@codemirror/autocomplete";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { yamlFrontmatter } from "@codemirror/lang-yaml";
import { HighlightStyle, syntaxHighlighting, indentOnInput, bracketMatching, syntaxTree } from "@codemirror/language";
import { formatTable, parseGrid, tableFromGrid } from "../lib/tableModel";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, EditorState, type Range, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  drawSelection,
  dropCursor,
  EditorView,
  hoverTooltip,
  keymap,
  MatchDecorator,
  placeholder,
  showTooltip,
  type Tooltip,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { classHighlighter, tags as t } from "@lezer/highlight";
import { forwardRef, useEffect, useImperativeHandle, useRef } from "react";
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next";
import type { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { codeLanguage } from "../../src/codeHighlight";
import { isTypePath } from "../../src/types";
import { countWords, findWikiLinks, headings } from "../../src/markdown";
import { cachedAssistants, loadAssistants } from "../lib/ai";
import { type ColourName, stripColour, wrapColour } from "../lib/colours";
import { api, type NoteSummary } from "../lib/api";
import { blockHandle } from "../lib/blockHandle";
import { available, COMMANDS, currentCtx, pickDate } from "../lib/commands";
import { fuzzyScore, linkTextFor, resolveLocal } from "../lib/links";
import { livePreview, refreshLivePreview } from "../lib/livePreview";
import { deleteProp, minimalChange, type PropValue, readProps, setProp } from "../lib/frontmatter";
import { frontmatterYaml, setRelationCandidates, setRelationshipOpener } from "../lib/propertiesWidget";
import { openRelationshipBuilder } from "./RelationshipBuilder";
import { linkTargets } from "../../src/types";
import { createTypedNote, subscribeTypes, typesState } from "../lib/types";
import { useWritingAids } from "../lib/writingAids";
import { findEmoji, loadEmoji } from "../lib/look";
import { folding, foldHeadings, unfoldEverything } from "../lib/folding";
import { formatKeymap, type Mark, runMark } from "../lib/format";
import { selectionToolbar } from "../lib/selectionToolbar";
import { previewContent } from "../lib/hoverPreview";
import { getPlace, setPlace } from "../lib/places";
import { navigate, noteUrl } from "../lib/router";
import { formatDate, isoDay, splitTemplate } from "../lib/templates";
import { prepareImage } from "../lib/resizeImage";
import { iconElement } from "../ui/Icon";
import { chooseDialog, promptDialog, toast, toastError } from "../ui/overlays";

export interface EditorHandle {
  focus(): void;
  /** Focus with the cursor at the start of the text below any properties, so the properties
   *  panel stays a panel (a cursor inside frontmatter shows it as YAML). */
  focusBody(): void;
  jumpToLine(line: number): void;
  /** Go back to where this note was left on this device; false if there's nowhere to go. */
  restorePlace(): boolean;
  /** Fold every heading's section, leaving the outline; unfold everything. */
  foldHeadings(): void;
  unfoldAll(): void;
  wrap(before: string, after?: string): void;
  /** Bold, italic and the rest: wrap the selection, or unwrap it if it already is (format.ts). */
  toggleMark(mark: Mark): void;
  /** Link the selected words to a note or a web address, asking which. */
  linkSelection(): Promise<void>;
  insertLinePrefix(prefix: string): void;
  /** Make the cursor's line a heading, list item, to-do or quote, replacing any such prefix. */
  setBlock(prefix: string): void;
  /** Insert at the cursor; with `complete`, open autocompletion after (for [[ and #). */
  insert(text: string, complete?: boolean): void;
  /** The selected text, or (with nothing selected) the cursor's line without its list, to-do or
   *  heading markup, with where it sits; null if that's empty. */
  selectedOrLine(): { text: string; from: number; to: number } | null;
  /** Replace a range, as one undoable change. */
  replaceRange(from: number, to: number, text: string): void;
  /** Upload files (e.g. photos picked on a phone) and embed them at the cursor. */
  insertFiles(files: File[]): void;
  /** Focus "Add property" in the properties panel, creating empty frontmatter if there is none. */
  addProperty(): void;
  /** Add relationship… (F27): how this note relates to another, as a property. */
  addRelationship(): void;
  /** Set a property (null removes it), making the frontmatter if there is none. */
  setProperty(key: string, value: PropValue): void;
  /**
   * Insert a filled-in template at the cursor. Its properties join the note's (ones the note
   * already has are kept), so there is never a second frontmatter block.
   */
  insertTemplate(text: string): void;
  /** Insert a CodeMirror snippet (${placeholders}, Tab between them) at the cursor. */
  snippet(template: string): void;
  undo(): void;
  redo(): void;
  /** Where the cursor is. */
  cursor(): number;
  /** Colour the selection (or the word at the cursor): text or highlight, or null to remove (F10). */
  colour(kind: "text" | "highlight", name: ColourName | null): void;
  /** Show `el` (the `@name` chat box) as a block under the line at `pos`, or hide it (null). It
   *  stays with that line as the text around it changes. */
  showInline(pos: number | null, el?: HTMLElement): void;
}

interface Props {
  ytext: Y.Text;
  /** Comments (L3): where each open thread's words are now. */
  commentRanges?: { id: number; from: number; to: number }[];
  awareness: Awareness;
  readOnly: boolean;
  /** Live Preview: markdown renders in place except on the cursor's lines. */
  livePreview: boolean;
  vaultId: number;
  notes: () => NoteSummary[];
  /** Changes whenever the note list does (e.g. the array itself), so links re-resolve. */
  notesVersion?: unknown;
  tags: () => string[];
  onOpenLink: (target: string, newNote: boolean) => void;
  /** This note defines a type (F16): its frontmatter is edited in the type editor instead. */
  typeNote?: boolean;
  /** The note being edited, so embeds can't show it inside itself. */
  noteId?: number;
  /** Focus mode: keep the cursor's line in the middle of the screen as you type. */
  typewriter?: boolean;
  /** The note's words, and the selection's (0 with nothing selected), as they change. */
  onStats?: (stats: { words: number; selected: number }) => void;
  /** Where to keep the cursor and scroll position (web/lib/places.ts); restorePlace() goes back. */
  placeKey?: string;
}

/** Typewriter scrolling: after each move or keystroke, scroll the cursor's line to the middle. */
const typewriterScroll = EditorView.updateListener.of((u) => {
  if (!(u.selectionSet || u.docChanged) || !u.view.hasFocus) return;
  const head = u.state.selection.main.head;
  queueMicrotask(() => u.view.dispatch({ effects: EditorView.scrollIntoView(head, { y: "center" }) }));
});

// A line's block markup: heading, list item, to-do or quote (with its indent).
const BLOCK_PREFIX = /^(\s*)((?:#{1,6} |[-*+] \[[ xX]\] |[-*+] |\d+[.)] |> ?)?)/;

const FM_BLOCK = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// Spelling and grammar help (web/lib/writingAids.ts). CodeMirror switches off spell check,
// autocorrect, capitals and writing suggestions for the whole note, which also silences the
// iPhone keyboard's help and Grammarly. A note is mostly prose, so they're on, except in code,
// the properties at the top, inline code and links, which are marked to be left alone.
const LEAVE_ALONE = { spellcheck: "false", autocorrect: "off", autocapitalize: "off", writingsuggestions: "false" };
const leaveLine = Decoration.line({ attributes: LEAVE_ALONE });
const leaveMark = Decoration.mark({ attributes: LEAVE_ALONE });
function notProse(view: EditorView) {
  const out: Range<Decoration>[] = [];
  const { state } = view;
  const lines = (from: number, to: number) => {
    for (let l = state.doc.lineAt(from); ; l = state.doc.line(l.number + 1)) {
      out.push(leaveLine.range(l.from));
      if (l.to >= to || l.number === state.doc.lines) break;
    }
  };
  const head = FM_BLOCK.exec(state.doc.sliceString(0, Math.min(state.doc.length, 200_000)));
  if (head) lines(0, head[0].length - 1);
  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from,
      to,
      enter: (n) => {
        if (/^(FencedCode|CodeBlock|HTMLBlock)$/.test(n.name)) return void lines(n.from, n.to);
        if (/^(InlineCode|URL|Autolink)$/.test(n.name) && n.to > n.from) out.push(leaveMark.range(n.from, n.to));
      },
    });
  }
  return Decoration.set(out, true);
}
const writingAids = [
  EditorView.contentAttributes.of({ spellcheck: "true", autocorrect: "on", autocapitalize: "sentences", writingsuggestions: "true" }),
  ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      constructor(view: EditorView) {
        this.decorations = notProse(view);
      }
      update(u: ViewUpdate) {
        if (u.docChanged || u.viewportChanged || syntaxTree(u.startState) !== syntaxTree(u.state)) this.decorations = notProse(u.view);
      }
    },
    { decorations: (v) => v.decorations },
  ),
];

// `#Person Sam Okafor` (F26). Choosing "New Person…" from the # menu leaves `#Person ` and
// remembers where its # is; while the cursor stays on that line after it, what follows is the new
// note's title, offered as "New Person “Sam Okafor”". A tag that happens to share a type's name
// never turns into a note on its own: only a choice from the menu starts this.
const setTypedHash = StateEffect.define<{ at: number; type: string } | null>();
const typedHash = StateField.define<{ at: number; type: string } | null>({
  create: () => null,
  update(v, tr) {
    for (const e of tr.effects) if (e.is(setTypedHash)) return e.value;
    if (!v) return v;
    const at = tr.changes.mapPos(v.at, 1);
    const head = tr.state.selection.main.head;
    const prefix = `#${v.type} `;
    if (tr.state.sliceDoc(at, at + prefix.length) !== prefix || head < at + prefix.length || tr.state.doc.lineAt(head).number !== tr.state.doc.lineAt(at).number) return null;
    return { at, type: v.type };
  },
});

// The `@name` chat box sits under its line as a block widget. The element is NoteView's (React
// renders into it), moved into whichever wrapper CodeMirror draws, so it survives redraws.
const setInline = StateEffect.define<{ pos: number; el: HTMLElement } | null>();
class InlineHost extends WidgetType {
  constructor(readonly el: HTMLElement) {
    super();
  }
  eq(o: InlineHost) {
    return o.el === this.el;
  }
  toDOM() {
    const wrap = document.createElement("div");
    wrap.className = "cm-ai-inline";
    wrap.appendChild(this.el);
    return wrap;
  }
  ignoreEvent() {
    return true;
  }
}
type Inline = { pos: number; el: HTMLElement; deco: ReturnType<typeof Decoration.set> } | null;
const inlineField = StateField.define<Inline>({
  create: () => null,
  update(v, tr) {
    let next: { pos: number; el: HTMLElement } | null = v;
    for (const e of tr.effects) if (e.is(setInline)) next = e.value;
    if (!next) return null;
    if (next === v && !tr.docChanged) return v;
    const pos = next === v ? tr.changes.mapPos(v!.pos, -1) : Math.min(next.pos, tr.state.doc.length);
    const at = tr.state.doc.lineAt(pos).to;
    return { pos, el: next.el, deco: Decoration.set([Decoration.widget({ widget: new InlineHost(next.el), block: true, side: 1 }).range(at)]) };
  },
  provide: (f) => EditorView.decorations.from(f, (v) => v?.deco ?? Decoration.none),
});

const highlight = HighlightStyle.define([
  { tag: t.heading1, fontSize: "1.6em", fontWeight: "700" },
  { tag: t.heading2, fontSize: "1.4em", fontWeight: "700" },
  { tag: t.heading3, fontSize: "1.2em", fontWeight: "650" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "650" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--accent)" },
  { tag: t.url, color: "var(--muted)" },
  { tag: t.monospace, fontFamily: "var(--mono)", color: "var(--code)" },
  { tag: t.quote, color: "var(--muted)", fontStyle: "italic" },
  { tag: [t.processingInstruction, t.meta, t.contentSeparator], color: "var(--faint)" },
]);

const wikiMarks = new MatchDecorator({ regexp: /!?\[\[[^\[\]\n]+?\]\]/g, decoration: Decoration.mark({ class: "cm-wikilink" }) });
const wikiPlugin = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = wikiMarks.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = wikiMarks.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);
const tagMarks = new MatchDecorator({ regexp: /(?<=^|\s)#[\p{L}_\-/][\p{L}\p{N}_\-/]*/gu, decoration: Decoration.mark({ class: "cm-tag" }) });
const tagPlugin = ViewPlugin.fromClass(
  class {
    decorations;
    constructor(view: EditorView) {
      this.decorations = tagMarks.createDeco(view);
    }
    update(u: ViewUpdate) {
      this.decorations = tagMarks.updateDeco(u, this.decorations);
    }
  },
  { decorations: (v) => v.decorations },
);

function linkAt(state: EditorState, pos: number) {
  const line = state.doc.lineAt(pos);
  for (const l of findWikiLinks(line.text)) {
    if (pos >= line.from + l.from && pos <= line.from + l.to) return l;
  }
  return null;
}


/** A range copied from a spreadsheet (two rows or more) pasted into prose becomes a Markdown
 *  table, on lines of its own; inside code it stays as it was copied. */
function pasteRange(e: ClipboardEvent, view: EditorView): boolean {
  const grid = parseGrid(e.clipboardData?.getData("text/plain") ?? "");
  if (!grid || grid.length < 2 || grid[0]!.length < 2 || grid.every((r) => !r[0])) return false;
  const { from, to } = view.state.selection.main;
  for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(view.state).resolveInner(from, -1); n; n = n.parent)
    if (/^(FencedCode|CodeBlock|InlineCode|Table)$/.test(n.name)) return false;
  e.preventDefault();
  const doc = view.state.doc;
  const before = from === doc.lineAt(from).from ? (from > 0 && doc.lineAt(from - 1).text.trim() ? "\n" : "") : "\n\n";
  const atEnd = to === doc.lineAt(to).to;
  const after = atEnd && to === doc.length ? "\n" : atEnd && !doc.lineAt(to + 1).text.trim() ? "" : "\n\n";
  const insert = before + formatTable(tableFromGrid(grid)) + after;
  // The cursor goes below the table (onto the blank line already there), so it shows as a grid.
  view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + insert.length + (after ? 0 : 1) }, userEvent: "input.paste", scrollIntoView: true });
  return true;
}

/** Comments (L3): the words each open thread is on, marked; the marks move with edits, and the
 *  note sets them again whenever its comments change (web/lib/comments.ts finds them). */
const setCommentMarks = StateEffect.define<{ id: number; from: number; to: number }[]>();
const commentMarks = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(marks, tr) {
    marks = marks.map(tr.changes);
    for (const e of tr.effects)
      if (e.is(setCommentMarks)) {
        const len = tr.state.doc.length;
        marks = Decoration.set(
          e.value
            .filter((r) => r.from < r.to && r.to <= len)
            .sort((a, b) => a.from - b.from)
            .map((r) => Decoration.mark({ class: "cm-commented", attributes: { "data-comment": String(r.id) } }).range(r.from, r.to)),
        );
      }
    return marks;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Who's signed in, for leaving yourself out of the @ list (F39). */
let myId: Promise<number | null> | undefined;

export const Editor = forwardRef<EditorHandle, Props>(function Editor(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const placeReady = useRef(false);
  const undoRef = useRef<Y.UndoManager | null>(null);
  const roCompartment = useRef(new Compartment());
  const lpCompartment = useRef(new Compartment());
  const twCompartment = useRef(new Compartment());
  const waCompartment = useRef(new Compartment());
  const aids = useWritingAids();
  const uploadRef = useRef<((view: EditorView, files: File[]) => Promise<void>) | null>(null);
  const lpRef = useRef<ReturnType<typeof livePreview> | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;

  // The relationship builder (F31), with the notes this one links to offered first. Only refs, so
  // the properties widget can keep the one it was given.
  const openBuilder = () => {
    const v = viewRef.current;
    const id = propsRef.current.noteId;
    if (!v || v.state.readOnly || !id) return;
    const body = v.state.doc.sliceString(0, Math.min(v.state.doc.length, 200_000)).replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
    openRelationshipBuilder({ vaultId: propsRef.current.vaultId, notes: propsRef.current.notes(), from: id, linked: linkTargets(body).map((t) => t.split("/").pop()!) });
  };
  useImperativeHandle(ref, () => ({
    focus: () => viewRef.current?.focus(),
    focusBody() {
      const v = viewRef.current;
      // Not before the text has arrived: a cursor parked at 0 would stay inside the properties.
      if (!v || !v.state.doc.length) return;
      const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(v.state.doc.toString());
      if (fm && v.state.selection.main.head === 0) {
        // The end of the first line of text: right where the properties end still counts as
        // touching them, which would show them as YAML.
        const doc = v.state.doc;
        let to = -1;
        for (let n = doc.lineAt(Math.min(fm[0].length, doc.length)).number; n <= doc.lines && to < 0; n++) {
          const line = doc.line(n);
          if (line.from >= fm[0].length && line.text.trim()) to = line.to;
        }
        if (to < 0) return; // only properties: leave them as a panel
        v.dispatch({ selection: { anchor: to } });
      }
      v.focus();
    },
    foldHeadings() {
      if (viewRef.current && !foldHeadings(viewRef.current)) toast("No headings to fold");
    },
    unfoldAll() {
      if (viewRef.current) unfoldEverything(viewRef.current);
    },
    restorePlace() {
      const v = viewRef.current;
      const key = propsRef.current.placeKey;
      placeReady.current = true;
      const p = key ? getPlace(key) : null;
      if (!v || !p || !v.state.doc.length) return false;
      const len = v.state.doc.length;
      v.dispatch({ selection: { anchor: Math.min(p.anchor, len), head: Math.min(p.head, len) } });
      // After CodeMirror has measured the text, or the scroll lands short.
      v.requestMeasure({ read: () => null, write: () => void (v.scrollDOM.scrollTop = p.top) });
      return true;
    },
    jumpToLine(line) {
      const v = viewRef.current;
      if (!v) return;
      const l = v.state.doc.line(Math.min(line + 1, v.state.doc.lines));
      v.dispatch({ selection: { anchor: l.from }, effects: EditorView.scrollIntoView(l.from, { y: "start", yMargin: 40 }) });
      v.focus();
    },
    toggleMark(mark) {
      const v = viewRef.current;
      if (!v) return;
      runMark(v, mark);
      v.focus();
    },
    async linkSelection() {
      const v = viewRef.current;
      if (!v) return;
      const sel = v.state.selection.main;
      const words = v.state.sliceDoc(sel.from, sel.to).trim();
      if (!words || words.includes("\n")) return void toast("Select some words on one line to link them");
      const notes = propsRef.current.notes();
      const WEB = "\u0000web";
      const pick = await chooseDialog({
        title: `Link “${words.length > 40 ? `${words.slice(0, 40)}…` : words}” to…`,
        placeholder: "Find a note…",
        options: [
          { value: WEB, label: "A web address…", icon: "globe" },
          ...notes.filter((n) => !isTypePath(n.path)).map((n) => ({ value: String(n.id), label: n.title, hint: n.path.includes("/") ? n.path.replace(/\/[^/]+$/, "") : undefined })),
        ],
      });
      if (pick === null) return;
      let text: string;
      if (pick === WEB) {
        const url = await promptDialog({ title: "Link to a web address", label: "Address", placeholder: "https://", action: "Link" });
        if (!url) return;
        text = `[${words.replace(/[[\]]/g, "\\$&")}](${/^[a-z][\w+.-]*:/i.test(url) ? url : `https://${url}`})`;
      } else {
        const n = notes.find((x) => String(x.id) === pick);
        if (!n) return;
        const target = linkTextFor(notes, n);
        text = target.toLowerCase() === words.toLowerCase() ? `[[${target}]]` : `[[${target}|${words.replace(/[|\]]/g, " ")}]]`;
      }
      // The selection's spaces stay where they were.
      const raw = v.state.sliceDoc(sel.from, sel.to);
      const from = sel.from + (raw.length - raw.trimStart().length);
      v.dispatch({ changes: { from, to: from + words.length, insert: text }, selection: { anchor: from + text.length }, userEvent: "input.format" });
      v.focus();
    },
    wrap(before, after = before) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch(
        v.state.changeByRange((r) => ({
          changes: [
            { from: r.from, insert: before },
            { from: r.to, insert: after },
          ],
          range: EditorSelection.range(r.from + before.length, r.to + before.length),
        })),
      );
      v.focus();
    },
    insertLinePrefix(prefix) {
      const v = viewRef.current;
      if (!v) return;
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      const has = line.text.startsWith(prefix);
      v.dispatch({ changes: has ? { from: line.from, to: line.from + prefix.length } : { from: line.from, insert: prefix } });
      v.focus();
    },
    setBlock(prefix) {
      const v = viewRef.current;
      if (!v) return;
      const line = v.state.doc.lineAt(v.state.selection.main.head);
      // Keep the indent (a nested list item stays nested); swap only the markup after it.
      const [, indent = "", old = ""] = BLOCK_PREFIX.exec(line.text) ?? [];
      const from = line.from + indent.length;
      v.dispatch({ changes: { from, to: from + old.length, insert: prefix }, selection: { anchor: line.to - old.length + prefix.length } });
      v.focus();
    },
    selectedOrLine() {
      const v = viewRef.current;
      if (!v) return null;
      const sel = v.state.selection.main;
      if (!sel.empty) {
        const raw = v.state.sliceDoc(sel.from, sel.to);
        const lead = raw.length - raw.trimStart().length;
        const text = raw.trim();
        return text ? { text, from: sel.from + lead, to: sel.from + lead + text.length } : null;
      }
      const line = v.state.doc.lineAt(sel.head);
      const [prefix = ""] = BLOCK_PREFIX.exec(line.text) ?? [];
      const text = line.text.slice(prefix.length).trim();
      if (!text) return null;
      const from = line.from + prefix.length + (line.text.slice(prefix.length).length - line.text.slice(prefix.length).trimStart().length);
      return { text, from, to: from + text.length };
    },
    replaceRange(from, to, text) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ changes: { from, to, insert: text }, selection: { anchor: from + text.length } });
      v.focus();
    },
    insert(text, complete) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch(v.state.replaceSelection(text));
      v.focus();
      if (complete) startCompletion(v);
    },
    insertFiles(files) {
      const v = viewRef.current;
      if (v && files.length) void uploadRef.current?.(v, files);
    },
    addProperty() {
      const v = viewRef.current;
      if (!v || v.state.readOnly) return;
      if (frontmatterYaml(v.state.doc.sliceString(0, 200_000)) === null) {
        const fm = "---\n\n---\n";
        v.dispatch({ changes: { from: 0, insert: fm }, selection: { anchor: fm.length } });
      }
      requestAnimationFrame(() => v.dom.querySelector<HTMLInputElement>(".prop-new-key")?.focus());
    },
    setProperty(key, value) {
      const v = viewRef.current;
      if (!v || v.state.readOnly) return;
      const head = v.state.doc.sliceString(0, Math.min(v.state.doc.length, 200_000));
      const yaml = frontmatterYaml(head);
      if (yaml === null) {
        if (value !== null) v.dispatch({ changes: { from: 0, insert: `---\n${setProp("", key, value).trimEnd()}\n---\n` }, userEvent: "input.properties" });
        return;
      }
      const start = head.indexOf("\n") + 1;
      const c = minimalChange(yaml, value === null ? deleteProp(yaml, key) : setProp(yaml, key, value));
      if (c) v.dispatch({ changes: { from: start + c.from, to: start + c.to, insert: c.insert }, userEvent: "input.properties" });
    },
    addRelationship: openBuilder,
    insertTemplate(text) {
      const v = viewRef.current;
      if (!v || v.state.readOnly) return;
      const { yaml, body } = splitTemplate(text);
      const doc = v.state.doc.toString();
      const head = FM_BLOCK.exec(doc);
      // Body goes at the cursor, but never inside the frontmatter.
      let at = v.state.selection.main.head;
      if (head && at < head[0].length) at = doc.length;
      const changes: { from: number; to?: number; insert: string }[] = [];
      if (yaml !== null && yaml.trim()) {
        if (head) {
          const mine = head[1]!;
          let merged = mine;
          for (const p of readProps(yaml) ?? []) if (!(readProps(merged) ?? []).some((q) => q.key === p.key)) merged = setProp(merged, p.key, p.value);
          const c = minimalChange(mine, merged);
          const start = head[0].indexOf("\n") + 1;
          if (c) changes.push({ from: start + c.from, to: start + c.to, insert: c.insert });
        } else changes.push({ from: 0, insert: `---\n${yaml}\n---\n` });
      }
      const sep = at > 0 && doc[at - 1] !== "\n" ? "\n" : "";
      changes.push({ from: at, insert: sep + body });
      v.dispatch({ changes, scrollIntoView: true, userEvent: "input.template" });
      v.focus();
    },
    snippet(template) {
      const v = viewRef.current;
      if (!v || v.state.readOnly) return;
      const { from, to } = v.state.selection.main;
      snippet(template)(v, null, from, to);
      v.focus();
    },
    undo: () => undoRef.current?.undo(),
    redo: () => undoRef.current?.redo(),
    cursor: () => viewRef.current?.state.selection.main.head ?? 0,
    colour(kind, name) {
      const v = viewRef.current;
      if (!v || v.state.readOnly) return;
      let { from, to } = v.state.selection.main;
      if (from === to) {
        const w = v.state.wordAt(from);
        if (!w) return void toast("Select some text to colour first");
        ({ from, to } = w);
      }
      // A selection inside coloured text takes the whole coloured run: one colour per run.
      const line = v.state.doc.lineAt(from);
      if (to <= line.to) {
        for (const m of line.text.matchAll(/<(mark|span|font)\b[^>]*>[^<]*<\/\1>|==\{[a-z]+\}[^=\n]*==/gi)) {
          const a = line.from + m.index!;
          const b = a + m[0].length;
          if (a <= from && b >= to && stripColour(m[0]) !== m[0]) {
            from = a;
            to = b;
            break;
          }
        }
      }
      const plain = stripColour(v.state.sliceDoc(from, to));
      const insert = name ? wrapColour(plain, kind, name) : plain;
      const start = name ? from + insert.indexOf(">") + 1 : from;
      v.dispatch({ changes: { from, to, insert }, selection: { anchor: start, head: start + plain.length }, userEvent: "input.colour" });
      v.focus();
    },
    showInline(pos, el) {
      const v = viewRef.current;
      if (!v) return;
      v.dispatch({ effects: [setInline.of(pos === null || !el ? null : { pos, el }), ...(pos === null ? [] : [EditorView.scrollIntoView(pos, { y: "nearest", yMargin: 220 })])] });
    },
  }));

  useEffect(() => {
    const { ytext, awareness } = props;
    const undoManager = new Y.UndoManager(ytext);
    undoRef.current = undoManager;

    // Close the link, unless closeBrackets already put "]]" after the cursor.
    const closeLink = (view: EditorView, from: number, to: number, text: string) => {
      const insert = view.state.sliceDoc(to, to + 2) === "]]" ? text : `${text}]]`;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + text.length + 2 } });
    };
    const wikilinkCompletions = async (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/!?\[\[[^\]\n]*/);
      if (!m) return null;
      const start = m.from + m.text.indexOf("[[") + 2;
      const typed = ctx.state.sliceDoc(start, ctx.pos);
      const notes = propsRef.current.notes();
      // [[Note#: that note's headings ([[#: this note's own).
      const hash = typed.indexOf("#");
      if (hash >= 0 && !typed.includes("|")) {
        const target = typed.slice(0, hash);
        const md = !target ? ctx.state.doc.toString() : await noteText(resolveLocal(notes, target));
        if (md === null) return null;
        return {
          from: start + hash + 1,
          filter: true,
          options: headings(md).map((h) => ({
            label: h.text,
            detail: "#".repeat(h.level),
            apply: (view: EditorView, _c: unknown, from: number, to: number) => closeLink(view, from, to, h.text),
          })),
        };
      }
      if (typed.includes("|")) return null;
      return {
        from: start,
        filter: true,
        options: notes.flatMap((n) => {
          const label = linkTextFor(notes, n);
          const folder = n.path.includes("/") ? n.path.replace(/\/[^/]+$/, "") : undefined;
          return [
            { label, detail: folder, apply: (view: EditorView, _c: unknown, from: number, to: number) => closeLink(view, from, to, label) },
            // Each alias finds the note too, and is kept as the link's words: [[Note|alias]].
            ...(n.names ?? []).map((alias) => ({
              label: alias,
              detail: `→ ${n.title}`,
              boost: -1,
              apply: (view: EditorView, _c: unknown, from: number, to: number) => closeLink(view, from, to, `${label}|${alias}`),
            })),
          ];
        }),
      };
    };
    // Another note's text, for its headings; kept briefly so each keystroke doesn't fetch it.
    const noteTexts = new Map<number, { at: number; md: Promise<string | null> }>();
    const noteText = (n: NoteSummary | undefined): Promise<string | null> => {
      if (!n) return Promise.resolve(null);
      const hit = noteTexts.get(n.id);
      if (hit && Date.now() - hit.at < 30_000) return hit.md;
      const md = api<{ content: string }>(`/vaults/${propsRef.current.vaultId}/notes/${n.id}`).then(
        (x) => x.content,
        () => null,
      );
      noteTexts.set(n.id, { at: Date.now(), md });
      return md;
    };
    const tagCompletions = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|\s)#[\p{L}\p{N}_\-/]*/u);
      if (!m) return null;
      const from = m.from + m.text.indexOf("#") + 1;
      const tags = propsRef.current.tags().map((tag) => ({ label: tag, type: "keyword" }));
      if (propsRef.current.readOnly || !inProse(ctx, from - 1)) return { from, options: tags };
      // Each type, as "New Person…" (F26): it leaves `#Person ` for the title to follow.
      const types = typesState().types.map((t) => ({
        label: t.name,
        displayLabel: `New ${t.name}…`,
        type: t.icon,
        boost: -1,
        apply: (view: EditorView, _c: unknown, a: number, b: number) =>
          view.dispatch({ changes: { from: a, to: b, insert: `${t.name} ` }, selection: { anchor: a + t.name.length + 1 }, effects: setTypedHash.of({ at: a - 1, type: t.name }) }),
      }));
      return { from, options: [...tags, ...types] };
    };

    // The title after a chosen `#Person ` (F26): Enter makes the note and leaves a link to it.
    const typedTitleCompletions = (ctx: CompletionContext) => {
      const pending = ctx.state.field(typedHash, false);
      if (!pending || propsRef.current.readOnly) return null;
      const type = typesState().types.find((t) => t.name === pending.type);
      const start = pending.at + pending.type.length + 2;
      if (!type || ctx.pos < start) return null;
      const title = ctx.state
        .sliceDoc(start, ctx.pos)
        .replace(/[*_`~=[\]|#]/g, "")
        .replace(/[\\/:]/g, "-")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 120);
      if (!title) return null;
      const existing = propsRef.current.notes().find((n) => n.title.toLowerCase() === title.toLowerCase());
      return {
        from: pending.at,
        filter: false,
        options: [
          {
            label: ctx.state.sliceDoc(pending.at, ctx.pos),
            displayLabel: existing ? `Link to “${existing.title}”` : `New ${type.name} “${title}”`,
            type: type.icon,
            apply: (view: EditorView, _c: unknown, a: number, b: number) => {
              const vaultId = propsRef.current.vaultId;
              // Its own undo step, so Undo brings back `#Person Sam Okafor` rather than the typing before it.
              undoManager.stopCapturing();
              view.dispatch({ changes: { from: a, to: b, insert: `[[${existing?.title ?? title}]]` }, effects: setTypedHash.of(null), userEvent: "input.complete" });
              undoManager.stopCapturing();
              if (existing) return void toast(`Linked to the note “${existing.title}” that was already there`, { action: { label: "Open", run: () => navigate(noteUrl(vaultId, existing.id)) } });
              createTypedNote(vaultId, type, title).then(
                (made) => toast(`Made ${type.name} “${title}”`, { action: { label: "Open", run: () => navigate(noteUrl(vaultId, made.id)) } }),
                toastError,
              );
            },
          },
        ],
      };
    };

    // Menus that open as you type (/ and @) only in prose: not in code, frontmatter or a URL.
    const inProse = (ctx: CompletionContext, at: number) => {
      const head = FM_BLOCK.exec(ctx.state.doc.sliceString(0, Math.min(ctx.state.doc.length, 200_000)));
      if (head && at < head[0].length) return false;
      for (let n: ReturnType<ReturnType<typeof syntaxTree>["resolveInner"]> | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent) {
        if (/^(FencedCode|CodeBlock|InlineCode|CodeText|HTMLBlock|URL)$/.test(n.name)) return false;
      }
      return true;
    };

    // The `/` menu (web/lib/commands.ts): at the start of a line or after a space ("a/b" and
    // "https://" don't start with a space). A space closes it.
    const slashCompletions = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|[\s(])\/[\p{L}\p{N}-]*/u);
      if (!m || propsRef.current.readOnly) return null;
      const slash = m.from + m.text.indexOf("/");
      if (!inProse(ctx, slash)) return null;
      const q = ctx.state.sliceDoc(slash + 1, ctx.pos);
      const cmds = available("slash")
        .map((c) => ({ c, s: q ? Math.max(fuzzyScore(q, c.title) + 50, fuzzyScore(q, `${c.title} ${c.keywords ?? ""}`)) : 0 }))
        .filter((x) => x.s > -Infinity)
        .sort((a, b) => b.s - a.s);
      if (!cmds.length) return null;
      return {
        from: slash,
        filter: false,
        options: cmds.map(({ c }, i) => ({
          label: c.title,
          boost: -i,
          type: c.icon,
          apply: (view: EditorView, _c: unknown, from: number, to: number) => {
            view.dispatch({ changes: { from, to, insert: "" } }); // drop the "/query"
            c.run(currentCtx());
          },
        })),
      };
    };

    // `//` picks a date (F28, as Confluence does): today, tomorrow, the coming weekdays, or the
    // picker, written as YYYY-MM-DD. After a space or at a line's start, so "https://" never does.
    const dateCompletions = (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|[\s(])\/\/[\p{L}\p{N} -]*/u);
      if (!m || propsRef.current.readOnly) return null;
      const at = m.from + m.text.indexOf("//");
      if (!inProse(ctx, at)) return null;
      const day = (n: number) => {
        const d = new Date();
        d.setDate(d.getDate() + n);
        return d;
      };
      const put = (text: string) => (view: EditorView, _c: unknown, _from: number, to: number) => view.dispatch({ changes: { from: at, to, insert: text }, selection: { anchor: at + text.length } });
      const days: [string, Date][] = [["Today", day(0)], ["Tomorrow", day(1)], ["Yesterday", day(-1)]];
      for (let n = 2; n <= 7; n++) days.push([`${n === 7 ? "Next " : ""}${formatDate(day(n), "dddd")}`, day(n)]);
      return {
        from: at + 2,
        options: [
          ...days.map(([label, d], i) => ({ label, detail: isoDay(d), boost: -i, type: "calendar", apply: put(isoDay(d)) })),
          {
            label: "Pick a date…",
            boost: -99,
            type: "calendar",
            apply: (view: EditorView, _c: unknown, _from: number, to: number) => {
              view.dispatch({ changes: { from: at, to, insert: "" } });
              const e = currentCtx().note?.editor;
              if (e) void pickDate(e);
            },
          },
        ],
      };
    };

    // `:name` suggests emoji (F28): after a space or at a line's start, so times (10:30) and
    // `:status[` never do, from two letters, inserting the emoji itself.
    const emojiCompletions = async (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|[\s(]):[a-z][a-z0-9_+-]+/i);
      if (!m || propsRef.current.readOnly) return null;
      const at = m.from + m.text.indexOf(":");
      if (!inProse(ctx, at) || /^:status$/i.test(ctx.state.sliceDoc(at, ctx.pos))) return null;
      const hits = findEmoji(await loadEmoji(), ctx.state.sliceDoc(at + 1, ctx.pos), 30);
      if (!hits.length) return null;
      return {
        from: at,
        filter: false,
        options: hits.map((e, i) => ({
          label: `${e.char} ${e.name}`,
          boost: -i,
          apply: (view: EditorView, _c: unknown, from: number, to: number) => view.dispatch({ changes: { from, to, insert: e.char }, selection: { anchor: from + e.char.length } }),
        })),
      };
    };

    // `@name` opens a chat with one of your AI assistants at that line (F13), or mentions one of the
    // collection's people (F39), who's told under the bell. Only after a space
    // or at the start of a line, so an email address (a@b.com) never does.
    const mentionCompletions = async (ctx: CompletionContext) => {
      const m = ctx.matchBefore(/(?:^|[\s(])@[\p{L}\p{N}]*/u);
      // Without assistants to offer (the standalone file has no server), `@` is just a letter.
      if (!m || propsRef.current.readOnly || !available().some((c) => c.id === "ai.add")) return null;
      const at = m.from + m.text.indexOf("@");
      if (!inProse(ctx, at)) return null;
      const list = await loadAssistants().catch(() => cachedAssistants());
      // F39: the collection's other members too; choosing one writes @Name, which tells them.
      myId ??= api<{ user: { id: number } | null }>("/session").then((s) => s.user?.id ?? null, () => null);
      const me = await myId;
      const people = (await api<{ id: number; name: string }[]>(`/vaults/${propsRef.current.vaultId}/members`).catch(() => [])).filter((p) => p.id !== me);
      const remove = (view: EditorView, from: number, to: number) => view.dispatch({ changes: { from, to, insert: "" } });
      return {
        from: at,
        filter: true,
        options: [
          ...people.map((p) => ({
            label: `@${p.name}`,
            detail: "tell them",
            type: "user",
            boost: 1,
            apply: `@${p.name} `,
          })),
          ...list.map((a) => ({
            label: `@${a.name}`,
            detail: a.model,
            type: "sparkle",
            apply: (view: EditorView, _c: unknown, from: number, to: number) => {
              remove(view, from, to);
              currentCtx().note?.askHere(a);
            },
          })),
          {
            label: list.length ? "@ Add an AI assistant…" : "@ Bring your own AI…",
            type: "plus",
            boost: -99,
            apply: (view: EditorView, _c: unknown, from: number, to: number) => {
              remove(view, from, to);
              currentCtx().app?.addAssistant();
            },
          },
        ],
      };
    };

    // Hover preview (web/lib/hoverPreview.ts): rest the pointer on a [[link]] to see the note.
    const linkPreview = hoverTooltip(
      async (view, pos) => {
        const l = linkAt(view.state, pos);
        if (!l || (l.embed && /\.\w{2,4}$/.test(l.target) && !/\.md$/i.test(l.target))) return null;
        const body = await previewContent(propsRef.current.vaultId, propsRef.current.notes(), l.target);
        if (!body) return null;
        const line = view.state.doc.lineAt(pos);
        return {
          pos: line.from + l.from,
          end: line.from + l.to,
          above: false,
          create: () => {
            const dom = document.createElement("div");
            dom.className = "hover-preview";
            dom.appendChild(body);
            return { dom };
          },
        };
      },
      { hoverTime: 500 },
    );

    const linkTooltip = StateField.define<readonly Tooltip[]>({
      create: (s) => tooltipsFor(s),
      update: (tips, tr) => (tr.docChanged || tr.selection ? tooltipsFor(tr.state) : tips),
      provide: (f) => showTooltip.computeN([f], (s) => s.field(f)),
    });
    function tooltipsFor(state: EditorState): readonly Tooltip[] {
      const sel = state.selection.main;
      if (!sel.empty) return [];
      const l = linkAt(state, sel.head);
      if (!l || (l.embed && /\.\w{2,4}$/.test(l.target) && !/\.md$/i.test(l.target))) return [];
      const line = state.doc.lineAt(sel.head);
      return [
        {
          pos: line.from + l.from,
          above: true,
          arrow: false,
          create: () => {
            // CodeMirror styles the tooltip element itself, so the button goes inside it.
            const dom = document.createElement("div");
            dom.className = "cm-open-link-tip";
            const btn = dom.appendChild(document.createElement("button"));
            btn.className = "cm-open-link";
            btn.textContent = `Open ${l.target} ↗`;
            btn.onmousedown = (e) => e.preventDefault();
            btn.onclick = () => propsRef.current.onOpenLink(l.target, false);
            return { dom };
          },
        },
      ];
    }

    const uploadAndInsert = async (view: EditorView, files: File[]) => {
      for (const original of files) {
        const file = await prepareImage(original);
        const form = new FormData();
        const ext = file.type.split("/")[1]?.replace("jpeg", "jpg") ?? "png";
        // A pasted picture has no name of its own ("image.png"): call it after the note, which
        // the server numbers if taken ("Kitchen plan 1.png").
        const title = propsRef.current.notes().find((n) => n.id === propsRef.current.noteId)?.title;
        const base = (title ?? "Pasted image").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim() || "Pasted image";
        const name = file.name && !/^image\.\w+$/i.test(file.name) ? file.name : `${base}.${ext}`;
        form.append("file", file, name);
        try {
          const { path } = await api<{ path: string }>(`/vaults/${propsRef.current.vaultId}/files`, { form });
          view.dispatch(view.state.replaceSelection(`![[${path}]]\n`));
        } catch (err) {
          toastError(err);
        }
      }
    };

    uploadRef.current = uploadAndInsert;

    const lp = livePreview(
      { vaultId: props.vaultId, notes: () => propsRef.current.notes(), typeNote: () => !!propsRef.current.typeNote, noteId: () => propsRef.current.noteId ?? null },
      (target, newNote) => propsRef.current.onOpenLink(target, newNote),
    );

    placeReady.current = false;
    // Word count: the whole note's after typing pauses, the selection's at once.
    let statsTimer: ReturnType<typeof setTimeout> | undefined;
    let words = 0;
    const reportStats = (v: EditorView, docChanged: boolean) => {
      const send = () => {
        // The properties at the top aren't words of the note, selected or not.
        const sel = v.state.selection.main;
        const from = Math.max(sel.from, FM_BLOCK.exec(v.state.sliceDoc(0, Math.min(v.state.doc.length, 20_000)))?.[0].length ?? 0);
        propsRef.current.onStats?.({ words, selected: sel.empty || from >= sel.to ? 0 : countWords(v.state.sliceDoc(from, sel.to)) });
      };
      if (!docChanged) return send();
      clearTimeout(statsTimer);
      statsTimer = setTimeout(() => {
        words = countWords(v.state.doc.toString().replace(FM_BLOCK, ""));
        send();
      }, 300);
    };
    // Where you are, once the note has been put back where it was (or there was nowhere).
    // The key is this note's, kept from when it opened: by the time the editor closes, the props
    // may already be the next note's.
    const placeKey = props.placeKey;
    let placeTimer: ReturnType<typeof setTimeout> | undefined;
    const writePlace = (v: EditorView) => {
      clearTimeout(placeTimer);
      placeTimer = undefined;
      const sel = v.state.selection.main;
      if (placeKey) setPlace(placeKey, { anchor: sel.anchor, head: sel.head, top: Math.round(v.scrollDOM.scrollTop) });
    };
    const savePlace = (v: EditorView) => {
      if (!placeKey || !placeReady.current) return;
      clearTimeout(placeTimer);
      placeTimer = setTimeout(() => writePlace(v), 400);
    };

    const view = new EditorView({
      parent: host.current!,
      state: EditorState.create({
        doc: ytext.toString(),
        extensions: [
          roCompartment.current.of([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
          commentMarks,
          formatKeymap,
          keymap.of([...closeBracketsKeymap, ...yUndoManagerKeymap, ...completionKeymap, ...searchKeymap, ...defaultKeymap, indentWithTab]),
          drawSelection(),
          dropCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightSelectionMatches(),
          // Without the frontmatter wrapper, lezer reads "key: value\n---" as a setext heading.
          yamlFrontmatter({ content: markdown({ base: markdownLanguage, codeLanguages: codeLanguage }) }),
          syntaxHighlighting(highlight),
          syntaxHighlighting(classHighlighter), // code blocks, coloured by markdown.css's tok-* rules
          EditorView.lineWrapping,
          // A name for screen readers (and axe): the text box is the note.
          EditorView.contentAttributes.of({ "aria-label": "Note text" }),
          placeholder("Start writing…  / for blocks, [[ links a note, # adds a tag"),
          autocompletion({
            override: [typedTitleCompletions, wikilinkCompletions, tagCompletions, slashCompletions, dateCompletions, emojiCompletions, mentionCompletions],
            icons: false,
            activateOnTyping: true,
            // The `/` menu's options carry an icon name in `type`; draw it with the app's icons.
            addToOptions: [{ render: (c) => (c.type ? iconElement(c.type) : null), position: 20 }],
          }),
          typedHash,
          wikiPlugin,
          tagPlugin,
          lpCompartment.current.of(props.livePreview ? lp : []),
          twCompartment.current.of(props.typewriter ? typewriterScroll : []),
          waCompartment.current.of(aids ? writingAids : []),
          linkTooltip,
          matchMedia("(hover: hover)").matches ? linkPreview : [],
          folding(),
          selectionToolbar(),
          inlineField,
          EditorView.updateListener.of((u) => {
            if (u.docChanged || u.selectionSet) reportStats(u.view, u.docChanged);
            if (u.selectionSet) savePlace(u.view);
          }),
          EditorView.domEventHandlers({ scroll: (_e, v) => void savePlace(v) }),
          blockHandle({
            ytext,
            awareness,
            title: () => {
              const notes = propsRef.current.notes();
              const n = notes.find((x) => x.id === propsRef.current.noteId);
              return n ? linkTextFor(notes, n) : null;
            },
            makeTyped: {
              can: () => !!COMMANDS.find((c) => c.id === "note.typed")?.when(currentCtx()),
              run: () => COMMANDS.find((c) => c.id === "note.typed")?.run(currentCtx()),
            },
          }),
          yCollab(ytext, awareness, { undoManager }),
          EditorView.domEventHandlers({
            mousedown(e, view) {
              if (!(e.metaKey || e.ctrlKey)) return false;
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              const l = pos == null ? null : linkAt(view.state, pos);
              if (!l) return false;
              e.preventDefault();
              propsRef.current.onOpenLink(l.target, e.shiftKey);
              return true;
            },
            paste(e, view) {
              if (propsRef.current.readOnly) return false;
              const files = [...(e.clipboardData?.files ?? [])];
              if (!files.length) return pasteRange(e, view);
              e.preventDefault();
              void uploadAndInsert(view, files);
              return true;
            },
            drop(e, view) {
              const files = [...(e.dataTransfer?.files ?? [])];
              if (!files.length || propsRef.current.readOnly) return false;
              e.preventDefault();
              const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
              if (pos != null) view.dispatch({ selection: { anchor: pos } });
              void uploadAndInsert(view, files);
              return true;
            },
          }),
        ],
      }),
    });
    viewRef.current = view;
    // A new view (another note, or the same one again): put its comment marks straight back.
    if (propsRef.current.commentRanges?.length) view.dispatch({ effects: setCommentMarks.of(propsRef.current.commentRanges) });
    lpRef.current = lp;
    reportStats(view, true);
    return () => {
      clearTimeout(statsTimer);
      if (placeTimer) writePlace(view); // a move just before leaving the note
      view.destroy();
      undoManager.destroy();
      viewRef.current = null;
    };
  }, [props.ytext, props.awareness]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: roCompartment.current.reconfigure([EditorState.readOnly.of(props.readOnly), EditorView.editable.of(!props.readOnly)]),
    });
  }, [props.readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) });
  }, [props.notesVersion]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: setCommentMarks.of(props.commentRanges ?? []) });
  }, [props.commentRanges]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: twCompartment.current.reconfigure(props.typewriter ? typewriterScroll : []) });
  }, [props.typewriter]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: waCompartment.current.reconfigure(aids ? writingAids : []) });
  }, [aids]);

  // Typed notes' properties panels (F16): redraw when types change; relations pick from notes.
  useEffect(() => setRelationshipOpener(openBuilder), []);
  useEffect(() => {
    setRelationCandidates((type) =>
      propsRef.current
        .notes()
        .filter((n) => !type || (n.type ?? "").toLowerCase() === type.toLowerCase())
        .map((n) => ({ title: n.title, folder: n.path.includes("/") ? n.path.replace(/\/[^/]+$/, "") : undefined })),
    );
    return subscribeTypes(() => viewRef.current?.dispatch({ effects: refreshLivePreview.of(null) }));
  }, []);

  useEffect(() => {
    if (lpRef.current) viewRef.current?.dispatch({ effects: lpCompartment.current.reconfigure(props.livePreview ? lpRef.current : []) });
  }, [props.livePreview]);

  return <div className={`editor${props.livePreview ? " live-preview" : ""}`} ref={host} />;
});
