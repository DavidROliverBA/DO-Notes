// Floe in DO Notes (F41, docs/design/F41.md; the server side is src/floeLandscape.ts): bring a
// landscape in from the person's Floe connection, update it later without losing what they
// wrote, see when Floe has changed, and put a Floe diagram in any note. Every change is previewed
// before it happens; nothing in Floe changes.

import { api } from "./api";
import { chooseDialog, confirmDialog, promptDialog, toast, toastError } from "../ui/overlays";
import { newBlock } from "../../src/floeDiagrams";
import type { EditorHandle } from "../components/Editor";

interface FloeState {
  connected: boolean;
  web: string | null;
}
interface Preview {
  landscape: { id: string; name: string };
  folder: string;
  bring: boolean;
  hash: string;
  upToDate: boolean;
  notes: number;
  new: number;
  changed: number;
  renamed: { from: string; to: string }[];
  removed: string[];
  edited: string[];
  adopted: string[];
  kept: number;
  types: string[];
  diagrams: number;
  overview: string;
}
interface Applied {
  created: number;
  changed: number;
  renamed: number;
  removed: number;
  typesAdded: string[];
  overview: string;
  clashes: string[];
}

let known: FloeState | null = null;
let asked = 0;

/** Whether Floe is connected, as last known; asked again in the background after a minute. */
export function floeConnected(): boolean {
  if (Date.now() - asked > 60_000) {
    asked = Date.now();
    api<FloeState>("/me/floe").then(
      (s) => {
        const changed = known?.connected !== s.connected;
        known = s;
        if (changed) dispatchEvent(new Event("cp:floe"));
      },
      () => (asked = 0),
    );
  }
  return !!known?.connected;
}

export const floeWeb = () => known?.web ?? null;

/** "System", "System and App", "System, App and Store", "…and 3 more". */
function listed(xs: string[], most = 5): string {
  const shown = xs.length > most ? [...xs.slice(0, most), `${xs.length - most} more`] : xs;
  return shown.length < 2 ? shown.join("") : `${shown.slice(0, -1).join(", ")} and ${shown.at(-1)}`;
}
const notes = (n: number) => `${n} note${n === 1 ? "" : "s"}`;

/** What an update will do, in a few sentences. */
function updateMessage(p: Preview): string {
  const what = [
    p.changed ? `${notes(p.changed)} changed` : "",
    p.new ? `${p.new} new` : "",
    p.renamed.length ? `${p.renamed.length} renamed (${listed(p.renamed.map((r) => `${r.from} → ${r.to}`), 3)})` : "",
    p.removed.length ? `${p.removed.length} removed in Floe (${listed(p.removed, 3)}): kept here, marked removed` : "",
  ].filter(Boolean);
  return [
    what.length ? `${what.join(" · ")}.` : "Only the diagrams or the overview changed.",
    p.kept ? `Your writing in ${notes(p.kept)} is kept.` : "",
    p.edited.length ? `You had changed Floe's part of ${listed(p.edited)}: Floe's version replaces it.` : "",
    p.adopted.length ? `${listed(p.adopted)} get${p.adopted.length === 1 ? "s" : ""} a Floe section at the top; what's in ${p.adopted.length === 1 ? "it" : "them"} now stays below.` : "",
    p.types.length ? `It adds the ${listed(p.types)} type${p.types.length === 1 ? "" : "s"}.` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function bringMessage(p: Preview): string {
  return [
    `${notes(p.notes)}${p.types.length ? `, and the ${listed(p.types)} type${p.types.length === 1 ? "" : "s"}` : ""}, with an overview note${p.diagrams ? ` holding ${p.diagrams === 1 ? "its diagram" : `its ${p.diagrams} diagrams`}` : ""}.`,
    p.adopted.length ? `${listed(p.adopted)} came from an earlier import: they get a Floe section at the top, and keep what's in them below.` : "",
    "Write in them as you like: Update from Floe changes only Floe's part of each note.",
  ]
    .filter(Boolean)
    .join(" ");
}

async function chooseLandscape(title: string): Promise<{ id: string; name: string } | null> {
  const ls = await api<{ id: string; name: string }[]>("/me/floe/landscapes");
  if (!ls.length) {
    toast("Your Floe has no landscapes yet");
    return null;
  }
  const id = await chooseDialog({ title, options: ls.map((l) => ({ value: l.id, label: l.name, icon: "graph" })), placeholder: "Find a landscape…" });
  return ls.find((l) => l.id === id) ?? null;
}

/** ⌘K → Bring in a landscape from Floe…: choose it, see what comes, choose the folder. */
export async function bringInLandscape(vaultId: number, openNote: (path: string) => void) {
  try {
    const l = await chooseLandscape("Bring in a landscape from Floe");
    if (!l) return;
    const p = await api<Preview>(`/vaults/${vaultId}/floe`, { body: { landscape: l.id } });
    if (!p.bring) return void (await confirmUpdate(vaultId, p, openNote));
    const folder = await promptDialog({ title: `Bring in “${l.name}” from Floe`, message: bringMessage(p), label: "Into the folder", value: p.folder, action: "Bring in" });
    if (folder === null) return;
    const r = await api<Applied>(`/vaults/${vaultId}/floe`, { body: { landscape: l.id, folder: folder.trim() || p.folder, apply: true, hash: p.hash } });
    toast(`Brought in ${l.name}: ${notes(r.created)}${r.typesAdded.length ? `, and the ${listed(r.typesAdded)} types` : ""}`);
    openNote(r.overview);
  } catch (e) {
    toastError(e);
  }
}

async function confirmUpdate(vaultId: number, p: Preview, openNote?: (path: string) => void) {
  if (p.upToDate) return toast(`“${p.landscape.name}” is up to date with Floe`);
  if (!(await confirmDialog({ title: `Update “${p.landscape.name}” from Floe?`, message: updateMessage(p), action: "Update" }))) return;
  const r = await api<Applied>(`/vaults/${vaultId}/floe`, { body: { landscape: p.landscape.id, apply: true, hash: p.hash } });
  const done = [r.changed ? `${r.changed} changed` : "", r.created ? `${r.created} new` : "", r.renamed ? `${r.renamed} renamed` : "", r.removed ? `${r.removed} marked removed` : ""].filter(Boolean);
  toast(`Updated ${p.landscape.name}${done.length ? `: ${done.join(", ")}` : ""}${r.clashes.length ? `. Not renamed, as the name is taken: ${listed(r.clashes)}` : ""}`);
  openNote?.(r.overview);
}

/** Update from Floe, on a note of a brought-in landscape. */
export async function updateLandscape(vaultId: number, landscape: string) {
  try {
    await confirmUpdate(vaultId, await api<Preview>(`/vaults/${vaultId}/floe`, { body: { landscape } }));
  } catch (e) {
    toastError(e);
  }
}

const checked = new Set<string>();
/** Opening a landscape's overview asks Floe, once a session, whether it has changed since. */
export async function checkLandscape(vaultId: number, landscape: string) {
  const key = `${vaultId}:${landscape}`;
  if (checked.has(key)) return;
  checked.add(key);
  try {
    const s = await api<{ changed: boolean; updated: string | null }>(`/vaults/${vaultId}/floe/status?landscape=${encodeURIComponent(landscape)}`);
    if (s.changed) {
      const since = s.updated ? new Date(`${s.updated}T12:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : "";
      toast(`Floe has changed${since ? ` since ${since}` : ""}`, { action: { label: "Update", run: () => updateLandscape(vaultId, landscape) } });
    }
  } catch {
    // Quiet: Floe asleep or out of reach isn't worth a message on opening a note.
  }
}

/** Open the landscape in Floe. */
export function openInFloe(landscape: string) {
  const web = floeWeb();
  if (web) window.open(`${web}/#/l/${encodeURIComponent(landscape)}`, "_blank", "noopener");
}

/** `/` → Floe diagram…: choose a landscape, then a diagram, and it goes in filled. */
export async function insertFloeDiagram(e: EditorHandle) {
  try {
    const l = await chooseLandscape("Floe diagram: which landscape?");
    if (!l) return;
    const ds = await api<{ id: string; name: string }[]>(`/me/floe/landscapes/${encodeURIComponent(l.id)}/diagrams`);
    if (!ds.length) return toast(`“${l.name}” has no diagrams yet`);
    const id = await chooseDialog({ title: `Floe diagram from “${l.name}”`, options: ds.map((d) => ({ value: d.id, label: d.name, icon: "graph" })), placeholder: "Find a diagram…" });
    const d = ds.find((x) => x.id === id);
    if (!d) return;
    const { text } = await api<{ text: string }>(`/me/floe/diagrams/${encodeURIComponent(d.id)}`);
    e.insert(`\n${newBlock({ id: d.id, landscape: l.name, diagram: d.name }, text)}\n`);
  } catch (err) {
    toastError(err);
  }
}

/** Update every Floe diagram in the note from Floe. */
export async function refreshFloeDiagrams(vaultId: number, noteId: number) {
  try {
    const r = await api<{ updated: number; problems: string[] }>(`/vaults/${vaultId}/notes/${noteId}/floe-diagrams`, { method: "POST" });
    const head = r.updated ? `Updated ${r.updated} diagram${r.updated === 1 ? "" : "s"} from Floe` : "The diagrams are as Floe has them";
    toast(r.problems.length ? `${head}. Not found: ${listed(r.problems, 2)}` : head, r.problems.length ? { tone: "error" } : {});
  } catch (err) {
    toastError(err);
  }
}
