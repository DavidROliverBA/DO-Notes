// Full width: the note's text fills the space between the side panels instead of keeping to a
// reading width, and follows them as they open, close or are dragged wider. A view choice for
// every note, remembered on this device: the button beside the view switch, ⌘K, or Settings →
// Account → Appearance. A note's own `width:` property only matters at the normal width; focus
// mode keeps its reading width either way.

import { useSyncExternalStore } from "react";

const KEY = "cp:full-width";
const listeners = new Set<() => void>();

let on = (() => {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
})();

export const fullWidthOn = () => on;
export function setFullWidth(next: boolean): void {
  on = next;
  try {
    if (next) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {}
  listeners.forEach((l) => l());
}
export const useFullWidth = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    fullWidthOn,
  );
