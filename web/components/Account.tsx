// Settings → Account (profile, appearance, password, two-step sign-in, passkeys, sign out) and Settings → Admin
// (the library's name, storage, accounts).

import { useEffect, useState } from "react";
import { api, type User } from "../lib/api";
import { confirmDialog, promptDialog, toast, toastError } from "../ui/overlays";
import { forgetEverything } from "../lib/offline";
import { addPasskey, confirmWithPasskey, deviceName, passkeysSupported, prepareAdd, type PasskeyRow } from "../lib/passkeys";
import { formatDate } from "../lib/templates";
import { setTheme, THEMES, useTheme } from "../lib/theme";
import { setFullWidth, useFullWidth } from "../lib/editorWidth";
import { setWritingAids, useWritingAids } from "../lib/writingAids";
import { Icon } from "../ui/Icon";

interface Storage {
  database: number;
  attachments: number;
  notes: number;
  revisions: number;
  trash: number;
  limit: number | null;
  /** Shares of the limit: past warnAt admins are told; past fullAt new data is refused. */
  warnAt: number;
  fullAt: number;
}
const mb = (b: number) => (b >= 1024 ** 3 ? `${(b / 1024 ** 3).toFixed(2)} GB` : `${(b / 1024 ** 2).toFixed(1)} MB`);

interface AdminUser extends User {
  created_at: string;
}

async function attempt(fn: () => Promise<unknown>, ok: string) {
  try {
    await fn();
    toast(ok);
  } catch (e) {
    toastError(e);
  }
}

export function AccountSettings({ user, onChanged }: { user: User; onChanged: () => void }) {
  const [name, setName] = useState(user.name);
  const theme = useTheme();
  const fullWidth = useFullWidth();
  const aids = useWritingAids();
  return (
    <>
      <section className="settings-section">
        <h3>Profile</h3>
        <p className="muted">{user.email}</p>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} aria-label="Display name" />
          <button onClick={() => attempt(() => api("/me", { method: "PATCH", body: { name } }).then(onChanged), "Name saved")} disabled={!name.trim() || name === user.name}>
            Save name
          </button>
        </div>
      </section>
      <section className="settings-section">
        <h3>Appearance</h3>
        <div className="segmented wide" role="radiogroup" aria-label="Theme">
          {THEMES.map((t) => (
            <button type="button" key={t.id} role="radio" aria-checked={theme === t.id} className={theme === t.id ? "on" : ""} onClick={() => setTheme(t.id)}>
              <Icon name={t.icon} size={16} /> {t.label}
            </button>
          ))}
        </div>
        <p className="muted">Auto follows your device's light or dark setting. The choice is kept on this device.</p>
        <label className="check">
          <input type="checkbox" checked={fullWidth} onChange={(e) => setFullWidth(e.target.checked)} /> Full-width editor
        </label>
        <p className="muted">Notes fill the space between the side panels, and follow them as you open, close or resize them. Kept on this device.</p>
      </section>
      <section className="settings-section">
        <h3>Writing</h3>
        <label className="check">
          <input type="checkbox" checked={aids} onChange={(e) => setWritingAids(e.target.checked)} /> Spelling and grammar help as you type
        </label>
        <p className="muted">
          Lets your browser's spell check, the iPhone keyboard's autocorrect and suggestions, and Grammarly help in your notes. Code, properties and links are left alone. Kept on this
          device.
        </p>
      </section>
      <Reminders />
      <SignIn />
      <Passkeys />
      <section className="settings-section">
        <button
          className="danger"
          onClick={() =>
            api("/logout", { method: "POST" }).then(async () => {
              await forgetEverything(); // notes kept on this device for offline go too
              location.href = "/";
            }, toastError)
          }
        >
          Sign out
        </button>
      </section>
    </>
  );
}

/** Reminders for dated tasks (F35): on or off, and the time for a task with only a date. The
 *  DO Notes apps on the iPhone and Mac schedule the alerts (src/reminders.ts). */
function Reminders() {
  const [s, setS] = useState<{ on: boolean; time: string } | null>(null);
  useEffect(() => {
    api<{ on: boolean; time: string }>("/me/reminders?days=1").then(({ on, time }) => setS({ on, time }), toastError);
  }, []);
  const save = (change: Partial<{ on: boolean; time: string }>, said: string) =>
    attempt(async () => setS(await api<{ on: boolean; time: string }>("/me/reminders", { method: "PATCH", body: change })), said);
  if (!s) return null;
  return (
    <section className="settings-section">
      <h3>Reminders</h3>
      <label className="check">
        <input type="checkbox" checked={s.on} onChange={(e) => void save({ on: e.target.checked }, e.target.checked ? "Reminders on" : "Reminders off")} /> Remind me about dated tasks
      </label>
      <div className="row wrap">
        <label htmlFor="reminder-time">For a task with only a date, remind me at</label>
        <input id="reminder-time" type="time" value={s.time} disabled={!s.on} onChange={(e) => e.target.value && void save({ time: e.target.value }, `Reminders at ${e.target.value}`)} />
      </div>
      <p className="muted">
        The DO Notes app on your iPhone and Mac reminds you on the day. A task reminds you when it has a date (📅 2026-11-02) and is in a note you wrote or last edited, or names you (@Name or
        [[Name]]). Add ⏰ 14:30 for a time of its own.
      </p>
    </section>
  );
}

interface SignInState {
  password: boolean;
  twoStep: boolean;
  recoveryLeft: number;
  passkeys: number;
  canTwoStep: boolean;
}

/** How you sign in (F40, src/twoStep.ts): your password (or passkeys only), and two-step
 *  sign-in with a code app and recovery codes. Each change asks for your password again. */
function SignIn() {
  const [st, setSt] = useState<SignInState | null>(null);
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [setup, setSetup] = useState<{ secret: string; uri: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [codes, setCodes] = useState<string[] | null>(null);
  const load = () => api<SignInState>("/me/sign-in").then(setSt, toastError);
  useEffect(() => void load(), []);
  // Passkeys added or removed below change what's possible here.
  useEffect(() => {
    addEventListener("cp:passkeys", load);
    return () => removeEventListener("cp:passkeys", load);
  }, []);
  if (!st) return null;

  const askPassword = (title: string, action: string, danger = false) =>
    promptDialog({ title, message: "Type your password to confirm it's you.", label: "Password", input: "password", action, danger });

  async function turnOn(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ codes: string[] }>("/me/two-step", { body: { code, password: pw } });
      setSetup(null);
      setCode("");
      setPw("");
      setCodes(r.codes);
      await load();
      toast("Two-step sign-in is on. Other devices were signed out.");
    } catch (err) {
      toastError(err);
    }
  }

  return (
    <>
      <section className="settings-section">
        <h3>Password</h3>
        {st.password ? (
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              void attempt(async () => {
                await api("/me", { method: "PATCH", body: { currentPassword: cur, newPassword: next } });
                setCur("");
                setNext("");
              }, "Password changed");
            }}
          >
            <input type="password" placeholder="Current password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
            <input type="password" placeholder="New password (8+ characters)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
            <button type="submit">Change password</button>
          </form>
        ) : (
          <>
            <p className="muted">Your account signs in with passkeys only: there's no password to guess or leak. To have a password again, set one and confirm with a passkey.</p>
            <form
              className="row wrap"
              onSubmit={(e) => {
                e.preventDefault();
                void attempt(async () => {
                  const passkey = await confirmWithPasskey();
                  await api("/me", { method: "PATCH", body: { newPassword: next, passkey } });
                  setNext("");
                  await load();
                }, "Password set. Other devices were signed out.");
              }}
            >
              <input type="password" placeholder="New password (8+ characters)" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" minLength={8} required />
              <button type="submit">Set a password</button>
            </form>
          </>
        )}
        {st.password && st.passkeys > 0 && (
          <>
            <h4>Passkeys only</h4>
            <p className="muted">Sign in with your passkeys alone and drop the password, so there's nothing to guess or phish. Keep a passkey on more than one device.</p>
            <button
              onClick={async () => {
                const password = await askPassword("Sign in with passkeys only?", "Drop my password");
                if (password === null) return;
                await attempt(async () => setSt(await api<SignInState>("/me/passwordless", { body: { password } })), "Your account now signs in with passkeys only");
              }}
            >
              Sign in with passkeys only…
            </button>
          </>
        )}
      </section>
      {st.password && (
        <section className="settings-section two-step">
          <h3>Two-step sign-in</h3>
          {codes && <RecoveryCodes codes={codes} onDone={() => setCodes(null)} />}
          {!codes && st.twoStep && (
            <>
              <p>
                <Icon name="check" size={16} /> On. After your password, you're asked for the code your code app shows. Passkeys don't ask: they're two steps already.
              </p>
              <p className="muted">
                {st.recoveryLeft} recovery code{st.recoveryLeft === 1 ? "" : "s"} left{st.recoveryLeft <= 3 ? ": make new ones soon" : ""}.
              </p>
              <div className="row wrap">
                <button
                  onClick={async () => {
                    const password = await askPassword("Make new recovery codes?", "Make new codes");
                    if (password === null) return;
                    await attempt(async () => setCodes((await api<{ codes: string[] }>("/me/two-step/codes", { body: { password } })).codes), "New recovery codes made; the old ones no longer work");
                    await load();
                  }}
                >
                  New recovery codes…
                </button>
                <button
                  className="danger"
                  onClick={async () => {
                    const password = await askPassword("Turn off two-step sign-in?", "Turn off", true);
                    if (password === null) return;
                    await attempt(async () => setSt(await api<SignInState>("/me/two-step", { method: "DELETE", body: { password } })), "Two-step sign-in is off");
                  }}
                >
                  Turn off…
                </button>
              </div>
            </>
          )}
          {!codes && !st.twoStep && !setup && (
            <>
              <p className="muted">After your password, ask for a code from a code app on your phone (Apple Passwords, Google Authenticator, 1Password and others), so a password alone can't get in.</p>
              {st.canTwoStep ? (
                <button onClick={() => api<{ secret: string; uri: string; qr: string }>("/me/two-step/start", { method: "POST" }).then(setSetup, toastError)}>Turn on two-step sign-in…</button>
              ) : (
                <p className="muted">This server can't keep a code app's secret yet: an admin needs to set SECRETS_KEY.</p>
              )}
            </>
          )}
          {setup && (
            <form className="two-step-setup" onSubmit={turnOn}>
              <img src={setup.qr} alt="QR code for your code app" width={180} height={180} />
              <div>
                <p>
                  <b>1.</b> Scan this with your code app, or <a href={setup.uri}>open it in your code app</a> on this device.
                </p>
                <p className="muted">
                  Or type this key: <code className="secret">{setup.secret}</code>
                </p>
                <p>
                  <b>2.</b> Type the code it shows, and your password.
                </p>
                <div className="row wrap">
                  <input value={code} onChange={(e) => setCode(e.target.value)} placeholder="6-digit code" aria-label="Code from your code app" autoComplete="one-time-code" inputMode="numeric" maxLength={7} required />
                  <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="Password" aria-label="Password" autoComplete="current-password" required />
                </div>
                <div className="row">
                  <button type="submit" className="primary">
                    Turn on
                  </button>
                  <button type="button" onClick={() => setSetup(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            </form>
          )}
        </section>
      )}
    </>
  );
}

/** Recovery codes, shown once: each signs in once when the code app isn't to hand. */
function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const text = `DO Notes recovery codes (${location.host}), made ${formatDate(new Date(), "D MMM YYYY")}\nEach one signs in once, in place of the code app's code.\n\n${codes.join("\n")}\n`;
  return (
    <div className="recovery">
      <p>
        <b>Keep these recovery codes somewhere safe</b>, such as your password manager. Each signs you in once if your phone is lost. They won't be shown again.
      </p>
      <ol className="recovery-codes">
        {codes.map((c) => (
          <li key={c}>
            <code>{c}</code>
          </li>
        ))}
      </ol>
      <div className="row wrap">
        <button onClick={() => navigator.clipboard.writeText(text).then(() => toast("Recovery codes copied"), toastError)}>Copy</button>
        <a className="button" href={`data:text/plain;charset=utf-8,${encodeURIComponent(text)}`} download="do-notes-recovery-codes.txt">
          Download
        </a>
        <button className="primary" onClick={onDone}>
          I've saved them
        </button>
      </div>
    </div>
  );
}

/** Passkeys (F32): sign in with Face ID or Touch ID. Each device's is listed, and can be removed
 *  (Undo puts it back). They're for this address: the cloud and a Mac's kit each have their own. */
function Passkeys() {
  const [list, setList] = useState<PasskeyRow[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Tells How you sign in (above) that the passkeys changed.
  const load = () => api<PasskeyRow[]>("/passkeys").then((l) => (setList(l), dispatchEvent(new Event("cp:passkeys"))), toastError);
  const supported = passkeysSupported();
  useEffect(() => {
    void load();
    if (!supported) return;
    prepareAdd();
    const t = setInterval(prepareAdd, 3 * 60_000); // kept fresh while Settings is open
    return () => clearInterval(t);
  }, []);

  async function add() {
    setBusy(true);
    try {
      const made = await addPasskey(deviceName());
      toast(`Passkey added: ${made.name}. Next time, choose Sign in with a passkey.`);
      await load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      prepareAdd(); // ready for the next one
    }
  }

  async function remove(p: PasskeyRow) {
    try {
      await api(`/passkeys/${p.id}`, { method: "DELETE" });
      await load();
      toast(`Removed the passkey “${p.name}”`, { undo: () => api(`/passkeys/${p.id}/restore`, { method: "POST" }).then(load) });
    } catch (e) {
      toastError(e);
    }
  }

  const when = (d: string) => formatDate(new Date(d), "D MMM YYYY");
  return (
    <section className="settings-section passkeys">
      <h3>Passkeys</h3>
      <p className="muted">Sign in with Face ID, Touch ID or your device's passcode instead of your password. Add one on each device you use; iCloud Keychain shares yours between your Apple devices.</p>
      {list && list.length > 0 && (
        <ul className="passkey-list">
          {list.map((p) => (
            <li key={p.id}>
              <Icon name="key" size={16} />
              <span className="passkey-name">
                {p.name}
                <small className="muted">
                  Added {when(p.created_at)}
                  {p.last_used_at ? ` · last used ${when(p.last_used_at)}` : " · not used yet"}
                </small>
              </span>
              <button className="quiet" onClick={() => void remove(p)} aria-label={`Remove the passkey ${p.name}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      {list && list.length === 0 && <p className="muted">No passkeys yet.</p>}
      {supported ? (
        <button onClick={() => void add()} disabled={busy}>
          <Icon name="plus" size={16} /> Add a passkey on this device
        </button>
      ) : (
        <p className="muted">This browser can't make passkeys.</p>
      )}
    </section>
  );
}

export function AdminSettings({ user, library, onChanged }: { user: User; library: string; onChanged: () => void }) {
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [libName, setLibName] = useState(library);
  const [nu, setNu] = useState({ email: "", name: "", password: "", is_admin: false });
  const [storage, setStorage] = useState<Storage | null>(null);

  const loadUsers = async () => setUsers(await api<AdminUser[]>("/admin/users"));
  useEffect(() => {
    loadUsers().catch(toastError);
    api<Storage>("/admin/storage").then(setStorage, () => {});
  }, []);

  async function deleteUser(u: AdminUser) {
    const yes = await confirmDialog({
      title: `Delete ${u.name}'s account?`,
      message: `${u.email} won't be able to sign in. Collections only they own pass to you. This can't be undone.`,
      action: "Delete account",
      danger: true,
    });
    if (yes) await attempt(() => api(`/admin/users/${u.id}`, { method: "DELETE" }).then(loadUsers), `Deleted ${u.email}`);
  }

  return (
    <>
      <section className="settings-section">
        <h3>Library</h3>
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(() => api<{ library: string }>("/admin/library", { method: "PUT", body: { name: libName } }).then((r) => (setLibName(r.library), onChanged())), "Library renamed");
          }}
        >
          <input value={libName} onChange={(e) => setLibName(e.target.value)} maxLength={80} aria-label="Library name" placeholder="David's Library" />
          <button type="submit" disabled={libName.trim() === library}>
            Rename
          </button>
        </form>
        <p className="muted small">Everyone here sees this name above their collections. Leave it empty to go back to the first admin's name.</p>
      </section>
      {storage && (
        <section className="settings-section">
          <h3>Storage</h3>
          <p>
            <b>{mb(storage.database)}</b> used{storage.limit ? ` of ${mb(storage.limit)} (${Math.round((storage.database / storage.limit) * 100)}%)` : ""}
          </p>
          {storage.limit && <div className={`meter${storage.database / storage.limit > storage.warnAt ? " warn" : ""}`}><span style={{ width: `${Math.min(100, (storage.database / storage.limit) * 100)}%` }} /></div>}
          <p className="muted small">
            Pictures and files {mb(storage.attachments)} · notes {mb(storage.notes)} · history {mb(storage.revisions)} · Trash {mb(storage.trash)}
          </p>
          {storage.limit && (
            <p className="muted small">
              At {Math.round(storage.fullAt * 100)}% ({mb(storage.limit * storage.fullAt)}) nothing new can be added until space is freed, so the database never fills and stops. Typing in open notes carries on.
            </p>
          )}
        </section>
      )}

      <section className="settings-section">
        <h3>Accounts</h3>
        <ul className="members">
          {users.map((u) => (
            <li key={u.id}>
              <div>
                <b>{u.name}</b> <span className="muted">{u.email}</span> {u.is_admin && <span className="pill">admin</span>}
              </div>
              {u.id !== user.id && (
                <button className="danger-link" onClick={() => void deleteUser(u)}>
                  Delete
                </button>
              )}
            </li>
          ))}
        </ul>
        <form
          className="row wrap"
          onSubmit={(e) => {
            e.preventDefault();
            void attempt(async () => {
              await api("/admin/users", { body: nu });
              setNu({ email: "", name: "", password: "", is_admin: false });
              await loadUsers();
            }, "Account created — share the password with them; they can change it in Settings → Account.");
          }}
        >
          <input type="email" placeholder="Email" value={nu.email} onChange={(e) => setNu({ ...nu, email: e.target.value })} required />
          <input placeholder="Name" value={nu.name} onChange={(e) => setNu({ ...nu, name: e.target.value })} />
          <input type="text" placeholder="Temporary password" value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} minLength={8} required />
          <label className="check">
            <input type="checkbox" checked={nu.is_admin} onChange={(e) => setNu({ ...nu, is_admin: e.target.checked })} /> Admin
          </label>
          <button type="submit">Create account</button>
        </form>
      </section>
    </>
  );
}
