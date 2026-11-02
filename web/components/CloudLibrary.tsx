// The cloud library and the Mac (F23). In the cloud, Settings → Connections lists the Macs signed
// in, each with Sign out. On the Mac, Connections signs in to the cloud library (CloudConnection),
// and a cloud collection's settings say what's done where (CloudVaultSettings).

import { useEffect, useState } from "react";
import { api, type Vault } from "../lib/api";
import { toast, toastError } from "../ui/overlays";
import { relativeTime } from "../lib/links";
import { type Token } from "./ShareFromPhone";

export function MacsSignedIn() {
  const [macs, setMacs] = useState<Token[]>([]);
  const load = () => api<Token[]>("/me/tokens").then((all) => setMacs(all.filter((t) => t.scope === "device")), toastError);
  useEffect(() => void load(), []);
  if (!macs.length) return null;

  async function signOut(t: Token) {
    try {
      await api(`/me/tokens/${t.id}`, { method: "DELETE" });
      await load();
      toast(`Signed out “${t.name}”`);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <section className="settings-section">
      <h3>Macs signed in</h3>
      <p className="muted">DO Notes on these Macs shows your collections here beside its own, and can move notes between them. Signing one out closes it at once.</p>
      <ul className="members">
        {macs.map((t) => (
          <li key={t.id}>
            <div>
              <b>{t.name}</b> <span className="muted">· {t.last_used_at ? `last used ${relativeTime(t.last_used_at)}` : "not used yet"}</span>
            </div>
            <button className="danger-link" onClick={() => void signOut(t)}>
              Sign out
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface CloudStatus {
  available: boolean;
  link: { url: string; email: string | null; library: string | null } | null;
}

export function useCloud(): CloudStatus | null {
  const [s, setS] = useState<CloudStatus | null>(null);
  useEffect(() => void api<CloudStatus>("/cloud").then(setS, () => setS(null)), []);
  return s;
}

/** On the Mac: sign in to your cloud library, so its collections join the menu (F23). */
export function CloudConnection() {
  const [s, setS] = useState<CloudStatus | null>(null);
  const [url, setUrl] = useState("");
  const [name, setName] = useState("My Mac");
  const [busy, setBusy] = useState(false);
  const load = () => api<CloudStatus>("/cloud").then(setS, () => setS(null));
  useEffect(() => void load(), []);
  if (!s?.available) return null;

  async function signIn() {
    setBusy(true);
    try {
      const { authorize } = await api<{ authorize: string }>("/cloud/connect", { body: { url, name } });
      location.assign(authorize);
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  }
  async function signOut() {
    setBusy(true);
    try {
      await api("/cloud", { method: "DELETE" });
      toast("Signed out of the cloud library. Its collections have left the menu; sign in again to bring them back.");
      await load();
      setTimeout(() => location.reload(), 1200);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>Cloud library</h3>
      {s.link ? (
        <>
          <p>
            Signed in to <b>{s.link.library || s.link.url}</b> (<code>{s.link.url}</code>){s.link.email ? ` as ${s.link.email}` : ""}. Its collections are in the menu under{" "}
            <i>In the cloud</i>, and open and change here as they do there, live.
          </p>
          <button className="danger-link" onClick={() => void signOut()} disabled={busy}>
            Sign out of the cloud library
          </button>
        </>
      ) : (
        <>
          <p className="muted">Sign in to the DO Notes you use on the web, and its collections join this Mac's in the menu. Notes move between the two with Move to another collection.</p>
          <form
            className="cloud-connect"
            onSubmit={(e) => {
              e.preventDefault();
              void signIn();
            }}
          >
            <label>
              Address <input type="url" required placeholder="https://notes.example.com" value={url} onChange={(e) => setUrl(e.target.value)} />
            </label>
            <label>
              This Mac's name <input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
            </label>
            <button type="submit" className="primary" disabled={busy || !url.trim()}>
              {busy ? "Opening…" : "Sign in"}
            </button>
          </form>
          <p className="muted small">You'll sign in there and allow this Mac. Sign it out at any time, here or in the cloud's Settings → Connections.</p>
        </>
      )}
    </section>
  );
}

/** Settings → This collection, for a cloud collection on the Mac: what's done where. */
export function CloudVaultSettings({ vault }: { vault: Vault }) {
  const s = useCloud();
  return (
    <section className="settings-section">
      <h3>{vault.name}</h3>
      <p>
        In your cloud library{s?.link ? <> at <code>{s.link.url}</code></> : null}, where you're {vault.role === "owner" ? "an owner" : `an ${vault.role}`}. Its notes open and change here as they
        do there, live with everyone else.
      </p>
      {vault.offline && <p className="notice">The cloud library can't be reached just now. Notes you've opened on this Mac are still here, and changes go when it's back.</p>}
      <p className="muted">Members, renaming, publishing as a website, GitHub and imports are done in the cloud library itself.</p>
      {s?.link && (
        <a className="button" href={s.link.url} target="_blank" rel="noopener">
          Open the cloud library
        </a>
      )}
    </section>
  );
}
