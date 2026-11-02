// AI-XF bundles (F9, src/aixf.ts): export a collection or folder as a bundle. Notes need ids
// first (Level 1); an editor is asked once before they're written in, and a viewer's export
// gives the missing ones for that bundle only.

import { api } from "./api";
import { confirmDialog, toast, toastError } from "../ui/overlays";

export async function exportAixf(vaultId: number, canWrite: boolean, folder?: string): Promise<void> {
  try {
    const q = folder ? `?folder=${encodeURIComponent(folder)}` : "";
    const { missing } = await api<{ missing: number }>(`/vaults/${vaultId}/aixf/ids${q}`);
    if (missing > 0 && canWrite) {
      const yes = await confirmDialog({
        title: `Give ${missing} ${missing === 1 ? "note an id" : "notes ids"}?`,
        message: "An AI-XF bundle names each note by an id that never changes, so links from other collections and from Longview keep working. Each note gets `id:` in its properties, made from its title. Renaming a note later doesn't change it.",
        action: missing === 1 ? "Give it an id" : "Give them ids",
      });
      if (!yes) return;
      const { given } = await api<{ given: number }>(`/vaults/${vaultId}/aixf/ids`, { body: { folder } });
      toast(`Gave ${given} ${given === 1 ? "note an id" : "notes ids"}`);
    }
    location.href = `/api/vaults/${vaultId}/export?format=ai-xf${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`;
  } catch (e) {
    toastError(e);
  }
}
