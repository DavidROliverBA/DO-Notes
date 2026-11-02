// Hover preview: rest the pointer on a [[link]] for half a second to see the start of the note
// (or of the heading's section, for [[Note#Heading]]) without leaving this one. The editor shows
// it as a CodeMirror tooltip (Editor.tsx); reading view uses attachHoverPreviews below. Laptops
// only: a phone has no hover. The text is rendered like reading view (sanitised), without
// running embeds or queries.

import { parseFrontmatter, sectionRange } from "../../src/markdown";
import { api, type NoteSummary } from "./api";
import { resolveLocal } from "./links";
import { renderMarkdown } from "./render";

const HOVER_MS = 500;
const MAX_CHARS = 1500;

const texts = new Map<number, { at: number; md: Promise<string | null> }>();
function noteText(vaultId: number, id: number): Promise<string | null> {
  const hit = texts.get(id);
  if (hit && Date.now() - hit.at < 30_000) return hit.md;
  const md = api<{ content: string }>(`/vaults/${vaultId}/notes/${id}`).then(
    (n) => n.content,
    () => null,
  );
  texts.set(id, { at: Date.now(), md });
  return md;
}

/** The first part of some markdown, cut at a paragraph (or line) near MAX_CHARS. */
function opening(md: string): { text: string; more: boolean } {
  if (md.length <= MAX_CHARS) return { text: md, more: false };
  const cut = md.lastIndexOf("\n\n", MAX_CHARS);
  const at = cut > MAX_CHARS / 3 ? cut : Math.max(md.lastIndexOf("\n", MAX_CHARS), MAX_CHARS / 2);
  return { text: md.slice(0, at), more: true };
}

/** The preview's contents for a link target, or null for a note that doesn't exist (yet). */
export async function previewContent(vaultId: number, notes: NoteSummary[], target: string, signal?: { cancelled: boolean }): Promise<HTMLElement | null> {
  const [name, heading] = target.split("#");
  const n = resolveLocal(notes, name!.trim());
  if (!n) return null;
  const md = await noteText(vaultId, n.id);
  if (md === null || signal?.cancelled) return null;
  let { body } = parseFrontmatter(md);
  if (heading?.trim()) {
    const r = sectionRange(body, heading);
    if (r) body = body.slice(r.from, r.to);
  }
  // The title is already at the top of the card: not again as the note's (or section's) heading.
  body = body.replace(/^\s*#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*(?:\n|$)/, (line, text: string) =>
    [n.title, heading?.trim()].some((t) => t && t.toLowerCase() === text.trim().toLowerCase()) ? "" : line,
  );
  const { text, more } = opening(body.trim());
  const box = document.createElement("div");
  box.className = "hover-preview-body";
  const title = box.appendChild(document.createElement("div"));
  title.className = "hover-preview-title";
  title.textContent = heading?.trim() ? `${n.title} › ${heading.trim()}` : n.title;
  const page = box.appendChild(document.createElement("div"));
  page.className = "markdown hover-preview-text";
  // renderMarkdown sanitises (DOMPurify), as in reading view.
  page.innerHTML = text ? renderMarkdown(text, vaultId, notes) : `<p class="muted">Nothing written yet.</p>`;
  if (more) page.insertAdjacentHTML("beforeend", `<p class="hover-preview-more">…</p>`);
  return box;
}

/** Hover previews for the links in rendered markdown (reading view). Returns a cleanup. */
export function attachHoverPreviews(root: HTMLElement, ctx: () => { vaultId: number; notes: NoteSummary[] }): () => void {
  if (!matchMedia("(hover: hover)").matches) return () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pop: HTMLElement | null = null;
  let link: HTMLElement | null = null;
  let signal = { cancelled: false };
  const close = () => {
    clearTimeout(timer);
    signal.cancelled = true;
    pop?.remove();
    pop = null;
    link = null;
  };
  const leaveSoon = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!pop?.matches(":hover") && !link?.matches(":hover")) close();
    }, 200);
  };
  const over = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>("a.internal-link:not(.unresolved)");
    if (!a || a === link) return;
    close();
    link = a;
    signal = { cancelled: false };
    const mine = signal;
    timer = setTimeout(async () => {
      const { vaultId, notes } = ctx();
      const body = await previewContent(vaultId, notes, a.dataset.target ?? "", mine);
      if (!body || mine.cancelled || !a.isConnected) return;
      pop = document.createElement("div");
      pop.className = "hover-preview floating";
      pop.setAttribute("role", "tooltip");
      pop.appendChild(body);
      pop.addEventListener("mouseleave", leaveSoon);
      document.body.appendChild(pop);
      const r = a.getBoundingClientRect();
      const h = pop.offsetHeight;
      const below = r.bottom + 6 + h < innerHeight || r.top < h + 6;
      pop.style.left = `${Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8))}px`;
      pop.style.top = `${below ? r.bottom + 6 : r.top - h - 6}px`;
    }, HOVER_MS);
  };
  const out = (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest("a.internal-link") === link) leaveSoon();
  };
  const key = (e: KeyboardEvent) => e.key === "Escape" && close();
  root.addEventListener("mouseover", over);
  root.addEventListener("mouseout", out);
  root.addEventListener("scroll", close, true);
  document.addEventListener("keydown", key);
  return () => {
    close();
    root.removeEventListener("mouseover", over);
    root.removeEventListener("mouseout", out);
    root.removeEventListener("scroll", close, true);
    document.removeEventListener("keydown", key);
  };
}
