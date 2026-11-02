// The file panel on the left (a drawer on a phone): the vault switcher, quick actions, and three
// tabs. Files shows Tasks, bookmarks and saved searches, then types (F16), then the folder tree,
// built from note paths plus stored folders so empty ones show. Notes and folders drag to move
// (web/lib/useTreeDrag.tsx). Which folders are open, the sort and the Types fold are remembered on
// this device (localStorage); the tab and search query live in App.

import { exportAixf } from "../lib/aixf";
import { emojiIcon } from "../lib/look";
import { ThemeButton } from "./ThemeButton";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { api, type NoteSummary, type Session, type Vault } from "../lib/api";
import { allFolders, type DragItem } from "../lib/move";
import { moveItem, moveToPicker, otherVaults, sendToVault } from "../lib/moving";
import { provide } from "../lib/commands";
import { noteUrl, navigate, usePath } from "../lib/router";
import { typeUrl, useTypes } from "../lib/types";
import { graphUrl } from "../lib/graph";
import { useBookmarks } from "../lib/bookmarks";
import { removeSearch, useSavedSearches } from "../lib/savedSearches";
import { useTreeDrag } from "../lib/useTreeDrag";
import { Icon } from "../ui/Icon";
import { Menu, MenuPopover } from "../ui/Menu";
import { promptDialog, toast, toastError } from "../ui/overlays";
import { openHelp } from "../lib/help";
import { openSettings } from "../lib/settings";
import { newJournalEntry } from "../lib/journal";
import { SearchPanel } from "./SearchPanel";
import { Invitations } from "./Invitations";
import { BellButton } from "./Notifications";

interface TreeNode {
  name: string;
  path: string;
  folders: Map<string, TreeNode>;
  notes: NoteSummary[];
}

function buildTree(notes: NoteSummary[], folders: string[]): TreeNode {
  const root: TreeNode = { name: "", path: "", folders: new Map(), notes: [] };
  const walk = (parts: string[]) => {
    let node = root;
    for (const p of parts) {
      const key = p.toLowerCase();
      if (!node.folders.has(key)) node.folders.set(key, { name: p, path: node.path ? `${node.path}/${p}` : p, folders: new Map(), notes: [] });
      node = node.folders.get(key)!;
    }
    return node;
  };
  // Stored folders first, so empty ones appear; note paths imply the rest.
  for (const f of folders) walk(f.split("/"));
  for (const n of notes) walk(n.path.split("/").slice(0, -1)).notes.push(n);
  return root;
}

function loadOpen(vaultId: number): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(`cp:open:${vaultId}`) ?? "[]"));
  } catch {
    return new Set();
  }
}

interface Props {
  session: Session;
  vaults: Vault[];
  vault: Vault;
  notes: NoteSummary[];
  folders: string[];
  onFoldersChanged: () => void;
  /** Refetch the vault list (after creating one), so navigating to it doesn't bounce back. */
  reloadVaults: () => Promise<unknown>;
  tags: { tag: string; count: number }[];
  activeId: number | null;
  tab: "files" | "search" | "tags";
  setTab: (t: "files" | "search" | "tags") => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  onNewNote: (folder?: string) => void;
  onNewFromTemplate: (folder?: string) => void;
  onDaily: () => void;
  onTrash: () => void;
  onNewType: () => void;
  /** New vault from GitHub (F14). */
  onNewGitVault: () => void;
  onNavigate: () => void;
  /** A GitHub vault's bar, on a phone (on a laptop it sits above the note). */
  branchBar?: ReactNode;
}

type Sort = "name" | "changed" | "created";
const SORTS: { id: Sort; label: string }[] = [
  { id: "name", label: "By name" },
  { id: "changed", label: "Last changed first" },
  { id: "created", label: "Newest first" },
];

/** Tasks, bookmarks and saved searches, above the types: the things you come back to (F7). */
function ShortcutsSection({ vaultId, notes, activeId, onNavigate, onSearch }: { vaultId: number; notes: NoteSummary[]; activeId: number | null; onNavigate: () => void; onSearch: (q: string) => void }) {
  const { ids } = useBookmarks();
  const { list: searches } = useSavedSearches();
  const path = usePath();
  const marked = ids.map((id) => notes.find((n) => n.id === id)).filter(Boolean) as NoteSummary[];
  const go = (url: string) => {
    navigate(url);
    onNavigate();
  };
  return (
    <div className="types-section shortcuts">
      <ul className="types-list">
        <li>
          <button className={`type-row${path === `/v/${vaultId}/tasks` ? " active" : ""}`} onClick={() => go(`/v/${vaultId}/tasks`)}>
            <Icon name="check" size={16} />
            <span className="type-row-name">Tasks</span>
          </button>
        </li>
        <li>
          <button className={`type-row${path === `/v/${vaultId}/journal` ? " active" : ""}`} onClick={() => go(`/v/${vaultId}/journal`)}>
            <Icon name="book" size={16} />
            <span className="type-row-name">Journal</span>
          </button>
        </li>
      </ul>
      {marked.length > 0 && (
        <>
          <div className="section-head">Bookmarks</div>
          <ul className="types-list">
            {marked.map((n) => (
              <li key={n.id}>
                <button className={`type-row${n.id === activeId ? " active" : ""}`} onClick={() => go(noteUrl(vaultId, n.id))}>
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
                <button className="type-row" onClick={() => onSearch(s.query)} title={`Search for ${s.query}`}>
                  <Icon name="search" size={16} />
                  <span className="type-row-name">{s.query}</span>
                </button>
                <button className="quiet icon-btn saved-search-graph" aria-label={`Graph of ${s.query}`} title="Show these notes in the graph" onClick={() => (navigate(graphUrl(vaultId, { search: s.query })), onNavigate())}>
                  <Icon name="graph" size={14} />
                </button>
                <button className="quiet icon-btn saved-search-x" aria-label={`Remove the saved search ${s.query}`} title="Remove" onClick={() => removeSearch(vaultId, s)}>
                  <Icon name="x" size={14} />
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** Types first (what things are, F16), then folders (where files are, for other Markdown editors). */
function TypesSection({ vaultId, canWrite, onNewType, onNavigate, sort, setSort }: { vaultId: number; canWrite: boolean; onNewType: () => void; onNavigate: () => void; sort: Sort; setSort: (s: Sort) => void }) {
  const { types, undefined: undef } = useTypes();
  const path = usePath();
  const [open, setOpen] = useState(() => localStorage.getItem("cp:typesOpen") !== "0");
  if (!types.length && !undef.length && !canWrite) return null;
  const go = (name: string) => {
    navigate(typeUrl(vaultId, name));
    onNavigate();
  };
  const row = (name: string, icon: string, colour: string, count: number, faint = false) => {
    const active = decodeURIComponent(path) === `/v/${vaultId}/t/${name}`;
    return (
      <li key={name}>
        <button className={`type-row colour-${colour}${active ? " active" : ""}${faint ? " faint" : ""}`} onClick={() => go(name)} title={faint ? `Notes say they're a ${name}, but there's no ${name} type yet` : undefined}>
          <Icon name={icon} size={16} />
          <span className="type-row-name">{name}</span>
          <span className="count">{count}</span>
        </button>
      </li>
    );
  };
  return (
    <div className="types-section">
      <div className="section-head">
        <button
          className="section-toggle"
          aria-expanded={open}
          onClick={() => {
            setOpen(!open);
            localStorage.setItem("cp:typesOpen", open ? "0" : "1");
          }}
        >
          <Icon name="chevron" size={14} /> Types
        </button>
        {canWrite && (
          <button className="icon-btn" onClick={onNewType} aria-label="New type" title="New type: a kind of thing, such as Person or Book">
            <Icon name="plus" size={14} />
          </button>
        )}
      </div>
      {open && (
        <ul className="types-list">
          {types.map((t) => row(t.name, t.icon, t.colour, t.count))}
          {undef.map((t) => row(t.name, "shapes", "grey", t.count, true))}
          {!types.length && !undef.length && (
            <li className="muted pad">
              Say what your notes are: Person, Meeting, Book. <button className="link" onClick={onNewType}>Make a type</button>
            </li>
          )}
        </ul>
      )}
      <div className="section-head folders-head">
        Folders
        <Menu label="Sort notes" icon="list" size={14} items={() => SORTS.map((x) => ({ label: `${x.id === sort ? "✓ " : ""}${x.label}`, onSelect: () => setSort(x.id) }))} />
      </div>
    </div>
  );
}

/** Today: a press opens today's note; press and hold (or right-click) offers a journal entry
 *  too (F24), the quick way in on the iPhone. */
function TodayButton({ onDaily }: { onDaily: () => void }) {
  const button = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const held = useRef<{ timer?: ReturnType<typeof setTimeout>; fired?: boolean }>({});
  const release = () => clearTimeout(held.current.timer);
  return (
    <>
      <button
        ref={button}
        className="today-button"
        onClick={() => (held.current.fired ? (held.current.fired = false) : onDaily())}
        onPointerDown={() => {
          held.current.fired = false;
          held.current.timer = setTimeout(() => ((held.current.fired = true), setMenu(true)), 500);
        }}
        onPointerUp={release}
        onPointerLeave={release}
        onPointerCancel={release}
        onContextMenu={(e) => (e.preventDefault(), release(), setMenu(true))}
        title="Today's daily note (press and hold for a journal entry)"
        aria-haspopup="menu"
      >
        <Icon name="calendar" /> <span>Today</span>
      </button>
      {menu && button.current && (
        <MenuPopover
          label="Today"
          anchor={button.current}
          align="left"
          items={[
            { label: "Today's note", icon: "calendar", onSelect: onDaily },
            { label: "New journal entry", icon: "edit", onSelect: newJournalEntry },
          ]}
          onClose={(refocus) => (setMenu(false), refocus && button.current?.focus())}
        />
      )}
    </>
  );
}

/** The collection menu (F20): home first, then by name; grouped by where each is kept once there's
 *  more than one place (a folder on the Mac: F22; the cloud library, from the Mac: F23). */
function switcherGroups(vaults: Vault[]): { label: string | null; vaults: Vault[] }[] {
  const sorted = [...vaults].sort((a, b) => Number(!!b.home) - Number(!!a.home) || a.name.localeCompare(b.name));
  const groups = [
    { label: "In this library", vaults: sorted.filter((v) => !v.git_repo && !v.folder && !v.cloud) },
    { label: "In folders on this Mac", vaults: sorted.filter((v) => v.folder) },
    { label: "From GitHub", vaults: sorted.filter((v) => v.git_repo) },
    { label: "In the cloud", vaults: sorted.filter((v) => v.cloud) },
  ].filter((g) => g.vaults.length);
  return groups.length > 1 ? groups : [{ label: null, vaults: sorted }];
}
const vaultOption = (v: Vault) => (
  <option key={v.id} value={v.id}>
    {v.name}
    {v.home ? " · home" : ""}
    {v.member_count > 1 ? ` (${v.member_count} members)` : ""}
  </option>
);

export function Sidebar(p: Props) {
  const [open, setOpen] = useState<Set<string>>(() => loadOpen(p.vault.id));
  const [sort, setSortState] = useState<Sort>(() => (localStorage.getItem("cp:sort") as Sort) || "name");
  const setSort = (s: Sort) => {
    setSortState(s);
    localStorage.setItem("cp:sort", s);
  };
  const tree = useMemo(() => buildTree(p.notes, p.folders), [p.notes, p.folders]);
  const canWrite = p.vault.role !== "viewer";

  useEffect(() => setOpen(loadOpen(p.vault.id)), [p.vault.id]);
  // Reveal the active note's folder.
  useEffect(() => {
    const n = p.notes.find((x) => x.id === p.activeId);
    if (!n || !n.path.includes("/")) return;
    const parts = n.path.split("/").slice(0, -1);
    const next = new Set(open);
    let changed = false;
    parts.forEach((_, i) => {
      const key = parts.slice(0, i + 1).join("/").toLowerCase();
      if (!next.has(key)) (next.add(key), (changed = true));
    });
    if (changed) save(next);
  }, [p.activeId]);

  function save(next: Set<string>) {
    setOpen(next);
    localStorage.setItem(`cp:open:${p.vault.id}`, JSON.stringify([...next]));
  }
  const toggle = (path: string) => {
    const next = new Set(open);
    const k = path.toLowerCase();
    next.has(k) ? next.delete(k) : next.add(k);
    save(next);
  };

  async function newFolder(parent?: string) {
    const name = await promptDialog({ title: "New folder", message: parent ? `Inside ${parent}` : undefined, label: "Name", value: "Untitled", action: "Create folder" });
    if (!name) return;
    try {
      const { path } = await api<{ path: string }>(`/vaults/${p.vault.id}/folders`, { body: { path: parent ? `${parent}/${name}` : name } });
      // Open the new folder and every folder above it.
      const next = new Set(open);
      const parts = path.split("/");
      parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join("/").toLowerCase()));
      save(next);
      p.onFoldersChanged();
    } catch (e) {
      toastError(e);
    }
  }

  // An empty folder is easy to bring back, so no "Are you sure?": delete, and offer Undo.
  async function deleteFolder(path: string) {
    try {
      await api(`/vaults/${p.vault.id}/folders?path=${encodeURIComponent(path)}`, { method: "DELETE" });
      p.onFoldersChanged();
      toast(`Deleted the folder “${path.split("/").pop()}”`, {
        undo: async () => {
          await api(`/vaults/${p.vault.id}/folders`, { body: { path } });
          p.onFoldersChanged();
        },
      });
    } catch (e) {
      toastError(e);
    }
  }

  const openFolder = (folder: string, base = open) => {
    const next = new Set(base);
    const parts = folder.split("/");
    parts.forEach((_, i) => next.add(parts.slice(0, i + 1).join("/").toLowerCase()));
    save(next);
  };

  async function move(item: DragItem, folder: string) {
    if (await moveItem(p.vault.id, item, folder, p.onFoldersChanged)) if (folder) openFolder(folder);
  }
  const folderList = useMemo(() => allFolders(p.notes.map((n) => n.path), p.folders), [p.notes, p.folders]);
  useEffect(() => {
    provide("sidebar", canWrite ? { newFolder: () => void newFolder() } : null);
  });
  const dnd = useTreeDrag({ enabled: canWrite, onDrop: (item, folder) => void move(item, folder) });

  // Hovering a closed folder mid-drag opens it, so you can drop deeper.
  useEffect(() => {
    if (!dnd.over || open.has(dnd.over.toLowerCase())) return;
    const t = setTimeout(() => openFolder(dnd.over!), 700);
    return () => clearTimeout(t);
  }, [dnd.over]);

  const isDragged = (item: DragItem) => {
    const d = dnd.drag?.item;
    if (!d) return false;
    return d.kind === "note" ? item.kind === "note" && item.id === d.id : item.kind === "folder" && item.path === d.path;
  };

  async function renameFolder(path: string) {
    const slash = path.lastIndexOf("/");
    const name = await promptDialog({ title: "Rename folder", label: "Name", value: path.slice(slash + 1), action: "Rename" });
    if (!name || name.includes("/")) return name?.includes("/") ? toast("A name can't contain /: use Move to… to move it", { tone: "error" }) : undefined;
    const to = slash >= 0 ? `${path.slice(0, slash)}/${name}` : name;
    if (to === path) return;
    try {
      await api(`/vaults/${p.vault.id}/folders/rename`, { body: { from: path, to } });
      p.onFoldersChanged();
    } catch (e) {
      toastError(e);
    }
  }

  function renderNode(node: TreeNode, depth: number): React.ReactNode {
    const folders = [...node.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
    const notes = [...node.notes].sort((a, b) =>
      sort === "changed" ? b.updated_at.localeCompare(a.updated_at) : sort === "created" ? (b.created_at ?? "").localeCompare(a.created_at ?? "") : a.title.localeCompare(b.title),
    );
    return (
      <>
        {folders.map((f) => {
          const isOpen = open.has(f.path.toLowerCase());
          const item: DragItem = { kind: "folder", path: f.path };
          return (
            <li key={"d:" + f.path} data-drop={f.path}>
              <div
                className={`tree-row folder${dnd.over === f.path ? " drop-over" : ""}${isDragged(item) ? " dragging" : ""}`}
                style={{ paddingLeft: 8 + depth * 14 }}
                onClick={() => toggle(f.path)}
                {...dnd.bind(item, f.name)}
              >
                {/* The row takes a click anywhere; this is its keyboard (and screen reader) way in. */}
                <button type="button" className="tree-toggle" aria-expanded={isOpen}>
                  <span className={`chev${isOpen ? " open" : ""}`} aria-hidden="true">
                    <Icon name="chevron" size={14} />
                  </span>
                  <span className="tree-label">{f.name}</span>
                </button>
                {canWrite && (
                  <span className="row-actions">
                    <button className="row-btn" title="New note here" aria-label={`New note in ${f.name}`} onClick={(e) => (e.stopPropagation(), p.onNewNote(f.path))}>
                      <Icon name="plus" size={15} />
                    </button>
                    <Menu
                      label={`${f.name} folder actions`}
                      size={15}
                      items={[
                        { label: "New note here", icon: "plus", onSelect: () => p.onNewNote(f.path) },
                        { label: "New note from template", icon: "template", onSelect: () => p.onNewFromTemplate(f.path) },
                        { label: "New folder inside", icon: "folder-plus", onSelect: () => void newFolder(f.path) },
                        { label: "Rename", icon: "edit", onSelect: () => void renameFolder(f.path) },
                        { label: "Move to…", icon: "folder", onSelect: () => void moveToPicker(p.vault.id, { kind: "folder", path: f.path }, folderList, p.onFoldersChanged) },
                        { label: "Copy to another collection…", icon: "copy", hidden: !otherVaults(p.vault.id).length, onSelect: () => void sendToVault(p.vault.id, { kind: "folder", path: f.path }, false, p.onFoldersChanged) },
                        { label: "Move to another collection…", icon: "vault", hidden: !otherVaults(p.vault.id).length, onSelect: () => void sendToVault(p.vault.id, { kind: "folder", path: f.path }, true, p.onFoldersChanged) },
                        { label: "Show in graph", icon: "graph", onSelect: () => (navigate(graphUrl(p.vault.id, { folder: f.path })), p.onNavigate()) },
                        { label: "Export as AI-XF bundle", icon: "download", onSelect: () => void exportAixf(p.vault.id, canWrite, f.path) },
                        { label: "Delete empty folder", icon: "trash", danger: true, hidden: f.notes.length > 0 || f.folders.size > 0, onSelect: () => void deleteFolder(f.path) },
                      ]}
                    />
                  </span>
                )}
              </div>
              {isOpen && <ul>{renderNode(f, depth + 1)}</ul>}
            </li>
          );
        })}
        {notes.map((n) => (
          <li key={n.id}>
            <a
              className={`tree-row note${n.id === p.activeId ? " active" : ""}${isDragged({ kind: "note", id: n.id, path: n.path }) ? " dragging" : ""}`}
              {...dnd.bind({ kind: "note", id: n.id, path: n.path }, n.title)}
              draggable={false}
              style={{ paddingLeft: 8 + depth * 14 + 18 }}
              href={noteUrl(p.vault.id, n.id)}
              onClick={(e) => {
                e.preventDefault();
                navigate(noteUrl(p.vault.id, n.id));
                p.onNavigate();
              }}
            >
              <span className="tree-label">
                {emojiIcon(n.icon) ? <span className="note-icon">{emojiIcon(n.icon)}</span> : /\.canvas$/i.test(n.path) && (
                    <span className="note-icon tree-board" title="Board">
                      <Icon name="graph" size={14} />
                    </span>
                  )}
                {n.title}
              </span>
            </a>
          </li>
        ))}
      </>
    );
  }

  return (
    <nav className="sidebar">
      <Invitations onJoined={p.reloadVaults} />
      <div className="library-name">{p.session.library}</div>
      <div className="vault-switch">
        <select
          value={p.vault.id}
          onChange={(e) => {
            if (e.target.value === "github") return p.onNewGitVault();
            if (e.target.value === "new") {
              void promptDialog({ title: "New collection", message: "A collection is a separate set of notes with its own members.", label: "Name", action: "Create collection" }).then((name) => {
                if (name)
                  api<Vault>("/vaults", { body: { name } })
                    .then(async (v) => {
                      await p.reloadVaults();
                      navigate(`/v/${v.id}`);
                      // Straight to its setup, where starter types for its kind are a click away (F20).
                      openSettings("vault");
                      toast(`Created “${v.name}”`);
                    })
                    .catch(toastError);
              });
              return;
            }
            navigate(`/v/${e.target.value}`);
          }}
          aria-label="Collection"
        >
          {switcherGroups(p.vaults).map((g) =>
            g.label ? (
              <optgroup key={g.label} label={g.label}>
                {g.vaults.map(vaultOption)}
              </optgroup>
            ) : (
              g.vaults.map(vaultOption)
            ),
          )}
          <option value="new">+ New collection…</option>
          <option value="github">+ New collection from GitHub…</option>
        </select>
        <button className="icon-btn" onClick={() => openSettings("vault")} title="Settings: this collection, members, import & export" aria-label="Settings">
          <Icon name="settings" />
        </button>
      </div>
      {p.branchBar}

      <div className="sidebar-actions">
        {canWrite && (
          <button onClick={() => p.onNewNote()} title="New note (⌥N)">
            <Icon name="plus" /> <span>New</span>
          </button>
        )}
        {canWrite && (
          <button className="narrow-btn" onClick={() => void newFolder()} title="New folder" aria-label="New folder">
            <Icon name="folder-plus" />
          </button>
        )}
        {canWrite && <TodayButton onDaily={p.onDaily} />}
        <button
          onClick={() => {
            navigate(`/v/${p.vault.id}/graph`);
            p.onNavigate();
          }}
          title="Graph view"
        >
          <Icon name="graph" /> <span>Graph</span>
        </button>
      </div>

      <div className="tabs">
        {(["files", "search", "tags"] as const).map((t) => (
          <button key={t} className={p.tab === t ? "on" : ""} onClick={() => p.setTab(t)}>
            <Icon name={t === "files" ? "folder" : t === "search" ? "search" : "tag"} size={16} />
            {t[0]!.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className={`sidebar-scroll${dnd.over === "" ? " drop-root" : ""}`} data-drop="">
        {p.tab === "files" && <ShortcutsSection vaultId={p.vault.id} notes={p.notes} activeId={p.activeId} onNavigate={p.onNavigate} onSearch={(q) => (p.setSearchQuery(q), p.setTab("search"))} />}
        {p.tab === "files" && <TypesSection vaultId={p.vault.id} canWrite={canWrite} onNewType={p.onNewType} onNavigate={p.onNavigate} sort={sort} setSort={setSort} />}
        {p.tab === "files" &&
          (p.notes.length || p.folders.length ? (
            <ul className="tree">{renderNode(tree, 0)}</ul>
          ) : (
            <div className="muted pad">No notes yet. Create one, or import a folder of Markdown files from Settings → This collection.</div>
          ))}
        {p.tab === "search" && <SearchPanel vaultId={p.vault.id} session={p.session} query={p.searchQuery} setQuery={p.setSearchQuery} onNavigate={p.onNavigate} />}
        {p.tab === "tags" && (
          <ul className="tag-list">
            {p.tags.length === 0 && <li className="muted pad">No tags yet. Add #tags in notes or tags: in frontmatter.</li>}
            {p.tags.map((t) => (
              <li key={t.tag}>
                <button
                  onClick={() => {
                    p.setSearchQuery(`tag:${t.tag}`);
                    p.setTab("search");
                  }}
                >
                  <span>#{t.tag}</span>
                  <span className="count">{t.count}</span>
                </button>
                <button className="quiet icon-btn tag-graph" aria-label={`Graph of #${t.tag}`} title={`Show #${t.tag} in the graph`} onClick={() => (navigate(graphUrl(p.vault.id, { tag: t.tag })), p.onNavigate())}>
                  <Icon name="graph" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sidebar-foot">
        <span className="offline-badge" role="status" title="Notes opened on this device still open and take edits; they sync when you're back">
          Offline
        </span>
        <button className="account" onClick={() => openSettings("account")} title="Settings">
          <span className="avatar small">{p.session.user!.name.slice(0, 1).toUpperCase()}</span>
          <span className="account-name">{p.session.user!.name}</span>
          <Icon name="user" size={16} />
        </button>
        <BellButton vaultId={p.vault.id} />
        <button className="icon-btn" onClick={() => openHelp()} title="Help" aria-label="Help">
          <Icon name="help" size={16} />
        </button>
        <ThemeButton />
        {canWrite && (
          <button className="icon-btn" onClick={p.onTrash} title="Trash" aria-label="Trash">
            <Icon name="trash" size={16} />
          </button>
        )}
      </div>
      {dnd.ghost}
    </nav>
  );
}
