// The journal (F24): "New journal entry" opens a short sheet from anywhere (⌘K, a note's ⋯ menu,
// press and hold on Today); the entry goes into today's daily note of your home collection,
// stamped with this device's day and time. Module state, so commands can open it. Release 2
// adds importing a Day One export and "Reflect on this week" (the assistant, given the week).

import { useSyncExternalStore } from "react";
import { api } from "./api";
import { formatDate } from "./templates";
import { confirmDialog, toast, toastError } from "../ui/overlays";

let open = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((f) => f());

export function newJournalEntry(): void {
  open = true;
  emit();
}
export function closeJournalEntry(): void {
  open = false;
  emit();
}
export const useJournalEntryOpen = () => useSyncExternalStore((f) => (listeners.add(f), () => void listeners.delete(f)), () => open);

export interface Added {
  vaultId: number;
  noteId: number;
  path: string;
  day: string;
  time: string;
}

/** Add an entry now, by this device's clock, to the home collection (or `vaultId`). */
export function addJournalEntry(text: string, vaultId?: number): Promise<Added> {
  const now = new Date();
  return api<Added>("/journal", { body: { text, vaultId, day: formatDate(now, "YYYY-MM-DD"), time: formatDate(now, "HH:mm") } });
}

export interface JournalDay {
  day: string;
  noteId: number;
  entries: { time: string; text: string }[];
}

export const journalUrl = (vaultId: number) => `/v/${vaultId}/journal`;

// Release 2: the journal changes when entries are imported; the page reads it again.
let changes = 0;
const changeListeners = new Set<() => void>();
export function journalChanged(): void {
  changes++;
  changeListeners.forEach((f) => f());
}
export const useJournalChanges = () => useSyncExternalStore((f) => (changeListeners.add(f), () => void changeListeners.delete(f)), () => changes);

export interface ImportSummary {
  entries: number;
  days: number;
  empty: number;
  already: number;
  files: number;
}

const count = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** Choose a file, as a button would (the ⌘K command has no button to hold the input). */
export function pickFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** Import a Day One export (Export → JSON in Day One: a zip) into a collection's daily notes:
 *  counted first, then asked, then written. True when something was imported. */
export async function importDayOne(vault: { id: number; name: string }): Promise<boolean> {
  const file = await pickFile(".zip,.json,application/zip,application/json");
  if (!file) return false;
  const send = (dryRun: boolean) => {
    const form = new FormData();
    form.set("file", file);
    form.set("dryRun", String(dryRun));
    return api<ImportSummary>(`/vaults/${vault.id}/journal/import`, { form });
  };
  try {
    const plan = await send(true);
    if (!plan.entries) {
      toast(plan.already ? `Everything in that export is already in ${vault.name}` : "There's nothing to import in that export");
      return false;
    }
    const notes = [
      `They go into ${vault.name}'s daily notes under Journal, on ${count(plan.days, "day")}, each at the time it was written${plan.files ? `, with ${count(plan.files, "photo or file", "photos and files")}` : ""}.`,
      plan.already ? `${count(plan.already, "entry is", "entries are")} already there and will be left out.` : "",
      plan.empty ? `${count(plan.empty, "empty entry", "empty entries")} will be skipped.` : "",
    ];
    if (!(await confirmDialog({ title: `Import ${count(plan.entries, "entry", "entries")} from Day One?`, message: notes.filter(Boolean).join(" "), action: "Import" }))) return false;
    const done = await send(false);
    journalChanged();
    toast(`Imported ${count(done.entries, "entry", "entries")} into ${count(done.days, "day")}`);
    return true;
  } catch (e) {
    toastError(e);
    return false;
  }
}

/** What "Reflect on this week" asks the assistant: the last seven days' entries, oldest first,
 *  and a request to reflect without changing anything. Null when the week has none. */
export async function weekReflection(vaultId: number, now = new Date()): Promise<string | null> {
  const from = formatDate(new Date(now.getTime() - 6 * 86_400_000), "YYYY-MM-DD");
  const { days } = await api<{ days: JournalDay[] }>(`/vaults/${vaultId}/journal`);
  const week = days.filter((d) => d.day >= from && d.day <= formatDate(now, "YYYY-MM-DD")).reverse();
  if (!week.length) return null;
  const entries = week
    .map((d) => `## ${formatDate(new Date(`${d.day}T12:00:00`), "dddd D MMMM")}\n\n${d.entries.map((e) => `${e.time}: ${e.text}`).join("\n\n")}`)
    .join("\n\n");
  return [
    "Reflect on my journal for the past week. Here are the entries:",
    entries,
    "Please: sum up the week in a few sentences; name the themes and feelings that come up more than once; note what went well and what weighed on me; and end with one or two gentle questions for me to think about. Quote my own words where it helps. Don't change or create any notes.",
  ].join("\n\n");
}
