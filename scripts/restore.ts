// Restore a backup (GET /api/backup, or a daily artifact from .github/workflows/backup.yml) into
// the database at DATABASE_URL: each vault comes back with its notes, files, empty folders,
// history and Trash, owned by --owner, with members whose accounts exist here.
//
//   DATABASE_URL=postgres://… bun scripts/restore.ts commonplace-backup-2026-10-13.zip --owner you@example.com
//
// Into an empty database, it creates the owner as an admin and prints a one-time password.
// Not restored, by design: other people's accounts and passwords, sessions, AI keys and GitHub
// tokens (sealed with SECRETS_KEY), and GitHub vault links: a GitHub vault comes back as a plain
// vault. Embeddings are rebuilt when the server next starts.

import { randomBytes } from "node:crypto";
import { strFromU8, unzipSync } from "fflate";
import type { User } from "../src/auth";
import { createUser } from "../src/auth";
import { sql } from "../src/db";
import { migrate } from "../src/migrate";
import { createNote } from "../src/notes";
import { mimeFor } from "../src/transfer";
import { createVault } from "../src/vaults";

const [file, ...rest] = process.argv.slice(2);
const owner = rest[rest.indexOf("--owner") + 1];
if (!file || !rest.includes("--owner") || !owner) {
  console.error("usage: bun scripts/restore.ts <backup.zip> --owner <email>");
  process.exit(2);
}

await migrate();
let [me] = await sql<User[]>`select id, email, name, is_admin from users where lower(email) = lower(${owner})`;
if (!me) {
  const password = randomBytes(12).toString("base64url");
  me = await createUser({ email: owner, name: "", password, isAdmin: true });
  console.log(`Created ${owner} (admin) with password ${password}: change it in Settings → Account.`);
}

const entries = unzipSync(new Uint8Array(await Bun.file(file).arrayBuffer()));
const sidecars = Object.keys(entries).filter((p) => /^\d+ [^/]*\.json$/.test(p));
const emailId = new Map((await sql`select id, lower(email) as email from users`).map((u) => [u.email as string, u.id as number]));

for (const side of sidecars.sort((a, b) => parseInt(a) - parseInt(b))) {
  const meta = JSON.parse(strFromU8(entries[side]!));
  const dir = side.slice(0, -".json".length) + "/";
  const vault = await createVault(me, String(meta.vault.name));
  let notes = 0;
  let files = 0;
  let folders = 0;
  for (const [p, data] of Object.entries(entries)) {
    if (!p.startsWith(dir) || p === dir) continue;
    if ((notes + files + 1) % 1000 === 0) await sql`analyze notes, links, attachments`; // see importFiles
    const path = p.slice(dir.length);
    if (path.endsWith("/")) {
      await sql`insert into folders (vault_id, path) values (${vault.id}, ${path.slice(0, -1)}) on conflict do nothing`;
      folders++;
    } else if (/\.md$/i.test(path)) {
      await createNote(vault.id, me.id, path, strFromU8(data), false);
      notes++;
    } else {
      await sql`insert into attachments (vault_id, path, mime, size, data, created_by) values (${vault.id}, ${path}, ${mimeFor(path)}, ${data.byteLength}, ${data}, ${me.id})`;
      files++;
    }
  }

  let versions = 0;
  for (const h of meta.history as { path: string; revisions: { created_at: string; reason: string; author: string | null; content: string }[] }[]) {
    const [n] = await sql`select id from notes where vault_id = ${vault.id} and path = ${h.path}`;
    if (!n) continue;
    const rows = h.revisions.map((r) => ({ note_id: n.id, content: r.content, reason: r.reason, created_at: r.created_at, author_id: (r.author && emailId.get(r.author.toLowerCase())) ?? null }));
    if (rows.length) await sql`insert into note_revisions ${sql(rows)}`;
    versions += rows.length;
  }
  // Comments (L3), with replies kept under their threads.
  const commentIds = new Map<number, number>();
  for (const c of (meta.comments ?? []) as { path: string; id: number; parent_id: number | null; author: string | null; quote: string; anchor_from: string | null; anchor_to: string | null; body: string; created_at: string; edited_at: string | null; resolved_at: string | null }[]) {
    const [n] = await sql`select id from notes where vault_id = ${vault.id} and path = ${c.path}`;
    if (!n) continue;
    const [row] = await sql`insert into comments (vault_id, note_id, author_id, parent_id, quote, anchor_from, anchor_to, body, created_at, edited_at, resolved_at)
      values (${vault.id}, ${n.id}, ${(c.author && emailId.get(c.author.toLowerCase())) ?? null}, ${c.parent_id ? (commentIds.get(c.parent_id) ?? null) : null}, ${c.quote}, ${c.anchor_from}, ${c.anchor_to}, ${c.body}, ${c.created_at}, ${c.edited_at}, ${c.resolved_at}) returning id`;
    commentIds.set(c.id, Number(row!.id));
  }
  for (const t of meta.trash as { path: string; content: string; revisions: unknown; created_at: string; deleted_at: string }[]) {
    await sql`insert into trashed_notes (vault_id, path, content, revisions, created_at, deleted_at)
              values (${vault.id}, ${t.path}, ${t.content}, ${sql.json(t.revisions as any)}, ${t.created_at}, ${t.deleted_at})`;
  }

  const missing: string[] = [];
  for (const m of meta.members as { email: string; role: string }[]) {
    const uid = emailId.get(m.email.toLowerCase());
    if (uid === me.id) continue;
    if (!uid) {
      missing.push(m.email);
      continue;
    }
    await sql`insert into vault_members (vault_id, user_id, role) values (${vault.id}, ${uid}, ${m.role}) on conflict (vault_id, user_id) do update set role = excluded.role`;
  }
  console.log(
    `${meta.vault.name} → vault ${vault.id}: ${notes} notes, ${files} files, ${folders} folders, ${versions} versions, ${meta.trash.length} in Trash` +
      (missing.length ? `; members without an account here: ${missing.join(", ")}` : ""),
  );
}

await sql.end({ timeout: 5 });
process.exit(0);
