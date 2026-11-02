// HTTP + WebSocket server. Bun bundles the React client from web/index.html on the fly (with
// hot reload under `bun run dev`), so there is no separate build step.

import { dirname, join } from "node:path";
import index from "../web/index.html";
import { apiRoutes } from "./api";
import { sameOrigin, sessionHash } from "./auth";
import { appSiteAssociation } from "./iosApp";
import { type CollabData, flushAll, onClose, onMessage, onOpen } from "./collab";
import { sql } from "./db";
import { backfill } from "./embed";
import { readOldPdfs } from "./fileText";
import { startScheduler } from "./gitAuto";
import { startFolderSync } from "./folderSync";
import { dbVersions, migrate } from "./migrate";
import { adoptCanvasFiles, pruneRevisions, purgeTrash } from "./notes";
import { oauthRoutes } from "./oauth";
import { serveSite } from "./publish";
import { serveShared } from "./shareLink";
import { dataviewjsSandbox } from "./sandbox";
import { canWrite, roleIn } from "./vaults";
import { requestUser, socketKey } from "./tokens";
import { isCloudVault, loadAliases, type ProxyData, socketClose, socketMessage, socketOpen, socketTarget } from "./remote";

/** A live socket relayed to the cloud library (F23) rather than a room here. */
const isProxy = (ws: { data: unknown }): boolean => (ws.data as { kind?: string }).kind === "proxy";
import { generatedSetupToken, settings } from "./settings";

await migrate();
const boards = await adoptCanvasFiles();
if (boards) console.log(`kept ${boards} .canvas file${boards === 1 ? "" : "s"} as boards`);

// Trash keeps notes for TRASH_DAYS, and each note its newest versions; tidy at boot and every
// six hours.
const purge = () =>
  Promise.all([
    purgeTrash().then((n) => n && console.log(`purged ${n} notes from Trash`)),
    pruneRevisions().then((n) => n && console.log(`pruned ${n} old note versions`)),
  ]).catch((e) => console.error("tidying failed:", e));
void purge();
setInterval(purge, 6 * 60 * 60 * 1000).unref();

// Automatic pushes to GitHub (F19): due vaults are looked for once a minute.
startScheduler();

// The cloud library's collections, on the Mac (F23): their ids work before the menu is fetched.
await loadAliases();

// Folder vaults on the Mac (F22): watched, and rescanned now and then.
void startFolderSync().catch((e) => console.error("folder sync failed to start:", e));

// ── security headers (N13) ──────────────────────────────────────────────────────────────────
// Bun's HTML-bundle route takes no headers, so the bundle is mounted at a private path and the app's
// own "/*" route serves its HTML with them: fetched once from that path over loopback in
// production (the bundle never changes there), and on every request in development (it rebuilds
// on edits). Its scripts, styles and icons are still served by Bun itself.

const development = process.env.NODE_ENV !== "production";
const SHELL_PATH = `/__app-shell-${crypto.randomUUID()}`;

/** As the session cookie decides `Secure` (src/auth.ts), so HSTS is sent exactly when it is. */
const isHttps = (req: Request) =>
  settings.cookieSecure ?? (req.headers.get("x-forwarded-proto") ?? new URL(req.url).protocol.replace(":", "")) === "https";

/** The app page's policy. Scripts are the bundle's own files only (Bun's dev server adds one inline
 *  script, so development allows inline script). Styles allow inline: React and CodeMirror set
 *  them. Notes may show remote https images (Referrer-Policy keeps the note's address from them).
 *  The live socket is same-origin ws/wss. Nothing may frame the app. */
function appCsp(req: Request): string {
  const host = req.headers.get("host");
  const ws = host ? ` ${isHttps(req) ? "wss" : "ws"}://${host}` : "";
  return [
    "default-src 'self'",
    `script-src 'self'${development ? " 'unsafe-inline'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    `connect-src 'self'${ws}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "frame-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** Headers every app response carries, unless it set its own (attachments have a sandboxing CSP). */
function securityHeaders(req: Request, res: Response, html = false): Response {
  const want: [string, string][] = [
    ["X-Content-Type-Options", "nosniff"],
    ["Referrer-Policy", "same-origin"],
    ["X-Frame-Options", "DENY"],
    ["Content-Security-Policy", html ? appCsp(req) : "default-src 'none'; frame-ancestors 'none'"],
  ];
  if (isHttps(req)) want.push(["Strict-Transport-Security", "max-age=31536000"]);
  const set = (h: Headers) => {
    for (const [k, v] of want) if (!h.has(k)) h.set(k, v);
  };
  try {
    set(res.headers);
    return res;
  } catch {
    // An immutable response (e.g. one passed through from fetch): copy it.
    const copy = new Response(res.body, res);
    set(copy.headers);
    return copy;
  }
}

type AnyHandler = (req: any, srv: any) => Response | undefined | void | Promise<Response | undefined | void>;
const guard =
  <H extends AnyHandler>(fn: H) =>
  async (req: Request, srv: Bun.Server<CollabData>) => {
    const res = await fn(req, srv);
    return res instanceof Response ? securityHeaders(req, res) : res;
  };
/** Every route of a route table with the security headers added. */
function guarded<T extends Record<string, unknown>>(table: T): T {
  const out: Record<string, unknown> = {};
  for (const [path, v] of Object.entries(table)) {
    if (typeof v === "function") out[path] = guard(v as AnyHandler);
    else if (v instanceof Response) throw new Error(`route ${path}: give a function, so its headers can be added`);
    else if (v && typeof v === "object") out[path] = Object.fromEntries(Object.entries(v).map(([m, h]) => [m, typeof h === "function" ? guard(h as AnyHandler) : h]));
    else out[path] = v;
  }
  return out as T;
}

const HELP_IMAGES = join(import.meta.dir, "..", "docs", "help", "images");
const MERMAID_JS = join(dirname(Bun.resolveSync("mermaid/package.json", import.meta.dir)), "dist", "mermaid.min.js");

let shellCache: Promise<{ body: ArrayBuffer; type: string }> | null = null;
async function appShell(req: Request, srv: Bun.Server<CollabData>): Promise<Response> {
  const load = async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}${SHELL_PATH}`);
    if (!r.ok) throw new Error(`the app's page answered ${r.status}`);
    return { body: await r.arrayBuffer(), type: r.headers.get("content-type") ?? "text/html;charset=utf-8" };
  };
  let shell;
  try {
    shell = await (development ? load() : (shellCache ??= load().catch((e) => ((shellCache = null), Promise.reject(e)))));
  } catch (e) {
    console.error("serving the app page failed:", e);
    return securityHeaders(req, new Response("The app is starting; try again in a moment.", { status: 503, headers: { "Retry-After": "2" } }));
  }
  return securityHeaders(req, new Response(shell.body, { headers: { "Content-Type": shell.type, "Cache-Control": "no-cache" } }), true);
}

const server = Bun.serve<CollabData>({
  port: settings.port,
  hostname: "0.0.0.0", // reachable from a phone on the same network
  idleTimeout: 60, // SSE pings every 20s keep event streams open
  // The largest request is an import; anything bigger is refused before it's read, whether or not
  // it says its length up front.
  maxRequestBodySize: settings.maxImportBytes + 1024 * 1024,
  development,
  routes: {
    [SHELL_PATH]: index, // served to the world only through "/*" below, with its headers
    ...guarded({
      "/manifest.webmanifest": () => new Response(Bun.file(new URL("../web/manifest.webmanifest", import.meta.url)), { headers: { "Content-Type": "application/manifest+json" } }),
      "/icon.svg": () => new Response(Bun.file(new URL("../web/icon.svg", import.meta.url)), { headers: { "Content-Type": "image/svg+xml" } }),
      "/apple-touch-icon.png": () => new Response(Bun.file(new URL("../web/apple-touch-icon.png", import.meta.url)), { headers: { "Content-Type": "image/png" } }),
      // The service worker (F4), at the root so it can serve every page; never cached itself, so a
      // new version reaches people on their next visit. A worker runs under its own script's CSP,
      // and it fetches the app's pages and reads, so it gets 'self' rather than the API's 'none'.
      "/sw.js": () =>
        new Response(Bun.file(new URL("../web/sw.js", import.meta.url)), {
          headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache", "Service-Worker-Allowed": "/", "Content-Security-Policy": "default-src 'self'" },
        }),
      // The frame dataviewjs blocks run in (src/sandbox.ts): an opaque origin with no network.
      "/sandbox/dataviewjs": async () => {
        const { html, csp } = await dataviewjsSandbox(development);
        return new Response(html, {
          headers: {
            "Content-Type": "text/html; charset=utf-8",
            "Cache-Control": "no-cache",
            "Content-Security-Policy": `${csp}; frame-ancestors 'self'; sandbox allow-scripts`,
            "X-Frame-Options": "SAMEORIGIN",
          },
        });
      },
      // Mermaid's browser build (web/lib/mermaidLib.ts), fetched the first time a note has a diagram.
      "/vendor/mermaid.js": () =>
        new Response(Bun.file(MERMAID_JS), { headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" } }),
      // The help's pictures (docs/help/images/, shown by web/components/Help.tsx).
      "/help/images/:name": (req: Bun.BunRequest<"/help/images/:name">) => {
        const name = req.params.name;
        if (!/^[a-z0-9-]+\.webp$/.test(name)) return new Response("Not found", { status: 404 });
        const file = Bun.file(join(HELP_IMAGES, name));
        return file.size ? new Response(file, { headers: { "Content-Type": "image/webp", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" } }) : new Response("Not found", { status: 404 });
      },
      // The iPhone app's links and passwords (src/iosApp.ts); nothing unless APPLE_APP_IDS is set.
      "/.well-known/apple-app-site-association": () =>
        settings.appleAppIds.length ? Response.json(appSiteAssociation(settings.appleAppIds)) : Response.json({ error: "Not found" }, { status: 404 }),
      "/health": async () => {
        await sql`select 1`;
        return Response.json({ ok: true });
      },
      ...apiRoutes,
      ...oauthRoutes,
      "/api/*": () => Response.json({ error: "Not found" }, { status: 404 }),
    }),

    // Published sites (F18): served from their snapshot, with no app around them.
    "/p/*": (req: Request) => serveSite(req),
    // One note shared by link (F38).
    "/s/*": (req: Request) => serveShared(req),

    // Live editing socket. The y-websocket client connects to `/ws/<noteId>`.
    "/ws/:noteId": async (req: Bun.BunRequest<"/ws/:noteId">, srv: Bun.Server<CollabData>) => {
      if (!sameOrigin(req)) return new Response("Cross-origin socket refused", { status: 403 });
      // The browser's session, or a Mac's device token (F23), whose sockets revoking closes.
      let who;
      try {
        who = await requestUser(req);
      } catch {
        who = null;
      }
      if (!who) return new Response("Sign in required", { status: 401 });
      const user = who.user;
      // A note in a cloud collection, opened on the Mac (F23): relayed to the cloud's socket.
      const cloudId = Number(new URL(req.url).searchParams.get("v"));
      if (!who.deviceToken && isCloudVault(cloudId)) {
        try {
          const data = await socketTarget(user, cloudId, Number(req.params.noteId));
          if ((srv as unknown as Bun.Server<ProxyData>).upgrade(req, { data })) return undefined as unknown as Response;
          return new Response("Expected a WebSocket", { status: 426 });
        } catch (e) {
          return new Response((e as Error).message, { status: (e as { status?: number }).status ?? 503 });
        }
      }
      const noteId = Number(req.params.noteId);
      const [n] = Number.isSafeInteger(noteId) ? await sql`select vault_id from notes where id = ${noteId}` : [];
      if (!n) return new Response("Note not found", { status: 404 });
      let role;
      try {
        role = await roleIn(n.vault_id, user.id);
      } catch {
        return new Response("Note not found", { status: 404 });
      }
      const data: CollabData = { kind: "collab", noteId, vaultId: n.vault_id, userId: user.id, canWrite: canWrite(role), sessionHash: who.deviceToken ? socketKey(who.deviceToken) : sessionHash(req) };
      if (srv.upgrade(req, { data })) return undefined as unknown as Response;
      return new Response("Expected a WebSocket", { status: 426 });
    },

    // Everything else is the single-page app (client-side routing), with its security headers.
    "/*": (req: Request, srv: Bun.Server<CollabData>) => appShell(req, srv),
  },
  websocket: {
    open: (ws) => (isProxy(ws) ? socketOpen(ws as any) : void onOpen(ws)),
    message: (ws, msg) => (isProxy(ws) ? socketMessage(ws as any, msg as Buffer) : onMessage(ws, msg as Buffer)),
    close: (ws) => (isProxy(ws) ? socketClose(ws as any) : onClose(ws)),
    idleTimeout: 120,
    maxPayloadLength: 16 * 1024 * 1024,
  },
});

if (generatedSetupToken) {
  const [{ count }] = (await sql`select count(*)::int as count from users`) as unknown as [{ count: number }];
  if (count === 0) console.log(`No accounts yet: create the first (admin) account with the setup token ${generatedSetupToken}, or set SETUP_TOKEN.`);
}

const queued = await backfill();
// The words in PDFs, for search (src/fileText.ts): any not read yet, now and every two minutes,
// whichever way they arrived (upload, import, GitHub, a folder on the Mac).
const readPdfs = () => readOldPdfs().catch((e) => console.warn(`reading PDFs: ${(e as Error).message}`));
void readPdfs();
setInterval(readPdfs, 2 * 60_000).unref?.();
console.log(
  `commonplace on http://localhost:${server.port}  (${await dbVersions()}; embeddings: ${settings.embeddingProvider}${queued ? `, ${queued} notes queued` : ""})`,
);

async function shutdown() {
  console.log("flushing open notes…");
  // Render stops a slow process after 30 s; never hang here waiting on one stuck save.
  const flushed = await Promise.race([flushAll().then(() => true), Bun.sleep(10_000).then(() => false)]);
  if (!flushed) {
    const busy = await Promise.race([
      sql`select pid, state, wait_event_type, wait_event, left(query, 120) as query, now() - xact_start as age from pg_stat_activity where datname = current_database() and pid <> pg_backend_pid() and state <> 'idle'`.catch(() => []),
      Bun.sleep(2_000).then(() => "database not answering"),
    ]);
    console.error("shutdown: some notes didn't finish saving within 10 s; database activity:", busy);
  }
  await sql.end({ timeout: 5 });
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
