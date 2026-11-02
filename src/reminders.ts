// Reminders for dated tasks (F35, docs/design/F35.md). The server only says which tasks are due
// and when; the iPhone and Mac apps schedule the alerts on the device (no push service, so nothing
// leaves the server but this list, to the person it's for). A task reminds you when it's open, has
// a date (📅 2026-11-02) and either sits in a note you wrote or last edited, or names you
// (@David, @David Oliver, [[David Oliver]]). ⏰ 14:30 (or ⏰ 2026-11-02 14:30) gives it a time;
// otherwise it's your reminder time, 09:00 unless you change it in Settings → Account.

import { createHash } from "node:crypto";
import { sql } from "./db";
import { tasksIn } from "./tasks";

const AT = /⏰\s*(?:(\d{4}-\d{2}-\d{2})\s+)?(\d{1,2}):(\d{2})/u;
/** The Tasks format's markers, left out of what the alert says. */
const MARKS = /\s*(?:[📅⏰⏳🛫✅➕❌]\s*\d{4}-\d{2}-\d{2}(?:\s+\d{1,2}:\d{2})?|⏰\s*\d{1,2}:\d{2}|[⏫🔼🔽🔺⏬]|🔁[^📅⏰⏳🛫✅➕]*)/gu;
const MAX = 200;

export interface Reminder {
  /** Stable while the task's words don't change: the apps replace alerts by it. */
  key: string;
  vaultId: number;
  vault: string;
  noteId: number;
  path: string;
  title: string;
  line: number;
  /** The task line as written, which ticking it needs. */
  task: string;
  /** What the alert says. */
  text: string;
  due: string;
  /** When to remind, in the device's own time: 2026-11-02T09:00. */
  at: string;
}

export interface ReminderSettings {
  on: boolean;
  time: string;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether a task's words name this person: @First, @Full Name or [[Full Name]] (any case). */
export function namesPerson(text: string, name: string): boolean {
  const full = name.trim();
  if (!full) return false;
  const first = full.split(/\s+/)[0]!;
  const forms = [...new Set([full, first])].map(escapeRe);
  const re = new RegExp(`(?:@(?:${forms.join("|")})(?![\\p{L}\\p{N}_])|\\[\\[(?:${forms.join("|")})(?:[|#][^\\]]*)?\\]\\])`, "iu");
  return re.test(text);
}

/** When to remind: the task's own time, or the person's reminder time on the due date. */
export function remindAt(task: string, due: string, time: string): string {
  const m = AT.exec(task);
  if (m) return `${m[1] ?? due}T${m[2]!.padStart(2, "0")}:${m[3]}`;
  return `${due}T${time}`;
}

export const cleanTask = (task: string) => task.replace(MARKS, "").replace(/\s+/g, " ").trim();

export async function reminderSettings(userId: number): Promise<ReminderSettings> {
  const [u] = await sql`select reminders_on, reminder_time from users where id = ${userId}`;
  return { on: u?.reminders_on ?? true, time: u?.reminder_time ?? "09:00" };
}

export async function setReminderSettings(userId: number, s: Partial<ReminderSettings>): Promise<ReminderSettings> {
  if (s.on !== undefined) await sql`update users set reminders_on = ${s.on} where id = ${userId}`;
  if (s.time !== undefined) await sql`update users set reminder_time = ${s.time} where id = ${userId}`;
  return reminderSettings(userId);
}

/** This person's reminders from yesterday (the device skips any already past) to `days` ahead. */
export async function remindersFor(user: { id: number; name: string }, days = 14, today = new Date()): Promise<ReminderSettings & { reminders: Reminder[] }> {
  const settings = await reminderSettings(user.id);
  if (!settings.on) return { ...settings, reminders: [] };
  const day = (offset: number) => new Date(today.getTime() + offset * 86_400_000).toISOString().slice(0, 10);
  const from = day(-1);
  const to = day(days);
  const rows = await sql`
    select n.id, n.vault_id, v.name as vault, n.path, n.title, n.content, n.created_by, n.updated_by
    from notes n join vault_members m on m.vault_id = n.vault_id and m.user_id = ${user.id} join vaults v on v.id = n.vault_id
    where n.content like '%📅%' and n.content ~ '\\[ \\]'
    order by n.updated_at desc limit 3000`;
  const out: Reminder[] = [];
  for (const r of rows) {
    const mine = Number(r.created_by) === user.id || Number(r.updated_by) === user.id;
    for (const t of tasksIn(r.content)) {
      if (t.done || !t.due || t.due < from || t.due > to) continue;
      if (!mine && !namesPerson(t.text, user.name)) continue;
      const key = createHash("sha256").update(`${r.vault_id}:${r.id}:${t.text}`).digest("hex").slice(0, 16);
      out.push({ key, vaultId: Number(r.vault_id), vault: r.vault, noteId: Number(r.id), path: r.path, title: r.title, line: t.line, task: t.text, text: cleanTask(t.text) || r.title, due: t.due, at: remindAt(t.text, t.due, settings.time) });
    }
  }
  out.sort((a, b) => a.at.localeCompare(b.at) || a.title.localeCompare(b.title) || a.line - b.line);
  return { ...settings, reminders: out.slice(0, MAX) };
}
