// Spelling and grammar help in the note: the browser's spell check, the iPhone keyboard's
// autocorrect, capitals and suggestions, and Grammarly (its browser extension and its keyboard),
// which all go by the attributes CodeMirror turns off by default. On unless switched off in
// Settings → Account → Writing, and remembered on this device. Editor.tsx applies it, and keeps
// it out of code, properties and links, where a "correction" would break something.

import { useSyncExternalStore } from "react";

const KEY = "cp:writing-aids";
const listeners = new Set<() => void>();

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}
let on = stored();

export const writingAidsOn = () => on;
export function setWritingAids(next: boolean) {
  on = next;
  try {
    if (next) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, "off");
  } catch {}
  listeners.forEach((l) => l());
}
export const useWritingAids = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    writingAidsOn,
  );
