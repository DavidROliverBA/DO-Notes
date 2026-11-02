// ⌘K / ⌘P: every action that applies right now, from the one list in web/lib/commands.ts. In the
// shared Modal (bare, its own box), so focus stays inside and goes back where it was on Escape;
// running a command lets the command decide where focus goes.

import { useMemo, useRef, useState } from "react";
import { available, type Command, currentCtx, type Group } from "../lib/commands";
import { fuzzyScore } from "../lib/links";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";

const ORDER: Group[] = ["Insert", "Note", "View", "Create", "Go", "Collection", "Settings", "Help"];

/** Each word of the query must match the command, in any order ("account settings" finds
 *  Settings → Account); a match in the title counts for more. -Infinity if a word doesn't match. */
export function commandScore(q: string, c: Pick<Command, "title" | "group" | "keywords">): number {
  const hay = `${c.group} ${c.title} ${c.keywords ?? ""}`;
  let total = 0;
  for (const w of q.trim().split(/\s+/)) {
    const s = Math.max(fuzzyScore(w, c.title) + 50, fuzzyScore(w, hay));
    if (s === -Infinity) return -Infinity;
    total += s;
  }
  return total;
}

/** Commands for a search box (Find a note, the Search tab): someone typing "tour" or "history"
 *  there means the command. Stricter than the palette: each word must start a word of the
 *  command's title or keywords, at least three letters in all, and nothing from the / menu. */
export function findCommands(q: string, limit = 3): Command[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.join("").length < 3) return [];
  return available()
    .filter((c) => c.group !== "Insert")
    .filter((c) => {
      const hay = `${c.title} ${c.keywords ?? ""}`.toLowerCase().split(/[^\p{L}\p{N}]+/u);
      return words.every((w) => hay.some((h) => h.startsWith(w)));
    })
    .map((c) => ({ c, s: commandScore(q, c) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.c);
}

/** Run a command once the box it was chosen in has closed, so focus lands where it puts it. */
export function runCommandSoon(c: Command): void {
  requestAnimationFrame(() => (c.href ? (location.href = c.href(currentCtx())) : c.run(currentCtx())));
}

export function CommandPalette({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const all = useMemo(() => available(), []);
  const results = useMemo(() => {
    if (!q.trim()) return [...all].sort((a, b) => ORDER.indexOf(a.group) - ORDER.indexOf(b.group));
    return all
      .map((c) => ({ c, s: commandScore(q, c) }))
      .filter((x) => x.s > -Infinity)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
  }, [q, all]);

  const ran = useRef(false);
  function run(c: Command | undefined) {
    if (!c) return;
    ran.current = true;
    onClose();
    runCommandSoon(c);
  }

  return (
    <Modal title="Commands" bare top className="switcher palette" onClose={onClose} returnFocus={() => !ran.current}>
      <input
        autoFocus
        role="combobox"
        aria-expanded="true"
        aria-controls="palette-list"
        aria-activedescendant={results.length ? `palette-opt-${sel}` : undefined}
        placeholder="Type a command…"
        value={q}
        onChange={(e) => (setQ(e.target.value), setSel(0))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, results.length - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
          else if (e.key === "Enter") (e.preventDefault(), run(results[sel]));
        }}
        aria-label="Command"
      />
      <ul id="palette-list" role="listbox" aria-label="Commands" tabIndex={-1}>
        {results.map((c, i) => (
          <li key={c.id} id={`palette-opt-${i}`} role="option" aria-selected={i === sel} className={`${i === sel ? "on" : ""}${c.danger ? " danger" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
            {c.icon && <Icon name={c.icon} size={16} />}
            <span className="palette-title">{c.title}</span>
            {c.shortcut ? <kbd>{c.shortcut}</kbd> : <small>{c.group}</small>}
          </li>
        ))}
        {results.length === 0 && (
          <li className="muted" role="option" aria-selected={false} aria-disabled="true">
            No command by that name
          </li>
        )}
      </ul>
      <footer className="muted keys-hint">↑↓ to move · ↵ to run · esc to close · / in a note for blocks</footer>
    </Modal>
  );
}
