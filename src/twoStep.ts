// Two-step sign-in (F40): after the password, a six-digit code from a code app (TOTP, RFC 6238:
// HMAC-SHA1, 30-second steps, one step either side allowed), or one of ten single-use recovery
// codes. The code app's secret is sealed with SECRETS_KEY (src/secrets.ts); recovery codes are
// kept only as SHA-256 hashes. A code can't be used twice (the last step used is kept). A passkey
// is already two steps (the device and the face or finger), so passkey sign-in asks for no code.
// And an account can drop its password and sign in with passkeys only.
//
// Between the password and the code, the sign-in waits in memory five minutes (one instance, like
// the sign-in limits in auth.ts), with five tries; then it starts again.

import { createHash, randomBytes } from "node:crypto";
import qrcode from "qrcode-generator";
import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { open, seal, secretsAvailable } from "./secrets";
import { base32, DIGITS, fromBase32, matchStep, STEP_S } from "./totp";

const WAIT_MS = 5 * 60_000;
const SETUP_MS = 10 * 60_000;
const TRIES = 5;
const RECOVERY_CODES = 10;

const recoveryHash = (code: string) => createHash("sha256").update(`cp-recovery:${code.toLowerCase().replace(/[^a-z0-9]/g, "")}`).digest("hex");

/** Ten new recovery codes (xxxx-xxxx, letters and digits that can't be misread), replacing any. */
async function newRecoveryCodes(userId: number): Promise<string[]> {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const codes = Array.from({ length: RECOVERY_CODES }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => alphabet[x % alphabet.length]).join("");
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
  await sql.begin(async (tx) => {
    await tx`delete from recovery_codes where user_id = ${userId}`;
    for (const c of codes) await tx`insert into recovery_codes (user_id, code_hash) values (${userId}, ${recoveryHash(c)})`;
  });
  return codes;
}

// ── what a person has ───────────────────────────────────────────────────────────────────────

export interface SignInState {
  /** Signs in with a password (false: passkeys only). */
  password: boolean;
  /** A code app is needed after the password. */
  twoStep: boolean;
  /** Recovery codes not yet used. */
  recoveryLeft: number;
  /** Passkeys, at any address. */
  passkeys: number;
  /** This server can keep a code app's secret (SECRETS_KEY is set). */
  canTwoStep: boolean;
}

export async function signInState(userId: number): Promise<SignInState> {
  const [u] = await sql`
    select password_off, totp_secret is not null as two_step,
      (select count(*)::int from recovery_codes r where r.user_id = u.id and r.used_at is null) as left,
      (select count(*)::int from passkeys p where p.user_id = u.id and p.removed_at is null) as passkeys
    from users u where id = ${userId}`;
  return { password: !u!.password_off, twoStep: u!.two_step, recoveryLeft: u!.left, passkeys: u!.passkeys, canTwoStep: secretsAvailable() };
}

export async function needsCode(userId: number): Promise<boolean> {
  const [u] = await sql`select totp_secret is not null as on from users where id = ${userId}`;
  return !!u?.on;
}

// ── setting up a code app ───────────────────────────────────────────────────────────────────

const setups = new Map<number, { secret: Buffer; until: number }>();

/** A new secret to show (QR code and text); kept ten minutes until confirmed with a code. */
export async function startSetup(user: User, issuer: string) {
  if (!secretsAvailable()) throw new HttpError(503, "This server can't keep a code app's secret yet: an admin needs to set SECRETS_KEY (see README).");
  const secret = randomBytes(20);
  const now = Date.now();
  for (const [k, v] of setups) if (v.until < now) setups.delete(k);
  setups.set(user.id, { secret, until: now + SETUP_MS });
  const label = encodeURIComponent(`${issuer}:${user.email}`);
  const uri = `otpauth://totp/${label}?secret=${base32(secret)}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${STEP_S}`;
  const qr = qrcode(0, "M");
  qr.addData(uri);
  qr.make();
  return { secret: base32(secret).replace(/(.{4})/g, "$1 ").trim(), uri, qr: qr.createDataURL(5, 2) };
}

/** Confirm the code app with a code it shows: two-step is on, other sessions are signed out by
 *  the caller, and the recovery codes are returned (shown once). */
export async function finishSetup(userId: number, code: string): Promise<string[]> {
  const s = setups.get(userId);
  if (!s || s.until < Date.now()) throw new HttpError(400, "That took too long. Start again.");
  const step = matchStep(s.secret, code);
  if (step === null) throw new HttpError(400, "That code isn't right. Check the code app shows DO Notes, and type the code it shows now.");
  setups.delete(userId);
  await sql`update users set totp_secret = ${seal(base32(s.secret))}, totp_last_step = ${step} where id = ${userId}`;
  return newRecoveryCodes(userId);
}

export async function turnOff(userId: number): Promise<void> {
  await sql`update users set totp_secret = null, totp_last_step = null where id = ${userId}`;
  await sql`delete from recovery_codes where user_id = ${userId}`;
}

export async function replaceRecoveryCodes(userId: number): Promise<string[]> {
  if (!(await needsCode(userId))) throw new HttpError(400, "Two-step sign-in isn't on.");
  return newRecoveryCodes(userId);
}

// ── signing in: the code after the password ─────────────────────────────────────────────────

const waiting = new Map<string, { user: User; until: number; tries: number }>();

/** After a right password: the sign-in waits for the code. Returns the flow id that ties them. */
export function awaitCode(user: User): string {
  const now = Date.now();
  for (const [k, v] of waiting) if (v.until < now) waiting.delete(k);
  if (waiting.size > 10_000) waiting.delete(waiting.keys().next().value!);
  const flow = randomBytes(18).toString("base64url");
  waiting.set(flow, { user, until: now + WAIT_MS, tries: 0 });
  return flow;
}

const AGAIN = "That took too long or had too many tries. Sign in again.";

/** Check the code (or a recovery code) for a waiting sign-in; the user when it's right. */
export async function checkCode(flow: string, code: string): Promise<{ user: User; recovery: boolean }> {
  const w = waiting.get(flow);
  if (!w || w.until < Date.now()) throw new HttpError(401, AGAIN);
  const ok = await codeMatches(w.user.id, code);
  if (!ok) {
    w.tries++;
    if (w.tries >= TRIES) waiting.delete(flow);
    throw new HttpError(401, w.tries >= TRIES ? AGAIN : "That code isn't right. Try the code your app shows now, or a recovery code.");
  }
  waiting.delete(flow);
  return { user: w.user, recovery: ok === "recovery" };
}

/** Whether a code (six digits from the app, or a recovery code) is right for this person now.
 *  An app code can't be used twice; a recovery code is used up. */
export async function codeMatches(userId: number, code: string): Promise<false | "app" | "recovery"> {
  const [u] = await sql`select totp_secret, totp_last_step from users where id = ${userId}`;
  if (!u?.totp_secret) return false;
  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits)) {
    const step = matchStep(fromBase32(open(u.totp_secret)), digits);
    if (step === null || (u.totp_last_step !== null && step <= Number(u.totp_last_step))) return false;
    // Only one sign-in can take a step: the update fails if another already did.
    const r = await sql`update users set totp_last_step = ${step} where id = ${userId} and (totp_last_step is null or totp_last_step < ${step}) returning 1`;
    return r.length ? "app" : false;
  }
  const r = await sql`update recovery_codes set used_at = now() where user_id = ${userId} and code_hash = ${recoveryHash(code)} and used_at is null returning 1`;
  return r.length ? "recovery" : false;
}

// ── passkeys only ───────────────────────────────────────────────────────────────────────────

/** Sign in with passkeys only: the password is replaced by one nobody knows (so signing in with a
 *  password fails like a wrong one, and says nothing about the account), and a code app is no
 *  longer needed. Needs a passkey at this address first, so the account isn't locked out. */
export async function dropPassword(userId: number, rpID: string): Promise<void> {
  const [{ n }] = (await sql`select count(*)::int as n from passkeys where user_id = ${userId} and rp_id = ${rpID} and removed_at is null`) as unknown as [{ n: number }];
  if (!n) throw new HttpError(400, "Add a passkey on this device first, so you can still sign in.");
  const unusable = await Bun.password.hash(randomBytes(32).toString("hex"));
  await sql`update users set password_hash = ${unusable}, password_off = true where id = ${userId}`;
  await turnOff(userId);
}

/** Back to a password (the caller has checked it's really them, with a passkey). */
export async function setPassword(userId: number, password: string): Promise<void> {
  await sql`update users set password_hash = ${await Bun.password.hash(password)}, password_off = false where id = ${userId}`;
}
