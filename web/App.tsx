// The app shell. App loads the session and shows Login or the Workspace; Workspace owns the
// vault list, the open vault's notes, tags and folders (refetched on its SSE event stream), the
// two side panels, the global shortcuts and dialogs, and picks the screen from the URL
// (web/lib/router.ts). It provide()s the app-wide actions to web/lib/commands.ts. VaultHome, at
// the bottom, is the vault's start page.

import { emptyCanvas, serialiseCanvas } from "../src/canvas";
import { type CSSProperties, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { normalisePath } from "../src/markdown";
import { AiPanel, askInPanel } from "./components/AiPanel";
import { importDayOne, weekReflection } from "./lib/journal";
import { AssistantDialogHost, editAssistant } from "./components/AssistantDialog";
import { CommandPalette, findCommands, runCommandSoon } from "./components/CommandPalette";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { Graph } from "./components/Graph";
import { LocalGraph } from "./components/LocalGraph";
import { graphUrl } from "./lib/graph";
import { Icon } from "./ui/Icon";
import { PanelToggle, setFilesBadge } from "./ui/PanelToggle";
import { chooseDialog, Overlays, promptDialog, toast, toastError } from "./ui/overlays";
import { RelationshipBuilderHost } from "./components/RelationshipBuilder";
import { Login } from "./components/Login";
import { OAuthConsent } from "./components/OAuthConsent";
import { NoteView } from "./components/NoteView";
import { QuickSwitcher } from "./components/QuickSwitcher";
import { RightPanel } from "./components/RightPanel";
import { PanelResizer, usePanelWidths } from "./ui/PanelResizer";
import { Tour } from "./ui/Tour";
import { markSeen, startTour, type TourEnv, useTourOffer } from "./lib/tour";
import { setHelpTour } from "./lib/help";
import { isTypePath } from "../src/types";
import { NewTypeDialog } from "./components/NewTypeDialog";
import { TasksPage } from "./components/TasksPage";
import { JournalPage } from "./components/JournalPage";
import { JournalEntryHost } from "./components/JournalEntry";
import { BranchBar, filesBadge } from "./components/BranchBar";
import { ChangesPage } from "./components/ChangesPage";
import { GitHubVaultDialog } from "./components/GitHubVault";
import { PullRequestDialog } from "./components/PullRequestDialog";
import { cancelBranch, sendNow, setPaused, updateFromBase, useGit } from "./lib/git";
import { setVaultList } from "./lib/moving";
import { TypePage } from "./components/TypePage";
import { loadBookmarks } from "./lib/bookmarks";
import { loadSavedSearches } from "./lib/savedSearches";
import { focusModeOn, setFocusMode, useFocusMode } from "./lib/focusMode";
import { useFullWidth } from "./lib/editorWidth";
import { usePhoneChrome } from "./lib/phoneChrome";
import { Sidebar } from "./components/Sidebar";
import { Trash } from "./components/Trash";
import { HelpHost } from "./components/Help";
import { SettingsHost } from "./components/Settings";
import { openSettings } from "./lib/settings";
import { api, type Note, type NoteSummary, type Session, type Vault } from "./lib/api";
import { COMMANDS, currentCtx, provide } from "./lib/commands";
import { relativeTime, resolveLocal } from "./lib/links";
import { loadAssistants } from "./lib/ai";
import { claimDevice, useOnline } from "./lib/offline";
import { createTypedNote, loadTypes, typesState } from "./lib/types";
import { allFolders } from "./lib/move";
import { pickTemplate, templatesIn } from "./lib/templateActions";
import { dailyPath, dailyTemplatePath, defaultDaily, fillTemplate, isoDay } from "./lib/templates";
import { navigate, noteUrl, parseRoute, usePath } from "./lib/router";
import { NARROW, useNarrow } from "./lib/useNarrow";

type Outline = { level: number; text: string; line: number }[];

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  // Back from signing in to the cloud library (F23, src/remote.ts): say how it went.
  useEffect(() => {
    const said = new URLSearchParams(location.search).get("cloud");
    if (!said) return;
    history.replaceState(history.state, "", location.pathname);
    if (said === "connected") toast("Signed in to the cloud library: its collections are in the menu, under In the cloud");
    else toast(said, { tone: "error" });
    openSettings("connections");
  }, []);
  // Before anyone's notes show: if this isn't the person whose offline copies are on this device,
  // those go first (a shared browser, a session that expired; web/lib/offline.ts).
  const loadSession = useCallback(
    () =>
      api<Session>("/session").then(async (s) => {
        if (s.user) await claimDevice(s.instance, s.user.id);
        setSession(s);
      }),
    [],
  );
  useEffect(() => {
    void loadSession();
  }, []);

  if (!session) return <div className="splash" />;
  return (
    <>
      {!session.user ? (
        <Login session={session} onDone={loadSession} />
      ) : location.pathname === "/oauth/authorize" ? (
        <OAuthConsent session={session} />
      ) : (
        <Workspace session={session} reloadSession={loadSession} />
      )}
      <Overlays />
      <RelationshipBuilderHost />
    </>
  );
}

function Workspace({ session, reloadSession }: { session: Session; reloadSession: () => void }) {
  const path = usePath();
  const route = parseRoute(path);
  const narrow = useNarrow();
  const focus = useFocusMode();
  const fullWidth = useFullWidth();
  // Offline (F4): say so once when the connection goes, and again when it's back.
  const online = useOnline();
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online === wasOnline.current) return;
    wasOnline.current = online;
    toast(online ? "Back online. Edits made offline are syncing." : "You're offline. Notes opened on this device still open and take edits; they sync when you're back.");
  }, [online]);
  // Admins hear once a session when the database is getting full (N9).
  useEffect(() => {
    const st = session.storage;
    if (!st || st.state === "ok" || !st.limit) return;
    const pct = Math.round((st.used / st.limit) * 100);
    toast(st.state === "full" ? `Storage is ${pct}% full: nothing new can be added until space is freed.` : `Storage is ${pct}% full.`, {
      tone: st.state === "full" ? "error" : "info",
      action: { label: "See what's using it", run: () => openSettings("admin") },
    });
  }, []);
  const [vaults, setVaults] = useState<Vault[] | null>(null);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [tags, setTags] = useState<{ tag: string; count: number }[]>([]);
  const [folders, setFolders] = useState<string[]>([]);
  const [loadedFor, setLoadedFor] = useState<number | null>(null); // whose notes and folders are in
  // On a phone both panels are drawers: start closed. On a laptop, remember each choice.
  const stored = (key: string) => !matchMedia(NARROW).matches && localStorage.getItem(key) !== "0";
  const [leftOpen, setLeftOpen] = useState(() => stored("cp:left"));
  const [rightOpen, setRightOpen] = useState(() => stored("cp:right"));
  // The side panel's three tabs: the note's links and outline, its graph, and the AI assistant.
  const [rightTab, setRightTabState] = useState<"links" | "graph" | "ai">(() => {
    const t = localStorage.getItem("cp:rightTab");
    return t === "ai" || t === "graph" ? t : "links";
  });
  const setRightTab = (t: "links" | "graph" | "ai") => {
    setRightTabState(t);
    localStorage.setItem("cp:rightTab", t);
  };
  useEffect(() => {
    setLeftOpen(stored("cp:left"));
    setRightOpen(stored("cp:right"));
  }, [narrow]);
  // Panels slide only when toggled, never as the page first appears.
  const [ready, setReady] = useState(false);
  const { widths, resize } = usePanelWidths();
  const [journalSeq, setJournalSeq] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setReady(true), 500);
    return () => clearTimeout(t);
  }, []);
  const [switcher, setSwitcher] = useState(false);
  const [palette, setPalette] = useState(false);
  const [trash, setTrash] = useState(false);
  const [typeDialog, setTypeDialog] = useState(false);
  const [tab, setTab] = useState<"files" | "search" | "tags">("files");
  const [searchQuery, setSearchQuery] = useState("");
  const [outline, setOutline] = useState<Outline>([]);
  const jumpRef = useRef<(line: number) => void>(() => {});
  const vaultId = "vaultId" in route ? route.vaultId : null;
  const vault = vaults?.find((v) => v.id === vaultId) ?? null;
  const canWrite = vault ? vault.role !== "viewer" : false;

  const loadVaults = useCallback(() => api<Vault[]>("/vaults").then((v) => (setVaultList(v), setVaults(v))), []);
  useEffect(() => {
    void loadVaults();
    void loadAssistants().catch(() => {}); // so @name offers them at the first keystroke
  }, []);

  // Siri and Shortcuts (L8 step 5) open the app at /find?q=… (a note by its title, in any
  // collection) or /ask?q=… (the question, sent to the assistant in the side panel).
  useEffect(() => {
    const q = new URLSearchParams(location.search).get("q")?.trim();
    if (!q || (location.pathname !== "/find" && location.pathname !== "/ask")) return;
    if (location.pathname === "/ask") {
      askInPanel(q);
      setRightTab("ai");
      setRight(true);
      navigate("/", true);
      return;
    }
    api<{ id: number; vaultId: number; title: string }[]>(`/find?q=${encodeURIComponent(q)}`).then(
      (hits) => {
        if (hits[0]) navigate(noteUrl(hits[0].vaultId, hits[0].id), true);
        else (toast(`No note called “${q}”`), navigate("/", true));
      },
      (e) => (toastError(e), navigate("/", true)),
    );
  }, []);

  // "/" → the last collection used, else your home one, else the first.
  useEffect(() => {
    if (!vaults) return;
    if (route.page === "home" || (vaultId && !vault)) {
      const last = Number(localStorage.getItem("cp:vault"));
      const target = vaults.find((v) => v.id === last) ?? vaults.find((v) => v.home) ?? vaults[0];
      if (target) navigate(`/v/${target.id}`, true);
    }
  }, [vaults, route.page, vaultId]);

  useEffect(() => {
    if (vaultId) localStorage.setItem("cp:vault", String(vaultId));
  }, [vaultId]);

  // The vault's notes, tags and folders. A failed load keeps the last list; a load someone asked
  // for (opening the vault, after a move or a restore) says so once, until one succeeds, while the
  // refreshes the event stream triggers stay quiet (they retry by themselves, and offline has
  // its own notice). A reply for a vault that's no longer open is dropped.
  const shownVault = useRef(vaultId);
  shownVault.current = vaultId;
  const loadFailed = useRef(false);
  const loadNotes = useCallback(
    async (background = false) => {
      if (!vaultId) return;
      void loadTypes(vaultId).catch(() => {});
      void loadBookmarks(vaultId).catch(() => {});
      void loadSavedSearches(vaultId).catch(() => {});
      try {
        const [n, t, f] = await Promise.all([
          api<NoteSummary[]>(`/vaults/${vaultId}/notes`),
          api<{ tag: string; count: number }[]>(`/vaults/${vaultId}/tags`),
          api<string[]>(`/vaults/${vaultId}/folders`),
        ]);
        if (shownVault.current !== vaultId) return;
        setNotes(n);
        setTags(t);
        setFolders(f);
        setLoadedFor(vaultId);
        loadFailed.current = false;
      } catch (e) {
        if (shownVault.current !== vaultId || background || loadFailed.current || !navigator.onLine) return;
        loadFailed.current = true;
        toast(`Couldn't load this collection's notes. ${e instanceof Error ? e.message : String(e)}`, { tone: "error", action: { label: "Try again", run: () => void loadNotes() } });
      }
    },
    [vaultId],
  );

  // Live vault changes from every member, over SSE.
  useEffect(() => {
    if (!vaultId || !vault) return;
    setNotes([]);
    setFolders([]);
    void loadNotes();
    let timer: Timer | undefined;
    const es = new EventSource(`/api/vaults/${vaultId}/events`);
    es.onmessage = (m) => {
      // Comments (L3) change nothing in the file list: tell the open note and side panel instead.
      try {
        const e = JSON.parse(m.data) as { type?: string; noteId?: number };
        if (e.type === "comments.changed") return void window.dispatchEvent(new CustomEvent("cp:comments", { detail: e.noteId }));
      } catch {}
      clearTimeout(timer);
      timer = setTimeout(() => void loadNotes(true), 400);
    };
    // EventSource reconnects by itself; refetch when it does, in case we missed events.
    es.onopen = () => void loadNotes(true);
    // A page leaving (or frozen in the back/forward cache) must let go of its stream: browsers
    // allow six connections per site, and held streams would stall the next page load.
    const leave = () => es.close();
    window.addEventListener("pagehide", leave);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", leave);
      es.close();
    };
  }, [vaultId, !!vault]);

  const noteId = route.page === "note" ? route.noteId : null;
  const onNoteViewNav = () => narrow && (setLeftOpen(false), setRightOpen(false));

  // A double tap (or a held ⌥N) must not fire a second create while the first is in flight.
  const creating = useRef(false);
  const createNote = useCallback(
    async (rawPath: string, content = "") => {
      if (!vaultId || creating.current) return;
      creating.current = true;
      try {
        const n = await api<Note>(`/vaults/${vaultId}/notes`, { body: { path: rawPath, content } });
        setNotes((prev) => [...prev, n]);
        navigate(noteUrl(vaultId, n.id));
        onNoteViewNav();
      } catch (e) {
        toastError(e);
      } finally {
        creating.current = false;
      }
    },
    [vaultId, narrow],
  );

  // A board (F11): a .canvas note, named first since it starts empty.
  const newBoard = async () => {
    const name = await promptDialog({ title: "New board", label: "Name", placeholder: "Ideas", action: "Create" });
    if (!name) return;
    void createNote(`${name.replace(/\.canvas$/i, "")}.canvas`, serialiseCanvas(emptyCanvas()));
  };

  const newNote = (folder?: string) => {
    const base = folder ? `${folder}/Untitled` : "Untitled";
    let p = `${base}.md`;
    for (let i = 1; notes.some((n) => n.path.toLowerCase() === p.toLowerCase()); i++) p = `${base} ${i}.md`;
    void createNote(p);
  };

  // A day's daily note: open it, or make it (from Templates/Daily.md when there is one).
  const daily = async (date = new Date()) => {
    if (!vaultId) return;
    const path = dailyPath(date);
    const existing = notes.find((n) => n.path.toLowerCase() === path.toLowerCase());
    if (existing) {
      navigate(noteUrl(vaultId, existing.id));
      onNoteViewNav();
      return;
    }
    if (!canWrite) return toast(`There's no daily note for ${isoDay(date)}.`);
    let content = defaultDaily(date);
    const tpl = dailyTemplatePath(notes.map((n) => n.path));
    if (tpl) {
      try {
        const t = notes.find((n) => n.path === tpl)!;
        content = fillTemplate((await api<Note>(`/vaults/${vaultId}/notes/${t.id}`)).content, { title: isoDay(date), date });
      } catch (e) {
        toastError(e);
      }
    }
    await createNote(path, content);
  };

  // F16: a note of a type (ask which, unless given), then its title.
  const newTyped = async (typeName?: string, folder?: string) => {
    if (!vaultId || !canWrite) return;
    const types = typesState().types;
    if (!types.length) return void newType();
    const name = typeName ?? (await chooseDialog({ title: "New note of a type", options: types.map((t) => ({ value: t.name, label: t.name, icon: t.icon })), placeholder: "Which type?" }));
    const type = types.find((t) => t.name === name);
    if (!type) return;
    const title = await promptDialog({ title: `New ${type.name}`, label: "Title", value: "", action: "Create" });
    if (!title) return;
    try {
      const n = await createTypedNote(vaultId, type, title, folder);
      setNotes((prev) => [...prev, n]);
      navigate(noteUrl(vaultId, n.id));
      onNoteViewNav();
    } catch (e) {
      toastError(e);
    }
  };
  const newType = () => canWrite && setTypeDialog(true);
  const saveLink = async () => {
    if (!vaultId || !canWrite) return;
    const url = await promptDialog({ title: "Save a web link", message: "It becomes a Weblink note with the page's title, summary and picture.", label: "Web address", value: "https://", action: "Save" });
    if (!url || url === "https://") return;
    try {
      const w = await api<{ id: number; title: string; existed: boolean }>(`/vaults/${vaultId}/weblinks`, { body: { url } });
      if (w.existed) toast(`You saved that before, as “${w.title}”`);
      navigate(noteUrl(vaultId, w.id));
      onNoteViewNav();
    } catch (e) {
      toastError(e);
    }
  };

  const newFromTemplate = async (folder?: string) => {
    if (!vaultId || !canWrite) return;
    try {
      const picked = await pickTemplate(vaultId, notes);
      if (!picked) return;
      const title = await promptDialog({ title: "New note", message: `From the “${picked.note.title}” template`, label: "Title", value: "Untitled", action: "Create note" });
      if (!title) return;
      await createNote(normalisePath(folder ? `${folder}/${title}` : title), fillTemplate(picked.text, { title, date: new Date() }));
    } catch (e) {
      toastError(e);
    }
  };

  const openLink = (target: string) => {
    if (!vaultId) return;
    const hit = resolveLocal(notes, target);
    if (hit) {
      navigate(noteUrl(vaultId, hit.id));
      onNoteViewNav();
      return;
    }
    if (!canWrite) return toast(`“${target}” doesn't exist yet.`);
    // As in other Markdown editors: following a link to a missing note creates it; with types, you choose
    // whether it's a plain note or a Person, a Meeting… (F16, "create as a type").
    const clean = target.split("#")[0]!.trim();
    const types = typesState().types;
    if (types.length) {
      void chooseDialog({
        title: `Create “${clean}”`,
        message: "It doesn't exist yet. What is it?",
        options: [{ value: "", label: "A note", icon: "file" }, ...types.map((t) => ({ value: t.name, label: `A ${t.name}`, icon: t.icon }))],
        placeholder: "A note, or a type…",
      }).then((choice) => {
        if (choice === null) return;
        const type = types.find((t) => t.name === choice);
        if (!type) return void createNote(normalisePath(clean)).catch(toastError);
        createTypedNote(vaultId!, type, clean)
          .then((n) => {
            setNotes((prev) => [...prev, n]);
            navigate(noteUrl(vaultId!, n.id));
            onNoteViewNav();
          })
          .catch(toastError);
      });
      return;
    }
    try {
      void createNote(normalisePath(clean));
    } catch (e) {
      toastError(e);
    }
  };

  // Keyboard shortcuts: ⌘O finds a note, ⌘K or ⌘P opens every command.
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      // Escape leaves focus mode, once nothing else (a dialog, a menu, autocomplete) wanted it.
      if (e.key === "Escape" && !e.defaultPrevented && focusModeOn() && !document.querySelector(".modal, .switcher, .menu, .cm-tooltip-autocomplete")) {
        setFocusMode(false);
        return;
      }
      if (mod && !e.shiftKey && e.key === "o") {
        e.preventDefault();
        setPalette(false);
        setSwitcher(true);
      } else if (mod && (e.key === "k" || e.key === "p")) {
        e.preventDefault();
        setSwitcher(false);
        setPalette((x) => !x);
      } else if (mod && e.shiftKey && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setTab("search");
        setLeft(true);
      } else if (mod && e.shiftKey && e.code === "KeyH") {
        const colour = COMMANDS.find((c) => c.id === "format.colour")!;
        if (colour.when(currentCtx())) {
          e.preventDefault();
          colour.run(currentCtx());
        }
      } else if (mod && !e.shiftKey && !e.altKey && e.code === "KeyJ") {
        e.preventDefault();
        askAi();
      } else if (mod && !e.shiftKey && !e.altKey && (e.key === "\\" || e.code === "Backslash")) {
        e.preventDefault();
        toggleLeft();
      } else if (e.altKey && e.code === "KeyN" && !e.repeat && canWrite) {
        e.preventDefault();
        newNote();
      }
    };
    window.addEventListener("keydown", on);
    return () => window.removeEventListener("keydown", on);
  });

  // The guided tour (web/lib/tour.ts) opens a note and the panels as it goes, without
  // remembering them as your choice, and puts the panels back when it ends.
  const tourNow = useRef({ notes, route, vault });
  tourNow.current = { notes, route, vault };
  const tourEnv = (): TourEnv => {
    const was = { left: leftOpen, right: rightOpen };
    return {
      narrow,
      async openRecentNote() {
        const { notes, route, vault } = tourNow.current;
        if (route.page === "note" && route.noteId) return true;
        const n = [...notes].filter((x) => !isTypePath(x.path)).sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
        if (!n || !vault) return false;
        navigate(noteUrl(vault.id, n.id));
        if (narrow) (setLeftOpen(false), setRightOpen(false));
        return true;
      },
      showLeft: (open) => setLeftOpen(open),
      showRight: (open) => {
        if (open) setRightTabState("links");
        setRightOpen(open);
      },
      home: () => tourNow.current.vault && navigate(`/v/${tourNow.current.vault.id}`),
      finish: () => (setLeftOpen(narrow ? false : was.left), setRightOpen(narrow ? false : was.right)),
    };
  };

  const setLeft = (open: boolean) => {
    setLeftOpen(open);
    if (!narrow) localStorage.setItem("cp:left", open ? "1" : "0");
  };
  const toggleLeft = () => setLeft(!leftOpen);
  const setRight = (open: boolean) => {
    setRightOpen(open);
    if (!narrow) localStorage.setItem("cp:right", open ? "1" : "0");
  };
  // Off a note there are no links to show, so the panel there is the AI.
  const toggleRight = () => {
    if (route.page !== "note" && !rightOpen) setRightTab("ai");
    setRight(!rightOpen);
  };
  // ⌘J: open the AI; again, close it.
  const askAi = () => {
    if (rightOpen && (rightTab === "ai" || route.page !== "note")) return setRight(false);
    setRightTab("ai");
    setRight(true);
  };
  // F24: the week's journal, from the home collection, handed to the assistant in the side panel.
  const reflect = async () => {
    const home = vaults?.find((v) => v.home) ?? vault;
    if (!home) return;
    try {
      const text = await weekReflection(home.id);
      if (!text) return void toast(`No journal entries in ${home.name} in the last seven days`);
      askInPanel(text);
      setRightTab("ai");
      setRight(true);
    } catch (e) {
      toastError(e);
    }
  };
  const openNoteByName = (target: string): string | null => {
    const hit = vaultId ? resolveLocal(notes, target.replace(/^\[\[|\]\]$/g, "")) : null;
    if (!hit || !vaultId) return null;
    navigate(noteUrl(vaultId, hit.id));
    onNoteViewNav();
    return hit.title;
  };

  // A GitHub vault's branch (F14): the bar, the changes page and the PR dialog share one status.
  const git = useGit(vault?.git_repo ? vault.id : null, notes);
  const phoneChrome = usePhoneChrome();
  // On a phone the branch bar is in the Files drawer: a dot on the Files button stands in for it.
  useEffect(() => setFilesBadge(narrow && vault?.git_repo ? filesBadge(git) : null), [narrow, vault?.git_repo, git]);
  // The tab says where you are: the note, the collection, the library.
  const openTitle = notes.find((n) => n.id === noteId)?.title;
  useEffect(() => {
    document.title = [openTitle, vault?.name, session.library].filter(Boolean).join(" · ");
  }, [openTitle, vault?.name, session.library]);
  const [prDialog, setPrDialog] = useState(false);
  const [ghDialog, setGhDialog] = useState(false);

  // App-wide actions for the command list (web/lib/commands.ts), refreshed every render.
  useEffect(() => {
    setHelpTour(vault ? { tour: () => startTour("full", tourEnv()), whatsNew: () => startTour("new", tourEnv()) } : null);
    if (!vault) return provide("app", null);
    provide("app", {
      canWrite,
      findNote: () => setSwitcher(true),
      search: () => (setTab("search"), setLeft(true)),
      graph: () => (navigate(`/v/${vault.id}/graph`), onNoteViewNav()),
      graphHere: noteId ? () => (navigate(graphUrl(vault.id, { note: noteId })), onNoteViewNav()) : null,
      tasks: () => (navigate(`/v/${vault.id}/tasks`), onNoteViewNav()),
      journal: () => (navigate(`/v/${vault.id}/journal`), onNoteViewNav()),
      home: () => navigate(`/v/${vault.id}`),
      today: () => void daily(),
      newNote: () => newNote(),
      newFromTemplate: () => void newFromTemplate(),
      newTyped: (t) => void newTyped(t),
      newType: () => void newType(),
      newBoard: () => void newBoard(),
      saveLink: () => void saveLink(),
      isAdmin: !!session.user!.is_admin,
      trash: () => setTrash(true),
      toggleLeft,
      toggleRight,
      openNote: openNoteByName,
      askAi,
      importDayOne: () => void importDayOne(vault).then((done) => done && (navigate(`/v/${vault.id}/journal`), onNoteViewNav())),
      reflect: () => void reflect(),
      addAssistant: () => void editAssistant(),
      exportHref: `/api/vaults/${vault.id}/export`,
      vaultId: vault.id,
      folders: !!session.folders,
      tour: (kind) => startTour(kind, tourEnv()),
      newGitVault: () => setGhDialog(true),
      git: git
        ? {
            pushed: git.pushed,
            hasPr: !!git.pr,
            changes: git.changes.length,
            unpushed: git.unpushed,
            review: () => (navigate(`/v/${vault.id}/changes`), onNoteViewNav()),
            pullRequest: () => setPrDialog(true),
            update: () => void updateFromBase(vault.id, git),
            cancel: () => void cancelBranch(vault.id, git),
            auto: git.auto.mode !== "ask",
            paused: !!git.auto.paused,
            sendNow: () => void sendNow(vault.id, git),
            setPaused: (on: boolean) => void setPaused(vault.id, on),
          }
        : null,
    });
  });

  const tagNames = useMemo(() => tags.map((t) => t.tag), [tags]);
  const folderList = useMemo(() => allFolders(notes.map((n) => n.path), folders), [notes, folders]);

  if (vaults === null) return <div className="splash" />;
  if (!vault)
    return (
      <div className="empty-state">
        <p>No collection yet.</p>
        <button className="primary" onClick={() => api<Vault>("/vaults", { body: { name: "Personal" } }).then((v) => (loadVaults(), navigate(`/v/${v.id}`)), toastError)}>
          Create a collection
        </button>
      </div>
    );

  const onNote = route.page === "note" && !!noteId;
  const branchBar = vault.git_repo && <BranchBar vault={vault} status={git} onPullRequest={() => setPrDialog(true)} onNavigate={() => narrow && setLeftOpen(false)} />;
  const tabShown = onNote ? rightTab : "ai";
  const showRight = rightOpen && (onNote || tabShown === "ai");

  return (
    <div className={`app${focus && onNote ? " focus-mode" : ""}${fullWidth ? " full-width" : ""}${online ? "" : " offline"}${ready ? " ready" : ""}${leftOpen ? " left-open" : ""}${showRight ? " right-open" : ""}${tabShown === "ai" ? " right-ai" : ""}${phoneChrome.hidden ? " chrome-hidden" : ""}${phoneChrome.typing ? " typing" : ""}`}
      style={narrow ? undefined : ({ "--sidebar-w": `${widths.left}px`, "--right-w": `${widths.right}px` } as CSSProperties)}
    >
      <Sidebar
        session={session}
        vaults={vaults}
        vault={vault}
        notes={notes}
        folders={folders}
        onFoldersChanged={() => void loadNotes()}
        reloadVaults={loadVaults}
        tags={tags}
        activeId={noteId}
        tab={tab}
        setTab={setTab}
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        onNewNote={newNote}
        onNewFromTemplate={(f) => void newFromTemplate(f)}
        onDaily={() => void daily()}
        onTrash={() => setTrash(true)}
        onNewType={() => void newType()}
        onNewGitVault={() => setGhDialog(true)}
        onNavigate={() => narrow && setLeftOpen(false)}
        branchBar={narrow ? branchBar : null}
      />
      {!narrow && leftOpen && !(focus && onNote) && <PanelResizer side="left" width={widths.left} other={showRight ? widths.right : 0} resize={resize} />}
      {!narrow && showRight && !(focus && onNote) && <PanelResizer side="right" width={widths.right} other={leftOpen ? widths.left : 0} resize={resize} />}
      {narrow && (leftOpen || (showRight && rightOpen)) && <div className="scrim" onClick={() => (setLeftOpen(false), setRightOpen(false))} />}

      <main className="main">
        {!narrow && branchBar}
        <ErrorBoundary resetKey={path}>
        {route.page === "note" && noteId && (
          <NoteView
            key={noteId}
            vaultId={vault.id}
            noteId={noteId}
            user={session.user!}
            instance={session.instance}
            cloud={!!vault.cloud}
            notes={notes}
            tags={tagNames}
            folders={folderList}
            onMoved={() => void loadNotes()}
            onOpenLink={openLink}
            onTag={(t) => {
              setSearchQuery(`tag:${t}`);
              setTab("search");
              setLeft(true);
            }}
            onDeleted={() => {
              setNotes((prev) => prev.filter((n) => n.id !== noteId)); // at once, not after the server's event
              navigate(`/v/${vault.id}`);
            }}
            onOutline={(o, jump) => {
              setOutline(o);
              jumpRef.current = jump;
            }}
            leftOpen={leftOpen}
            rightOpen={rightOpen}
            onToggleRight={toggleRight}
            onToggleLeft={toggleLeft}
            onDaily={(d) => void daily(d)}
          />
        )}
        {route.page === "tasks" && (
          <TasksPage vault={vault} notes={notes} leftOpen={leftOpen} onToggleLeft={toggleLeft} rightOpen={showRight} onToggleRight={toggleRight} onNavigate={onNoteViewNav} />
        )}
        {route.page === "journal" && (
          <JournalPage vault={vault} notes={notes} leftOpen={leftOpen} onToggleLeft={toggleLeft} rightOpen={showRight} onToggleRight={toggleRight} onNavigate={onNoteViewNav} onDaily={(d) => void daily(d)} seq={journalSeq} />
        )}
        {route.page === "changes" && (
          <ChangesPage vault={vault} notes={notes} leftOpen={leftOpen} onToggleLeft={toggleLeft} rightOpen={showRight} onToggleRight={toggleRight} onNavigate={onNoteViewNav} onPullRequest={() => setPrDialog(true)} />
        )}
        {route.page === "type" && (
          <TypePage
            vault={vault}
            name={route.name}
            notes={notes}
            leftOpen={leftOpen}
            onToggleLeft={toggleLeft}
            rightOpen={showRight}
            onToggleRight={toggleRight}
            onNavigate={onNoteViewNav}
          />
        )}
        {route.page === "graph" && <Graph vaultId={vault.id} vaultName={vault.name} notes={notes} leftOpen={leftOpen} onToggleLeft={toggleLeft} rightOpen={showRight} onToggleRight={toggleRight} />}
        {route.page === "vault" && (
          <VaultHome
            vault={vault}
            notes={notes}
            folderCount={folders.length}
            loaded={loadedFor === vault.id}
            onSwitcher={() => setSwitcher(true)}
            onCommands={() => setPalette(true)}
            onNew={() => newNote()}
            onNewFromTemplate={templatesIn(notes).length ? () => void newFromTemplate() : undefined}
            onDaily={() => void daily()}
            onImport={() => openSettings("vault")}
            onGuidedTour={(kind) => startTour(kind, tourEnv())}
            onTour={() =>
              api<{ id: number }>(`/vaults/${vault.id}/tour`, { body: {} })
                .then(async (r) => (await loadNotes(), navigate(noteUrl(vault.id, r.id))))
                .catch(toastError)
            }
            leftOpen={leftOpen}
            onToggleLeft={toggleLeft}
            rightOpen={showRight}
            onToggleRight={toggleRight}
          />
        )}
        </ErrorBoundary>
      </main>

      <aside className="right-panel">
        {(onNote || narrow) && (
          <div className="tabs right-tabs" role="tablist">
            {onNote ? (
              <>
                <button role="tab" aria-selected={tabShown === "links"} className={tabShown === "links" ? "on" : ""} onClick={() => setRightTab("links")}>
                  <Icon name="link" size={16} /> Links
                </button>
                <button role="tab" aria-selected={tabShown === "graph"} className={tabShown === "graph" ? "on" : ""} onClick={() => setRightTab("graph")}>
                  <Icon name="graph" size={16} /> Graph
                </button>
                <button role="tab" aria-selected={tabShown === "ai"} className={tabShown === "ai" ? "on" : ""} onClick={() => setRightTab("ai")}>
                  <Icon name="sparkle" size={16} /> AI
                </button>
              </>
            ) : (
              <span className="right-title">
                <Icon name="sparkle" size={16} /> AI
              </span>
            )}
            {narrow && (
              <button className="icon-btn" onClick={() => setRightOpen(false)} aria-label="Close the side panel">
                <Icon name="x" />
              </button>
            )}
          </div>
        )}
        {onNote && tabShown === "links" && (
          <RightPanel
            vaultId={vault.id}
            canWrite={canWrite}
            noteId={noteId!}
            notes={notes}
            outline={outline}
            jump={(l) => jumpRef.current(l)}
            semantic={session.search.semantic}
            onCreate={openLink}
            onNavigate={() => narrow && setRightOpen(false)}
            onDaily={(d) => void daily(d)}
          />
        )}
        {onNote && tabShown === "graph" && showRight && <LocalGraph vaultId={vault.id} noteId={noteId!} notes={notes} onNavigate={() => narrow && setRightOpen(false)} />}
        {tabShown === "ai" && showRight && <AiPanel vaultId={vault.id} noteId={onNote ? noteId : null} notes={notes} you={session.user!.name} onOpenLink={openLink} />}
      </aside>

      <Tour />
      {narrow && (
        <button className="fab" onClick={() => setSwitcher(true)} aria-label="Find a note">
          <Icon name="search" size={22} />
        </button>
      )}

      {palette && <CommandPalette onClose={() => setPalette(false)} />}
      {switcher && (
        <QuickSwitcher
          notes={notes}
          canCreate={canWrite}
          findCommands={(q) => findCommands(q).map((c) => ({ id: c.id, title: c.title, icon: c.icon, run: () => runCommandSoon(c) }))}
          onPick={(n) => {
            setSwitcher(false);
            navigate(noteUrl(vault.id, n.id));
            onNoteViewNav();
          }}
          onCreate={(title) => {
            setSwitcher(false);
            try {
              void createNote(normalisePath(title));
            } catch (e) {
              toastError(e);
            }
          }}
          onClose={() => setSwitcher(false)}
        />
      )}
      {trash && vault && (
        <Trash
          vault={vault}
          onClose={() => setTrash(false)}
          onRestored={(n) => {
            setTrash(false);
            void loadNotes();
            navigate(noteUrl(vault.id, n.id));
            onNoteViewNav();
          }}
        />
      )}
      {typeDialog && (
        <NewTypeDialog
          vaultId={vault.id}
          onClose={() => setTypeDialog(false)}
          onOpen={(id) => {
            navigate(noteUrl(vault.id, id));
            onNoteViewNav();
          }}
        />
      )}
      {prDialog && git && <PullRequestDialog vaultId={vault.id} status={git} user={session.user!} onClose={() => setPrDialog(false)} />}
      {ghDialog && <GitHubVaultDialog onClose={() => setGhDialog(false)} onCreated={() => loadVaults()} />}
      {/* After the dialogs that open it, and before the one it opens, so each is on top */}
      <JournalEntryHost
        homeName={vaults.find((v) => v.home)?.name ?? null}
        onAdded={(v) => {
          setJournalSeq((n) => n + 1);
          if (v === vaultId) void loadNotes();
        }}
      />
      <HelpHost />
      <SettingsHost
        vault={vault}
        user={session.user!}
        library={session.library}
        onVaultChanged={() => {
          void loadVaults();
          void loadNotes();
        }}
        onAccountChanged={reloadSession}
      />
      <AssistantDialogHost />
    </div>
  );
}

/** The guided tour's offer, at the top of the home page: once, then after each release. */
function TourOffer({ onTour }: { onTour: (kind: "full" | "new") => void }) {
  const narrow = useNarrow();
  const offer = useTourOffer(narrow);
  if (!offer) return null;
  return (
    <div className="tour-offer-card" role="region" aria-label={offer === "tour" ? "Tour" : "What's new"}>
      <Icon name={offer === "tour" ? "lightbulb" : "sparkle"} />
      <p>
        {offer === "tour" ? (
          <>
            <b>New here?</b> A one-minute tour of the screen, pointing at each part as it goes.
          </>
        ) : (
          <>
            <b>New in DO Notes.</b> A quick look at what's been added since you last looked.
          </>
        )}
      </p>
      <button className="quiet" onClick={markSeen}>
        Not now
      </button>
      <button className="primary" onClick={() => onTour(offer === "tour" ? "full" : "new")}>
        {offer === "tour" ? "Take the tour" : "Show me"}
      </button>
    </div>
  );
}

function VaultHome({ vault, notes, folderCount, loaded, onSwitcher, onCommands, onNew, onNewFromTemplate, onDaily, onImport, onTour, onGuidedTour, leftOpen, onToggleLeft, rightOpen, onToggleRight }: { vault: Vault; notes: NoteSummary[]; folderCount: number; loaded: boolean; onSwitcher: () => void; onCommands: () => void; onNew: () => void; onNewFromTemplate?: () => void; onDaily: () => void; onImport: () => void; onTour: () => void; onGuidedTour: (kind: "full" | "new") => void; leftOpen: boolean; onToggleLeft: () => void; rightOpen: boolean; onToggleRight: () => void }) {
  const recent = [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 12);
  const canWrite = vault.role !== "viewer";
  return (
    <div className="vault-home">
      <header className="note-header">
        <PanelToggle side="left" open={leftOpen} onToggle={onToggleLeft} />
        <h1 className="note-title">{vault.name}</h1>
        <div className="note-actions">
          <PanelToggle side="right" open={rightOpen} onToggle={onToggleRight} />
        </div>
      </header>
      <div className="vault-home-body">
        <TourOffer onTour={onGuidedTour} />
        <div className="quick-actions">
          <button onClick={onSwitcher}>
            <Icon name="search" /> Find a note <kbd>⌘O</kbd>
          </button>
          <button onClick={onCommands}>
            <Icon name="command" /> All commands <kbd>⌘K</kbd>
          </button>
          {canWrite && (
            <button onClick={onNew}>
              <Icon name="plus" /> New note <kbd>⌥N</kbd>
            </button>
          )}
          {canWrite && onNewFromTemplate && (
            <button onClick={onNewFromTemplate}>
              <Icon name="template" /> From a template
            </button>
          )}
          {canWrite && (
            <button onClick={onDaily}>
              <Icon name="calendar" /> Today's note
            </button>
          )}
          {canWrite && (
            <button onClick={onImport}>
              <Icon name="upload" /> Import markdown
            </button>
          )}
        </div>
        {recent.length > 0 ? (
          <>
            <h3>Recently edited</h3>
            <ul className="recent">
              {recent.map((n) => (
                <li key={n.id}>
                  <a
                    href={noteUrl(vault.id, n.id)}
                    onClick={(e) => {
                      e.preventDefault();
                      navigate(noteUrl(vault.id, n.id));
                    }}
                  >
                    <span>{n.title}</span>
                    <small>
                      {n.path.includes("/") ? n.path.replace(/\/[^/]+$/, "") + " · " : ""}
                      {relativeTime(n.updated_at)}
                    </small>
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : !loaded ? null : folderCount > 0 ? (
          <p className="muted">No notes yet. Pick a folder in the sidebar and add one with +, or start a note here.</p>
        ) : (
          <div className="vault-empty">
            <p className="muted">This collection is empty. Start a note, or import a folder of Markdown files.</p>
            {canWrite && (
              <div className="tour-offer">
                <p>
                  <b>New to DO Notes?</b> A short tour: five notes that show how it works by being used. Delete them when you're done.
                </p>
                <button className="primary" onClick={onTour}>
                  <Icon name="book" /> Add a short tour
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
