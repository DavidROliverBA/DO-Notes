// A tiny client-side router: the URL is the only navigation state. navigate() pushes or replaces
// history and fires `cp:navigate`, which usePath() listens for alongside popstate; parseRoute()
// turns a path into the screen App shows. The server serves index.html for every one of these.

import { useEffect, useState } from "react";

// The standalone file (standalone/) is opened from disk, where history can't hold the app's
// paths: keepInMemory() makes it keep the path (and its ?query) in memory instead.
let memory: string | null = null;
export const keepInMemory = (start = "/") => void (memory = start);
const here = () => memory ?? location.pathname + location.search;
export const currentPath = () => (memory ?? location.pathname).replace(/\?.*$/, "");
export const currentSearch = () => (memory === null ? location.search : memory.includes("?") ? memory.slice(memory.indexOf("?")) : "");

export function navigate(path: string, replace = false) {
  if (path === here()) return;
  if (memory !== null) memory = path;
  else if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  window.dispatchEvent(new Event("cp:navigate"));
}

/** Change the ?query without telling anyone (a page keeping its own state in the address). */
export function replaceQuietly(path: string) {
  if (memory !== null) memory = path;
  else history.replaceState(history.state, "", path);
}

export function usePath(): string {
  const [path, setPath] = useState(currentPath);
  useEffect(() => {
    const on = () => setPath(currentPath());
    window.addEventListener("popstate", on);
    window.addEventListener("cp:navigate", on);
    return () => {
      window.removeEventListener("popstate", on);
      window.removeEventListener("cp:navigate", on);
    };
  }, []);
  return path;
}

export type Route =
  | { page: "home" }
  | { page: "vault"; vaultId: number }
  | { page: "note"; vaultId: number; noteId: number }
  | { page: "graph"; vaultId: number }
  | { page: "type"; vaultId: number; name: string }
  | { page: "tasks"; vaultId: number }
  | { page: "journal"; vaultId: number }
  | { page: "changes"; vaultId: number };

export function parseRoute(path: string): Route {
  let m = /^\/v\/(\d+)\/n\/(\d+)/.exec(path);
  if (m) return { page: "note", vaultId: Number(m[1]), noteId: Number(m[2]) };
  m = /^\/v\/(\d+)\/t\/([^/]+)/.exec(path);
  if (m) return { page: "type", vaultId: Number(m[1]), name: decodeURIComponent(m[2]!) };
  m = /^\/v\/(\d+)\/tasks/.exec(path);
  if (m) return { page: "tasks", vaultId: Number(m[1]) };
  m = /^\/v\/(\d+)\/journal/.exec(path);
  if (m) return { page: "journal", vaultId: Number(m[1]) };
  m = /^\/v\/(\d+)\/changes/.exec(path);
  if (m) return { page: "changes", vaultId: Number(m[1]) };
  m = /^\/v\/(\d+)\/graph/.exec(path);
  if (m) return { page: "graph", vaultId: Number(m[1]) };
  m = /^\/v\/(\d+)/.exec(path);
  if (m) return { page: "vault", vaultId: Number(m[1]) };
  return { page: "home" };
}

export const noteUrl = (vaultId: number, noteId: number) => `/v/${vaultId}/n/${noteId}`;
