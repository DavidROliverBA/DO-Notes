// A labelled box that filters a list as you type (the ARIA combobox pattern): arrow keys move
// through the matches, Enter or a click chooses, Escape puts back what was chosen. The list
// shows below the box while it has focus. Keyboard alone does everything, and a screen reader
// hears the option it's on (aria-activedescendant). `create` adds a last option for text that
// matches nothing ("New kind “blocks”…").

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fuzzyScore } from "../lib/links";
import { Icon } from "./Icon";

export interface ComboOption {
  value: string;
  label: string;
  hint?: string;
  icon?: string;
}

export function Combobox({
  label,
  options,
  value,
  onChange,
  placeholder,
  create,
  autoFocus,
  className,
  name,
  initialText,
}: {
  /** Read by a screen reader, and shown above the box. */
  label: string;
  options: ComboOption[];
  value: string | null;
  onChange(value: string): void;
  placeholder?: string;
  /** Offer the typed text as something new: the option's words, and what choosing it does. */
  create?: { label: (text: string) => string; run: (text: string) => void };
  autoFocus?: boolean;
  className?: string;
  /** Marks the box (`data-combo`), so a screen can move focus to it. */
  name?: string;
  /** Text already typed when it opens (a board arrow's label), with "New…" ready if it's new. */
  initialText?: string;
}) {
  const id = useId();
  const chosen = options.find((o) => o.value === value) ?? null;
  const [q, setQ] = useState<string | null>(initialText || null); // null: not typing, so the box shows the choice
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  const shown = useMemo(() => {
    const t = (q ?? "").trim();
    if (!t) return options;
    return options
      .map((o) => ({ o, s: Math.max(fuzzyScore(t, o.label) + 50, fuzzyScore(t, `${o.hint ?? ""} ${o.label}`)) }))
      .filter((x) => x.s > -Infinity)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.o);
  }, [q, options]);
  const typed = (q ?? "").trim();
  const offerNew = !!create && !!typed && !options.some((o) => o.label.toLowerCase() === typed.toLowerCase());
  const count = shown.length + (offerNew ? 1 : 0);

  useEffect(() => {
    list.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [sel, open]);

  const choose = (i: number) => {
    if (i < shown.length) onChange(shown[i]!.value);
    else if (offerNew) create!.run(typed);
    setQ(null);
    setOpen(false);
  };
  const optId = (i: number) => `${id}-o${i}`;

  return (
    <div className={`combo${className ? ` ${className}` : ""}`}>
      <label className="combo-label" htmlFor={`${id}-in`}>
        {label}
      </label>
      <input
        id={`${id}-in`}
        role="combobox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-activedescendant={open && count ? optId(Math.min(sel, count - 1)) : undefined}
        autoFocus={autoFocus}
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={q ?? chosen?.label ?? ""}
        data-combo={name}
        onFocus={(e) => {
          setOpen(true);
          // Typed text with nothing chosen yet: "New…" is ready; otherwise the current choice.
          setSel(q !== null && offerNew && !value ? shown.length : Math.max(0, shown.findIndex((o) => o.value === value)));
          if (q === null) e.currentTarget.select();
        }}
        onBlur={() => (setOpen(false), setQ(null))}
        onChange={(e) => (setQ(e.target.value), setSel(0), setOpen(true))}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") (e.preventDefault(), setOpen(true), setSel((s) => Math.min(s + 1, count - 1)));
          else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
          else if (e.key === "Enter" && open && count) (e.preventDefault(), choose(Math.min(sel, count - 1)));
          else if (e.key === "Escape" && (open || q !== null)) (e.preventDefault(), e.stopPropagation(), setQ(null), setOpen(false));
        }}
      />
      {open && (
        <ul className="combo-list choose-list" id={`${id}-list`} role="listbox" aria-label={label} ref={list}>
          {shown.map((o, i) => (
            <li
              key={o.value}
              id={optId(i)}
              role="option"
              aria-selected={i === sel}
              className={i === sel ? "on" : ""}
              onMouseEnter={() => setSel(i)}
              onMouseDown={(e) => (e.preventDefault(), choose(i))}
            >
              {o.icon && <Icon name={o.icon} size={16} />}
              <span className="choose-label">{o.label}</span>
              {o.hint && <small>{o.hint}</small>}
            </li>
          ))}
          {offerNew && (
            <li id={optId(shown.length)} role="option" aria-selected={sel === shown.length} className={sel === shown.length ? "on" : ""} onMouseEnter={() => setSel(shown.length)} onMouseDown={(e) => (e.preventDefault(), choose(shown.length))}>
              <Icon name="plus" size={16} />
              <span className="choose-label">{create!.label(typed)}</span>
            </li>
          )}
          {count === 0 && <li className="muted choose-empty">Nothing matches</li>}
        </ul>
      )}
    </div>
  );
}
