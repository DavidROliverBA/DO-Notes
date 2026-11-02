// The New journal entry sheet (F24): a box for the entry and Add. It goes into today's daily note
// of your home collection, under Journal with the time, and a toast offers to open it.

import { useState } from "react";
import { addJournalEntry, closeJournalEntry, useJournalEntryOpen } from "../lib/journal";
import { navigate, noteUrl } from "../lib/router";
import { Modal } from "../ui/Modal";
import { toast, toastError } from "../ui/overlays";

/** Mounted once in App; shows the sheet whenever newJournalEntry() has opened it. */
export function JournalEntryHost({ homeName, onAdded }: { homeName: string | null; onAdded: (vaultId: number) => void }) {
  const open = useJournalEntryOpen();
  return open ? <JournalEntry homeName={homeName} onAdded={onAdded} /> : null;
}

function JournalEntry({ homeName, onAdded }: { homeName: string | null; onAdded: (vaultId: number) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    if (!text.trim() || busy) return;
    setBusy(true);
    try {
      const r = await addJournalEntry(text);
      closeJournalEntry();
      onAdded(r.vaultId);
      toast(`Added to your journal at ${r.time}`, { action: { label: "Open", run: () => navigate(noteUrl(r.vaultId, r.noteId)) } });
    } catch (e) {
      toastError(e);
      setBusy(false);
    }
  }

  return (
    <Modal title="New journal entry" onClose={closeJournalEntry}>
      <form
        className="journal-entry"
        onSubmit={(e) => {
          e.preventDefault();
          void add();
        }}
      >
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) (e.preventDefault(), void add());
          }}
          placeholder="What's on your mind?"
          aria-label="Journal entry"
          rows={6}
        />
        <p className="muted small">Goes into today's daily note{homeName ? ` in ${homeName}` : ""}, under Journal with the time. Markdown works.</p>
        <div className="dialog-actions">
          <button type="button" onClick={closeJournalEntry}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={!text.trim() || busy}>
            {busy ? "Adding…" : "Add entry"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
