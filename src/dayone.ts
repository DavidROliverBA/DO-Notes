// Import from Day One (F24, release 2): its JSON export (a zip of one .json per journal, with
// photos/, videos/, audios/ and pdfs/ folders) becomes journal entries in the collection's daily
// notes, as New journal entry writes them: `### HH:MM` under `## Journal` in
// Daily/YYYY-MM-DD.md, by the time where the entry was written. Day One's first-line titles
// become bold (a heading would end the Journal section), its backslash escapes are taken out, its
// tags follow the entry as #tags, and its photos and files are stored as attachments and
// embedded where they were. Location, weather and stars aren't kept (no mood or location yet).
//
// Importing the same export again adds nothing: an entry already in its day at the same time
// with the same text is skipped. Writes go through createNote / overwriteContent with a function,
// one per day, so an open daily note keeps its typing.

import { strFromU8, unzipSync } from "fflate";
import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { addToJournal, dailyNotePath, entriesIn, newDailyNote } from "./journal";
import { isAttachmentPath, normalisePath } from "./markdown";
import { createNote, findByPath, overwriteContent } from "./notes";
import { settings } from "./settings";
import { assertRoom } from "./storage";
import { mimeFor } from "./transfer";

const MAX_FILE = 25 * 1024 * 1024;
const MAX_EXPANDED = 256 * 1024 * 1024;
const MAX_FILES = 50_000;
const MEDIA_FOLDER = "attachments/Day One";

export interface DayOneEntry {
  uuid: string;
  creationDate: string;
  timeZone?: string;
  text?: string;
  tags?: string[];
  photos?: Media[];
  videos?: Media[];
  audios?: Media[];
  pdfAttachments?: Media[];
}
interface Media {
  identifier: string;
  md5?: string;
  type?: string;
}

/** The day and time an entry was written, where it was written (else the server's zone). */
export function localWhen(iso: string, timeZone?: string): { day: string; time: string } | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const fmt = (tz: string) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
        .formatToParts(at)
        .map((p) => [p.type, p.value]),
    );
  let p;
  try {
    p = fmt(timeZone || settings.timeZone);
  } catch {
    p = fmt(settings.timeZone);
  }
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}` };
}

/** An entry's text as Markdown for a journal entry. `media` maps Day One's identifiers to the
 *  attachment paths they were stored at; a missing one is dropped. Pure. */
export function entryMarkdown(e: DayOneEntry, media: Map<string, string> = new Map()): string {
  let t = (e.text ?? "").replace(/\r\n/g, "\n");
  // Attachments: ![](dayone-moment://ID), or dayone-moment:/video/ID and the like.
  t = t.replace(/!?\[[^\]]*\]\(dayone-moment:\/{1,2}(?:[a-z]+\/)?([A-Za-z0-9-]+)\)/g, (_m, id: string) => {
    const path = media.get(id);
    return path ? `![[${path}]]` : "";
  });
  // Day One escapes Markdown's punctuation (2019\-01\-02, Mr\. Smith); its text is meant literally.
  t = t.replace(/\\([\\`*_{}[\]()#+\-.!&<>|~=])/g, "$1");
  // Headings would end the Journal section; a title reads as bold.
  t = t.replace(/^#{1,6}[ \t]+(.+?)[ \t#]*$/gm, "**$1**");
  t = t.replace(/\n{3,}/g, "\n\n").trim();
  const tags = (e.tags ?? []).map((g) => g.trim().replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "")).filter(Boolean);
  if (tags.length && t) t += `\n\n${tags.map((g) => `#${g}`).join(" ")}`;
  return t;
}

/** The entries in an export (a zip, or one journal's .json) and its media files by identifier. */
export function readExport(name: string, data: Uint8Array): { entries: DayOneEntry[]; files: Map<string, { name: string; data: Uint8Array }> } {
  const json: Uint8Array[] = [];
  const byMd5 = new Map<string, { name: string; data: Uint8Array }>();
  if (/\.json$/i.test(name)) json.push(data);
  else {
    let total = 0;
    let count = 0;
    let unzipped: Record<string, Uint8Array>;
    try {
      unzipped = unzipSync(data, {
        filter: (f) => {
          if (f.name.endsWith("/") || f.name.split("/").some((s) => s.startsWith(".") || s === "__MACOSX")) return false;
          if (f.originalSize > MAX_FILE) return false;
          total += f.originalSize;
          if (++count > MAX_FILES || total > MAX_EXPANDED) throw new HttpError(413, "That export expands to more than 256 MB: export fewer journals at a time");
          return true;
        },
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(400, "That isn't a zip file. In Day One, choose Export → JSON, and import the zip it makes.");
    }
    for (const [path, bytes] of Object.entries(unzipped)) {
      const base = path.split("/").pop()!;
      if (/\.json$/i.test(base)) json.push(bytes);
      else {
        const m = /^([0-9a-f]{32})\.[a-z0-9]+$/i.exec(base);
        if (m) byMd5.set(m[1]!.toLowerCase(), { name: base, data: bytes });
      }
    }
  }
  const entries: DayOneEntry[] = [];
  for (const j of json) {
    let parsed: any;
    try {
      parsed = JSON.parse(strFromU8(j));
    } catch {
      continue;
    }
    if (Array.isArray(parsed?.entries)) for (const e of parsed.entries) if (e && typeof e.creationDate === "string") entries.push(e);
  }
  if (!entries.length) throw new HttpError(400, "No Day One entries found. In Day One, choose Export → JSON, and import the zip it makes.");
  const files = new Map<string, { name: string; data: Uint8Array }>();
  for (const e of entries)
    for (const m of [...(e.photos ?? []), ...(e.videos ?? []), ...(e.audios ?? []), ...(e.pdfAttachments ?? [])]) {
      const f = m.md5 ? byMd5.get(m.md5.toLowerCase()) : undefined;
      if (f && m.identifier) files.set(m.identifier, f);
    }
  return { entries, files };
}

export interface ImportSummary {
  entries: number;
  days: number;
  /** Empty in Day One, or nothing left once its attachments were missing. */
  empty: number;
  /** Already in the collection (an earlier import). */
  already: number;
  files: number;
}

/** Import an export into a collection's daily notes; `dryRun` only counts. */
export async function importDayOne(user: User, vaultId: number, name: string, data: Uint8Array, dryRun: boolean): Promise<ImportSummary> {
  const { entries, files } = readExport(name, data);
  const sum: ImportSummary = { entries: 0, days: 0, empty: 0, already: 0, files: 0 };

  // Store each attachment once, by Day One's own name (its md5), reusing one already there.
  const stored = new Map<string, string>();
  const used = new Set<string>();
  for (const e of entries) for (const m of (e.text ?? "").matchAll(/dayone-moment:\/{1,2}(?:[a-z]+\/)?([A-Za-z0-9-]+)/g)) used.add(m[1]!);
  for (const id of used) {
    const f = files.get(id);
    if (!f) continue;
    const path = normalisePath(`${MEDIA_FOLDER}/${f.name}`, null);
    if (!isAttachmentPath(path)) continue;
    stored.set(id, path);
  }

  // Each entry's day, time and text, grouped by day, oldest first.
  const byDay = new Map<string, { time: string; text: string }[]>();
  for (const e of [...entries].sort((a, b) => a.creationDate.localeCompare(b.creationDate))) {
    const when = localWhen(e.creationDate, e.timeZone);
    const text = entryMarkdown(e, stored);
    if (!when || !text) {
      sum.empty++;
      continue;
    }
    const list = byDay.get(when.day) ?? [];
    list.push({ time: when.time, text });
    byDay.set(when.day, list);
  }

  // What's already there (an earlier import) is left out.
  const plan: { day: string; add: { time: string; text: string }[] }[] = [];
  for (const [day, list] of byDay) {
    const [existing] = await sql<{ content: string }[]>`select content from notes where vault_id = ${vaultId} and lower(path) = lower(${dailyNotePath(day)})`;
    const have = existing ? entriesIn(existing.content) : [];
    const add = list.filter((x) => !have.some((h) => h.time === x.time && h.text === x.text.trim()));
    sum.already += list.length - add.length;
    if (add.length) plan.push({ day, add });
  }
  sum.entries = plan.reduce((n, d) => n + d.add.length, 0);
  sum.days = plan.length;
  const needed = new Set(plan.flatMap((d) => d.add.flatMap((x) => [...x.text.matchAll(/!\[\[([^\]]+)\]\]/g)].map((m) => m[1]!))));
  const media = [...stored].filter(([, path]) => needed.has(path));
  sum.files = media.length;
  if (dryRun) return sum;

  await assertRoom(media.reduce((n, [id]) => n + files.get(id)!.data.byteLength, 0) + plan.reduce((n, d) => n + d.add.reduce((m, x) => m + x.text.length + 16, 0), 0));
  for (const [id, path] of media) {
    const f = files.get(id)!;
    const [there] = await sql`select 1 from attachments where vault_id = ${vaultId} and path = ${path}`;
    if (!there) await sql`insert into attachments (vault_id, path, mime, size, data, created_by) values (${vaultId}, ${path}, ${mimeFor(path)}, ${f.data.byteLength}, ${f.data}, ${user.id})`;
  }
  const addAll = (md: string, add: { time: string; text: string }[]) => add.reduce((acc, x) => addToJournal(acc, x.time, x.text), md);
  for (const { day, add } of plan) {
    const path = dailyNotePath(day);
    const existing = await findByPath(vaultId, path);
    if (existing) await overwriteContent(existing.id, (cur) => addAll(cur, add), user.id, "import");
    else await createNote(vaultId, user.id, path, addAll(await newDailyNote(vaultId, day), add));
  }
  return sum;
}
