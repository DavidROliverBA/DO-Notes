// A board (F11): notes, text, links and pictures as cards on a whiteboard, joined by arrows.
// Stored as JSON Canvas (src/canvas.ts) and edited live through the note's Yjs document, so two
// people can arrange the same board at once. Drawn with React Flow (@xyflow/react, MIT); every
// change is written to the Yjs maps and drawn from them, so there is one source of truth.

import "@xyflow/react/dist/base.css";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  type Connection,
  ConnectionMode,
  type Edge,
  type EdgeChange,
  Handle,
  MarkerType,
  MiniMap,
  type Node,
  type NodeChange,
  type NodeProps,
  NodeResizeControl,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
} from "@xyflow/react";
import * as Y from "yjs";
import type { Awareness } from "y-protocols/awareness";
import { canvasFromDoc, canvasMaps, type CanvasItem, setField, topZ } from "../../src/canvas";
import { api, type Note, type NoteSummary } from "../lib/api";
import { fileUrl, renderMarkdown } from "../lib/render";
import { navigate, noteUrl } from "../lib/router";
import { useNarrow } from "../lib/useNarrow";
import { Icon } from "../ui/Icon";
import { Menu } from "../ui/Menu";
import { chooseDialog, promptDialog, toast, toastError } from "../ui/overlays";
import { arrange, mindMap, tidy } from "../lib/boardLayout";
import { arrowSentence, cardName } from "../lib/boardWords";
import { openRelationshipBuilder } from "./RelationshipBuilder";

/** Transactions made here, so Undo takes back only this person's changes. */
export const BOARD_ORIGIN = "board";
const SIDES = ["top", "right", "bottom", "left"] as const;
type Side = (typeof SIDES)[number];
const PRESETS: { value: string; label: string }[] = [
  { value: "1", label: "Red" },
  { value: "2", label: "Orange" },
  { value: "3", label: "Yellow" },
  { value: "4", label: "Green" },
  { value: "5", label: "Cyan" },
  { value: "6", label: "Purple" },
];
const CORNERS = ["top-left", "top-right", "bottom-left", "bottom-right"] as const;
const NOTE_FILE = /\.(md|markdown)$/i;
const BOARD_FILE = /\.canvas$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

interface Ctx {
  vaultId: number;
  notes: NoteSummary[];
  readOnly: boolean;
  editing: string | null;
  setEditing(id: string | null): void;
  ydoc: Y.Doc;
  /** Others' selections, by card id: their colour. */
  others: Map<string, string>;
  openPath(path: string): void;
}
const BoardCtx = createContext<Ctx | null>(null);
const useBoardCtx = () => useContext(BoardCtx)!;

/** A colour as JSON Canvas writes it: a preset "1"–"6" (a class) or a hex value (a variable). */
function colourProps(color: unknown): { className: string; style: Record<string, string> } {
  if (typeof color !== "string" || !color) return { className: "", style: {} };
  if (/^[1-6]$/.test(color)) return { className: ` board-c${color}`, style: {} };
  return { className: " board-custom", style: { "--card-c": color } };
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);

/** The side of `a` that faces `b`, for arrows that don't say. */
function facing(a: CanvasItem, b: CanvasItem): Side {
  const ax = num(a.x, 0) + num(a.width, 0) / 2;
  const ay = num(a.y, 0) + num(a.height, 0) / 2;
  const bx = num(b.x, 0) + num(b.width, 0) / 2;
  const by = num(b.y, 0) + num(b.height, 0) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "bottom" : "top";
}

// ── cards ──────────────────────────────────────────────────────────────────────────────────

function Handles() {
  return (
    <>
      <Handle type="source" position={Position.Top} id="top" />
      <Handle type="source" position={Position.Right} id="right" />
      <Handle type="source" position={Position.Bottom} id="bottom" />
      <Handle type="source" position={Position.Left} id="left" />
    </>
  );
}

function Shell({ id, item, selected, kind, children, label }: { id: string; item: CanvasItem; selected: boolean; kind: string; children: React.ReactNode; label: string }) {
  const { readOnly, others } = useBoardCtx();
  const c = colourProps(item.color);
  const other = others.get(id);
  return (
    <div
      className={`board-card board-${kind}${c.className}${selected ? " selected" : ""}${other ? " others" : ""}`}
      style={{ ...c.style, ...(other ? { "--other-c": other } : {}) } as React.CSSProperties}
      role="group"
      aria-label={label}
    >
      {/* Corners only: the middle of each side is where arrows are drawn from. */}
      {!readOnly && selected && CORNERS.map((c) => <NodeResizeControl key={c} position={c} minWidth={80} minHeight={40} className="board-resize" />)}
      {children}
      <Handles />
    </div>
  );
}

const TextCard = memo(function TextCard({ id, data, selected }: NodeProps<Node<{ item: CanvasItem }>>) {
  const { vaultId, notes, readOnly, editing, setEditing, ydoc } = useBoardCtx();
  const text = typeof data.item.text === "string" ? data.item.text : "";
  const html = useMemo(() => renderMarkdown(text, vaultId, notes), [text, notes]);
  const isEditing = editing === id && !readOnly;
  return (
    <Shell id={id} item={data.item} selected={selected} kind="text" label={`Text card: ${text.slice(0, 60)}`}>
      {isEditing ? (
        <textarea
          className="board-text-edit nodrag nowheel"
          autoFocus
          defaultValue={text}
          aria-label="Card text"
          onChange={(e) => {
            const m = canvasMaps(ydoc).nodes.get(id);
            if (m) ydoc.transact(() => setField(m, "text", e.currentTarget.value), BOARD_ORIGIN);
          }}
          onBlur={() => setEditing(null)}
          onKeyDown={(e) => e.key === "Escape" && (e.stopPropagation(), setEditing(null))}
        />
      ) : (
        <div className="board-body markdown" onDoubleClick={() => !readOnly && setEditing(id)} dangerouslySetInnerHTML={{ __html: html || '<p class="muted">Double-click to write</p>' }} />
      )}
    </Shell>
  );
});

// A note's text, fetched once per version and shared by every card showing it.
const noteText = new Map<string, Promise<string>>();
function useNoteText(vaultId: number, note: NoteSummary | undefined): string | null {
  const [text, setText] = useState<string | null>(null);
  const key = note ? `${vaultId}:${note.id}:${note.updated_at}` : "";
  useEffect(() => {
    if (!note) return;
    let live = true;
    if (!noteText.has(key)) noteText.set(key, api<Note>(`/vaults/${vaultId}/notes/${note.id}`).then((n) => n.content));
    noteText.get(key)!.then((t) => live && setText(t), () => live && setText(""));
    return () => {
      live = false;
    };
  }, [key]);
  return text;
}

/** The section under a heading, for a card showing `Note.md#Heading`. */
function section(md: string, subpath: unknown): string {
  if (typeof subpath !== "string" || !subpath.startsWith("#")) return md;
  const want = subpath.slice(1).trim().toLowerCase();
  const lines = md.split("\n");
  const at = lines.findIndex((l) => /^#{1,6}\s/.test(l) && l.replace(/^#+\s*/, "").trim().toLowerCase() === want);
  if (at < 0) return md;
  const level = /^#+/.exec(lines[at]!)![0].length;
  const end = lines.findIndex((l, i) => i > at && /^#{1,6}\s/.test(l) && /^#+/.exec(l)![0].length <= level);
  return lines.slice(at, end < 0 ? undefined : end).join("\n");
}

const FileCard = memo(function FileCard({ id, data, selected }: NodeProps<Node<{ item: CanvasItem }>>) {
  const { vaultId, notes, openPath } = useBoardCtx();
  const file = typeof data.item.file === "string" ? data.item.file : "";
  const note = useMemo(() => notes.find((n) => n.path.toLowerCase() === file.toLowerCase()), [notes, file]);
  const text = useNoteText(vaultId, NOTE_FILE.test(file) ? note : undefined);
  const html = useMemo(() => (text === null ? "" : renderMarkdown(section(text, data.item.subpath), vaultId, notes)), [text, notes, data.item.subpath]);
  const name = file.split("/").pop()!.replace(/\.(md|markdown|canvas)$/i, "");

  if (BOARD_FILE.test(file))
    return (
      <Shell id={id} item={data.item} selected={selected} kind="board" label={`Board: ${name}`}>
        <button className="board-card-head nodrag" onClick={() => openPath(file)} title="Open this board">
          <Icon name="graph" size={14} /> {name}
        </button>
        <BoardPreview vaultId={vaultId} note={note} />
      </Shell>
    );
  if (IMAGE_FILE.test(file))
    return (
      <Shell id={id} item={data.item} selected={selected} kind="image" label={`Picture: ${name}`}>
        <img className="board-image" src={fileUrl(vaultId, file)} alt={name} draggable={false} />
      </Shell>
    );
  if (!NOTE_FILE.test(file))
    return (
      <Shell id={id} item={data.item} selected={selected} kind="file" label={`File: ${name}`}>
        <a className="board-card-head nodrag" href={fileUrl(vaultId, file)} target="_blank" rel="noopener">
          <Icon name="file" size={14} /> {file.split("/").pop()}
        </a>
      </Shell>
    );
  return (
    <Shell id={id} item={data.item} selected={selected} kind="note" label={`Note: ${name}`}>
      <button className="board-card-head nodrag" onClick={() => openPath(file)} title="Open this note">
        <Icon name="file" size={14} /> {note ? note.title : name}
        {typeof data.item.subpath === "string" && <span className="muted"> {data.item.subpath}</span>}
      </button>
      {note ? (
        <div className="board-body markdown nowheel" dangerouslySetInnerHTML={{ __html: html }} />
      ) : (
        <p className="board-body muted">This note isn't in the collection (yet): {file}</p>
      )}
    </Shell>
  );
});

/** A board on a board (F11 step 4): its name and a sketch of its cards. */
function BoardPreview({ vaultId, note }: { vaultId: number; note: NoteSummary | undefined }) {
  const text = useNoteText(vaultId, note);
  const boxes = useMemo(() => {
    try {
      const nodes = (JSON.parse(text ?? "{}").nodes ?? []) as CanvasItem[];
      if (!nodes.length) return null;
      const xs = nodes.map((n) => num(n.x, 0));
      const ys = nodes.map((n) => num(n.y, 0));
      const x0 = Math.min(...xs);
      const y0 = Math.min(...ys);
      const w = Math.max(...nodes.map((n) => num(n.x, 0) + num(n.width, 0))) - x0 || 1;
      const h = Math.max(...nodes.map((n) => num(n.y, 0) + num(n.height, 0))) - y0 || 1;
      return { nodes, x0, y0, w, h };
    } catch {
      return null;
    }
  }, [text]);
  if (!note) return <p className="board-body muted">This board isn't in the collection (yet).</p>;
  if (!boxes) return <p className="board-body muted">{text === null ? "…" : "An empty board"}</p>;
  return (
    <svg className="board-preview" viewBox={`${boxes.x0} ${boxes.y0} ${boxes.w} ${boxes.h}`} preserveAspectRatio="xMidYMid meet" aria-label={`${boxes.nodes.length} cards`}>
      {boxes.nodes.map((n) => (
        <rect key={n.id} x={num(n.x, 0)} y={num(n.y, 0)} width={num(n.width, 0)} height={num(n.height, 0)} className={n.type === "group" ? "group" : ""} />
      ))}
    </svg>
  );
}

const LinkCard = memo(function LinkCard({ id, data, selected }: NodeProps<Node<{ item: CanvasItem }>>) {
  const url = typeof data.item.url === "string" ? data.item.url : "";
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, "");
  } catch {}
  const safe = /^https?:\/\//i.test(url);
  return (
    <Shell id={id} item={data.item} selected={selected} kind="link" label={`Link: ${host}`}>
      <div className="board-body">
        <Icon name="globe" size={16} />{" "}
        {safe ? (
          <a className="nodrag" href={url} target="_blank" rel="noopener noreferrer">
            {host}
          </a>
        ) : (
          host
        )}
        <p className="muted small">{url}</p>
      </div>
    </Shell>
  );
});

const GroupCard = memo(function GroupCard({ id, data, selected }: NodeProps<Node<{ item: CanvasItem }>>) {
  const label = typeof data.item.label === "string" ? data.item.label : "";
  return (
    <Shell id={id} item={data.item} selected={selected} kind="group" label={`Group: ${label || "untitled"}`}>
      {label && <div className="board-group-label">{label}</div>}
    </Shell>
  );
});

const NODE_TYPES = { text: TextCard, file: FileCard, link: LinkCard, group: GroupCard };

// ── the board ──────────────────────────────────────────────────────────────────────────────

interface Props {
  ydoc: Y.Doc;
  awareness: Awareness;
  vaultId: number;
  notes: NoteSummary[];
  readOnly: boolean;
  ready: boolean;
  /** The board's own folder, where new notes made on it go. */
  folder: string;
  onOpenLink(target: string): void;
  /** Publish what the board can do, for the palette and the ⋯ menu. */
  onActions(a: BoardActions | null): void;
}

export interface BoardActions {
  addText(): void;
  addNote(): void;
  newNote(): void;
  addLink(): void;
  addGroup(): void;
  fit(): void;
  tidy(): void;
  mindMap(): void;
  remove(): void;
  front(): void;
  back(): void;
  labelArrow(): void;
  /** Turn the selected arrow round (F31). */
  reverse(): void;
  /** Join the selected card to another, picked from a list: an arrow without dragging (F31). */
  connect(): void;
  /** Every arrow as a sentence; choosing one selects it (the board's text alternative). */
  arrows(): void;
  /** An arrow between two notes is selected, so it can become a relation (F16). */
  relation: (() => void) | null;
  hasSelection: boolean;
  /** One arrow is selected. */
  hasArrow: boolean;
}

export function Board(props: Props) {
  return (
    <ReactFlowProvider>
      <BoardInner {...props} />
    </ReactFlowProvider>
  );
}

/** The board's maps as a plain board, redrawn (at most once a frame) when anyone changes them. */
function useCanvas(ydoc: Y.Doc) {
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const { nodes, edges, extra } = canvasMaps(ydoc);
    let frame = 0;
    const bump = () => {
      if (!frame) frame = requestAnimationFrame(() => ((frame = 0), setVersion((v) => v + 1)));
    };
    nodes.observeDeep(bump);
    edges.observeDeep(bump);
    extra.observe(bump);
    bump();
    return () => {
      cancelAnimationFrame(frame);
      nodes.unobserveDeep(bump);
      edges.unobserveDeep(bump);
      extra.unobserve(bump);
    };
  }, [ydoc]);
  return useMemo(() => canvasFromDoc(ydoc), [ydoc, version]);
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

function BoardInner(props: Props) {
  const { ydoc, readOnly } = props;
  const canvas = useCanvas(ydoc);
  const flow = useReactFlow();
  const narrow = useNarrow();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<string | null>(null);
  const [others, setOthers] = useState<Map<string, string>>(new Map());
  const maps = useMemo(() => canvasMaps(ydoc), [ydoc]);
  const undo = useMemo(() => new Y.UndoManager([maps.nodes, maps.edges], { trackedOrigins: new Set([BOARD_ORIGIN]), captureTimeout: 400 }), [maps]);
  useEffect(() => () => undo.destroy(), [undo]);
  const change = useCallback((fn: () => void) => ydoc.transact(fn, BOARD_ORIGIN), [ydoc]);

  // Others' selections, shown as a coloured outline (as the editor shows their cursors).
  useEffect(() => {
    const aw = props.awareness;
    aw.setLocalStateField("board", { selected: [...selected] });
  }, [selected, props.awareness]);
  useEffect(() => {
    const aw = props.awareness;
    const read = () => {
      const m = new Map<string, string>();
      aw.getStates().forEach((s, clientId) => {
        if (clientId === ydoc.clientID) return;
        for (const id of (s.board?.selected as string[] | undefined) ?? []) m.set(id, s.user?.color ?? "");
      });
      setOthers(m);
    };
    aw.on("change", read);
    read();
    return () => aw.off("change", read);
  }, [props.awareness, ydoc]);

  const byId = useMemo(() => new Map(canvas.nodes.map((n) => [n.id, n])), [canvas]);
  const nodes: Node<{ item: CanvasItem }>[] = useMemo(
    () =>
      canvas.nodes.map((item, i) => ({
        id: item.id,
        type: (item.type as string) in NODE_TYPES ? (item.type as string) : "text",
        position: { x: num(item.x, 0), y: num(item.y, 0) },
        width: num(item.width, 250),
        height: num(item.height, 60),
        data: { item },
        selected: selected.has(item.id),
        // Groups sit behind cards, whatever their place in the file.
        zIndex: item.type === "group" ? i - 100_000 : i,
        draggable: !readOnly,
        selectable: true,
        connectable: !readOnly,
      })),
    [canvas, selected, readOnly],
  );
  const edges: Edge[] = useMemo(
    () =>
      canvas.edges
        .filter((e) => byId.has(e.fromNode as string) && byId.has(e.toNode as string))
        .map((e) => {
          const from = byId.get(e.fromNode as string)!;
          const to = byId.get(e.toNode as string)!;
          const c = colourProps(e.color);
          const arrow = { type: MarkerType.ArrowClosed, width: 18, height: 18 };
          return {
            id: e.id,
            source: from.id,
            target: to.id,
            sourceHandle: SIDES.includes(e.fromSide as Side) ? (e.fromSide as string) : facing(from, to),
            targetHandle: SIDES.includes(e.toSide as Side) ? (e.toSide as string) : facing(to, from),
            label: typeof e.label === "string" ? e.label : undefined,
            markerEnd: e.toEnd === "none" ? undefined : arrow,
            markerStart: e.fromEnd === "arrow" ? arrow : undefined,
            className: `board-edge${c.className}`,
            style: c.style as React.CSSProperties,
            selected: selectedEdges.has(e.id),
            interactionWidth: 24,
          };
        }),
    [canvas, byId, selectedEdges],
  );

  // A group carries the cards inside it when it moves, as in other canvas editors.
  const carried = useRef<{ group: string; ids: string[] } | null>(null);
  const onNodesChange = useCallback(
    (changes: NodeChange<Node<{ item: CanvasItem }>>[]) => {
      let sel: Set<string> | null = null;
      const writes: (() => void)[] = [];
      for (const ch of changes) {
        if (ch.type === "select") {
          sel ??= new Set(selected);
          if (ch.selected) sel.add(ch.id);
          else sel.delete(ch.id);
        } else if (readOnly) continue;
        else if (ch.type === "position" && ch.position) {
          const m = maps.nodes.get(ch.id);
          if (!m) continue;
          const x = Math.round(ch.position.x);
          const y = Math.round(ch.position.y);
          const dx = x - num(m.get("x"), 0);
          const dy = y - num(m.get("y"), 0);
          if (m.get("type") === "group") {
            if (!carried.current || carried.current.group !== ch.id) carried.current = { group: ch.id, ids: inside(canvas.nodes, byId.get(ch.id)!) };
            for (const id of carried.current.ids) {
              const c = maps.nodes.get(id);
              if (c && !changes.some((o) => o.type === "position" && o.id === id)) writes.push(() => (c.set("x", num(c.get("x"), 0) + dx), c.set("y", num(c.get("y"), 0) + dy)));
            }
          }
          writes.push(() => (m.set("x", x), m.set("y", y)));
          if (!ch.dragging && carried.current?.group === ch.id) carried.current = null;
        } else if (ch.type === "dimensions" && ch.dimensions && ch.resizing) {
          const m = maps.nodes.get(ch.id);
          if (m) writes.push(() => (m.set("width", Math.round(ch.dimensions!.width)), m.set("height", Math.round(ch.dimensions!.height))));
        } else if (ch.type === "remove") {
          writes.push(() => removeNode(ch.id));
        }
      }
      if (writes.length) change(() => writes.forEach((w) => w()));
      if (sel) setSelected(sel);
    },
    [selected, readOnly, maps, canvas, byId, change],
  );

  const removeNode = (id: string) => {
    maps.nodes.delete(id);
    maps.edges.forEach((e, eid) => {
      if (e.get("fromNode") === id || e.get("toNode") === id) maps.edges.delete(eid);
    });
  };

  const onEdgesChange = useCallback(
    (changes: EdgeChange[]) => {
      let sel: Set<string> | null = null;
      const gone: string[] = [];
      for (const ch of changes) {
        if (ch.type === "select") {
          sel ??= new Set(selectedEdges);
          if (ch.selected) sel.add(ch.id);
          else sel.delete(ch.id);
        } else if (ch.type === "remove" && !readOnly) gone.push(ch.id);
      }
      if (gone.length) change(() => gone.forEach((id) => maps.edges.delete(id)));
      if (sel) setSelectedEdges(sel);
    },
    [selectedEdges, readOnly, maps, change],
  );

  const onConnect = useCallback(
    (c: Connection) => {
      if (readOnly || !c.source || !c.target || c.source === c.target) return;
      change(() => {
        const m = new Y.Map<unknown>();
        maps.edges.set(newId(), m);
        m.set("z", topZ(maps.edges));
        m.set("fromNode", c.source);
        if (c.sourceHandle) m.set("fromSide", c.sourceHandle);
        m.set("toNode", c.target);
        if (c.targetHandle) m.set("toSide", c.targetHandle);
      });
    },
    [readOnly, maps, change],
  );

  /** Where a new card goes: the middle of what's on screen, nudged so cards don't stack. */
  const nudge = useRef(0);
  const centre = () => {
    const el = document.querySelector(".board .react-flow");
    const r = el?.getBoundingClientRect();
    const p = flow.screenToFlowPosition({ x: (r?.left ?? 0) + (r?.width ?? 600) / 2, y: (r?.top ?? 0) + (r?.height ?? 400) / 2 });
    const n = (nudge.current = (nudge.current + 1) % 6);
    return { x: Math.round(p.x - 130 + n * 24), y: Math.round(p.y - 80 + n * 24) };
  };

  const addNode = (fields: Record<string, unknown>, size = { width: 260, height: 160 }) => {
    const id = newId();
    const at = centre();
    change(() => {
      const m = new Y.Map<unknown>();
      maps.nodes.set(id, m);
      m.set("z", fields.type === "group" ? -1 : topZ(maps.nodes));
      for (const [k, v] of Object.entries({ ...fields, ...at, ...size })) setField(m, k, v);
    });
    setSelected(new Set([id]));
    return id;
  };

  const oneArrow = selectedEdges.size === 1 ? [...selectedEdges][0]! : null;
  const actions: BoardActions = {
    hasSelection: selected.size > 0,
    hasArrow: !!oneArrow,
    remove: () => remove(),
    front: () => order(true),
    back: () => order(false),
    labelArrow: () => oneArrow && void labelEdge(oneArrow),
    reverse: () => oneArrow && reverseEdge(oneArrow),
    connect: () => void connectTo(),
    arrows: () => void listArrows(),
    relation: oneArrow && arrowNotes(oneArrow) ? () => makeRelation(oneArrow) : null,
    addText: () => {
      const id = addNode({ type: "text", text: "" }, { width: 260, height: 120 });
      setEditing(id);
    },
    addNote: async () => {
      const picked = await chooseDialog({
        title: "Add a note to the board",
        options: props.notes.map((n) => ({ value: n.path, label: n.title, hint: n.path.includes("/") ? n.path.slice(0, n.path.lastIndexOf("/")) : undefined, icon: BOARD_FILE.test(n.path) ? "graph" : "file" })),
        placeholder: "Find a note or board",
      });
      if (picked) addNode({ type: "file", file: picked }, BOARD_FILE.test(picked) ? { width: 320, height: 240 } : { width: 400, height: 400 });
    },
    newNote: async () => {
      const title = await promptDialog({ title: "New note on the board", label: "Title", placeholder: "An idea", action: "Create" });
      if (!title) return;
      try {
        const made = await api<Note>(`/vaults/${props.vaultId}/notes`, { body: { path: props.folder ? `${props.folder}/${title}` : title, content: "" } });
        addNode({ type: "file", file: made.path }, { width: 400, height: 300 });
        toast(`Made “${made.title}”`, { action: { label: "Open", run: () => navigate(noteUrl(props.vaultId, made.id)) } });
      } catch (e) {
        toastError(e);
      }
    },
    addLink: async () => {
      const url = await promptDialog({ title: "Add a link", label: "Web address", placeholder: "https://…", action: "Add" });
      if (!url) return;
      const full = /^[a-z]+:\/\//i.test(url) ? url : `https://${url}`;
      addNode({ type: "link", url: full }, { width: 320, height: 120 });
    },
    addGroup: async () => {
      const label = await promptDialog({ title: "Group", label: "Name", placeholder: "Ideas", action: "Group" });
      if (label === null) return;
      const chosen = canvas.nodes.filter((n) => selected.has(n.id));
      if (!chosen.length) return void addNode({ type: "group", label }, { width: 600, height: 400 });
      const pad = 40;
      const x = Math.min(...chosen.map((n) => num(n.x, 0))) - pad;
      const y = Math.min(...chosen.map((n) => num(n.y, 0))) - pad - 20;
      const w = Math.max(...chosen.map((n) => num(n.x, 0) + num(n.width, 0))) + pad - x;
      const h = Math.max(...chosen.map((n) => num(n.y, 0) + num(n.height, 0))) + pad - y;
      const id = newId();
      change(() => {
        const m = new Y.Map<unknown>();
        maps.nodes.set(id, m);
        m.set("z", -1);
        for (const [k, v] of Object.entries({ type: "group", label, x, y, width: w, height: h })) setField(m, k, v);
      });
    },
    fit: () => void flow.fitView({ padding: 0.15, duration: 300 }),
    tidy: () => change(() => tidy(maps.nodes, selected.size ? selected : null)),
    mindMap: () => {
      const root = [...selected][0];
      if (!root) return toast("Select the card the map grows from");
      change(() => mindMap(maps.nodes, maps.edges, root));
    },
  };
  useEffect(() => {
    props.onActions(actions);
  });
  useEffect(() => () => props.onActions(null), []);

  function colour(c: string | null) {
    change(() => {
      for (const id of selected) {
        const m = maps.nodes.get(id);
        if (m) setField(m, "color", c ?? undefined);
      }
      for (const id of selectedEdges) {
        const m = maps.edges.get(id);
        if (m) setField(m, "color", c ?? undefined);
      }
    });
  }
  function order(front: boolean) {
    change(() => {
      let z = front ? topZ(maps.nodes) : Math.min(0, ...[...maps.nodes.values()].map((m) => num(m.get("z"), 0))) - selected.size;
      for (const id of selected) maps.nodes.get(id)?.set("z", z++);
    });
  }
  function remove() {
    const n = selected.size + selectedEdges.size;
    change(() => {
      for (const id of selected) removeNode(id);
      for (const id of selectedEdges) maps.edges.delete(id);
    });
    setSelected(new Set());
    setSelectedEdges(new Set());
    if (n) toast(`Removed ${n === 1 ? "it" : `${n} things`} from the board`, { undo: () => undo.undo() });
  }
  /** The notes at each end of an arrow, when both ends are note cards. */
  function arrowNotes(edgeId: string) {
    const e = canvas.edges.find((x) => x.id === edgeId);
    const note = (nid: unknown) => {
      const f = byId.get(nid as string)?.file;
      return typeof f === "string" && NOTE_FILE.test(f) ? props.notes.find((n) => n.path.toLowerCase() === f.toLowerCase()) : undefined;
    };
    const from = e && note(e.fromNode);
    const to = e && note(e.toNode);
    return from && to && from.id !== to.id ? { from, to, label: typeof e!.label === "string" ? e!.label : "" } : null;
  }

  // An arrow made into a relationship (F16, F31): the builder opens with the arrow's two notes and
  // its label as the kind, and writes a property of the note it starts from, so the connection
  // holds outside the board too. The arrow stays.
  function makeRelation(edgeId: string) {
    const ends = arrowNotes(edgeId);
    if (!ends) return;
    openRelationshipBuilder({ vaultId: props.vaultId, notes: props.notes, from: ends.from.id, to: ends.to.id, kind: ends.label.trim() || undefined });
  }

  // Reverse (F31): the arrow's ends and sides change places and its heads stay where they are,
  // so it points the other way. One change, so one Undo.
  function reverseEdge(id: string) {
    const m = maps.edges.get(id);
    if (!m || readOnly) return;
    const e = canvas.edges.find((x) => x.id === id);
    change(() => {
      const [fn, tn, fs, ts] = [m.get("fromNode"), m.get("toNode"), m.get("fromSide"), m.get("toSide")];
      m.set("fromNode", tn);
      m.set("toNode", fn);
      setField(m, "fromSide", ts ?? undefined);
      setField(m, "toSide", fs ?? undefined);
    });
    if (e) toast(`Turned round: ${arrowSentence({ ...e, fromNode: e.toNode, toNode: e.fromNode }, byId, props.notes)}`, { undo: () => undo.undo() });
  }

  // Connect to… (F31, WCAG 2.5.7): the other card from a list, so an arrow never needs a drag.
  async function connectTo() {
    if (readOnly || selected.size !== 1) return toast("Select the card the arrow starts from");
    const fromId = [...selected][0]!;
    const from = byId.get(fromId);
    const options = canvas.nodes
      .filter((n) => n.id !== fromId)
      .map((n) => ({ value: n.id, label: cardName(n, props.notes), icon: (n.type === "file" ? "file" : n.type === "link" ? "globe" : n.type === "group" ? "rows" : "text") }));
    if (!options.length) return toast("There's no other card to join it to");
    const to = await chooseDialog({ title: `Arrow from “${cardName(from, props.notes)}” to…`, options, placeholder: "Find a card" });
    if (!to) return;
    const id = newId();
    change(() => {
      const m = new Y.Map<unknown>();
      maps.edges.set(id, m);
      m.set("z", topZ(maps.edges));
      m.set("fromNode", fromId);
      m.set("toNode", to);
    });
    setSelected(new Set());
    setSelectedEdges(new Set([id]));
    toast(`Joined ${cardName(from, props.notes)} → ${cardName(byId.get(to), props.notes)}`, { undo: () => undo.undo() });
    host.current?.focus();
  }

  // Arrows on this board (F31): every arrow as a sentence; choosing one selects it and brings it
  // into view, so a screen reader can follow the board and act on an arrow.
  async function listArrows() {
    const drawn = canvas.edges.filter((e) => byId.has(e.fromNode as string) && byId.has(e.toNode as string));
    if (!drawn.length) return toast("There are no arrows on this board yet");
    const id = await chooseDialog({
      title: `Arrows on this board (${drawn.length})`,
      options: drawn.map((e) => ({ value: e.id, label: arrowSentence(e, byId, props.notes), icon: "arrow-right" })),
      placeholder: "Find an arrow",
    });
    if (!id) return;
    const e = drawn.find((x) => x.id === id)!;
    setSelected(new Set());
    setSelectedEdges(new Set([id]));
    void flow.fitView({ nodes: [{ id: e.fromNode as string }, { id: e.toNode as string }], padding: 0.3, duration: 300, maxZoom: 1 });
    host.current?.focus();
  }

  async function labelEdge(id: string) {
    const m = maps.edges.get(id);
    if (!m || readOnly) return;
    const label = await promptDialog({ title: "Label the arrow", label: "Label", value: typeof m.get("label") === "string" ? (m.get("label") as string) : "", action: "Save" });
    if (label !== null) change(() => setField(m, "label", label || undefined));
  }

  // ⌘Z / ⇧⌘Z for the board's own history; Delete removes what's selected.
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest("textarea, input")) return;
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) undo.redo();
        else undo.undo();
      } else if (!readOnly && (e.key === "Delete" || e.key === "Backspace") && (selected.size || selectedEdges.size)) {
        e.preventDefault();
        remove();
      } else if (!readOnly && e.key === "Enter" && selected.size === 1) {
        const id = [...selected][0]!;
        if (maps.nodes.get(id)?.get("type") === "text") (e.preventDefault(), setEditing(id));
      }
    };
    el.addEventListener("keydown", onKey);
    return () => el.removeEventListener("keydown", onKey);
  });

  const ctx: Ctx = useMemo(
    () => ({
      vaultId: props.vaultId,
      notes: props.notes,
      readOnly,
      editing,
      setEditing,
      ydoc,
      others,
      openPath: (path: string) => props.onOpenLink(path.replace(/\.md$/i, "")),
    }),
    [props.vaultId, props.notes, readOnly, editing, ydoc, others],
  );

  // Fit once the board has arrived.
  const fitted = useRef(false);
  useEffect(() => {
    if (fitted.current || !props.ready) return;
    fitted.current = true;
    requestAnimationFrame(() => flow.fitView({ padding: 0.15, maxZoom: 1 }));
  }, [props.ready, canvas]);

  const empty = props.ready && !canvas.nodes.length;
  const some = selected.size + selectedEdges.size > 0;
  return (
    <BoardCtx.Provider value={ctx}>
      {/* Focusable, so ⌘Z and Delete reach it after a click on empty board or a dialog closing. */}
      <div className="board" ref={host} data-cards={canvas.nodes.length} tabIndex={-1}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={NODE_TYPES}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onEdgeDoubleClick={(_, e) => void labelEdge(e.id)}
          onPaneClick={() => setEditing(null)}
          connectionMode={ConnectionMode.Loose}
          nodesDraggable={!readOnly}
          nodesConnectable={!readOnly}
          elementsSelectable
          deleteKeyCode={null}
          selectionOnDrag={!narrow}
          panOnDrag={narrow ? true : [1, 2]}
          panOnScroll={!narrow}
          zoomOnPinch
          minZoom={0.05}
          maxZoom={4}
          onlyRenderVisibleElements
          proOptions={{ hideAttribution: true }}
          aria-label="Board"
        >
          <Background gap={24} size={1} />
          {!narrow && <MiniMap pannable zoomable className="board-minimap" />}
          <Panel position="top-left" className="board-toolbar" aria-label="Board">
            {!readOnly && (
              <>
                <Menu
                  label="Add a card"
                  icon="plus"
                  className="icon-btn"
                  items={[
                    { label: "Text", icon: "text", onSelect: actions.addText },
                    { label: "Note or board…", icon: "file", onSelect: () => void actions.addNote() },
                    { label: "New note…", icon: "plus", onSelect: () => void actions.newNote() },
                    { label: "Link…", icon: "globe", onSelect: () => void actions.addLink() },
                    { label: selected.size ? "Group the selection…" : "Group…", icon: "rows", onSelect: () => void actions.addGroup() },
                  ]}
                />
                {some && (
                  <>
                    <Menu
                      label="Colour"
                      icon="sparkle"
                      className="icon-btn"
                      items={[...PRESETS.map((p) => ({ label: p.label, icon: "check-plain", onSelect: () => colour(p.value) })), { label: "No colour", icon: "x", onSelect: () => colour(null) }]}
                    />
                    {selected.size > 0 && (
                      <Menu
                        label="Arrange"
                        icon="sort"
                        className="icon-btn"
                        items={[
                          { label: "Bring to front", icon: "arrow-up", onSelect: () => order(true) },
                          { label: "Send to back", icon: "arrow-down", onSelect: () => order(false) },
                          { label: "Tidy up", icon: "columns", onSelect: actions.tidy },
                          { label: "Arrange the group", icon: "rows", hidden: !(selected.size === 1 && maps.nodes.get([...selected][0]!)?.get("type") === "group"), onSelect: () => change(() => arrange(maps.nodes, [...selected][0]!)) },
                          { label: "Mind map from here", icon: "branch", hidden: selected.size !== 1, onSelect: actions.mindMap },
                        ]}
                      />
                    )}
                    {selectedEdges.size === 1 && (
                      <button className="icon-btn" onClick={() => void labelEdge([...selectedEdges][0]!)} aria-label="Label the arrow" title="Label the arrow">
                        <Icon name="tag" />
                      </button>
                    )}
                    {selectedEdges.size === 1 && (
                      <button className="icon-btn" onClick={() => reverseEdge([...selectedEdges][0]!)} aria-label="Reverse the arrow" title="Reverse the arrow">
                        <Icon name="swap" />
                      </button>
                    )}
                    {selected.size === 1 && (
                      <button className="icon-btn" onClick={() => void connectTo()} aria-label="Connect to another card" title="Connect to…">
                        <Icon name="arrow-right" />
                      </button>
                    )}
                    {selectedEdges.size === 1 && arrowNotes([...selectedEdges][0]!) && (
                      <button className="icon-btn" onClick={() => makeRelation([...selectedEdges][0]!)} aria-label="Make this a relationship" title="Make this a relationship…">
                        <Icon name="link" />
                      </button>
                    )}
                    <button className="icon-btn" onClick={remove} aria-label="Remove from the board" title="Remove from the board (Delete)">
                      <Icon name="trash" />
                    </button>
                  </>
                )}
                <button className="icon-btn" onClick={() => undo.undo()} aria-label="Undo" title="Undo (⌘Z)">
                  <Icon name="undo" />
                </button>
                <button className="icon-btn" onClick={() => undo.redo()} aria-label="Redo" title="Redo (⇧⌘Z)">
                  <Icon name="redo" />
                </button>
              </>
            )}
            <button className="icon-btn" onClick={() => void listArrows()} aria-label="Arrows on this board" title="Arrows on this board">
              <Icon name="list" />
            </button>
            <button className="icon-btn" onClick={actions.fit} aria-label="Fit the board" title="Fit the board">
              <Icon name="width" />
            </button>
          </Panel>
        </ReactFlow>
        {empty && (
          <div className="board-empty">
            <p>{readOnly ? "This board is empty." : "An empty board. Add a note, some text or a link with +, then draw arrows between them from a card's edge."}</p>
          </div>
        )}
      </div>
    </BoardCtx.Provider>
  );
}

/** The cards wholly inside a group's frame. */
function inside(all: CanvasItem[], g: CanvasItem): string[] {
  const gx = num(g.x, 0);
  const gy = num(g.y, 0);
  const gw = num(g.width, 0);
  const gh = num(g.height, 0);
  return all
    .filter((n) => n.id !== g.id && num(n.x, 0) >= gx && num(n.y, 0) >= gy && num(n.x, 0) + num(n.width, 0) <= gx + gw && num(n.y, 0) + num(n.height, 0) <= gy + gh)
    .map((n) => n.id);
}
