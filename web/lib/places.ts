// Where you were in each note (cursor and scroll), so it reopens there. Kept on this device for
// the most recent 200 notes, and forgotten with everything else at sign-out or when someone else
// signs in (web/lib/offline.ts). Positions only, never text.

const KEY = "cp:places";
const MAX = 200;

export interface Place {
  anchor: number;
  head: number;
  top: number;
}

function all(): Record<string, Place> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}");
  } catch {
    return {};
  }
}

export const getPlace = (key: string): Place | null => all()[key] ?? null;

export function setPlace(key: string, place: Place): void {
  const m = all();
  delete m[key]; // newest last, so the oldest go first
  m[key] = place;
  const keys = Object.keys(m);
  for (const k of keys.slice(0, Math.max(0, keys.length - MAX))) delete m[k];
  try {
    localStorage.setItem(KEY, JSON.stringify(m));
  } catch {}
}

export function forgetPlaces(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}
