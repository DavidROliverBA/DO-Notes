// Import and export as plain markdown — the escape hatch that keeps this honest. An exported zip
// is a plain folder of Markdown files (paths preserved, attachments alongside), and a vault zip
// (or a folder of .md files picked in the browser) imports straight back in. Also here: saving an
// uploaded file as an attachment, and the streamed all-vaults backup (GET /api/backup).

import { readPdfLater } from "./fileText";
import { commentsMarkdown, listComments } from "./comments";
import { strFromU8, strToU8, unzipSync, Zip, ZipDeflate, ZipPassThrough, zipSync } from "fflate";
import { HttpError } from "./auth";
import { sql } from "./db";
import { emit } from "./events";
import { isAttachmentPath, normalisePath, parseFrontmatter, SITE_SETTINGS } from "./markdown";
import { isTypePath, STARTERS, starterNeeds, starterNote, typeOf, TYPES_FOLDER } from "./types";
import { isNotePath } from "./syncCore";
import { type BundleImport, isBundle, MANIFEST as BUNDLE_MANIFEST, readBundle } from "./aixfImport";
import { addKinds } from "./relationshipIndex";
import { RELATIONSHIPS_NOTE } from "./relationships";
import { createNote, findByPath, freeNotePath, overwriteContent } from "./notes";
import { assertRoom } from "./storage";

export type ConflictMode = "overwrite" | "skip" | "keep-both";

export interface ImportReport {
  created: number;
  updated: number;
  skipped: number;
  attachments: number;
  errors: { path: string; error: string }[];
  /** When it was an AI-XF bundle (F9): what became of its concepts and typed links. */
  aixf?: BundleImport;
  /** Starter types added because imported notes said they were one (`type: system`). */
  typesAdded?: string[];
}

const MAX_ATTACHMENT = 25 * 1024 * 1024;
const MAX_NOTE = 5 * 1024 * 1024;
// A zip's compressed size says nothing about its expanded size (1000:1 is easy), so limits are
// checked against each entry's declared size before anything is inflated. Everything expanded
// is held in memory at once, so the cap stays well inside a 512 MB server.
const MAX_EXPANDED = 256 * 1024 * 1024;
const MAX_ENTRIES = 50_000;

const MIME: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  svg: "image/svg+xml", bmp: "image/bmp", avif: "image/avif", heic: "image/heic", pdf: "application/pdf",
  mp3: "audio/mpeg", m4a: "audio/mp4", wav: "audio/wav", ogg: "audio/ogg", mp4: "video/mp4",
  mov: "video/quicktime", webm: "video/webm", csv: "text/csv", txt: "text/plain", zip: "application/zip",
  base: "text/yaml; charset=utf-8", canvas: "application/json", json: "application/json",
};

export const mimeFor = (path: string) => MIME[path.split(".").pop()!.toLowerCase()] ?? "application/octet-stream";

export const MAX_FILE_BYTES = 25 * 1024 * 1024;

/** Store an uploaded file under `folder` without clobbering ("image.png" → "image 1.png"). */
export async function saveAttachment(vaultId: number, userId: number, file: File, folder = "attachments"): Promise<string> {
  if (file.size > MAX_FILE_BYTES) throw new HttpError(413, "Files are limited to 25 MB");
  await assertRoom(file.size);
  let path = normalisePath(`${folder}/${file.name || "pasted.png"}`, null);
  if (!isAttachmentPath(path)) throw new HttpError(400, "That file type isn't supported");
  for (let i = 1; (await sql`select 1 from attachments where vault_id = ${vaultId} and path = ${path}`).length; i++) {
    path = path.replace(/( \d+)?(\.[^.]+)$/, ` ${i}$2`);
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  await sql`insert into attachments (vault_id, path, mime, size, data, created_by)
            values (${vaultId}, ${path}, ${mimeFor(path)}, ${file.size}, ${bytes}, ${userId})`;
  readPdfLater(vaultId, path, bytes);
  return path;
}

/** Editor settings folders (dot-folders), trash and OS litter are not content. */
function ignored(path: string): boolean {
  return path.split("/").some((seg) => seg.startsWith(".") || seg === "__MACOSX" || seg === "node_modules") || /(^|\/)Thumbs\.db$/i.test(path);
}

/** If every file sits under one top-level folder (a zipped vault folder), drop that folder. */
function stripCommonRoot(paths: string[]): string | null {
  const firsts = new Set(paths.map((p) => (p.includes("/") ? p.split("/")[0] : null)));
  if (firsts.size !== 1) return null;
  const [only] = firsts;
  return only ?? null;
}

/** Import notes and files (zips expanded in place) into a vault, optionally under `intoFolder`.
 *  `mode` says what happens when a path is taken: overwrite it, skip it, or keep both. */
export async function importFiles(
  vaultId: number,
  userId: number,
  files: { path: string; data: Uint8Array }[],
  mode: ConflictMode = "overwrite",
  intoFolder = "",
  /** Only an owner may change the site settings (publish.json) this way, as in Settings. */
  owner = true,
): Promise<ImportReport> {
  // Expand zips in place.
  const tooBig: string[] = [];
  const dirs: string[] = []; // zip directory entries, so empty folders survive a round trip
  const expanded: { path: string; data: Uint8Array }[] = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.path)) {
      let total = 0;
      let count = 0;
      const entries = unzipSync(f.data, {
        filter: (e) => {
          if (ignored(e.name)) return false;
          if (e.name.endsWith("/")) {
            dirs.push(e.name.replace(/\\/g, "/").replace(/^\/+|\/+$/g, ""));
            return false;
          }
          const limit = isNotePath(e.name) ? MAX_NOTE : MAX_ATTACHMENT;
          if (e.originalSize > limit) {
            tooBig.push(e.name);
            return false;
          }
          total += e.originalSize;
          if (++count > MAX_ENTRIES || total > MAX_EXPANDED) throw new HttpError(413, "That zip expands to more than 256 MB or 50,000 files: import it in parts");
          return true;
        },
      });
      for (const [p, data] of Object.entries(entries)) if (!p.endsWith("/")) expanded.push({ path: p, data });
    } else expanded.push(f);
  }
  // What a zip expands to must fit on the disk too, not just what was uploaded.
  await assertRoom(expanded.reduce((n, f) => n + f.data.byteLength, 0));
  let items = expanded.map((f) => ({ ...f, path: f.path.replace(/\\/g, "/").replace(/^\/+/, "") })).filter((f) => !ignored(f.path));
  const root = stripCommonRoot(items.map((f) => f.path));
  if (root) items = items.map((f) => ({ ...f, path: f.path.slice(root.length + 1) }));
  const prefix = intoFolder.trim() ? normalisePath(intoFolder, null) + "/" : "";

  const report: ImportReport = { created: 0, updated: 0, skipped: 0, attachments: 0, errors: tooBig.map((path) => ({ path, error: "too large to import" })) };
  // An AI-XF bundle (F9): typed links become relation properties; the manifest is kept as the
  // collection's own if it has none; the vocabularies were only for the trip.
  const bundle = isBundle(items) ? readBundle(items, prefix) : null;
  if (bundle) {
    report.aixf = bundle.report;
    const manifest = items.find((f) => f.path === BUNDLE_MANIFEST)!;
    items = items.filter((f) => f !== manifest && !/^vocab\/[^/]+\.json$/.test(f.path));
    await sql`insert into attachments (vault_id, path, mime, size, data, created_by)
              values (${vaultId}, ${BUNDLE_MANIFEST}, ${"application/yaml"}, ${manifest.data.byteLength}, ${manifest.data}, ${userId})
              on conflict (vault_id, path) do nothing`;
  }
  let done = 0;
  const typesNamed = new Set<string>();
  for (const f of items) {
    // A big import grows the tables many times over while it runs; refresh Postgres's statistics
    // as it goes, or the plans made when the vault was nearly empty (scans) make it quadratic.
    if (++done % 1000 === 0) await sql`analyze notes, links, attachments`;
    try {
      if (isNotePath(f.path)) {
        const path = normalisePath(prefix + f.path.replace(/\.markdown$/i, ".md"));
        // Some editors write CRLF on Windows and sometimes a BOM; store clean LF text.
        if (f.data.byteLength > MAX_NOTE) throw new Error("larger than 5 MB");
        const text = strFromU8(f.data).replace(/^﻿/, "").replace(/\r\n/g, "\n");
        const content = bundle ? bundle.convert(f.path, text) : text;
        const named = typeOf(parseFrontmatter(content).data);
        if (named) typesNamed.add(named.toLowerCase());
        const existing = await findByPath(vaultId, path);
        if (!existing) {
          await createNote(vaultId, userId, path, content);
          report.created++;
        } else if (mode === "skip") {
          report.skipped++;
        } else if (mode === "overwrite") {
          await overwriteContent(existing.id, content, userId, "import");
          report.updated++;
        } else {
          await createNote(vaultId, userId, await freeNotePath(vaultId, path), content);
          report.created++;
        }
      } else if (isAttachmentPath(f.path)) {
        if (f.data.byteLength > MAX_ATTACHMENT) throw new Error("larger than 25 MB");
        let path = normalisePath(prefix + f.path, null);
        if (path === SITE_SETTINGS && !owner) throw new Error("only an owner can change what's published");
        const taken = async (p: string) => (await sql`select 1 from attachments where vault_id = ${vaultId} and path = ${p}`).length > 0;
        if (await taken(path)) {
          if (mode === "skip") {
            report.skipped++;
            continue;
          }
          if (mode === "keep-both") {
            const base = path;
            for (let i = 1; await taken(path); i++) path = base.replace(/(\.[^./]+)?$/, ` ${i}$1`);
          }
        }
        await sql`
          insert into attachments (vault_id, path, mime, size, data, created_by)
          values (${vaultId}, ${path}, ${mimeFor(path)}, ${f.data.byteLength}, ${f.data}, ${userId})
          on conflict (vault_id, path) do update set data = excluded.data, size = excluded.size, mime = excluded.mime`;
        report.attachments++;
      } else {
        report.skipped++;
      }
    } catch (err) {
      report.errors.push({ path: f.path, error: (err as Error).message });
    }
  }
  if (bundle) {
    const have = new Set((await sql`select title from notes where vault_id = ${vaultId} and path ilike 'Types/%'`).map((r) => r.title as string));
    for (const t of bundle.missingTypes(have)) {
      try {
        await createNote(vaultId, userId, `Types/${t.name}.md`, t.content);
        report.created++;
      } catch (err) {
        report.errors.push({ path: `Types/${t.name}.md`, error: (err as Error).message });
      }
    }
    // Its kinds of relationship join the collection's Relationships note (F31).
    try {
      await addKinds(vaultId, userId, bundle.relKinds);
    } catch (err) {
      report.errors.push({ path: RELATIONSHIPS_NOTE, error: (err as Error).message });
    }
  }
  if (!bundle && typesNamed.size) {
    const added = await addNamedStarters(vaultId, userId, typesNamed, report);
    if (added.length) report.typesAdded = added;
  }
  // Empty folders from the zip; folders that received notes are already implied by their paths.
  const folders = dirs
    .map((d) => (root ? (d === root ? "" : d.startsWith(root + "/") ? d.slice(root.length + 1) : d) : d))
    .filter(Boolean)
    .flatMap((d) => {
      try {
        return [normalisePath(prefix + d, null)];
      } catch {
        return [];
      }
    });
  if (folders.length) {
    await sql`insert into folders ${sql(folders.map((path) => ({ vault_id: vaultId, path })))} on conflict do nothing`;
  }
  emit(vaultId, { type: "vault.changed" });
  return report;
}

/** Notes that say `type: system` get the System starter type if the collection has no System
 *  type yet (a Floe export, say), with the starters its relations need. Types the collection has,
 *  including ones this import brought, are left alone, and a name that isn't a starter stays plain.
 *  With `dryRun`, only says which it would add (F41's preview). */
export async function addNamedStarters(vaultId: number, userId: number, named: Set<string>, report: Pick<ImportReport, "created" | "errors">, dryRun = false): Promise<string[]> {
  const rows = await sql`select path from notes where vault_id = ${vaultId} and path ilike ${TYPES_FOLDER + "/%"}`;
  const have = new Set(rows.map((r) => r.path as string).filter(isTypePath).map((p) => p.slice(TYPES_FOLDER.length + 1, -3).toLowerCase()));
  const added: string[] = [];
  const add = async (name: string) => {
    const s = STARTERS.find((x) => x.name.toLowerCase() === name.toLowerCase());
    if (!s || have.has(s.name.toLowerCase())) return;
    have.add(s.name.toLowerCase());
    if (dryRun) {
      added.push(s.name);
      for (const need of starterNeeds(s)) await add(need);
      return;
    }
    try {
      await createNote(vaultId, userId, `${TYPES_FOLDER}/${s.name}.md`, starterNote(s));
      report.created++;
      added.push(s.name);
    } catch (err) {
      report.errors.push({ path: `${TYPES_FOLDER}/${s.name}.md`, error: (err as Error).message });
      return;
    }
    for (const need of starterNeeds(s)) await add(need);
  };
  for (const n of named) await add(n);
  return added;
}

/** The whole vault (or one folder of it) as a zip of plain, portable Markdown. */
export async function exportZip(vaultId: number, folder?: string): Promise<Uint8Array> {
  const tree = await exportTree(vaultId, folder);
  // Comments (L3) go beside the notes, in a dot-folder other editors (and an import here) leave alone.
  const prefix = folder ? normalisePath(folder, null) + "/" : "";
  const commented = await sql`select distinct n.id, n.path, n.title from comments c join notes n on n.id = c.note_id where n.vault_id = ${vaultId} and n.path like ${prefix.replace(/[%_\\]/g, "\\$&") + "%"}`;
  for (const n of commented) tree[`.comments/${n.path.slice(prefix.length)}`] = strToU8(commentsMarkdown(n.title, await listComments(vaultId, Number(n.id))));
  return zipTree(tree);
}

/** A vault (or one folder) as {zip path: bytes}: notes as markdown, files, empty folders as "dir/". */
export async function exportTree(vaultId: number, folder?: string): Promise<Record<string, Uint8Array>> {
  const prefix = folder ? normalisePath(folder, null) + "/" : "";
  const like = prefix.replace(/[%_\\]/g, "\\$&") + "%";
  const notes = await sql`select path, content from notes where vault_id = ${vaultId} and path like ${like}`;
  const atts = await sql`select path, data from attachments where vault_id = ${vaultId} and path like ${like}`;
  const tree: Record<string, Uint8Array> = {};
  for (const n of notes) tree[n.path.slice(prefix.length)] = strToU8(n.content);
  for (const a of atts) tree[a.path.slice(prefix.length)] = new Uint8Array(a.data);
  // Stored folders become zip directory entries, so empty ones reach other Markdown editors too.
  const dirs = await sql`select path from folders where vault_id = ${vaultId} and path like ${like}`;
  for (const d of dirs) if (d.path.length > prefix.length) tree[d.path.slice(prefix.length) + "/"] = new Uint8Array(0);
  return tree;
}

function zipTree(tree: Record<string, Uint8Array>): Uint8Array {
  // Already-compressed media gains nothing from deflate; store it.
  const opts = Object.fromEntries(
    Object.entries(tree).map(([p, d]) => [p, [d, { level: /\.(md|txt|csv|svg|json)$/i.test(p) ? 6 : 0 }] as const]),
  );
  return zipSync(opts as any);
}

/**
 * Every vault in one zip, for off-site backup: `<id> <name>/` holds the vault exactly as an export
 * (so it opens in any Markdown editor), and `<id> <name>.json` holds what markdown can't: members, each
 * note's history, and Trash. Streamed as it's read, a few rows and one file at a time, so its
 * size isn't limited by the server's memory (the Starter instance has 512 MB).
 * `scripts/restore.ts` turns one back into vaults.
 */
export function backupStream(): ReadableStream<Uint8Array> {
  let cancelled = false;
  return new ReadableStream<Uint8Array>(
    {
      async start(controller) {
        const zip = new Zip((err, chunk, final) => {
          if (cancelled) return;
          if (err) return controller.error(err);
          controller.enqueue(chunk);
          if (final) controller.close();
        });
        // Wait for the reader when it's behind, so memory holds a few MB, not the whole zip.
        const drained = async () => {
          while (!cancelled && (controller.desiredSize ?? 1) <= 0) await Bun.sleep(5);
        };
        const file = (path: string, compress: boolean) => {
          const f = compress ? new ZipDeflate(path, { level: 6 }) : new ZipPassThrough(path);
          zip.add(f);
          return f;
        };
        const put = async (path: string, data: Uint8Array) => {
          // Already-compressed media gains nothing from deflate; store it.
          const f = file(path, /\.(md|txt|csv|svg|json)$/i.test(path));
          // In 1 MB pieces, waiting for the reader between them, so a 25 MB file isn't copied whole.
          const PIECE = 1024 * 1024;
          for (let at = 0; at < data.byteLength || at === 0; at += PIECE) {
            f.push(data.subarray(at, at + PIECE), at + PIECE >= data.byteLength);
            await drained();
          }
        };
        try {
          const vaults = await sql`select id, name, created_at from vaults order by id`;
          for (const v of vaults) {
            if (cancelled) return;
            const dir = `${v.id} ${String(v.name).replace(/[\\/:*?"<>|]/g, "-")}`;
            for await (const rows of sql`select path, content from notes where vault_id = ${v.id} order by id`.cursor(200)) {
              for (const n of rows) await put(`${dir}/${n.path}`, strToU8(n.content));
            }
            for await (const [a] of sql`select path, data from attachments where vault_id = ${v.id} order by id`.cursor(1)) {
              await put(`${dir}/${a!.path}`, a!.data);
            }
            for (const d of await sql`select path from folders where vault_id = ${v.id}`) await put(`${dir}/${d.path}/`, new Uint8Array(0));

            // The sidecar, written in pieces: one note's history or one trashed note at a time.
            const json = file(`${dir}.json`, true);
            const members = await sql`select u.email, u.name, m.role from vault_members m join users u on u.id = m.user_id where m.vault_id = ${v.id} order by u.email`;
            json.push(strToU8(`{"vault":${JSON.stringify({ id: v.id, name: v.name, created_at: v.created_at })},"exported_at":${JSON.stringify(new Date().toISOString())},"members":${JSON.stringify(members)},"history":[`));
            let first = true;
            for await (const rows of sql`
              select n.path, json_agg(json_build_object('created_at', r.created_at, 'reason', r.reason, 'author', u.email, 'content', r.content) order by r.id) as revisions
              from note_revisions r join notes n on n.id = r.note_id left join users u on u.id = r.author_id
              where n.vault_id = ${v.id} group by n.path order by n.path`.cursor(20)) {
              for (const h of rows) {
                json.push(strToU8((first ? "" : ",") + JSON.stringify(h)));
                first = false;
              }
              await drained();
            }
            json.push(strToU8(`],"comments":`));
            const cm = await sql`
              select n.path, c.id, c.parent_id, u.email as author, c.quote, c.anchor_from, c.anchor_to, c.body, c.created_at, c.edited_at, c.resolved_at
              from comments c join notes n on n.id = c.note_id left join users u on u.id = c.author_id where c.vault_id = ${v.id} order by c.id`;
            json.push(strToU8(JSON.stringify(cm)));
            json.push(strToU8(`,"trash":[`));
            first = true;
            for await (const rows of sql`select path, content, revisions, created_at, deleted_at from trashed_notes where vault_id = ${v.id} order by deleted_at`.cursor(20)) {
              for (const t of rows) {
                json.push(strToU8((first ? "" : ",") + JSON.stringify(t)));
                first = false;
              }
              await drained();
            }
            json.push(strToU8("]}"), true);
            await drained();
          }
          zip.end();
        } catch (err) {
          console.error("backup failed:", err);
          if (!cancelled) controller.error(err);
        }
      },
      cancel() {
        cancelled = true;
      },
    },
    new ByteLengthQueuingStrategy({ highWaterMark: 4 * 1024 * 1024 }),
  );
}
