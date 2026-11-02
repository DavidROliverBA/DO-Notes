// The AI tab of the side panel (⌘J): one conversation that follows you from note to note, for
// longer work across the vault. ✓ saves it as a note in AI/, ✗ throws it away. The panel's
// conversation lives in this module, so it survives the panel closing and changing notes.

import { useEffect, useState, useSyncExternalStore } from "react";
import { normalisePath } from "../../src/markdown";
import { api, type Note, type NoteSummary } from "../lib/api";
import { type Assistant, cachedAssistants, Conversation, loadAssistants, onAssistants } from "../lib/ai";
import { panel } from "../lib/aiPanel";
import { navigate, noteUrl } from "../lib/router";
import { formatDate } from "../lib/templates";
import { toast, toastError } from "../ui/overlays";
import { AiChat } from "./AiChat";
import { editAssistant } from "./AssistantDialog";

let conv: Conversation | null = null;
let seq = 0;
const listeners = new Set<() => void>();
const setConv = (c: Conversation | null) => {
  conv = panel.conv = c;
  seq++;
  listeners.forEach((f) => f());
};
/** A request to send in a new conversation as soon as the panel has one (Reflect on this week). */
let queued: string | null = null;
export function askInPanel(text: string) {
  queued = text;
  if (conv && !conv.empty) {
    conv.stop();
    setConv(new Conversation(conv.assistant, where));
  } else listeners.forEach((f) => f());
}

/** Where the person is, read at each send: the panel follows them between notes and vaults. */
const here = { vaultId: 0, noteId: null as number | null };
const where = () => ({ ...here });

/** The assistant to start with: the last one used, else the first. */
export function preferredAssistant(list: Assistant[]): Assistant | undefined {
  let last = 0;
  try {
    last = Number(localStorage.getItem("cp:ai"));
  } catch {}
  return list.find((a) => a.id === last) ?? list[0];
}
/** Make this the assistant preferredAssistant() starts with next time, on this device. */
export function rememberAssistant(a: Assistant) {
  try {
    localStorage.setItem("cp:ai", String(a.id));
  } catch {}
}

/** Your assistants, live; null until the first load has finished (so "none yet" isn't shown early). */
export function useAssistants(): Assistant[] | null {
  const [ready, setReady] = useState(false);
  const list = useSyncExternalStore(onAssistants, cachedAssistants);
  useEffect(() => {
    loadAssistants().then(() => setReady(true), toastError);
  }, []);
  return ready ? list : null;
}

interface Props {
  vaultId: number;
  noteId: number | null;
  notes: NoteSummary[];
  you: string;
  onOpenLink: (target: string) => void;
}

export function AiPanel(p: Props) {
  const list = useAssistants();
  const current = useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => conv,
  );
  here.vaultId = p.vaultId;
  here.noteId = p.noteId;

  useEffect(() => {
    if (!list || current) return;
    const a = preferredAssistant(list);
    if (a) setConv(new Conversation(a, where));
  }, [list, current]);
  const ticks = useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => seq + (queued ? 0.5 : 0),
  );
  useEffect(() => {
    if (!current || !queued || !current.empty) return;
    const text = queued;
    queued = null;
    void current.send(text);
  }, [current, ticks]);

  if (!list) return <div className="ai-panel" />;
  if (!list.length)
    return (
      <div className="ai-panel ai-empty">
        <p>Bring your own AI: add an assistant with your API key, and it can find, write and tidy your notes for you.</p>
        <button className="primary" onClick={() => void editAssistant()}>
          Add an assistant
        </button>
      </div>
    );
  if (!current) return <div className="ai-panel" />;

  const restart = (a: Assistant) => {
    current.stop();
    rememberAssistant(a);
    setConv(new Conversation(a, where));
  };

  async function save() {
    if (!current || current.empty) return;
    const first = current.messages.find((m) => m.role === "user");
    const topic = (first?.role === "user" ? first.text : "Conversation").replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 50);
    const date = formatDate(new Date(), "YYYY-MM-DD");
    const body = `---\nassistant: ${current.assistant.name}\ndate: ${date}\ntags:\n  - ai\n---\n\n${current.transcript(p.you)}\n`;
    try {
      let path = normalisePath(`AI/${date} ${topic}`);
      for (let i = 2; p.notes.some((n) => n.path.toLowerCase() === path.toLowerCase()); i++) path = normalisePath(`AI/${date} ${topic} ${i}`);
      const n = await api<Note>(`/vaults/${p.vaultId}/notes`, { body: { path, content: body } });
      toast(`Saved as ${n.path.replace(/\.md$/, "")}`, { action: { label: "Open", run: () => navigate(noteUrl(p.vaultId, n.id)) } });
      restart(current.assistant);
    } catch (e) {
      toastError(e);
    }
  }

  return (
    <div className="ai-panel">
      <AiChat
        key={seq}
        conv={current}
        vaultId={p.vaultId}
        notes={p.notes}
        onOpenLink={p.onOpenLink}
        onKeep={() => void save()}
        keepLabel="Save as a note"
        onDiscard={() => restart(current.assistant)}
        discard={{ label: "Discard and start a new conversation", icon: "new-chat" }}
        autoFocus
        header={
          <select
            className="ai-picker"
            value={current.assistant.id}
            aria-label="Assistant"
            onChange={(e) => {
              if (e.target.value === "new") {
                void editAssistant().then((a) => a && restart(a));
                return;
              }
              const a = list.find((x) => x.id === Number(e.target.value));
              if (a) restart(a);
            }}
          >
            {list.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.model}
              </option>
            ))}
            <option value="new">+ Add an assistant…</option>
          </select>
        }
      />
    </div>
  );
}
