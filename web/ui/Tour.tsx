// The guided tour's overlay (steps and state in web/lib/tour.ts): the screen dimmed except for a
// window round the step's target, and a card beside it with the words, "3 of 12", Back, Next
// and Skip. A step whose target isn't on screen gets its card in the middle. On a phone the card
// sits at the bottom, or the top when the target is low. Escape ends it, ←/→ move. Mounted once,
// in App.

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { endTour, goTo, type TourStep, useTour } from "../lib/tour";

const PAD = 6;
const GAP = 12;

/** **bold** and `code` in a step's words, escaped first. */
function inline(text: string): string {
  const esc = text.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
  return esc.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>").replace(/`(.+?)`/g, "<code>$1</code>");
}

function findTarget(step: TourStep): HTMLElement | null {
  if (!step.target) return null;
  for (const el of document.querySelectorAll<HTMLElement>(step.target)) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden") return el;
  }
  return null;
}

export function Tour() {
  const run = useTour();
  const [target, setTarget] = useState<{ el: HTMLElement | null; at: number } | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const step = run?.steps[run.at];

  // Each step: do what it needs first (open a note, a panel), then wait briefly for its target.
  useEffect(() => {
    if (!run || !step) return;
    let live = true;
    setTarget(null);
    setPos(null);
    void (async () => {
      try {
        await step.before?.(run.env);
      } catch {}
      let el: HTMLElement | null = null;
      for (let i = 0; i < 30 && live && !(el = findTarget(step)) && step.target; i++) await new Promise((r) => setTimeout(r, 70));
      if (!live) return;
      el?.scrollIntoView({ block: "nearest", inline: "nearest" });
      setTarget({ el, at: run.at });
    })();
    return () => {
      live = false;
    };
  }, [run?.at, run?.steps]);

  // Follow the target as the page moves.
  useEffect(() => {
    if (!target?.el) return setRect(null);
    const el = target.el;
    const measure = () => setRect(el.isConnected ? el.getBoundingClientRect() : null);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    addEventListener("resize", measure);
    addEventListener("scroll", measure, true);
    return () => {
      ro.disconnect();
      removeEventListener("resize", measure);
      removeEventListener("scroll", measure, true);
    };
  }, [target]);

  // The card: below the target if it fits, else above, else beside; in the middle with none.
  useLayoutEffect(() => {
    const c = card.current;
    if (!c || !target) return;
    const w = c.offsetWidth;
    const h = c.offsetHeight;
    const vw = innerWidth;
    const vh = innerHeight;
    if (!rect) return setPos({ left: (vw - w) / 2, top: Math.max(16, (vh - h) / 2) });
    if (vw < 600) {
      const low = rect.top + rect.height / 2 > vh / 2;
      return setPos({ left: (vw - w) / 2, top: low ? Math.max(12, rect.top - PAD - GAP - h) : Math.min(vh - h - 12, rect.bottom + PAD + GAP) });
    }
    const left = Math.min(Math.max(16, rect.left), vw - w - 16);
    if (rect.bottom + PAD + GAP + h < vh - 8) return setPos({ left, top: rect.bottom + PAD + GAP });
    if (rect.top - PAD - GAP - h > 8) return setPos({ left, top: rect.top - PAD - GAP - h });
    const side = rect.right + PAD + GAP + w < vw - 8 ? rect.right + PAD + GAP : Math.max(16, rect.left - PAD - GAP - w);
    setPos({ left: side, top: Math.min(Math.max(16, rect.top), vh - h - 16) });
  }, [rect, target, run?.at]);

  // Keys: Escape ends, arrows move; focus goes to the card so a screen reader reads the step.
  useEffect(() => {
    if (!run) return;
    const on = (e: KeyboardEvent) => {
      if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), endTour());
      else if (e.key === "ArrowRight") (e.preventDefault(), goTo(run.at + 1));
      else if (e.key === "ArrowLeft") (e.preventDefault(), goTo(run.at - 1));
    };
    addEventListener("keydown", on, true);
    return () => removeEventListener("keydown", on, true);
  }, [run?.at]);
  useEffect(() => {
    if (target) card.current?.querySelector<HTMLButtonElement>(".tour-next")?.focus({ preventScroll: true });
  }, [target]);

  if (!run || !step) return null;
  const last = run.at === run.steps.length - 1;
  return (
    <div className="tour" data-step={step.id}>
      {/* Clicks on the dimmed page do nothing: the tour is explained, not a trap; Skip ends it. */}
      <div className="tour-block" />
      {rect ? (
        <div className="tour-spot" style={{ left: rect.left - PAD, top: rect.top - PAD, width: rect.width + PAD * 2, height: rect.height + PAD * 2 }} />
      ) : (
        <div className="tour-dim" />
      )}
      <div
        ref={card}
        className="tour-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tour-title"
        aria-describedby="tour-body"
        style={pos ? { left: pos.left, top: pos.top } : { visibility: "hidden" }}
      >
        <div className="tour-count">
          {run.at + 1} of {run.steps.length}
        </div>
        <h2 id="tour-title" className="tour-title">
          {step.title}
        </h2>
        <p id="tour-body" className="tour-body" dangerouslySetInnerHTML={{ __html: inline(step.body) }} />
        <div className="tour-actions">
          <button type="button" className="quiet tour-skip" onClick={endTour}>
            {last ? "Close" : "Skip"}
          </button>
          <span className="tour-gap" />
          {run.at > 0 && (
            <button type="button" className="tour-back" onClick={() => goTo(run.at - 1)}>
              Back
            </button>
          )}
          <button type="button" className="primary tour-next" onClick={() => goTo(run.at + 1)}>
            {last ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>
  );
}
