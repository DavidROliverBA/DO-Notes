// Commonplace's service worker (F4): the app opens with no signal. Network first for everything,
// so online you always get the latest; the copy here is used only when the network fails. Notes'
// text and edits offline live in IndexedDB (y-indexeddb, NoteView), not here; this keeps the app
// itself and the reads it needs to start: session, vaults, note lists, note metadata, pictures.
//
// Never cached: writes, the live socket, the event stream, AI, search, exports and backups.
// Signing out clears everything this worker stored (web/lib/offline.ts forgetEverything), and
// someone else signing in on this browser clears the cached reads (claimDevice). If API is renamed,
// rename it there too.

const SHELL = "cp-shell-v1";
const API = "cp-api-v1";

// GET /api/… reads worth keeping for offline: enough to open a vault and its notes.
const API_KEEP = [
  /^\/api\/session$/,
  /^\/api\/vaults$/,
  /^\/api\/vaults\/\d+\/(notes|tags|folders|types)$/,
  /^\/api\/vaults\/\d+\/notes\/\d+(\/links)?$/,
  /^\/api\/vaults\/\d+\/types\/[^/]+$/,
  /^\/api\/vaults\/\d+\/days\/\d{4}-\d{2}-\d{2}$/,
  /^\/api\/vaults\/\d+\/files$/,
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      const res = await fetch("/", { cache: "no-store" });
      if (!res.ok) return;
      const html = await res.clone().text();
      await cache.put("/", res);
      // The page's scripts, styles and icons, as the HTML names them.
      const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => new URL(m[1], self.location.origin)).filter((u) => u.origin === self.location.origin);
      await Promise.all(urls.map((u) => fetch(u, { cache: "no-store" }).then((r) => r.ok && cache.put(u.pathname + u.search, r)).catch(() => {})));
    })(),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const k of await caches.keys()) if (k !== SHELL && k !== API) await caches.delete(k);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "forget") event.waitUntil(Promise.all([caches.delete(API), caches.delete(SHELL)]));
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.method !== "GET") {
    // Signing out: forget this person's cached reads.
    if (url.pathname === "/api/logout") event.waitUntil(caches.delete(API));
    return;
  }
  // Published sites (F18) are not the app: never served from, or kept in, its caches.
  if (url.pathname.startsWith("/ws/") || url.pathname.startsWith("/p/") || url.pathname === "/sw.js") return;

  if (url.pathname.startsWith("/api/")) {
    if (!API_KEEP.some((r) => r.test(url.pathname))) return;
    event.respondWith(networkFirst(req, API, req.url));
    return;
  }
  // Pages: the app is one page; any path opens the cached shell when offline.
  if (req.mode === "navigate") {
    event.respondWith(networkFirst(req, SHELL, "/"));
    return;
  }
  event.respondWith(networkFirst(req, SHELL, url.pathname + url.search));
});

async function networkFirst(req, cacheName, key) {
  const cache = await caches.open(cacheName);
  try {
    const res = await fetch(req);
    // Keep good answers only; an error page or a 401 must never become the offline copy.
    if (res.ok && res.type === "basic") await cache.put(key, res.clone());
    // On the Mac, a cloud collection whose cloud can't be reached (F23): offline, like no signal.
    if (res.status === 503 && res.headers.get("X-Cloud-Unreachable")) return (await cache.match(key)) ?? res;
    return res;
  } catch {
    const hit = await cache.match(key);
    if (hit) return hit;
    if (cacheName === API) return new Response(JSON.stringify({ error: "You're offline, and this hasn't been opened on this device yet." }), { status: 503, headers: { "Content-Type": "application/json" } });
    return Response.error();
  }
}
