// MCP server at POST /mcp: Model Context Protocol over Streamable HTTP, stateless, answering
// each JSON-RPC request with a JSON response (no SSE stream is needed for tools). Authenticated by
// a personal MCP token in `Authorization: Bearer cpm_…` (never in the URL), pasted in or made by an
// app signing in (src/oauth.ts, which a 401 points to); the tools are in src/tools.ts. Connect
// Claude Code with:
//
//   claude mcp add --transport http commonplace https://…/mcp --header "Authorization: Bearer cpm_…"

import pkg from "../package.json" with { type: "json" };
import { HttpError, sameOrigin } from "./auth";
import { resourceMetadataUrl } from "./oauth";
import { authenticateToken } from "./tokens";
import { callTool, inputSchema, type ToolCtx, toolsFor } from "./tools";

/** JSON-RPC requests in one batch, which run at once: enough for any client, not enough to swamp the pool. */
const MAX_BATCH = 20;
const VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "DO Notes is a markdown knowledge base (plain Markdown): notes in collections, linked with [[wikilinks]], tagged with #tags, with YAML properties. " +
  "Search before creating, so you add to an existing note rather than duplicating it. Edits merge live with people typing, and the text before each edit is kept in the note's history.";

type Rpc = { jsonrpc: "2.0"; id?: string | number | null; method?: string; params?: any };

const ok = (id: Rpc["id"], result: unknown) => ({ jsonrpc: "2.0", id, result });
const fail = (id: Rpc["id"], code: number, message: string) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

async function handle(msg: Rpc, ctx: ToolCtx): Promise<object | null> {
  if (msg.jsonrpc !== "2.0" || typeof msg.method !== "string") return fail(msg.id, -32600, "Invalid request");
  if (msg.id === undefined) return null; // a notification (notifications/initialized…): nothing to answer
  switch (msg.method) {
    case "initialize": {
      const asked = msg.params?.protocolVersion;
      return ok(msg.id, {
        protocolVersion: VERSIONS.includes(asked) ? asked : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "commonplace", title: "DO Notes", version: pkg.version },
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return ok(msg.id, {});
    case "tools/list":
      return ok(msg.id, {
        tools: toolsFor(ctx).map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: inputSchema(t),
          annotations: { readOnlyHint: !t.writes, destructiveHint: false, idempotentHint: !t.writes, openWorldHint: false },
        })),
      });
    case "tools/call": {
      try {
        const result = await callTool(ctx, String(msg.params?.name ?? ""), msg.params?.arguments);
        // structuredContent must be an object; every tool returns one.
        const structured = result && typeof result === "object" && !Array.isArray(result) ? result : { result };
        return ok(msg.id, { content: [{ type: "text", text: JSON.stringify(result, null, 2) }], structuredContent: structured, isError: false });
      } catch (e) {
        // A tool that fails tells the model why, so it can try again differently.
        if (e instanceof HttpError) return ok(msg.id, { content: [{ type: "text", text: e.message }], isError: true });
        console.error("mcp tool failed:", e);
        return ok(msg.id, { content: [{ type: "text", text: "Something went wrong on the server" }], isError: true });
      }
    }
    default:
      return fail(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers });

export async function mcpRoute(req: Request): Promise<Response> {
  // Browsers send Origin; a page on another site must not drive this endpoint (DNS rebinding).
  if (!sameOrigin(req)) return json(fail(null, -32600, "Cross-origin request refused"), 403);
  if (req.method !== "POST") return new Response("The DO Notes MCP endpoint takes POST (Streamable HTTP, JSON responses).", { status: 405, headers: { Allow: "POST" } });

  let token;
  try {
    token = await authenticateToken(req, "mcp");
  } catch (e) {
    const message = e instanceof HttpError ? e.message : "Unauthorised";
    return json(fail(null, -32001, message), e instanceof HttpError ? e.status : 401, {
      "WWW-Authenticate": `Bearer realm="commonplace", ${req.headers.has("authorization") ? 'error="invalid_token", ' : ""}resource_metadata="${resourceMetadataUrl(req)}"`,
    });
  }
  const ctx: ToolCtx = { user: token.user, canWrite: token.scope === "mcp" };

  let body: Rpc | Rpc[];
  try {
    body = await req.json();
  } catch {
    return json(fail(null, -32700, "Parse error"), 400);
  }
  if (Array.isArray(body)) {
    if (body.length > MAX_BATCH) return json(fail(null, -32600, `At most ${MAX_BATCH} requests in a batch`), 400);
    const out = (await Promise.all(body.map((m) => handle(m, ctx)))).filter(Boolean);
    return out.length ? json(out) : new Response(null, { status: 202 });
  }
  const out = await handle(body, ctx);
  return out ? json(out) : new Response(null, { status: 202 });
}
