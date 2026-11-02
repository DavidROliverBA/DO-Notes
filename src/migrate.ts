// Applies db/schema.sql at every boot (src/server.ts) and from `bun run db:migrate`. The schema is
// create-if-not-exists and additive only (`add column if not exists`), so running it again is
// always safe; never put destructive DDL in it.

import { sql } from "./db";

export async function migrate(): Promise<void> {
  const schema = await Bun.file(new URL("../db/schema.sql", import.meta.url)).text();
  // The schema runs as one implicit transaction, so it can deadlock with a server still writing
  // to the same database (the old instance during a deploy). Postgres rolls the loser back whole,
  // and every statement is "if not exists", so trying again is safe.
  for (let attempt = 1; ; attempt++) {
    try {
      await sql.unsafe(schema);
      return;
    } catch (err) {
      // Up to ten tries, about 11 s in all: a busy old instance can win several in a row, and a
      // server that gives up doesn't start at all.
      if ((err as { code?: string }).code !== "40P01" || attempt >= 10) throw err;
      console.warn(`schema deadlocked with another connection; trying again (${attempt})`);
      await Bun.sleep(200 * attempt);
    }
  }
}

/** "postgres 18.6, pgvector 0.8.6", for the boot log: confirms an upgrade without a DB connection. */
export async function dbVersions(): Promise<string> {
  const [r] = await sql`select current_setting('server_version') as pg, (select extversion from pg_extension where extname = 'vector') as vector`;
  return `postgres ${String(r!.pg).split(" ")[0]}, pgvector ${r!.vector ?? "missing"}`;
}

if (import.meta.main) {
  await migrate();
  console.log("schema up to date");
  await sql.end();
}
