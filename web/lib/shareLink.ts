// Share one note by link (F38, src/shareLink.ts): make a read-only page of the note at a private
// address, copy it, update it when the note has changed, or stop sharing (with Undo).

import { api } from "./api";
import { chooseDialog, confirmDialog, toast, toastError } from "../ui/overlays";

interface ShareState {
  shared: boolean;
  live: boolean;
  url: string | null;
  updatedAt: string | null;
  stale: boolean;
}

const full = (url: string) => new URL(url, location.origin).toString();
const tz = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

async function copy(url: string, said: string) {
  try {
    await navigator.clipboard.writeText(full(url));
    toast(`${said}: the link is copied`);
  } catch {
    toast(`${said}: ${full(url)}`);
  }
}

export async function shareByLink(vaultId: number, noteId: number, title: string, canWrite: boolean): Promise<void> {
  const base = `/vaults/${vaultId}/notes/${noteId}/share`;
  try {
    const s = await api<ShareState>(base);
    if (!s.shared || !s.live) {
      if (!canWrite) return toast("Only someone who can edit this note can share it");
      const ok = await confirmDialog({
        title: `Share “${title}” by link?`,
        message: "Anyone with the link can read this note as it is now, without signing in. Links to your other notes show as plain words, and later edits stay private until you update the page. You can stop sharing at any time.",
        action: "Make a link",
      });
      if (!ok) return;
      const made = await api<ShareState>(base, { method: "POST", body: { tz: tz() } });
      return copy(made.url!, "Shared");
    }
    const when = s.updatedAt ? new Date(s.updatedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "";
    const choice = await chooseDialog({
      title: `“${title}” is shared by link`,
      message: s.stale ? `The page shows the note as it was on ${when}; it's changed since.` : `The page shows the note as it is (updated ${when}).`,
      options: [
        { value: "copy", label: "Copy the link", icon: "copy" },
        { value: "open", label: "Open the page", icon: "globe" },
        ...(canWrite && s.stale ? [{ value: "update", label: "Update the page to the note as it is now", icon: "history" }] : []),
        ...(canWrite ? [{ value: "stop", label: "Stop sharing", icon: "x" }] : []),
      ],
    });
    if (choice === "copy") return copy(s.url!, "Shared");
    if (choice === "open") return void window.open(full(s.url!), "_blank", "noopener");
    if (choice === "update") {
      const u = await api<ShareState>(base, { method: "POST", body: { tz: tz() } });
      return copy(u.url!, "Updated");
    }
    if (choice === "stop") {
      await api(base, { method: "PATCH", body: { live: false } });
      toast(`“${title}” isn't shared any more`, { undo: () => api(base, { method: "PATCH", body: { live: true } }).then(() => toast("Shared again, at the same link"), toastError) });
    }
  } catch (e) {
    toastError(e);
  }
}
