// The journal (F24, release 1). An entry goes into a day's daily note (Daily/YYYY-MM-DD.md) in the
// person's home collection unless they name another, under a `## Journal` heading, as
// `### HH:MM` and the text. Plain Markdown in an ordinary note, so it exports, syncs to GitHub and
// shows in other editors as written. The journal page reads the Journal sections back, newest day
// first, and On this day finds the same date in earlier years.
//
// Writes go through createNote / overwriteContent with a function, so an entry added while
// someone is typing in today's note joins their text rather than undoing it.

import { HttpError, type User } from "./auth";
import { sql } from "./db";
import { createNote, findByPath, overwriteContent } from "./notes";
import { settings } from "./settings";
import * as vaults from "./vaults";
import { DAILY_FOLDER, dailyTemplatePath, defaultDaily, fillTemplate } from "../web/lib/templates";

export const JOURNAL_HEADING = "## Journal";
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** A Journal heading anywhere in a note, for Postgres (whose ^ is the start of the text only). */
const HAS_JOURNAL = "(^|\n)##[ \t]+journal[ \t]*(\r?\n|$)";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A day's daily note path. */
export const dailyNotePath = (day: string) => `${DAILY_FOLDER}/${day}.md`;

/** Today's date and the time now in the server's zone, for entries that don't say. */
export function nowIn(timeZone = settings.timeZone): { day: string; time: string } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(new Date())
      .map((p) => [p.type, p.value]),
  );
  return { day: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}

/** The note with an entry added at the end of its Journal section (made if it isn't there). Pure,
 *  so the editor, the server and the tests agree. */
export function addToJournal(md: string, time: string, text: string): string {
  const entry = `### ${time}\n\n${text.trim()}\n`;
  const lines = md.replace(/\s+$/, "").split("\n");
  const start = lines.findIndex((l) => /^##\s+journal\s*$/i.test(l.trim()));
  if (start === -1) return `${lines.join("\n")}${lines.join("").trim() ? "\n\n" : ""}${JOURNAL_HEADING}\n\n${entry}`;
  // The section runs to the next heading of level one or two.
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) if (/^#{1,2}\s/.test(lines[i]!)) (end = i, (i = lines.length));
  const before = lines.slice(0, end).join("\n").replace(/\s+$/, "");
  const after = lines.slice(end).join("\n");
  return `${before}\n\n${entry}${after ? `\n${after}\n` : ""}`;
}

export interface Entry {
  time: string;
  text: string;
}

/** The entries in a note's Journal section, in the order written. */
export function entriesIn(md: string): Entry[] {
  const lines = md.split("\n");
  const start = lines.findIndex((l) => /^##\s+journal\s*$/i.test(l.trim()));
  if (start === -1) return [];
  const out: Entry[] = [];
  let cur: Entry | null = null;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i]!;
    if (/^#{1,2}\s/.test(l)) break;
    const m = /^###\s+(\d{1,2}:\d{2})\s*$/.exec(l.trim());
    if (m) {
      if (cur) out.push(cur);
      cur = { time: m[1]!.padStart(5, "0"), text: "" };
    } else if (cur) cur.text += `${l}\n`;
  }
  if (cur) out.push(cur);
  return out.map((e) => ({ time: e.time, text: e.text.trim() })).filter((e) => e.text);
}

/** Which collection an entry goes to: the one named, else the person's home. Editor or better. */
async function target(user: User, vaultId: number | null | undefined): Promise<number> {
  const v = vaultId ?? (await vaults.homeOf(user.id));
  if (!v) throw new HttpError(404, "There's no collection to write the journal in: make one first");
  await vaults.requireRole(v, user, "editor");
  return v;
}

export interface EntryRequest {
  text: string;
  vaultId?: number | null;
  /** The person's own day and time (their device's clock); the server's zone if left out. */
  day?: string;
  time?: string;
}

/** Where an entry would go and how it would read, without writing (the assistant's preview). */
export async function planEntry(user: User, r: EntryRequest) {
  const text = r.text.trim();
  if (!text) throw new HttpError(400, "Write something first");
  if (text.length > 20_000) throw new HttpError(400, "That's too long for one entry");
  const now = nowIn();
  const day = r.day ?? now.day;
  const time = r.time ?? now.time;
  if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new HttpError(400, "That isn't a day");
  if (!TIME.test(time)) throw new HttpError(400, "That isn't a time");
  const vaultId = await target(user, r.vaultId);
  const path = dailyNotePath(day);
  const existing = await findByPath(vaultId, path);
  return { vaultId, path, day, time, text, existing };
}

/** A new daily note for `day`: from Templates/Daily.md if the collection has one, else the
 *  default, as Today makes it. */
export async function newDailyNote(vaultId: number, day: string): Promise<string> {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const date = new Date(y, m - 1, d);
  const paths = (await sql<{ path: string }[]>`select path from notes where vault_id = ${vaultId} and lower(path) like 'templates/%'`).map((x) => x.path);
  const tpl = dailyTemplatePath(paths);
  if (tpl) {
    const [t] = await sql`select content from notes where vault_id = ${vaultId} and path = ${tpl}`;
    if (t) return fillTemplate(t.content, { title: day, date });
  }
  return defaultDaily(date);
}

/** Add an entry to a day's daily note, making the note (from Templates/Daily.md if there is
 *  one) when the day hasn't got one yet. */
export async function addEntry(user: User, r: EntryRequest): Promise<{ vaultId: number; noteId: number; path: string; day: string; time: string }> {
  const p = await planEntry(user, r);
  let note = p.existing;
  if (!note) {
    const content = await newDailyNote(p.vaultId, p.day);
    try {
      const made = await createNote(p.vaultId, user.id, p.path, addToJournal(content, p.time, p.text));
      return { vaultId: p.vaultId, noteId: made.id, path: made.path, day: p.day, time: p.time };
    } catch (e) {
      // Made a moment ago (another entry, or the person opening Today): add to that one.
      if (!(e instanceof HttpError && e.status === 409)) throw e;
      note = await findByPath(p.vaultId, p.path);
      if (!note) throw e;
    }
  }
  await overwriteContent(note.id, (cur) => addToJournal(cur, p.time, p.text), user.id, "journal");
  return { vaultId: p.vaultId, noteId: note.id, path: note.path, day: p.day, time: p.time };
}

export interface JournalDay {
  day: string;
  noteId: number;
  entries: Entry[];
}

const daily = (rows: { id: number; path: string; content: string }[]): JournalDay[] =>
  rows
    .map((r) => ({ day: r.path.slice(DAILY_FOLDER.length + 1, -3), noteId: Number(r.id), entries: entriesIn(r.content) }))
    .filter((d) => DAY.test(d.day) && d.entries.length);

/** Days with journal entries in a collection, newest first; `before` pages back from a day. */
export async function journalDays(vaultId: number, opts: { before?: string; limit?: number } = {}): Promise<JournalDay[]> {
  const limit = Math.min(Math.max(opts.limit ?? 30, 1), 100);
  const before = opts.before && DAY.test(opts.before) ? dailyNotePath(opts.before) : null;
  const rows = await sql<{ id: number; path: string; content: string }[]>`
    select id, path, content from notes
    where vault_id = ${vaultId} and path ~ ${`^${DAILY_FOLDER}/[0-9]{4}-[0-9]{2}-[0-9]{2}\\.md$`}
      and content ~* ${HAS_JOURNAL}
      ${before ? sql`and path < ${before}` : sql``}
    order by path desc limit ${limit}`;
  return daily(rows);
}

/** Journal days on this date in earlier years, newest first. */
export async function onThisDay(vaultId: number, day: string): Promise<JournalDay[]> {
  if (!DAY.test(day)) throw new HttpError(400, "That isn't a day");
  const rows = await sql<{ id: number; path: string; content: string }[]>`
    select id, path, content from notes
    where vault_id = ${vaultId} and path like ${`${DAILY_FOLDER}/____-${day.slice(5)}.md`} and path < ${dailyNotePath(day)}
      and content ~* ${HAS_JOURNAL}
    order by path desc limit 20`;
  return daily(rows);
}
