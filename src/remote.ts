// The cloud library, seen from the Mac (F23). The Mac's Commonplace signs in to the person's cloud
// Commonplace (OAuth with the "device" scope, src/oauth.ts there) and shows its collections in the
// same menu as the Mac's own. The browser only ever talks to the Mac: for a cloud collection the
// Mac forwards the app's own requests, events and live socket to the cloud, in the person's name.
//
//   remote_links   one per person: the cloud's address, its token endpoints, and the device
//                  token pair, sealed with SECRETS_KEY. The access token is refreshed (and
//                  replaced, as is its refresh token) when it's about to expire, once at a time.
//   remote_vaults  each cloud collection under a local id from the vaults sequence, so it can
//                  never be mistaken for a Mac collection: it has no vaults row, so MCP, the AI,
//                  backups and every local check leave it alone. Kept so the menu still lists them
//                  while the cloud can't be reached.
//   forward        only the routes on ALLOWED; publishing, GitHub, imports and members are done
//                  in the cloud. Cookies and Origin never leave the Mac; the token goes only in
//                  the Authorization header, to the address that was checked (src/egress.ts).

import { createHash, randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import type * as between from "./between";
import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { EgressError, pinnedFetch, vetAddresses } from "./egress";
import { open, seal } from "./secrets";
import { settings } from "./settings";

export interface CloudVault {
  id: number;
  name: string;
  role: "owner" | "editor" | "viewer";
  note_count: number;
  member_count: number;
  /** In the cloud library (F23), reached through this Mac. */
  cloud: true;
  /** Your id in the cloud, where it differs from yours here. */
  me: number;
  /** The cloud couldn't be reached just now: this is the list as it was last seen. */
  offline?: boolean;
}

interface Link {
  id: number;
  user_id: number;
  url: string;
  client_id: string;
  token_url: string;
  revoke_url: string | null;
  access: string;
  refresh: string;
  expires_at: Date;
  cloud_user_id: number | null;
  cloud_email: string | null;
  library: string | null;
}

/** Cloud collections forwarded for, by alias id: whose they are and which they are there. */
const aliases = new Map<number, { userId: number; linkId: number; remoteId: number }>();

export const isCloudVault = (id: number) => aliases.has(id);

/** Load the aliases at boot, so a cloud collection's address works before its list is fetched. */
export async function loadAliases(): Promise<void> {
  if (!settings.cloudLink) return;
  for (const r of await sql`select r.id, r.remote_id, l.id as link_id, l.user_id from remote_vaults r join remote_links l on l.id = r.link_id`)
    aliases.set(Number(r.id), { userId: Number(r.user_id), linkId: Number(r.link_id), remoteId: Number(r.remote_id) });
}

// ── reaching the cloud ───────────────────────────────────────────────────────────────────────

const localAllowed = () => process.env.ALLOW_LOCAL_CLOUD === "true";

export class Unreachable extends Error {}

/** A request to the cloud: to an address checked as public (unless ALLOW_LOCAL_CLOUD), never
 *  following redirects, with the device token in the header. */
async function cloudFetch(url: URL, init: BunFetchRequestInit = {}): Promise<Response> {
  if (url.protocol !== "https:" && !(localAllowed() && url.protocol === "http:")) throw new HttpError(400, "The cloud library's address must start with https://");
  let addrs: string[];
  try {
    addrs = await vetAddresses(url, { allowPrivate: localAllowed() });
  } catch (e) {
    if (e instanceof EgressError && e.reason === "private") throw new HttpError(400, "That address isn't on the public web");
    throw new Unreachable(`Couldn't reach ${url.host}`);
  }
  try {
    return await pinnedFetch(url, addrs, { ...init, redirect: "manual" });
  } catch {
    throw new Unreachable(`Couldn't reach ${url.host}`);
  }
}

/** A cloud library's address as typed: "notes.example.com" → "https://notes.example.com". */
export function cleanUrl(raw: string): string {
  let s = raw.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    throw new HttpError(400, "That isn't a web address");
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== "/")) throw new HttpError(400, "Give just the address, such as https://notes.example.com");
  return u.origin;
}

async function linkOf(userId: number): Promise<Link | null> {
  const [l] = await sql<Link[]>`select * from remote_links where user_id = ${userId}`;
  return l ? { ...l, id: Number(l.id), user_id: Number(l.user_id), cloud_user_id: l.cloud_user_id === null ? null : Number(l.cloud_user_id) } : null;
}

const refreshing = new Map<number, Promise<string>>();

/** The link's access token, refreshed first if it's about to expire (one refresh at a time:
 *  each refresh token works once). */
async function accessToken(link: Link, force = false): Promise<string> {
  if (!force && link.expires_at.getTime() - Date.now() > 60_000) return open(link.access);
  const running = refreshing.get(link.id);
  if (running) return running;
  const p = (async () => {
    const res = await cloudFetch(new URL(link.token_url), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: open(link.refresh), client_id: link.client_id }),
    });
    const t = (await res.json().catch(() => ({}))) as any;
    if (!res.ok || !String(t.access_token ?? "").startsWith("cpd_")) throw new HttpError(401, "The cloud library signed this Mac out. Sign in again in Settings → Connections.");
    await sql`update remote_links set access = ${seal(t.access_token)}, refresh = ${seal(t.refresh_token)}, expires_at = now() + make_interval(secs => ${Number(t.expires_in) || 3600}) where id = ${link.id}`;
    return String(t.access_token);
  })().finally(() => refreshing.delete(link.id));
  refreshing.set(link.id, p);
  return p;
}

/** Call the cloud's API as the person; a token that has just expired is refreshed once. */
async function cloudApi(link: Link, path: string, init: BunFetchRequestInit = {}): Promise<Response> {
  const go = async (force: boolean) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${await accessToken(link, force)}`);
    return cloudFetch(new URL(`${link.url}/api${path}`), { ...init, headers });
  };
  const res = await go(false);
  return res.status === 401 ? go(true) : res;
}

// ── signing in ───────────────────────────────────────────────────────────────────────────────

const pending = new Map<string, { userId: number; url: string; clientId: string; verifier: string; redirectUri: string; tokenUrl: string; revokeUrl: string | null; at: number }>();

/** Start signing in to a cloud library: register this Mac there and say where to send the
 *  person to allow it. */
export async function connect(user: User, rawUrl: string, name: string, redirectUri: string): Promise<{ authorize: string }> {
  if (!settings.cloudLink) throw new HttpError(404, "Not found");
  const url = cleanUrl(rawUrl);
  const meta = (await (await cloudFetch(new URL(`${url}/.well-known/oauth-authorization-server`))).json().catch(() => null)) as any;
  const same = (u: unknown) => typeof u === "string" && new URL(u).origin === url;
  if (!meta || !same(meta.authorization_endpoint) || !same(meta.token_endpoint) || !same(meta.registration_endpoint)) throw new HttpError(400, "That address isn't a DO Notes library");
  const reg = (await (
    await cloudFetch(new URL(meta.registration_endpoint), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: name.trim().slice(0, 60) || "DO Notes on a Mac", redirect_uris: [redirectUri], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] }),
    })
  ).json()) as any;
  if (!reg?.client_id) throw new HttpError(502, "The cloud library wouldn't register this Mac");
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  for (const [k, v] of pending) if (Date.now() - v.at > 10 * 60_000) pending.delete(k);
  pending.set(state, { userId: user.id, url, clientId: reg.client_id, verifier, redirectUri, tokenUrl: meta.token_endpoint, revokeUrl: same(meta.revocation_endpoint) ? meta.revocation_endpoint : null, at: Date.now() });
  const a = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: redirectUri, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", state, scope: "device" })) a.searchParams.set(k, v);
  return { authorize: a.toString() };
}

/** Sign-ins in progress or just finished, by state: a browser may load the return address twice
 *  at once, and the second must wait for the first and say how it went, not that it expired. */
const finishing = new Map<string, { userId: number; at: number; done: Promise<void> }>();

/** The cloud sent the person back: swap the code for the device token, and keep it. */
export async function callback(user: User, params: URLSearchParams): Promise<void> {
  const state = params.get("state") ?? "";
  for (const [k, v] of finishing) if (Date.now() - v.at > 5 * 60_000) finishing.delete(k);
  const already = finishing.get(state);
  if (already && already.userId === user.id) return already.done;
  const done = finishSignIn(user, state, params);
  finishing.set(state, { userId: user.id, at: Date.now(), done });
  return done;
}

async function finishSignIn(user: User, state: string, params: URLSearchParams): Promise<void> {
  const p = pending.get(state);
  if (!p || p.userId !== user.id) throw new HttpError(400, "That sign-in has expired; start again in Settings → Connections");
  pending.delete(state);
  if (params.get("error")) throw new HttpError(400, "The cloud library wasn't allowed");
  const res = await cloudFetch(new URL(p.tokenUrl), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code: params.get("code") ?? "", code_verifier: p.verifier, client_id: p.clientId, redirect_uri: p.redirectUri }),
  });
  const t = (await res.json().catch(() => ({}))) as any;
  if (!res.ok || !String(t.access_token ?? "").startsWith("cpd_")) throw new HttpError(502, "The cloud library didn't sign this Mac in");
  const me = (await (await cloudFetch(new URL(`${p.url}/api/session`), { headers: { authorization: `Bearer ${t.access_token}` } })).json()) as any;
  await disconnect(user).catch(() => {});
  await sql`insert into remote_links (user_id, url, client_id, token_url, revoke_url, access, refresh, expires_at, cloud_user_id, cloud_email, library)
            values (${user.id}, ${p.url}, ${p.clientId}, ${p.tokenUrl}, ${p.revokeUrl}, ${seal(t.access_token)}, ${seal(t.refresh_token)},
                    now() + make_interval(secs => ${Number(t.expires_in) || 3600}), ${me?.user?.id ?? null}, ${me?.user?.email ?? null}, ${me?.library || null})`;
  await cloudVaults(user.id);
}

/** Sign this Mac out of the cloud library: the tokens are revoked there and forgotten here. */
export async function disconnect(user: User): Promise<void> {
  const link = await linkOf(user.id);
  if (!link) return;
  if (link.revoke_url)
    for (const tok of [link.refresh, link.access])
      await cloudFetch(new URL(link.revoke_url), { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: open(tok), client_id: link.client_id }) }).catch(() => {});
  for (const [id, a] of aliases) if (a.linkId === link.id) aliases.delete(id);
  closeSockets(user.id);
  await sql`delete from remote_links where id = ${link.id}`;
}

export async function linkStatus(userId: number) {
  const l = await linkOf(userId);
  return { available: settings.cloudLink, link: l ? { url: l.url, email: l.cloud_email, library: l.library } : null };
}

// ── the collections ──────────────────────────────────────────────────────────────────────────

/** The person's cloud collections, under their Mac ids; the last list seen if the cloud can't be
 *  reached, and none if this Mac isn't signed in. */
export async function cloudVaults(userId: number): Promise<CloudVault[]> {
  if (!settings.cloudLink) return [];
  const link = await linkOf(userId);
  if (!link) return [];
  const me = link.cloud_user_id ?? 0;
  try {
    const res = await cloudApi(link, "/vaults");
    if (!res.ok) throw new Unreachable(`status ${res.status}`);
    const list = (await res.json()) as { id: number; name: string; role: CloudVault["role"]; note_count: number; member_count: number }[];
    for (const v of list)
      await sql`insert into remote_vaults (link_id, remote_id, name, role, note_count, member_count) values (${link.id}, ${v.id}, ${v.name}, ${v.role}, ${v.note_count}, ${v.member_count})
                on conflict (link_id, remote_id) do update set name = excluded.name, role = excluded.role, note_count = excluded.note_count, member_count = excluded.member_count`;
    const keep = list.map((v) => v.id);
    const gone = await sql`delete from remote_vaults where link_id = ${link.id} and not (remote_id = any(${keep}::bigint[])) returning id`;
    for (const g of gone) aliases.delete(Number(g.id));
    return (await stored(link)).map((v) => ({ ...v, me }));
  } catch (e) {
    if (e instanceof HttpError && e.status === 401) throw e;
    return (await stored(link)).map((v) => ({ ...v, me, offline: true }));
  }
}

async function stored(link: Link): Promise<Omit<CloudVault, "me">[]> {
  const rows = await sql`select id, remote_id, name, role, note_count, member_count from remote_vaults where link_id = ${link.id} order by name`;
  for (const r of rows) aliases.set(Number(r.id), { userId: link.user_id, linkId: link.id, remoteId: Number(r.remote_id) });
  return rows.map((r) => ({ id: Number(r.id), name: r.name, role: r.role, note_count: r.note_count, member_count: r.member_count, cloud: true as const }));
}

/** Which cloud collection (and through which link) a Mac id stands for, if it's the person's. */
export async function resolveCloud(user: User, aliasId: number): Promise<{ link: Link; remoteId: number }> {
  const a = aliases.get(aliasId);
  if (!a || a.userId !== user.id) throw new HttpError(404, "Not found");
  const link = await linkOf(user.id);
  if (!link || link.id !== a.linkId) throw new HttpError(404, "Not found");
  return { link, remoteId: a.remoteId };
}

// ── forwarding the app's requests ────────────────────────────────────────────────────────────

/** What a cloud collection can do from the Mac, by the first part of its path (and method). */
const ALLOWED = new Set(["bookmarks", "bundle", "dataview", "days", "events", "export", "files", "folders", "graph", "journal", "linkcard", "notes", "receive", "resolve", "search", "searches", "suggest", "tags", "tasks", "trash", "types", "weblinks"]);
function allowed(method: string, rest: string[]): boolean {
  if (!rest.length || rest[0] === "members") return method === "GET"; // renaming, deleting and members are done in the cloud
  if (rest[0] === "journal" && rest[1] === "import") return false;
  return ALLOWED.has(rest[0]!);
}

/** Forward a request about a cloud collection, as the person, and pass the answer back. */
export async function forward(req: Request, user: User, aliasId: number): Promise<Response> {
  const { link, remoteId } = await resolveCloud(user, aliasId);
  const url = new URL(req.url);
  const rest = url.pathname.split("/").slice(4); // "", "api", "vaults", ":v", …
  if (!allowed(req.method, rest)) return Response.json({ error: "Do that in the cloud library itself" }, { status: 404 });
  const headers = new Headers();
  for (const h of ["content-type", "accept", "last-event-id"]) {
    const v = req.headers.get(h);
    if (v) headers.set(h, v);
  }
  const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.arrayBuffer();
  let res: Response;
  try {
    res = await cloudApi(link, `/vaults/${remoteId}${rest.length ? "/" + rest.join("/") : ""}${url.search}`, { method: req.method, headers, body, signal: req.signal });
  } catch (e) {
    if (e instanceof Unreachable) return Response.json({ error: "The cloud library can't be reached just now" }, { status: 503, headers: { "X-Cloud-Unreachable": "1" } });
    throw e;
  }
  const out = new Headers();
  for (const h of ["content-type", "content-disposition", "cache-control", "content-security-policy", "x-content-type-options"]) {
    const v = res.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(res.body, { status: res.status, headers: out });
}

// ── forwarding the live socket ───────────────────────────────────────────────────────────────

export interface ProxyData {
  kind: "proxy";
  userId: number;
  target: string;
  token: string;
  upstream?: WebSocket;
  queue: (string | ArrayBuffer)[];
}

const sockets = new Map<number, Set<ServerWebSocket<ProxyData>>>();

/** For an upgrade to /ws/:noteId?v=<cloud collection>: where to connect, as the person. */
export async function socketTarget(user: User, aliasId: number, noteId: number): Promise<ProxyData> {
  const { link } = await resolveCloud(user, aliasId);
  const u = new URL(`${link.url}/ws/${noteId}`);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  // A socket can't be pinned to an address, so the name is checked just before connecting.
  try {
    await vetAddresses(new URL(link.url), { allowPrivate: localAllowed() });
  } catch {
    throw new HttpError(503, "The cloud library can't be reached just now");
  }
  return { kind: "proxy", userId: user.id, target: u.toString(), token: await accessToken(link), queue: [] };
}

export function socketOpen(ws: ServerWebSocket<ProxyData>) {
  let set = sockets.get(ws.data.userId);
  if (!set) sockets.set(ws.data.userId, (set = new Set()));
  set.add(ws);
  const up = new WebSocket(ws.data.target, { headers: { authorization: `Bearer ${ws.data.token}` } } as any);
  up.binaryType = "arraybuffer";
  ws.data.upstream = up;
  up.onopen = () => {
    for (const m of ws.data.queue.splice(0)) up.send(m as string | ArrayBuffer);
  };
  up.onmessage = (e) => ws.send(e.data as ArrayBuffer);
  // The cloud's reasons (note deleted 4404, access changed 44xx) reach the editor unchanged.
  up.onclose = (e) => ws.close(e.code >= 4000 && e.code < 5000 ? e.code : 1011, e.reason || "the cloud closed the connection");
  up.onerror = () => {};
}

export function socketMessage(ws: ServerWebSocket<ProxyData>, msg: string | Buffer) {
  const up = ws.data.upstream;
  const data = typeof msg === "string" ? msg : (new Uint8Array(msg).slice().buffer as ArrayBuffer);
  if (up?.readyState === WebSocket.OPEN) up.send(data);
  else if (ws.data.queue.length < 1000) ws.data.queue.push(data);
}

export function socketClose(ws: ServerWebSocket<ProxyData>) {
  sockets.get(ws.data.userId)?.delete(ws);
  try {
    ws.data.upstream?.close();
  } catch {}
}

function closeSockets(userId: number) {
  for (const ws of sockets.get(userId) ?? []) ws.close(4401, "signed out of the cloud library");
  sockets.delete(userId);
}

// ── moving notes between the Mac and the cloud ───────────────────────────────────────────────

export interface CrossSend {
  from: number;
  to: number;
  notes?: number[];
  folder?: string;
  into: string;
  move: boolean;
  dryRun: boolean;
}

/** Copy or move notes between a Mac collection and a cloud one (or two cloud ones): taken as a
 *  bundle from one side, received by the other, then (moving) each original to Trash where it
 *  was. The answer has send()'s shape, so the app's Undo works unchanged: its ids are each
 *  side's, and requests about a cloud collection are forwarded. */
export async function crossSend(
  user: User,
  r: CrossSend,
  local: { bundle: typeof between.bundle; receive: typeof between.receive; trash: (vaultId: number, noteId: number) => Promise<number>; name: (vaultId: number) => Promise<string> },
) {
  if (r.from === r.to) throw new HttpError(400, "That's the collection they're in already");
  const side = async (id: number) => (isCloudVault(id) ? { cloud: await resolveCloud(user, id), id } : { cloud: null, id });
  const from = await side(r.from);
  const to = await side(r.to);
  const call = async (s: typeof from, path: string, body?: unknown, method = "POST") => {
    let res: Response;
    try {
      res = await cloudApi(s.cloud!.link, `/vaults/${s.cloud!.remoteId}${path}`, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch (e) {
      if (e instanceof Unreachable) throw new HttpError(503, "The cloud library can't be reached just now");
      throw e;
    }
    const out = (await res.json().catch(() => ({}))) as any;
    if (!res.ok) throw new HttpError(res.status, out.error ?? "The cloud library refused");
    return out;
  };
  const pick = { notes: r.notes, folder: r.folder, move: r.move };
  const b: between.Bundle = from.cloud ? await call(from, "/bundle", pick) : await local.bundle(user, from.id, pick);
  if (!b.notes.length) throw new HttpError(400, "There are no notes to send");
  const toName = to.cloud ? ((await stored(to.cloud.link)).find((v) => v.id === to.id)?.name ?? "the cloud") : await local.name(to.id);
  if (r.dryRun) {
    const what = b.notes.length === 1 ? `“${b.notes[0]!.rel.replace(/^.*\//, "").replace(/\.md$/i, "")}”` : `${b.notes.length} notes`;
    const extras = [b.files.length ? `${b.files.length} file${b.files.length === 1 ? "" : "s"}` : "", b.types.length ? `${b.types.length} type${b.types.length === 1 ? "" : "s"}` : ""].filter(Boolean);
    return { summary: `${r.move ? "Move" : "Copy"} ${what} to ${toName}${extras.length ? `, with ${extras.join(" and ")}` : ""}${r.move ? `; the original${b.notes.length === 1 ? "" : "s"} go${b.notes.length === 1 ? "es" : ""} to Trash` : ""}`, notes: b.notes.length, files: b.files.length, types: b.types.length, linkedFrom: 0 };
  }
  const got = to.cloud ? await call(to, "/receive", { ...b, into: r.into, move: r.move }) : await local.receive(user, to.id, { ...b, into: r.into, move: r.move });
  const trashIds: number[] = [];
  if (r.move)
    for (const n of b.notes) trashIds.push(from.cloud ? Number((await call(from, `/notes/${n.id}`, undefined, "DELETE")).trashId) : await local.trash(from.id, n.id));
  return { from: r.from, to: r.to, move: r.move, created: got.created, files: got.files, trashIds };
}

