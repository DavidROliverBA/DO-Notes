// Settings → This collection: setup (F20: where it's kept, people, home, starter types), name, how a
// GitHub collection sends its changes (F19), members and invitations, import, export, and leave or
// delete.

import { exportAixf } from "../lib/aixf";
import { useEffect, useRef, useState } from "react";
import { api, type Role, type User, type Vault } from "../lib/api";
import { navigate } from "../lib/router";
import { CollectionSetup } from "./CollectionSetup";
import { GitHubSending } from "./GitHubSending";
import { confirmDialog, promptDialog, toast, toastError } from "../ui/overlays";

interface Member {
  id: number;
  email: string;
  name: string;
  role: Role;
}

/** Someone invited but not yet in (N13): they get no access until they accept. */
interface Invite {
  id: number;
  email: string;
  role: Role;
}

interface Report {
  created: number;
  updated: number;
  skipped: number;
  attachments: number;
  errors: { path: string; error: string }[];
  typesAdded?: string[];
}

/** "System", "System and App", "System, App and Store". */
const listed = (xs: string[]) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)}`);

export function VaultSettings({ vault, user, onClose, onChanged }: { vault: Vault; user: User; onClose: () => void; onChanged: () => void }) {
  const isOwner = vault.role === "owner";
  const canWrite = vault.role !== "viewer";
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [name, setName] = useState(vault.name);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("editor");
  const [mode, setMode] = useState("overwrite");
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const dirInput = useRef<HTMLInputElement>(null);

  const load = () =>
    Promise.all([
      api<Member[]>(`/vaults/${vault.id}/members`).then(setMembers),
      isOwner ? api<Invite[]>(`/vaults/${vault.id}/invites`).then(setInvites) : setInvites([]),
    ]);
  useEffect(() => {
    void load();
  }, [vault.id]);
  // webkitdirectory isn't in React's typings.
  useEffect(() => dirInput.current?.setAttribute("webkitdirectory", ""), []);

  /** Run an action with a busy label; say when it's done, or what went wrong (principle 6). */
  async function run(label: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(label);
    try {
      await fn();
      if (done) toast(done);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  }

  // Removing a member is easy to reverse (the server puts them back with the same role for a few
  // minutes): offer Undo.
  function removeMember(m: Member) {
    void run("Removing…", async () => {
      await api(`/vaults/${vault.id}/members/${m.id}`, { method: "DELETE" });
      await load();
      toast(`Removed ${m.name} from “${vault.name}”`, {
        undo: () =>
          api(`/vaults/${vault.id}/members/${m.id}/restore`, { method: "POST" })
            .then(load)
            .catch(toastError),
      });
    });
  }

  // Cancelling an invitation is undone by sending it again.
  function cancelInvite(i: Invite) {
    void run("Cancelling…", async () => {
      await api(`/vaults/${vault.id}/invites/${i.id}`, { method: "DELETE" });
      await load();
      toast(`Cancelled the invitation to ${i.email}`, {
        undo: () =>
          api(`/vaults/${vault.id}/members`, { method: "PUT", body: { email: i.email, role: i.role } })
            .then(load)
            .catch(toastError),
      });
    });
  }

  async function leave() {
    const ok = await confirmDialog({
      title: "Leave this collection?",
      message: `You'll lose access to “${vault.name}” until an owner invites you again.`,
      action: "Leave collection",
      danger: true,
    });
    if (!ok) return;
    await run("Leaving…", async () => {
      await api(`/vaults/${vault.id}/members/${user.id}`, { method: "DELETE" });
      onClose();
      navigate("/");
      onChanged();
    }, `You left “${vault.name}”`);
  }

  async function deleteVault() {
    const typed = await promptDialog({
      title: "Delete this collection?",
      message: `This deletes every note in “${vault.name}” for every member, and can't be undone. Type the collection's name to confirm.`,
      label: "Collection name",
      placeholder: vault.name,
      mustMatch: vault.name,
      action: "Delete collection",
      danger: true,
    });
    if (typed !== vault.name) return;
    await run("Deleting…", async () => {
      await api(`/vaults/${vault.id}`, { method: "DELETE" });
      onClose();
      navigate("/");
      onChanged();
    }, `Deleted “${vault.name}”`);
  }

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    const form = new FormData();
    for (const f of list) {
      form.append("files", f, f.name);
      form.append("paths", (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name);
    }
    form.append("mode", mode);
    form.append("folder", folder);
    await run("Importing…", async () => {
      setReport(await api<Report>(`/vaults/${vault.id}/import`, { form }));
      onChanged();
    });
    if (filesInput.current) filesInput.current.value = "";
    if (dirInput.current) dirInput.current.value = "";
  }

  return (
    <>
      <CollectionSetup vault={vault} members={members.length} onChanged={onChanged} onInvite={() => { const i = document.querySelector<HTMLInputElement>('input[aria-label="Their email"]'); i?.scrollIntoView({ block: "center" }); i?.focus(); }} />
      <section className="settings-section">
        <h3>Collection</h3>
        <div className="row">
          <input value={name} onChange={(e) => setName(e.target.value)} disabled={!isOwner} aria-label="Collection name" />
          {isOwner && (
            <button onClick={() => run("Saving…", () => api(`/vaults/${vault.id}`, { method: "PATCH", body: { name } }).then(onChanged), "Collection renamed")} disabled={!name.trim() || name === vault.name}>
              Rename
            </button>
          )}
        </div>
        <p className="muted">
          Your role: <b>{vault.role}</b>. {vault.note_count} notes.
        </p>
      </section>

      {vault.git_repo && <GitHubSending vault={vault} />}

      <section className="settings-section">
        <h3>Members</h3>
        <ul className="members">
          {members.map((m) => (
            <li key={m.id}>
              <div>
                <b>{m.name}</b> <span className="muted">{m.email}</span>
              </div>
              {isOwner && m.id !== user.id ? (
                <div className="row">
                  <select
                    value={m.role}
                    aria-label={`${m.name}'s role`}
                    onChange={(e) => run("Saving…", () => api(`/vaults/${vault.id}/members`, { method: "PUT", body: { email: m.email, role: e.target.value } }).then(load), `${m.name} is now ${e.target.value === "owner" ? "an owner" : `a ${e.target.value}`}`)}
                  >
                    <option value="owner">Owner</option>
                    <option value="editor">Editor</option>
                    <option value="viewer">Viewer</option>
                  </select>
                  <button className="danger-link" onClick={() => removeMember(m)}>
                    Remove
                  </button>
                </div>
              ) : (
                <span className="pill">{m.role}</span>
              )}
            </li>
          ))}
          {invites.map((i) => (
            <li key={`invite-${i.id}`}>
              <div>
                <b>{i.email}</b> <span className="muted">invited as {i.role}, not joined yet</span>
              </div>
              <button className="danger-link" onClick={() => cancelInvite(i)}>
                Cancel invitation
              </button>
            </li>
          ))}
        </ul>
        {isOwner && (
          <form
            className="row wrap"
            onSubmit={(e) => {
              e.preventDefault();
              const to = email.trim();
              void run("Inviting…", async () => {
                const r = await api<{ status: "invited" | "updated" }>(`/vaults/${vault.id}/members`, { method: "PUT", body: { email: to, role } });
                setEmail("");
                await load();
                onChanged();
                toast(r.status === "invited" ? `Invited ${to}. They'll see it when they sign in.` : `${to} is now ${role === "owner" ? "an owner" : `a ${role}`}`);
              });
            }}
          >
            <input type="email" placeholder="Their email" aria-label="Their email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Their role">
              <option value="editor">Editor — can edit</option>
              <option value="viewer">Viewer — read only</option>
              <option value="owner">Owner — can manage</option>
            </select>
            <button type="submit">Invite</button>
          </form>
        )}
        <p className="muted">They join when they accept the invitation. No account yet? It waits for them: they can sign up (if open), or an admin can create one in Settings → Admin.</p>
      </section>

      {canWrite && (
        <section className="settings-section">
          <h3>Import markdown</h3>
          <p className="muted">A folder of Markdown files from any editor, a .zip of one, or individual .md files. Folder structure, frontmatter, tags, links and attachments come across; app settings folders (dot-folders) are skipped.</p>
          <div className="row wrap">
            <label>
              If a note exists:{" "}
              <select value={mode} onChange={(e) => setMode(e.target.value)}>
                <option value="overwrite">Overwrite (old text kept in history)</option>
                <option value="skip">Skip it</option>
                <option value="keep-both">Keep both</option>
              </select>
            </label>
            <input placeholder="Into folder (optional)" value={folder} onChange={(e) => setFolder(e.target.value)} />
          </div>
          <div className="row wrap">
            <button onClick={() => dirInput.current?.click()} disabled={!!busy}>
              Choose a folder…
            </button>
            <button onClick={() => filesInput.current?.click()} disabled={!!busy}>
              Choose .md / .zip files…
            </button>
            <input ref={dirInput} type="file" multiple hidden onChange={(e) => upload(e.target.files)} />
            <input ref={filesInput} type="file" multiple hidden accept=".md,.markdown,.zip,text/markdown,application/zip,image/*" onChange={(e) => upload(e.target.files)} />
            {busy && <span className="muted">{busy}</span>}
          </div>
          {report && (
            <div className="report">
              Imported: {report.created} new, {report.updated} updated, {report.attachments} attachments, {report.skipped} skipped.
              {report.typesAdded?.length ? ` Added the ${listed(report.typesAdded)} ${report.typesAdded.length === 1 ? "type" : "types"}, which the notes use.` : ""}
              {report.errors.length > 0 && (
                <details>
                  <summary>{report.errors.length} problems</summary>
                  <ul>
                    {report.errors.map((e) => (
                      <li key={e.path}>
                        {e.path}: {e.error}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </section>
      )}

      <section className="settings-section">
        <h3>Export</h3>
        <p className="muted">Everything as plain markdown in a .zip — open it in any Markdown editor.</p>
        <div className="row wrap">
          <a className="button" href={`/api/vaults/${vault.id}/export`}>
            Download collection (.zip)
          </a>
          {!vault.cloud && <button onClick={() => void exportAixf(vault.id, canWrite)}>Export as AI-XF bundle (.zip)</button>}
        </div>
        <p className="muted small">An AI-XF bundle is the same notes for Longview and other AI-XF tools: each with an id, relations as typed links, and a manifest.</p>
        {isOwner && !vault.cloud && (
          <label className="check">
            <input
              type="checkbox"
              checked={!!vault.note_ids}
              onChange={(e) => {
                const on = e.currentTarget.checked;
                void run("Saving…", () => api(`/vaults/${vault.id}`, { method: "PATCH", body: { noteIds: on } }).then(onChanged), on ? "New notes get an id" : "New notes no longer get an id");
              }}
            />{" "}
            Give new notes an id, which stays the same when they're renamed (for AI-XF bundles and links from other collections)
          </label>
        )}
      </section>

      <section className="settings-section danger-zone">
        <h3>Leave or delete</h3>
        <div className="row wrap">
          <button onClick={() => void leave()}>Leave collection</button>
          {isOwner && (
            <button className="danger" onClick={() => void deleteVault()}>
              Delete collection
            </button>
          )}
        </div>
      </section>
    </>
  );
}
