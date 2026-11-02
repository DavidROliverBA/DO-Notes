// The help (web/lib/help.ts, docs/help/*.md), laid out like Settings: the topics beside the open
// page on a laptop; on the iPhone the topics first and a page in their place, with a way back.
// Pages are drawn by the note renderer, so they look like notes, with diagrams drawn by Mermaid.
// Shared by the app and the standalone file. Opened by openHelp().

import { useEffect, useMemo, useRef, useState } from "react";
import { closeHelp, HELP_PAGES, helpMarkdown, helpPageFor, helpTour, useHelp } from "../lib/help";
import { drawDiagrams } from "../lib/mermaid";
import { renderMarkdown } from "../lib/render";
import { useNarrow } from "../lib/useNarrow";
import { Icon } from "../ui/Icon";
import { Modal } from "../ui/Modal";

/** Mounted once; shows the help whenever openHelp() has opened it. */
export function HelpHost() {
  const open = useHelp();
  if (!open) return null;
  return <Help initial={open} />;
}

function Help({ initial }: { initial: string }) {
  const narrow = useNarrow();
  // The guided tour, where the app has one (not the standalone file).
  const tour = helpTour;
  // On a phone, opening the help at its start shows the list of topics.
  const [page, setPage] = useState<string | null>(narrow && initial === "index" ? null : initial);
  useEffect(() => void (initial !== "index" && setPage(initial)), [initial]);
  const shown = HELP_PAGES.find((p) => p.id === page) ?? (narrow ? null : HELP_PAGES[0]!);

  const body = useRef<HTMLDivElement>(null);
  const html = useMemo(() => (shown ? renderMarkdown(helpMarkdown(shown), 0, []) : ""), [shown]);
  useEffect(() => {
    const el = body.current;
    if (!el) return;
    el.innerHTML = html;
    // A link to a page this build doesn't have (an app page, in the standalone file) is plain words.
    // The renderer marks them unresolved, having no notes to look in.
    for (const a of el.querySelectorAll<HTMLAnchorElement>("a.internal-link")) {
      if (helpPageFor(a.dataset.target ?? "")) a.classList.remove("unresolved");
      else a.replaceWith(...a.childNodes);
    }
    drawDiagrams(el);
    el.closest(".modal-body")?.scrollTo(0, 0);
  }, [html]);

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
    if (!a) return;
    e.preventDefault();
    const to = helpPageFor(a.dataset.target ?? "");
    if (to) setPage(to.id);
  };

  return (
    <Modal title={narrow && shown ? shown.title : "Help"} onClose={closeHelp} size="wide">
      <div className={`settings help${shown ? " has-section" : ""}`}>
        <nav className="settings-nav help-nav" aria-label="Help topics">
          {tour && (
            <div className="help-tour">
              <button className="primary" onClick={() => (closeHelp(), requestAnimationFrame(tour.tour))}>
                <Icon name="lightbulb" size={16} /> Take the tour
              </button>
              <button onClick={() => (closeHelp(), requestAnimationFrame(tour.whatsNew))}>
                <Icon name="sparkle" size={16} /> What's new
              </button>
            </div>
          )}
          {HELP_PAGES.map((p) => (
            <button key={p.id} className={shown?.id === p.id ? "on" : ""} aria-current={shown?.id === p.id ? "page" : undefined} onClick={() => setPage(p.id)}>
              <span className="settings-nav-text">{p.title}</span>
              <span className="only-narrow">
                <Icon name="chevron" size={16} />
              </span>
            </button>
          ))}
        </nav>
        {shown && (
          <div className="settings-pane">
            <button className="quiet settings-back only-narrow" onClick={() => setPage(null)}>
              <Icon name="chevron-left" size={16} /> Help
            </button>
            <article ref={body} className="markdown help-page" onClick={onClick} />
          </div>
        )}
      </div>
    </Modal>
  );
}
