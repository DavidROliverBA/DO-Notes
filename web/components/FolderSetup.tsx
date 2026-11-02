// Setup → Kept, on the Mac (F22): keep a collection in a folder of Markdown on this computer, or
// stop; how the two are kept in step; and the notes changed on both sides that wait for a choice.
// Shown only where the server can reach folders (the laptop kit).

import { useCallback, useEffect, useState } from "react";
import { api, type Vault } from "../lib/api";
import { lineDiff } from "../lib/diff";
import { Diff } from "../ui/Diff";
import { Icon } from "../ui/Icon";
import { chooseDialog, confirmDialog, promptDialog, toast, toastError } from "../ui/overlays";

type Mode = "folder" | "both";
interface Clash {
  path: string;
  mine: string | null;
  theirs: string | null;
  base: string | null;
}
export interface FolderStatus {
  root: string;
  label: string;
  mode: Mode;
  paused: boolean;
  pausedWhy: string | null;
  lastSync: string | null;
  lastError: string | null;
  clashes: Clash[];
}
interface Place {
  root: string;
  label: string;
  vaultId: number | null;
}

const MODES: { value: Mode; label: string; hint: string }[] = [
  { value: "both", label: "Both, kept in step", hint: "edits on either side reach the other; a note changed on both waits for you" },
  { value: "folder", label: "The folder is the master copy", hint: "if a note changes on both sides, the folder's text wins (yours stays in its history)" },
];

/** Whether this server can keep collections in folders, and where they can go. */
export function useFolders(): { available: boolean; folders: Place[]; reload: () => void } {
  const [s, setS] = useState<{ available: boolean; folders: Place[] }>({ available: false, folders: [] });
  const reload = useCallback(() => void api<{ available: boolean; folders: Place[] }>("/folders").then(setS, () => {}), []);
  useEffect(reload, [reload]);
  return { ...s, reload };
}

async function pickFolder(places: Place[], purpose: string): Promise<{ root: string; create: boolean } | null> {
  const free = places.filter((p) => p.vaultId === null);
  const choice = await chooseDialog({
    title: purpose,
    message: "A folder on this Mac. You can open it in Obsidian, VS Code or any other editor too.",
    options: [{ value: "\u0000new", label: "New folder…", icon: "folder-plus" }, ...free.map((p) => ({ value: p.root, label: p.root, hint: p.label.slice(0, -p.root.length - 1), icon: "folder" }))],
    placeholder: "Find a folder",
  });
  if (choice === null) return null;
  if (choice !== "\u0000new") return { root: choice, create: false };
  const name = await promptDialog({ title: "New folder", label: "Folder name", placeholder: "Work notes", action: "Create" });
  return name ? { root: name, create: true } : null;
}

async function pickMode(current?: Mode): Promise<Mode | null> {
  const m = await chooseDialog({ title: "How should they be kept in step?", options: MODES.map((x) => ({ ...x, label: x.value === current ? `${x.label} (now)` : x.label })) });
  return m as Mode | null;
}

/** The "Kept" row's value for a collection that could live in a folder, with what can be done. */
export function FolderKept({ vault, onChanged }: { vault: Vault; onChanged: () => void }) {
  const { available, folders, reload } = useFolders();
  const [status, setStatus] = useState<FolderStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const owner = vault.role === "owner";
  const load = useCallback(() => void api<FolderStatus | { ok: true }>(`/vaults/${vault.id}/folder`).then((s) => setStatus("root" in s ? s : null), () => {}), [vault.id]);
  useEffect(load, [load, vault.folder]);

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    try {
      await fn();
      load();
      reload();
      onChanged();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  }

  const keepInFolder = () =>
    run(async () => {
      const place = await pickFolder(folders, `Keep “${vault.name}” in a folder`);
      if (!place) return;
      const mode = await pickMode();
      if (!mode) return;
      const s = await api<FolderStatus>(`/vaults/${vault.id}/folder`, { method: "PUT", body: { root: place.root, mode, create: place.create } });
      toast(`“${vault.name}” is kept in ${s.label}`);
    });
  const exportTo = () =>
    run(async () => {
      const place = await pickFolder(folders, `Export “${vault.name}” to a folder`);
      if (!place) return;
      const r = await api<{ files: number; label: string }>(`/vaults/${vault.id}/folder/export`, { body: { root: place.root } });
      toast(`Wrote ${r.files} ${r.files === 1 ? "file" : "files"} to ${r.label}`);
    });
  const changeMode = () =>
    run(async () => {
      const mode = await pickMode(status!.mode);
      if (mode && mode !== status!.mode) await api(`/vaults/${vault.id}/folder`, { method: "PUT", body: { root: status!.root, mode } });
    });
  const stop = () =>
    run(async () => {
      if (!(await confirmDialog({ title: `Stop keeping “${vault.name}” in ${status!.label}?`, message: "The notes stay here and the files stay in the folder, but changes no longer pass between them. To keep it in the folder again, the folder must be empty.", action: "Stop keeping it there" }))) return;
      await api(`/vaults/${vault.id}/folder`, { method: "DELETE" });
      toast(`“${vault.name}” is kept in this library only`);
    });
  const rebuild = () =>
    run(async () => {
      if (!(await confirmDialog({ title: "Rebuild from the folder?", message: `Every note takes its text from ${status!.label}, and notes that aren't in the folder go to Trash.`, action: "Rebuild" }))) return;
      await api(`/vaults/${vault.id}/folder/rebuild`, { method: "POST" });
      toast("Rebuilt from the folder");
    });
  const pause = (paused: boolean) => run(() => api(`/vaults/${vault.id}/folder/pause`, { body: { paused } }));

  if (!status) {
    if (!available || vault.git_repo) return <>{vault.git_repo ? <>In this library, copied from GitHub: <code>{vault.git_repo}</code></> : "In this library"}</>;
    return (
      <>
        In this library
        {owner && (
          <button onClick={() => void keepInFolder()} disabled={busy}>
            Keep in a folder on this Mac…
          </button>
        )}
        <button className="link" onClick={() => void exportTo()} disabled={busy}>
          Export to a folder…
        </button>
      </>
    );
  }
  return (
    <div className="folder-kept">
      <div>
        In a folder on this Mac: <code>{status.label}</code> · {MODES.find((m) => m.value === status.mode)!.label.toLowerCase()}
      </div>
      <div className="muted small" role="status">
        {status.paused ? <><Icon name="pause" size={12} /> Paused{status.pausedWhy ? `: ${status.pausedWhy}` : ""}.</> : status.lastError ? <><Icon name="alert" size={12} /> {status.lastError}</> : status.lastSync ? `In step, checked ${new Date(status.lastSync).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Starting…"}
      </div>
      {owner && (
        <div className="folder-actions">
          {status.paused ? (
            <button onClick={() => void pause(false)} disabled={busy}>
              <Icon name="play" size={14} /> Resume
            </button>
          ) : (
            <button className="quiet" onClick={() => void pause(true)} disabled={busy}>
              <Icon name="pause" size={14} /> Pause
            </button>
          )}
          <button className="quiet" onClick={() => void changeMode()} disabled={busy}>
            Change how
          </button>
          {status.mode === "folder" && (
            <button className="quiet" onClick={() => void rebuild()} disabled={busy}>
              Rebuild from the folder
            </button>
          )}
          <button className="quiet" onClick={() => void stop()} disabled={busy}>
            Stop keeping it there
          </button>
        </div>
      )}
      {status.clashes.length > 0 && (
        <>
          <h4>Changed in both places</h4>
          <ul className="changes">
            {status.clashes.map((c) => (
              <FolderClash key={c.path} vault={vault} clash={c} label={status.label} onDone={load} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function FolderClash({ vault, clash, label, onDone }: { vault: Vault; clash: Clash; label: string; onDone: () => void }) {
  const canWrite = vault.role !== "viewer";
  async function pick(take: "mine" | "theirs") {
    try {
      await api(`/vaults/${vault.id}/folder/resolve`, { body: { path: clash.path, take } });
      toast(take === "mine" ? `Kept this ${clash.path}` : `Took the folder's ${clash.path}`);
      onDone();
    } catch (e) {
      toastError(e);
    }
  }
  return (
    <li className="change change-clash">
      <div className="change-head">
        <span className="change-kind">
          <Icon name="folder" size={14} /> Clash
        </span>
        <span className="change-path">{clash.path}</span>
        <span className="muted change-from">{clash.theirs === null ? "deleted in the folder, changed here" : clash.mine === null ? "changed in the folder, deleted here" : "changed here and in the folder"}</span>
        {canWrite && (
          <span className="change-actions">
            <button className="quiet" onClick={() => void pick("mine")}>
              Keep this one
            </button>
            <button className="quiet" onClick={() => void pick("theirs")}>
              Take the folder's
            </button>
          </span>
        )}
      </div>
      <p className="muted change-note">From this one to the one in {label}:</p>
      <Diff lines={lineDiff(clash.mine ?? "", clash.theirs ?? "")} label={`This ${clash.path} against the folder's`} />
    </li>
  );
}
