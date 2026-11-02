// The app's own confirm, prompt and toasts, in place of the browser's alert/confirm/prompt
// (docs/PRINCIPLES.md §2 and §5). Callable from anywhere, including CodeMirror widgets that live
// outside React; <Overlays /> (mounted once, in App) draws them.
//
//   if (!(await confirmDialog({ title: "Delete forever?", message, action: "Delete forever", danger: true }))) return;
//   const name = await promptDialog({ title: "New folder", value: "Untitled", action: "Create folder" });
//   const folder = await chooseDialog({ title: "Move to…", options, placeholder: "Find a folder…" });
//   toast("Moved “Plans” to Trash", { undo: () => restore() });
//   toastError(err);

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { fuzzyScore } from "../lib/links";
import { Icon } from "./Icon";
import { MenuHost } from "./Menu";
import { Modal } from "./Modal";

interface ConfirmOpts {
  title: string;
  message?: string;
  /** The button that does it: a verb, never "OK" (principle 8). */
  action: string;
  danger?: boolean;
}
interface PromptOpts {
  title: string;
  message?: string;
  label?: string;
  value?: string;
  placeholder?: string;
  action: string;
  danger?: boolean;
  /** The action works with nothing typed (an optional reason). */
  optional?: boolean;
  /** Only allow the action once the text equals this (typing a name to confirm a delete). */
  mustMatch?: string;
  /** "date": the browser's date picker, answering YYYY-MM-DD. "password": hidden as typed. */
  input?: "text" | "date" | "password";
}
export interface Choice {
  value: string;
  label: string;
  /** Shown faint after the label (a folder's parent, a shortcut). */
  hint?: string;
  icon?: string;
  /** A colour swatch before the label: a class such as "tc-red" or "hl-red" (F10). */
  swatch?: string;
}
interface ChooseOpts {
  title: string;
  message?: string;
  options: Choice[];
  placeholder?: string;
  /** Shown when the filter matches nothing. */
  empty?: string;
}
type Dialog = ({ kind: "confirm" } & ConfirmOpts) | ({ kind: "prompt" } & PromptOpts) | ({ kind: "choose" } & ChooseOpts);
type Pending = { id: number; dialog: Dialog; resolve: (v: string | null) => void };

export interface Toast {
  id: number;
  text: string;
  tone: "info" | "error";
  action?: { label: string; run: () => unknown };
}

let seq = 0;
let dialogs: Pending[] = [];
let toasts: Toast[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => (listeners.add(l), () => void listeners.delete(l));

function ask(dialog: Dialog): Promise<string | null> {
  return new Promise((resolve) => {
    dialogs = [...dialogs, { id: ++seq, dialog, resolve }];
    emit();
  });
}
function settle(id: number, value: string | null) {
  const d = dialogs.find((x) => x.id === id);
  dialogs = dialogs.filter((x) => x.id !== id);
  emit();
  d?.resolve(value);
}

/** Ask before something that can't be undone. Resolves true if they chose the action. */
export async function confirmDialog(opts: ConfirmOpts): Promise<boolean> {
  return (await ask({ kind: "confirm", ...opts })) !== null;
}

/** Ask for a line of text. Resolves the trimmed text, or null if cancelled or left empty. */
export async function promptDialog(opts: PromptOpts): Promise<string | null> {
  const v = await ask({ kind: "prompt", ...opts });
  return v?.trim() ? v.trim() : null;
}

/** Pick one of a list, with a filter box and arrow keys. Resolves the chosen value, or null. */
export async function chooseDialog(opts: ChooseOpts): Promise<string | null> {
  return ask({ kind: "choose", ...opts });
}

/** A short message at the bottom of the screen. `undo` adds an Undo button (principle 5). */
export function toast(text: string, opts: { undo?: () => unknown; action?: Toast["action"]; tone?: Toast["tone"] } = {}): void {
  const t: Toast = { id: ++seq, text, tone: opts.tone ?? "info", action: opts.undo ? { label: "Undo", run: opts.undo } : opts.action };
  toasts = [...toasts.slice(-2), t];
  emit();
  later(t);
}

// An Undo stays long enough to read the message and decide; any toast waits while the pointer is
// on it or focus is in it, and starts its time again on leaving.
const timers = new Map<number, ReturnType<typeof setTimeout>>();
const lifetime = (t: Toast) => (t.action ? 20_000 : t.tone === "error" ? 7000 : 4000);
function later(t: Toast) {
  clearTimeout(timers.get(t.id));
  timers.set(t.id, setTimeout(() => dismiss(t.id), lifetime(t)));
}
function hold(t: Toast) {
  clearTimeout(timers.get(t.id));
  timers.delete(t.id);
}

/** Show an error as a toast, in the server's plain words. */
export function toastError(err: unknown): void {
  toast(err instanceof Error ? err.message : String(err), { tone: "error" });
}

function dismiss(id: number) {
  clearTimeout(timers.get(id));
  timers.delete(id);
  if (!toasts.some((t) => t.id === id)) return;
  toasts = toasts.filter((t) => t.id !== id);
  emit();
}

const snapshot = () => ({ dialogs, toasts });
let last = snapshot();
const getSnapshot = () => (last.dialogs === dialogs && last.toasts === toasts ? last : (last = snapshot()));

/** Draws the open dialog, the toasts and any menu opened from code; mounted once, in App. */
export function Overlays() {
  const s = useSyncExternalStore(subscribe, getSnapshot);
  const top = s.dialogs[0];
  return (
    <>
      <MenuHost />
      {top && (top.dialog.kind === "choose" ? <ChooseView key={top.id} pending={top} opts={top.dialog} /> : <DialogView key={top.id} pending={top} />)}
      <div className="toasts" role="status" aria-live="polite">
        {s.toasts.map((t) => (
          <div
            key={t.id}
            className={`toast toast-${t.tone}`}
            onPointerEnter={() => hold(t)}
            onPointerLeave={(e) => !e.currentTarget.contains(document.activeElement) && later(t)}
            onFocus={() => hold(t)}
            onBlur={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && !e.currentTarget.matches(":hover") && later(t)}
          >
            <span className="toast-text">{t.text}</span>
            {t.action && (
              <button
                className="quiet toast-action"
                onClick={() => {
                  dismiss(t.id);
                  Promise.resolve()
                    .then(t.action!.run)
                    .catch(toastError);
                }}
              >
                {t.action.label}
              </button>
            )}
            <button className="quiet toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
              ×
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function ChooseView({ pending, opts }: { pending: Pending; opts: ChooseOpts }) {
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const list = useRef<HTMLUListElement>(null);
  const shown = useMemo(() => {
    if (!q.trim()) return opts.options;
    return opts.options
      .map((o) => ({ o, s: Math.max(fuzzyScore(q, o.label) + 50, fuzzyScore(q, `${o.hint ?? ""} ${o.label}`)) }))
      .filter((x) => x.s > -Infinity)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.o);
  }, [q, opts.options]);
  const choose = (o: Choice | undefined) => o && settle(pending.id, o.value);
  useEffect(() => {
    list.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  return (
    <Modal title={opts.title} onClose={() => settle(pending.id, null)} size="small">
      <div className="dialog choose">
        {opts.message && <p className="dialog-message">{opts.message}</p>}
        <input
          autoFocus
          value={q}
          placeholder={opts.placeholder ?? "Type to filter…"}
          onChange={(e) => (setQ(e.target.value), setSel(0))}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") (e.preventDefault(), setSel((s) => Math.min(s + 1, shown.length - 1)));
            else if (e.key === "ArrowUp") (e.preventDefault(), setSel((s) => Math.max(s - 1, 0)));
            else if (e.key === "Enter") (e.preventDefault(), choose(shown[sel]));
          }}
          aria-label="Filter"
          autoComplete="off"
          spellCheck={false}
          data-dialog-input
        />
        <ul className="choose-list" ref={list} role="listbox">
          {shown.map((o, i) => (
            <li key={o.value} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onMouseEnter={() => setSel(i)} onClick={() => choose(o)}>
              {o.icon && <Icon name={o.icon} size={16} />}
              {o.swatch && <span className={`swatch-dot ${o.swatch}`} aria-hidden="true">{o.swatch.startsWith("tc-") ? "A" : ""}</span>}
              <span className="choose-label">{o.label}</span>
              {o.hint && <small>{o.hint}</small>}
            </li>
          ))}
          {shown.length === 0 && <li className="muted choose-empty">{opts.empty ?? "Nothing matches"}</li>}
        </ul>
      </div>
    </Modal>
  );
}

function DialogView({ pending }: { pending: Pending }) {
  const d = pending.dialog as ({ kind: "confirm" } & ConfirmOpts) | ({ kind: "prompt" } & PromptOpts);
  const [value, setValue] = useState(d.kind === "prompt" ? (d.value ?? "") : "");
  const input = useRef<HTMLInputElement>(null);
  const cancelBtn = useRef<HTMLButtonElement>(null);
  const actionBtn = useRef<HTMLButtonElement>(null);
  const cancel = () => settle(pending.id, null);
  const blocked = d.kind === "prompt" && (d.mustMatch !== undefined ? value.trim() !== d.mustMatch : !d.optional && !value.trim());
  const submit = () => !blocked && settle(pending.id, d.kind === "prompt" ? value : "yes");

  useEffect(() => {
    if (d.kind === "prompt") d.input === "date" ? input.current?.focus() : input.current?.select();
    // A destructive choice is never the default: Enter on its own shouldn't delete.
    else (d.danger ? cancelBtn : actionBtn).current?.focus();
  }, []);

  return (
    <Modal title={d.title} onClose={cancel} size="small">
      <form
        className="dialog"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {d.message && <p className="dialog-message">{d.message}</p>}
        {d.kind === "prompt" && (
          <label className="field">
            {d.label && <span className="field-label">{d.label}</span>}
            <input ref={input} type={d.input ?? "text"} value={value} placeholder={d.placeholder} onChange={(e) => setValue(e.target.value)} autoComplete={d.input === "password" ? "current-password" : "off"} spellCheck={false} data-dialog-input />
          </label>
        )}
        <div className="dialog-actions">
          <button type="button" ref={cancelBtn} onClick={cancel}>
            Cancel
          </button>
          <button type="submit" ref={actionBtn} className={`primary${d.danger ? " danger" : ""}`} disabled={blocked} data-dialog-action>
            {d.action}
          </button>
        </div>
      </form>
    </Modal>
  );
}
