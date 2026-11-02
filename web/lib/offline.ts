// Notes kept on this device for offline use (F4). Each opened note's Yjs state lives in its own
// IndexedDB database (y-indexeddb), named for this server's database, the signed-in person and the
// note, so edits made with no signal survive closing the app and merge when it reconnects. The most
// recently opened KEEP notes stay; older ones are dropped. Signing out forgets them all, and so
// does someone else signing in on this browser (claimDevice): one person's notes are never left
// on a shared device for the next, even when the first one's session simply expired.

import { forgetPlaces } from "./places";
import { useEffect, useState } from "react";

const KEEP = 200;
const INDEX = "cp:offline";
/** Whose copies are on this device: `<instance>-u<userId>`. */
const OWNER = "cp:offline-owner";
/** The service worker's cache of API reads (web/sw.js API). */
const API_CACHE = "cp-api-v1";

type Entry = { db: string; at: number };

function read(): Record<string, Entry> {
  try {
    return JSON.parse(localStorage.getItem(INDEX) ?? "{}");
  } catch {
    return {};
  }
}
function write(m: Record<string, Entry>) {
  try {
    localStorage.setItem(INDEX, JSON.stringify(m));
  } catch {}
}

const owner = (instance: string, userId: number) => `${instance || "local"}-u${userId}`;

/** The IndexedDB name for a note's offline copy, kept for one person. A note in a cloud
 *  collection on the Mac (F23) has the cloud's id, so its name says which collection too, under
 *  the same owner so claimDevice treats it as this person's. */
export const offlineName = (instance: string, userId: number, noteId: number, cloudVault?: number) =>
  `cp-${owner(instance, userId)}-${cloudVault ? `c${cloudVault}-` : ""}${noteId}`;

/** Record that a note was opened, and drop the oldest copies beyond KEEP. */
export function rememberOpened(db: string) {
  const m = read();
  m[db] = { db, at: Date.now() };
  const all = Object.values(m).sort((a, b) => b.at - a.at);
  for (const old of all.slice(KEEP)) {
    delete m[old.db];
    try {
      indexedDB.deleteDatabase(old.db);
    } catch {}
  }
  write(m);
}

/** Delete every offline copy on this device except those named with `keep` (a name prefix), and
 *  return once the deletes are under way. Copies are found from the index and, where the browser
 *  can list them, from IndexedDB itself, so ones the index lost (or made under the old naming,
 *  `cp-<instance>-<noteId>`, which said nothing of whose they were) go too. */
async function dropCopies(keep: string | null): Promise<void> {
  const names = new Set(Object.keys(read()));
  try {
    for (const d of (await indexedDB.databases?.()) ?? []) if (d.name?.startsWith("cp-")) names.add(d.name);
  } catch {}
  const m = read();
  for (const name of names) {
    if (keep && name.startsWith(keep)) continue;
    delete m[name];
    try {
      indexedDB.deleteDatabase(name);
    } catch {}
  }
  write(m);
}

/** The cached reads the service worker keeps (the session, vaults, note lists) belong to whoever
 *  was signed in: drop them. The page shares the worker's caches, so this works even before a
 *  worker controls the page. The app shell (code and icons) is no one's and stays. */
async function dropCachedReads(): Promise<void> {
  try {
    await caches.delete(API_CACHE);
  } catch {}
}

/** Someone is signed in on this device. If it isn't the person whose copies are here (a session
 *  expired and someone else signed in, or the copies predate naming them by person), forget the
 *  previous person's notes and cached reads before any are shown. The same person reopening the
 *  app, online or off, keeps everything. */
export async function claimDevice(instance: string, userId: number): Promise<void> {
  const me = owner(instance, userId);
  let was: string | null = null;
  try {
    was = localStorage.getItem(OWNER);
  } catch {}
  if (was === me) return;
  await Promise.all([dropCopies(`cp-${me}-`), dropCachedReads()]);
  forgetPlaces();
  try {
    localStorage.setItem(OWNER, me);
  } catch {}
}

/** Sign out: forget every note kept on this device, and the app's cached reads. */
export async function forgetEverything(): Promise<void> {
  await dropCopies(null);
  forgetPlaces();
  try {
    localStorage.removeItem(OWNER);
  } catch {}
  navigator.serviceWorker?.controller?.postMessage({ type: "forget" });
}

/** Whether the browser thinks it's online, kept up to date. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    return () => {
      window.removeEventListener("online", on);
      window.removeEventListener("offline", off);
    };
  }, []);
  return online;
}
