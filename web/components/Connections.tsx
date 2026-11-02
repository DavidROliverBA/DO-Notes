// Settings → Connections → Connected services (F33, src/connections.ts): the person's read-only
// connections, for their assistants to read. Each listed with its sign-in and tools, Review (which
// tools are on, what changed if the service changed one, and Try it) and Disconnect. Known services
// are added here: Longview with a read token; Recall by signing in on its own page (a new tab,
// Safari's sheet in the iPhone app, the browser from the Mac app). Any other service is added by
// its address (step 2): looked at first, then a token, or no sign-in past a warning.

import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";
import { confirmDialog, toast, toastError } from "../ui/overlays";
import { refresh as refreshLongview, type SendState } from "../lib/longview";

interface Preset {
  key: string;
  name: string;
  auth: "token" | "oauth" | "none";
  address: string;
  blurb: string;
  tokenHelp: string | null;
}
interface Connection {
  id: number;
  name: string;
  preset: string | null;
  address: string;
  auth: "token" | "oauth" | "none";
  token_hint: string;
  status: "ok" | "review";
  tools: { read: number; unknown: number; changes: number; on: number };
  created_at: string;
}
interface State {
  available: boolean;
  presets: Preset[];
  connections: Connection[];
}

export function Connections() {
  const [state, setState] = useState<State | null>(null);
  const [reviewing, setReviewing] = useState<Connection | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api<State>("/me/connections").then(setState, toastError);
  useEffect(() => void load(), []);
  if (!state) return null;
  const missing = state.presets.filter((p) => !state.connections.some((c) => c.preset === p.key));

  return (
    <section className="settings-section connections">
      <h3>Connected services</h3>
      <p className="muted">Services your assistants can read from: search them, look things up, read what you've saved. DO Notes only reads; it never changes anything in them.</p>
      {!state.available && <p className="notice">This server can't store tokens yet: an admin needs to set SECRETS_KEY.</p>}
      {state.connections.length > 0 && (
        <ul className="members connection-list">
          {state.connections.map((c) => (
            <li key={c.id}>
              <div>
                <b>{c.name}</b>{" "}
                <span className="muted">
                  · {c.auth === "token" ? `token …${c.token_hint}` : c.auth === "oauth" ? "signed in, read only" : "no sign-in"} · {c.tools.on} of {c.tools.read + c.tools.unknown} tools on
                </span>
                {c.preset === "longview" && <LongviewSend />}
                {c.status === "review" && (
                  <p className="notice">
                    {c.name} changed a tool you chose. Your assistants won't use {c.name} until you look: Review.
                  </p>
                )}
              </div>
              <div className="row">
                <button className={c.status === "review" ? "primary" : "quiet"} onClick={() => setReviewing(c)}>
                  Review
                </button>
                <button className="danger-link" onClick={() => void disconnect(c, load)}>
                  Disconnect
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {state.available &&
        missing.map((p) => (p.auth === "oauth" ? <AddOAuth key={p.key} preset={p} onDone={load} /> : <AddToken key={p.key} preset={p} onDone={load} />))}
      {state.available && (
        <div className="connection-add">
          <h4>Another service</h4>
          <p className="muted">Any service that speaks MCP over the web, with a token or no sign-in. DO Notes looks at it first and says what it found.</p>
          <button onClick={() => setAdding(true)}>
            <Icon name="plus" size={16} /> Add a connection…
          </button>
        </div>
      )}
      {adding && <AddService onClose={() => setAdding(false)} onAdded={(c) => (setAdding(false), void load(), setReviewing(c))} />}
      {reviewing && <Review connection={reviewing} onClose={() => (setReviewing(null), void load())} />}
    </section>
  );
}

/** Send to Longview (F30 step 4): a second Longview token, one that can save, used only to save a
 *  Weblink note's address (⋯ → Send to Longview…). The connection above stays read-only. */
function LongviewSend() {
  const [s, setS] = useState<SendState | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => void api<SendState>("/me/longview-send").then(setS, toastError), []);
  const set = (next: SendState) => (setS(next), refreshLongview(next));
  if (!s) return null;
  if (s.on)
    return (
      <p className="longview-send muted">
        <Icon name="send" size={14} /> Send to Longview is on (token …{s.hint}): a Weblink note's ⋯ menu sends its address.{" "}
        <button className="danger-link" onClick={() => api<SendState>("/me/longview-send", { method: "DELETE" }).then((n) => (set(n), toast("Send to Longview is off")), toastError)}>
          Turn off
        </button>
      </p>
    );
  return (
    <details className="longview-send">
      <summary>Send Weblink notes to Longview…</summary>
      <p className="muted">
        Save a page you've kept here into Longview with one command. Only its address goes, never the note. This needs one of Longview's write tokens (MCP_WRITE_TOKENS), kept apart
        from the read token and used for nothing else.
      </p>
      <form
        className="row wrap"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try {
            set(await api<SendState>("/me/longview-send", { method: "PUT", body: { token } }));
            setToken("");
            toast("Send to Longview is on: find it in a Weblink note's ⋯ menu");
          } catch (err) {
            toastError(err);
          } finally {
            setBusy(false);
          }
        }}
      >
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Longview write token" placeholder="Write token" autoComplete="off" required />
        <button type="submit" disabled={busy}>
          {busy ? "Checking…" : "Turn on"}
        </button>
      </form>
    </details>
  );
}

async function disconnect(c: Connection, onDone: () => unknown) {
  if (!(await confirmDialog({ title: `Disconnect ${c.name}?`, message: `Your assistants stop reading ${c.name}. Nothing in ${c.name} or in your notes changes.`, action: "Disconnect", danger: true }))) return;
  await api(`/me/connections/${c.id}`, { method: "DELETE" }).catch(toastError);
  if (c.preset === "longview") refreshLongview(); // its token for sending goes with it
  toast(`${c.name} disconnected`);
  onDone();
}

/** Add a service that signs in with a token (Longview). */
function AddToken({ preset, onDone }: { preset: Preset; onDone: () => unknown }) {
  const [address, setAddress] = useState(preset.address);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  async function connect(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await api("/me/connections", { body: { preset: preset.key, address, token } });
      setToken("");
      toast(`${preset.name} connected: ask your assistant about it`);
      onDone();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="connection-add">
      <h4>{preset.name}</h4>
      <p className="muted">
        {preset.blurb} {preset.tokenHelp}
      </p>
      <form className="row wrap" onSubmit={connect}>
        <input value={address} onChange={(e) => setAddress(e.target.value)} aria-label={`${preset.name}'s address`} required />
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} aria-label={`${preset.name} read token`} placeholder="Read token" autoComplete="off" required />
        <button type="submit" disabled={busy}>
          {busy ? "Checking…" : `Connect ${preset.name}`}
        </button>
      </form>
    </div>
  );
}

/** Add a service that signs in with OAuth (Recall). Its sign-in address is fetched before the tap,
 *  so the tap opens it at once: a page opened after a request isn't a tap's any more, and is
 *  blocked (in the iPhone app, always). Good for ten minutes; fetched again every eight. */
function AddOAuth({ preset, onDone }: { preset: Preset; onDone: () => unknown }) {
  const [url, setUrl] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [waiting, setWaiting] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);
  useEffect(() => {
    const get = () =>
      api<{ url: string | null; problem?: string }>("/me/connections/oauth", { body: { preset: preset.key } }).then(
        (r) => (setUrl(r.url), setProblem(r.problem ?? null)),
        (e) => (setUrl(null), setProblem((e as Error).message)),
      );
    void get();
    const t = setInterval(get, 8 * 60_000);
    return () => (clearInterval(t), void (timer.current && clearInterval(timer.current)));
  }, []);

  function connect() {
    if (!url) return;
    // A new tab in a browser. The iPhone and Mac apps open no window (the open returns nothing):
    // there, going to the address sends it to Safari's sheet or the Mac's browser, and the app
    // stays where it is.
    const tab = window.open(url, "_blank");
    if (tab) tab.opener = null;
    else location.href = url;
    setUrl(null);
    setWaiting(true);
    const until = Date.now() + 10 * 60_000;
    if (timer.current) clearInterval(timer.current);
    // Signed in (in the other tab or sheet): the list shows it, and this goes.
    timer.current = setInterval(() => (Date.now() > until ? (clearInterval(timer.current!), setWaiting(false)) : void onDone()), 2000);
  }

  return (
    <div className="connection-add">
      <h4>{preset.name}</h4>
      <p className="muted">{preset.blurb} DO Notes asks it for read access only.</p>
      <button onClick={connect} disabled={!url}>
        Connect {preset.name}…
      </button>
      {problem && !waiting && <p className="muted">{problem}</p>}
      {waiting && (
        <p className="muted" role="status">
          Sign in to {preset.name} in the page that opened and allow DO Notes. This updates by itself when you're done.
        </p>
      )}
    </div>
  );
}


interface Probe {
  ok: boolean;
  name: string;
  version: string | null;
  signIn: "none" | "token" | "oauth";
  tools: { read: number; unknown: number; changes: number };
  problem: string | null;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What DO Notes found, in words: "Items 2.1, an MCP service. It doesn't ask who you are. It offers
 *  4 tools: 2 read, 1 doesn't say, 1 changes things." */
function foundWords(p: Probe): string {
  const t = p.tools;
  const total = t.read + t.unknown + t.changes;
  const parts = [t.read && `${t.read} read`, t.unknown && `${t.unknown} ${t.unknown === 1 ? "doesn't" : "don't"} say what ${t.unknown === 1 ? "it does" : "they do"}`, t.changes && `${t.changes} change${t.changes === 1 ? "s" : ""} things`].filter(Boolean);
  const who = p.signIn === "none" ? "It doesn't ask who you are." : p.signIn === "token" ? "It signs in with a token." : "It signs in on its own page.";
  return `${p.name}${p.version ? ` ${p.version}` : ""}, an MCP service. ${who}${total ? ` It offers ${plural(total, "tool")}: ${parts.join(", ")}.` : ""}`;
}

/** Add a connection… (F33 step 2): where it is, what DO Notes found, its token or the no-sign-in
 *  warning, then Connect; Review opens next to choose its tools. */
function AddService({ onClose, onAdded }: { onClose: () => void; onAdded: (c: Connection) => void }) {
  const [address, setAddress] = useState("");
  const [token, setToken] = useState("");
  const [name, setName] = useState("");
  const [found, setFound] = useState<Probe | null>(null);
  const [understood, setUnderstood] = useState(false);
  const [busy, setBusy] = useState(false);

  async function look(e?: React.FormEvent) {
    e?.preventDefault();
    setBusy(true);
    try {
      const p = await api<Probe>("/me/connections/probe", { body: { address, token } });
      setFound(p);
      if (!name || name === found?.name) setName(p.name);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  async function connect() {
    setBusy(true);
    try {
      const c = await api<Connection>("/me/connections", { body: { address, token, name, noSignIn: !token && understood } });
      toast(`${c.name} connected: choose its tools`);
      onAdded(c);
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  }

  const needsToken = found?.signIn === "token";
  const canConnect = !!found?.ok && (token ? true : found.signIn === "none" && understood) && name.trim().length > 0;
  return (
    <Modal title="Add a connection" onClose={onClose}>
      <form className="add-service" onSubmit={look}>
        <label htmlFor="service-address">Where is it?</label>
        <p className="muted small">The service's MCP address, such as https://example.com/mcp. Leave any sign-in out of it.</p>
        <div className="row wrap">
          <input id="service-address" type="url" value={address} onChange={(e) => (setAddress(e.target.value), setFound(null))} placeholder="https://…/mcp" required autoFocus />
          <button type="submit" disabled={busy || !address.trim()}>
            {busy && !found ? "Looking…" : "Look"}
          </button>
        </div>
      </form>
      {found && (
        <div className="add-service" role="status">
          <p>{foundWords(found)}</p>
          {found.problem && <p className="notice">{found.problem}</p>}
          {needsToken && (
            <form onSubmit={look}>
              <label htmlFor="service-token">Its token</label>
              <p className="muted small">A read-only token, if the service has them. DO Notes keeps it sealed and only ever sends it to this service.</p>
              <div className="row wrap">
                <input id="service-token" type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" required />
                <button type="submit" disabled={busy || !token.trim()}>
                  Check
                </button>
              </div>
            </form>
          )}
          {found.ok && found.signIn === "none" && !token && (
            <div className="notice warning">
              <p>
                <b>This service doesn't ask who you are.</b> Anyone can use it, and it can't keep anything private for you. What your assistants send it (your searches) goes to it unsigned. Only
                connect it if you trust who runs it.
              </p>
              <label className="check">
                <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} /> I understand: connect it with no sign-in
              </label>
            </div>
          )}
          {found.ok && (
            <>
              <label htmlFor="service-name">Call it</label>
              <input id="service-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
            </>
          )}
        </div>
      )}
      <div className="dialog-actions">
        <button className="quiet" onClick={onClose}>
          Cancel
        </button>
        <button className="primary" onClick={() => void connect()} disabled={busy || !canConnect} data-dialog-action>
          Connect
        </button>
      </div>
    </Modal>
  );
}

interface Tool {
  name: string;
  title: string | null;
  description: string;
  inputs: string[];
  kind: "read" | "unknown" | "changes";
  enabled: boolean;
  changed: { before: string; after: string } | null;
  fresh: boolean;
}

/** Review: which of the service's tools the assistant may use, in three groups (read; unknown,
 *  which ask every time; and tools that change things, which can't be turned on), and, when the
 *  service changed a tool the person chose, what it said before and what it says now. */
function Review({ connection, onClose }: { connection: Connection; onClose: () => void }) {
  const [tools, setTools] = useState<Tool[] | null>(null);
  const [on, setOn] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [tried, setTried] = useState<{ tool: string | null; answer: string } | null>(null);
  // From your connections, in the side panel (F33 step 4): which tool looks the open note up.
  const [panel, setPanel] = useState<{ tool: string | null; candidates: { name: string; title: string }[] } | null>(null);
  type Panel = { tool: string | null; candidates: { name: string; title: string }[] };
  useEffect(() => {
    api<Panel>(`/me/connections/${connection.id}/panel`).then(setPanel, () => {});
  }, []);
  // Saved at once, like the reminder switch: it decides what leaves when a note opens.
  const choosePanel = (tool: string | null) =>
    api<Panel>(`/me/connections/${connection.id}/panel`, { method: "PUT", body: { tool } }).then((r) => (setPanel(r), toast(tool ? `${connection.name} is in the side panel` : `${connection.name} is out of the side panel`)), toastError);
  useEffect(() => {
    api<{ tools: Tool[] }>(`/me/connections/${connection.id}/tools`).then((r) => (setTools(r.tools), setOn(new Set(r.tools.filter((t) => t.enabled).map((t) => t.name)))), (e) => (toastError(e), onClose()));
  }, []);

  async function toggle(t: Tool, want: boolean) {
    if (want && t.kind === "unknown" && !(await confirmDialog({ title: `Turn on ${t.title ?? t.name}?`, message: `${connection.name} doesn't say whether this changes anything. Turn it on only if you know it just reads. Your assistants will ask you before every use.`, action: "Turn on" })))
      return;
    const next = new Set(on);
    if (want) next.add(t.name);
    else next.delete(t.name);
    setOn(next);
  }

  async function save() {
    setBusy(true);
    try {
      await api(`/me/connections/${connection.id}/tools`, { method: "PUT", body: { on: [...on] } });
      toast(`${connection.name}: ${on.size} tool${on.size === 1 ? "" : "s"} on`);
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const group = (kind: Tool["kind"], heading: string, note: string) => {
    const list = (tools ?? []).filter((t) => t.kind === kind);
    if (!list.length) return null;
    return (
      <fieldset className="tool-group">
        <legend>{heading}</legend>
        <p className="muted small">{note}</p>
        {list.map((t) => (
          <label key={t.name} className={`check tool-row${kind === "changes" ? " off" : ""}`}>
            <input type="checkbox" checked={on.has(t.name)} disabled={kind === "changes"} onChange={(e) => void toggle(t, e.target.checked)} />
            <span>
              <b>{t.title ?? t.name}</b>
              {t.fresh && kind !== "changes" && <span className="badge">new</span>}
              <span className="muted small"> {t.description || "No description."}</span>
              {t.inputs.length > 0 && <span className="muted small"> Sends: {t.inputs.join(", ")}.</span>}
              {t.changed && (
                <span className="tool-changed">
                  <span className="small">Before: {t.changed.before || "(nothing)"}</span>
                  <span className="small">Now: {t.changed.after || "(nothing)"}</span>
                </span>
              )}
            </span>
          </label>
        ))}
      </fieldset>
    );
  };

  return (
    <Modal title={`${connection.name}: tools`} onClose={onClose} size="wide">
      {!tools ? (
        <p className="muted">Asking {connection.name} for its tools…</p>
      ) : (
        <>
          {connection.status === "review" && <p className="notice">{connection.name} changed a tool you chose: read what it says now. Saving here lets your assistants use it again.</p>}
          {group("read", "Read", "Your assistants can use these. A search in your own words runs straight away; anything else asks you first.")}
          {group("unknown", "Doesn't say", `${connection.name} doesn't say whether these only read. Off unless you turn one on; your assistants then ask before every use.`)}
          {group("changes", "Changes things", `These change things in ${connection.name}. DO Notes only reads, so they can't be turned on.`)}
          {panel && (
            <fieldset className="tool-group">
              <legend>In the side panel</legend>
              {panel.candidates.length === 0 ? (
                <p className="muted small">None of the tools that are on can look up a note by its title.</p>
              ) : (
                <>
                  <label className="check">
                    <input type="checkbox" checked={!!panel.tool} onChange={(e) => void choosePanel(e.target.checked ? panel.candidates[0]!.name : null)} /> Look up the open note in the side panel
                  </label>
                  {panel.tool && panel.candidates.length > 1 && (
                    <select aria-label="Tool to look up with" value={panel.tool} onChange={(e) => void choosePanel(e.target.value)}>
                      {panel.candidates.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.title}
                        </option>
                      ))}
                    </select>
                  )}
                  <p className="muted small">
                    Shows what {connection.name} has on the note you're reading, under From your connections. It sends the note's title, never its text, each time a note opens.
                  </p>
                </>
              )}
            </fieldset>
          )}
          {tried && (
            <div className="tool-tried" role="status">
              <p className="small">{tried.tool ? `${connection.name} answered (${tried.tool}):` : tried.answer}</p>
              {tried.tool && <pre>{tried.answer}</pre>}
            </div>
          )}
          <div className="dialog-actions">
            <button className="quiet" onClick={() => api<{ tool: string | null; answer: string }>(`/me/connections/${connection.id}/try`, { method: "POST" }).then(setTried, toastError)}>
              Try it
            </button>
            <button className="quiet" onClick={onClose}>
              Cancel
            </button>
            <button className="primary" onClick={() => void save()} disabled={busy} data-dialog-action>
              <Icon name="check" size={16} /> Save
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}
