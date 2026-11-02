// Known services for the connections manager (F33, docs/design/F33.md): what Commonplace already
// knows about each, so connecting one skips the questions. Data, not code: the address, how it
// signs in, which of its tools read (reviewed here, since a service may not say), the names the
// assistant knows them by, inputs to leave out or fix, how a call is described to the person, and
// a harmless test call. Longview and Recall were F30's hand-written connections; their tool names
// (longview_search, recall_read…) stay the same.

import { settings } from "./settings";

export interface PresetTool {
  /** What the assistant calls it, after the connection's slug: longview_<as>. */
  as: string;
  kind: "read" | "changes";
  /** On when connected. */
  on?: boolean;
  /** Replaces the service's description for the model. */
  description?: string;
  /** Inputs the model isn't offered. */
  hide?: string[];
  /** Inputs always sent. */
  fixed?: Record<string, unknown>;
  /** How a call is shown to the person: {input} and {out.field} are filled in. */
  describe?: string;
  summary?: string;
  /** The input the side panel puts the open note's title in (F33 step 4); none: not in the panel. */
  panel?: string;
}

export interface Preset {
  key: string;
  name: string;
  slug: string;
  address: () => string;
  auth: "token" | "oauth" | "none";
  /** OAuth: the scopes asked for (read only). */
  scopes?: string;
  /** Token: where to get a read-only one. */
  tokenHelp?: string;
  tools: Record<string, PresetTool>;
  /** A harmless call to show it works. */
  test?: { tool: string; args: Record<string, unknown> };
  blurb: string;
}

export const PRESETS: Preset[] = [
  {
    key: "longview",
    name: "Longview",
    slug: "longview",
    address: () => "https://longview-qf8i.onrender.com/mcp",
    auth: "token",
    tokenHelp: "Use one of Longview's read tokens (MCP_READ_TOKENS in its settings), never a token that can change Longview.",
    blurb: "Your knowledge base of AI news: events, entities and trends, all with sources.",
    tools: {
      search_intelligence: {
        as: "search",
        kind: "read",
        on: true,
        description:
          "Search Longview, the person's knowledge base of AI news (releases, results, funding, regulation, incidents), for events on a topic; leave out query for the latest stories. Returns events with their sources: cite them.",
        hide: ["categories", "kinds", "min_significance", "limit"],
        fixed: { limit: 10 },
        panel: "query",
        describe: "Search Longview for “{query}”",
        summary: "Searched Longview for “{query}”",
      },
      get_entity_dossier: { as: "entity", kind: "read", on: true, describe: "Look up “{entity}” in Longview", summary: "Looked up {entity} in Longview" },
      get_trend: { as: "trend", kind: "read", on: true, describe: "Get Longview's trend for “{entity}”", summary: "Got Longview's trend for {entity}" },
      ask_analyst: { as: "ask", kind: "read", on: true, hide: ["depth"], fixed: { depth: "quick" }, describe: "Ask Longview: “{question}”", summary: "Asked Longview's analyst" },
      get_digest: { as: "digest", kind: "read" },
      get_practice_guidance: { as: "guidance", kind: "read" },
      list_sources: { as: "sources", kind: "read" },
      get_article_candidates: { as: "candidates", kind: "read" },
      get_article_candidate: { as: "candidate", kind: "read" },
      save_url: { as: "save_url", kind: "changes" },
      create_source: { as: "create_source", kind: "changes" },
      update_source: { as: "update_source", kind: "changes" },
      delete_source: { as: "delete_source", kind: "changes" },
      test_source: { as: "test_source", kind: "changes" },
      update_candidate: { as: "update_candidate", kind: "changes" },
      revise_candidate: { as: "revise_candidate", kind: "changes" },
      submit_feedback: { as: "submit_feedback", kind: "changes" },
    },
    test: { tool: "search_intelligence", args: { limit: 1 } },
  },
  {
    key: "recall",
    name: "Recall",
    slug: "recall",
    address: () => settings.recallMcp,
    auth: "oauth",
    scopes: "kb:read",
    blurb: "What you've saved to Recall: articles, videos, podcasts and your notes on them.",
    tools: {
      search: {
        as: "search",
        kind: "read",
        on: true,
        hide: ["cursor", "card_id", "tag_ids", "source_url_contains"],
        fixed: { mode: "focused" },
        panel: "queries",
        describe: "Search Recall for “{queries}”",
        summary: "Searched Recall for “{queries}”",
      },
      fetch: { as: "read", kind: "read", on: true, hide: ["cursor", "from_chunk"], describe: "Read Recall card {id}", summary: "Read {out.title}" },
      grep: { as: "grep", kind: "read" },
      filter_by_metadata: { as: "list", kind: "read" },
      find_tags: { as: "tags", kind: "read" },
      get_related_cards: { as: "related", kind: "read" },
      list_sources: { as: "sources", kind: "read" },
      get_stats: { as: "stats", kind: "read" },
      explore_kb: { as: "explore", kind: "read" },
      get_document_content: { as: "content", kind: "read" },
    },
  },
  {
    key: "floe",
    name: "Floe",
    slug: "floe",
    address: () => settings.floeMcp,
    auth: "token",
    tokenHelp: "Use a read-only Floe token (flt_…), from Floe's settings.",
    blurb: "Your architecture landscapes in Floe: systems, their diagrams (as Mermaid C4) and decision records.",
    tools: {
      list_landscapes: { as: "landscapes", kind: "read", on: true, describe: "List your Floe landscapes", summary: "Listed your Floe landscapes" },
      get_landscape: { as: "landscape", kind: "read", on: true, describe: "Open Floe landscape {landscapeId}", summary: "Opened a Floe landscape" },
      get_diagram: {
        as: "diagram",
        kind: "read",
        on: true,
        hide: ["format"],
        fixed: { format: "mermaid" },
        description: "Get one of Floe's diagrams by its id (from floe_landscape), as Mermaid C4 the person can paste into a note in a ```mermaid block.",
        describe: "Get Floe diagram {diagramId}",
        summary: "Got a Floe diagram",
      },
    },
    test: { tool: "list_landscapes", args: {} },
  },
];

export const presetFor = (key: string | null | undefined) => PRESETS.find((p) => p.key === key) ?? null;
