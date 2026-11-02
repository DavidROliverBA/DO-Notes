// Live multi-user editing: one Yjs document per open note, synchronised over Bun's native
// WebSockets using the standard y-websocket wire protocol (so the stock `y-websocket` client and
// `y-codemirror.next` work unchanged), with cursors/selections shared via the awareness protocol.
//
// Persistence: the room writes the materialised markdown AND the CRDT state back to Postgres a
// moment after edits go quiet (and at least every few seconds during continuous typing), and
// immediately when the last person leaves or the server shuts down.
//
// CRDT continuity matters: if the server ever rebuilt a document from plain text while a client
// still held the old one (an offline phone reconnecting), Yjs would merge the two histories and
// duplicate the text. So server-side text changes are applied as a minimal diff to the existing
// CRDT state — never by replacing it.

import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import type { ServerWebSocket } from "bun";
import { sql } from "./db";
import { persist, setLiveOverwrite, writeBarrier } from "./notes";
import { assertNoteSize } from "./storage";
import { isCanvasPath } from "./canvas";
import { applyContent, docContent, loadDoc } from "./ydoc";

const MSG_SYNC = 0;
const MSG_AWARENESS = 1;
const MSG_QUERY_AWARENESS = 3;
const QUIET_MS = 800;
const MAX_WAIT_MS = 4000;
const SAVE_RETRY_MAX_MS = 30_000;

export interface CollabData {
  kind: "collab";
  noteId: number;
  vaultId: number;
  userId: number;
  canWrite: boolean;
  /** SHA-256 of the session token, so signing out can close this socket. */
  sessionHash: string;
  /** Messages that arrived while the room was still loading from the database. */
  pending?: Uint8Array[];
}

type Conn = ServerWebSocket<CollabData>;

interface Room {
  noteId: number;
  doc: Y.Doc;
  /** A board (F11): its document holds cards, not text (src/canvas.ts). */
  board: boolean;
  /** The text last read or saved, which a board keeps byte for byte while its cards are unchanged. */
  content: string;
  awareness: awarenessProtocol.Awareness;
  conns: Map<Conn, Set<number>>; // conn → awareness client ids it controls
  lastEditor: number | null;
  timer: Timer | null;
  firstDirtyAt: number | null;
  saving: Promise<void>;
  /** Consecutive failed saves; while > 0 a retry is scheduled and the room is kept. */
  failures: number;
}

const rooms = new Map<number, Room>();
const loading = new Map<number, Promise<Room>>();

async function openRoom(noteId: number): Promise<Room> {
  const existing = rooms.get(noteId);
  if (existing) return existing;
  const inflight = loading.get(noteId);
  if (inflight) return inflight;
  const p = (async () => {
    // A REST/import write that started before this room existed must land before we read the
    // row, or the room would hold (and later re-save) the old text.
    await writeBarrier(noteId);
    const [n] = await sql`select path, content, ydoc from notes where id = ${noteId}`;
    if (!n) throw new Error("note not found");
    const board = isCanvasPath(n.path);
    const doc = loadDoc(n.content, n.ydoc ? new Uint8Array(n.ydoc) : null, board);
    const room: Room = {
      noteId,
      doc,
      board,
      content: n.content,
      awareness: new awarenessProtocol.Awareness(doc),
      conns: new Map(),
      lastEditor: null,
      timer: null,
      firstDirtyAt: null,
      saving: Promise.resolve(),
      failures: 0,
    };
    room.awareness.setLocalState(null); // the server has no cursor

    doc.on("update", (update: Uint8Array, origin: unknown) => {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.writeUpdate(enc, update);
      broadcast(room, encoding.toUint8Array(enc));
      const conn = origin as Conn | undefined;
      if (conn && typeof conn === "object" && "data" in conn) room.lastEditor = conn.data.userId;
      scheduleSave(room);
    });

    room.awareness.on("update", ({ added, updated, removed }: Record<string, number[]>, origin: unknown) => {
      const changed = [...added!, ...updated!, ...removed!];
      const conn = origin as Conn | undefined;
      const owned = conn ? room.conns.get(conn) : undefined;
      if (owned) {
        for (const id of added!) owned.add(id);
        for (const id of removed!) owned.delete(id);
      }
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, changed));
      broadcast(room, encoding.toUint8Array(enc));
    });

    rooms.set(noteId, room);
    return room;
  })();
  loading.set(noteId, p);
  try {
    return await p;
  } finally {
    loading.delete(noteId);
  }
}

function broadcast(room: Room, msg: Uint8Array) {
  for (const conn of room.conns.keys()) conn.send(msg);
}

function scheduleSave(room: Room) {
  const now = Date.now();
  room.firstDirtyAt ??= now;
  if (room.timer) clearTimeout(room.timer);
  const wait = Math.max(0, Math.min(QUIET_MS, room.firstDirtyAt + MAX_WAIT_MS - now));
  room.timer = setTimeout(() => void save(room), wait);
}

function save(room: Room): Promise<void> {
  if (room.timer) clearTimeout(room.timer);
  room.timer = null;
  room.firstDirtyAt = null;
  // Saves are serialised per room so an older snapshot can never land after a newer one.
  room.saving = room.saving
    .then(async () => {
      const content = docContent(room.doc, room.board, room.content);
      await persist(room.noteId, content, room.lastEditor, Y.encodeStateAsUpdate(room.doc));
      room.content = content;
      room.failures = 0;
    })
    .catch((err) => {
      // The room may hold the only copy of these edits (e.g. the database is down and everyone
      // has left), so keep it and retry with backoff. The pending timer also blocks teardown.
      room.failures++;
      console.error(`saving note ${room.noteId} failed (attempt ${room.failures}):`, err);
      if (!room.timer) room.timer = setTimeout(() => void save(room), Math.min(SAVE_RETRY_MAX_MS, 1000 * 2 ** room.failures));
    })
    .then(() => maybeTeardown(room));
  return room.saving;
}

/** Drop an empty room once everything is saved — but not while a change is still pending. */
function maybeTeardown(room: Room) {
  if (room.conns.size > 0 || room.timer || rooms.get(room.noteId) !== room) return;
  rooms.delete(room.noteId);
  room.awareness.destroy();
  room.doc.destroy();
}

// REST / import / restore writes land in the live document when the note is open or opening.
// Decided synchronously, so notes.ts can register its write barrier in the same tick otherwise.
setLiveOverwrite((noteId, next, userId) => {
  if (!rooms.has(noteId) && !loading.has(noteId)) return null;
  return openRoom(noteId).then((room) => {
    const text = typeof next === "string" ? next : next(docContent(room.doc, room.board, room.content));
    assertNoteSize(text);
    room.lastEditor = userId;
    room.doc.transact(() => applyContent(room.doc, room.board, text), "server");
    // A board written from outside keeps that exact text unless its cards then change.
    if (room.board && docContent(room.doc, true, text) === text) room.content = text;
    // Saved now, not after the typing pause: whoever wrote it reads it back at once (the side
    // panel after a relationship changes, F31), and the database has it when the request returns.
    return save(room);
  });
});

export async function onOpen(ws: Conn): Promise<void> {
  // The client sends its sync step 1 the moment the socket opens, usually before the room has
  // loaded; hold those messages and replay them once we've joined, or the client never syncs.
  ws.data.pending = [];
  let room: Room;
  try {
    room = await openRoom(ws.data.noteId);
  } catch {
    ws.close(4404, "note not found");
    return;
  }
  if (ws.readyState !== 1) return; // closed while loading
  room.conns.set(ws, new Set());
  const enc = encoding.createEncoder();
  encoding.writeVarUint(enc, MSG_SYNC);
  syncProtocol.writeSyncStep1(enc, room.doc);
  ws.send(encoding.toUint8Array(enc));
  const states = room.awareness.getStates();
  if (states.size > 0) {
    const a = encoding.createEncoder();
    encoding.writeVarUint(a, MSG_AWARENESS);
    encoding.writeVarUint8Array(a, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...states.keys()]));
    ws.send(encoding.toUint8Array(a));
  }
  const queued = ws.data.pending ?? [];
  ws.data.pending = undefined;
  for (const m of queued) handle(ws, room, m);
}

export function onMessage(ws: Conn, message: string | Buffer): void {
  if (typeof message === "string") return;
  const bytes = new Uint8Array(message);
  if (ws.data.pending) {
    if (ws.data.pending.length < 1000) ws.data.pending.push(bytes);
    return;
  }
  const room = rooms.get(ws.data.noteId);
  if (room && room.conns.has(ws)) handle(ws, room, bytes);
}

function handle(ws: Conn, room: Room, bytes: Uint8Array): void {
  try {
    const decoder = decoding.createDecoder(bytes);
    const type = decoding.readVarUint(decoder);
    if (type === MSG_SYNC) {
      // Sync sub-types: 0 = step 1 (a request), 1 = step 2 and 2 = update (both writes).
      // Viewers may ask for the document but their writes are dropped.
      if (!ws.data.canWrite && decoding.peekVarUint(decoder) !== syncProtocol.messageYjsSyncStep1) return;
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_SYNC);
      syncProtocol.readSyncMessage(decoder, enc, room.doc, ws);
      if (encoding.length(enc) > 1) ws.send(encoding.toUint8Array(enc));
    } else if (type === MSG_AWARENESS) {
      const update = decoding.readVarUint8Array(decoder);
      // A client may only set its own presence, not overwrite another connection's cursor/name.
      if (claimsOthersPresence(room, ws, update)) return;
      awarenessProtocol.applyAwarenessUpdate(room.awareness, update, ws);
    } else if (type === MSG_QUERY_AWARENESS) {
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MSG_AWARENESS);
      encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(room.awareness, [...room.awareness.getStates().keys()]));
      ws.send(encoding.toUint8Array(enc));
    }
  } catch (err) {
    console.warn(`collab: bad message on note ${ws.data.noteId}:`, (err as Error).message);
  }
}

function claimsOthersPresence(room: Room, ws: Conn, update: Uint8Array): boolean {
  const d = decoding.createDecoder(update);
  const n = decoding.readVarUint(d);
  for (let i = 0; i < n; i++) {
    const clientId = decoding.readVarUint(d);
    decoding.readVarUint(d); // clock
    decoding.readVarString(d); // state JSON
    for (const [conn, owned] of room.conns) if (conn !== ws && owned.has(clientId)) return true;
  }
  return false;
}

export function onClose(ws: Conn): void {
  const room = rooms.get(ws.data.noteId);
  if (!room) return;
  const owned = room.conns.get(ws);
  room.conns.delete(ws);
  if (owned?.size) awarenessProtocol.removeAwarenessStates(room.awareness, [...owned], null);
  if (room.conns.size === 0) void save(room); // tears the room down once saved, if still empty
}

/** Disconnect everyone from a note (deleted) or a user from a vault (removed/demoted). */
export function kick(filter: { noteId?: number; vaultId?: number; userId?: number; sessionHash?: string }, reason = "access changed"): void {
  for (const room of rooms.values()) {
    for (const conn of room.conns.keys()) {
      const d = conn.data;
      if (filter.noteId !== undefined && d.noteId !== filter.noteId) continue;
      if (filter.vaultId !== undefined && d.vaultId !== filter.vaultId) continue;
      if (filter.userId !== undefined && d.userId !== filter.userId) continue;
      if (filter.sessionHash !== undefined && d.sessionHash !== filter.sessionHash) continue;
      conn.close(4403, reason);
    }
  }
}

export async function flushAll(): Promise<void> {
  await Promise.all([...rooms.values()].map((r) => save(r)));
}

/** Save a note's live room now (if it has one), e.g. before it's moved to Trash. */
export async function flushNote(noteId: number): Promise<void> {
  const room = rooms.get(noteId) ?? (await loading.get(noteId)?.catch(() => null));
  if (room) await save(room);
}
