// Send to Longview (F30 step 4; the server side is src/sendLongview.ts): a Weblink note's address
// saved into your Longview, with a reason if you give one; never the note. Whether it's on is
// fetched once and kept, and fetched again when Settings changes it.

import { api } from "./api";
import { promptDialog, toast, toastError } from "../ui/overlays";

export interface SendState {
  connected: boolean;
  on: boolean;
  hint: string | null;
}

let state: Promise<SendState> | null = null;
let known: SendState | null = null;

/** Whether sending is on, as last known (fetched in the background the first time). */
export function sendOn(): boolean {
  if (!state) refresh();
  return !!known?.on;
}

export function refresh(next?: SendState) {
  state = next ? Promise.resolve(next) : api<SendState>("/me/longview-send");
  state.then((s) => {
    const changed = known?.on !== s.on;
    known = s;
    if (changed) dispatchEvent(new Event("cp:longview-send"));
  }, () => (state = null));
}

export async function sendToLongview(vaultId: number, noteId: number, title: string) {
  const why = await promptDialog({
    title: `Send “${title}” to Longview?`,
    message: "Longview saves the page at this note's address, now. Only the address goes, not the note. You can say why it's worth keeping.",
    label: "Why it's worth keeping (optional)",
    placeholder: "Good on the costs",
    action: "Send to Longview",
    optional: true,
  });
  if (why === null) return;
  try {
    const r = await api<{ url: string; message: string }>(`/vaults/${vaultId}/notes/${noteId}/longview`, { body: { why } });
    toast(`Sent to Longview${r.message ? `: ${r.message}` : ""}`);
  } catch (err) {
    toastError(err);
  }
}
