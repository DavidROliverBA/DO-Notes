// Open a note by name (⌘O): fuzzy-matches titles (weighted above paths), most recently changed
// first when empty, and offers to create the note when nothing matches its title exactly. In the
// shared Modal (bare, its own box), so focus stays inside and goes back where it was on Escape;
// choosing a note lets the note take focus instead.

import { useMemo, useRef, useState } from "react";
import type { NoteSummary } from "../lib/api";
import { fuzzyScore } from "../lib/links";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";

/** A command offered when its name is typed (the app passes these; the standalone file doesn't). */
export interface SwitcherCommand {
  id: string;
  title: string;
  icon?: string;
  run(): void;
}

export function QuickSwitcher({ notes, canCreate, onPick, onCreate, onClose, findCommands }: { notes: NoteSummary[]; canCreate: boolean; onPick: (n: NoteSummary) => void; onCreate: (title: string) => void; onClose: () => void; findCommands?: (q: string) => SwitcherCommand[] }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const results = useMemo(() => {
    if (!q.trim()) return [...notes].sort((a, b) => b.updated_at.localeCompare(a.updated_at)).slice(0, 30);
    return notes
      .map((n) => ({ n, s: Math.max(fuzzyScore(q, n.title) + 50, fuzzyScore(q, n.path)) }))
      .filter((x) => x.s > -Infinity)
      .sort((a, b) => b.s - a.s)
      .slice(0, 30)
      .map((x) => x.n);
  }, [q, notes]);
  // Commands whose name was typed ("tour", "history"): first, unless a note's title starts with
  // the words (that note is what was meant); then the other notes, and Create last.
  const commands = useMemo(() => findCommands?.(q) ?? [], [q]);
  const exact = results.some((n) => n.title.toLowerCase() === q.trim().toLowerCase());
  const showCreate = canCreate && q.trim() && !exact;
  type Row = { note: NoteSummary } | { command: SwitcherCommand } | { create: string };
  const rows = useMemo<Row[]>(() => {
    const want = q.trim().toLowerCase();
    const named = commands.length ? results.filter((n) => n.title.toLowerCase().startsWith(want)) : [];
    const others = results.filter((n) => !named.includes(n));
    return [...named.map((note) => ({ note })), ...commands.map((command) => ({ command })), ...others.map((note) => ({ note })), ...(showCreate ? [{ create: q.trim() }] : [])];
  }, [results, commands, showCreate, q]);
  const count = rows.length;

  const chose = useRef(false);
  function choose(i: number) {
    const row = rows[i];
    if (!row) return;
    chose.current = true;
    if ("note" in row) onPick(row.note);
    else if ("command" in row) (onClose(), row.command.run());
    else onCreate(row.create);
  }

  return (
    <Modal title="Open note" bare top className="switcher" onClose={onClose} returnFocus={() => !chose.current}>
      <input
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls="switcher-list"
        aria-activedescendant={`switcher-opt-${sel}`}
        aria-label="Find or create a note"
        placeholder="Find or create a note…"
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, count - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
          else if (e.key === "Enter") (e.preventDefault(), choose(sel));
        }}
      />
      <ul id="switcher-list" role="listbox" aria-label="Notes" tabIndex={-1}>
        {rows.map((row, i) => (
          <li
            key={"note" in row ? `n${row.note.id}` : "command" in row ? `c${row.command.id}` : "create"}
            id={`switcher-opt-${i}`}
            role="option"
            aria-selected={i === sel}
            className={`${"command" in row ? "switcher-command " : ""}${i === sel ? "on" : ""}`.trim()}
            onMouseEnter={() => setSel(i)}
            onClick={() => choose(i)}
          >
            {"note" in row ? (
              <>
                <span>{row.note.title}</span>
                {row.note.path.includes("/") && <small>{row.note.path.replace(/\/[^/]+$/, "")}</small>}
              </>
            ) : "command" in row ? (
              <>
                <span>
                  {row.command.icon && <Icon name={row.command.icon} size={16} />} {row.command.title}
                </span>
                <small>command</small>
              </>
            ) : (
              <>
                <span>Create “{row.create}”</span>
                <small>new note</small>
              </>
            )}
          </li>
        ))}
      </ul>
      <footer className="muted keys-hint">↑↓ to move · ↵ to open · esc to close</footer>
    </Modal>
  );
}
