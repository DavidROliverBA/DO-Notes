// Sign-in for MCP clients (F25): OAuth 2.1 with PKCE, as the MCP authorization spec asks, so
// claude.ai's connectors (and through them the Claude iPhone and desktop apps) can use Commonplace
// without anyone pasting a token. Commonplace is both the authorization server and the resource:
//
//   /.well-known/oauth-protected-resource[/mcp]  where to sign in for /mcp (RFC 9728)
//   /.well-known/oauth-authorization-server      the endpoints below (RFC 8414)
//   POST /oauth/register                         dynamic client registration (RFC 7591)
//   /oauth/authorize                             the app's consent page (web/components/OAuthConsent.tsx),
//                                                which asks /api/oauth/request and /api/oauth/approve
//   POST /oauth/token                            a code (with its PKCE verifier) or refresh token for tokens
//   POST /oauth/revoke                           RFC 7009
//
// A Mac's Commonplace signs in the same way with scope "device" (F23): its token (cpd_…) opens
// the person's collections over the app's own API, events and live socket, so the Mac can show
// them beside its own; never /mcp, Settings or Admin.
//
// Signing in makes an ordinary MCP token row (src/tokens.ts) with the client's name: listed in
// Settings → Connections, revoked there like any other, and cut off at once. Its access token
// (cpm_…, so /mcp reads it as it reads a pasted token) lasts an hour; the refresh token (cpr_…)
// is replaced each time it's used. Only hashes are stored. Tokens never travel in a URL; the one
// secret that does is the authorization code, which lasts five minutes, works once, and is
// useless without the verifier only the client holds.

import { createHash, randomBytes } from "node:crypto";
import { hashToken, HttpError, type User } from "./auth";
import { kick } from "./collab";
import { sql } from "./db";
import { socketKey } from "./tokens";

const ACCESS_SECONDS = 3600;
const CODE_SECONDS = 300;
/** Unused registrations (no sign-in made with them) are dropped after a day, and refused while
 *  there are this many, since anyone may register. */
const UNUSED_CAP = 500;
export const SCOPES = ["mcp", "mcp:read"] as const;
/** A Mac's sign-in (F23). Not advertised (MCP clients ask for every scope they're offered), and
 *  granted only when it's all that's asked for. */
const DEVICE_SCOPE = "device";

/** This server's address as the client reached it, behind Render's proxy or not. */
export function origin(req: Request): string {
  const url = new URL(req.url);
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(":", "");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  return `${proto}://${host}`;
}
export const resourceMetadataUrl = (req: Request) => `${origin(req)}/.well-known/oauth-protected-resource/mcp`;

// ── metadata ────────────────────────────────────────────────────────────────────────────────

export function protectedResource(req: Request) {
  const o = origin(req);
  return {
    resource: `${o}/mcp`,
    authorization_servers: [o],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "DO Notes",
    resource_documentation: "https://github.com/DavidROliverBA/commonplace-md/blob/main/docs/MCP.md",
  };
}

export function authorizationServer(req: Request) {
  const o = origin(req);
  return {
    issuer: o,
    authorization_endpoint: `${o}/oauth/authorize`,
    token_endpoint: `${o}/oauth/token`,
    registration_endpoint: `${o}/oauth/register`,
    revocation_endpoint: `${o}/oauth/revoke`,
    scopes_supported: [...SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    code_challenge_methods_supported: ["S256"],
  };
}

/** Is this resource (RFC 8707) this server's MCP endpoint? Left out is fine. */
function forUs(req: Request, resource: string | null | undefined): boolean {
  if (!resource) return true;
  const o = origin(req);
  return [o, `${o}/`, `${o}/mcp`, `${o}/mcp/`].includes(resource);
}

// ── registration ────────────────────────────────────────────────────────────────────────────

/** A redirect a client may register: https anywhere, http only back to this machine (a desktop
 *  client's local listener), or an app's own reverse-domain scheme (com.example.app:/callback). */
export function allowedRedirect(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  return /^[a-z][a-z0-9+-]*(\.[a-z0-9+-]+)+:$/i.test(u.protocol);
}

/** Loopback redirects may come back on any port (RFC 8252 §7.3); everything else must match exactly. */
function redirectMatches(registered: string[], given: string): boolean {
  if (registered.includes(given)) return true;
  let g: URL;
  try {
    g = new URL(given);
  } catch {
    return false;
  }
  if (g.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(g.hostname)) return false;
  return registered.some((r) => {
    const u = new URL(r);
    return u.protocol === "http:" && u.hostname === g.hostname && u.pathname === g.pathname && u.search === g.search;
  });
}

class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}

export async function register(meta: any) {
  const uris: unknown = meta?.redirect_uris;
  if (!Array.isArray(uris) || !uris.length || uris.length > 10 || !uris.every((u) => typeof u === "string" && u.length <= 2000 && allowedRedirect(u)))
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be https addresses, http on localhost, or an app's own scheme");
  const method = meta.token_endpoint_auth_method ?? "client_secret_basic";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(method)) throw new OAuthError("invalid_client_metadata", `token_endpoint_auth_method ${method} isn't supported`);
  const grants: string[] = meta.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grants) || !grants.includes("authorization_code") || grants.some((g) => !["authorization_code", "refresh_token"].includes(g)))
    throw new OAuthError("invalid_client_metadata", "grant_types may be authorization_code and refresh_token");
  const name = String(meta.client_name ?? "").trim().slice(0, 80) || new URL(uris[0] as string).hostname || "MCP client";

  await sql`delete from oauth_clients c where created_at < now() - interval '1 day' and not exists (select 1 from api_tokens t where t.client_id = c.id)`;
  const [{ n }] = (await sql`select count(*)::int as n from oauth_clients c where not exists (select 1 from api_tokens t where t.client_id = c.id)`) as unknown as [{ n: number }];
  if (n >= UNUSED_CAP) throw new OAuthError("temporarily_unavailable", "Too many registrations; try again tomorrow", 429);

  const clientId = `cpo_${randomBytes(16).toString("base64url")}`;
  const secret = method === "none" ? null : `cps_${randomBytes(32).toString("base64url")}`;
  const [row] = await sql`
    insert into oauth_clients (id, name, redirect_uris, secret_hash)
    values (${clientId}, ${name}, ${uris as string[]}, ${secret ? hashToken(secret) : null})
    returning extract(epoch from created_at)::bigint as at`;
  return {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Number(row!.at),
    client_name: name,
    redirect_uris: uris,
    token_endpoint_auth_method: method,
    grant_types: grants,
    response_types: ["code"],
  };
}

// ── authorization (the consent page) ───────────────────────────────────────────────────────

export interface AuthRequest {
  response_type?: string;
  client_id?: string;
  redirect_uri?: string;
  code_challenge?: string;
  code_challenge_method?: string;
  state?: string;
  scope?: string;
  resource?: string;
}

/** Check an authorization request and say who's asking, for the consent page. A problem with the
 *  client or its redirect is shown on the page, never sent to an address we can't trust. */
export async function checkRequest(req: Request, r: AuthRequest) {
  const [client] = r.client_id ? await sql`select id, name, redirect_uris from oauth_clients where id = ${r.client_id}` : [];
  if (!client) throw new HttpError(400, "This app isn't registered with DO Notes. Try adding the connector again.");
  const redirectUri = r.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!redirectMatches(client.redirect_uris, redirectUri)) throw new HttpError(400, "This app asked to return to an address it didn't register.");
  if (r.response_type !== "code") throw new HttpError(400, "This app asked for a kind of sign-in DO Notes doesn't offer (response_type must be code).");
  if (!r.code_challenge || r.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(r.code_challenge))
    throw new HttpError(400, "This app didn't send a PKCE challenge (S256), which DO Notes needs.");
  if (!forUs(req, r.resource)) throw new HttpError(400, "This app asked for access to another server.");
  const asked = (r.scope ?? "").split(/\s+/).filter(Boolean);
  const device = asked.length === 1 && asked[0] === DEVICE_SCOPE;
  const readOnly = !device && asked.length > 0 && !asked.includes("mcp") && asked.includes("mcp:read");
  return { name: client.name as string, returnsTo: new URL(redirectUri).host || new URL(redirectUri).protocol.replace(":", ""), redirectUri, readOnly, device };
}

const withParams = (uri: string, params: Record<string, string | undefined>) => {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined) u.searchParams.set(k, v);
  return u.toString();
};

/** The person's answer: a code for the client, or "access denied", as the address to go back to. */
export async function decide(req: Request, user: User, r: AuthRequest, allow: boolean, readOnly: boolean): Promise<string> {
  const c = await checkRequest(req, r);
  const iss = origin(req);
  if (!allow) return withParams(c.redirectUri, { error: "access_denied", error_description: "The person declined", state: r.state, iss });
  const code = randomBytes(32).toString("base64url");
  await sql`delete from oauth_codes where expires_at < now()`;
  await sql`
    insert into oauth_codes (code_hash, client_id, user_id, redirect_uri, challenge, scope, expires_at)
    values (${hashToken(code)}, ${r.client_id!}, ${user.id}, ${c.redirectUri}, ${r.code_challenge!}, ${c.device ? "device" : readOnly || c.readOnly ? "mcp:read" : "mcp"},
            now() + make_interval(secs => ${CODE_SECONDS}))`;
  return withParams(c.redirectUri, { code, state: r.state, iss });
}

// ── tokens ──────────────────────────────────────────────────────────────────────────────────

/** Which registered client is calling the token or revocation endpoint, with its secret if it has one. */
async function callingClient(req: Request, form: URLSearchParams) {
  let id = form.get("client_id") ?? "";
  let secret = form.get("client_secret");
  const basic = /^Basic\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1];
  if (basic) {
    const [u, p] = Buffer.from(basic, "base64").toString().split(":");
    id = decodeURIComponent(u ?? "");
    secret = decodeURIComponent(p ?? "");
  }
  const [client] = id ? await sql`select id, name, secret_hash from oauth_clients where id = ${id}` : [];
  if (!client) throw new OAuthError("invalid_client", "Unknown client", 401);
  if (client.secret_hash && (!secret || hashToken(secret) !== client.secret_hash)) throw new OAuthError("invalid_client", "Wrong client secret", 401);
  return client as { id: string; name: string };
}

const pkce = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** A device sign-in's access token is cpd_ (the app's API), any other cpm_ (MCP): each is
 *  refused where the other is read. */
function issue(scope: string) {
  return { access: `${scope === "device" ? "cpd_" : "cpm_"}${randomBytes(32).toString("base64url")}`, refresh: `cpr_${randomBytes(32).toString("base64url")}` };
}
const tokenResponse = (t: { access: string; refresh: string }, scope: string) => ({
  access_token: t.access,
  token_type: "Bearer",
  expires_in: ACCESS_SECONDS,
  refresh_token: t.refresh,
  scope,
});

export async function token(req: Request, form: URLSearchParams) {
  const client = await callingClient(req, form);
  const grant = form.get("grant_type");
  if (!forUs(req, form.get("resource"))) throw new OAuthError("invalid_target", "That resource isn't this server");

  if (grant === "authorization_code") {
    const code = form.get("code") ?? "";
    const verifier = form.get("code_verifier") ?? "";
    const [c] = await sql`delete from oauth_codes where code_hash = ${hashToken(code)} returning client_id, user_id, redirect_uri, challenge, scope, expires_at > now() as live`;
    if (!c || !c.live || c.client_id !== client.id) throw new OAuthError("invalid_grant", "That code isn't valid (it may have been used or expired)");
    if (form.has("redirect_uri") && form.get("redirect_uri") !== c.redirect_uri) throw new OAuthError("invalid_grant", "redirect_uri doesn't match");
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || pkce(verifier) !== c.challenge) throw new OAuthError("invalid_grant", "The PKCE verifier doesn't match");
    const t = issue(c.scope);
    await sql`
      insert into api_tokens (user_id, vault_id, name, scope, token_hash, refresh_hash, client_id, expires_at)
      values (${c.user_id}, null, ${client.name}, ${c.scope}, ${hashToken(t.access)}, ${hashToken(t.refresh)}, ${client.id},
              now() + make_interval(secs => ${ACCESS_SECONDS}))`;
    return tokenResponse(t, c.scope);
  }

  if (grant === "refresh_token") {
    const [was] = await sql`select scope from api_tokens where refresh_hash = ${hashToken(form.get("refresh_token") ?? "")} and client_id = ${client.id}`;
    const t = issue(was?.scope ?? "mcp");
    // The old refresh token stops working as the new one is made (rotation, as OAuth 2.1 asks of
    // clients without a secret); a revoked connection has no row, so nothing comes back.
    const [row] = await sql`
      update api_tokens set token_hash = ${hashToken(t.access)}, refresh_hash = ${hashToken(t.refresh)},
                            expires_at = now() + make_interval(secs => ${ACCESS_SECONDS})
      where refresh_hash = ${hashToken(form.get("refresh_token") ?? "")} and client_id = ${client.id}
      returning scope`;
    if (!row) throw new OAuthError("invalid_grant", "That refresh token isn't valid; sign in again");
    return tokenResponse(t, row.scope);
  }

  throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
}

/** RFC 7009: forget a token the client holds (either kind). Unknown tokens are fine, as the RFC says. */
export async function revoke(req: Request, form: URLSearchParams) {
  const client = await callingClient(req, form);
  const h = hashToken(form.get("token") ?? "");
  const gone = await sql`delete from api_tokens where client_id = ${client.id} and (token_hash = ${h} or refresh_hash = ${h}) returning id`;
  for (const g of gone) kick({ sessionHash: socketKey(Number(g.id)) }, "signed out");
}

// ── routes ──────────────────────────────────────────────────────────────────────────────────

// Called by clients' servers and, for the metadata, sometimes their browser pages: no cookies
// are read here, so any origin may call.
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, content-type, mcp-protocol-version", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });
const preflight = () => new Response(null, { status: 204, headers: CORS });

function endpoint(fn: (req: Request, form: URLSearchParams) => Promise<unknown>) {
  return async (req: Request) => {
    try {
      const type = req.headers.get("content-type") ?? "";
      const form = type.includes("json") ? new URLSearchParams((await req.json()) as Record<string, string>) : new URLSearchParams(await req.text());
      const out = await fn(req, form);
      return out === undefined ? new Response(null, { status: 200, headers: CORS }) : reply(out);
    } catch (e) {
      if (e instanceof OAuthError) return reply({ error: e.code, error_description: e.message }, e.status);
      console.error(`${new URL(req.url).pathname} failed:`, e);
      return reply({ error: "server_error", error_description: "Something went wrong on the server" }, 500);
    }
  };
}

export const oauthRoutes = {
  "/.well-known/oauth-protected-resource": { GET: (req: Request) => reply(protectedResource(req)), OPTIONS: preflight },
  "/.well-known/oauth-protected-resource/mcp": { GET: (req: Request) => reply(protectedResource(req)), OPTIONS: preflight },
  "/.well-known/oauth-authorization-server": { GET: (req: Request) => reply(authorizationServer(req)), OPTIONS: preflight },
  "/oauth/register": {
    POST: async (req: Request) => {
      try {
        return reply(await register(await req.json().catch(() => null)), 201);
      } catch (e) {
        if (e instanceof OAuthError) return reply({ error: e.code, error_description: e.message }, e.status);
        console.error("/oauth/register failed:", e);
        return reply({ error: "server_error", error_description: "Something went wrong on the server" }, 500);
      }
    },
    OPTIONS: preflight,
  },
  "/oauth/token": { POST: endpoint(token), OPTIONS: preflight },
  "/oauth/revoke": { POST: endpoint(revoke), OPTIONS: preflight },
};
