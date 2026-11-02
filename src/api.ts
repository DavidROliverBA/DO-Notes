// JSON API: every /api route, plus /mcp. Every handler runs through `route()`, which enforces
// same-origin on mutations and turns HttpError (and validation errors) into a JSON error with the
// right status. `id()` parses the numeric ids in the URL. Vault routes start with
// `vaultCtx(ctx, role)`: any write needs at least "editor", and a non-member gets 404, never 403.

import { remindersFor, setReminderSettings } from "./reminders";
import * as panel from "./outsidePanel";
import * as shareLink from "./shareLink";
import * as notifications from "./notifications";
import * as comments from "./comments";
import { isCanvasPath } from "./canvas";
import { boardsFor } from "./boards";
import { assignIds, exportBundle, missingIds } from "./aixf";
import type { Server } from "bun";
import { z } from "zod";
import * as auth from "./auth";
import { HttpError, requireUser, type User } from "./auth";
import { ChatRequest, chatResponse } from "./ai";
import * as assistants from "./assistants";
import * as git from "./git";
import * as gitAuto from "./gitAuto";
import * as graph from "./graph";
import * as web from "./web";
import * as github from "./github";
import * as captureTokens from "./capture";
import { mcpRoute } from "./mcp";
import * as oauth from "./oauth";
import * as connections from "./connections";
import * as passkeys from "./passkeys";
import * as twoStep from "./twoStep";
import * as sendLongview from "./sendLongview";
import * as floe from "./floeLandscape";
import * as tokens from "./tokens";
import { flushNote, kick } from "./collab";
import { sql } from "./db";
import { providerName, semanticEnabled } from "./embed";
import { subscribe } from "./events";
import * as between from "./between";
import * as remote from "./remote";
import * as folders from "./folderSync";
import * as journal from "./journal";
import { importDayOne } from "./dayone";
import * as notes from "./notes";
import { related, search, suggest } from "./search";
import { secretsAvailable } from "./secrets";
import { withProperties } from "./props";
import { backlinksWithProperty, dayActivity, listTypes, relationsFrom, renameType, saveViews, typeNotes, updateType } from "./typeIndex";
import { addKinds, vaultKinds } from "./relationshipIndex";
import { PROP_KINDS, TYPE_COLOURS } from "./types";
import { linkCard, saveWeblink } from "./weblinks";
import { bookmarks, linkMention, removeSearch, savedSearches, saveSearch, setBookmark, setTask, unlinkedMentions, vaultTasks } from "./vaultViews";
import { dataviewFile, dataviewPages, runDataview } from "./dataviewVault";
import { settings } from "./settings";
import { assertRoom, FULL_AT, storageState, WARN_AT } from "./storage";
import { addTour } from "./tour";
import * as site from "./publish";
import { backupStream, type ConflictMode, exportZip, importFiles, saveAttachment } from "./transfer";
import * as vaults from "./vaults";

type Params = Record<string, string>;
type Ctx = { req: Request & { params: Params }; server: Server<any>; url: URL };
type Handler = (ctx: Ctx) => Promise<Response | unknown>;

const json = (data: unknown, init?: ResponseInit) => Response.json(data, init);

/** `tokenOnly`: the handler signs in by its bearer token alone, never the session cookie, so a
 *  request from another origin (the web clipper's extension, F37) can't ride on someone's cookie
 *  and needn't be same-origin. */
function route(fn: Handler, opts: { tokenOnly?: boolean } = {}) {
  return async (req: Request & { params: Params }, server: Server<any>) => {
    try {
      if (req.method !== "GET" && req.method !== "HEAD" && !opts.tokenOnly && !auth.sameOrigin(req)) throw new HttpError(403, "Cross-origin request refused");
      // A cloud collection on the Mac (F23): the cloud answers, through src/remote.ts.
      const cloudId = Number(req.params?.v);
      if (req.params?.v && remote.isCloudVault(cloudId) && !new URL(req.url).pathname.endsWith("/send")) return await remote.forward(req, await requireUser(req), cloudId);
      const out = await fn({ req, server, url: new URL(req.url) });
      return out instanceof Response ? out : json(out ?? { ok: true });
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, { status: err.status });
      if (err instanceof z.ZodError) return json({ error: err.issues.map((i) => i.message).join("; ") }, { status: 400 });
      if (err instanceof Error && /^Invalid path|^Path is/.test(err.message)) return json({ error: err.message }, { status: 400 });
      // A unique-constraint race (two creates at once) is a conflict, not a server fault.
      if ((err as { code?: string })?.code === "23505") return json({ error: "That already exists" }, { status: 409 });
      console.error(`${req.method} ${new URL(req.url).pathname} failed:`, err);
      return json({ error: "Something went wrong on the server" }, { status: 500 });
    }
  };
}

const id = (v: string | undefined) => {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0) throw new HttpError(404, "Not found");
  return n;
};

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.infer<T>> {
  let data: unknown;
  try {
    data = await req.json();
  } catch {
    throw new HttpError(400, "Expected a JSON body");
  }
  return schema.parse(data);
}

/** The person, signed in here or through a device token from their Mac (F23). Only for routes
 *  about collections; Settings, Admin, tokens and AI keys use requireUser. */
async function personOrDevice(req: Request): Promise<User> {
  const who = await tokens.requestUser(req);
  if (!who) throw new HttpError(401, "Sign in required");
  return who.user;
}

/** Resolve :v and check the caller's role in that vault. */
async function vaultCtx(ctx: Ctx, min: vaults.Role) {
  const user = await personOrDevice(ctx.req);
  const vaultId = id(ctx.req.params.v);
  const role = await vaults.requireRole(vaultId, user, min);
  return { user, vaultId, role };
}

async function requireAdmin(req: Request): Promise<User> {
  const user = await requireUser(req);
  if (!user.is_admin) throw new HttpError(403, "Admins only");
  return user;
}

const Credentials = z.object({ email: z.string().max(320), password: z.string().max(1024) });
const Role = z.enum(["owner", "editor", "viewer"]);
const AssistantDraft = z.object({
  name: z.string().max(30),
  provider: z.enum(["anthropic", "openai", "relaxai", "compatible"]),
  baseUrl: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(1000),
  price: z.object({ in: z.number(), out: z.number() }).nullable().optional(),
  dailyCap: z.number().nullable().optional(),
  web: z.boolean().optional(),
});

/** The library's name: what an admin called it (Settings → Admin), or the first admin's first
 *  name ("David's Library"), or Commonplace before anyone has signed up. */
/** Sign out every other device of this person (a new password, two-step turned on). */
async function signOutOthers(req: Request, userId: number, why: string): Promise<void> {
  const others = await sql`delete from sessions where user_id = ${userId} and token_hash <> ${auth.sessionHash(req)} returning token_hash`;
  for (const s of others) kick({ sessionHash: s.token_hash }, why);
}

export async function libraryName(): Promise<string> {
  const [set] = await sql`select value from server_info where key = 'library'`;
  if (set?.value) return set.value;
  const [first] = await sql`select name from users where is_admin order by created_at limit 1`;
  const given = String(first?.name ?? "").trim().split(/\s+/)[0];
  return given ? `${given}'s Library` : "DO Notes";
}

export const apiRoutes = {
  // ── session ──────────────────────────────────────────────────────────────────────────
  "/api/session": {
    GET: route(async ({ req }) => {
      const user = (await tokens.requestUser(req))?.user ?? null;
      const [{ n }] = (await sql`select count(*)::int as n from users`) as any;
      const [inst] = await sql`select value from server_info where key = 'instance'`;
      return {
        instance: inst?.value ?? "",
        // Only to people signed in: by default it carries the first admin's name.
        library: user ? await libraryName() : "",
        user,
        needsSetup: n === 0,
        setupTokenRequired: n === 0 && !!settings.setupToken,
        allowSignup: settings.allowSignup || n === 0,
        search: { semantic: semanticEnabled(), provider: providerName() },
        ai: { available: secretsAvailable() },
        // F22: this server can keep collections in folders on the Mac (the laptop kit).
        folders: user ? await folders.available() : false,
        // Admins are told when the database is getting full (N9, src/storage.ts).
        storage: user?.is_admin ? await storageState() : undefined,
      };
    }),
  },
  "/api/register": {
    POST: route(async ({ req }) => {
      const b = await body(req, Credentials.extend({ name: z.string().max(200).default(""), setupToken: z.string().max(512).optional() }));
      const user = await auth.register(b);
      const cookie = await auth.startSession(req, user.id);
      // A new account starts with a collection of its own so the first screen isn't empty.
      await vaults.createVault(user, "Personal");
      return json({ user }, { headers: { "Set-Cookie": cookie } });
    }),
  },
  "/api/login": {
    POST: route(async ({ req }) => {
      const b = await body(req, Credentials);
      const user = await auth.login(b.email, b.password, auth.clientAddress(req));
      // Two-step sign-in (F40): a right password waits for the code app's code.
      if (await twoStep.needsCode(user.id)) return { twoStep: true, flow: twoStep.awaitCode(user) };
      return json({ user }, { headers: { "Set-Cookie": await auth.startSession(req, user.id) } });
    }),
  },
  "/api/login/code": {
    POST: route(async ({ req }) => {
      const b = await body(req, z.object({ flow: z.string().max(64), code: z.string().max(40) }));
      const { user, recovery } = await twoStep.checkCode(b.flow, b.code);
      const left = recovery ? (await twoStep.signInState(user.id)).recoveryLeft : undefined;
      return json({ user, recoveryLeft: left }, { headers: { "Set-Cookie": await auth.startSession(req, user.id) } });
    }),
  },
  // Passkeys (F32, src/passkeys.ts): sign in with Face ID or Touch ID. The options and the
  // answer are two requests; the browser's WebAuthn sits between them.
  "/api/passkeys/login/options": {
    POST: route(async ({ req }) => passkeys.authenticationOptions(req)),
  },
  "/api/passkeys/login": {
    POST: route(async ({ req }) => {
      const b = await body(req, z.object({ flow: z.string().max(64), response: z.any() }));
      const user = await passkeys.authenticate(b.flow, b.response);
      return json({ user }, { headers: { "Set-Cookie": await auth.startSession(req, user.id) } });
    }),
  },
  "/api/passkeys": {
    GET: route(async ({ req }) => passkeys.listPasskeys((await requireUser(req)).id, passkeys.relyingParty(req).rpID)),
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ response: z.any(), name: z.string().max(100).default("") }));
      return passkeys.register(user, b.response, b.name);
    }),
  },
  "/api/passkeys/options": {
    POST: route(async ({ req }) => passkeys.registrationOptions(req, await requireUser(req), await libraryName())),
  },
  "/api/passkeys/:id": {
    DELETE: route(async ({ req }) => {
      await passkeys.remove((await requireUser(req)).id, id(req.params.id));
    }),
  },
  "/api/passkeys/:id/restore": {
    POST: route(async ({ req }) => {
      await passkeys.restore((await requireUser(req)).id, id(req.params.id));
    }),
  },
  "/api/logout": {
    POST: route(async ({ req }) => {
      kick({ sessionHash: auth.sessionHash(req) }, "signed out");
      return json({ ok: true }, { headers: { "Set-Cookie": await auth.endSession(req) } });
    }),
  },
  // F20: the person's home collection, where "home" capture tokens send and the app opens.
  "/api/me/home": {
    PUT: route(async ({ req }) => {
      const user = await requireUser(req);
      const { vaultId } = await body(req, z.object({ vaultId: z.number().int() }));
      await vaults.setHome(user, vaultId);
      return { home: vaultId };
    }),
  },
  // A note by its title, in any of the person's collections (Siri's "Open a note in DO Notes", L8
  // step 5): the same title first, then one starting with the words, then containing them; the
  // home collection and the most recently changed first among equals.
  "/api/find": {
    GET: route(async ({ req }) => {
      const user = await requireUser(req);
      const q = (new URL(req.url).searchParams.get("q") ?? "").trim().slice(0, 200);
      if (!q) return [];
      const like = q.replace(/[\\%_]/g, (c) => `\\${c}`);
      const rows = await sql`
        select n.id, n.vault_id, n.title from notes n join vault_members m on m.vault_id = n.vault_id and m.user_id = ${user.id}
        where n.title ilike ${`%${like}%`} and n.path not ilike '%.canvas'
        order by lower(n.title) = lower(${q}) desc, n.title ilike ${`${like}%`} desc,
                 n.vault_id = (select home_vault_id from users where id = ${user.id}) desc, n.updated_at desc
        limit 5`;
      return rows.map((r) => ({ id: Number(r.id), vaultId: Number(r.vault_id), title: r.title as string }));
    }),
  },
  // Notifications (F39): the bell's list (also what the apps alert with), and marking them read.
  "/api/me/notifications": {
    GET: route(async ({ req }) => notifications.list((await requireUser(req)).id, Number(new URL(req.url).searchParams.get("since") ?? 0) || 0)),
  },
  "/api/me/notifications/read": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ ids: z.array(z.number().int()).max(200).optional(), all: z.boolean().optional() }));
      await notifications.markRead(user.id, b.all ? "all" : (b.ids ?? []));
      return notifications.list(user.id);
    }),
  },
  "/api/me/reminders": {
    // Reminders for dated tasks (F35): the apps fetch these and schedule the alerts.
    GET: route(async ({ req }) => {
      const user = await requireUser(req);
      const days = Number(new URL(req.url).searchParams.get("days") ?? 14);
      return remindersFor(user, Number.isFinite(days) ? Math.min(Math.max(days, 1), 31) : 14);
    }),
    PATCH: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ on: z.boolean().optional(), time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Give the time as HH:MM").optional() }));
      return setReminderSettings(user.id, b);
    }),
  },
  "/api/me": {
    PATCH: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(
        req,
        z.object({ name: z.string().max(200).optional(), currentPassword: z.string().optional(), newPassword: z.string().optional(), passkey: z.object({ flow: z.string().max(64), response: z.any() }).optional() }),
      );
      if (b.name?.trim()) await sql`update users set name = ${b.name.trim()} where id = ${user.id}`;
      if (b.newPassword) {
        // With a password, the current one proves it's them; an account on passkeys only (F40)
        // proves it with a passkey instead.
        if ((await twoStep.signInState(user.id)).password) await auth.login(user.email, b.currentPassword ?? "", auth.clientAddress(req));
        else if (!b.passkey || (await passkeys.authenticate(b.passkey.flow, b.passkey.response)).id !== user.id) throw new HttpError(401, "Confirm it's you with one of your passkeys.");
        auth.validatePassword(b.newPassword);
        await twoStep.setPassword(user.id, b.newPassword);
        // A new password signs out every other device, in case someone else knew the old one.
        await signOutOthers(req, user.id, "password changed");
      }
      return { user: await auth.currentUser(req) };
    }),
  },

  // How a person signs in (F40, src/twoStep.ts): a password or passkeys only, and a code app as
  // a second step. Each change asks for the password again (the sign-in limits apply).
  "/api/me/sign-in": {
    GET: route(async ({ req }) => twoStep.signInState((await requireUser(req)).id)),
  },
  "/api/me/two-step/start": {
    POST: route(async ({ req }) => twoStep.startSetup(await requireUser(req), (await libraryName()) || "DO Notes")),
  },
  "/api/me/two-step": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ code: z.string().max(20), password: z.string().max(1024) }));
      await auth.login(user.email, b.password, auth.clientAddress(req));
      const codes = await twoStep.finishSetup(user.id, b.code);
      // Anyone else signed in with only the password is signed out.
      await signOutOthers(req, user.id, "two-step sign-in turned on");
      return { codes };
    }),
    DELETE: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ password: z.string().max(1024) }));
      await auth.login(user.email, b.password, auth.clientAddress(req));
      await twoStep.turnOff(user.id);
      return twoStep.signInState(user.id);
    }),
  },
  "/api/me/two-step/codes": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ password: z.string().max(1024) }));
      await auth.login(user.email, b.password, auth.clientAddress(req));
      return { codes: await twoStep.replaceRecoveryCodes(user.id) };
    }),
  },
  "/api/me/passwordless": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ password: z.string().max(1024) }));
      await auth.login(user.email, b.password, auth.clientAddress(req));
      await twoStep.dropPassword(user.id, passkeys.relyingParty(req).rpID);
      return twoStep.signInState(user.id);
    }),
  },

  // Tokens for clients other than the browser (src/tokens.ts): the iPhone Shortcut, MCP agents.
  "/api/me/tokens": {
    GET: route(async ({ req }) => tokens.listTokens((await requireUser(req)).id)),
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(
        req,
        z.object({
          kind: z.enum(["capture", "mcp"]).default("capture"),
          vaultId: z.number().int().positive().optional(),
          name: z.string().max(100).default(""),
          notePath: z.string().max(500).default("Inbox"),
          readOnly: z.boolean().default(false),
        }),
      );
      return tokens.createToken(user, b);
    }),
  },
  "/api/me/tokens/:id": {
    DELETE: route(async ({ req }) => {
      const user = await requireUser(req);
      await tokens.revokeToken(user.id, id(req.params.id));
    }),
  },
  // An app signing in to the MCP server (F25, src/oauth.ts): the consent page checks the request,
  // then sends the person's answer, and goes where it's told (back to the app, with a code).
  "/api/oauth/request": {
    GET: route(async ({ req, url }) => {
      await requireUser(req);
      return oauth.checkRequest(req, Object.fromEntries(url.searchParams));
    }),
  },
  "/api/oauth/approve": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ request: z.record(z.string(), z.string().max(4000)), allow: z.boolean(), readOnly: z.boolean().default(false) }));
      return { redirect: await oauth.decide(req, user, b.request, b.allow, b.readOnly) };
    }),
  },
  // Bring your own AI (src/assistants.ts, src/ai.ts). Keys are write-only from here on.
  "/api/me/assistants": {
    GET: route(async ({ req }) => assistants.listAssistants((await requireUser(req)).id)),
    POST: route(async ({ req }) => assistants.createAssistant(await requireUser(req), await body(req, AssistantDraft))),
  },
  // The assistant's web search (src/web.ts): each person's own Brave Search key, write-only.
  "/api/me/web-search": {
    GET: route(async ({ req }) => ({ available: secretsAvailable(), connection: await web.connection((await requireUser(req)).id) })),
    PUT: route(async ({ req }) => {
      const user = await requireUser(req);
      if (!secretsAvailable()) throw new HttpError(503, "This server can't store keys yet: an admin needs to set SECRETS_KEY");
      return web.connect(user.id, (await body(req, z.object({ key: z.string().max(300) }))).key);
    }),
    DELETE: route(async ({ req }) => web.disconnect((await requireUser(req)).id)),
  },
  // Connections (F33, src/connections.ts): each person's read-only connections to services that
  // meet the bar, for the in-app assistant. Presets (Longview, Recall) fill in what's known.
  "/api/me/connections": {
    GET: route(async ({ req }) => connections.list((await requireUser(req)).id)),
    // A preset that signs in with a token, or any service with a token or none (F33 step 2).
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(
        req,
        z.object({ preset: z.string().max(40).optional(), address: z.string().max(500).default(""), token: z.string().max(500).default(""), name: z.string().max(60).optional(), noSignIn: z.boolean().optional() }),
      );
      if (b.preset) return connections.connectToken(user.id, b.preset, b.address, b.token);
      return connections.connectService(user.id, b);
    }),
  },
  // Look at a service before connecting it: what it is, what it asks for, what tools it has.
  "/api/me/connections/probe": {
    POST: route(async ({ req }) => {
      await requireUser(req);
      const b = await body(req, z.object({ address: z.string().min(1).max(500), token: z.string().max(500).default("") }));
      return connections.probe(b.address, b.token);
    }),
  },
  // Send to Longview (F30 step 4): the second token, that can save, and only that.
  "/api/me/longview-send": {
    GET: route(async ({ req }) => sendLongview.sendState((await requireUser(req)).id)),
    PUT: route(async ({ req }) => {
      const user = await requireUser(req);
      return sendLongview.setSendToken(user.id, (await body(req, z.object({ token: z.string().max(500) }))).token);
    }),
    DELETE: route(async ({ req }) => sendLongview.clearSendToken((await requireUser(req)).id)),
  },
  // Floe (F41): what the `/` menu's Floe diagram… and Bring in a landscape choose from.
  "/api/me/floe": { GET: route(async ({ req }) => floe.floeState((await requireUser(req)).id)) },
  "/api/me/floe/landscapes": { GET: route(async ({ req }) => floe.landscapes((await requireUser(req)).id)) },
  "/api/me/floe/landscapes/:id/diagrams": { GET: route(async ({ req }) => floe.diagrams((await requireUser(req)).id, req.params.id!)) },
  "/api/me/floe/diagrams/:id": { GET: route(async ({ req }) => floe.diagram((await requireUser(req)).id, req.params.id!)) },
  // "From your connections" in the side panel (F33 step 4): which tool looks a note up.
  "/api/me/connections/:id/panel": {
    GET: route(async ({ req }) => panel.panelChoice((await requireUser(req)).id, id(req.params.id))),
    PUT: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ tool: z.string().max(64).nullable() }));
      return panel.setPanel(user.id, id(req.params.id), b.tool);
    }),
  },
  "/api/me/connections/:id/try": {
    POST: route(async ({ req }) => connections.tryConnection((await requireUser(req)).id, id(req.params.id))),
  },
  // A preset that signs in with OAuth: its sign-in page's address, fetched before the button is
  // pressed (web/components/Connections.tsx); when the service can't be reached, that's said in
  // the answer, not as an error.
  "/api/me/connections/oauth": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const { preset } = await body(req, z.object({ preset: z.string().max(40) }));
      try {
        return await connections.startOAuth(user.id, preset, passkeys.relyingParty(req).origin);
      } catch (e) {
        if (e instanceof HttpError && e.status !== 502) throw e;
        return { url: null, problem: e instanceof Error ? e.message : "Couldn't reach it" };
      }
    }),
  },
  "/api/me/connections/:id": {
    DELETE: route(async ({ req }) => connections.disconnect((await requireUser(req)).id, id(req.params.id))),
  },
  // Review: the service's tools as listed now (what changed since the person last looked), and
  // the person's choice of which are on.
  "/api/me/connections/:id/tools": {
    GET: route(async ({ req }) => connections.tools((await requireUser(req)).id, id(req.params.id))),
    PUT: route(async ({ req }) => {
      const user = await requireUser(req);
      const { on } = await body(req, z.object({ on: z.array(z.string().max(64)).max(200) }));
      return connections.choose(user.id, id(req.params.id), on);
    }),
  },
  // The service sends the person back here after they sign in (in a new tab, the iPhone app's
  // Safari sheet or the Mac's browser); the state says who, so no cookie is needed.
  "/api/connections/callback": {
    GET: route(async ({ url }) => {
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      let said: string;
      try {
        if (!code) throw new HttpError(400, url.searchParams.get("error") === "access_denied" ? "You chose not to connect it." : "The service didn't send DO Notes a sign-in.");
        const name = await connections.finishOAuth(state, code);
        said = `${name} is connected to DO Notes. You can close this and go back to DO Notes.`;
      } catch (e) {
        said = e instanceof HttpError ? e.message : "Something went wrong connecting it. Try again from Settings → Connections.";
      }
      const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Connections · DO Notes</title></head><body><main><h1>DO Notes</h1><p>${Bun.escapeHTML(said)}</p><p><a href="/">Back to DO Notes</a></p></main></body></html>`;
      return new Response(page, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
    }),
  },
  "/api/me/assistants/test": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ id: z.number().int().positive().optional(), draft: AssistantDraft.optional() }));
      return assistants.testAssistant(user, b);
    }),
  },
  "/api/me/assistants/:id": {
    PATCH: route(async ({ req }) => assistants.updateAssistant(await requireUser(req), id(req.params.id), await body(req, AssistantDraft.partial()))),
    DELETE: route(async ({ req }) => {
      const user = await requireUser(req);
      await assistants.deleteAssistant(user.id, id(req.params.id));
    }),
  },
  "/api/ai/chat": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      return chatResponse(user, await body(req, ChatRequest), req.signal);
    }),
  },
  // Model Context Protocol for Claude and other agents (src/mcp.ts). Bearer MCP token.
  "/mcp": { POST: mcpRoute, GET: mcpRoute, DELETE: mcpRoute },
  // Share from the iPhone: a bearer capture token, never a cookie or a URL token.
  "/api/capture": {
    POST: route(async ({ req }) => {
      try {
        return await captureTokens.capture(req);
      } catch (e) {
        // The Shortcut shows `message` in its notification, so failures say why there too.
        if (e instanceof HttpError) return json({ ok: false, error: e.message, message: e.message }, { status: e.status });
        throw e;
      }
    }, { tokenOnly: true }),
  },

  // ── admin ────────────────────────────────────────────────────────────────────────────
  "/api/admin/users": {
    GET: route(async ({ req }) => {
      await requireAdmin(req);
      return sql`select id, email, name, is_admin, created_at from users order by created_at`;
    }),
    POST: route(async ({ req }) => {
      await requireAdmin(req);
      const b = await body(req, Credentials.extend({ name: z.string().max(200).default(""), is_admin: z.boolean().default(false) }));
      const user = await auth.createUser({ ...b, isAdmin: b.is_admin });
      await vaults.createVault(user, "Personal");
      return user;
    }),
  },
  "/api/admin/library": {
    PUT: route(async ({ req }) => {
      await requireAdmin(req);
      const { name } = await body(req, z.object({ name: z.string().max(80) }));
      // Empty goes back to the default.
      if (name.trim()) await sql`insert into server_info (key, value) values ('library', ${name.trim()}) on conflict (key) do update set value = excluded.value`;
      else await sql`delete from server_info where key = 'library'`;
      return { library: await libraryName() };
    }),
  },
  // Off-site backups (.github/workflows/backup.yml). A bearer token, never a cookie or URL token.
  "/api/backup": {
    GET: route(async ({ req }) => {
      const given = /^Bearer\s+(.+)$/i.exec(req.headers.get("authorization") ?? "")?.[1]?.trim() ?? "";
      if (!settings.backupToken) throw new HttpError(404, "Not found");
      if (!auth.tokenMatches(given, settings.backupToken)) throw new HttpError(401, "Bad backup token");
      const zip = backupStream();
      const stamp = new Date().toISOString().slice(0, 10);
      return new Response(zip, {
        headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="commonplace-backup-${stamp}.zip"`, "Cache-Control": "no-store" },
      });
    }),
  },
  "/api/admin/storage": {
    GET: route(async ({ req }) => {
      await requireAdmin(req);
      const [r] = await sql`
        select pg_database_size(current_database())::bigint as database,
               (select coalesce(sum(size), 0) from attachments)::bigint as attachments,
               (select coalesce(sum(octet_length(content) + coalesce(octet_length(ydoc), 0)), 0) from notes)::bigint as notes,
               (select coalesce(sum(octet_length(content)), 0) from note_revisions)::bigint as revisions,
               (select coalesce(sum(octet_length(content) + coalesce(octet_length(ydoc), 0) + octet_length(revisions::text)), 0) from trashed_notes)::bigint as trash`;
      return { ...r, limit: settings.dbDiskBytes || null, warnAt: WARN_AT, fullAt: FULL_AT };
    }),
  },
  "/api/admin/users/:id": {
    DELETE: route(async ({ req }) => {
      const admin = await requireAdmin(req);
      const uid = id(req.params.id);
      if (uid === admin.id) throw new HttpError(400, "You can't delete your own account");
      // Vaults where they're the only owner pass to the admin rather than becoming ownerless, named
      // for where they came from ("Personal (from Eve)"), since everyone's first is "Personal".
      const [gone] = await sql`select name from users where id = ${uid}`;
      const handed = await sql`
        insert into vault_members (vault_id, user_id, role)
        select m.vault_id, ${admin.id}, 'owner' from vault_members m
        where m.user_id = ${uid} and m.role = 'owner'
          and not exists (select 1 from vault_members o where o.vault_id = m.vault_id and o.role = 'owner' and o.user_id <> ${uid})
        on conflict (vault_id, user_id) do update set role = 'owner'
        returning vault_id`;
      if (gone?.name && handed.length)
        await sql`update vaults set name = left(name || ' (from ' || ${gone.name} || ')', 200) where id in ${sql(handed.map((h) => h.vault_id))}`;
      await sql`delete from users where id = ${uid}`;
      kick({ userId: uid }, "account removed");
    }),
  },

  // GitHub (F14, src/github.ts): each person's own token, write-only like AI keys.
  "/api/me/github": {
    GET: route(async ({ req }) => ({ available: secretsAvailable(), connection: await github.connection((await requireUser(req)).id) })),
    PUT: route(async ({ req }) => {
      const user = await requireUser(req);
      return github.connect(user.id, (await body(req, z.object({ token: z.string().max(300) }))).token);
    }),
    DELETE: route(async ({ req }) => github.disconnect((await requireUser(req)).id)),
  },
  "/api/me/github/repos": {
    GET: route(async ({ req }) => github.listRepos(await github.clientFor((await requireUser(req)).id))),
  },
  "/api/me/github/repos/:owner/:repo/branches": {
    GET: route(async ({ req }) => github.listBranches(await github.clientFor((await requireUser(req)).id), `${req.params.owner}/${req.params.repo}`)),
  },
  "/api/me/github/repos/:owner/:repo/folders": {
    GET: route(async ({ req, url }) => git.folders(await github.clientFor((await requireUser(req)).id), `${req.params.owner}/${req.params.repo}`, url.searchParams.get("branch") ?? "main")),
  },
  "/api/vaults/github": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ repo: z.string().max(200), branch: z.string().min(1).max(200), folder: z.string().max(500).optional(), name: z.string().max(200).optional() }));
      return git.copyIn(user, b);
    }),
  },

  // ── vaults ───────────────────────────────────────────────────────────────────────────
  "/api/vaults": {
    GET: route(async ({ req }) => {
      const who = await tokens.requestUser(req);
      if (!who) throw new HttpError(401, "Sign in required");
      const own = await vaults.listVaults(who.user.id);
      // On the Mac (F23), the cloud library's collections follow the Mac's own; never for another
      // server asking with a device token, which gets only the collections kept here.
      return who.deviceToken ? own : [...own, ...(await remote.cloudVaults(who.user.id))];
    }),
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ name: z.string().min(1).max(200) }));
      return vaults.createVault(user, b.name);
    }),
  },
  "/api/vaults/:v": {
    PATCH: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      const b = await body(ctx.req, z.object({ name: z.string().max(200).optional(), noteIds: z.boolean().optional() }));
      if (b.name !== undefined) await vaults.renameVault(vaultId, b.name);
      if (b.noteIds !== undefined) await vaults.setNoteIds(vaultId, b.noteIds);
    }),
    DELETE: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      kick({ vaultId }, "collection deleted");
      await vaults.deleteVault(vaultId);
    }),
  },
  "/api/vaults/:v/members": {
    GET: route(async (ctx) => vaults.listMembers((await vaultCtx(ctx, "viewer")).vaultId)),
    // A member's email changes their role; anyone else's gets an invitation (N13). The reply for an
    // invitation is the same whether or not the email has an account.
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      const b = await body(ctx.req, z.object({ email: z.string().max(320), role: Role }));
      const r = await vaults.setMember(vaultId, b.email, b.role, user);
      if (r.status === "invited") return { status: "invited" };
      // Reconnect them so a demotion to viewer takes effect in open editors.
      kick({ vaultId, userId: r.userId }, "role changed");
      return { status: "updated" };
    }),
  },
  "/api/vaults/:v/invites": {
    GET: route(async (ctx) => vaults.listInvites((await vaultCtx(ctx, "owner")).vaultId)),
  },
  "/api/vaults/:v/invites/:id": {
    DELETE: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      await vaults.cancelInvite(vaultId, id(ctx.req.params.id));
    }),
  },
  // The signed-in person's own invitations: accept to join, decline to drop it.
  "/api/invitations": {
    GET: route(async ({ req }) => vaults.myInvites(await requireUser(req))),
  },
  "/api/invitations/:id/accept": {
    POST: route(async ({ req }) => vaults.acceptInvite(await requireUser(req), id(req.params.id))),
  },
  "/api/invitations/:id": {
    DELETE: route(async ({ req }) => vaults.declineInvite(await requireUser(req), id(req.params.id))),
  },
  "/api/vaults/:v/members/:uid": {
    DELETE: route(async (ctx) => {
      const user = await requireUser(ctx.req);
      const vaultId = id(ctx.req.params.v);
      const uid = id(ctx.req.params.uid);
      // Owners remove anyone; anyone may leave.
      await vaults.requireRole(vaultId, user, uid === user.id ? "viewer" : "owner");
      await vaults.removeMember(vaultId, uid, user);
      kick({ vaultId, userId: uid }, "removed from collection");
    }),
  },
  // Undo of Remove, for the owner who just did it (a few minutes); otherwise invite them again.
  "/api/vaults/:v/members/:uid/restore": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      await vaults.restoreMember(vaultId, id(ctx.req.params.uid), user);
    }),
  },
  "/api/vaults/:v/events": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      let cleanup = () => {};
      const stream = new ReadableStream({
        start(controller) {
          const enc = new TextEncoder();
          const send = (s: string) => {
            try {
              controller.enqueue(enc.encode(s));
            } catch {
              cleanup();
            }
          };
          send(": connected\n\n");
          const off = subscribe(vaultId, (e) => send(`data: ${JSON.stringify(e)}\n\n`));
          // Each ping re-checks the session and membership, so signing out, removal from the
          // vault or account deletion ends the stream within 20 s.
          const ping = setInterval(async () => {
            try {
              const u = (await tokens.requestUser(ctx.req))?.user;
              if (!u) throw new Error("signed out");
              await vaults.roleIn(vaultId, u.id);
              send(": ping\n\n");
            } catch {
              cleanup();
              try {
                controller.close();
              } catch {}
            }
          }, 20_000);
          cleanup = () => {
            off();
            clearInterval(ping);
          };
          ctx.req.signal.addEventListener("abort", () => cleanup());
        },
        cancel() {
          cleanup();
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", "X-Accel-Buffering": "no" },
      });
    }),
  },

  // ── notes ────────────────────────────────────────────────────────────────────────────
  "/api/vaults/:v/notes": {
    GET: route(async (ctx) => notes.listNotes((await vaultCtx(ctx, "viewer")).vaultId)),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().min(1), content: z.string().max(5_000_000).default("") }));
      return notes.createNote(vaultId, user.id, b.path, await notes.withNewId(vaultId, b.path, b.content));
    }),
  },
  "/api/vaults/:v/notes/:id": {
    GET: route(async (ctx) => {
      const { vaultId, role } = await vaultCtx(ctx, "viewer");
      return { ...(await notes.getNote(vaultId, id(ctx.req.params.id))), role };
    }),
    PATCH: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().min(1), updateLinks: z.boolean().default(true) }));
      return notes.renameNote(vaultId, id(ctx.req.params.id), b.path, user.id, b.updateLinks);
    }),
    DELETE: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      // Close the live room first and save it, so Trash holds the latest text.
      kick({ noteId }, "note deleted");
      await flushNote(noteId);
      return { trashId: await notes.deleteNote(vaultId, noteId, user.id) };
    }),
  },
  "/api/vaults/:v/notes/:id/content": {
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      const b = await body(ctx.req, z.object({ content: z.string().max(5_000_000) }));
      await notes.overwriteContent(noteId, b.content, user.id);
      return notes.getNote(vaultId, noteId);
    }),
  },
  "/api/vaults/:v/notes/:id/links": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const noteId = id(ctx.req.params.id);
      const [me, backlinks, outgoing, rel, onBoards, relations] = await Promise.all([
        notes.getNote(vaultId, noteId),
        backlinksWithProperty(vaultId, noteId),
        notes.outgoing(vaultId, noteId),
        related(vaultId, noteId).catch(() => []),
        boardsFor(vaultId, noteId),
        relationsFrom(vaultId, noteId),
      ]);
      // Boards it's on are listed on their own (F11), not as backlinks.
      return { backlinks: backlinks.filter((b) => !isCanvasPath(b.path)), outgoing, related: rel, created_at: me.created_at, relations, ...onBoards };
    }),
  },
  // Set properties without touching the rest of the note, merged into live typing (type pages).
  "/api/vaults/:v/notes/:id/properties": {
    PATCH: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      const PropValue = z.union([z.string().max(10_000), z.number(), z.boolean(), z.array(z.string().max(10_000)).max(500), z.null()]);
      const b = await body(ctx.req, z.object({ set: z.record(z.string().min(1).max(200), PropValue) }));
      await notes.overwriteContent(noteId, (cur) => withProperties(cur, b.set), user.id);
      return notes.getNote(vaultId, noteId);
    }),
  },
  // Types (F16): the vault's types, one type's notes and saved views, and a day's activity.
  "/api/vaults/:v/types": {
    GET: route(async (ctx) => listTypes((await vaultCtx(ctx, "viewer")).vaultId)),
  },
  // The kinds of relationship (F31): the collection's own (its Relationships note), its types'
  // relations, and AI-XF's core kinds.
  "/api/vaults/:v/relationships": {
    GET: route(async (ctx) => vaultKinds((await vaultCtx(ctx, "viewer")).vaultId)),
    // A new kind, from the builder: added to the Relationships note (made if need be).
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ label: z.string().trim().min(1).max(80), inverse: z.string().trim().max(80).optional(), hint: z.string().max(300).optional() }));
      const added = await addKinds(vaultId, user.id, [{ label: b.label, inverse: b.inverse || b.label, hint: b.hint ?? "" }], "edit");
      if (!added.length) throw new HttpError(409, `There's a kind called “${b.label}” already`);
      return { added };
    }),
  },
  "/api/vaults/:v/types/:name": {
    GET: route(async (ctx) => typeNotes((await vaultCtx(ctx, "viewer")).vaultId, decodeURIComponent(ctx.req.params.name ?? ""))),
    // The type editor saves the whole definition at once.
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const Prop = z.object({
        name: z.string().max(100),
        kind: z.enum(PROP_KINDS as [string, ...string[]]),
        options: z.array(z.string().max(200)).max(100).optional(),
        type: z.string().max(200).optional(),
        many: z.boolean().optional(),
      });
      const b = await body(ctx.req, z.object({ icon: z.string().max(40), colour: z.enum(TYPE_COLOURS), properties: z.array(Prop).max(100), cards: z.boolean().optional() }));
      await updateType(vaultId, user.id, decodeURIComponent(ctx.req.params.name ?? ""), b as any);
    }),
  },
  "/api/vaults/:v/types/:name/rename": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ to: z.string().min(1).max(200) }));
      return { changed: await renameType(vaultId, user.id, decodeURIComponent(ctx.req.params.name ?? ""), b.to) };
    }),
  },
  "/api/vaults/:v/types/:name/views": {
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ yaml: z.string() }));
      await saveViews(vaultId, user.id, decodeURIComponent(ctx.req.params.name ?? ""), b.yaml);
    }),
  },
  // Weblinks (src/weblinks.ts), then small views (src/vaultViews.ts): tasks across the vault,
  // unlinked mentions, bookmarks and saved searches.
  "/api/vaults/:v/weblinks": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ url: z.string().min(1).max(4000), title: z.string().max(300).default("") }));
      return saveWeblink(vaultId, user.id, b.url, b.title);
    }),
  },
  // A link card (F28): what a page on its own line says about itself. Anyone who can read the
  // collection sees its cards; the fetch is the weblinks' one, which never reaches private addresses.
  "/api/vaults/:v/linkcard": {
    GET: route(async (ctx) => {
      await vaultCtx(ctx, "viewer");
      const url = ctx.url.searchParams.get("url") ?? "";
      if (!url || url.length > 4000) throw new HttpError(400, "That isn't a web address");
      return (await linkCard(url)) ?? { title: "", description: "", site: "", image: null, url };
    }),
  },
  // Dataview queries in a note (src/dataview.ts), run over the vault as its reader sees it.
  "/api/vaults/:v/dataview": {
    POST: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const b = await body(
        ctx.req,
        z.object({
          noteId: z.number().int().nullable(),
          offset: z.number().int().min(-14 * 60).max(14 * 60),
          tz: z.string().max(64).optional(),
          items: z.array(z.object({ kind: z.enum(["query", "inline"]), source: z.string().max(20_000) })).max(200),
        }),
      );
      return runDataview(vaultId, b.noteId, b.offset, b.items, b.tz);
    }),
  },
  // dataviewjs (web/sandbox/dvjs.ts) runs in the reader's browser, on the pages they can read.
  "/api/vaults/:v/dataview/pages": {
    GET: route(async (ctx) => dataviewPages((await vaultCtx(ctx, "viewer")).vaultId)),
  },
  "/api/vaults/:v/dataview/file": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const path = new URL(ctx.req.url).searchParams.get("path") ?? "";
      if (!path || path.length > 1024) throw new HttpError(400, "Which file?");
      return { text: await dataviewFile(vaultId, path) };
    }),
  },
  // Comments (L3): threads beside a note. Viewers read; editors comment and resolve.
  "/api/vaults/:v/notes/:id/comments": {
    GET: route(async (ctx) => comments.listComments((await vaultCtx(ctx, "viewer")).vaultId, id(ctx.req.params.id))),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ body: z.string().max(5000), quote: z.string().max(2000).optional(), from: z.string().max(200).optional(), to: z.string().max(200).optional(), parentId: z.number().int().positive().optional() }));
      return comments.addComment(vaultId, id(ctx.req.params.id), user, b);
    }),
  },
  "/api/vaults/:v/notes/:id/comments/:cid": {
    PATCH: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ resolved: z.boolean().optional(), body: z.string().max(5000).optional() }));
      return comments.changeComment(vaultId, id(ctx.req.params.id), id(ctx.req.params.cid), user, b);
    }),
  },
  // Follow a note (F39): told when someone else changes it.
  "/api/vaults/:v/notes/:id/follow": {
    GET: route(async (ctx) => {
      const { user } = await vaultCtx(ctx, "viewer");
      return { following: await notifications.following(user.id, id(ctx.req.params.id)) };
    }),
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      const b = await body(ctx.req, z.object({ on: z.boolean() }));
      return { following: await notifications.follow(user.id, noteId, b.on) };
    }),
  },
  // Since you last looked (F39): what others changed in this collection.
  "/api/vaults/:v/activity": {
    GET: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return notifications.activity(user.id, vaultId);
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      await notifications.markSeen(user.id, vaultId);
      return notifications.activity(user.id, vaultId);
    }),
  },
  // Share one note by link (F38): its state, make or update the page, stop sharing or Undo.
  "/api/vaults/:v/notes/:id/share": {
    GET: route(async (ctx) => shareLink.shareState((await vaultCtx(ctx, "viewer")).vaultId, id(ctx.req.params.id))),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ tz: z.string().max(64).optional() }).default({}));
      return shareLink.shareNote(vaultId, id(ctx.req.params.id), user, b.tz);
    }),
    PATCH: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ live: z.boolean() }));
      return shareLink.setShareLive(vaultId, id(ctx.req.params.id), b.live);
    }),
  },
  // A Weblink note's address saved into the person's Longview (F30 step 4); never the note.
  "/api/vaults/:v/notes/:id/longview": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      const b = await body(ctx.req, z.object({ why: z.string().max(500).default("") }));
      return sendLongview.sendNote(user, vaultId, id(ctx.req.params.id), b.why);
    }),
  },
  // A landscape from Floe (F41): previewed, then brought in or updated if Floe is as previewed.
  "/api/vaults/:v/floe": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ landscape: z.string().min(1).max(100), folder: z.string().max(300).optional(), apply: z.boolean().default(false), hash: z.string().max(20).default("") }));
      return b.apply ? floe.applyLandscape(user.id, vaultId, b.landscape, b.hash, b.folder) : floe.previewLandscape(user.id, vaultId, b.landscape, b.folder);
    }),
  },
  "/api/vaults/:v/floe/status": {
    GET: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return floe.landscapeStatus(user.id, vaultId, new URL(ctx.req.url).searchParams.get("landscape") ?? "");
    }),
  },
  "/api/vaults/:v/notes/:id/floe-diagrams": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return floe.refreshDiagrams(user.id, vaultId, id(ctx.req.params.id));
    }),
  },
  // The open note looked up in the person's connections that are in the side panel (F33 step 4).
  "/api/vaults/:v/notes/:id/outside": {
    GET: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return panel.lookup(user, vaultId, id(ctx.req.params.id));
    }),
  },
  "/api/vaults/:v/tasks": {
    GET: route(async (ctx) => vaultTasks((await vaultCtx(ctx, "viewer")).vaultId)),
  },
  "/api/vaults/:v/notes/:id/tasks": {
    PATCH: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ line: z.number().int().min(0), text: z.string().max(10_000), done: z.boolean() }));
      await setTask(vaultId, id(ctx.req.params.id), user.id, b.line, b.text, b.done);
    }),
  },
  "/api/vaults/:v/notes/:id/mentions": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      return unlinkedMentions(vaultId, id(ctx.req.params.id));
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ source: z.number().int().positive() }));
      await linkMention(vaultId, id(ctx.req.params.id), b.source, user.id);
    }),
  },
  "/api/vaults/:v/bookmarks": {
    GET: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return bookmarks(user.id, vaultId);
    }),
  },
  "/api/vaults/:v/bookmarks/:id": {
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return setBookmark(user.id, vaultId, id(ctx.req.params.id), true);
    }),
    DELETE: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return setBookmark(user.id, vaultId, id(ctx.req.params.id), false);
    }),
  },
  // ── website (F18): what's published, Publish, take down ─────────────────────────────────
  "/api/vaults/:v/site": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      return site.siteState(vaultId);
    }),
  },
  "/api/vaults/:v/site/settings": {
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      const change = await body(
        ctx.req,
        z.object({
          include: z.array(z.string().max(512)).max(1000).optional(),
          features: z.object(Object.fromEntries(site.FEATURES.map((f) => [f, z.boolean().optional()])) as Record<site.Feature, z.ZodOptional<z.ZodBoolean>>).optional(),
        }),
      );
      return site.saveSettings(vaultId, user.id, change);
    }),
  },
  // The builder's preview: what Publish would make now, as pages framed by Settings → Website.
  "/api/vaults/:v/site/preview": {
    GET: route(async (ctx) => {
      await vaultCtx(ctx, "owner");
      return new Response(null, { status: 308, headers: { Location: `${ctx.url.pathname}/` } });
    }),
  },
  "/api/vaults/:v/site/preview/*": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      return site.previewSite(vaultId, ctx.req);
    }),
  },
  "/api/vaults/:v/site/publish": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      // The owner's time zone, for Dataview's dates (results are frozen at Publish).
      // What each dataviewjs block drew, run in the owner's browser (cleaned in publish.ts).
      const b = await body(
        ctx.req,
        z.object({
          offset: z.number().int().min(-14 * 60).max(14 * 60).default(0),
          tz: z.string().max(64).optional(),
          frozen: z.array(z.object({ path: z.string().max(1024), code: z.string().max(200_000), html: z.string().max(2_000_000) })).max(5000).default([]),
        }),
      );
      return site.publish(vaultId, user, b.offset, b.tz, b.frozen);
    }),
  },
  // dataviewjs at Publish: the blocks to run and the published notes they see, and the files
  // they may read (published ones only).
  "/api/vaults/:v/site/dataviewjs": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      return site.dataviewjsToFreeze(vaultId);
    }),
  },
  "/api/vaults/:v/site/dataviewjs/file": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      const path = new URL(ctx.req.url).searchParams.get("path") ?? "";
      if (!path || path.length > 1024) throw new HttpError(400, "Which file?");
      return { text: await site.dataviewjsFreezeFile(vaultId, path) };
    }),
  },
  "/api/vaults/:v/site/live": {
    PUT: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      const { live } = await body(ctx.req, z.object({ live: z.boolean() }));
      await site.setLive(vaultId, live);
    }),
  },
  "/api/vaults/:v/tour": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return addTour(vaultId, user);
    }),
  },
  "/api/vaults/:v/searches": {
    GET: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return savedSearches(user.id, vaultId);
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return saveSearch(user.id, vaultId, (await body(ctx.req, z.object({ query: z.string().max(500) }))).query);
    }),
  },
  "/api/vaults/:v/searches/:id": {
    DELETE: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return removeSearch(user.id, vaultId, id(ctx.req.params.id));
    }),
  },
  "/api/vaults/:v/days/:day": {
    GET: route(async (ctx) => dayActivity((await vaultCtx(ctx, "viewer")).vaultId, ctx.req.params.day ?? "")),
  },
  "/api/vaults/:v/notes/:id/revisions": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      return notes.revisions(noteId);
    }),
  },
  "/api/vaults/:v/notes/:id/revisions/:rid": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      return notes.revision(noteId, id(ctx.req.params.rid));
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const noteId = id(ctx.req.params.id);
      await notes.getNote(vaultId, noteId);
      const r = await notes.revision(noteId, id(ctx.req.params.rid));
      await notes.overwriteContent(noteId, r.content, user.id, "restore");
      return notes.getNote(vaultId, noteId);
    }),
  },
  "/api/vaults/:v/notes/:id/export": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const n = await notes.getNote(vaultId, id(ctx.req.params.id));
      const board = isCanvasPath(n.path);
      return new Response(n.content, {
        headers: {
          "Content-Type": board ? "application/json; charset=utf-8" : "text/markdown; charset=utf-8",
          "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(n.title)}${board ? ".canvas" : ".md"}`,
        },
      });
    }),
  },
  "/api/vaults/:v/trash": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "editor");
      return { days: notes.TRASH_DAYS, items: await notes.listTrash(vaultId) };
    }),
    DELETE: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      return { deleted: await notes.purgeFromTrash(vaultId) };
    }),
  },
  "/api/vaults/:v/trash/:id": {
    // Gone for good, like emptying Trash: the owner's call. Editors can still restore (N13).
    DELETE: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "owner");
      return { deleted: await notes.purgeFromTrash(vaultId, id(ctx.req.params.id)) };
    }),
  },
  "/api/vaults/:v/trash/:id/restore": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return notes.restoreNote(vaultId, id(ctx.req.params.id), user.id);
    }),
  },
  "/api/vaults/:v/folders": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      return notes.listFolders(vaultId);
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().min(1).max(512) }));
      return { path: await notes.createFolder(vaultId, b.path, user.id) };
    }),
    DELETE: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      await notes.deleteFolder(vaultId, ctx.url.searchParams.get("path") ?? "", user.id);
    }),
  },
  "/api/vaults/:v/folders/rename": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ from: z.string().min(1), to: z.string().min(1) }));
      return { moved: await notes.renameFolder(vaultId, b.from, b.to, user.id) };
    }),
  },
  // F24: a journal entry in today's daily note of your home collection (or the one given), and
  // the journal page's days.
  "/api/journal": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ text: z.string().max(20_000), vaultId: z.number().int().positive().optional(), day: z.string().max(10).optional(), time: z.string().max(5).optional() }));
      return journal.addEntry(user, b);
    }),
  },
  "/api/vaults/:v/journal": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const q = new URL(ctx.req.url).searchParams;
      const day = q.get("day");
      return { days: await journal.journalDays(vaultId, { before: q.get("before") ?? undefined }), onThisDay: day ? await journal.onThisDay(vaultId, day) : [] };
    }),
  },
  // Import a Day One export (zip or .json) into this collection's daily notes; dryRun only counts.
  "/api/vaults/:v/journal/import": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const form = await ctx.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "Choose a Day One export to import");
      return importDayOne(user, vaultId, file.name, new Uint8Array(await file.arrayBuffer()), form.get("dryRun") === "true");
    }),
  },
  // Between two servers (F23): the Mac's Commonplace takes notes from one side and gives them to
  // the other, in the person's name (src/between.ts bundle / receive).
  "/api/vaults/:v/bundle": {
    POST: route(async (ctx) => {
      const b = await body(ctx.req, z.object({ notes: z.array(z.number().int().positive()).max(2000).optional(), folder: z.string().max(512).optional(), move: z.boolean().default(false) }));
      const { user, vaultId } = await vaultCtx(ctx, b.move ? "editor" : "viewer");
      return between.bundle(user, vaultId, b);
    }),
  },
  "/api/vaults/:v/receive": {
    POST: route(async (ctx) => {
      const { user, vaultId } = await vaultCtx(ctx, "editor");
      const Rev = z.object({ content: z.string().max(5_000_000), reason: z.string().max(40), created_at: z.string().max(40) });
      const b = await body(
        ctx.req,
        z.object({
          into: z.string().max(512).default(""),
          move: z.boolean().default(false),
          notes: z.array(z.object({ id: z.number().int(), path: z.string().max(1000), rel: z.string().max(1000), content: z.string().max(5_000_000), created_at: z.string().max(40).default(""), revisions: z.array(Rev).max(200).default([]) })).min(1).max(2000),
          files: z.array(z.object({ path: z.string().max(1000), rel: z.string().max(1000).nullable(), data: z.string() })).max(5000).default([]),
          types: z.array(z.object({ path: z.string().max(1000), content: z.string().max(5_000_000) })).max(200).default([]),
        }),
      );
      return between.receive(user, vaultId, b);
    }),
  },
  "/api/vaults/:v/send": {
    // Copy or move notes (or a folder) to another of your vaults; `dryRun` says what would happen.
    POST: route(async (ctx) => {
      const Send = z.object({ to: z.number().int().positive(), notes: z.array(z.number().int().positive()).max(2000).optional(), folder: z.string().max(512).optional(), into: z.string().max(512).default(""), move: z.boolean().default(false), dryRun: z.boolean().default(false) });
      // Between the Mac and its cloud library (F23): two servers, so a bundle from one, received
      // by the other; each side checks the person's role itself.
      const from = id(ctx.req.params.v);
      if (remote.isCloudVault(from) || remote.isCloudVault(Number((await ctx.req.clone().json().catch(() => ({}))).to))) {
        const user = await requireUser(ctx.req);
        const b = await body(ctx.req, Send);
        return remote.crossSend(user, { from, to: b.to, notes: b.notes, folder: b.folder, into: b.into, move: b.move, dryRun: b.dryRun }, {
          bundle: between.bundle,
          receive: between.receive,
          trash: async (v, noteId) => (kick({ noteId }, "note deleted"), await flushNote(noteId), notes.deleteNote(v, noteId, user.id)),
          name: async (v) => (await vaults.listVaults(user.id)).find((x) => x.id === v)?.name ?? "this collection",
        });
      }
      // The shared check: a copy reads this vault, a move writes it (its notes go to Trash).
      const { user, vaultId } = await vaultCtx(ctx, "viewer");
      const b = await body(ctx.req, Send);
      if (b.move) await vaultCtx(ctx, "editor");
      const r = { from: vaultId, to: b.to, notes: b.notes, folder: b.folder, into: b.into, move: b.move };
      if (!b.dryRun) return between.send(user, r);
      const p = await between.planSend(user, r);
      return { summary: between.describePlan(p), notes: p.notes.length, files: p.files.length, types: p.types.length, linkedFrom: p.linkedFrom };
    }),
  },
  "/api/vaults/:v/resolve": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const hit = await notes.resolveLink(vaultId, ctx.url.searchParams.get("target") ?? "");
      if (!hit) throw new HttpError(404, "No such note");
      return hit;
    }),
  },
  "/api/vaults/:v/search": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      return search(vaultId, (ctx.url.searchParams.get("q") ?? "").slice(0, 500));
    }),
  },
  "/api/vaults/:v/suggest": {
    GET: route(async (ctx) => suggest((await vaultCtx(ctx, "viewer")).vaultId, (ctx.url.searchParams.get("q") ?? "").slice(0, 200))),
  },
  "/api/vaults/:v/tags": {
    GET: route(async (ctx) => notes.tagCounts((await vaultCtx(ctx, "viewer")).vaultId)),
  },
  "/api/vaults/:v/graph": {
    GET: route(async (ctx) => graph.graph((await vaultCtx(ctx, "viewer")).vaultId)),
  },

  // ── the cloud library, seen from the Mac (F23, src/remote.ts) ─────────────────────────────
  "/api/cloud": {
    GET: route(async ({ req }) => remote.linkStatus((await requireUser(req)).id)),
    DELETE: route(async ({ req }) => {
      await remote.disconnect(await requireUser(req));
    }),
  },
  "/api/cloud/connect": {
    POST: route(async ({ req }) => {
      const user = await requireUser(req);
      const b = await body(req, z.object({ url: z.string().max(500), name: z.string().max(60).default("") }));
      return remote.connect(user, b.url, b.name, `${oauth.origin(req)}/api/cloud/callback`);
    }),
  },
  "/api/cloud/callback": {
    // Where the cloud sends the person back after they allow (or don't): a page load, so the
    // answer is a redirect into the app, which says how it went.
    GET: route(async ({ req, url }) => {
      const user = await requireUser(req);
      try {
        await remote.callback(user, url.searchParams);
        return Response.redirect("/?cloud=connected", 302);
      } catch (e) {
        return Response.redirect(`/?cloud=${encodeURIComponent(e instanceof HttpError ? e.message : "The cloud library didn't sign this Mac in")}`, 302);
      }
    }),
  },

  // ── folder vaults on the Mac (F22, src/folderSync.ts) ───────────────────────────────────
  "/api/folders": {
    GET: route(async ({ req }) => {
      await requireUser(req);
      return { available: await folders.available(), folders: await folders.listFolders() };
    }),
  },
  "/api/vaults/:v/folder": {
    GET: route(async (ctx) => folders.status((await vaultCtx(ctx, "viewer")).vaultId)),
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      const b = await body(ctx.req, z.object({ root: z.string().max(1000), mode: z.enum(["folder", "both"]), create: z.boolean().optional() }));
      return folders.link(vaultId, user, b.root, b.mode, { create: b.create });
    }),
    DELETE: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      await folders.unlink(vaultId, user);
    }),
  },
  "/api/vaults/:v/folder/sync": {
    POST: route(async (ctx) => folders.syncNow((await vaultCtx(ctx, "editor")).vaultId)),
  },
  "/api/vaults/:v/folder/pause": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      return folders.setPaused(vaultId, user, (await body(ctx.req, z.object({ paused: z.boolean() }))).paused);
    }),
  },
  "/api/vaults/:v/folder/rebuild": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      return folders.rebuild(vaultId, user);
    }),
  },
  "/api/vaults/:v/folder/resolve": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().max(1000), take: z.enum(["mine", "theirs"]) }));
      await folders.resolve(vaultId, user, b.path, b.take);
    }),
  },
  "/api/vaults/:v/folder/export": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return folders.exportTo(vaultId, user, (await body(ctx.req, z.object({ root: z.string().max(1000) }))).root);
    }),
  },

  // ── GitHub vaults (F14, src/git.ts): the branch, its changes, the pull request ─────────
  "/api/vaults/:v/git": {
    GET: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "viewer");
      return git.status(vaultId, user.id);
    }),
  },
  "/api/vaults/:v/git/diff": {
    GET: route(async (ctx) => git.diff((await vaultCtx(ctx, "viewer")).vaultId, ctx.url.searchParams.get("path") ?? "")),
  },
  "/api/vaults/:v/git/revert": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return git.revert(vaultId, user, (await body(ctx.req, z.object({ path: z.string().max(1000) }))).path);
    }),
  },
  "/api/vaults/:v/git/push": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ message: z.string().max(10_000), title: z.string().max(300).optional(), body: z.string().max(60_000).optional(), branch: z.string().max(200).optional() }));
      return git.push(vaultId, user, b);
    }),
  },
  "/api/vaults/:v/git/cancel": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return git.cancel(vaultId, user);
    }),
  },
  "/api/vaults/:v/git/update": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return git.update(vaultId, user);
    }),
  },
  "/api/vaults/:v/git/resolve": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().max(1000), take: z.enum(["mine", "theirs"]) }));
      return git.resolve(vaultId, user, b.path, b.take);
    }),
  },
  // F19 (src/gitAuto.ts): how changes are sent, chosen by an owner; pause, send now, hold back.
  "/api/vaults/:v/git/auto": {
    PUT: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "owner");
      const b = await body(
        ctx.req,
        z.object({
          mode: z.enum(["ask", "review", "sync", "publish"]),
          every: z.enum(["hour", "day", "week"]).default("day"),
          at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time is HH:MM").default("18:00"),
          day: z.number().int().min(0).max(6).default(5),
          soon: z.boolean().default(false),
          coauthorEmails: z.boolean().default(false),
          branch: z.string().max(200).optional(),
        }),
      );
      return gitAuto.configure(vaultId, user, b);
    }),
  },
  "/api/vaults/:v/git/pause": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return gitAuto.pause(vaultId, user, (await body(ctx.req, z.object({ paused: z.boolean() }))).paused);
    }),
  },
  "/api/vaults/:v/git/send-now": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      return gitAuto.run(vaultId, user);
    }),
  },
  "/api/vaults/:v/git/hold": {
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ path: z.string().max(1000), held: z.boolean() }));
      return git.hold(vaultId, user, b.path, b.held);
    }),
  },
  "/api/vaults/:v/git/branch": {
    PUT: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "editor");
      await git.renameBranch(vaultId, (await body(ctx.req, z.object({ name: z.string().max(200) }))).name);
    }),
  },

  // ── import / export / files ──────────────────────────────────────────────────────────
  "/api/vaults/:v/import": {
    POST: route(async (ctx) => {
      const { vaultId, user, role } = await vaultCtx(ctx, "editor");
      const len = Number(ctx.req.headers.get("content-length") ?? 0);
      if (len > settings.maxImportBytes) throw new HttpError(413, `Import is larger than ${settings.maxImportBytes / 1048576} MB`);
      await assertRoom(len);
      const form = await ctx.req.formData();
      const mode = (form.get("mode") as ConflictMode) ?? "overwrite";
      if (!["overwrite", "skip", "keep-both"].includes(mode)) throw new HttpError(400, "Unknown conflict mode");
      const paths = form.getAll("paths").map(String);
      const files = form.getAll("files").filter((f): f is File => f instanceof File);
      if (!files.length) throw new HttpError(400, "Choose some .md files, a folder or a .zip to import");
      const items = await Promise.all(
        // A folder upload sends each file's relative path alongside it ("paths"), since
        // File.name is only the basename.
        files.map(async (f, i) => ({ path: paths[i] || f.name, data: new Uint8Array(await f.arrayBuffer()) })),
      );
      return importFiles(vaultId, user.id, items, mode, String(form.get("folder") ?? ""), role === "owner");
    }),
  },
  // AI-XF ids (F9): how many notes have none, and give them one (written into each note, once).
  "/api/vaults/:v/aixf/ids": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      return { missing: (await missingIds(vaultId, ctx.url.searchParams.get("folder") || undefined)).length };
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const b = await body(ctx.req, z.object({ folder: z.string().max(512).optional() }));
      return { given: await assignIds(vaultId, user.id, b.folder || undefined) };
    }),
  },
  "/api/vaults/:v/export": {
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const [v] = await sql`select name from vaults where id = ${vaultId}`;
      const folder = ctx.url.searchParams.get("folder") || undefined;
      const name = `${v!.name}${folder ? ` - ${folder.split("/").pop()}` : ""}`.replace(/[\\/:*?"<>|]/g, "-");
      // An AI-XF bundle (F9): canonical concepts, typed links, a manifest and vocabularies.
      if (ctx.url.searchParams.get("format") === "ai-xf") {
        const { zip, report } = await exportBundle(vaultId, folder);
        const summary = { concepts: report.concepts, links: report.links, dropped: report.dropped.length, unnamed: report.unnamed, unreadable: report.unreadable.length };
        return new Response(zip as Uint8Array<ArrayBuffer>, {
          headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}%20(AI-XF).zip`, "X-AI-XF-Report": JSON.stringify(summary) },
        });
      }
      const zip = await exportZip(vaultId, folder);
      return new Response(zip as Uint8Array<ArrayBuffer>, {
        headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}.zip` },
      });
    }),
  },
  "/api/vaults/:v/files": {
    // ?path=exact/path.png, or ?name=path.png resolved by basename.
    GET: route(async (ctx) => {
      const { vaultId } = await vaultCtx(ctx, "viewer");
      const p = ctx.url.searchParams.get("path") ?? "";
      const [f] = await sql`
        select path, mime, data from attachments
        where vault_id = ${vaultId} and (lower(path) = lower(${p}) or lower(path) like ${"%/" + p.toLowerCase().replace(/[%_\\]/g, "\\$&")})
        order by (lower(path) = lower(${p})) desc, length(path) limit 1`;
      if (!f) throw new HttpError(404, "File not found");
      return new Response(new Uint8Array(f.data), {
        headers: {
          "Content-Type": f.mime,
          "Cache-Control": "private, max-age=300",
          "X-Content-Type-Options": "nosniff",
          // An uploaded SVG must never run script in our origin.
          "Content-Security-Policy": "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
        },
      });
    }),
    POST: route(async (ctx) => {
      const { vaultId, user } = await vaultCtx(ctx, "editor");
      const form = await ctx.req.formData();
      const file = form.get("file");
      if (!(file instanceof File)) throw new HttpError(400, "No file");
      const path = await saveAttachment(vaultId, user.id, file, String(form.get("folder") ?? "attachments"));
      return { path };
    }),
  },
};
