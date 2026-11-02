// Writing blocks from Confluence (F28), shared by reading view, Live Preview and published sites.
// Each is plain Markdown another editor shows sensibly as text:
//
//   :status[In progress]{.amber}   a coloured label (the generic directive syntax)
//   [TOC]                          on a line of its own: the note's headings, as links
//   https://example.com/page       on a line of its own: a card with the page's title and picture
//
// Shared with the browser: keep it free of server imports.

import type { Heading } from "./markdown";

export const STATUS_COLOURS = ["grey", "blue", "green", "amber", "red", "purple"] as const;
export type StatusColour = (typeof STATUS_COLOURS)[number];

/** `:status[Label]{.colour}` at the start of `src`; the colour is optional (grey). */
export const STATUS_RE = /^:status\[([^\[\]\n]{1,40})\](?:\{\.([a-z]+)\})?/;
/** The same, anywhere in a line. */
export const STATUS_ALL = /:status\[([^\[\]\n]{1,40})\](?:\{\.([a-z]+)\})?/g;

export function statusColour(c: string | undefined): StatusColour {
  return STATUS_COLOURS.includes(c as StatusColour) ? (c as StatusColour) : "grey";
}

export function statusMarkdown(label: string, colour: StatusColour): string {
  return `:status[${label.replace(/[\[\]\n]/g, "").slice(0, 40)}]${colour === "grey" ? "" : `{.${colour}}`}`;
}

/** A paragraph that is only `[TOC]` (or `[toc]`) is a table of contents. */
export const TOC_RE = /^\s*\[toc\]\s*$/i;

/** The table of contents' HTML: a nested-looking list of the headings below the title. `href`
 *  gives each one's link. Headings deeper than three levels below the top one are left out. */
export function tocHtml(hs: Heading[], href: (h: Heading, i: number) => string, esc: (s: string) => string): string {
  const shown = hs.length > 1 && hs[0]!.level === 1 && !hs.slice(1).some((h) => h.level === 1) ? hs.slice(1) : hs;
  if (!shown.length) return `<nav class="toc" aria-label="Contents"><p class="toc-empty">No headings yet.</p></nav>`;
  const top = Math.min(...shown.map((h) => h.level));
  const items = shown
    .filter((h) => h.level - top < 3)
    .map((h) => `<li class="toc-l${h.level - top}"><a class="toc-link" href="${esc(href(h, hs.indexOf(h)))}" data-heading="${hs.indexOf(h)}">${esc(h.text)}</a></li>`)
    .join("");
  return `<nav class="toc" aria-label="Contents"><ul>${items}</ul></nav>`;
}

/** A line that is only a web address (bare or in <>): a link card. */
export const WEB_LINE = /^\s*<?(https?:\/\/[^\s<>]+?)>?\s*$/i;
