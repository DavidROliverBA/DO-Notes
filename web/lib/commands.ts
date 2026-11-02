// Every action in one list (docs/PRINCIPLES.md §1–2). The ⌘K palette shows all that apply, the
// note's ⋯ menu shows those marked `noteMenu`, and the editor's `/` menu those marked `slash`,
// so an action is named, iconed and behaves the same wherever it's found.
//
// Screens publish what they can do with provide(): App the app-wide actions, the sidebar its
// own, an open note its actions and editor. It's module state, so CodeMirror (outside React)
// can read it too.

import type { BoardActions } from "../components/Board";
import type { EditorHandle } from "../components/Editor";
import type { Assistant } from "./ai";
import { panel } from "./aiPanel";
import type { Mode } from "../components/NoteView";
import { formatDate, isoDay } from "./templates";
import { chooseDialog, promptDialog, toast, toastError } from "../ui/overlays";
import { STATUS_COLOURS, statusMarkdown } from "../../src/blocks";
import { PALETTE } from "./colours";
import { openHelp } from "./help";
import { exportAixf } from "./aixf";
import { openSettings } from "./settings";
import { fullWidthOn, setFullWidth } from "./editorWidth";
import { MARKS } from "./format";
import { focusModeOn, setFocusMode } from "./focusMode";
import { typesState } from "./types";
import { newJournalEntry } from "./journal";
import { getTheme, setTheme } from "./theme";
import { setWritingAids, writingAidsOn } from "./writingAids";
import { pickCover, pickIcon } from "./look";
import { bringInLandscape, floeConnected, insertFloeDiagram } from "./floe";

/** Colour the selection (F10): pick a text colour, a highlight, or none. */
async function pickColour(e: EditorHandle) {
  const choice = await chooseDialog({
    title: "Colour",
    options: [
      ...PALETTE.map((p) => ({ value: `highlight:${p.name}`, label: `${p.label} highlight`, swatch: `hl-${p.name}` })),
      ...PALETTE.map((p) => ({ value: `text:${p.name}`, label: `${p.label} text`, swatch: `tc-${p.name}` })),
      { value: "none", label: "Remove colour", icon: "x" },
    ],
    placeholder: "Red, yellow highlight, none…",
  });
  if (!choice) return;
  if (choice === "none") return e.colour("text", null);
  const [kind, name] = choice.split(":") as ["text" | "highlight", any];
  e.colour(kind, name);
}

/** Status (F28): its words, then its colour. */
async function pickStatus(e: EditorHandle) {
  const label = await promptDialog({ title: "Status", label: "Says", placeholder: "In progress", action: "Next" });
  if (!label?.trim()) return;
  const colour = await chooseDialog({
    title: `“${label.trim()}”: colour`,
    options: STATUS_COLOURS.map((c) => ({ value: c, label: c[0]!.toUpperCase() + c.slice(1), swatch: `status-swatch status-${c}` })),
    placeholder: "Green, amber, red…",
  });
  if (colour) e.insert(statusMarkdown(label.trim(), colour as (typeof STATUS_COLOURS)[number]));
}

/** Date (F28): the browser's date picker, written as YYYY-MM-DD. Also `//` as you type. */
export async function pickDate(e: EditorHandle) {
  const day = await promptDialog({ title: "Date", value: isoDay(new Date()), action: "Insert", input: "date" });
  if (day && /^\d{4}-\d{2}-\d{2}$/.test(day)) e.insert(day);
}

export interface AppActions {
  canWrite: boolean;
  findNote(): void;
  search(): void;
  graph(): void;
  /** The graph page centred on the open note (null when no note is open). */
  graphHere: (() => void) | null;
  /** Every task in the vault. */
  tasks(): void;
  journal(): void;
  home(): void;
  today(): void;
  newNote(): void;
  newFromTemplate(): void;
  /** F16: a note of a type (asks which, then the title), and a new type. */
  newTyped(type?: string): void;
  newType(): void;
  /** A new, empty board (F11). */
  newBoard(): void;
  /** Save a web page as a Weblink note. */
  saveLink(): void;
  isAdmin: boolean;
  trash(): void;
  toggleLeft(): void;
  toggleRight(): void;
  /** Open a note by path or title; its title, or null if there's no such note. */
  openNote(target: string): string | null;
  /** The guided tour (web/lib/tour.ts): the whole thing, or what's new since this device looked. */
  tour(kind: "full" | "new"): void;
  /** The AI side panel (⌘J). */
  askAi(): void;
  /** F24: import a Day One export into this collection's journal. */
  importDayOne(): void;
  /** F24: the assistant, given the last seven days of the journal. */
  reflect(): void;
  /** /boyai: add an assistant. */
  addAssistant(): void;
  exportHref: string;
  /** The open collection's id. */
  vaultId: number;
  /** F22: this server can keep collections in folders on the Mac. */
  folders: boolean;
  /** New vault from GitHub (F14). */
  newGitVault(): void;
  /** On a GitHub vault: its branch. */
  git: GitActions | null;
}
export interface GitActions {
  pushed: boolean;
  hasPr: boolean;
  changes: number;
  unpushed: number;
  review(): void;
  pullRequest(): void;
  update(): void;
  cancel(): void;
  /** Changes go on their own (F19), and whether that's paused. */
  auto: boolean;
  paused: boolean;
  sendNow(): void;
  setPaused(paused: boolean): void;
}
export interface SidebarActions {
  newFolder(): void;
}
export interface NoteActions {
  readOnly: boolean;
  /** F30 step 4: send this Weblink note's address to Longview (only when it's on). */
  sendToLongview?(): void;
  /** F41: a note of a landscape brought in from Floe: update it, open it in Floe. */
  floe?: { update(): void; open: (() => void) | null };
  /** F41: the note has Floe diagram blocks; refresh them from Floe. */
  floeDiagrams?(): void;
  /** F38: share this note by link, or manage its link. */
  shareLink?(): void;
  /** L3: comment on the selected words (absent for viewers and the standalone file). */
  comment?(): void;
  /** F39: whether you follow this note, and following or not. */
  following?: boolean;
  setFollowing?(on: boolean): void;
  mode: Mode;
  narrow: boolean;
  editor: EditorHandle | null;
  downloadHref: string;
  setMode(m: Mode): void;
  history(): void;
  copyLink(): void;
  /** Its AI-XF id (F9), if it has one. */
  aixfId: string | null;
  rename(): void;
  moveTo(): void;
  /** Copy or move it to another of your vaults; `canSend` when there's one you can add to. */
  sendTo(move: boolean): void;
  canSend: boolean;
  trash(): void;
  pickPicture(): void;
  insertTemplate(): void;
  /** Star it in the sidebar (F7), or unstar it. */
  bookmark(): void;
  bookmarked: boolean;
  /** The `@name` chat box at the cursor: with this assistant, else the last one used. */
  askHere(a?: Assistant): void;
  /** Turn the selection (or the line) into a note of a type, leaving a link in its place. */
  makeTyped(): void;
  vaultId: number;
  /** Its look (F28): the emoji icon, the cover property as written, and the page width. */
  look: { icon: string | null; cover: string | null; width: "wide" | "full" | null };
}
export interface Ctx {
  app: AppActions | null;
  sidebar: SidebarActions | null;
  note: NoteActions | null;
  /** An open board (F11). */
  board: BoardActions | null;
}

const ctx: Ctx = { app: null, sidebar: null, note: null, board: null };
// The standalone file (standalone/) has no server, so it offers only the commands that work
// without one: offerOnly() names them, and every list below leaves the rest out.
let only: Set<string> | null = null;
export const offerOnly = (ids: string[]) => void (only = new Set(ids));
const offered = (c: Command) => !only || only.has(c.id);
/** A screen publishes what it can do now (null when it can't); commands read it at run time. */
export function provide<K extends keyof Ctx>(key: K, value: Ctx[K]): void {
  ctx[key] = value;
}
export const currentCtx = (): Ctx => ctx;

export type Group = "Insert" | "Note" | "Create" | "Go" | "View" | "Collection" | "Settings" | "Help";

export interface Command {
  id: string;
  title: string;
  group: Group;
  icon?: string;
  /** More words to find it by. */
  keywords?: string;
  /** Shown beside it, e.g. ⌘O. */
  shortcut?: string;
  /** In the editor's `/` menu. */
  slash?: boolean;
  /** In the note's ⋯ menu (in list order). */
  noteMenu?: boolean;
  danger?: boolean;
  /** A link (downloads) rather than an action. */
  href?: (c: Ctx) => string;
  when(c: Ctx): boolean;
  run(c: Ctx): void;
}

// Conditions.
const writable = (c: Ctx) => !!c.note && !c.note.readOnly;
const editing = (c: Ctx) => writable(c) && c.note!.mode !== "read" && !!c.note!.editor;
const live = (c: Ctx) => editing(c) && c.note!.mode === "edit";
const ed = (c: Ctx) => c.note!.editor!;
const canCreate = (c: Ctx) => !!c.app?.canWrite;

/** Editor inserts, for the `/` menu and the palette. */
const insert = (id: string, title: string, icon: string, keywords: string, run: (e: EditorHandle) => void): Command => ({
  id: `insert.${id}`,
  title,
  group: "Insert",
  icon,
  keywords,
  slash: true,
  when: editing,
  run: (c) => run(ed(c)),
});

export const COMMANDS: Command[] = [
  // ── Insert (the `/` menu) ──────────────────────────────────────────────────────────────
  insert("h1", "Heading 1", "heading", "title h1 #", (e) => e.setBlock("# ")),
  insert("h2", "Heading 2", "heading", "subtitle h2 ##", (e) => e.setBlock("## ")),
  insert("h3", "Heading 3", "heading", "h3 ###", (e) => e.setBlock("### ")),
  insert("bullets", "Bulleted list", "list", "ul unordered points -", (e) => e.setBlock("- ")),
  insert("numbers", "Numbered list", "list-ordered", "ol ordered 1.", (e) => e.setBlock("1. ")),
  insert("todo", "To-do", "check", "task checkbox [ ]", (e) => e.setBlock("- [ ] ")),
  insert("quote", "Quote", "quote", "blockquote >", (e) => e.setBlock("> ")),
  insert("callout", "Callout", "callout", "admonition note tip warning info box", (e) => e.snippet("> [!${note}] ${Title}\n> ${}")),
  insert("table", "Table", "table", "grid columns rows", (e) => e.snippet("| ${Column} | ${Column} |\n| --- | --- |\n| ${} |  |\n")),
  insert("code", "Code block", "code", "snippet pre fence ```", (e) => e.snippet("```${language}\n${}\n```")),
  insert("divider", "Divider", "divider", "rule hr line ---", (e) => e.snippet("---\n${}")),
  insert("link", "Link to a note", "link", "wikilink [[ internal", (e) => e.insert("[[", true)),
  insert("tag", "Tag", "tag", "label #", (e) => e.insert("#", true)),
  insert("status", "Status", "flag", "lozenge label badge pill state progress done", (e) => void pickStatus(e)),
  insert("date", "Date", "calendar", "day today when picker //", (e) => void pickDate(e)),
  insert("toc", "Table of contents", "list", "toc contents headings outline [toc]", (e) => e.snippet("[TOC]\n${}")),
  { ...insert("floe", "Floe diagram…", "graph", "floe architecture c4 mermaid diagram landscape system context", (e) => void insertFloeDiagram(e)), when: (c) => editing(c) && floeConnected() },
  // Inline formatting (web/lib/format.ts): each toggles, so the same key takes it off again.
  ...MARKS.map(
    (m): Command => ({
      id: `format.${m.label.toLowerCase().replace(/\s+/g, "-")}`,
      title: m.label,
      group: "Insert",
      icon: m.mark === "`" ? "code" : "text",
      keywords: `format style ${m.mark} ${m.label === "Strikethrough" ? "strike cross out" : m.label === "Highlight" ? "mark ==" : ""}`,
      shortcut: m.key?.replace("Mod-Shift-", "⌘⇧").replace("Mod-", "⌘").toUpperCase(),
      when: editing,
      run: (c) => ed(c).toggleMark(m.mark),
    }),
  ),
  { id: "format.link", title: "Link…", group: "Insert", icon: "link", keywords: "hyperlink url web address wikilink selected words", when: editing, run: (c) => void ed(c).linkSelection() },
  {
    id: "format.colour",
    title: "Colour…",
    group: "Insert",
    icon: "sparkle",
    keywords: "color colour highlight highlighter text red yellow green blue mark",
    shortcut: "⌘⇧H",
    when: editing,
    run: (c) => void pickColour(ed(c)),
  },
  insert("date", "Today's date", "calendar", "now day iso", (e) => e.insert(formatDate(new Date(), "YYYY-MM-DD"))),
  insert("time", "Current time", "clock", "now hour", (e) => e.insert(formatDate(new Date(), "HH:mm"))),
  {
    id: "insert.picture",
    title: "Insert picture",
    group: "Insert",
    icon: "image",
    keywords: "photo image camera upload attachment",
    slash: true,
    noteMenu: true,
    when: editing,
    run: (c) => c.note!.pickPicture(),
  },
  {
    id: "insert.template",
    title: "Insert template…",
    group: "Insert",
    icon: "template",
    keywords: "boilerplate snippet",
    slash: true,
    noteMenu: true,
    when: editing,
    run: (c) => c.note!.insertTemplate(),
  },
  {
    id: "insert.property",
    title: "Add property",
    group: "Insert",
    icon: "list",
    keywords: "frontmatter yaml metadata field",
    slash: true,
    noteMenu: true,
    when: live,
    run: (c) => ed(c).addProperty(),
  },
  {
    id: "insert.relationship",
    title: "Add relationship",
    group: "Insert",
    icon: "link",
    keywords: "relation parent child part of depends supersedes ai-xf",
    slash: true,
    noteMenu: true,
    when: live,
    run: (c) => ed(c).addRelationship(),
  },

  {
    id: "insert.ai",
    title: "Ask AI here",
    group: "Insert",
    icon: "sparkle",
    keywords: "assistant claude chat @ write summarise",
    slash: true,
    when: editing,
    run: (c) => c.note!.askHere(),
  },
  {
    id: "ai.add",
    title: "Add an AI assistant",
    group: "Collection",
    icon: "sparkle",
    keywords: "boyai bring your own ai key claude openai model",
    slash: true,
    when: (c) => !!c.app,
    run: (c) => c.app!.addAssistant(),
  },

  // ── This note (the ⋯ menu) ─────────────────────────────────────────────────────────────
  { id: "note.source", title: "Source mode", group: "View", icon: "code", keywords: "markdown raw", noteMenu: true, when: (c) => writable(c) && c.note!.mode !== "source", run: (c) => c.note!.setMode("source") },
  { id: "note.live", title: "Live preview", group: "View", icon: "edit", keywords: "edit wysiwyg", noteMenu: true, when: (c) => writable(c) && c.note!.mode !== "edit", run: (c) => c.note!.setMode("edit") },
  { id: "note.split", title: "Edit and preview side by side", group: "View", icon: "split", keywords: "split", when: (c) => writable(c) && !c.note!.narrow && c.note!.mode !== "split", run: (c) => c.note!.setMode("split") },
  { id: "note.read", title: "Reading view", group: "View", icon: "book", keywords: "preview read only", when: (c) => !!c.note && c.note.mode !== "read", run: (c) => c.note!.setMode("read") },
  { id: "note.typed", title: "Turn into a typed note…", group: "Note", icon: "sparkle", keywords: "convert make person task project object type extract link new note from selection line", when: (c) => writable(c) && typesState().types.length > 0, run: (c) => c.note!.makeTyped() },
  { id: "note.floe-update", title: "Update from Floe", group: "Note", icon: "arrow-down", keywords: "floe landscape architecture refresh sync pull", noteMenu: true, when: (c) => !!c.note?.floe && writable(c), run: (c) => c.note!.floe!.update() },
  { id: "note.floe-open", title: "Open in Floe", group: "Note", icon: "globe", keywords: "floe landscape architecture model", noteMenu: true, when: (c) => !!c.note?.floe?.open, run: (c) => c.note!.floe!.open!() },
  { id: "note.floe-diagrams", title: "Update Floe diagrams", group: "Note", icon: "graph", keywords: "floe mermaid c4 refresh diagram", noteMenu: true, when: (c) => !!c.note?.floeDiagrams && writable(c), run: (c) => c.note!.floeDiagrams!() },
  { id: "note.longview", title: "Send to Longview…", group: "Note", icon: "send", keywords: "longview save url article knowledge base weblink", noteMenu: true, when: (c) => !!c.note?.sendToLongview, run: (c) => c.note!.sendToLongview!() },
  { id: "note.share", title: "Share by link…", group: "Note", icon: "globe", keywords: "public read only page send someone url private link", noteMenu: true, when: (c) => !!c.note?.shareLink, run: (c) => c.note!.shareLink!() },
  { id: "note.comment", title: "Comment…", group: "Note", icon: "edit", keywords: "comment note remark discuss reply annotate feedback", noteMenu: true, when: (c) => !!c.note?.comment, run: (c) => c.note!.comment!() },
  { id: "note.follow", title: "Follow this note", group: "Note", icon: "eye", keywords: "watch notify subscribe changes tell me", noteMenu: true, when: (c) => !!c.note?.setFollowing && !c.note.following, run: (c) => c.note!.setFollowing!(true) },
  { id: "note.unfollow", title: "Stop following", group: "Note", icon: "eye", keywords: "unwatch unsubscribe notify", noteMenu: true, when: (c) => !!c.note?.setFollowing && !!c.note.following, run: (c) => c.note!.setFollowing!(false) },
  { id: "note.history", title: "Version history", group: "Note", icon: "history", keywords: "revisions restore undo old", noteMenu: true, when: (c) => !!c.note, run: (c) => c.note!.history() },
  { id: "note.download", title: "Download .md", group: "Note", icon: "download", keywords: "export markdown file", noteMenu: true, when: (c) => !!c.note, href: (c) => c.note!.downloadHref, run: (c) => void (location.href = c.note!.downloadHref) },
  { id: "note.bookmark", title: "Bookmark", group: "Note", icon: "bookmark", keywords: "star favourite pin sidebar", noteMenu: true, when: (c) => !!c.note && !c.note.bookmarked, run: (c) => c.note!.bookmark() },
  { id: "note.unbookmark", title: "Remove bookmark", group: "Note", icon: "bookmark", keywords: "unstar favourite pin", noteMenu: true, when: (c) => !!c.note && c.note.bookmarked, run: (c) => c.note!.bookmark() },
  { id: "note.copyid", title: "Copy the note's id", group: "Note", icon: "copy", keywords: "ai-xf identifier stable clipboard", noteMenu: true, when: (c) => !!c.note?.aixfId, run: (c) => void navigator.clipboard?.writeText(c.note!.aixfId!).then(() => toast("Id copied"), toastError) },
  { id: "note.copylink", title: "Copy wikilink", group: "Note", icon: "link", keywords: "clipboard [[", noteMenu: true, when: (c) => !!c.note, run: (c) => c.note!.copyLink() },
  { id: "note.rename", title: "Rename", group: "Note", icon: "edit", keywords: "title name", noteMenu: true, when: writable, run: (c) => c.note!.rename() },
  { id: "note.icon", title: "Icon…", group: "Note", icon: "sparkle", keywords: "emoji page icon symbol", noteMenu: true, when: editing, run: (c) => void pickIcon(ed(c), c.note!.look.icon) },
  { id: "note.cover", title: "Cover picture…", group: "Note", icon: "image", keywords: "banner header image page cover", noteMenu: true, when: editing, run: (c) => void pickCover(c.note!.vaultId, ed(c), c.note!.look.cover) },
  { id: "note.foldheadings", title: "Fold all headings", group: "Note", icon: "chevron", keywords: "collapse outline sections hide", when: (c) => !!c.note?.editor && c.note.mode !== "read", run: (c) => c.note!.editor!.foldHeadings() },
  { id: "note.unfold", title: "Unfold all", group: "Note", icon: "chevron", keywords: "expand open sections show folded", when: (c) => !!c.note?.editor && c.note.mode !== "read", run: (c) => c.note!.editor!.unfoldAll() },
  { id: "note.wide", title: "Wide page", group: "Note", icon: "panel", keywords: "width full wider page layout", when: (c) => editing(c) && !c.note!.look.width, run: (c) => ed(c).setProperty("width", "wide") },
  { id: "note.narrow", title: "Normal page width", group: "Note", icon: "panel", keywords: "width narrow page layout", when: (c) => editing(c) && !!c.note!.look.width, run: (c) => ed(c).setProperty("width", null) },
  { id: "note.move", title: "Move to…", group: "Note", icon: "folder", keywords: "file folder organise", noteMenu: true, when: writable, run: (c) => c.note!.moveTo() },
  { id: "note.copyvault", title: "Copy to another collection…", group: "Note", icon: "copy", keywords: "vault duplicate collection repo github send", noteMenu: true, when: (c) => !!c.note?.canSend, run: (c) => c.note!.sendTo(false) },
  { id: "note.movevault", title: "Move to another collection…", group: "Note", icon: "vault", keywords: "vault transfer collection repo github send", noteMenu: true, when: (c) => writable(c) && c.note!.canSend, run: (c) => c.note!.sendTo(true) },
  { id: "note.trash", title: "Move to Trash", group: "Note", icon: "trash", keywords: "delete remove", noteMenu: true, danger: true, when: writable, run: (c) => c.note!.trash() },

  // ── Create, go, vault (the palette) ────────────────────────────────────────────────────
  { id: "create.note", title: "New note", group: "Create", icon: "plus", shortcut: "⌥N", keywords: "add page", when: canCreate, run: (c) => c.app!.newNote() },
  { id: "create.template", title: "New note from template", group: "Create", icon: "template", when: canCreate, run: (c) => c.app!.newFromTemplate() },
  { id: "create.board", title: "New board", group: "Create", icon: "graph", keywords: "canvas whiteboard visual cards map heptabase scrintal mind", when: canCreate, run: (c) => c.app!.newBoard() },
  { id: "board.text", title: "Add a text card", group: "Note", icon: "text", keywords: "board canvas card write", when: (c) => !!c.board && writable(c), run: (c) => c.board!.addText() },
  { id: "board.note", title: "Add a note to the board…", group: "Note", icon: "file", keywords: "board canvas card existing", when: (c) => !!c.board && writable(c), run: (c) => c.board!.addNote() },
  { id: "board.newnote", title: "New note on the board…", group: "Note", icon: "plus", keywords: "board canvas card create", when: (c) => !!c.board && writable(c), run: (c) => c.board!.newNote() },
  { id: "board.link", title: "Add a link card…", group: "Note", icon: "globe", keywords: "board canvas card web url", when: (c) => !!c.board && writable(c), run: (c) => c.board!.addLink() },
  { id: "board.group", title: "Group on the board…", group: "Note", icon: "rows", keywords: "board canvas section frame", when: (c) => !!c.board && writable(c), run: (c) => c.board!.addGroup() },
  { id: "board.fit", title: "Fit the board", group: "View", icon: "width", keywords: "board canvas zoom all show", when: (c) => !!c.board, run: (c) => c.board!.fit() },
  { id: "board.tidy", title: "Tidy up the board", group: "Note", icon: "columns", keywords: "board canvas arrange overlap grid snap layout", when: (c) => !!c.board && writable(c), run: (c) => c.board!.tidy() },
  { id: "board.mindmap", title: "Mind map from the selected card", group: "Note", icon: "branch", keywords: "board canvas layout tree arrange", when: (c) => !!c.board?.hasSelection && writable(c), run: (c) => c.board!.mindMap() },
  { id: "board.remove", title: "Remove from the board", group: "Note", icon: "trash", keywords: "board canvas delete card arrow", when: (c) => !!c.board && (c.board.hasSelection || c.board.hasArrow) && writable(c), run: (c) => c.board!.remove() },
  { id: "board.front", title: "Bring to front", group: "Note", icon: "arrow-up", keywords: "board canvas order raise top", when: (c) => !!c.board?.hasSelection && writable(c), run: (c) => c.board!.front() },
  { id: "board.back", title: "Send to back", group: "Note", icon: "arrow-down", keywords: "board canvas order lower bottom", when: (c) => !!c.board?.hasSelection && writable(c), run: (c) => c.board!.back() },
  { id: "board.label", title: "Label the arrow…", group: "Note", icon: "tag", keywords: "board canvas edge connection text", when: (c) => !!c.board?.hasArrow && writable(c), run: (c) => c.board!.labelArrow() },
  { id: "board.reverse", title: "Reverse the arrow", group: "Note", icon: "swap", keywords: "board canvas edge direction turn round swap flip", when: (c) => !!c.board?.hasArrow && writable(c), run: (c) => c.board!.reverse() },
  { id: "board.connect", title: "Connect to…", group: "Note", icon: "arrow-right", keywords: "board canvas arrow join edge link card keyboard", when: (c) => !!c.board?.hasSelection && writable(c), run: (c) => c.board!.connect() },
  { id: "board.arrows", title: "Arrows on this board", group: "View", icon: "list", keywords: "board canvas edges list sentences connections screen reader", when: (c) => !!c.board, run: (c) => c.board!.arrows() },
  { id: "board.relation", title: "Make the arrow a relationship…", group: "Note", icon: "link", keywords: "board canvas edge property link type", when: (c) => !!c.board?.relation && writable(c), run: (c) => c.board!.relation!() },
  { id: "create.typed", title: "New note of a type…", group: "Create", icon: "shapes", keywords: "type object person meeting project book thing", when: canCreate, run: (c) => c.app!.newTyped() },
  { id: "create.weblink", title: "Save a web link…", group: "Create", icon: "link", keywords: "url bookmark article page web clip read later weblink", when: canCreate, run: (c) => c.app!.saveLink() },
  { id: "create.type", title: "New type", group: "Create", icon: "shapes", keywords: "type object schema properties define kind", when: canCreate, run: (c) => c.app!.newType() },
  { id: "create.github", title: "New collection from GitHub…", group: "Create", icon: "branch", keywords: "vault repo repository git clone import pull request docs", when: (c) => !!c.app, run: (c) => c.app!.newGitVault() },
  { id: "git.review", title: "Review changes", group: "Collection", icon: "branch", keywords: "github git diff branch changed", when: (c) => !!c.app?.git, run: (c) => c.app!.git!.review() },
  { id: "git.pr", title: "Open pull request", group: "Collection", icon: "pull-request", keywords: "github pr push commit", when: (c) => !!c.app?.canWrite && !!c.app.git && !c.app.git.hasPr && c.app.git.changes > 0, run: (c) => c.app!.git!.pullRequest() },
  { id: "git.push", title: "Push changes to the pull request", group: "Collection", icon: "pull-request", keywords: "github pr commit", when: (c) => !!c.app?.canWrite && !!c.app.git?.hasPr && c.app.git.unpushed > 0, run: (c) => c.app!.git!.pullRequest() },
  { id: "git.send", title: "Send to GitHub now", group: "Collection", icon: "upload", keywords: "github push publish sync automatic", when: (c) => !!c.app?.canWrite && !!c.app.git?.auto, run: (c) => c.app!.git!.sendNow() },
  { id: "git.pause", title: "Pause automatic pushes", group: "Collection", icon: "pause", keywords: "github stop hold sync schedule", when: (c) => !!c.app?.canWrite && !!c.app.git?.auto && !c.app.git.paused, run: (c) => c.app!.git!.setPaused(true) },
  { id: "git.resume", title: "Carry on with automatic pushes", group: "Collection", icon: "play", keywords: "github resume unpause sync schedule", when: (c) => !!c.app?.canWrite && !!c.app.git?.auto && c.app.git.paused, run: (c) => c.app!.git!.setPaused(false) },
  { id: "git.sending", title: "How changes go to GitHub…", group: "Settings", icon: "settings", keywords: "github automatic schedule review sync publish main push", when: (c) => !!c.app?.git, run: () => openSettings("vault") },
  { id: "git.update", title: "Update from GitHub", group: "Collection", icon: "download", keywords: "pull main merge sync fetch", when: (c) => !!c.app?.canWrite && !!c.app.git, run: (c) => c.app!.git!.update() },
  { id: "git.cancel", title: "Cancel the branch", group: "Collection", icon: "undo", keywords: "github discard revert reset", danger: true, when: (c) => !!c.app?.canWrite && !!c.app.git && (c.app.git.changes > 0 || c.app.git.pushed), run: (c) => c.app!.git!.cancel() },
  { id: "create.folder", title: "New folder", group: "Create", icon: "folder-plus", keywords: "directory", when: (c) => canCreate(c) && !!c.sidebar, run: (c) => c.sidebar!.newFolder() },
  { id: "go.today", title: "Today's note", group: "Go", icon: "calendar", keywords: "daily journal", when: (c) => !!c.app, run: (c) => c.app!.today() },
  { id: "go.find", title: "Find a note", group: "Go", icon: "search", shortcut: "⌘O", keywords: "open switcher quick", when: (c) => !!c.app, run: (c) => c.app!.findNote() },
  { id: "go.search", title: "Search", group: "Go", icon: "search", shortcut: "⌘⇧F", keywords: "full text find in notes", when: (c) => !!c.app, run: (c) => c.app!.search() },
  { id: "journal.new", title: "New journal entry", group: "Create", icon: "edit", keywords: "journal diary day one write today reflect entry", noteMenu: true, when: (c) => !!c.app, run: () => newJournalEntry() },
  { id: "journal.reflect", title: "Reflect on this week", group: "Create", icon: "sparkle", keywords: "journal week review summary diary ai assistant think", when: (c) => !!c.app, run: (c) => c.app!.reflect() },
  { id: "journal.import", title: "Import from Day One", group: "Collection", icon: "upload", keywords: "journal diary dayone export json zip", when: (c) => !!c.app?.canWrite, run: (c) => c.app!.importDayOne() },
  { id: "go.journal", title: "Journal", group: "Go", icon: "book", keywords: "diary entries on this day day one", when: (c) => !!c.app, run: (c) => c.app!.journal() },
  { id: "go.tasks", title: "Tasks", group: "Go", icon: "check", keywords: "todo to-do checklist due open done", when: (c) => !!c.app, run: (c) => c.app!.tasks() },
  { id: "go.graph", title: "Graph view", group: "Go", icon: "graph", keywords: "map links network", when: (c) => !!c.app, run: (c) => c.app!.graph() },
  { id: "go.graph.here", title: "This note in the graph", group: "Go", icon: "graph", keywords: "map links network local neighbourhood around", when: (c) => !!c.app?.graphHere, run: (c) => c.app!.graphHere!() },
  { id: "go.home", title: "Collection home", group: "Go", icon: "vault", keywords: "vault start recent", when: (c) => !!c.app, run: (c) => c.app!.home() },
  { id: "view.files", title: "Show or hide the file panel", group: "View", icon: "panel-left", shortcut: "⌘\\", keywords: "sidebar files tree left folders focus", when: (c) => !!c.app, run: (c) => c.app!.toggleLeft() },
  { id: "ai.web.on", title: "Let the AI use the web", group: "View", icon: "globe", keywords: "assistant internet search browse online brave", when: () => !!panel.conv?.assistant.web && !panel.conv.web, run: () => panel.conv!.setWeb(true) },
  { id: "ai.web.off", title: "Stop the AI using the web", group: "View", icon: "globe", keywords: "assistant internet search offline", when: () => !!panel.conv?.web, run: () => panel.conv!.setWeb(false) },
  { id: "view.ai", title: "Ask AI in the side panel", group: "View", icon: "sparkle", shortcut: "⌘J", keywords: "assistant chat claude librarian organise", when: (c) => !!c.app, run: (c) => c.app!.askAi() },
  { id: "view.focus", title: "Focus mode", group: "View", icon: "book", keywords: "zen distraction free writing typewriter hide everything", when: (c) => !!c.note && !focusModeOn(), run: () => setFocusMode(true) },
  { id: "view.unfocus", title: "Leave focus mode", group: "View", icon: "x", keywords: "zen distraction exit", when: (c) => !!c.note && focusModeOn(), run: () => setFocusMode(false) },
  { id: "view.fullwidth", title: "Full-width editor", group: "View", icon: "width", keywords: "wide wider page width fill window stretch layout", when: (c) => !!c.app && !fullWidthOn(), run: () => setFullWidth(true) },
  { id: "view.normalwidth", title: "Normal editor width", group: "View", icon: "width", keywords: "narrow reading width page layout", when: (c) => !!c.app && fullWidthOn(), run: () => setFullWidth(false) },
  { id: "view.theme.auto", title: "Theme: Auto (follow the system)", group: "View", icon: "theme-auto", keywords: "appearance dark light mode system colour scheme", when: () => getTheme() !== "auto", run: () => setTheme("auto") },
  { id: "view.theme.light", title: "Theme: Light", group: "View", icon: "sun", keywords: "appearance light mode day colour scheme", when: () => getTheme() !== "light", run: () => setTheme("light") },
  { id: "view.theme.dark", title: "Theme: Dark", group: "View", icon: "moon", keywords: "appearance dark mode night colour scheme", when: () => getTheme() !== "dark", run: () => setTheme("dark") },
  { id: "view.spelling.off", title: "Turn off spelling and grammar help", group: "View", icon: "x", keywords: "spellcheck spell check autocorrect grammarly suggestions writing", when: () => writingAidsOn(), run: () => setWritingAids(false) },
  { id: "view.spelling.on", title: "Turn on spelling and grammar help", group: "View", icon: "check", keywords: "spellcheck spell check autocorrect grammarly suggestions writing", when: () => !writingAidsOn(), run: () => setWritingAids(true) },
  { id: "view.panel", title: "Show or hide the side panel", group: "View", icon: "panel", keywords: "outline backlinks right sidebar calendar", when: (c) => !!c.note, run: (c) => c.app!.toggleRight() },
  { id: "vault.import", title: "Import markdown", group: "Collection", icon: "upload", keywords: "markdown zip upload", when: canCreate, run: () => openSettings("vault") },
  { id: "vault.aixf", title: "Export collection as AI-XF bundle", group: "Collection", icon: "download", keywords: "ai-xf aixf longview okf bundle export typed links ids", when: (c) => !!c.app, run: (c) => void exportAixf(c.app!.vaultId, c.app!.canWrite) },
  { id: "vault.export", title: "Export collection as .zip", group: "Collection", icon: "download", keywords: "vault download backup markdown", when: (c) => !!c.app, href: (c) => c.app!.exportHref, run: (c) => void (location.href = c.app!.exportHref) },
  { id: "vault.trash", title: "Trash", group: "Collection", icon: "trash", keywords: "deleted restore", when: canCreate, run: (c) => c.app!.trash() },
  // Settings (F17): one command per section, so ⌘K finds a setting by what it's about.
  { id: "settings.open", title: "Settings", group: "Settings", icon: "settings", keywords: "preferences options configure", when: (c) => !!c.app, run: () => openSettings() },
  { id: "settings.account", title: "Account", group: "Settings", icon: "user", keywords: "profile name password sign out log out", when: (c) => !!c.app, run: () => openSettings("account") },
  { id: "settings.vault", title: "Collection settings", group: "Settings", icon: "vault", keywords: "vault this collection members share invite people role rename export leave delete", when: (c) => !!c.app, run: () => openSettings("vault") },
  { id: "settings.folder", title: "Keep in a folder on this Mac", group: "Settings", icon: "folder", keywords: "folder mac disk files markdown obsidian sync local laptop export setup kept", when: (c) => !!c.app?.folders, run: () => openSettings("vault") },
  { id: "settings.site", title: "Publish as a website", group: "Settings", icon: "globe", keywords: "web site publish public page share link unlisted take down unpublish", when: (c) => !!c.app, run: () => openSettings("site") },
  { id: "settings.assistants", title: "AI assistants", group: "Settings", icon: "sparkle", keywords: "bring your own ai key model provider daily limit", when: (c) => !!c.app, run: () => openSettings("assistants") },
  { id: "floe.bring", title: "Bring in a landscape from Floe…", group: "Collection", icon: "download", keywords: "floe architecture landscape c4 systems import model", when: (c) => canCreate(c) && floeConnected(), run: (c) => void bringInLandscape(c.app!.vaultId, (p) => void c.app!.openNote(p)) },
  { id: "settings.connections", title: "Connections", group: "Settings", icon: "link", keywords: "github token claude mcp code agent iphone share shortcut capture", when: (c) => !!c.app, run: () => openSettings("connections") },
  { id: "help.open", title: "Help", group: "Help", icon: "help", keywords: "guide manual how to docs documentation explain learn ?", when: (c) => !!c.app, run: () => openHelp() },
  { id: "help.tour", title: "Take the tour", group: "Help", icon: "lightbulb", keywords: "guided tour walkthrough introduction start learn how welcome", when: (c) => !!c.app, run: (c) => c.app!.tour("full") },
  { id: "help.whatsnew", title: "What's new", group: "Help", icon: "sparkle", keywords: "new features release changes recent updates tour", when: (c) => !!c.app, run: (c) => c.app!.tour("new") },
  { id: "help.shortcuts", title: "Keyboard shortcuts", group: "Help", icon: "help", keywords: "keys hotkeys help", when: (c) => !!c.app, run: () => openHelp("shortcuts") },
  { id: "settings.admin", title: "Admin", group: "Settings", icon: "users", keywords: "accounts users create storage database", when: (c) => !!c.app?.isAdmin, run: () => openSettings("admin") },
];

/** The note's ⋯ menu, in this order. View switches are there only on a phone, where the header
 *  has one Edit/Read toggle instead of the mode buttons. */
const NOTE_MENU = ["note.source", "note.live", "view.focus", "view.unfocus", "journal.new", "note.bookmark", "note.unbookmark", "note.history", "note.download", "note.comment", "note.share", "note.longview", "note.floe-update", "note.floe-open", "note.floe-diagrams", "note.follow", "note.unfollow", "note.copylink", "note.copyid", "insert.property", "insert.relationship", "note.icon", "note.cover", "insert.picture", "insert.template", "note.rename", "note.move", "note.copyvault", "note.movevault", "note.trash"];
export function noteMenu(): Command[] {
  return NOTE_MENU.map((id) => COMMANDS.find((c) => c.id === id)!).filter((c) => offered(c) && c.when(ctx) && (c.group !== "View" || !!ctx.note?.narrow));
}

/** The commands that apply right now, optionally only those for one place. */
export function available(where?: "slash" | "noteMenu"): Command[] {
  return COMMANDS.filter((c) => offered(c) && (where ? c[where] : true) && c.when(ctx));
}
