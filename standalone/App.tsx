// Commonplace as one HTML file: open folders of Markdown files and edit them in the app's own
// editor (web/components/Editor.tsx), with the file panel, wikilinks, backlinks, outline, search,
// the four view modes, the ⌘K palette, bookmarks, saved searches, Today's note, templates, the
// graph and Tasks. No server, no account: the files are the notes (standalone/vault.ts), and
// standalone/api-shim.ts answers what the shared code would ask the server. Several folders can
// be open at once, each a collection; the switcher at the top of the file panel moves between them.

import { useDeferredValue, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Awareness } from "y-protocols/awareness";
import * as Y from "yjs";
import { findWikiLinks, headings, isAttachmentPath, normalisePath } from "../src/markdown";
import type { NoteSummary, Vault } from "../web/lib/api";
import { toggleBookmark, isBookmarked, loadBookmarks, useBookmarks } from "../web/lib/bookmarks";
import { type AppActions, currentCtx, type NoteActions, noteMenu, offerOnly, provide } from "../web/lib/commands";
import { refreshDataview } from "../web/lib/dataview";
import { useFullWidth, setFullWidth } from "../web/lib/editorWidth";
import { hydrate } from "../web/lib/embeds";
import { setFocusMode, useFocusMode } from "../web/lib/focusMode";
import { graphUrl } from "../web/lib/graph";
import { openHelp } from "../web/lib/help";
import { resolveLocal } from "../web/lib/links";
import { coverSrc, emojiIcon } from "../web/lib/look";
import { renderMarkdown, toggleTask } from "../web/lib/render";
import { navigate, noteUrl, parseRoute, usePath } from "../web/lib/router";
import { loadSavedSearches, removeSearch, saveSearch, useSavedSearches } from "../web/lib/savedSearches";
import { pickTemplate } from "../web/lib/templateActions";
import { addDays, dailyDate, dailyPath, dailyTemplatePath, defaultDaily, fillTemplate, formatDate, isoDay } from "../web/lib/templates";
import { CommandPalette } from "../web/components/CommandPalette";
import { Editor, type EditorHandle } from "../web/components/Editor";
import { Graph } from "../web/components/Graph";
import { HelpHost } from "../web/components/Help";
import type { Mode } from "../web/components/NoteView";
import { QuickSwitcher } from "../web/components/QuickSwitcher";
import { TasksPage } from "../web/components/TasksPage";
import { ThemeButton } from "../web/components/ThemeButton";
import { Icon } from "../web/ui/Icon";
import { Menu } from "../web/ui/Menu";
import { confirmDialog, Overlays, promptDialog, toast, toastError } from "../web/ui/overlays";
import { PanelToggle } from "../web/ui/PanelToggle";
import { searchNotes } from "./search";
import * as vault from "./vault";

// What works without a server, in the palette, the ⋯ menu and the / menu. The rest (history,
// sharing, the assistant, types, the journal, GitHub, Settings) stays in the full app.
offerOnly([
  ...["h1", "h2", "h3", "bullets", "numbers", "todo", "quote", "callout", "table", "code", "divider", "link", "tag", "status", "date", "toc", "time", "picture", "template", "property"].map((i) => `insert.${i}`),
  ...["bold", "italic", "strikethrough", "highlight", "code", "link", "colour"].map((i) => `format.${i}`),
  ...["source", "live", "split", "read", "bookmark", "unbookmark", "copylink", "rename", "icon", "cover", "foldheadings", "unfold", "wide", "narrow", "move"].map((i) => `note.${i}`),
  "create.note",
  "create.template",
  ...["today", "find", "search", "tasks", "graph", "graph.here"].map((i) => `go.${i}`),
  ...["files", "focus", "unfocus", "fullwidth", "normalwidth", "theme.auto", "theme.light", "theme.dark", "spelling.off", "spelling.on", "panel"].map((i) => `view.${i}`),
  "help.open",
  "help.shortcuts",
]);

const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(`cp-standalone-${k}`);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(`cp-standalone-${k}`, v);
    } catch {
      // Not kept (private window); it's only a preference.
    }
  },
};

const useNotes = () => useSyncExternalStore(vault.subscribe, vault.allNotes);
const useCurrent = () => useSyncExternalStore(vault.subscribe, vault.vaultId);
const narrow = () => window.matchMedia("(max-width: 820px)").matches;
const noop = () => {};

export function App() {
  const notes = useNotes();
  const vid = useCurrent();
  const route = parseRoute(usePath());
  // The welcome screen shows until a folder is open, and again to open another.
  const [adding, setAdding] = useState(false);
  const [left, setLeft] = useState(() => !narrow());
  const [right, setRight] = useState(() => !narrow() && store.get("right") !== "0");
  const [switcher, setSwitcher] = useState(false);
  const [palette, setPalette] = useState(false);
  const [tab, setTab] = useState<"files" | "search" | "tags">("files");
  const [query, setQuery] = useState("");
  const [ready, setReady] = useState(false);
  const focus = useFocusMode();
  const fullWidth = useFullWidth();

  useEffect(() => vault.onSaveError((e) => toastError(e)), []);
  useEffect(() => void requestAnimationFrame(() => setReady(true)), []);
  // Each folder keeps its own bookmarks and saved searches (in this browser).
  useEffect(() => {
    if (!vid) return;
    void loadBookmarks(vid);
    void loadSavedSearches(vid);
  }, [vid]);

  const here = route.page !== "home" && "vaultId" in route && route.vaultId === vid ? route : null;
  const activeId = here?.page === "note" ? here.noteId : null;

  const openNote = (n: NoteSummary | undefined) => {
    if (!n) return;
    navigate(noteUrl(vault.vaultId(), n.id));
    if (narrow()) setLeft(false);
  };
  const go = (url: string) => (navigate(url), narrow() && setLeft(false));

  /** A folder became current: back to the note it was on, else its last changed note. */
  function opened() {
    setAdding(false);
    setQuery("");
    const all = vault.allNotes();
    const last = all.find((n) => n.path === store.get(`last:${vault.vaultName()}`));
    const n = last ?? [...all].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (n) openNote(n);
    else navigate(`/v/${vault.vaultId()}`);
  }

  useEffect(() => {
    const n = notes.find((x) => x.id === activeId);
    if (n) store.set(`last:${vault.vaultName()}`, n.path);
  }, [activeId, notes]);

  async function newNote(folder = "") {
    const name = await promptDialog({ title: "New note", label: "Title", value: "Untitled", action: "Create" });
    if (!name) return;
    try {
      openNote(await vault.createNote(folder ? `${folder}/${name}` : name, ""));
    } catch (e) {
      toastError(e);
    }
  }

  async function newFromTemplate() {
    try {
      const picked = await pickTemplate(vault.vaultId(), vault.allNotes());
      if (!picked) return;
      const title = await promptDialog({ title: "New note", message: `From the “${picked.note.title}” template`, label: "Title", value: "Untitled", action: "Create note" });
      if (!title) return;
      openNote(await vault.createNote(normalisePath(title), fillTemplate(picked.text, { title, date: new Date() })));
    } catch (e) {
      toastError(e);
    }
  }

  /** A day's note in Daily/: open it, or make it (from Templates/Daily.md when there is one). */
  async function daily(date = new Date()) {
    const path = dailyPath(date);
    const all = vault.allNotes();
    const existing = all.find((n) => n.path.toLowerCase() === path.toLowerCase());
    if (existing) return openNote(existing);
    const tpl = dailyTemplatePath(all.map((n) => n.path));
    const tplNote = tpl ? all.find((n) => n.path === tpl) : undefined;
    const content = tplNote ? fillTemplate(vault.getNote(tplNote.id)?.content ?? "", { title: isoDay(date), date }) : defaultDaily(date);
    try {
      openNote(await vault.createNote(path, content));
    } catch (e) {
      toastError(e);
    }
  }

  /** A [[link]]: open its note, or make it (beside the note it was in) when there isn't one. */
  async function openLink(target: string) {
    const name = target.split("#")[0]!.trim();
    const hit = resolveLocal(vault.allNotes(), name);
    if (hit) return openNote(hit);
    if (!name) return;
    try {
      const from = vault.allNotes().find((n) => n.id === activeId)?.path ?? "";
      const folder = name.includes("/") ? "" : from.replace(/\/?[^/]*$/, "");
      openNote(await vault.createNote(folder ? `${folder}/${name}` : name));
      toast(`Made a new note, ${name}`);
    } catch (e) {
      toastError(e);
    }
  }

  const toggleRight = () => setRight((v) => (store.set("right", v ? "0" : "1"), !v));
  const search = (q?: string) => (q !== undefined && setQuery(q), setLeft(true), setTab("search"));

  // What the app can do, for ⌘K (web/lib/commands.ts). Server features are never offered
  // (offerOnly above), so their actions are left empty.
  const app: AppActions = {
    canWrite: true,
    findNote: () => setSwitcher(true),
    search: () => search(),
    graph: () => go(graphUrl(vid)),
    graphHere: activeId ? () => go(graphUrl(vid, { note: activeId })) : null,
    tasks: () => go(`/v/${vid}/tasks`),
    journal: noop,
    home: noop,
    today: () => void daily(),
    newNote: () => void newNote(),
    newFromTemplate: () => void newFromTemplate(),
    newTyped: noop,
    newType: noop,
    newBoard: noop,
    saveLink: noop,
    isAdmin: false,
    trash: noop,
    toggleLeft: () => setLeft((v) => !v),
    toggleRight,
    openNote: (t) => {
      const hit = resolveLocal(vault.allNotes(), t);
      if (hit) openNote(hit);
      return hit?.title ?? null;
    },
    tour: noop,
    askAi: noop,
    importDayOne: noop,
    reflect: noop,
    addAssistant: noop,
    exportHref: "",
    vaultId: 0,
    folders: false,
    newGitVault: noop,
    git: null,
  };
  useEffect(() => {
    provide("app", vault.isOpen() ? app : null);
  });

  // ⌘K the palette, ⌘O opens a note by name, ⌘\ the file panel, ⌘S saves now, ⌘⇧F search.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape" && document.documentElement.querySelector(".app.focus-mode") && !document.querySelector(".modal, .menu")) return setFocusMode(false);
      if (!(e.metaKey || e.ctrlKey) || !vault.isOpen()) return;
      const k = e.key.toLowerCase();
      if (k === "k") (e.preventDefault(), setPalette((x) => !x));
      else if (k === "o" || k === "p") (e.preventDefault(), setSwitcher(true));
      else if (k === "\\") (e.preventDefault(), setLeft((v) => !v));
      else if (k === "s") (e.preventDefault(), void vault.flush());
      else if (k === "f" && e.shiftKey) (e.preventDefault(), search());
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  }, []);

  // Unsaved work: writes still pending, or (without folder access) changes not downloaded.
  useEffect(() => {
    const on = (e: BeforeUnloadEvent) => {
      if (vault.dirtyCount(true) === 0) return;
      void vault.flush();
      e.preventDefault();
    };
    window.addEventListener("beforeunload", on);
    return () => window.removeEventListener("beforeunload", on);
  }, []);

  useAttachmentUrls();

  if (!vid || adding) return <Welcome onOpened={opened} onBack={vid ? () => setAdding(false) : undefined} />;

  async function close(id: number) {
    const f = vault.openFolders().find((x) => x.id === id);
    if (f && !f.writes && f.dirty) {
      const ok = await confirmDialog({ title: `Close ${f.name}?`, message: `${f.dirty} changed note${f.dirty === 1 ? " hasn't" : "s haven't"} been downloaded, and will be lost.`, action: "Close", danger: true });
      if (!ok) return;
    }
    await vault.closeFolder(id);
    if (vault.isOpen()) opened();
    else navigate("/");
  }

  const active = notes.find((n) => n.id === activeId);
  const page = here?.page === "graph" || here?.page === "tasks" ? here.page : null;
  const showRight = right && !!active && !page;
  const cls = `app${focus && active ? " focus-mode" : ""}${fullWidth ? " full-width" : ""}${left ? " left-open" : ""}${showRight ? " right-open" : ""}${ready ? " ready" : ""}`;
  const asVault: Vault = { id: vid, name: vault.vaultName(), role: "editor", note_count: notes.length, member_count: 1 };
  return (
    <div className={cls}>
      <Sidebar
        notes={notes}
        activeId={activeId}
        page={page}
        tab={tab}
        setTab={setTab}
        query={query}
        setQuery={setQuery}
        onOpen={openNote}
        onGo={go}
        onToday={() => void daily()}
        onNewNote={(f) => void newNote(f)}
        onAdd={() => setAdding(true)}
        onSwitch={(id) => (vault.switchTo(id), opened())}
        onClose={(id) => void close(id)}
        onSearch={search}
      />
      {narrow() && (left || showRight) && <div className="scrim" onClick={() => (setLeft(false), setRight(false))} />}
      {page === "graph" ? (
        <main className="main">
          <Graph vaultId={vid} vaultName={vault.vaultName()} notes={notes} leftOpen={left} onToggleLeft={() => setLeft((v) => !v)} rightOpen={false} onToggleRight={noop} />
        </main>
      ) : page === "tasks" ? (
        <main className="main">
          <TasksPage vault={asVault} notes={notes} leftOpen={left} onToggleLeft={() => setLeft((v) => !v)} rightOpen={false} onToggleRight={noop} onNavigate={() => narrow() && setLeft(false)} />
        </main>
      ) : active ? (
        <NoteScreen
          key={active.id}
          note={active}
          notes={notes}
          leftOpen={left}
          rightOpen={right}
          onToggleLeft={() => setLeft((v) => !v)}
          onToggleRight={toggleRight}
          onOpenLink={(t) => void openLink(t)}
          onOpen={openNote}
          onDaily={(d) => void daily(d)}
          onTag={(t) => search(`#${t}`)}
          onDeleted={() => navigate(`/v/${vid}`)}
        />
      ) : (
        <main className="main">
          <div className="empty-state">
            <p>{notes.length ? "Pick a note on the left, or press ⌘O to open one by name." : "This folder has no Markdown files yet."}</p>
            <button className="primary" onClick={() => void newNote()}>
              <Icon name="plus" /> New note
            </button>
          </div>
        </main>
      )}
      {switcher && (
        <QuickSwitcher notes={notes} canCreate onPick={(n) => (setSwitcher(false), openNote(n))} onCreate={(t) => (setSwitcher(false), void openLink(t))} onClose={() => setSwitcher(false)} />
      )}
      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      <HelpHost />
      <Overlays />
    </div>
  );
}

// ── welcome ───────────────────────────────────────────────────────────────────────────

function Welcome({ onOpened, onBack }: { onOpened: () => void; onBack?: () => void }) {
  const [known, setKnown] = useState<FileSystemDirectoryHandle[]>([]);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const filePicker = useRef<HTMLInputElement>(null);
  const folders = vault.supportsFolders();
  const open = vault.openFolders();

  useEffect(() => void vault.rememberedFolders().then(setKnown), []);

  async function run(f: () => Promise<void>) {
    setBusy(true);
    try {
      await f();
      onOpened();
    } catch (e) {
      // Closing the picker isn't an error.
      if ((e as Error)?.name !== "AbortError") toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const pickFolder = () => run(async () => vault.openFolder(await (window as any).showDirectoryPicker({ id: "commonplace", mode: "readwrite" })));
  const reopen = (dir: FileSystemDirectoryHandle) =>
    run(async () => {
      const ok = (await (dir as any).requestPermission({ mode: "readwrite" })) === "granted";
      if (!ok) throw new Error("DO Notes needs permission to edit that folder.");
      await vault.openFolder(dir);
    });
  const forget = async (dir: FileSystemDirectoryHandle) => {
    await vault.forgetFolder(dir);
    setKnown(await vault.rememberedFolders());
  };
  const fromInput = (input: HTMLInputElement, label: string) => {
    const list = [...(input.files ?? [])];
    input.value = "";
    if (list.length) void run(() => vault.openFiles(list, label));
  };

  return (
    <div
      className="login"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const list = [...e.dataTransfer.files].filter((f) => /\.md$/i.test(f.name) || f.type.startsWith("image/"));
        if (list.length) void run(() => vault.openFiles(list, "Dropped files"));
        else toast("Drop .md files here (a folder needs the Open buttons).", { tone: "error" });
      }}
    >
      <div className="login-card standalone-welcome">
        <div className="brand">
          <Icon name="book" size={28} />
          <h1>DO Notes</h1>
        </div>
        <p className="muted">A Markdown editor for folders of notes. Your files stay on this computer: nothing is uploaded.</p>
        {folders ? (
          <>
            {known.length > 0 && (
              <ul className="standalone-folders" aria-label="Folders opened before">
                {known.map((d, i) => {
                  const isOpen = open.some((f) => f.name === d.name);
                  return (
                    <li key={i}>
                      <button className={i === 0 && !open.length ? "primary" : ""} disabled={busy} onClick={() => void reopen(d)}>
                        <Icon name="folder" /> {isOpen ? `Go to ${d.name || "Folder"}` : `Reopen ${d.name || "Folder"}`}
                      </button>
                      <button className="icon-btn quiet" title={`Take ${d.name} off this list`} aria-label={`Take ${d.name} off this list`} onClick={() => void forget(d)}>
                        <Icon name="x" size={14} />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <button className={known.length ? "" : "primary"} disabled={busy} onClick={() => void pickFolder()}>
              <Icon name="folder" /> {open.length ? "Open another folder" : "Open a folder"}
            </button>
            <p className="muted small">Changes are saved to the files as you type. Open as many folders as you like: the switcher at the top of the file panel moves between them.</p>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={() => picker.current?.click()}>
              <Icon name="folder" /> {open.length ? "Open another folder" : "Open a folder"}
            </button>
            <button disabled={busy} onClick={() => filePicker.current?.click()}>
              <Icon name="file" /> Open files
            </button>
            <p className="muted small">This browser can't write to a folder, so edits stay in this tab: use Download changes to save them. Chrome or Edge saves to the files directly.</p>
          </>
        )}
        <input
          ref={picker}
          type="file"
          hidden
          {...{ webkitdirectory: "" }}
          multiple
          onChange={(e) => fromInput(e.currentTarget, e.currentTarget.files?.[0]?.webkitRelativePath.split("/")[0] || "Folder")}
        />
        <input ref={filePicker} type="file" hidden multiple accept=".md,text/markdown,image/*" onChange={(e) => fromInput(e.currentTarget, "Files")} />
        <p className="muted small">Or drop Markdown files here.</p>
        <div className="row">
          {onBack && (
            <button className="quiet" onClick={onBack}>
              <Icon name="chevron-left" size={16} /> Back to {vault.vaultName()}
            </button>
          )}
          <button className="quiet" onClick={() => openHelp("standalone")}>
            <Icon name="help" size={16} /> How it works
          </button>
        </div>
      </div>
      <HelpHost />
      <Overlays />
    </div>
  );
}

// ── file panel ────────────────────────────────────────────────────────────────────────

interface Tree {
  name: string;
  path: string;
  folders: Map<string, Tree>;
  notes: NoteSummary[];
}
function buildTree(notes: NoteSummary[]): Tree {
  const root: Tree = { name: "", path: "", folders: new Map(), notes: [] };
  for (const n of notes) {
    const parts = n.path.split("/");
    let node = root;
    for (const p of parts.slice(0, -1)) {
      let next = node.folders.get(p);
      if (!next) node.folders.set(p, (next = { name: p, path: node.path ? `${node.path}/${p}` : p, folders: new Map(), notes: [] }));
      node = next;
    }
    node.notes.push(n);
  }
  return root;
}

function Sidebar(p: {
  notes: NoteSummary[];
  activeId: number | null;
  page: "graph" | "tasks" | null;
  tab: "files" | "search" | "tags";
  setTab: (t: "files" | "search" | "tags") => void;
  query: string;
  setQuery: (q: string) => void;
  onOpen: (n: NoteSummary) => void;
  onGo: (url: string) => void;
  onToday: () => void;
  onNewNote: (folder?: string) => void;
  onAdd: () => void;
  onSwitch: (id: number) => void;
  onClose: (id: number) => void;
  onSearch: (q: string) => void;
}) {
  const tree = useMemo(() => buildTree(p.notes), [p.notes]);
  const [openFolders, setOpenFolders] = useState<Set<string>>(() => new Set());
  // Typing doesn't change the note list, so the footer follows the save status on its own.
  useSyncExternalStore(vault.subscribeStatus, vault.statusVersion);
  const dirty = vault.dirtyCount();
  const writes = vault.canWrite();
  const vid = vault.vaultId();
  const { ids } = useBookmarks();
  const { list: searches } = useSavedSearches();
  const marked = ids.map((id) => p.notes.find((n) => n.id === id)).filter(Boolean) as NoteSummary[];

  // The open note's folders open with it.
  useEffect(() => {
    const n = p.notes.find((x) => x.id === p.activeId);
    if (!n) return;
    const parts = n.path.split("/").slice(0, -1);
    setOpenFolders((s) => {
      const next = new Set(s);
      parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join("/")));
      return next.size === s.size ? s : next;
    });
  }, [p.activeId]);

  const toggle = (path: string) =>
    setOpenFolders((s) => {
      const next = new Set(s);
      next.has(path) ? next.delete(path) : next.add(path);
      return next;
    });

  function render(node: Tree, depth: number): React.ReactNode {
    return (
      <>
        {[...node.folders.values()]
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((f) => {
            const isOpen = openFolders.has(f.path);
            return (
              <li key={"d:" + f.path}>
                <div className="tree-row folder" style={{ paddingLeft: 8 + depth * 14 }} onClick={() => toggle(f.path)}>
                  <button type="button" className="tree-toggle" aria-expanded={isOpen}>
                    <span className={`chev${isOpen ? " open" : ""}`} aria-hidden="true">
                      <Icon name="chevron" size={14} />
                    </span>
                    <span className="tree-label">{f.name}</span>
                  </button>
                  <span className="row-actions">
                    <button className="row-btn" title="New note here" aria-label={`New note in ${f.name}`} onClick={(e) => (e.stopPropagation(), p.onNewNote(f.path))}>
                      <Icon name="plus" size={15} />
                    </button>
                  </span>
                </div>
                {isOpen && <ul>{render(f, depth + 1)}</ul>}
              </li>
            );
          })}
        {[...node.notes]
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((n) => (
            <li key={n.id}>
              <a className={`tree-row note${n.id === p.activeId ? " active" : ""}`} style={{ paddingLeft: 8 + depth * 14 + 18 }} href="#" onClick={(e) => (e.preventDefault(), p.onOpen(n))}>
                <span className="tree-label">{n.title}</span>
              </a>
            </li>
          ))}
      </>
    );
  }

  const tags = useMemo(() => {
    const m = new Map<string, number>();
    for (const n of p.notes) for (const t of n.tags) m.set(t, (m.get(t) ?? 0) + 1);
    return [...m].sort((a, b) => a[0].localeCompare(b[0]));
  }, [p.notes]);

  function download() {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(vault.changesZip());
    a.download = `${vault.vaultName()} changes.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    vault.markAllSaved();
    toast("Saved the changed notes as a zip. Unzip it over the folder to keep them.");
  }

  return (
    <nav className="sidebar">
      <div className="vault-switch standalone-vault">
        {/* The collection switcher, as in the app: every open folder, then open or close one. */}
        <select
          value={vid}
          aria-label="Collection"
          title={vault.canWrite() ? vault.vaultName() : `${vault.vaultName()} (in this tab only)`}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "add") p.onAdd();
            else if (v === "close") p.onClose(vid);
            else p.onSwitch(Number(v));
          }}
        >
          {vault.openFolders().map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
          <option value="add">Open another folder…</option>
          <option value="close">Close {vault.vaultName()}</option>
        </select>
        <ThemeButton />
        <button className="icon-btn" onClick={() => openHelp()} title="Help" aria-label="Help">
          <Icon name="help" />
        </button>
      </div>
      <div className="sidebar-actions">
        <button onClick={() => p.onNewNote()}>
          <Icon name="plus" size={16} /> New note
        </button>
        <button onClick={p.onToday} title="Today's note, in Daily/">
          <Icon name="calendar" size={16} /> Today
        </button>
        <button onClick={() => p.onGo(graphUrl(vid))} title="Graph view" className={p.page === "graph" ? "on" : ""}>
          <Icon name="graph" size={16} /> Graph
        </button>
      </div>
      <div className="tabs">
        {(["files", "search", "tags"] as const).map((t) => (
          <button key={t} className={p.tab === t ? "on" : ""} onClick={() => p.setTab(t)}>
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>
      <div className="sidebar-scroll">
        {p.tab === "files" && (
          <>
            <div className="types-section shortcuts">
              <ul className="types-list">
                <li>
                  <button className={`type-row${p.page === "tasks" ? " active" : ""}`} onClick={() => p.onGo(`/v/${vid}/tasks`)}>
                    <Icon name="check" size={16} />
                    <span className="type-row-name">Tasks</span>
                  </button>
                </li>
              </ul>
              {marked.length > 0 && (
                <>
                  <div className="section-head">Bookmarks</div>
                  <ul className="types-list">
                    {marked.map((n) => (
                      <li key={n.id}>
                        <button className={`type-row${n.id === p.activeId ? " active" : ""}`} onClick={() => p.onOpen(n)}>
                          <Icon name="bookmark" size={16} />
                          <span className="type-row-name">{n.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {searches.length > 0 && (
                <>
                  <div className="section-head">Saved searches</div>
                  <ul className="types-list">
                    {searches.map((s) => (
                      <li key={s.id} className="saved-search">
                        <button className="type-row" onClick={() => p.onSearch(s.query)} title={`Search for ${s.query}`}>
                          <Icon name="search" size={16} />
                          <span className="type-row-name">{s.query}</span>
                        </button>
                        <button className="quiet icon-btn saved-search-graph" aria-label={`Graph of ${s.query}`} title="Show these notes in the graph" onClick={() => p.onGo(graphUrl(vid, { search: s.query }))}>
                          <Icon name="graph" size={14} />
                        </button>
                        <button className="quiet icon-btn saved-search-x" aria-label={`Remove the saved search ${s.query}`} title="Remove" onClick={() => removeSearch(vid, s)}>
                          <Icon name="x" size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
            {p.notes.length ? <ul className="tree">{render(tree, 0)}</ul> : <div className="muted pad">No notes yet. Make one with New note.</div>}
          </>
        )}
        {p.tab === "search" && <Search notes={p.notes} query={p.query} setQuery={p.setQuery} onOpen={p.onOpen} />}
        {p.tab === "tags" && (
          <ul className="tag-list">
            {tags.length === 0 && <li className="muted pad">No tags yet. Add #tags in notes or tags: in frontmatter.</li>}
            {tags.map(([t, n]) => (
              <li key={t}>
                <button onClick={() => (p.setQuery(`#${t}`), p.setTab("search"))}>
                  #{t} <span className="count">{n}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="sidebar-foot standalone-foot">
        {writes ? (
          <span className="muted small" role="status">
            {dirty ? "Saving…" : "Saved to the folder"}
          </span>
        ) : (
          <>
            <span className="muted small" role="status">
              {dirty ? `${dirty} changed, not saved` : "No unsaved changes"}
            </span>
            <button disabled={!dirty} onClick={download} title="Download the changed notes as a zip">
              <Icon name="download" size={16} /> Download changes
            </button>
          </>
        )}
      </div>
    </nav>
  );
}

/** Every word must appear (a #tag must be one of the note's tags); title matches first. A search
 *  can be kept in the file panel, under Saved searches. */
function Search(p: { notes: NoteSummary[]; query: string; setQuery: (q: string) => void; onOpen: (n: NoteSummary) => void }) {
  // Typing in the box stays quick: the search over every note runs behind it.
  const query = useDeferredValue(p.query);
  const hits = useMemo(() => searchNotes(p.notes, query), [query, p.notes]);
  const { list } = useSavedSearches();
  const saved = list.find((s) => s.query === p.query.trim()) ?? null;
  const vid = vault.vaultId();

  return (
    <div className="search-panel">
      <input autoFocus type="search" placeholder="Search notes" aria-label="Search notes" value={p.query} onChange={(e) => p.setQuery(e.target.value)} enterKeyHint="search" />
      {p.query.trim() && (
        <div className="search-meta muted">
          <span>{hits.length === 0 ? "No notes match." : `${hits.length} note${hits.length === 1 ? "" : "s"}`}</span>
          <button
            className={`quiet search-save${saved ? " on" : ""}`}
            aria-pressed={!!saved}
            title={saved ? "Remove from the file panel" : "Keep this search in the file panel"}
            onClick={() => (saved ? removeSearch(vid, saved) : saveSearch(vid, p.query))}
          >
            <Icon name="bookmark" size={14} /> {saved ? "Saved" : "Save"}
          </button>
        </div>
      )}
      <ul className="search-results">
        {hits.map(({ n, snippet }) => (
          <li key={n.id}>
            <a href="#" onClick={(e) => (e.preventDefault(), p.onOpen(n))}>
              <div className="hit-title">{n.title}</div>
              {n.path.includes("/") && <div className="hit-path">{n.path.replace(/\/[^/]+$/, "")}</div>}
              {snippet && <div className="hit-snippet" dangerouslySetInnerHTML={{ __html: snippet }} />}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ── the note ──────────────────────────────────────────────────────────────────────────

/** The note's text as a Yjs document for the app's editor, which edits one: kept in this tab
 *  only (there's no one to share it with), and made again from the file's text when something
 *  else changes the note (a task ticked elsewhere, a link rewritten by a rename). */
function useLocalDoc(id: number, generation: number) {
  return useMemo(() => {
    const doc = new Y.Doc();
    const ytext = doc.getText("content");
    ytext.insert(0, vault.getNote(id)?.content ?? "");
    return { ytext, awareness: new Awareness(doc) };
  }, [id, generation]);
}

function NoteScreen(p: {
  note: NoteSummary;
  notes: NoteSummary[];
  leftOpen: boolean;
  rightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
  onOpenLink: (target: string) => void;
  onOpen: (n: NoteSummary) => void;
  onDaily: (d: Date) => void;
  onTag: (tag: string) => void;
  onDeleted: () => void;
}) {
  const [saved, setMode] = useState<Mode>(() => (store.get("mode") as Mode) || "edit");
  // A phone has room for one pane: split shows as editing.
  const isNarrow = narrow();
  const mode: Mode = isNarrow && saved === "split" ? "edit" : saved;
  const [text, setText] = useState(() => vault.getNote(p.note.id)?.content ?? "");
  const [renaming, setRenaming] = useState(false);
  const [generation, setGeneration] = useState(0);
  const editor = useRef<EditorHandle>(null);
  const preview = useRef<HTMLDivElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const notesRef = useRef(p.notes);
  notesRef.current = p.notes;
  const focusMode = useFocusMode();
  const fullWidth = useFullWidth();
  useBookmarks();
  const vid = vault.vaultId();
  const { ytext, awareness } = useLocalDoc(p.note.id, generation);

  // Typing changes the document; the folder keeps the text, and the preview follows it.
  useEffect(() => {
    const on = () => {
      const t = ytext.toString();
      setText(t);
      vault.setContent(p.note.id, t);
    };
    ytext.observe(on);
    return () => (ytext.unobserve(on), awareness.destroy());
  }, [ytext]);

  const setModeSaved = (m: Mode) => (setMode(m), store.set("mode", m));
  const folder = p.note.path.includes("/") ? p.note.path.replace(/\/[^/]+$/, "") : "";
  const showPreview = mode === "split" || mode === "read";
  // The preview follows the text a moment behind, so a long note doesn't slow typing.
  const shown = useDeferredValue(text);
  const html = useMemo(() => (showPreview ? renderMarkdown(shown, vid, p.notes) : ""), [showPreview, shown, p.notes]);
  const icon = emojiIcon(p.note.icon);
  const cover = coverSrc(vid, p.note.cover);
  const day = dailyDate(p.note.path);
  const tags = useMemo(() => [...new Set(p.notes.flatMap((n) => n.tags))].sort(), [p.notes]);

  useEffect(() => {
    if (preview.current) hydrate(preview.current, { vaultId: vid, notes: p.notes, ancestors: [p.note.id], onOpen: p.onOpenLink });
  }, [html]);

  // Dataview results follow the folder: again a moment after typing, or when notes change.
  useEffect(() => {
    const t = setTimeout(refreshDataview, 600);
    return () => clearTimeout(t);
  }, [text, p.notes]);
  // Something else changed this note: start the editor again from the new text.
  useEffect(() => {
    const on = (e: Event) => {
      if ((e as CustomEvent).detail !== p.note.id) return;
      setText(vault.getNote(p.note.id)?.content ?? "");
      setGeneration((g) => g + 1);
    };
    window.addEventListener("cp-note-replaced", on);
    return () => window.removeEventListener("cp-note-replaced", on);
  }, [p.note.id]);
  useEffect(() => void (generation === 0 && setTimeout(() => editor.current?.restorePlace())), []);

  function onPreviewClick(e: React.MouseEvent) {
    const el = e.target as HTMLElement;
    if (el instanceof HTMLInputElement && el.dataset.task) {
      e.preventDefault();
      const next = toggleTask(text, Number(el.dataset.task));
      if (next !== null) {
        vault.setContent(p.note.id, next);
        setText(next);
        setGeneration((g) => g + 1);
      }
      return;
    }
    const a = el.closest("a");
    if (!a) return;
    if (a.dataset.target) (e.preventDefault(), p.onOpenLink(a.dataset.target));
    else if (a.dataset.tag) (e.preventDefault(), p.onTag(a.dataset.tag));
  }

  const renamed = (r: { relinked: number }) => r.relinked && toast(`Updated the links in ${r.relinked} note${r.relinked === 1 ? "" : "s"}`);

  async function rename(title: string) {
    setRenaming(false);
    const t = title.trim();
    if (!t || t === p.note.title) return;
    if (t.includes("/")) return toast("A title can't contain /.", { tone: "error" });
    try {
      renamed(await vault.renameNote(p.note.id, folder ? `${folder}/${t}` : t));
    } catch (e) {
      toastError(e);
    }
  }

  async function move() {
    const to = await promptDialog({
      title: "Move note",
      message: "Its path in the folder, with any subfolders: Projects/Plan",
      label: "Path",
      value: p.note.path.replace(/\.md$/i, ""),
      action: "Move",
    });
    if (!to) return;
    try {
      renamed(await vault.renameNote(p.note.id, to));
    } catch (e) {
      toastError(e);
    }
  }

  async function remove() {
    const ok = await confirmDialog({
      title: `Delete ${p.note.title}?`,
      message: vault.canWrite() ? "The file is deleted from the folder. This can't be undone here." : "It's removed from this tab.",
      action: "Delete",
      danger: true,
    });
    if (!ok) return;
    try {
      await vault.deleteNote(p.note.id);
      p.onDeleted();
    } catch (e) {
      toastError(e);
    }
  }

  async function insertTemplate() {
    try {
      const picked = await pickTemplate(vid, p.notes);
      if (picked) editor.current?.insertTemplate(fillTemplate(picked.text, { title: p.note.title, date: new Date() }));
    } catch (e) {
      toastError(e);
    }
  }

  // What this note can do, for the ⋯ menu, ⌘K and the / menu (web/lib/commands.ts).
  const actions: NoteActions = {
    aixfId: null,
    readOnly: false,
    mode,
    narrow: isNarrow,
    get editor() {
      return editor.current;
    },
    downloadHref: "",
    setMode: setModeSaved,
    history: noop,
    copyLink: () => void navigator.clipboard?.writeText(`[[${p.note.title}]]`).then(() => toast("Wikilink copied"), toastError),
    rename: () => setRenaming(true),
    moveTo: () => void move(),
    sendTo: noop,
    canSend: false,
    trash: () => void remove(),
    pickPicture: () => picker.current?.click(),
    insertTemplate: () => void insertTemplate(),
    askHere: noop,
    bookmark: () => void toggleBookmark(vid, p.note.id, p.note.title),
    bookmarked: isBookmarked(p.note.id),
    makeTyped: noop,
    vaultId: vid,
    look: { icon, cover: p.note.cover ?? null, width: p.note.width ?? null },
  };
  useEffect(() => {
    provide("note", actions);
    return () => {
      if (currentCtx().note === actions) provide("note", null);
    };
  });

  const outline = useMemo(() => headings(text), [text]);
  const outgoing = useMemo(
    () => [
      ...new Map(
        findWikiLinks(text)
          .filter((l) => !isAttachmentPath(l.target.split("#")[0]!))
          .map((l) => [l.target.split("#")[0]!.toLowerCase(), l.target.split("#")[0]!]),
      ).values(),
    ],
    [text],
  );
  const backlinks = useMemo(() => vault.backlinksOf(p.note.id), [p.notes, p.note.id]);

  return (
    <>
      <main className="main">
        <div className={`note-view mode-${mode}${p.note.width ? ` width-${p.note.width}` : ""}`}>
          <header className="note-header">
            <PanelToggle side="left" open={p.leftOpen} onToggle={p.onToggleLeft} />
            <div className="note-title-wrap">
              <div className="breadcrumb">{folder && <span>{folder.split("/").join(" / ")}</span>}</div>
              {renaming ? (
                <input
                  className="title-input"
                  autoFocus
                  defaultValue={p.note.title}
                  onBlur={(e) => void rename(e.currentTarget.value)}
                  aria-label="Note title"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") (e.preventDefault(), e.currentTarget.blur());
                    if (e.key === "Escape") setRenaming(false);
                  }}
                />
              ) : (
                <h1 className="note-title">
                  {icon && <span className="note-icon">{icon}</span>}
                  <button type="button" className="title-button" onClick={() => setRenaming(true)} title="Rename" aria-label={`Rename “${p.note.title}”`}>
                    {p.note.title}
                  </button>
                </h1>
              )}
            </div>
            <div className="note-actions">
              {focusMode && (
                <button className="quiet focus-exit" onClick={() => setFocusMode(false)} title="Leave focus mode (Esc)">
                  Leave focus
                </button>
              )}
              {day && (
                <div className="day-nav">
                  <button className="icon-btn" onClick={() => p.onDaily(addDays(day, -1))} aria-label={`Previous day, ${formatDate(addDays(day, -1), "dddd D MMMM")}`} title="Previous day">
                    <Icon name="chevron-left" />
                  </button>
                  <button className="icon-btn" onClick={() => p.onDaily(addDays(day, 1))} aria-label={`Next day, ${formatDate(addDays(day, 1), "dddd D MMMM")}`} title="Next day">
                    <Icon name="chevron" />
                  </button>
                </div>
              )}
              {isNarrow ? (
                <button
                  className="icon-btn"
                  onClick={() => setModeSaved(mode === "read" ? "edit" : "read")}
                  aria-label={mode === "read" ? "Edit" : "Reading view"}
                  title={mode === "read" ? "Edit" : "Reading view"}
                >
                  <Icon name={mode === "read" ? "edit" : "book"} />
                </button>
              ) : (
                <div className="segmented" role="radiogroup" aria-label="View">
                  {(
                    [
                      ["edit", "edit", "Live preview"],
                      ["source", "code", "Source mode"],
                      ["split", "split", "Edit and preview"],
                      ["read", "book", "Reading view"],
                    ] as const
                  ).map(([m, icon, label]) => (
                    <button key={m} role="radio" aria-checked={mode === m} aria-label={label} title={label} className={mode === m ? "on" : ""} onClick={() => setModeSaved(m)}>
                      <Icon name={icon} />
                    </button>
                  ))}
                </div>
              )}
              {!isNarrow && (
                <button
                  className={`icon-btn${fullWidth ? " on" : ""}`}
                  onClick={() => setFullWidth(!fullWidth)}
                  aria-pressed={fullWidth}
                  aria-label="Full-width editor"
                  title={fullWidth ? "Normal editor width" : "Full-width editor"}
                >
                  <Icon name="width" />
                </button>
              )}
              <Menu
                label="More"
                items={() => [
                  ...noteMenu().map((c) => ({ label: c.title, icon: c.icon, danger: c.danger, onSelect: () => c.run(currentCtx()) })),
                  { label: "Delete", icon: "trash", danger: true, onSelect: () => void remove() },
                ]}
              />
              <PanelToggle side="right" open={p.rightOpen} onToggle={p.onToggleRight} />
            </div>
          </header>
          {focusMode && isNarrow && (
            <button className="focus-exit-float" onClick={() => setFocusMode(false)}>
              Leave focus
            </button>
          )}
          {cover && (
            <div className="note-cover">
              <img src={cover} alt="" referrerPolicy="no-referrer" />
            </div>
          )}
          <div className="note-body">
            <div className="pane edit-pane" hidden={mode === "read"}>
              <Editor
                key={generation}
                ref={editor}
                ytext={ytext}
                awareness={awareness}
                readOnly={false}
                livePreview={mode === "edit"}
                vaultId={vid}
                notes={() => notesRef.current}
                notesVersion={p.notes}
                tags={() => tags}
                onOpenLink={(target) => p.onOpenLink(target)}
                noteId={p.note.id}
                typewriter={focusMode}
                placeKey={`standalone:${vault.vaultName()}:${p.note.path}`}
              />
            </div>
            {showPreview && <div className="pane preview markdown" ref={preview} onClick={onPreviewClick} dangerouslySetInnerHTML={{ __html: html }} />}
          </div>
          <input
            ref={picker}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              const files = [...(e.currentTarget.files ?? [])];
              e.currentTarget.value = "";
              if (files.length) editor.current?.insertFiles(files);
            }}
          />
        </div>
      </main>
      <aside className="right-panel" aria-label="Links and outline">
        <div className="links-panel">
          <section>
            <h3>Outline</h3>
            {outline.length === 0 ? (
              <p className="muted">No headings.</p>
            ) : (
              <ul className="outline">
                {outline.map((h, i) => (
                  <li key={i} style={{ paddingLeft: (h.level - Math.min(...outline.map((x) => x.level))) * 12 }}>
                    <button onClick={() => (mode === "read" && setModeSaved("edit"), setTimeout(() => editor.current?.jumpToLine(h.line)))}>{h.text}</button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3>
              Backlinks <span className="count">{backlinks.length}</span>
            </h3>
            {backlinks.length === 0 && <p className="muted">Nothing links here yet.</p>}
            <ul className="link-list">
              {backlinks.map((n) => (
                <li key={n.id}>
                  <button onClick={() => p.onOpen(n)}>{n.title}</button>
                </li>
              ))}
            </ul>
          </section>
          <section>
            <h3>
              Outgoing links <span className="count">{outgoing.length}</span>
            </h3>
            <ul className="link-list">
              {outgoing.map((t) => {
                const hit = resolveLocal(p.notes, t);
                return (
                  <li key={t}>
                    <button className={hit ? "" : "unresolved"} onClick={() => p.onOpenLink(t)} title={hit ? undefined : "Not created yet — click to create"}>
                      {hit?.title ?? t}
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        </div>
      </aside>
    </>
  );
}

// ── attachments ───────────────────────────────────────────────────────────────────────

const SERVED = /^\/api\/vaults\/(\d+)\/files\?path=/;

/** The shared renderer points images at the server's file route; point them at the folder's
 *  files instead, wherever they appear (preview, Live Preview widgets, embeds, covers). */
function useAttachmentUrls() {
  useEffect(() => {
    const fix = (el: Element) => {
      for (const attr of ["src", "href"]) {
        const v = el.getAttribute(attr);
        const m = v ? SERVED.exec(v) : null;
        if (!m) continue;
        const path = decodeURIComponent(v!.slice(m[0].length));
        el.setAttribute(attr, "");
        void vault.attachmentUrl(path, Number(m[1])).then((url) => {
          if (url) el.setAttribute(attr, url);
          else if (el instanceof HTMLImageElement) el.alt = `${path} isn't in this folder`;
        });
      }
    };
    const scan = (root: ParentNode) => root.querySelectorAll(`[src^="/api/vaults/"], [href^="/api/vaults/"]`).forEach(fix);
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        if (r.type === "attributes") fix(r.target as Element);
        else
          r.addedNodes.forEach((n) => {
            if (!(n instanceof Element)) return;
            fix(n);
            scan(n);
          });
      }
    });
    mo.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["src", "href"] });
    scan(document.body);
    return () => mo.disconnect();
  }, []);
}
