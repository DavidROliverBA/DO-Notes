// Fake Longview and Recall for the tests (F30): just enough MCP over Streamable HTTP (Longview
// answers in JSON, Recall in event streams, as real servers may do either), and for Recall the
// OAuth a client meets: resource and server metadata, dynamic registration, an authorize page
// that says yes at once, PKCE, refresh and revoke.

import { createHash, randomBytes } from "node:crypto";
import { strToU8, zipSync } from "fflate";

export const LONGVIEW_READ = "lv-read-token-0001";
export const LONGVIEW_WRITE = "lv-write-token-0002";

type Seen = { tool: string; args: Record<string, unknown>; auth: string | null };

function rpc(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

type FakeTool = { name: string; title?: string; description?: string; annotations?: Record<string, unknown>; inputSchema?: Record<string, unknown> };

function mcp(req: Request, body: any, tools: FakeTool[], call: (name: string, args: any) => unknown, sse: boolean): Response {
  const reply = (msg: unknown) =>
    sse
      ? new Response(`event: message\ndata: ${JSON.stringify(msg)}\n\n`, { headers: { "content-type": "text/event-stream", "mcp-session-id": "s-1" } })
      : Response.json(msg, { headers: { "mcp-session-id": "s-1" } });
  if (body.method === "initialize") return reply(rpc(body.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fake", version: "1" } }));
  if (body.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (body.method === "tools/list") return reply(rpc(body.id, { tools }));
  if (body.method === "tools/call") {
    try {
      const out = call(body.params.name, body.params.arguments ?? {});
      return reply(rpc(body.id, { content: [{ type: "text", text: JSON.stringify(out) }] }));
    } catch (e) {
      return reply(rpc(body.id, { content: [{ type: "text", text: String((e as Error).message) }], isError: true }));
    }
  }
  return reply({ jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "no such method" } });
}

export function startFakeLongview(port: number) {
  const seen: Seen[] = [];
  const read = ["search_intelligence", "get_entity_dossier", "get_trend", "ask_analyst"].map((name) => ({ name }));
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/mcp" || req.method !== "POST") return new Response("not found", { status: 404 });
      const auth = req.headers.get("authorization");
      const token = auth?.replace(/^Bearer /, "");
      if (token !== LONGVIEW_READ && token !== LONGVIEW_WRITE) return Response.json({ error: "unauthorized" }, { status: 401 });
      const tools = token === LONGVIEW_WRITE ? [...read, { name: "save_url" }] : read;
      return mcp(req, await req.json(), tools, (name, args) => {
        seen.push({ tool: name, args, auth });
        if (name === "search_intelligence") return { events: [{ id: "ev-1", title: "Gemini 4 Carbon released", url: "https://example.com/gemini", date: "2026-10-30" }] };
        if (name === "get_entity_dossier") return { entity: args.entity, events: 12 };
        if (name === "get_trend") return { entity: args.entity, weeks: [3, 5] };
        if (name === "ask_analyst") return { answer: "Twice.", citations: ["ev-1"] };
        if (name === "save_url") return { message: `Saved ${args.url}`, event: "ev-9" };
        throw new Error(`no tool ${name}`);
      }, false);
    },
  });
  return { seen, stop: () => server.stop(true) };
}

export function startFakeRecall(port: number) {
  const base = `http://localhost:${port}`;
  const seen: Seen[] = [];
  const clients = new Map<string, string[]>(); // client_id → redirect URIs
  const codes = new Map<string, { client: string; redirect: string; challenge: string; scope: string }>();
  const access = new Set<string>();
  const refresh = new Map<string, string>(); // refresh → client
  const revoked: string[] = [];
  let lastScope = "";
  // Recall's tools, which a test can change: add some, or change what one says.
  const tools: FakeTool[] = [
    { name: "search", description: "Search the user's saved cards.", inputSchema: { type: "object", properties: { queries: { type: "string" }, mode: { type: "string" }, cursor: { type: "string" } }, required: ["queries"] } },
    { name: "fetch", description: "Read one card.", inputSchema: { type: "object", properties: { id: { type: "string" }, part: { type: "string" }, cursor: { type: "string" } }, required: ["id"] } },
  ];
  const issue = (client: string) => {
    const a = `rc-access-${randomBytes(6).toString("hex")}`;
    const r = `rc-refresh-${randomBytes(6).toString("hex")}`;
    access.add(a);
    refresh.set(r, client);
    return { access_token: a, refresh_token: r, token_type: "Bearer", expires_in: 3600, scope: "kb:read" };
  };
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p.startsWith("/.well-known/oauth-protected-resource")) return Response.json({ resource: `${base}/mcp`, authorization_servers: [base], scopes_supported: ["kb:read", "kb:write"] });
      if (p === "/.well-known/oauth-authorization-server")
        return Response.json({ issuer: base, authorization_endpoint: `${base}/oauth/authorize`, token_endpoint: `${base}/oauth/token`, registration_endpoint: `${base}/oauth/register`, revocation_endpoint: `${base}/oauth/revoke`, code_challenge_methods_supported: ["S256"] });
      if (p === "/oauth/register" && req.method === "POST") {
        const b = (await req.json()) as { redirect_uris: string[] };
        const id = `client-${clients.size + 1}`;
        clients.set(id, b.redirect_uris);
        return Response.json({ client_id: id, redirect_uris: b.redirect_uris }, { status: 201 });
      }
      if (p === "/oauth/authorize") {
        // The person signs in and allows it: straight back with a code.
        const q = url.searchParams;
        const client = q.get("client_id")!;
        const redirect = q.get("redirect_uri")!;
        if (!clients.get(client)?.includes(redirect) || q.get("code_challenge_method") !== "S256") return new Response("bad request", { status: 400 });
        lastScope = q.get("scope") ?? "";
        const code = `code-${randomBytes(6).toString("hex")}`;
        codes.set(code, { client, redirect, challenge: q.get("code_challenge")!, scope: lastScope });
        return Response.redirect(`${redirect}?code=${code}&state=${encodeURIComponent(q.get("state")!)}`, 302);
      }
      if (p === "/oauth/token" && req.method === "POST") {
        const f = new URLSearchParams(await req.text());
        if (f.get("grant_type") === "authorization_code") {
          const c = codes.get(f.get("code") ?? "");
          codes.delete(f.get("code") ?? "");
          const verifierOk = c && createHash("sha256").update(f.get("code_verifier") ?? "").digest("base64url") === c.challenge;
          if (!c || !verifierOk || c.client !== f.get("client_id") || c.redirect !== f.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json(issue(c.client));
        }
        if (f.get("grant_type") === "refresh_token") {
          const client = refresh.get(f.get("refresh_token") ?? "");
          if (!client) return Response.json({ error: "invalid_grant" }, { status: 400 });
          refresh.delete(f.get("refresh_token")!);
          return Response.json(issue(client));
        }
        return Response.json({ error: "unsupported_grant_type" }, { status: 400 });
      }
      if (p === "/oauth/revoke" && req.method === "POST") {
        const t = new URLSearchParams(await req.text()).get("token") ?? "";
        revoked.push(t);
        refresh.delete(t);
        return new Response(null, { status: 200 });
      }
      if (p === "/mcp/" && req.method === "POST") {
        const auth = req.headers.get("authorization");
        if (!access.has(auth?.replace(/^Bearer /, "") ?? "")) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } });
        return mcp(req, await req.json(), tools, (name, args) => {
          seen.push({ tool: name, args, auth });
          if (name === "summarise_card") return { summary: "A guide to tiling." };
          if (name === "search") return { cards: [{ card_id: "card_tiles42", title: "How to tile a bathroom", source_url: "https://example.com/tiles", chunks: ["Use a notched trowel."] }], has_more: false };
          if (name === "fetch") return { id: args.id, title: "How to tile a bathroom", text: "## Notes\nGood guide.\n## Content\nUse a notched trowel." };
          throw new Error(`no tool ${name}`);
        }, true);
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    seen,
    revoked,
    scope: () => lastScope,
    /** Add tools, or change what one says. */
    addTools: (more: FakeTool[]) => tools.push(...more),
    describe: (name: string, description: string) => (tools.find((t) => t.name === name)!.description = description),
    /** Make every access token stale, as if an hour passed. */
    expireAccess: () => access.clear(),
    stop: () => server.stop(true),
  };
}

/** A service connected by its address alone (F33 step 2): no sign-in, or a token when `token` is
 *  given. Its tools say what they do in annotations: two read, one says nothing, one deletes.
 *  `/` is a plain web page, for "that isn't an MCP service". */
export function startFakeService(port: number, token: string | null = null) {
  const seen: Seen[] = [];
  const tools: FakeTool[] = [
    { name: "list_recent", title: "Recent items", description: "The ten newest items.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: {} } },
    { name: "search_items", title: "Search", description: "Search the items.", annotations: { readOnlyHint: true }, inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] } },
    { name: "summarise", description: "Summarise an item.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
    { name: "delete_item", title: "Delete", description: "Delete an item.", annotations: { readOnlyHint: false, destructiveHint: true }, inputSchema: { type: "object", properties: { id: { type: "string" } } } },
  ];
  const server = Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/") return new Response("<!doctype html><title>Hello</title>", { headers: { "content-type": "text/html" } });
      if (url.pathname !== "/mcp" || req.method !== "POST") return new Response("not found", { status: 404 });
      const auth = req.headers.get("authorization");
      if (token && auth !== `Bearer ${token}`) return Response.json({ error: "unauthorized" }, { status: 401, headers: { "www-authenticate": 'Bearer realm="items"' } });
      const body = await req.json();
      if (body.method === "initialize") return Response.json(rpc(body.id, { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "items-server", title: "Items", version: "2.1" } }));
      return mcp(req, body, tools, (name, args) => {
        seen.push({ tool: name, args, auth });
        if (name === "list_recent") return { items: [{ id: "i1", title: "First item" }] };
        if (name === "search_items") return { items: [{ id: "i2", title: `About ${args.q}` }] };
        throw new Error(`no tool ${name}`);
      }, false);
    },
  });
  return { seen, stop: () => server.stop(true) };
}

export const FLOE_READ = "flt_read_0001";

/** A Floe with one landscape and one diagram (the three tools the Floe preset knows), and a
 *  fourth it doesn't, which says it changes things. */
export function startFakeFloe(port: number) {
  const seen: Seen[] = [];
  const tools: FakeTool[] = [
    { name: "list_landscapes", annotations: { readOnlyHint: true } },
    { name: "get_landscape", inputSchema: { type: "object", properties: { landscapeId: { type: "string" } }, required: ["landscapeId"] } },
    { name: "get_diagram", inputSchema: { type: "object", properties: { diagramId: { type: "string" }, format: { type: "string" } }, required: ["diagramId"] } },
    { name: "update_diagram", annotations: { readOnlyHint: false } },
  ];
  // Its REST export (F41): the landscape's folder of notes as a zip, as the test sets them.
  const notes: Record<string, string> = {};
  const exports: string[] = [];
  const server = Bun.serve({
    port,
    async fetch(req) {
      const auth = req.headers.get("authorization");
      if (auth !== `Bearer ${FLOE_READ}`) return Response.json({ error: "unauthorized" }, { status: 401 });
      const url = new URL(req.url);
      const ex = /^\/api\/landscapes\/([^/]+)\/export$/.exec(url.pathname);
      if (ex && req.method === "GET") {
        exports.push(`${ex[1]} ${url.searchParams.get("format")}`);
        if (ex[1] !== "l1") return Response.json({ error: "not found" }, { status: 404 });
        return new Response(zipSync(Object.fromEntries(Object.entries(notes).map(([p, c]) => [p, strToU8(c)]))), { headers: { "content-type": "application/zip" } });
      }
      return mcp(req, await req.json(), tools, (name, args) => {
        seen.push({ tool: name, args, auth });
        if (name === "list_landscapes") return { landscapes: [{ id: "l1", name: "Payments" }] };
        if (name === "get_landscape") return { id: args.landscapeId, diagrams: [{ id: "d1", name: "Context" }] };
        if (name === "get_diagram") return { text: "C4Context\n  System(pay, \"Payments\")" };
        throw new Error(`no tool ${name}`);
      }, false);
    },
  });
  return { seen, notes, exports, stop: () => server.stop(true) };
}
