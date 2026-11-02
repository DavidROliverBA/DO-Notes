// Weblinks as notes (from Capacities): a link shared from the iPhone, or saved with ⌘K, becomes a
// Weblink note with the page's title, description, site and picture, so a saved article can be
// tagged, linked, searched and found again like anything else.
//
// The server fetches pages people send it, so it must never be turned against things only it can
// reach: only http(s) on the usual ports, never a private, loopback, link-local or metadata
// address (checked again at every redirect), and small limits on time and size. The connection goes
// to the address that was checked, not to a fresh lookup (src/egress.ts), so DNS rebinding can't
// slip a private address in between.

import { HttpError } from "./auth";
import { sql } from "./db";
import { bareHost, EgressError, pinnedFetch, type Resolve, vetAddresses } from "./egress";
import { preparePhoto } from "./images";
import { normalisePath } from "./markdown";
import * as notes from "./notes";
import { settings } from "./settings";
import { saveAttachment } from "./transfer";
import { listTypes } from "./typeIndex";
import { STARTERS, starterNote, TYPES_FOLDER } from "./types";

const TIMEOUT_MS = 8_000;
const MAX_HTML = 1_500_000;
const MAX_IMAGE = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

// ── fetching safely ───────────────────────────────────────────────────────────────────────

/** Tests serve their pages from this machine; nothing else should ever set this. */
const allowLocal = () => process.env.WEBLINKS_ALLOW_LOCAL === "true";

/** What fetching can be given in tests: the resolver, and fetch itself. */
export interface FetchDeps {
  resolve?: Resolve;
  fetch?: (input: string, init: BunFetchRequestInit) => Promise<Response>;
}

/** A link the server may fetch, and the checked addresses to fetch it from (src/egress.ts): the
 *  name is resolved here, once, and the connection goes to these addresses, never to a second
 *  lookup's answer (DNS rebinding). */
async function checkUrl(raw: string, deps: FetchDeps = {}): Promise<{ url: URL; addresses: string[] }> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new HttpError(400, "That isn't a web address");
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new HttpError(400, "Only http and https links can be opened");
  if (u.username || u.password) throw new HttpError(400, "Links with a name and password in them can't be opened");
  const local = allowLocal(); // tests serve their pages from this machine
  if (!local && u.port && u.port !== "80" && u.port !== "443") throw new HttpError(400, "Only links on the usual web ports can be fetched");
  if (!local && /^localhost$|\.localhost$|\.local$|\.internal$/i.test(bareHost(u))) throw new HttpError(400, "That address isn't on the public web");
  try {
    return { url: u, addresses: await vetAddresses(u, { allowPrivate: local, resolve: deps.resolve }) };
  } catch (e) {
    if (e instanceof EgressError) throw new HttpError(400, e.message);
    throw e;
  }
}

/** Fetch a public URL, following a few redirects, each resolved, checked and pinned again. */
export async function safeFetch(raw: string, accept: string, deps: FetchDeps = {}): Promise<{ res: Response; url: URL }> {
  let { url, addresses } = await checkUrl(raw, deps);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    // Tests never reach the internet: only their own pages on this machine are fetched.
    if (allowLocal() && !["localhost", "127.0.0.1"].includes(url.hostname)) throw new Error("tests don't fetch the internet");
    const res = await pinnedFetch(
      url,
      addresses,
      {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { accept, "user-agent": "Mozilla/5.0 (compatible; DO Notes; +https://github.com/DavidROliverBA/commonplace-md)", "accept-language": "en-GB,en;q=0.8" },
      },
      deps.fetch,
    );
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      void res.body?.cancel();
      ({ url, addresses } = await checkUrl(new URL(res.headers.get("location")!, url).toString(), deps));
      continue;
    }
    return { res, url };
  }
  throw new HttpError(400, "That link redirects too many times");
}

export async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      void reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(Math.min(size, max));
  let o = 0;
  for (const c of chunks) {
    out.set(c.subarray(0, out.length - o), o);
    o += c.length;
    if (o >= out.length) break;
  }
  return out;
}

// ── reading a page ────────────────────────────────────────────────────────────────────────

export interface PageMeta {
  title: string;
  description: string;
  site: string;
  image: string | null;
  url: string;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", hellip: "…", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", pound: "£" };
export const decodeEntities = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
    e[0] === "#" ? String.fromCodePoint(e[1]!.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : Number(e.slice(1))) : (ENTITIES[e.toLowerCase()] ?? m),
  );
const clean = (s: string | undefined | null) => decodeEntities((s ?? "").replace(/\s+/g, " ")).trim();

/** Title, description, site and picture from a page's <head>, Open Graph first. */
export function parseMeta(html: string, pageUrl: string): PageMeta {
  const head = html.slice(0, 300_000);
  const metas = [...head.matchAll(/<meta\b[^>]*>/gi)].map((m) => m[0]);
  const attr = (tag: string, name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag)?.slice(1).find((x) => x !== undefined);
  const meta = (...keys: string[]) => {
    for (const k of keys) {
      const tag = metas.find((t) => (attr(t, "property") ?? attr(t, "name") ?? "").toLowerCase() === k);
      const v = tag && attr(tag, "content");
      if (v && v.trim()) return v;
    }
    return undefined;
  };
  const u = new URL(pageUrl);
  const titleTag = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1];
  const abs = (v?: string) => {
    if (!v) return null;
    try {
      const x = new URL(decodeEntities(v.trim()), pageUrl);
      return x.protocol === "http:" || x.protocol === "https:" ? x.toString() : null;
    } catch {
      return null;
    }
  };
  return {
    title: clean(meta("og:title", "twitter:title") ?? titleTag).slice(0, 200) || u.hostname.replace(/^www\./, ""),
    description: clean(meta("og:description", "description", "twitter:description")).slice(0, 500),
    site: clean(meta("og:site_name", "application-name")).slice(0, 100) || u.hostname.replace(/^www\./, ""),
    image: abs(meta("og:image:secure_url", "og:image", "twitter:image", "twitter:image:src")),
    url: abs(meta("og:url")) && new URL(abs(meta("og:url"))!).hostname === u.hostname ? abs(meta("og:url"))! : pageUrl,
  };
}

/** What a page says about itself. Never throws for an unreachable page: it still gets a note. */
export async function pageMeta(raw: string): Promise<PageMeta> {
  const fallback = (url: string): PageMeta => {
    const u = new URL(url);
    return { title: (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).slice(0, 120), description: "", site: u.hostname.replace(/^www\./, ""), image: null, url };
  };
  const { res, url } = await safeFetch(raw, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5");
  if (!res.ok || !(res.headers.get("content-type") ?? "").includes("html")) {
    void res.body?.cancel();
    return fallback(url.toString());
  }
  const html = new TextDecoder().decode(await readCapped(res, MAX_HTML));
  return parseMeta(html, url.toString());
}

async function fetchImage(raw: string, title: string): Promise<File | null> {
  try {
    const { res } = await safeFetch(raw, "image/avif,image/webp,image/png,image/jpeg,image/*;q=0.8");
    const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim();
    if (!res.ok || !/^image\/(jpeg|png|gif|webp|avif)$/.test(type)) {
      void res.body?.cancel();
      return null;
    }
    const bytes = await readCapped(res, MAX_IMAGE + 1);
    if (bytes.length > MAX_IMAGE) return null;
    const ext = type.split("/")[1]!.replace("jpeg", "jpg");
    const name = `${title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60) || "Weblink"}.${ext}`;
    return new File([bytes as Uint8Array<ArrayBuffer>], name, { type });
  } catch {
    return null;
  }
}

// ── saving ────────────────────────────────────────────────────────────────────────────────

const yamlString = (s: string) => JSON.stringify(s);

/** The Weblink type, made from its starter the first time a link is saved. */
async function ensureWeblinkType(vaultId: number, userId: number): Promise<void> {
  if ((await listTypes(vaultId)).types.some((t) => t.name.toLowerCase() === "weblink")) return;
  const s = STARTERS.find((x) => x.name === "Weblink")!;
  try {
    await notes.createNote(vaultId, userId, `${TYPES_FOLDER}/Weblink`, starterNote(s));
  } catch (e) {
    if (!(e instanceof HttpError && e.status === 409)) throw e; // made at the same moment
  }
}

/** Save a link as a Weblink note, or return the one that already has this address. */
export async function saveWeblink(vaultId: number, userId: number, raw: string, sharedTitle = ""): Promise<{ id: number; path: string; title: string; existed: boolean }> {
  const url = (await checkUrl(raw.trim())).url.toString();
  const [dup] = await sql`select id, path, title from notes where vault_id = ${vaultId} and lower(type_name) = 'weblink' and frontmatter->>'url' = ${url} limit 1`;
  if (dup) return { id: Number(dup.id), path: dup.path, title: dup.title, existed: true };
  await ensureWeblinkType(vaultId, userId);

  let meta: PageMeta;
  try {
    meta = await pageMeta(url);
  } catch (e) {
    if (e instanceof HttpError && e.status === 400) throw e; // not a public address: refuse, don't save
    const u = new URL(url);
    meta = { title: sharedTitle.trim() || u.hostname.replace(/^www\./, ""), description: "", site: u.hostname.replace(/^www\./, ""), image: null, url };
  }
  // Keep where the link really leads (a shortened or old link redirects), and don't save it twice.
  const final = meta.url || url;
  if (final !== url) {
    const [again] = await sql`select id, path, title from notes where vault_id = ${vaultId} and lower(type_name) = 'weblink' and frontmatter->>'url' = ${final} limit 1`;
    if (again) return { id: Number(again.id), path: again.path, title: again.title, existed: true };
  }
  const title = (meta.title || sharedTitle).replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100) || "Weblink";
  const path = await notes.freeNotePath(vaultId, normalisePath(`Weblinks/${title}`));
  let picture = "";
  if (meta.image) {
    const file = await fetchImage(meta.image, title);
    if (file) {
      try {
        picture = await saveAttachment(vaultId, userId, await preparePhoto(file), "attachments/weblinks");
      } catch {}
    }
  }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: settings.timeZone }).format(new Date());
  const content = [
    "---",
    "type: Weblink",
    `url: ${yamlString(final)}`,
    `site: ${yamlString(meta.site)}`,
    ...(meta.description ? [`description: ${yamlString(meta.description)}`] : []),
    `saved: ${today}`,
    "---",
    `# ${title}`,
    "",
    ...(picture ? [`![[${picture}]]`, ""] : []),
    ...(meta.description ? [`> ${meta.description}`, ""] : []),
    `[Open ${meta.site}](${final.replace(/[()\s]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : "%20"))})`,
    "",
    "## Notes",
    "",
  ].join("\n");
  const n = await notes.createNote(vaultId, userId, path, await notes.withNewId(vaultId, path, content));
  return { id: n.id, path: n.path, title: n.title, existed: false };
}

// ── link cards (F28) ──────────────────────────────────────────────────────────────────────
//
// A web address on a line of its own shows as a card: what the page says about itself, fetched
// as safely as a weblink and kept for a day (a few hundred pages), so a note full of them
// doesn't fetch each one every time it's opened.

const CARD_TTL_MS = 24 * 3600_000;
const CARD_MAX = 500;
const cards = new Map<string, { at: number; meta: Promise<PageMeta | null> }>();

export function linkCard(raw: string): Promise<PageMeta | null> {
  let url: string;
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    url = u.toString();
  } catch {
    throw new HttpError(400, "That isn't a web address");
  }
  const hit = cards.get(url);
  if (hit && Date.now() - hit.at < CARD_TTL_MS) return hit.meta;
  const meta = pageMeta(url).catch(() => null);
  cards.delete(url);
  cards.set(url, { at: Date.now(), meta });
  while (cards.size > CARD_MAX) cards.delete(cards.keys().next().value!);
  return meta;
}
