// Notes inside notes (F2) and link cards (F16 step 5), for reading view and Live Preview alike.
//
// `![[Note]]` shows that note, and `![[Note#Heading]]` just that section, in a framed box with a
// link to open it; embeds inside embeds work three deep, and a note that would show itself again
// says so instead of looping. A `[[link]]` on a line of its own to a typed note becomes a card:
// the type's icon and colour, the title, and the first few of its properties that have values.
//
// The renderer leaves placeholders (`.note-embed[data-embed]`, `.link-card[data-card]`); hydrate()
// fills them in, fetching notes as needed (cached, and refetched when a note changes).

import { parseFrontmatter, sectionRange } from "../../src/markdown";
import { linkTargets } from "../../src/types";
import { api, type Note, type NoteSummary } from "./api";
import { resolveLocal } from "./links";
import { fillDataview } from "./dataview";
import { fillDataviewJs } from "./dataviewjs";
import { drawDiagrams } from "./mermaid";
import { renderMarkdown } from "./render";
import { typeNamed } from "./types";
import { iconElement } from "../ui/Icon";

export const MAX_DEPTH = 3;

export interface EmbedCtx {
  vaultId: number;
  notes: NoteSummary[];
  /** Notes already being shown on the way down (the open note first): a repeat is a loop. */
  ancestors: number[];
  onOpen: (target: string) => void;
}

const cache = new Map<string, Promise<Note>>();

/** A note, fetched once per version: its id and when it last changed. */
function fetchNote(vaultId: number, n: NoteSummary): Promise<Note> {
  const key = `${vaultId}:${n.id}:${n.updated_at}`;
  let p = cache.get(key);
  if (!p) {
    p = api<Note>(`/vaults/${vaultId}/notes/${n.id}`);
    p.catch(() => cache.delete(key));
    cache.set(key, p);
    if (cache.size > 300) cache.delete(cache.keys().next().value!);
  }
  return p;
}

const el = (tag: string, cls: string, text?: string) => {
  const e = document.createElement(tag);
  e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

function openLink(target: string, label: string, ctx: EmbedCtx, cls = "internal-link") {
  const a = el("a", cls, label) as HTMLAnchorElement;
  a.dataset.target = target;
  const hit = resolveLocal(ctx.notes, target);
  a.href = hit ? `/v/${ctx.vaultId}/n/${hit.id}` : "#";
  a.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.onOpen(target);
  };
  return a;
}

/** Fill every embed and card placeholder under `root`. */
export function hydrate(root: HTMLElement, ctx: EmbedCtx): void {
  for (const box of root.querySelectorAll<HTMLElement>(".note-embed[data-embed]:not([data-done])")) {
    box.dataset.done = "1";
    void fillEmbed(box, box.dataset.embed!, ctx);
  }
  for (const card of root.querySelectorAll<HTMLElement>(".link-card[data-card]:not([data-done])")) {
    card.dataset.done = "1";
    void fillCard(card, card.dataset.card!, ctx);
  }
  for (const card of root.querySelectorAll<HTMLElement>(".web-card[data-url]:not([data-done])")) {
    card.dataset.done = "1";
    void fillWebCard(card, card.dataset.url!, ctx.vaultId);
  }
  drawDiagrams(root, ctx.onOpen);
  const dv = { vaultId: ctx.vaultId, noteId: ctx.ancestors.at(-1) ?? null, notes: () => ctx.notes, onOpen: ctx.onOpen };
  fillDataview(root, dv);
  fillDataviewJs(root, dv);
}

/** One embed: a header linking to the note, then its content (or its section), rendered. */
export async function fillEmbed(box: HTMLElement, target: string, ctx: EmbedCtx): Promise<void> {
  const [name, heading] = target.split("#") as [string, string | undefined];
  const hit = resolveLocal(ctx.notes, name);
  box.replaceChildren();
  box.classList.add("note-embed");
  const head = el("div", "note-embed-head");
  head.append(openLink(target, heading && !heading.startsWith("^") ? `${hit?.title ?? name} › ${heading}` : (hit?.title ?? name), ctx, "internal-link note-embed-title"));
  box.append(head);
  if (!hit) {
    box.append(el("p", "note-embed-missing", `“${name}” doesn't exist yet.`));
    return;
  }
  if (ctx.ancestors.includes(hit.id)) {
    box.append(el("p", "note-embed-missing", "Already shown above, so not again here."));
    return;
  }
  if (ctx.ancestors.length >= MAX_DEPTH + 1) {
    box.append(el("p", "note-embed-missing", "Embedded too deep to show here; open it to read."));
    return;
  }
  const body = el("div", "note-embed-body markdown");
  body.append(el("p", "muted", "…"));
  box.append(body);
  let note: Note;
  try {
    note = await fetchNote(ctx.vaultId, hit);
  } catch {
    body.replaceChildren(el("p", "note-embed-missing", "Couldn't load it."));
    return;
  }
  let md = parseFrontmatter(note.content).body;
  if (heading && !heading.startsWith("^")) {
    const r = sectionRange(md, heading);
    if (!r) {
      body.replaceChildren(el("p", "note-embed-missing", `No heading “${heading}” in ${note.title}.`));
      return;
    }
    md = md.slice(r.from, r.to);
  }
  body.innerHTML = renderMarkdown(md, ctx.vaultId, ctx.notes); // sanitised by renderMarkdown
  body.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>("a.internal-link");
    if (a?.dataset.target) {
      e.preventDefault();
      e.stopPropagation();
      ctx.onOpen(a.dataset.target);
    }
  });
  // Tasks in an embed are shown, not ticked: tick them in their own note.
  for (const box of body.querySelectorAll<HTMLInputElement>("input.task")) box.disabled = true;
  hydrate(body, { ...ctx, ancestors: [...ctx.ancestors, hit.id] });
}

/** A link card, if the note has a type that shows cards; otherwise the plain link stays. */
export async function fillCard(card: HTMLElement, target: string, ctx: EmbedCtx): Promise<void> {
  const hit = resolveLocal(ctx.notes, target.split("#")[0]!);
  const type = typeNamed(hit?.type);
  if (!hit || !type || !type.cards) return; // keep the plain link already inside
  let note: Note;
  try {
    note = await fetchNote(ctx.vaultId, hit);
  } catch {
    return;
  }
  const fm = (note.frontmatter ?? {}) as Record<string, unknown>;
  const shown = type.properties
    .map((p) => {
      const v = fm[p.name];
      if (v === null || v === undefined || v === "" || (Array.isArray(v) && !v.length) || v === false) return null;
      const text = p.kind === "relation" ? linkTargets(v).join(", ") : Array.isArray(v) ? v.join(", ") : v === true ? "✓" : String(v);
      return text ? [p.name, text] : null;
    })
    .filter(Boolean)
    .slice(0, 3) as [string, string][];
  const box = el("a", `link-card-box colour-${type.colour}`) as HTMLAnchorElement;
  box.href = `/v/${ctx.vaultId}/n/${hit.id}`;
  box.dataset.target = target;
  box.onclick = (e) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.onOpen(target);
  };
  const icon = el("span", "link-card-icon");
  const svg = iconElement(type.icon, 18);
  if (svg) icon.append(svg);
  const main = el("span", "link-card-main");
  main.append(el("span", "link-card-title", hit.title), el("span", "link-card-type", type.name));
  const props = el("span", "link-card-props");
  for (const [k, v] of shown) {
    const item = el("span", "link-card-prop");
    item.append(el("small", "", k), document.createTextNode(` ${v}`));
    props.append(item);
  }
  box.append(icon, main, props);
  card.replaceChildren(box);
  card.classList.add("is-card");
}

// ── Link cards for web addresses (F28) ───────────────────────────────────────────────────────

interface PageMeta {
  title: string;
  description: string;
  site: string;
  image: string | null;
  url: string;
}
const pages = new Map<string, Promise<PageMeta | null>>();

/** A web address alone on its line, as a card: the page's picture, title, summary and site. If
 *  the page can't be read (offline, the standalone file), the plain link inside stays. */
export async function fillWebCard(box: HTMLElement, url: string, vaultId: number): Promise<void> {
  const key = `${vaultId} ${url}`;
  if (!pages.has(key)) pages.set(key, api<PageMeta>(`/vaults/${vaultId}/linkcard?url=${encodeURIComponent(url)}`).catch(() => null));
  const meta = await pages.get(key)!;
  if (!meta?.title) {
    pages.delete(key); // try again next time
    return;
  }
  const a = document.createElement("a");
  a.className = "web-card-link";
  a.href = /^https?:/i.test(url) ? url : "#";
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  if (meta.image && /^https:/i.test(meta.image)) {
    const img = document.createElement("img");
    img.src = meta.image;
    img.alt = "";
    img.loading = "lazy";
    img.referrerPolicy = "no-referrer";
    img.onerror = () => img.remove();
    a.append(img);
  }
  const text = el("span", "web-card-text");
  text.append(el("strong", "web-card-title", meta.title));
  if (meta.description) text.append(el("span", "web-card-desc", meta.description));
  text.append(el("small", "web-card-site", meta.site));
  a.append(text);
  box.replaceChildren(a);
  box.classList.add("filled");
}
