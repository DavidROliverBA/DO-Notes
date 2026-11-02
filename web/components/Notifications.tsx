// Notifications and activity (F39, src/notifications.ts): the bell in the sidebar, with how many
// are unread, and its list: mentions, invitations, changes to notes you follow and comments,
// newest first, each opening its note; and, for the open collection, what others changed since
// you last looked. Checked every minute and when the window comes back.

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { noteUrl, navigate } from "../lib/router";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { toastError } from "../ui/overlays";

interface Item {
  id: number;
  kind: "mention" | "invite" | "accepted" | "follow" | "comment";
  text: string;
  vaultId: number | null;
  noteId: number | null;
  actor: string | null;
  at: string;
  read: boolean;
}
interface Bell {
  unread: number;
  items: Item[];
}
interface Activity {
  since: string;
  notes: { id: number; title: string; path: string; by: string | null; at: string; made: boolean }[];
}

const ICON: Record<Item["kind"], string> = { mention: "user", invite: "users", accepted: "users", follow: "eye", comment: "edit" };

function ago(iso: string): string {
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
}

export function BellButton({ vaultId }: { vaultId: number }) {
  const [bell, setBell] = useState<Bell | null>(null);
  const [open, setOpen] = useState(false);
  const load = () => api<Bell>("/me/notifications").then(setBell, () => {});
  useEffect(() => {
    void load();
    const t = setInterval(load, 60_000);
    const back = () => document.visibilityState === "visible" && void load();
    document.addEventListener("visibilitychange", back);
    return () => (clearInterval(t), document.removeEventListener("visibilitychange", back));
  }, []);
  const unread = bell?.unread ?? 0;
  return (
    <>
      <button className="icon-btn bell" onClick={() => setOpen(true)} title="Notifications" aria-label={unread ? `Notifications, ${unread} new` : "Notifications"}>
        <Icon name="bell" size={16} />
        {unread > 0 && <span className="bell-count" aria-hidden="true">{unread > 9 ? "9+" : unread}</span>}
      </button>
      {open && <NotificationsDialog vaultId={vaultId} bell={bell} onChange={setBell} onClose={() => setOpen(false)} />}
    </>
  );
}

function NotificationsDialog({ vaultId, bell, onChange, onClose }: { vaultId: number; bell: Bell | null; onChange: (b: Bell) => void; onClose: () => void }) {
  const [activity, setActivity] = useState<Activity | null>(null);
  useEffect(() => {
    api<Activity>(`/vaults/${vaultId}/activity`).then(setActivity, () => {});
  }, [vaultId]);

  const openItem = async (i: Item) => {
    if (!i.read) await api<Bell>("/me/notifications/read", { body: { ids: [i.id] } }).then(onChange, () => {});
    if (i.kind === "invite") return onClose(); // the invitation waits in the file panel, with Join and Decline
    if (i.vaultId && i.noteId) navigate(noteUrl(i.vaultId, i.noteId));
    onClose();
  };

  return (
    <Modal title="Notifications" onClose={onClose}>
      <div className="notifications">
        {bell && bell.items.length > 0 ? (
          <ul className="notification-list">
            {bell.items.map((i) => (
              <li key={i.id} className={i.read ? "" : "unread"}>
                <button onClick={() => void openItem(i)}>
                  <Icon name={ICON[i.kind]} size={16} />
                  <span className="notification-text">{i.text}</span>
                  <small>{ago(i.at)}</small>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">Nothing yet. You'll see here when someone mentions you (@ and your name), invites you, comments, or changes a note you follow.</p>
        )}
        {activity && (
          <section className="activity">
            <h3>Since you last looked here</h3>
            {activity.notes.length === 0 ? (
              <p className="muted">Nobody else has changed anything in this collection since then.</p>
            ) : (
              <ul className="link-list">
                {activity.notes.map((n) => (
                  <li key={n.id}>
                    <button onClick={() => (navigate(noteUrl(vaultId, n.id)), onClose())}>
                      {n.title}{" "}
                      <small>
                        {n.made ? "new" : "changed"}
                        {n.by ? ` by ${n.by}` : ""} · {ago(n.at)}
                      </small>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
      <div className="dialog-actions">
        {activity && activity.notes.length > 0 && (
          <button className="quiet" onClick={() => api<Activity>(`/vaults/${vaultId}/activity`, { method: "POST" }).then(setActivity, toastError)}>
            Mark this collection seen
          </button>
        )}
        <button className="primary" data-dialog-action disabled={!bell?.unread} onClick={() => api<Bell>("/me/notifications/read", { body: { all: true } }).then(onChange, toastError)}>
          Mark all read
        </button>
      </div>
    </Modal>
  );
}
