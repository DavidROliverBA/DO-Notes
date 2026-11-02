// Comments on notes (L3, src/comments.ts), for the note and the side panel: loaded per note, kept
// up to date when anyone changes them (the "cp:comments" event the app passes on from the
// server's stream), and anchored with Yjs relative positions, so a thread stays on its words while
// anyone edits around them.

import { useEffect, useState } from "react";
import * as Y from "yjs";
import { api } from "./api";

export interface Comment {
  id: number;
  parentId: number | null;
  author: string | null;
  authorId: number | null;
  quote: string;
  from: string | null;
  to: string | null;
  body: string;
  at: string;
  edited: boolean;
  resolved: boolean;
}

const cache = new Map<string, Comment[]>();
const keyOf = (v: number, n: number) => `${v}:${n}`;
const changed = new EventTarget();

export async function loadComments(vaultId: number, noteId: number): Promise<Comment[]> {
  const list = await api<Comment[]>(`/vaults/${vaultId}/notes/${noteId}/comments`);
  cache.set(keyOf(vaultId, noteId), list);
  changed.dispatchEvent(new Event(keyOf(vaultId, noteId)));
  return list;
}

/** A note's comments, kept current. */
export function useComments(vaultId: number, noteId: number): Comment[] {
  const key = keyOf(vaultId, noteId);
  const [list, setList] = useState<Comment[]>(() => cache.get(key) ?? []);
  useEffect(() => {
    setList(cache.get(key) ?? []);
    const update = () => setList(cache.get(key) ?? []);
    changed.addEventListener(key, update);
    const remote = (e: Event) => (e as CustomEvent<number>).detail === noteId && void loadComments(vaultId, noteId).catch(() => {});
    window.addEventListener("cp:comments", remote);
    void loadComments(vaultId, noteId).catch(() => {});
    return () => {
      changed.removeEventListener(key, update);
      window.removeEventListener("cp:comments", remote);
    };
  }, [key]);
  return list;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** Anchors for the text between `from` and `to`: they follow the words through others' edits. */
export function anchorsFor(ytext: Y.Text, from: number, to: number): { from: string; to: string } {
  return {
    from: b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, from))),
    // The end sticks to the character before it, so typing just after the words isn't taken in.
    to: b64(Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(ytext, to, -1))),
  };
}

/** Where a thread's words are now; null when they've been deleted (the thread stays, unanchored). */
export function rangeOf(ydoc: Y.Doc, c: Comment): { from: number; to: number } | null {
  if (!c.from || !c.to) return null;
  try {
    const a = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unb64(c.from)), ydoc);
    const b = Y.createAbsolutePositionFromRelativePosition(Y.decodeRelativePosition(unb64(c.to)), ydoc);
    if (!a || !b || b.index <= a.index) return null;
    return { from: a.index, to: b.index };
  } catch {
    return null;
  }
}

export async function addComment(vaultId: number, noteId: number, b: { body: string; quote?: string; from?: string; to?: string; parentId?: number }): Promise<void> {
  const list = await api<Comment[]>(`/vaults/${vaultId}/notes/${noteId}/comments`, { body: b });
  cache.set(keyOf(vaultId, noteId), list);
  changed.dispatchEvent(new Event(keyOf(vaultId, noteId)));
}

export async function changeComment(vaultId: number, noteId: number, id: number, change: { resolved?: boolean; body?: string }): Promise<void> {
  const list = await api<Comment[]>(`/vaults/${vaultId}/notes/${noteId}/comments/${id}`, { method: "PATCH", body: change });
  cache.set(keyOf(vaultId, noteId), list);
  changed.dispatchEvent(new Event(keyOf(vaultId, noteId)));
}
