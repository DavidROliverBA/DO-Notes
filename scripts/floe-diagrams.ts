#!/usr/bin/env bun
/*
 * Floe diagrams in notes: refresh every ```mermaid block that starts with a `%% floe:` line from
 * the Floe diagram it names, so a design note shows the diagram as it is in Floe today.
 *
 *   ```mermaid
 *   %% floe: Payments / Context
 *   ```
 *
 * names a diagram by landscape and diagram name (or by its Floe id). A refresh fills the block with
 * Floe's Mermaid C4 and writes the line back as `%% floe: Payments / Context · <id>`, so renaming
 * either in Floe later doesn't break it. The block stays plain Mermaid, readable in any editor.
 *
 * Both apps are reached over MCP with bearer tokens (never in URLs):
 *   FLOE_MCP_URL, FLOE_TOKEN                 e.g. https://<floe>/mcp, an flt_… token (read-only is enough)
 *   COMMONPLACE_MCP_URL, COMMONPLACE_TOKEN   e.g. https://<commonplace>/mcp, an MCP token
 * or `--mcp-config <file>`: a JSON file with `mcpServers` entries named floe and commonplace
 * (url + an Authorization header), as MCP clients keep them.
 *
 *   bun scripts/floe-diagrams.ts [--vault <collection>] [--note <name>]… [--dry-run]
 *   bun scripts/floe-diagrams.ts --list      every diagram, as a line to paste into a block
 *
 * Without --note it finds notes by searching the collection for "floe" (up to 50).
 * Changes go through edit_note, one block at a time, so they apply to the live text.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

import { type DiagramRef, findBlocks, listLine, renderBlock, resolve } from "../src/floeDiagrams";

export { findBlocks, listLine, parseRef, renderBlock, resolve } from "../src/floeDiagrams";

// ── Floe and Commonplace over MCP ───────────────────────────────────────────────────────────────

interface Service {
  url: string;
  auth: string;
}

async function connect(s: Service): Promise<Client> {
  const client = new Client({ name: "commonplace-floe-diagrams", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(s.url), { requestInit: { headers: { authorization: s.auth } } }));
  return client;
}

async function call<T>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = (await client.callTool({ name, arguments: args })) as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  const text = (r.content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");
  if (r.isError) throw new Error(`${name}: ${text || "failed"}`);
  if (r.structuredContent !== undefined) return r.structuredContent as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

/** Every diagram the Floe token can see, by id, with its landscape's name. */
async function floeIndex(floe: Client) {
  const { landscapes } = await call<{ landscapes: { id: string; name: string }[] }>(floe, "list_landscapes");
  const out: { id: string; landscape: string; diagram: string }[] = [];
  for (const l of landscapes) {
    const { diagrams } = await call<{ diagrams: { id: string; name: string }[] }>(floe, "get_landscape", { landscapeId: l.id });
    for (const d of diagrams) out.push({ id: d.id, landscape: l.name, diagram: d.name });
  }
  return out;
}

function service(prefix: string, name: string, config: Record<string, unknown> | null): Service {
  const url = process.env[`${prefix}_MCP_URL`];
  const token = process.env[`${prefix}_TOKEN`];
  if (url && token) return { url, auth: `Bearer ${token}` };
  const found = config && findServer(config, name);
  if (found) return found;
  throw new Error(`Set ${prefix}_MCP_URL and ${prefix}_TOKEN, or pass --mcp-config with an mcpServers entry named "${name}"`);
}

function findServer(o: unknown, name: string): Service | null {
  if (!o || typeof o !== "object") return null;
  const servers = (o as Record<string, unknown>).mcpServers as Record<string, { url?: string; headers?: Record<string, string> }> | undefined;
  const s = servers?.[name];
  const auth = s?.headers && Object.entries(s.headers).find(([k]) => k.toLowerCase() === "authorization")?.[1];
  if (s?.url && auth) return { url: s.url, auth };
  for (const v of Object.values(o)) {
    const hit = findServer(v, name);
    if (hit) return hit;
  }
  return null;
}

async function main(argv: string[]) {
  const args = { vault: undefined as string | undefined, notes: [] as string[], dryRun: false, list: false, config: null as Record<string, unknown> | null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--vault") args.vault = argv[++i];
    else if (a === "--note") args.notes.push(argv[++i]!);
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--list") args.list = true;
    else if (a === "--mcp-config") args.config = JSON.parse(await Bun.file(argv[++i]!).text());
    else throw new Error(`Unknown option ${a}. Usage: bun scripts/floe-diagrams.ts [--vault <collection>] [--note <name>]… [--dry-run] [--list] [--mcp-config <file>]`);
  }
  const floe = await connect(service("FLOE", "floe", args.config));
  if (args.list) {
    for (const d of await floeIndex(floe)) console.log(listLine(d));
    await floe.close();
    return;
  }
  const cp = await connect(service("COMMONPLACE", "commonplace", args.config));
  const v = args.vault ? { vault: args.vault } : {};

  let names = args.notes;
  if (!names.length) {
    const { results } = await call<{ results: { path: string }[] }>(cp, "search_notes", { query: "floe", limit: 50, ...v });
    names = results.map((r) => r.path);
  }

  let index: Awaited<ReturnType<typeof floeIndex>> | null = null;
  let changed = 0;
  let problems = 0;
  for (const name of names) {
    const note = await call<{ path: string; content: string }>(cp, "read_note", { note: name, ...v });
    const blocks = findBlocks(note.content);
    if (!blocks.length) continue;
    index ??= await floeIndex(floe);
    for (const b of blocks) {
      const ref = resolve(index, b.ref);
      if (typeof ref === "string") {
        console.log(`✗ ${note.path}: ${ref}`);
        problems++;
        continue;
      }
      const { text } = await call<{ text: string }>(floe, "get_diagram", { diagramId: ref.id, format: "mermaid" });
      const next = renderBlock(b.text, ref, text);
      if (next === b.text) {
        console.log(`= ${note.path}: ${ref.landscape} / ${ref.diagram}`);
        continue;
      }
      if (!args.dryRun) await call(cp, "edit_note", { note: note.path, find: b.text, replace: next, ...v });
      console.log(`${args.dryRun ? "would update" : "✓"} ${note.path}: ${ref.landscape} / ${ref.diagram}`);
      changed++;
    }
  }
  console.log(`${changed} diagram${changed === 1 ? "" : "s"} ${args.dryRun ? "to update" : "updated"}${problems ? `, ${problems} not found` : ""}.`);
  await Promise.all([cp.close(), floe.close()]);
  if (problems) process.exitCode = 1;
}

if (import.meta.main) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(1);
  });
}
