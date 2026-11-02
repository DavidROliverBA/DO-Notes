// The one menu: a popover by its button on a laptop, an action sheet from the bottom on a phone.
// Drawn in a portal so a scrolling sidebar can't clip it. Closes on a choice, Escape, or a tap
// outside; arrow keys move between items.

import { type ReactNode, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { useNarrow } from "../lib/useNarrow";
import { Icon } from "./Icon";

export interface MenuItem {
  label: string;
  icon?: string;
  onSelect?: () => void;
  /** A link instead of an action (downloads). */
  href?: string;
  /** The link opens in a new tab (another site). */
  external?: boolean;
  danger?: boolean;
  hidden?: boolean;
}

/** `items` may be a function, read each time the menu opens (for menus built from live state). */
/** `trigger` replaces the icon with your own content (a labelled chip); `className` styles it. */
export function Menu({ label, icon = "more", items, size, trigger, className }: { label: string; icon?: string; items: MenuItem[] | (() => MenuItem[]); size?: number; trigger?: ReactNode; className?: string }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const shown = open ? (typeof items === "function" ? items() : items) : [];

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`${className ?? "icon-btn"} menu-button${open ? " open" : ""}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {trigger ?? <Icon name={icon} size={size} />}
      </button>
      {open && button.current && (
        <MenuPopover
          label={label}
          items={shown}
          anchor={button.current}
          onClose={(refocus) => {
            setOpen(false);
            if (refocus) button.current?.focus();
          }}
        />
      )}
    </>
  );
}

/** The open menu itself, placed by `anchor`: under it (or above when there's no room), lined up
 *  with its right edge, or its left with `align: "left"`. */
export function MenuPopover({ label, items, anchor, align = "right", onClose }: { label: string; items: MenuItem[]; anchor: Element; align?: "left" | "right"; onClose: (refocus?: boolean) => void }) {
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right?: number; left?: number } | null>(null);
  const pop = useRef<HTMLDivElement>(null);
  const narrow = useNarrow();
  const shown = items.filter((i) => !i.hidden);
  const close = onClose;

  useLayoutEffect(() => {
    if (narrow) return;
    const r = anchor.getBoundingClientRect();
    const x = align === "left" ? { left: Math.max(8, r.left) } : { right: Math.max(8, innerWidth - r.right) };
    const below = innerHeight - r.bottom;
    const height = pop.current?.offsetHeight ?? 0;
    setPos(below < height + 16 && r.top > below ? { bottom: innerHeight - r.top + 4, ...x } : { top: r.bottom + 4, ...x });
  }, [narrow, anchor]);

  // Focus the first item once the menu shows: a popover is hidden until it's placed, and a
  // hidden item can't take focus.
  const placed = narrow || pos !== null;
  useEffect(() => {
    if (placed && !pop.current?.contains(document.activeElement)) pop.current?.querySelector<HTMLElement>(".menu-item")?.focus();
  }, [placed]);

  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!pop.current?.contains(t) && !anchor.contains(t)) close();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const all = [...(pop.current?.querySelectorAll<HTMLElement>(".menu-item") ?? [])];
        const i = all.indexOf(document.activeElement as HTMLElement);
        all[(i + (e.key === "ArrowDown" ? 1 : all.length - 1)) % all.length]?.focus();
      }
    };
    const scroll = (e: Event) => !pop.current?.contains(e.target as Node) && close();
    const resize = () => close();
    document.addEventListener("pointerdown", away, true);
    window.addEventListener("keydown", key, true);
    window.addEventListener("scroll", scroll, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", away, true);
      window.removeEventListener("keydown", key, true);
      window.removeEventListener("scroll", scroll, true);
      window.removeEventListener("resize", resize);
    };
  }, [anchor]);

  const list: ReactNode = shown.map((item) =>
    item.href ? (
      <a key={item.label} className={`menu-item${item.danger ? " danger" : ""}`} href={item.href} role="menuitem" onClick={() => close()} {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
        {item.icon && <Icon name={item.icon} />}
        {item.label}
      </a>
    ) : (
      <button
        key={item.label}
        type="button"
        className={`menu-item${item.danger ? " danger" : ""}`}
        role="menuitem"
        onClick={() => {
          close();
          item.onSelect?.();
        }}
      >
        {item.icon && <Icon name={item.icon} />}
        {item.label}
      </button>
    ),
  );

  return createPortal(
    // React events bubble out of portals to the button's ancestors (a tree row that toggles
    // or drags); stop them at the menu.
    <div className="menu-layer" onClick={(e) => e.stopPropagation()} onPointerDown={(e) => e.stopPropagation()}>
      {narrow ? (
        <div className="sheet-backdrop" onClick={(e) => e.target === e.currentTarget && close()}>
          <div ref={pop} className="menu sheet" role="menu" aria-label={label}>
            {list}
            <button type="button" className="menu-item menu-cancel" onClick={() => close(true)}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div ref={pop} className="menu popover" role="menu" aria-label={label} style={pos ?? { visibility: "hidden", top: 0, right: 0 }}>
          {list}
        </div>
      )}
    </div>,
    document.body,
  );
}

// A menu opened from code (the editor's block handle lives in CodeMirror, outside React):
// menuAt(el, label, items) shows it by `el`; <MenuHost /> (in <Overlays />) draws it.
type Floating = { id: number; anchor: Element; label: string; items: MenuItem[]; onClose?: (refocus: boolean) => void };
let floating: Floating | null = null;
let floatSeq = 0;
const floatListeners = new Set<() => void>();
const setFloating = (f: Floating | null) => ((floating = f), floatListeners.forEach((l) => l()));

/** Open a menu by `anchor`, lined up with its left edge; `onClose` runs however it closes. */
export function menuAt(anchor: Element, label: string, items: MenuItem[], onClose?: (refocus: boolean) => void): void {
  floating?.onClose?.(false);
  setFloating({ id: ++floatSeq, anchor, label, items, onClose });
}

export function MenuHost() {
  const f = useSyncExternalStore(
    (l) => (floatListeners.add(l), () => void floatListeners.delete(l)),
    () => floating,
  );
  if (!f) return null;
  return (
    <MenuPopover
      key={f.id}
      label={f.label}
      items={f.items}
      anchor={f.anchor}
      align="left"
      onClose={(refocus) => {
        if (floating?.id !== f.id) return;
        setFloating(null);
        f.onClose?.(!!refocus);
      }}
    />
  );
}
