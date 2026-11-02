// Bearer tokens for clients that aren't the browser (docs/PRINCIPLES.md §10). Per person,
// revocable, shown once and stored only as SHA-256 hashes, and always sent in an
// `Authorization: Bearer` header, never in a URL. Two kinds today:
//   capture (cpc_…): the iPhone Shortcut; can only append to one note in one vault (src/capture.ts)
//   mcp (cpm_…):     Claude and other agents over MCP (src/mcp.ts); every vault the person can
//                    see, read-only ("mcp:read") or read and write ("mcp"). Made here by hand, or
//                    by an app signing in (src/oauth.ts), whose rows name the client and whose
//                    access token expires within the hour (its refresh token makes the next one)
//   device (cpd_…):  a Mac's Commonplace showing the person's cloud collections (F23); made only
//                    by signing in (src/oauth.ts). Opens the app's own vault API, events and live
//                    socket as the person (requestUser), never Settings, Admin or /mcp

import { randomBytes } from "node:crypto";
import { currentUser, hashToken, HttpError, type User } from "./auth";
import { kick } from "./collab";
import { sql } from "./db";
import { normalisePath } from "./markdown";
import * as vaults from "./vaults";

export type Kind = "capture" | "mcp" | "device";
const PREFIX: Record<Kind, string> = { capture: "cpc_", mcp: "cpm_", device: "cpd_" };
const SCOPES: Record<Kind, string[]> = { capture: ["capture"], mcp: ["mcp", "mcp:read"], device: ["device"] };

export interface ApiToken {
  id: number;
  name: string;
  scope: string;
  vault_id: number | null;
  vault_name: string | null;
  note_path: string | null;
  created_at: string;
  last_used_at: string | null;
  /** Made by an app signing in (F25): where it sends people back to, such as claude.ai. */
  app: string | null;
}

export async function listTokens(userId: number): Promise<ApiToken[]> {
  return sql<ApiToken[]>`
    select t.id, t.name, t.scope, t.vault_id, v.name as vault_name, case when t.scope = 'capture' then t.note_path end as note_path,
           t.created_at, t.last_used_at, c.redirect_uris[1] as app
    from api_tokens t left join vaults v on v.id = t.vault_id left join oauth_clients c on c.id = t.client_id
    where t.user_id = ${userId} order by t.created_at`.then((rows) => rows.map((r) => ({ ...r, app: appHost(r.app) })));
}

const appHost = (uri: string | null) => {
  if (!uri) return null;
  try {
    const u = new URL(uri);
    return u.host || u.protocol.replace(":", "");
  } catch {
    return null;
  }
};

/** Make a token. Its value is returned this once and never stored. */
export async function createToken(
  user: User,
  input: { kind: Kind; name: string; vaultId?: number; notePath?: string; readOnly?: boolean },
): Promise<{ token: string; row: ApiToken }> {
  let vaultId: number | null = null;
  let notePath = "Inbox.md";
  let scope = "capture";
  if (input.kind === "capture") {
    // No collection means the person's home collection, whichever that is when a share arrives (F20).
    if (input.vaultId) {
      await vaults.requireRole(input.vaultId, user, "editor");
      vaultId = input.vaultId;
    }
    notePath = normalisePath(input.notePath?.trim() || "Inbox");
  } else scope = input.readOnly ? "mcp:read" : "mcp";
  const token = PREFIX[input.kind] + randomBytes(32).toString("base64url");
  const fallback = input.kind === "capture" ? "iPhone" : "Claude";
  const [r] = await sql`
    insert into api_tokens (user_id, vault_id, name, scope, token_hash, note_path)
    values (${user.id}, ${vaultId}, ${input.name.trim() || fallback}, ${scope}, ${hashToken(token)}, ${notePath})
    returning id`;
  return { token, row: (await listTokens(user.id)).find((t) => t.id === Number(r!.id))! };
}

export async function revokeToken(userId: number, id: number): Promise<void> {
  const r = await sql`delete from api_tokens where id = ${id} and user_id = ${userId} returning id`;
  if (!r.length) throw new HttpError(404, "Token not found");
  kick({ sessionHash: socketKey(id) }, "signed out");
}

/** Who a request's bearer token belongs to, for one kind of token; 401 otherwise. */
export async function authenticateToken(req: Request, kind: Kind) {
  const label = kind === "capture" ? "capture" : kind === "device" ? "device" : "MCP";
  const given = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "")?.[1] ?? "";
  if (!given.startsWith(PREFIX[kind])) throw new HttpError(401, `Add your ${label} token as an Authorization: Bearer header`);
  const [t] = await sql`
    update api_tokens set last_used_at = now()
    where token_hash = ${hashToken(given)} and scope = any(${SCOPES[kind]}) and (expires_at is null or expires_at > now())
    returning id, user_id, vault_id, note_path, scope`;
  if (!t) throw new HttpError(401, `This ${label} token isn't valid. It may have expired or been revoked; sign in again, or make a new one in Settings → Connections.`);
  const [user] = await sql<User[]>`select id, email, name, is_admin from users where id = ${t.user_id}`;
  return { id: Number(t.id), user: user!, scope: t.scope as string, vaultId: t.vault_id === null ? null : Number(t.vault_id), notePath: t.note_path as string };
}

/** The name a token's live sockets go by, so revoking it closes them (collab.ts kick). By row,
 *  since an access token made by signing in is replaced every hour. */
export const socketKey = (tokenId: number) => `token:${tokenId}`;

/** Who's asking, for the routes a Mac's Commonplace may reach in its person's name (F23): the
 *  browser's session, or else a device token. Settings, Admin and /mcp use requireUser and never
 *  see a device. */
export async function requestUser(req: Request): Promise<{ user: User; deviceToken: number | null } | null> {
  const user = await currentUser(req);
  if (user) return { user, deviceToken: null };
  if (!/^Bearer\s+cpd_\S+$/i.test(req.headers.get("authorization") ?? "")) return null;
  const t = await authenticateToken(req, "device");
  return { user: t.user, deviceToken: t.id };
}
