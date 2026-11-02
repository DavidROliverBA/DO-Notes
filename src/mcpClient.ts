// A small client for another server's MCP tools over Streamable HTTP (F30: Longview and
// Recall): initialize, then tools/list and tools/call, each a JSON-RPC POST whose answer is JSON
// or a server-sent event stream. Requests go only to addresses checked as public (src/egress.ts,
// unless CONNECTIONS_ALLOW_LOCAL), and the token goes only in the Authorization header.

import { HttpError } from "./auth";
import { EgressError, pinnedFetch, vetAddresses } from "./egress";
import { settings } from "./settings";

const PROTOCOL = "2025-06-18";
const TIMEOUT_MS = 60_000;
const MAX_BYTES = 4_000_000;

/** The server answered, but not with what was asked: a refused token, a tool's own error. */
export class McpError extends Error {
  constructor(
    message: string,
    public status = 502,
    /** On a 401: the service's WWW-Authenticate, which names its sign-in server when it has one. */
    public authenticate: string | null = null,
  ) {
    super(message);
  }
}

export interface McpTool {
  name: string;
  description?: string;
}

/** Fetch through the egress checks, following no redirects. */
export async function outsideFetch(url: URL, init: RequestInit & { timeoutMs?: number }): Promise<Response> {
  if (url.protocol !== "https:" && !(settings.connectionsAllowLocal && url.protocol === "http:")) throw new HttpError(400, "The address must start with https://");
  let addrs: string[];
  try {
    addrs = await vetAddresses(url, { allowPrivate: settings.connectionsAllowLocal });
  } catch (e) {
    throw new HttpError(400, e instanceof EgressError ? e.message : `Couldn't reach ${url.host}`);
  }
  try {
    return await pinnedFetch(url, addrs, { ...init, redirect: "manual", signal: AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS) } as BunFetchRequestInit);
  } catch (e) {
    throw new McpError(`Couldn't reach ${url.host}${e instanceof Error && e.name === "TimeoutError" ? " (it took too long)" : ""}`);
  }
}

/** The JSON-RPC answer with this id, from a JSON body or an event stream. */
async function answer(res: Response, id: number): Promise<any> {
  const text = await res.text();
  if (text.length > MAX_BYTES) throw new McpError("The answer was too large");
  if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      if (!data) continue;
      try {
        const msg = JSON.parse(data);
        if (msg?.id === id) return msg;
      } catch {}
    }
    throw new McpError("No answer in the server's event stream");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new McpError("The server's answer wasn't JSON-RPC");
  }
}

export class McpClient {
  private session: string | null = null;
  private seq = 0;
  private ready: Promise<void> | null = null;
  /** What the service said about itself when it was initialised: its name, title and version. */
  serverInfo: { name?: string; title?: string; version?: string } | null = null;

  constructor(
    private readonly url: URL,
    private readonly token: string,
  ) {}

  private async post(body: object, expectAnswer: boolean): Promise<any> {
    const headers: Record<string, string> = {
      // A service with no sign-in gets no Authorization header at all.
      ...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
    };
    if (this.session) headers["mcp-session-id"] = this.session;
    const res = await outsideFetch(this.url, { method: "POST", headers, body: JSON.stringify(body) });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.session = sid;
    if (res.status === 401 || res.status === 403)
      throw new McpError(this.token ? "The server refused the token: it may have been revoked or have expired" : "It asks who you are: it needs a sign-in", 401, res.headers.get("www-authenticate"));
    if (res.status >= 300 && res.status < 400) throw new McpError(`The server sent DO Notes elsewhere (${res.status}): check the address`);
    if (!res.ok) throw new McpError(`The server answered ${res.status}`);
    if (!expectAnswer) return null;
    if ((res.headers.get("content-type") ?? "").includes("text/html")) throw new McpError("That address isn't an MCP service: it answered with a web page");
    const msg = await answer(res, (body as { id: number }).id);
    if (msg?.error) throw new McpError(String(msg.error.message ?? "The server refused the request"));
    return msg?.result;
  }

  private init(): Promise<void> {
    this.ready ??= (async () => {
      const r = await this.post({ jsonrpc: "2.0", id: ++this.seq, method: "initialize", params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "DO Notes", version: "1" } } }, true);
      this.serverInfo = r?.serverInfo && typeof r.serverInfo === "object" ? r.serverInfo : null;
      await this.post({ jsonrpc: "2.0", method: "notifications/initialized" }, false);
    })().catch((e) => {
      this.ready = null;
      throw e;
    });
    return this.ready;
  }

  /** Every tool, following the pages (at most 10 of them). */
  async listTools(): Promise<McpTool[]> {
    await this.init();
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.post({ jsonrpc: "2.0", id: ++this.seq, method: "tools/list", params: cursor ? { cursor } : {} }, true);
      if (Array.isArray(r?.tools)) out.push(...r.tools);
      cursor = typeof r?.nextCursor === "string" && r.nextCursor ? r.nextCursor : undefined;
      if (!cursor) break;
    }
    return out;
  }

  /** Call a tool; its text, parsed as JSON when it is. A tool's own error throws. */
  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    await this.init();
    const r = await this.post({ jsonrpc: "2.0", id: ++this.seq, method: "tools/call", params: { name, arguments: args } }, true);
    const text = (Array.isArray(r?.content) ? r.content : [])
      .filter((c: any) => c?.type === "text")
      .map((c: any) => String(c.text))
      .join("\n");
    if (r?.isError) throw new McpError(text || `${name} failed`, 400);
    if (r?.structuredContent !== undefined) return r.structuredContent;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
}
