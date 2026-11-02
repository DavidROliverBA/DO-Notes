// The connections manager (F33, docs/design/F33.md): each person's read-only connections to
// services that meet the bar (MCP over Streamable HTTP; a token, OAuth, or no sign-in). Here:
// connecting (a token, or OAuth with PKCE, Commonplace registering itself with the service's sign-in
// server), the service's tools sorted into read / unknown / changes (a tool that changes things is
// never enabled), a hash of each so a change to one the person chose holds the connection until
// they look again, and disconnecting (revoking an OAuth sign-in). The assistant's side, which
// offers the enabled tools, is src/outside.ts. Tokens are sealed and never sent to the browser.

import { createHash, randomBytes } from "node:crypto";
import { HttpError } from "./auth";
import { sql } from "./db";
import { McpClient, McpError, type McpTool, outsideFetch } from "./mcpClient";
import { presetFor, PRESETS, type Preset } from "./presets";
import { open, seal, secretsAvailable } from "./secrets";

export type Kind = "read" | "unknown" | "changes";

export interface ConnectionRow {
  id: number;
  user_id: number;
  name: string;
  slug: string;
  preset: string | null;
  address: string;
  auth: "token" | "oauth" | "none";
  token_enc: string | null;
  token_hint: string;
  refresh_enc: string | null;
  expires_at: Date | null;
  token_url: string | null;
  client_id: string | null;
  status: "ok" | "review";
  server_name: string | null;
  panel_tool: string | null;
  synced_at: Date | null;
  created_at: Date;
}

export interface ToolRow {
  connection_id: number;
  name: string;
  title: string | null;
  description: string;
  input_schema: Record<string, unknown>;
  annotations: Record<string, unknown> | null;
  kind: Kind;
  enabled: boolean;
  hash: string;
  reviewed_hash: string | null;
  reviewed: { description: string; input_schema: unknown } | null;
}

const MAX_TOOLS_ON = 20;
const MAX_CONNECTIONS = 10;
const MAX_DESCRIPTION = 2000;
const SYNC_MS = 5 * 60_000;

const needSecrets = () => {
  if (!secretsAvailable()) throw new HttpError(409, "This server can't store tokens yet: an admin needs to set SECRETS_KEY.");
};
const hint = (t: string) => t.trim().slice(-4);

/** What the person sees of their connections: never a token. */
export async function list(userId: number) {
  const rows = await sql<(ConnectionRow & { read: number; unknown: number; changes: number; on: number })[]>`
    select c.*, count(t.name) filter (where t.kind = 'read')::int as read, count(t.name) filter (where t.kind = 'unknown')::int as unknown,
           count(t.name) filter (where t.kind = 'changes')::int as changes, count(t.name) filter (where t.enabled)::int as on
    from connections c left join connection_tools t on t.connection_id = c.id
    where c.user_id = ${userId} group by c.id order by c.created_at`;
  return {
    available: secretsAvailable(),
    presets: PRESETS.map((p) => ({ key: p.key, name: p.name, auth: p.auth, address: p.address(), blurb: p.blurb, tokenHelp: p.tokenHelp ?? null })),
    connections: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      slug: r.slug,
      preset: r.preset,
      address: r.address,
      auth: r.auth,
      token_hint: r.token_hint,
      status: r.status,
      server_name: r.server_name,
      panel: r.panel_tool,
      tools: { read: r.read, unknown: r.unknown, changes: r.changes, on: r.on },
      created_at: r.created_at,
    })),
  };
}

async function row(userId: number, id: number): Promise<ConnectionRow> {
  const [r] = await sql<ConnectionRow[]>`select * from connections where id = ${id} and user_id = ${userId}`;
  if (!r) throw new HttpError(404, "No such connection");
  return r;
}

// ── sorting and syncing a service's tools ────────────────────────────────────────────────

/** Read, unknown or changes: what the preset says (it was reviewed), else the tool's own
 *  annotations (read only when it says so and isn't destructive), else unknown. */
export function kindOf(tool: McpTool & { annotations?: Record<string, unknown> }, preset: Preset | null): Kind {
  const p = preset?.tools[tool.name];
  if (p) return p.kind;
  const a = tool.annotations;
  if (a && (a.readOnlyHint === false || a.destructiveHint === true)) return "changes";
  if (a?.readOnlyHint === true) return "read";
  return "unknown";
}

/** What the model would see of a tool: if any of it changes, the person looks again. */
export function toolHash(t: { name: string; description?: string; inputSchema?: unknown; annotations?: unknown }) {
  return createHash("sha256").update(JSON.stringify([t.name, t.description ?? "", t.inputSchema ?? {}, t.annotations ?? null])).digest("hex");
}

/** List the service's tools again and record them. A tool the person enabled whose description,
 *  inputs or annotations changed holds the connection (status review) until they look; one that
 *  disappeared just goes; a new one arrives off (a preset's "on" tools excepted, at first sight).
 *  `first`: the tools are being seen for the first time (connecting), so the preset's choices and
 *  what the person sees now count as reviewed. */
export async function sync(c: ConnectionRow, first = false): Promise<ToolRow[]> {
  const preset = presetFor(c.preset);
  const client = await clientFor(c);
  let tools: (McpTool & { title?: string; inputSchema?: Record<string, unknown>; annotations?: Record<string, unknown> })[];
  try {
    tools = (await client.listTools()) as typeof tools;
  } catch (e) {
    throw wrap(c, e);
  }
  const have = new Map((await sql<ToolRow[]>`select * from connection_tools where connection_id = ${c.id}`).map((t) => [t.name, t]));
  let held = false;
  const seen = new Set<string>();
  for (const t of tools.slice(0, 200)) {
    if (typeof t?.name !== "string" || !/^[A-Za-z0-9_.-]{1,64}$/.test(t.name) || seen.has(t.name)) continue;
    seen.add(t.name);
    const kind = kindOf(t, preset);
    const hash = toolHash(t);
    const old = have.get(t.name);
    const description = String(t.description ?? "").slice(0, MAX_DESCRIPTION);
    const schema = t.inputSchema && typeof t.inputSchema === "object" ? t.inputSchema : { type: "object" };
    // On at first sight: a preset's chosen tools; for a service with no preset, its read tools.
    const startOn = first && !old && kind !== "changes" && (preset ? !!preset.tools[t.name]?.on : kind === "read");
    const enabled = kind === "changes" ? false : old ? old.enabled : startOn;
    const changed = !!old?.enabled && old.reviewed_hash !== null && old.reviewed_hash !== hash;
    if (changed) held = true;
    const reviewedHash = old ? (first && old.enabled ? hash : old.reviewed_hash) : startOn ? hash : null;
    const reviewed = old ? (first && old.enabled ? { description, input_schema: schema } : old.reviewed) : startOn ? { description, input_schema: schema } : null;
    await sql`
      insert into connection_tools (connection_id, name, title, description, input_schema, annotations, kind, enabled, hash, reviewed_hash, reviewed)
      values (${c.id}, ${t.name}, ${t.title ? String(t.title).slice(0, 200) : null}, ${description}, ${sql.json(schema as never)}, ${t.annotations ? sql.json(t.annotations as never) : null},
              ${kind}, ${enabled}, ${hash}, ${reviewedHash}, ${reviewed ? sql.json(reviewed as never) : null})
      on conflict (connection_id, name) do update set title = excluded.title, description = excluded.description, input_schema = excluded.input_schema,
        annotations = excluded.annotations, kind = excluded.kind, enabled = excluded.enabled, hash = excluded.hash,
        reviewed_hash = excluded.reviewed_hash, reviewed = excluded.reviewed`;
  }
  const gone = [...have.keys()].filter((n) => !seen.has(n));
  if (gone.length) await sql`delete from connection_tools where connection_id = ${c.id} and name in ${sql(gone)}`;
  await sql`update connections set synced_at = now(), status = ${held ? "review" : c.status === "review" && !held && first ? "ok" : c.status} where id = ${c.id}`;
  if (held) c.status = "review";
  return sql<ToolRow[]>`select * from connection_tools where connection_id = ${c.id} order by kind, name`;
}

/** The person's connections that are ready (synced in the last few minutes, or now), with their
 *  enabled tools: what the assistant may use. A connection held for review offers nothing. */
export async function ready(userId: number): Promise<{ c: ConnectionRow; tools: ToolRow[] }[]> {
  const rows = await sql<ConnectionRow[]>`select * from connections where user_id = ${userId} order by created_at`;
  const out: { c: ConnectionRow; tools: ToolRow[] }[] = [];
  for (const c of rows) {
    let tools: ToolRow[];
    if (!c.synced_at || Date.now() - new Date(c.synced_at).getTime() > SYNC_MS) {
      try {
        tools = await sync(c, !c.synced_at);
      } catch {
        continue; // unreachable or signed out now: left out of this conversation
      }
    } else tools = await sql<ToolRow[]>`select * from connection_tools where connection_id = ${c.id}`;
    if (c.status !== "ok") continue;
    out.push({ c, tools: tools.filter((t) => t.enabled && t.kind !== "changes") });
  }
  return out;
}

/** The tools for Review: as listed now, with what changed since the person last looked. */
export async function tools(userId: number, id: number) {
  const c = await row(userId, id);
  const list = await sync(c);
  const preset = presetFor(c.preset);
  // What the assistant can send: the tool's inputs, less those the preset leaves out or fixes.
  const inputs = (t: ToolRow) => {
    const p = preset?.tools[t.name];
    const skip = new Set([...(p?.hide ?? []), ...Object.keys(p?.fixed ?? {})]);
    return Object.keys((t.input_schema as { properties?: object }).properties ?? {}).filter((k) => !skip.has(k));
  };
  return {
    status: c.status,
    tools: list.map((t) => ({
      name: t.name,
      title: t.title,
      description: t.description,
      inputs: inputs(t),
      kind: t.kind,
      enabled: t.enabled,
      changed: t.enabled && t.reviewed_hash !== null && t.reviewed_hash !== t.hash ? { before: t.reviewed?.description ?? "", after: t.description } : null,
      fresh: t.reviewed_hash === null,
    })),
  };
}

/** The person's choice in Review: which tools are on. A tool that changes things can't be. What
 *  they see now counts as reviewed, and the connection is released. */
export async function choose(userId: number, id: number, on: string[]) {
  const c = await row(userId, id);
  const all = await sql<ToolRow[]>`select * from connection_tools where connection_id = ${c.id}`;
  const want = new Set(on);
  const bad = all.filter((t) => want.has(t.name) && t.kind === "changes");
  if (bad.length) throw new HttpError(400, `${bad.map((t) => t.name).join(", ")} change${bad.length === 1 ? "s" : ""} things in ${c.name}: DO Notes only reads`);
  if (all.filter((t) => want.has(t.name)).length > MAX_TOOLS_ON) throw new HttpError(400, `At most ${MAX_TOOLS_ON} tools per connection`);
  for (const t of all) {
    const enabled = want.has(t.name);
    await sql`update connection_tools set enabled = ${enabled},
      reviewed_hash = ${enabled ? t.hash : null}, reviewed = ${enabled ? sql.json({ description: t.description, input_schema: t.input_schema } as never) : null}
      where connection_id = ${c.id} and name = ${t.name}`;
  }
  await sql`update connections set status = 'ok' where id = ${c.id}`;
  return tools(userId, id);
}

// ── connecting ───────────────────────────────────────────────────────────────────────────

function address(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim().includes("://") ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    throw new HttpError(400, "That isn't a web address");
  }
  if (url.username || url.password || /token|key|secret|password/i.test(url.search)) throw new HttpError(400, "Leave the sign-in out of the address: the token goes in its own box");
  return url;
}

async function limit(userId: number) {
  const [{ n }] = (await sql`select count(*)::int as n from connections where user_id = ${userId}`) as unknown as [{ n: number }];
  if (n >= MAX_CONNECTIONS) throw new HttpError(400, `At most ${MAX_CONNECTIONS} connections each`);
}

/** Connect a preset that signs in with a token (Longview): check the address and token by listing
 *  its tools and the preset's test call; refuse a token that's offered tools that change things. */
export async function connectToken(userId: number, presetKey: string, rawAddress: string, rawToken: string) {
  needSecrets();
  const preset = presetFor(presetKey);
  if (!preset || preset.auth !== "token") throw new HttpError(400, "No such service");
  const url = address(rawAddress || preset.address());
  if (preset.key === "longview" && !/\/mcp\/?$/.test(url.pathname)) url.pathname = url.pathname.replace(/\/?$/, "/mcp");
  const token = rawToken.trim();
  if (token.length < 8) throw new HttpError(400, `Paste ${preset.name}'s token`);
  const client = new McpClient(url, token);
  let names: string[];
  try {
    names = (await client.listTools()).map((t) => t.name);
  } catch (e) {
    throw new HttpError(400, e instanceof McpError ? `${preset.name}: ${e.message}` : `Couldn't reach ${preset.name} at that address`);
  }
  if (preset.test && !names.includes(preset.test.tool)) throw new HttpError(400, `That address answers, but it isn't ${preset.name}: it has no ${preset.test.tool} tool`);
  const writes = names.filter((n) => preset.tools[n]?.kind === "changes");
  if (writes.length) throw new HttpError(400, `That token can change ${preset.name} (it's offered ${writes.join(", ")}). DO Notes only reads: give it ${preset.tokenHelp ? "a read token. " + preset.tokenHelp : "a read-only token."}`);
  if (preset.test)
    await client.call(preset.test.tool, preset.test.args).catch((e) => {
      throw new HttpError(400, `${preset.name}: ${e instanceof Error ? e.message : "the test call failed"}`);
    });
  const [existing] = await sql`select id from connections where user_id = ${userId} and slug = ${preset.slug}`;
  if (!existing) await limit(userId);
  const [c] = await sql<ConnectionRow[]>`
    insert into connections (user_id, name, slug, preset, address, auth, token_enc, token_hint)
    values (${userId}, ${preset.name}, ${preset.slug}, ${preset.key}, ${url.toString()}, 'token', ${seal(token)}, ${hint(token)})
    on conflict (user_id, slug) do update set address = excluded.address, token_enc = excluded.token_enc, token_hint = excluded.token_hint, status = 'ok', synced_at = null
    returning *`;
  await sync(c!, true);
  return (await list(userId)).connections.find((x) => x.id === Number(c!.id))!;
}

// Any service with a token or no sign-in (F33 step 2): look first, then connect.

export interface Probe {
  /** Whether it can be connected as it is (with the token given, or none). */
  ok: boolean;
  name: string;
  version: string | null;
  /** What it asks for: nothing, a token, or a sign-in on its own page (OAuth, not yet for any service). */
  signIn: "none" | "token" | "oauth";
  tools: { read: number; unknown: number; changes: number };
  /** Why it can't be connected, naming the rule it failed (docs/design/F33.md, Part 1). */
  problem: string | null;
}

/** Look at a service before connecting: does it answer as MCP, does it need a sign-in, and what
 *  tools does it offer? Nothing is stored. */
export async function probe(rawAddress: string, rawToken = ""): Promise<Probe> {
  const url = address(rawAddress);
  const token = rawToken.trim();
  const out: Probe = { ok: false, name: url.hostname, version: null, signIn: token ? "token" : "none", tools: { read: 0, unknown: 0, changes: 0 }, problem: null };
  const client = new McpClient(url, token);
  let list: (McpTool & { annotations?: Record<string, unknown> })[];
  try {
    list = await client.listTools();
  } catch (e) {
    if (e instanceof McpError && e.status === 401) {
      // A service that names a sign-in server signs in on its own page (OAuth); otherwise it wants a token.
      if (!token && /resource_metadata|authorization_uri/i.test(e.authenticate ?? "")) {
        out.signIn = "oauth";
        out.problem = "It signs in on its own page (OAuth). DO Notes can do that for Recall today, and for any service in a later step.";
      } else {
        out.signIn = "token";
        out.problem = token ? "It refused that token: check it, or make a new read-only one." : null;
      }
      return out;
    }
    out.problem = e instanceof McpError || e instanceof HttpError ? e.message : "Couldn't reach it";
    return out;
  }
  const info = client.serverInfo;
  out.name = String(info?.title || info?.name || url.hostname).slice(0, 60);
  out.version = info?.version ? String(info.version).slice(0, 20) : null;
  for (const t of list) out.tools[kindOf(t, null)]++;
  if (!list.length) out.problem = "It has no tools, so there's nothing for your assistants to use.";
  else if (!out.tools.read && !out.tools.unknown) out.problem = "Every one of its tools changes things, and DO Notes only reads.";
  out.ok = !out.problem;
  return out;
}

/** The assistant's name for a connection's tools: short, lower-case, its own among the person's. */
async function slugFor(userId: number, name: string): Promise<string> {
  const base = (name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").replace(/^(?=\d)/, "s_") || "service").slice(0, 20);
  const taken = new Set((await sql`select slug from connections where user_id = ${userId}`).map((r) => r.slug as string));
  for (const p of PRESETS) taken.add(p.slug);
  let slug = base;
  for (let i = 2; taken.has(slug); i++) slug = `${base.slice(0, 17)}_${i}`;
  return slug;
}

/** Connect any service with a token, or none (past the warning, which the person confirms). Its
 *  read tools start on; the person chooses in Review next. */
export async function connectService(userId: number, b: { address: string; token?: string; name?: string; noSignIn?: boolean }) {
  const token = (b.token ?? "").trim();
  if (token) needSecrets();
  const found = await probe(b.address, token);
  if (found.signIn === "token" && !token) throw new HttpError(400, `${found.name} asks who you are: paste a token for it`);
  if (!found.ok) throw new HttpError(400, found.problem ?? "It can't be connected");
  if (!token && !b.noSignIn) throw new HttpError(400, `${found.name} doesn't ask who you are. Read the warning and confirm it before connecting.`);
  await limit(userId);
  const name = (b.name?.trim() || found.name).slice(0, 60);
  const url = address(b.address);
  const [c] = await sql<ConnectionRow[]>`
    insert into connections (user_id, name, slug, preset, address, auth, token_enc, token_hint, server_name)
    values (${userId}, ${name}, ${await slugFor(userId, name)}, null, ${url.toString()}, ${token ? "token" : "none"}, ${token ? seal(token) : null}, ${token ? hint(token) : ""}, ${found.name})
    returning *`;
  await sync(c!, true);
  return (await list(userId)).connections.find((x) => x.id === Number(c!.id))!;
}

/** Try it: one harmless call, so the person sees the connection works. The preset's test, else the
 *  first read tool that's on and needs no input. */
export async function tryConnection(userId: number, id: number): Promise<{ tool: string | null; answer: string }> {
  const c = await row(userId, id);
  const preset = presetFor(c.preset);
  const on = await sql<ToolRow[]>`select * from connection_tools where connection_id = ${c.id} and enabled and kind = 'read' order by name`;
  const pick = preset?.test ? { name: preset.test.tool, args: preset.test.args } : on.filter((t) => !((t.input_schema as { required?: string[] }).required ?? []).length).map((t) => ({ name: t.name, args: {} }))[0];
  if (!pick) return { tool: null, answer: `None of the tools on can be tried without something to look up: ask your assistant about ${c.name} instead.` };
  let out: unknown;
  try {
    out = await (await clientFor(c)).call(pick.name, pick.args);
  } catch (e) {
    throw wrap(c, e);
  }
  const text = typeof out === "string" ? out : JSON.stringify(out, null, 1);
  return { tool: pick.name, answer: text.length > 600 ? text.slice(0, 600) + "…" : text };
}

// OAuth (generalising F30's Recall sign-in): discovery, registration, PKCE, read scopes only.

const SIGN_IN_MS = 10 * 60_000;
const signIns = new Map<string, { userId: number; preset: string; verifier: string; redirect: string; clientId: string; tokenUrl: string; resource: string; until: number }>();

interface AuthServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  code_challenge_methods_supported?: string[];
}

async function getJson(url: URL, who: string): Promise<any> {
  const res = await outsideFetch(url, { headers: { accept: "application/json" }, timeoutMs: 20_000 }).catch((e) => {
    throw new HttpError(502, `Couldn't reach ${who}: ${e instanceof Error ? e.message : "no answer"}`);
  });
  if (!res.ok) throw new HttpError(502, `${who} answered ${res.status} at ${url.pathname}`);
  return res.json();
}

/** The service's sign-in server, found the way MCP clients find it: the resource's metadata. */
async function authServer(resource: URL, who: string): Promise<AuthServer> {
  const meta = await getJson(new URL(`/.well-known/oauth-protected-resource${resource.pathname.replace(/\/$/, "")}`, resource), who).catch(() =>
    getJson(new URL("/.well-known/oauth-protected-resource", resource), who),
  );
  const issuer = new URL(String(meta?.authorization_servers?.[0] ?? resource.origin));
  const server = (await getJson(new URL(`/.well-known/oauth-authorization-server${issuer.pathname.replace(/\/$/, "")}`, issuer), who)) as AuthServer;
  for (const k of ["authorization_endpoint", "token_endpoint"] as const) {
    const u = new URL(String(server[k] ?? ""), issuer);
    if (u.protocol !== "https:" && !(process.env.CONNECTIONS_ALLOW_LOCAL === "true" && u.protocol === "http:")) throw new HttpError(502, `${who}'s sign-in server gave an address that isn't https`);
    server[k] = u.toString();
  }
  if (server.code_challenge_methods_supported && !server.code_challenge_methods_supported.includes("S256")) throw new HttpError(502, `${who}'s sign-in doesn't use PKCE (S256), which DO Notes needs`);
  return server;
}

async function registration(server: AuthServer, redirect: string, scopes: string, who: string): Promise<string> {
  const [have] = await sql`select client_id from outside_oauth_clients where issuer = ${server.issuer} and redirect_uri = ${redirect}`;
  if (have) return have.client_id;
  if (!server.registration_endpoint) throw new HttpError(502, `${who} doesn't let new apps register`);
  const res = await outsideFetch(new URL(server.registration_endpoint), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ client_name: "DO Notes", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", scope: scopes }),
    timeoutMs: 20_000,
  });
  const body = (await res.json().catch(() => null)) as { client_id?: string } | null;
  if (!res.ok || !body?.client_id) throw new HttpError(502, `${who} wouldn't register DO Notes (${res.status})`);
  await sql`insert into outside_oauth_clients (issuer, redirect_uri, client_id) values (${server.issuer}, ${redirect}, ${body.client_id}) on conflict do nothing`;
  return body.client_id;
}

const b64url = (b: Buffer) => b.toString("base64url");
const resourceOf = (u: string) => new URL(u).toString().replace(/\/$/, "");

/** Where to send the person to sign in to a preset that uses OAuth: its own page, asking for its
 *  read scopes only. `origin` is the address this Commonplace is reached at. */
export async function startOAuth(userId: number, presetKey: string, origin: string): Promise<{ url: string }> {
  needSecrets();
  const preset = presetFor(presetKey);
  if (!preset || preset.auth !== "oauth") throw new HttpError(400, "No such service");
  const mcp = new URL(preset.address());
  const server = await authServer(mcp, preset.name);
  const redirect = `${origin}/api/connections/callback`;
  const clientId = await registration(server, redirect, preset.scopes ?? "", preset.name);
  const verifier = b64url(randomBytes(32));
  const state = b64url(randomBytes(24));
  const now = Date.now();
  for (const [k, v] of signIns) if (v.until < now) signIns.delete(k);
  signIns.set(state, { userId, preset: preset.key, verifier, redirect, clientId, tokenUrl: server.token_endpoint, resource: resourceOf(preset.address()), until: now + SIGN_IN_MS });
  const url = new URL(server.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirect,
    ...(preset.scopes ? { scope: preset.scopes } : {}),
    state,
    code_challenge: b64url(createHash("sha256").update(verifier).digest()),
    code_challenge_method: "S256",
    resource: resourceOf(preset.address()),
  }).toString();
  return { url: url.toString() };
}

async function tokenRequest(tokenUrl: string, form: Record<string, string>, who: string) {
  const res = await outsideFetch(new URL(tokenUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams(form).toString(),
    timeoutMs: 20_000,
  }).catch((e) => {
    throw new HttpError(502, `Couldn't reach ${who}: ${e instanceof Error ? e.message : "no answer"}`);
  });
  const body = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; expires_in?: number; error?: string } | null;
  if (!res.ok || !body?.access_token) throw new HttpError(res.status === 400 ? 401 : 502, body?.error === "invalid_grant" ? `${who}'s sign-in has expired` : `${who} refused the sign-in (${body?.error ?? res.status})`);
  return body;
}

/** The service sent the person back with a code: exchange it, keep the tokens sealed, list the
 *  tools. The state ties it to whoever started, so it works in a browser with no session.
 *  Returns the service's name. */
export async function finishOAuth(state: string, code: string): Promise<string> {
  const s = signIns.get(state);
  signIns.delete(state);
  if (!s || s.until < Date.now()) throw new HttpError(400, "That sign-in took too long or was used already. Start again from Settings → Connections.");
  const preset = presetFor(s.preset)!;
  const t = await tokenRequest(s.tokenUrl, { grant_type: "authorization_code", code, redirect_uri: s.redirect, client_id: s.clientId, code_verifier: s.verifier, resource: s.resource }, preset.name);
  const [existing] = await sql`select id from connections where user_id = ${s.userId} and slug = ${preset.slug}`;
  if (!existing) await limit(s.userId);
  const expires = t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null;
  const [c] = await sql<ConnectionRow[]>`
    insert into connections (user_id, name, slug, preset, address, auth, token_enc, refresh_enc, expires_at, token_url, client_id)
    values (${s.userId}, ${preset.name}, ${preset.slug}, ${preset.key}, ${preset.address()}, 'oauth', ${seal(t.access_token!)}, ${t.refresh_token ? seal(t.refresh_token) : null}, ${expires}, ${s.tokenUrl}, ${s.clientId})
    on conflict (user_id, slug) do update set address = excluded.address, token_enc = excluded.token_enc, refresh_enc = excluded.refresh_enc,
      expires_at = excluded.expires_at, token_url = excluded.token_url, client_id = excluded.client_id, status = 'ok', synced_at = null
    returning *`;
  await sync(c!, true).catch(() => {}); // listed on first use if the service is slow now
  return preset.name;
}

// ── using one ────────────────────────────────────────────────────────────────────────────

const needsAgain = (c: ConnectionRow) => new HttpError(409, `${c.name} needs connecting again: Settings → Connections.`);

/** A client for the connection, refreshing an OAuth sign-in that's about to expire. */
export async function clientFor(c: ConnectionRow): Promise<McpClient> {
  let token = "";
  if (c.auth !== "none") {
    try {
      token = open(c.token_enc!);
    } catch {
      throw needsAgain(c);
    }
  }
  if (c.auth === "oauth" && c.expires_at && new Date(c.expires_at).getTime() < Date.now() + 60_000) {
    if (!c.refresh_enc || !c.token_url || !c.client_id) throw needsAgain(c);
    try {
      const t = await tokenRequest(c.token_url, { grant_type: "refresh_token", refresh_token: open(c.refresh_enc), client_id: c.client_id }, c.name);
      const expires = t.expires_in ? new Date(Date.now() + t.expires_in * 1000) : null;
      await sql`update connections set token_enc = ${seal(t.access_token!)}, refresh_enc = coalesce(${t.refresh_token ? seal(t.refresh_token) : null}, refresh_enc), expires_at = ${expires} where id = ${c.id}`;
      token = t.access_token!;
      c.expires_at = expires;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) {
        await sql`delete from connections where id = ${c.id}`;
        throw needsAgain(c);
      }
      throw e;
    }
  }
  return new McpClient(new URL(c.address), token);
}

/** An error from the service, as the person should read it. */
export function wrap(c: ConnectionRow, e: unknown): HttpError {
  if (e instanceof McpError) return e.status === 401 ? needsAgain(c) : new HttpError(502, `${c.name}: ${e.message}`);
  return e instanceof HttpError ? e : new HttpError(502, `${c.name} failed`);
}

export async function disconnect(userId: number, id: number): Promise<void> {
  const [c] = await sql<ConnectionRow[]>`delete from connections where id = ${id} and user_id = ${userId} returning *`;
  if (!c) throw new HttpError(404, "No such connection");
  if (c.auth !== "oauth" || !c.refresh_enc) return;
  // Ask the service to forget the sign-in too; it's gone from here either way.
  try {
    const server = await authServer(new URL(c.address), c.name);
    if (server.revocation_endpoint)
      await outsideFetch(new URL(server.revocation_endpoint), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ token: open(c.refresh_enc), token_type_hint: "refresh_token", client_id: c.client_id ?? "" }).toString(),
        timeoutMs: 10_000,
      });
  } catch {}
}

/** The tool-name prefixes of the person's connections, held or not: earlier calls to them count
 *  as reading from outside. */
export async function slugs(userId: number): Promise<string[]> {
  return (await sql`select slug from connections where user_id = ${userId}`).map((r) => r.slug as string);
}
