// Open the pull request (F14), or push more changes to it: a short form filled in from the changed
// notes. People who edited them are listed as co-authors in the commit message, where they can be
// seen and removed before anything leaves this app.

import { useMemo, useState } from "react";
import { api, type User } from "../lib/api";
import { type GitStatus, setGit } from "../lib/git";
import { Modal } from "../ui/Modal";
import { toast } from "../ui/overlays";

const title = (path: string) => path.split("/").pop()!.replace(/\.md$/i, "");

function summary(st: GitStatus, onlyUnpushed: boolean): string {
  const list = st.changes.filter((c) => !c.held && (!onlyUnpushed || c.unpushed));
  const names = list.map((c) => title(c.path));
  if (!names.length) return st.mergePending ? `Merge ${st.baseBranch}` : "Update notes";
  if (names.length === 1) return `${list[0]!.kind === "added" ? "Add" : list[0]!.kind === "deleted" ? "Remove" : "Update"} ${names[0]}`;
  if (names.length <= 3) return `Update ${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
  return `Update ${names.length} notes: ${names.slice(0, 2).join(", ")} and more`;
}

export function PullRequestDialog({ vaultId, status: st, user, onClose }: { vaultId: number; status: GitStatus; user: User; onClose: () => void }) {
  const first = !st.pr;
  const [branch, setBranch] = useState(st.branch);
  const [prTitle, setPrTitle] = useState(() => summary(st, false));
  const [body, setBody] = useState(() => st.changes.filter((c) => !c.held).map((c) => `- ${c.kind === "moved" ? `Moved ${c.from} to ${c.path}` : `${c.kind[0]!.toUpperCase()}${c.kind.slice(1)} ${c.path}`}`).join("\n") + "\n\nEdited in DO Notes.");
  const coauthors = useMemo(() => st.authors.filter((a) => a.id !== user.id).map((a) => `Co-authored-by: ${a.name} <${a.email}>`), [st, user]);
  const [message, setMessage] = useState(() => [summary(st, st.pushed), ...(coauthors.length ? ["", ...coauthors] : [])].join("\n"));
  const [busy, setBusy] = useState(false);
  // GitHub's refusal stays in the dialog, where it was asked for, until the next try.
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setBusy(true);
    setError(null);
    try {
      const next = await api<GitStatus>(`/vaults/${vaultId}/git/push`, { body: { message, ...(first ? { title: prTitle, body, branch: st.pushed ? undefined : branch } : {}) } });
      setGit(vaultId, next);
      onClose();
      const pr = next.pr;
      if (pr) toast(first ? `Opened pull request #${pr.number}` : `Pushed to pull request #${pr.number}`, { action: { label: "View on GitHub", run: () => void window.open(pr.url, "_blank", "noopener") } });
      else toast(`Pushed to ${next.branch}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A push can get as far as GitHub before the pull request is refused: show where it got to.
      void api<GitStatus>(`/vaults/${vaultId}/git`).then((next) => setGit(vaultId, next), () => {});
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal title={first ? "Open a pull request" : `Push to pull request #${st.pr!.number}`} onClose={onClose}>
      <form
        className="assistant-form pr-form"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <p className="muted">
          {first
            ? `Your changes go to ${st.repo} as one commit on a new branch, with a pull request into ${st.baseBranch}. Nothing reaches ${st.baseBranch} until it's merged on GitHub.`
            : `${st.unpushed} change${st.unpushed === 1 ? "" : "s"} since the last push${st.mergePending ? `, and the newer ${st.baseBranch} merged in` : ""}, as one more commit on ${st.branch}.`}
          {st.held > 0 && ` ${st.held === 1 ? "One change is" : `${st.held} changes are`} held back and stay${st.held === 1 ? "s" : ""} here.`}
        </p>
        {first && !st.pushed && (
          <label className="field">
            <span className="field-label">Branch</span>
            <input value={branch} onChange={(e) => setBranch(e.target.value.replace(/\s+/g, "-"))} required spellCheck={false} autoCapitalize="off" />
          </label>
        )}
        {first && (
          <>
            <label className="field">
              <span className="field-label">Title</span>
              <input value={prTitle} onChange={(e) => setPrTitle(e.target.value)} required maxLength={300} />
            </label>
            <label className="field">
              <span className="field-label">Description</span>
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} />
            </label>
          </>
        )}
        <label className="field">
          <span className="field-label">Commit message</span>
          <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={coauthors.length ? 4 : 2} required />
          {coauthors.length > 0 && <small className="muted">Others who edited these notes are named as co-authors, with their email. Remove a line to leave someone out.</small>}
        </label>
        {error && (
          <div className="error" role="alert">
            {error}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? "Sending to GitHub…" : first ? "Open pull request" : "Push changes"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
