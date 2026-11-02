// The vault's types (F16), loaded with its notes and shared by the sidebar, the type chip, the
// properties panel, type pages and the command list. Module state, like the command registry,
// so CodeMirror's properties widget (outside React) can read it too.

import { useSyncExternalStore } from "react";
import { normalisePath } from "../../src/markdown";
import { newTypedNote, newTypeNote, STARTERS, starterNeeds, starterNote, type TypeDef, TYPES_FOLDER } from "../../src/types";
import { type Kind, kindNamed, relationshipKinds } from "../../src/relationships";
import { api, type Note } from "./api";
import { fillTemplate } from "./templates";

export type { TypeDef, TypeProp } from "../../src/types";

interface State {
  vaultId: number | null;
  types: TypeDef[];
  undefined: { name: string; count: number }[];
  /** The kinds of relationship (F31): the collection's own, its types', AI-XF's core. */
  kinds: Kind[];
}
const CORE = relationshipKinds([], []);
let state: State = { vaultId: null, types: [], undefined: [], kinds: CORE };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

/** Fetch the vault's types, and the type names notes use that have no definition yet. */
// The vault being shown: a reply for any other (a quick vault switch) is dropped.
let current: number | null = null;
export async function loadTypes(vaultId: number): Promise<void> {
  current = vaultId;
  if (state.vaultId !== vaultId) ((state = { vaultId, types: [], undefined: [], kinds: CORE }), emit()); // not the last vault's meanwhile
  const [r, k] = await Promise.all([
    api<{ types: TypeDef[]; undefined: { name: string; count: number }[] }>(`/vaults/${vaultId}/types`),
    api<{ kinds: Kind[] }>(`/vaults/${vaultId}/relationships`).catch(() => ({ kinds: CORE })),
  ]);
  if (vaultId !== current) return;
  state = { vaultId, types: r.types, undefined: r.undefined, kinds: k.kinds };
  emit();
}
export const typesState = () => state;
export function subscribeTypes(f: () => void) {
  listeners.add(f);
  return () => void listeners.delete(f);
}
export const useTypes = () => useSyncExternalStore(subscribeTypes, typesState);

export const typeNamed = (name: string | null | undefined): TypeDef | null =>
  name ? (state.types.find((t) => t.name.toLowerCase() === name.toLowerCase()) ?? null) : null;

/** The kind of relationship a property key names, in this collection's words (F31). */
export const relationKind = (key: string): Kind | null => kindNamed(state.kinds, key);

export const typeUrl = (vaultId: number, name: string) => `/v/${vaultId}/t/${encodeURIComponent(name)}`;

/** Make a note of a type: its `type:` line and the type's template, filled in. */
export async function createTypedNote(vaultId: number, type: TypeDef, title: string, folder?: string): Promise<Note> {
  const def = await api<Note>(`/vaults/${vaultId}/notes/${type.noteId}`);
  const body = def.content.replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, "");
  const content = newTypedNote(type, fillTemplate(body, { title, date: new Date() }));
  return api<Note>(`/vaults/${vaultId}/notes`, { body: { path: normalisePath(folder ? `${folder}/${title}` : title), content } });
}

/** Make a type: a note in Types/ with a starter property, then the vault's types reload. */
export async function createType(vaultId: number, name: string): Promise<Note> {
  const n = await api<Note>(`/vaults/${vaultId}/notes`, { body: { path: normalisePath(`${TYPES_FOLDER}/${name}`), content: newTypeNote(name) } });
  await loadTypes(vaultId);
  return n;
}

/** Add starter types the collection hasn't got, with the starters their links need (a Meeting's
 *  attendees are People). Returns the names added, in order; the types reload after. */
export async function addStarters(vaultId: number, names: string[]): Promise<string[]> {
  await loadTypes(vaultId);
  const has = (n: string) => state.types.some((t) => t.name.toLowerCase() === n.toLowerCase());
  const added: string[] = [];
  const add = async (n: string) => {
    const st = STARTERS.find((x) => x.name === n);
    if (!st || has(n) || added.includes(n)) return;
    await api<Note>(`/vaults/${vaultId}/notes`, { body: { path: normalisePath(`${TYPES_FOLDER}/${st.name}`), content: starterNote(st) } });
    added.push(n);
    for (const need of starterNeeds(st)) await add(need);
  };
  try {
    for (const n of names) await add(n);
  } finally {
    await loadTypes(vaultId);
  }
  return added;
}

/** Set some of a note's properties (null removes one), live-safe. */
export const setProperties = (vaultId: number, noteId: number, set: Record<string, unknown>) =>
  api<Note>(`/vaults/${vaultId}/notes/${noteId}/properties`, { method: "PATCH", body: { set } });
