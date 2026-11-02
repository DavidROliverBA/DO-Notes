// The help (docs/help/*.md): the same Markdown pages in the app, the standalone file and on GitHub.
// Each page's frontmatter has its title, and `standalone: true` when it belongs in the standalone
// file too. Pictures are `images/<name>.webp` beside the pages; `helpImageUrl` says where they're
// served from (the server's /help/images/ in the app; inside the file in the standalone build).
// Opened by openHelp(); module state, like Settings, so commands outside React can open it.

import { useSyncExternalStore } from "react";
import { parseFrontmatter } from "../../src/markdown";
import home from "../../docs/help/index.md" with { type: "text" };
import gettingStarted from "../../docs/help/getting-started.md" with { type: "text" };
import collections from "../../docs/help/collections.md" with { type: "text" };
import writing from "../../docs/help/writing.md" with { type: "text" };
import links from "../../docs/help/links.md" with { type: "text" };
import graph from "../../docs/help/graph.md" with { type: "text" };
import organising from "../../docs/help/organising.md" with { type: "text" };
import types from "../../docs/help/types.md" with { type: "text" };
import tasks from "../../docs/help/tasks.md" with { type: "text" };
import journal from "../../docs/help/journal.md" with { type: "text" };
import search from "../../docs/help/search.md" with { type: "text" };
import queries from "../../docs/help/queries.md" with { type: "text" };
import sharing from "../../docs/help/sharing.md" with { type: "text" };
import ai from "../../docs/help/ai.md" with { type: "text" };
import website from "../../docs/help/website.md" with { type: "text" };
import macFolders from "../../docs/help/mac-folders.md" with { type: "text" };
import macApp from "../../docs/help/mac-app.md" with { type: "text" };
import boards from "../../docs/help/boards.md" with { type: "text" };
import importExport from "../../docs/help/import-export.md" with { type: "text" };
import iphone from "../../docs/help/iphone.md" with { type: "text" };
import standalone from "../../docs/help/standalone.md" with { type: "text" };
import shortcuts from "../../docs/help/shortcuts.md" with { type: "text" };
import settings from "../../docs/help/settings.md" with { type: "text" };
import { HELP_STANDALONE, helpImageUrl } from "./helpImages";

export interface HelpPage {
  /** The file's name without .md: "links". */
  id: string;
  title: string;
  /** In the standalone file's help too. */
  standalone: boolean;
  /** The Markdown, without its frontmatter. */
  body: string;
}

/** Every page, in the order the help lists them. */
export const ALL_HELP_PAGES: HelpPage[] = (
  [
  ["index", home],
  ["getting-started", gettingStarted],
  ["collections", collections],
  ["writing", writing],
  ["links", links],
  ["graph", graph],
  ["boards", boards],
  ["organising", organising],
  ["types", types],
  ["tasks", tasks],
  ["journal", journal],
  ["search", search],
  ["queries", queries],
  ["sharing", sharing],
  ["ai", ai],
  ["website", website],
  ["mac-folders", macFolders],
  ["mac-app", macApp],
  ["import-export", importExport],
  ["iphone", iphone],
  ["standalone", standalone],
  ["shortcuts", shortcuts],
  ["settings", settings],
  ] as const
).map(([id, text]) => {
  const { data, body } = parseFrontmatter(text);
  return { id, title: String(data.title ?? id), standalone: data.standalone === true, body };
});

/** The pages this build shows. */
export const HELP_PAGES = HELP_STANDALONE ? ALL_HELP_PAGES.filter((p) => p.standalone) : ALL_HELP_PAGES;

/** A page's Markdown, ready for the renderer: pictures pointed at where they're served. */
export function helpMarkdown(page: HelpPage): string {
  return page.body.replace(/\]\(images\/([\w-]+\.webp)\)/g, (_, name: string) => `](${helpImageUrl(name)})`);
}

/** "links.md" (or "links") → the page it names, if this build has it. */
export function helpPageFor(target: string): HelpPage | undefined {
  const id = target.replace(/#.*$/, "").replace(/\.md$/i, "");
  return HELP_PAGES.find((p) => p.id === id);
}

// ── open / close ─────────────────────────────────────────────────────────────────────────

/** null: closed; otherwise the page on show. */
let open: string | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export function openHelp(page = "index"): void {
  open = helpPageFor(page)?.id ?? "index";
  emit();
}
export function closeHelp(): void {
  open = null;
  emit();
}
export function useHelp(): string | null {
  return useSyncExternalStore(
    (f) => (listeners.add(f), () => void listeners.delete(f)),
    () => open,
  );
}

/** The guided tour's buttons at the top of Help: set by the app (the standalone file has none). */
export let helpTour: { tour(): void; whatsNew(): void } | null = null;
export function setHelpTour(actions: typeof helpTour): void {
  helpTour = actions;
}
