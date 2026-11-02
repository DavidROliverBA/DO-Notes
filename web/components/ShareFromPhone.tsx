// Settings → Connections → Share from iPhone: make a capture token and set up the Apple Shortcut
// that puts "Save to Commonplace" in the share sheet (src/capture.ts, docs/IPHONE-SHORTCUT.md).

import { useEffect, useState } from "react";
import { api, type Vault } from "../lib/api";
import { inIPhoneApp } from "../lib/iphoneApp";
import { relativeTime } from "../lib/links";
import { Icon } from "../ui/Icon";
import { confirmDialog, toast, toastError } from "../ui/overlays";

export interface Token {
  id: number;
  name: string;
  scope: string;
  vault_id: number | null;
  vault_name: string | null;
  note_path: string | null;
  created_at: string;
  last_used_at: string | null;
  /** Made by an app signing in (F25): the address it returns to, such as claude.ai. */
  app: string | null;
}

/** Copy to the clipboard and say so; also used by ConnectClaude. */
export const copy = (text: string, what: string) =>
  navigator.clipboard?.writeText(text).then(
    () => toast(`${what} copied`),
    () => toast("Couldn't copy: select it and copy instead", { tone: "error" }),
  );

export function ShareFromPhone() {
  const [tokens, setTokens] = useState<Token[] | null>(null);
  const [vaults, setVaults] = useState<Vault[]>([]);
  const [vaultId, setVaultId] = useState<number | null>(null);
  const [note, setNote] = useState("Inbox");
  const [name, setName] = useState("iPhone");
  const [fresh, setFresh] = useState<{ token: string; row: Token } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = () => api<Token[]>("/me/tokens").then((all) => setTokens(all.filter((t) => t.scope === "capture")), toastError);
  useEffect(() => {
    void load();
    api<Vault[]>("/vaults").then((vs) => {
      const writable = vs.filter((v) => v.role !== "viewer");
      setVaults(writable);
      // Your home collection by default (0), which follows you if you change home later (F20).
      setVaultId(writable.length ? 0 : null);
    }, toastError);
  }, []);

  async function create() {
    if (vaultId === null) return;
    setBusy(true);
    try {
      const made = await api<{ token: string; row: Token }>("/me/tokens", { body: { kind: "capture", vaultId: vaultId || undefined, name, notePath: note } });
      setFresh(made);
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(t: Token) {
    const yes = await confirmDialog({
      title: `Revoke “${t.name}”?`,
      message: "The Shortcut using it will stop saving. You can make a new token any time.",
      action: "Revoke",
      danger: true,
    });
    if (!yes) return;
    try {
      await api(`/me/tokens/${t.id}`, { method: "DELETE" });
      if (fresh?.row.id === t.id) setFresh(null);
      await load();
      toast(`Revoked “${t.name}”`);
    } catch (e) {
      toastError(e);
    }
  }

  const address = `${location.origin}/api/capture`;
  const noteName = (p: string | null) => (p ?? "").replace(/\.md$/, "");

  return (
    <section className="settings-section">
      <h3>Share from iPhone</h3>
      {inIPhoneApp() ? (
        <p className="muted">
          Save links, text and photos from any app's <b>Share</b> button into your home collection's Inbox, as to-dos to file later: choose <b>DO Notes</b> in the share
          sheet. This app set it up when you signed in, with the token called <b>iPhone app</b> below. Revoking it stops sharing until you next open the app.
        </p>
      ) : (
        <p className="muted">
          Save links, text and photos from any app's <b>Share</b> button into a note, as to-dos to file later. It works through an Apple Shortcut, set up once.
        </p>
      )}

      {tokens && tokens.length > 0 && (
        <ul className="members">
          {tokens.map((t) => (
            <li key={t.id}>
              <div>
                <b>{t.name}</b>{" "}
                <span className="muted">
                  → {t.vault_name ?? "Home collection"} / {noteName(t.note_path)} · {t.last_used_at ? `last used ${relativeTime(t.last_used_at)}` : "not used yet"}
                </span>
              </div>
              <button className="danger-link" onClick={() => void revoke(t)}>
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}

      {fresh ? (
        <div className="capture-setup">
          <p className="notice">
            <b>Copy the token now</b>: it's shown only once. Treat it like a password; it can add to “{noteName(fresh.row.note_path)}”, and nothing else.
          </p>
          <div className="copy-row">
            <span className="copy-label">Address</span>
            <code>{address}</code>
            <button className="quiet" onClick={() => void copy(address, "Address")} aria-label="Copy address">
              <Icon name="copy" size={16} /> Copy
            </button>
          </div>
          <div className="copy-row">
            <span className="copy-label">Authorization</span>
            <code>Bearer {fresh.token}</code>
            <button className="quiet" onClick={() => void copy(`Bearer ${fresh.token}`, "Token")} aria-label="Copy token">
              <Icon name="copy" size={16} /> Copy
            </button>
          </div>
          <ol className="steps">
            <li>
              On your iPhone, open <b>Shortcuts</b>, tap <b>+</b> and name it <i>Save to DO Notes</i>.
            </li>
            <li>
              Tap <b>ⓘ</b>, turn on <b>Show in Share Sheet</b>, and tap Done.
            </li>
            <li>
              Add <b>Get Images from Input</b> and <b>Get URLs from Input</b>, both on <i>Shortcut Input</i>.
            </li>
            <li>
              Add <b>Get Contents of URL</b> and paste the address. Tap <b>›</b>: Method <b>POST</b>; under Headers add <code>Authorization</code> with the token line; Request Body{" "}
              <b>Form</b> with three fields: <code>item</code> (Text) = <i>Shortcut Input</i>, <code>url</code> (Text) = <i>URLs</i>, <code>photo</code> (File) = <i>Images</i>.
            </li>
            <li>
              Add <b>Get Dictionary Value</b> for <code>message</code> in <i>Contents of URL</i>, then <b>Show Notification</b> with it.
            </li>
            <li>Share a web page to <i>Save to DO Notes</i>: it appears in “{noteName(fresh.row.note_path)}”.</li>
          </ol>
          <button
            onClick={() => {
              setFresh(null);
              void load(); // shows "last used" if the test share already arrived
            }}
          >
            Done
          </button>
        </div>
      ) : vaults.length > 0 ? (
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <select value={vaultId ?? ""} onChange={(e) => setVaultId(Number(e.target.value))} aria-label="Collection">
            <option value={0}>Home collection{vaults.find((v) => v.home) ? ` (now ${vaults.find((v) => v.home)!.name})` : ""}</option>
            {vaults.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
          <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Inbox" aria-label="Note to save into" />
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="iPhone" aria-label="Name for this phone" />
          <button type="submit" className="primary" disabled={busy || !note.trim()}>
            {busy ? "Creating…" : "Create token"}
          </button>
        </form>
      ) : (
        <p className="muted">You need a collection you can edit first.</p>
      )}
    </section>
  );
}
