// In-process pub/sub for vault-level changes (notes created, saved, renamed or deleted; folders;
// a whole-vault change after an import or a GitHub update), fanned
// out to browsers over Server-Sent Events so every member's file tree stays current. Live text
// edits travel separately, over the Yjs WebSocket (src/collab.ts).

export type VaultEvent =
  | { type: "note.created"; id: number; path: string; by: number | null }
  | { type: "note.updated"; id: number; path: string; version: number; by: number | null }
  | { type: "note.renamed"; id: number; path: string; from: string; by: number | null }
  | { type: "note.deleted"; id: number; path: string; by: number | null }
  | { type: "folders.changed"; by: number | null }
  | { type: "vault.changed" }
  | { type: "comments.changed"; noteId: number; by: number | null };

type Listener = (e: VaultEvent) => void;
const listeners = new Map<number, Set<Listener>>();

export function subscribe(vaultId: number, fn: Listener): () => void {
  let set = listeners.get(vaultId);
  if (!set) listeners.set(vaultId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) listeners.delete(vaultId);
  };
}

export function emit(vaultId: number, e: VaultEvent): void {
  for (const fn of listeners.get(vaultId) ?? []) {
    try {
      fn(e);
    } catch (err) {
      console.warn("event listener failed:", err);
    }
  }
}
