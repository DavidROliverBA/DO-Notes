// Share one note by link (F38): a read-only, unlisted page of one note at /s/<slug>/, without
// publishing a site. Like a published site (F18, src/publish.ts) it's a snapshot: the page and the
// files it shows are copied when it's shared and when it's updated, so later edits stay private
// until then; it runs no script; a link to any other note shows as plain words. Stopping sharing
// keeps the snapshot, so Undo puts the same page back. One link per note; owners and editors make it.

import { randomBytes } from "node:crypto";
import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { encodeSitePath, renderSingle, SHARE_PAGE_HEADERS, sharedPage, siteStylesheet } from "./publish";
import { assertRoom } from "./storage";

const slugOf = () => randomBytes(12).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16).padEnd(16, "0");

export interface ShareState {
  shared: boolean;
  live: boolean;
  url: string | null;
  updatedAt: string | null;
  /** The note has changed since the page was made. */
  stale: boolean;
}

export async function shareState(vaultId: number, noteId: number): Promise<ShareState> {
  const [s] = await sql`select s.slug, s.live, s.updated_at, s.source_md5, md5(n.content) as now from shared_notes s join notes n on n.id = s.note_id where s.note_id = ${noteId} and s.vault_id = ${vaultId}`;
  if (!s) return { shared: false, live: false, url: null, updatedAt: null, stale: false };
  return { shared: true, live: s.live, url: `/s/${s.slug}/`, updatedAt: new Date(s.updated_at).toISOString(), stale: s.source_md5 !== s.now };
}

/** Make the page, or update it to the note as it is now. */
export async function shareNote(vaultId: number, noteId: number, user: User, tz?: string): Promise<ShareState> {
  const r = await renderSingle(vaultId, noteId, tz);
  const [{ bytes }] = (await sql`select coalesce(sum(size), 0)::float8 as bytes from attachments where vault_id = ${vaultId} and path = any(${r.files})`) as unknown as [{ bytes: number }];
  await assertRoom(bytes + r.html.length);
  await sql.begin(async (tx) => {
    const [s] = await tx`
      insert into shared_notes (vault_id, note_id, slug, page, title, html, source_md5, created_by)
      values (${vaultId}, ${noteId}, ${slugOf()}, ${r.page}, ${r.title}, ${r.html}, ${r.md5}, ${user.id})
      on conflict (note_id) do update set page = excluded.page, title = excluded.title, html = excluded.html, source_md5 = excluded.source_md5, live = true, updated_at = now()
      returning id`;
    await tx`delete from shared_note_files where share_id = ${s!.id}`;
    await tx`insert into shared_note_files (share_id, path, mime, data)
             select ${s!.id}, path, mime, data from attachments where vault_id = ${vaultId} and path = any(${r.files})`;
  });
  return shareState(vaultId, noteId);
}

/** Stop sharing (the page goes at once), or put it back (Undo). */
export async function setShareLive(vaultId: number, noteId: number, live: boolean): Promise<ShareState> {
  const r = await sql`update shared_notes set live = ${live} where note_id = ${noteId} and vault_id = ${vaultId} returning 1`;
  if (!r.length) throw new HttpError(404, "This note isn't shared");
  return shareState(vaultId, noteId);
}

const notFound = () => new Response("Not found", { status: 404, headers: { "Content-Type": "text/plain; charset=utf-8", "X-Robots-Tag": "noindex" } });

/** GET /s/<slug>/…: the page, its stylesheet, and the files it shows. */
export async function serveShared(req: Request): Promise<Response> {
  if (req.method !== "GET" && req.method !== "HEAD") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
  const m = /^\/s\/([a-z0-9]{16})(\/.*)?$/.exec(new URL(req.url).pathname);
  if (!m) return notFound();
  const [s] = await sql`select id, page, title, html, updated_at from shared_notes where slug = ${m[1]!} and live`;
  if (!s) return notFound();
  const base = `/s/${m[1]}/`;
  if (m[2] === undefined || m[2] === "/") return new Response(null, { status: 302, headers: { Location: base + encodeSitePath(s.page), "Cache-Control": "no-cache" } });
  let path: string;
  try {
    path = decodeURIComponent(m[2].slice(1));
  } catch {
    return notFound();
  }
  if (path === "_share/style.css") return new Response(await siteStylesheet(), { headers: { "Content-Type": "text/css; charset=utf-8", "Cache-Control": "public, max-age=300", "X-Content-Type-Options": "nosniff" } });
  if (path === s.page) return new Response(sharedPage(s.page, s.title, s.html, new Date(s.updated_at)), { headers: SHARE_PAGE_HEADERS });
  const [f] = await sql`select mime, data from shared_note_files where share_id = ${s.id} and path = ${path}`;
  if (f)
    return new Response(new Uint8Array(f.data), {
      headers: { "Content-Type": f.mime, "Cache-Control": "no-cache", "X-Content-Type-Options": "nosniff", "X-Robots-Tag": "noindex", "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox" },
    });
  return notFound();
}
