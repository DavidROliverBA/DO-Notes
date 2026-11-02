// Send to Longview (F30 step 4, opt-in): a Weblink note's address saved into the person's
// Longview with its save_url tool, so a page found here is in their knowledge base at once. Only
// the public address goes (and, if the person types one when sending, why it's worth keeping):
// never the note. It needs a second Longview token, one that can save, kept sealed beside the
// read-only connection and used for nothing but save_url, so the assistant's connection stays
// read-only (src/connections.ts refuses a token that can change Longview there).

import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { McpClient, McpError } from "./mcpClient";
import { open, seal } from "./secrets";

const NEEDS = "Connect Longview first (Settings → Connections), then add a token that can save.";

async function longview(userId: number) {
  const [c] = await sql`select id, address, send_enc, send_hint from connections where user_id = ${userId} and preset = 'longview'`;
  return c ?? null;
}

export async function sendState(userId: number) {
  const c = await longview(userId);
  return { connected: !!c, on: !!c?.send_enc, hint: c?.send_hint ?? null };
}

/** Keep the token that can save, after checking it offers save_url at the connection's address. */
export async function setSendToken(userId: number, raw: string) {
  const c = await longview(userId);
  if (!c) throw new HttpError(400, NEEDS);
  const token = raw.trim();
  if (token.length < 8) throw new HttpError(400, "Paste a Longview token that can save (one of its MCP write tokens).");
  let names: string[];
  try {
    names = (await new McpClient(new URL(c.address), token).listTools()).map((t) => t.name);
  } catch (e) {
    throw new HttpError(400, e instanceof McpError ? `Longview: ${e.message}` : "Couldn't reach Longview with that token");
  }
  if (!names.includes("save_url")) throw new HttpError(400, "That token can only read: Longview didn't offer it save_url. Use one of its write tokens.");
  await sql`update connections set send_enc = ${seal(token)}, send_hint = ${token.slice(-4)} where id = ${c.id}`;
  return sendState(userId);
}

export async function clearSendToken(userId: number) {
  await sql`update connections set send_enc = null, send_hint = null where user_id = ${userId} and preset = 'longview'`;
  return sendState(userId);
}

/** The page address of a Weblink note, or a 400 saying why there isn't one to send. */
export function pageAddress(type: string | null, frontmatter: Record<string, unknown> | null): string {
  if ((type ?? "").toLowerCase() !== "weblink") throw new HttpError(400, "Only a Weblink note can be sent to Longview.");
  const raw = String(frontmatter?.url ?? "").trim();
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "This Weblink note has no web address to send.");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new HttpError(400, "Only web pages (http or https) can be sent to Longview.");
  if (u.username || u.password) throw new HttpError(400, "That address has a sign-in in it, so it isn't sent.");
  return u.toString();
}

export async function sendNote(user: User, vaultId: number, noteId: number, why = ""): Promise<{ url: string; message: string }> {
  const [n] = await sql`select type_name, frontmatter from notes where id = ${noteId} and vault_id = ${vaultId}`;
  if (!n) throw new HttpError(404, "Not found");
  const url = pageAddress(n.type_name, n.frontmatter);
  const c = await longview(user.id);
  if (!c?.send_enc) throw new HttpError(400, "Send to Longview is off. Turn it on in Settings → Connections → Longview.");
  let token: string;
  try {
    token = open(c.send_enc);
  } catch {
    throw new HttpError(409, "The Longview token for sending can't be read any more. Add it again in Settings → Connections → Longview.");
  }
  const args: Record<string, unknown> = { url };
  if (why.trim()) args.note = why.trim().slice(0, 500);
  let out: unknown;
  try {
    out = await new McpClient(new URL(c.address), token).call("save_url", args);
  } catch (e) {
    throw new HttpError(502, e instanceof McpError ? `Longview didn't save it: ${e.message}` : "Couldn't reach Longview");
  }
  const said = typeof out === "string" ? out : (out as { title?: string; message?: string })?.message ?? (out as { title?: string })?.title ?? "";
  return { url, message: String(said).slice(0, 200) };
}
