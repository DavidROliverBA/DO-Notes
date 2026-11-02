// Give an account a new random password and sign it out everywhere: for a server with no email,
// such as the laptop kit (laptop/README.md, `./commonplace.sh reset-password <email>`).
//
//   DATABASE_URL=postgres://… bun scripts/reset-password.ts you@example.com

import { randomBytes } from "node:crypto";
import { sql } from "../src/db";

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error("usage: bun scripts/reset-password.ts <email>");
  process.exit(2);
}

const password = randomBytes(12).toString("base64url");
const hash = await Bun.password.hash(password);
// Also turns off two-step sign-in and "passkeys only" (F40): this is how a locked-out person gets back in.
const [user] = await sql`update users set password_hash = ${hash}, password_off = false, totp_secret = null, totp_last_step = null where lower(email) = ${email} returning id`;
if (user) await sql`delete from recovery_codes where user_id = ${user.id}`;
if (!user) {
  console.error(`No account with the email ${email}.`);
  process.exit(1);
}
await sql`delete from sessions where user_id = ${user.id}`;
console.log(`New password for ${email}: ${password}\nSign in with it, then change it in Settings → Account.`);
process.exit(0);
