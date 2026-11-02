// Passkeys (F32): signing in with Face ID, Touch ID or a security key instead of a password
// (WebAuthn, through @simplewebauthn/server). The server keeps each passkey's public half and
// nothing secret; the challenge for each ceremony lives in memory for five minutes (one
// instance, like the sign-in limits in auth.ts). The relying party is the address the request
// came to, so the cloud and the laptop kit (localhost) each have their own passkeys.

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import { randomBytes } from "node:crypto";
import { HttpError, type User } from "./auth";
import { sql } from "./db";

const CHALLENGE_MS = 5 * 60_000;
const challenges = new Map<string, { challenge: string; until: number; rpID: string; origin: string }>();

function keep(key: string, value: { challenge: string; rpID: string; origin: string }) {
  const now = Date.now();
  for (const [k, v] of challenges) if (v.until < now) challenges.delete(k);
  if (challenges.size > 10_000) challenges.delete(challenges.keys().next().value!);
  challenges.set(key, { ...value, until: now + CHALLENGE_MS });
}

function take(key: string) {
  const c = challenges.get(key);
  challenges.delete(key);
  if (!c || c.until < Date.now()) throw new HttpError(400, "That took too long. Try again.");
  return c;
}

/** Who the passkey is for: the address the browser is on (https, or http on localhost). */
export function relyingParty(req: Request): { rpID: string; origin: string } {
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? new URL(req.url).host;
  const proto = req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "");
  const origin = `${proto === "https" ? "https" : "http"}://${host}`;
  return { rpID: new URL(origin).hostname, origin };
}

export interface Passkey {
  id: number;
  name: string;
  created_at: string;
  last_used_at: string | null;
}

/** A person's passkeys for this address, newest first; ones removed over a day ago are deleted. */
export async function listPasskeys(userId: number, rpID: string): Promise<Passkey[]> {
  await sql`delete from passkeys where removed_at < now() - interval '1 day'`;
  return sql<Passkey[]>`
    select id, name, created_at, last_used_at from passkeys
    where user_id = ${userId} and rp_id = ${rpID} and removed_at is null order by created_at desc`;
}

// ── adding one ──────────────────────────────────────────────────────────────────────────────

export async function registrationOptions(req: Request, user: User, library: string) {
  const rp = relyingParty(req);
  const have = await sql`select credential_id, transports from passkeys where user_id = ${user.id} and rp_id = ${rp.rpID} and removed_at is null`;
  const options = await generateRegistrationOptions({
    rpName: library || "DO Notes",
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    // The same handle every time, so a device keeps one passkey per person here.
    userID: new TextEncoder().encode(`cp-user-${user.id}`),
    attestationType: "none",
    excludeCredentials: have.map((r) => ({ id: r.credential_id as string, transports: r.transports as string[] })),
    authenticatorSelection: { residentKey: "required", userVerification: "required" },
  });
  keep(`r:${user.id}`, { challenge: options.challenge, ...rp });
  return options;
}

export async function register(user: User, response: RegistrationResponseJSON, name: string): Promise<Passkey> {
  const c = take(`r:${user.id}`);
  const v = await verifyRegistrationResponse({ response, expectedChallenge: c.challenge, expectedOrigin: c.origin, expectedRPID: c.rpID, requireUserVerification: true }).catch(() => null);
  if (!v?.verified || !v.registrationInfo) throw new HttpError(400, "That passkey couldn't be checked. Try again.");
  const cred = v.registrationInfo.credential;
  const [row] = await sql<Passkey[]>`
    insert into passkeys (user_id, credential_id, public_key, counter, transports, name, rp_id)
    values (${user.id}, ${cred.id}, ${Buffer.from(cred.publicKey)}, ${cred.counter}, ${cred.transports ?? []}, ${name.trim().slice(0, 100) || "Passkey"}, ${c.rpID})
    on conflict (credential_id) do nothing
    returning id, name, created_at, last_used_at`;
  if (!row) throw new HttpError(409, "That passkey is added already.");
  return row;
}

// ── signing in with one ─────────────────────────────────────────────────────────────────────

/** Options for signing in, and the flow id that ties the answer to them. Any passkey for this
 *  address may answer (the device offers its own), so nothing here says who has an account. */
export async function authenticationOptions(req: Request) {
  const rp = relyingParty(req);
  const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: "required", allowCredentials: [] });
  const flow = randomBytes(18).toString("base64url");
  keep(`a:${flow}`, { challenge: options.challenge, ...rp });
  return { options, flow };
}

const REFUSED = "That passkey isn't one for this DO Notes. Sign in with your password, then add a passkey in Settings → Account.";

export async function authenticate(flow: string, response: AuthenticationResponseJSON): Promise<User> {
  const c = take(`a:${flow}`);
  const [row] = await sql`
    select p.id, p.public_key, p.counter, p.transports, u.id as user_id, u.email, u.name, u.is_admin
    from passkeys p join users u on u.id = p.user_id
    where p.credential_id = ${response.id} and p.rp_id = ${c.rpID} and p.removed_at is null`;
  if (!row) throw new HttpError(401, REFUSED);
  const v = await verifyAuthenticationResponse({
    response,
    expectedChallenge: c.challenge,
    expectedOrigin: c.origin,
    expectedRPID: c.rpID,
    requireUserVerification: true,
    credential: { id: response.id, publicKey: new Uint8Array(row.public_key as Buffer), counter: Number(row.counter), transports: row.transports as string[] },
  }).catch(() => null);
  if (!v?.verified) throw new HttpError(401, REFUSED);
  await sql`update passkeys set counter = ${v.authenticationInfo.newCounter}, last_used_at = now() where id = ${row.id}`;
  return { id: Number(row.user_id), email: row.email, name: row.name, is_admin: row.is_admin };
}

// ── removing one ────────────────────────────────────────────────────────────────────────────

export async function remove(userId: number, id: number): Promise<void> {
  // An account on passkeys only (F40) keeps at least one, or it couldn't sign in.
  const [last] = await sql`
    select 1 from users u where u.id = ${userId} and u.password_off
      and (select count(*) from passkeys p where p.user_id = u.id and p.removed_at is null and p.id <> ${id}) = 0`;
  if (last) throw new HttpError(400, "This is your only passkey, and your account signs in with passkeys only. Add another, or set a password, first.");
  const [r] = await sql`update passkeys set removed_at = now() where id = ${id} and user_id = ${userId} and removed_at is null returning id`;
  if (!r) throw new HttpError(404, "No such passkey");
}

/** Undo a removal (within the day it's kept). */
export async function restore(userId: number, id: number): Promise<void> {
  const [r] = await sql`update passkeys set removed_at = null where id = ${id} and user_id = ${userId} and removed_at is not null returning id`;
  if (!r) throw new HttpError(404, "No such passkey");
}
