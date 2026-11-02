// Settings → AI assistants: the assistants you've added (bring your own AI, F13), to change,
// test or remove, and your Brave Search key for their web search (src/web.ts). Keys are never
// shown; only their last four characters.

import { useEffect, useState, useSyncExternalStore } from "react";
import { api } from "../lib/api";
import { type Assistant, cachedAssistants, loadAssistants, onAssistants } from "../lib/ai";
import { pounds } from "../../src/prices";
import { relativeTime } from "../lib/links";
import { confirmDialog, toast, toastError } from "../ui/overlays";
import { useAssistants } from "./AiPanel";
import { editAssistant } from "./AssistantDialog";

const LABEL = { anthropic: "Anthropic", openai: "OpenAI", relaxai: "relaxAI", compatible: "OpenAI-compatible" } as const;

export function Assistants() {
  const ready = useAssistants();
  const list = useSyncExternalStore(onAssistants, cachedAssistants);

  // The key goes with it and can't come back, so this one asks first.
  async function remove(a: Assistant) {
    if (!(await confirmDialog({ title: `Remove ${a.name}?`, message: "Its API key is deleted from DO Notes. To use it again you'd add it with the key.", action: "Remove", danger: true }))) return;
    try {
      await api(`/me/assistants/${a.id}`, { method: "DELETE" });
      await loadAssistants(true);
      toast(`Removed ${a.name}`);
    } catch (e) {
      toastError(e);
    }
  }

  async function test(a: Assistant) {
    try {
      const r = await api<{ reply: string }>("/me/assistants/test", { body: { id: a.id } });
      toast(`${a.name} works: “${r.reply || "(no reply)"}”`);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <>
    <section className="settings-section">
      <h3>AI assistants</h3>
      <p className="muted">
        Bring your own AI. Each assistant uses your own API key, which is stored encrypted and never shown again or shared. Type <b>@name</b> in a note, or press ⌘J for the
        side panel.
      </p>
      {ready && list.length > 0 && (
        <ul className="members">
          {list.map((a) => (
            <li key={a.id}>
              <div>
                <b>@{a.name}</b>{" "}
                <span className="muted">
                  · {LABEL[a.provider]} · {a.model} · key …{a.key_hint} · {a.last_used_at ? `used ${relativeTime(a.last_used_at)}` : "not used yet"} ·{" "}
                  {a.daily_cap !== null ? `${pounds(a.spent_today)} of ${pounds(a.daily_cap)} today` : `${pounds(a.spent_today)} today, no limit`}
                  {a.web ? " · may use the web" : ""}
                </span>
              </div>
              <div className="row">
                <button className="quiet" onClick={() => void test(a)}>
                  Test
                </button>
                <button className="quiet" onClick={() => void editAssistant(a)}>
                  Change
                </button>
                <button className="danger-link" onClick={() => void remove(a)}>
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <button className="primary" onClick={() => void editAssistant()}>
        Add an assistant
      </button>
    </section>
    <WebSearchKey />
    </>
  );
}

const BRAVE_KEYS = "https://brave.com/search/api/";

/** Your Brave Search key, for assistants allowed the web: checked with one search, kept sealed. */
function WebSearchKey() {
  const [state, setState] = useState<{ available: boolean; connection: { key_hint: string } | null } | null>(null);
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const load = () => void api<typeof state>("/me/web-search").then(setState, toastError);
  useEffect(load, []);
  if (!state) return null;

  async function connect() {
    setBusy(true);
    try {
      await api("/me/web-search", { method: "PUT", body: { key } });
      setKey("");
      toast("Web search connected");
      load();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="settings-section">
      <h3>Web search</h3>
      <p className="muted">
        Assistants you allow to use the web can read pages without this. To let them search too, add a{" "}
        <a href={BRAVE_KEYS} target="_blank" rel="noopener noreferrer">
          Brave Search API key
        </a>{" "}
        of your own. Their searches go to Brave under your key.
      </p>
      {!state.available ? (
        <p className="notice">This server can't store keys yet: an admin needs to set SECRETS_KEY.</p>
      ) : state.connection ? (
        <ul className="members">
          <li>
            <div>
              <b>Brave Search</b> <span className="muted">· key …{state.connection.key_hint}</span>
            </div>
            <button
              className="danger-link"
              onClick={async () => {
                if (!(await confirmDialog({ title: "Remove the web search key?", message: "Assistants can still read pages, but can't search until you add a key again.", action: "Remove", danger: true }))) return;
                await api("/me/web-search", { method: "DELETE" }).catch(toastError);
                load();
              }}
            >
              Remove
            </button>
          </li>
        </ul>
      ) : (
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void connect();
          }}
        >
          <input value={key} onChange={(e) => setKey(e.target.value.trim())} placeholder="Brave Search API key" aria-label="Brave Search API key" autoComplete="off" spellCheck={false} type="password" />
          <button type="submit" className="primary" disabled={busy || key.length < 10}>
            {busy ? "Checking…" : "Add"}
          </button>
        </form>
      )}
    </section>
  );
}
