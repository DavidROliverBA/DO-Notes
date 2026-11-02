// Markdown → sanitised HTML with extended Markdown: [[wikilinks]], ![[embeds]], #tags,
// ==highlights==, > [!callouts], ```mermaid diagrams, frontmatter properties, and clickable task
// checkboxes.

import DOMPurify from "dompurify";
import { Marked, type Tokens } from "marked";
import { STATUS_RE, statusColour, TOC_RE, tocHtml, WEB_LINE } from "../../src/blocks";
import { headings, isAttachmentPath, parseFrontmatter } from "../../src/markdown";
import type { NoteSummary } from "./api";
import { resolveLocal } from "./links";
import { colourOf, hiloColour } from "./colours";
import { diagramHtml } from "./mermaid";
import { codeBlockHtml } from "../../src/codeHighlight";
import { inlineQuery } from "../../src/dataview";

// Colours (F10): before attributes are checked, a span, mark or font's colour becomes a palette
// class or a cleaned style kept aside; after, only that cleaned style is put back. Every other
// style, on any element, is still dropped (FORBID_ATTR below).
// (Only in a browser: outside one DOMPurify is an empty factory, as in the unit tests.)
if (typeof DOMPurify.addHook === "function") {
DOMPurify.addHook("beforeSanitizeAttributes", (node) => {
  if (!(node instanceof Element) || !/^(span|mark|font)$/i.test(node.tagName)) return;
  const { classes, style } = colourOf(node.tagName, { style: node.getAttribute("style"), color: node.getAttribute("color"), class: node.getAttribute("class") });
  node.removeAttribute("color");
  if (classes.length) node.setAttribute("class", [...(node.getAttribute("class") ?? "").split(/\s+/).filter((c) => c && !/^hltr-/.test(c)), ...classes].join(" "));
  if (style) node.setAttribute("data-cp-colour", style);
});
DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (!(node instanceof Element) || !node.hasAttribute("data-cp-colour")) return;
  node.setAttribute("style", node.getAttribute("data-cp-colour")!);
  node.removeAttribute("data-cp-colour");
});
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/** decodeURIComponent throws on a stray "%" ("[x](100%)"); a note must never fail to render. */
const safeDecode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** Where an attachment in the vault is served from (src/api.ts, with nosniff and a sandboxing CSP). */
export function fileUrl(vaultId: number, path: string) {
  return `/api/vaults/${vaultId}/files?path=${encodeURIComponent(path)}`;
}

export function renderMarkdown(md: string, vaultId: number, notes: NoteSummary[]): string {
  const { data, body, raw } = parseFrontmatter(md);
  let taskIndex = 0;

  const marked = new Marked({ gfm: true, breaks: false });
  marked.use({
    extensions: [
      {
        name: "wikilink",
        level: "inline",
        start: (src: string) => src.match(/!?\[\[/)?.index,
        tokenizer(src: string) {
          const m = /^(!?)\[\[([^\[\]|\n]+?)(?:\\?\|([^\[\]\n]*))?\]\]/.exec(src);
          if (m) return { type: "wikilink", raw: m[0], embed: m[1] === "!", target: m[2]!.trim(), alias: m[3]?.trim() };
        },
        renderer(t: any) {
          const target: string = t.target;
          if (t.embed && isAttachmentPath(target)) {
            const path = target.split("#")[0]!;
            // Embeds are sized with ![[img.png|300]] or |300x200.
            const size = /^(\d+)(?:x(\d+))?$/.exec(t.alias ?? "");
            if (/\.(png|jpe?g|gif|webp|svg|bmp|avif|heic)$/i.test(path)) {
              return `<img src="${esc(fileUrl(vaultId, path))}" alt="${esc(size ? path : (t.alias ?? path))}" loading="lazy"${size ? ` width="${size[1]}"${size[2] ? ` height="${size[2]}"` : ""}` : ""}>`;
            }
            if (/\.(mp3|m4a|wav|ogg)$/i.test(path)) return `<audio controls src="${esc(fileUrl(vaultId, path))}"></audio>`;
            if (/\.(mp4|mov|webm)$/i.test(path)) return `<video controls src="${esc(fileUrl(vaultId, path))}"></video>`;
            return `<a href="${esc(fileUrl(vaultId, path))}" target="_blank" rel="noopener">📎 ${esc(path)}</a>`;
          }
          const hit = resolveLocal(notes, target);
          const label = t.alias || target.replace(/#\^?/, " › ");
          // ![[Note]]: a placeholder that web/lib/embeds.ts fills with the note itself (F2).
          if (t.embed) return `<span class="note-embed" data-embed="${esc(target)}"><a class="internal-link${hit ? "" : " unresolved"}" data-target="${esc(target)}" href="${hit ? `/v/${vaultId}/n/${hit.id}` : "#"}">↪ ${esc(label)}</a></span>`;
          const cls = `internal-link${hit ? "" : " unresolved"}${t.embed ? " embed-link" : ""}`;
          return `<a class="${cls}" data-target="${esc(target)}" href="${hit ? `/v/${vaultId}/n/${hit.id}` : "#"}">${t.embed ? "↪ " : ""}${esc(label)}</a>`;
        },
      },
      {
        name: "highlight",
        level: "inline",
        start: (src: string) => src.indexOf("=="),
        tokenizer(src: string) {
          const m = /^==(?=\S)([^=\n]+?)==/.exec(src);
          if (!m) return;
          // Hilo's =={red}text==: a coloured highlight.
          const hilo = hiloColour(m[1]!);
          return { type: "highlight", raw: m[0], colour: hilo?.name ?? null, tokens: this.lexer.inlineTokens(hilo ? hilo.text : m[1]!) };
        },
        renderer(t: any) {
          return `<mark${t.colour ? ` class="hl-${t.colour}"` : ""}>${this.parser.parseInline(t.tokens)}</mark>`;
        },
      },
      {
        // :status[Done]{.green}: a coloured label (F28).
        name: "status",
        level: "inline",
        start: (src: string) => src.indexOf(":status["),
        tokenizer(src: string) {
          const m = STATUS_RE.exec(src);
          if (m) return { type: "status", raw: m[0], label: m[1]!, colour: statusColour(m[2]) };
        },
        renderer(t: any) {
          return `<span class="status status-${t.colour}">${esc(t.label)}</span>`;
        },
      },
      {
        name: "tag",
        level: "inline",
        start: (src: string) => src.match(/(^|\s)#[\p{L}_\-/]/u)?.index,
        tokenizer(src: string) {
          const m = /^(\s?)#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/u.exec(src);
          if (m) return { type: "tag", raw: m[0], lead: m[1], tag: m[2] };
        },
        renderer(t: any) {
          return `${t.lead}<a class="tag" data-tag="${esc(t.tag.toLowerCase())}" href="#">#${esc(t.tag)}</a>`;
        },
      },
    ],
    renderer: {
      // ```mermaid: a placeholder holding the source, drawn by web/lib/mermaid.ts.
      code({ text, lang }: Tokens.Code) {
        const kind = lang?.trim().split(/\s/)[0]!.toLowerCase();
        if (kind === "mermaid") return diagramHtml(text, esc) + "\n";
        // ```dataview: a placeholder holding the query, run by web/lib/dataview.ts.
        if (kind === "dataview") return `<div class="dataview-block"><pre><code>${esc(text)}</code></pre></div>\n`;
        // ```dataviewjs: run in a sandboxed frame by web/lib/dataviewjs.ts.
        if (kind === "dataviewjs") return `<div class="dataviewjs-block"><pre><code>${esc(text)}</code></pre></div>\n`;
        return codeBlockHtml(text, lang, esc, true);
      },
      // `= expression` (and `$= dv.pages(…)…` in the form src/dataview.ts reads): its result.
      codespan({ text }: Tokens.Codespan) {
        const raw = text.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
        const expr = inlineQuery(raw);
        if (expr === null) return false;
        return `<span class="dataview-inline" data-dv-expr="${esc(expr)}"><code>${esc(raw)}</code></span>`;
      },
      // Clickable checkboxes, numbered in document order so a click can find its line.
      checkbox({ checked }: Tokens.Checkbox) {
        return `<input type="checkbox" class="task" data-task="${taskIndex++}"${checked ? " checked" : ""}> `;
      },
      link({ href, title, tokens }: Tokens.Link) {
        const text = this.parser.parseInline(tokens);
        if (/^[a-z][a-z0-9+.-]*:/i.test(href)) return `<a href="${esc(href)}"${title ? ` title="${esc(title)}"` : ""} target="_blank" rel="noopener noreferrer">${text}</a>`;
        if (href.startsWith("#")) return `<a href="${esc(href)}">${text}</a>`;
        if (isAttachmentPath(href)) return `<a href="${esc(fileUrl(vaultId, safeDecode(href)))}" target="_blank" rel="noopener">${text}</a>`;
        const hit = resolveLocal(notes, href);
        return `<a class="internal-link${hit ? "" : " unresolved"}" data-target="${esc(safeDecode(href))}" href="${hit ? `/v/${vaultId}/n/${hit.id}` : "#"}">${text}</a>`;
      },
      image({ href, title, text }: Tokens.Image) {
        const src = /^([a-z]+:|\/\/)/i.test(href) ? href : fileUrl(vaultId, safeDecode(href));
        return `<img src="${esc(src)}" alt="${esc(text)}"${title ? ` title="${esc(title)}"` : ""} loading="lazy">`;
      },
      // A [[link]] alone in its paragraph may become a link card (F16 step 5), if its note's type
      // shows cards; the plain link stays inside as the fallback.
      paragraph({ tokens, raw }: Tokens.Paragraph) {
        // [TOC] alone: the note's headings (F28); NoteView scrolls to the one clicked.
        if (TOC_RE.test(raw)) return tocHtml(headings(body), () => "#", esc) + "\n";
        const inner = this.parser.parseInline(tokens);
        // A web address alone: a card (F28), filled by web/lib/embeds.ts; the link stays inside.
        const url = WEB_LINE.exec(raw)?.[1];
        if (url) return `<div class="web-card" data-url="${esc(url)}"><p>${inner}</p></div>\n`;
        const only = tokens.filter((x) => !(x.type === "text" && !x.raw.trim()));
        if (only.length === 1 && (only[0] as any).type === "wikilink" && !(only[0] as any).embed) {
          return `<div class="link-card" data-card="${esc((only[0] as any).target)}"><p>${inner}</p></div>\n`;
        }
        return `<p>${inner}</p>\n`;
      },
      blockquote({ tokens }: Tokens.Blockquote) {
        const inner = this.parser.parse(tokens);
        // > [!type] Optional title    (callouts; [!type]- folds closed, [!type]+ open)
        const m = /^<p>\[!([\w-]+)\]([+-]?)[ \t]*([^\n<]*)(?:\n|<br>)?/i.exec(inner);
        if (!m) return `<blockquote>${inner}</blockquote>`;
        const type = m[1]!.toLowerCase();
        const title = m[3]!.trim() || type[0]!.toUpperCase() + type.slice(1);
        let rest = inner.slice(m[0].length);
        rest = /^\s*<\/p>/.test(rest) ? rest.replace(/^\s*<\/p>/, "") : `<p>${rest}`;
        // [!type]- folds closed and [!type]+ open (F28's Expand), with no script: <details>.
        if (m[2]) return `<details class="callout" data-callout="${esc(type)}"${m[2] === "+" ? " open" : ""}><summary class="callout-title">${esc(title)}</summary><div class="callout-body">${rest}</div></details>`;
        return `<div class="callout" data-callout="${esc(type)}"><div class="callout-title">${esc(title)}</div><div class="callout-body">${rest}</div></div>`;
      },
    },
  });

  let html = "";
  if (raw.trim()) {
    // A note's AI-XF id (F9) is for links and bundles, not reading: it isn't shown.
    const rows = Object.entries(data)
      .filter(([k]) => k !== "id")
      .map(([k, v]) => {
        const val = Array.isArray(v) ? v.map((x) => `<span class="pill">${esc(String(x))}</span>`).join(" ") : esc(v instanceof Date ? v.toISOString().slice(0, 10) : typeof v === "object" ? JSON.stringify(v) : String(v));
        return `<tr><th>${esc(k)}</th><td>${val}</td></tr>`;
      })
      .join("");
    html += rows ? `<table class="properties">${rows}</table>` : "";
  }
  html += marked.parse(body, { async: false }) as string;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ["target", "data-heading", "data-url", "data-target", "data-tag", "data-task", "data-callout", "loading", "data-cp-colour", "data-dv-expr"],
    ADD_TAGS: ["audio", "video"],
    // A note must not be able to restyle or overlay the app for other members.
    FORBID_TAGS: ["style", "form"],
    FORBID_ATTR: ["style"],
  });
}

/** Flip the n-th task checkbox (document order, skipping code) in the markdown source. */
export function toggleTask(md: string, index: number): string | null {
  const lines = md.split("\n");
  let n = -1;
  let fence: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const f = /^\s*(```|~~~)/.exec(line);
    if (f) {
      fence = fence === null ? f[1]! : fence === f[1] ? null : fence;
      continue;
    }
    if (fence) continue;
    const m = /^(\s*(?:[-*+]|\d+[.)])\s+\[)([ xX])(\].*)$/.exec(line);
    if (m && ++n === index) {
      lines[i] = m[1] + (m[2] === " " ? "x" : " ") + m[3];
      return lines.join("\n");
    }
  }
  return null;
}
