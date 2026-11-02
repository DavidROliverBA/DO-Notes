// Quick capture: links, text and photos shared from the iPhone (an Apple Shortcut in the share
// sheet, docs/IPHONE-SHORTCUT.md) land as to-dos in an inbox note. The Shortcut authenticates
// with a capture token (src/tokens.ts), which can append to its one note and nothing else, apart
// from what those to-dos point at: the photos it saves and the Weblink notes made for links.

import { HttpError } from "./auth";
import { preparePhoto } from "./images";
import { createNote, findByPath, overwriteContent } from "./notes";
import { settings } from "./settings";
import { authenticateToken } from "./tokens";
import { saveAttachment } from "./transfer";
import { setFileText } from "./fileText";
import { saveWeblink } from "./weblinks";
import * as vaults from "./vaults";

const MAX_ITEMS = 10;
const MAX_TEXT = 20_000;
const LONG_TEXT = 1_000; // longer than a note-to-self: likely a whole page

/** The capture token's owner and target; still an editor there (roles change after tokens are made). */
async function authenticate(req: Request) {
  const t = await authenticateToken(req, "capture");
  // A token for "home" follows the person's home collection (F20).
  const vaultId = t.vaultId ?? (await vaults.homeOf(t.user.id));
  if (!vaultId) throw new HttpError(404, "There's no home collection to save to: make one in DO Notes first");
  await vaults.requireRole(vaultId, t.user, "editor");
  return { user: t.user, vaultId, notePath: t.notePath };
}

export interface Shared {
  files: File[];
  /** Each file's words, read on the device (Apple's text and speech recognition): `file_text`,
   *  in the files' order. Kept for search; a voice note's also goes under it in the Inbox. */
  fileTexts: string[];
  texts: string[];
  urls: string[];
  title: string;
}

/**
 * Read what was shared. A form is what the Shortcut sends (docs/IPHONE-SHORTCUT.md): `item` (the
 * share-sheet input as text), `url` (links found in it) and `photo` (images found in it); `text`
 * and `file` work too. JSON ({ text, url, title, items }) and a plain-text body are accepted for
 * scripts and future apps.
 */
async function readShared(req: Request): Promise<Shared> {
  const type = req.headers.get("content-type") ?? "";
  const out: Shared = { files: [], fileTexts: [], texts: [], urls: [], title: "" };
  if (type.includes("multipart/form-data") || type.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    for (const [key, v] of form.entries()) {
      if (typeof v !== "string") {
        const f = v as unknown as File;
        if (f.size > 0) out.files.push(f);
      } else if (key === "title") out.title = v;
      else if (key === "file_text") out.fileTexts.push(v.slice(0, 200_000));
      else if (key === "url") out.urls.push(...v.split(/\s+/).filter((u) => URL_ONLY.test(u)));
      else if (key === "item" || key === "text") out.texts.push(v);
    }
    return out;
  }
  if (type.includes("application/json")) {
    let b: Record<string, unknown>;
    try {
      b = await req.json();
    } catch {
      throw new HttpError(400, "Expected a JSON body");
    }
    if (typeof b.url === "string") out.urls.push(b.url);
    if (typeof b.text === "string") out.texts.push(b.text);
    if (Array.isArray(b.items)) out.texts.push(...b.items.filter((x): x is string => typeof x === "string"));
    if (typeof b.title === "string") out.title = b.title;
    return out;
  }
  out.texts.push(await req.text());
  return out;
}

/**
 * Decide what to write. Photos win: when the Shortcut sends a photo, its text field is just the
 * photo's name. Otherwise each text is kept as written, except that a bare link, or a page's
 * whole text where a link was also found, becomes a tidy [title](url).
 */
export function plan(s: Shared): { files: File[]; lines: string[] } {
  if (s.files.length) return { files: s.files.slice(0, MAX_ITEMS), lines: [] };
  const urls = [...new Set(s.urls)];
  const lines: string[] = [];
  const used = new Set<string>();
  for (const raw of s.texts) {
    const text = raw.trim();
    if (!text) continue;
    if (URL_ONLY.test(text)) {
      lines.push(linkFor(text, s.title));
      used.add(text);
    } else if (urls.length && text.length > LONG_TEXT) {
      continue; // a web page's full text: the link below stands for it
    } else {
      lines.push(text.slice(0, MAX_TEXT));
      for (const u of urls) if (text.includes(u)) used.add(u);
    }
  }
  for (const u of urls) if (!used.has(u)) lines.push(linkFor(u, s.title));
  return { files: [], lines: lines.slice(0, MAX_ITEMS) };
}

const URL_ONLY = /^https?:\/\/\S+$/i;

/** "11 Oct 08:45" in the server's time zone (ICU wording varies, so build it from parts). */
function when(d = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: settings.timeZone, day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("day")} ${get("month")} ${get("hour")}:${get("minute")}`;
}

/** One captured thing as a to-do line; extra lines are indented so they stay in the item. */
export function entryFor(content: string, at: string): string {
  const [first, ...rest] = content.split("\n");
  return [`- [ ] ${first} · ${at}`, ...rest.map((l) => (l.trim() ? `  ${l}` : ""))].join("\n");
}

export function linkFor(url: string, title: string): string {
  let label = title.trim();
  if (!label) {
    try {
      const u = new URL(url);
      label = (u.hostname.replace(/^www\./, "") + u.pathname.replace(/\/$/, "")).slice(0, 80);
    } catch {
      label = url;
    }
  }
  const safe = url.replace(/[()\s]/g, (c) => (c === "(" ? "%28" : c === ")" ? "%29" : "%20"));
  return `[${label.replace(/[[\]]/g, "")}](${safe})`;
}

/** Append `entries` to the inbox text, keeping one blank line before the list. */
export function appendEntries(current: string, entries: string[]): string {
  const base = current.replace(/\s+$/, "");
  const lastLine = base.split("\n").pop() ?? "";
  const sep = base === "" ? "" : /^\s*- /.test(lastLine) || /^\s{2}\S/.test(lastLine) ? "\n" : "\n\n";
  return `${base}${sep}${entries.join("\n")}\n`;
}

/** POST /api/capture: authenticate the capture token, save what was shared, append it to the inbox. */
export async function capture(req: Request): Promise<{ ok: true; message: string; note: { id: number; path: string }; added: number }> {
  const { user, vaultId, notePath } = await authenticate(req);
  const shared = await readShared(req);
  const { files, lines } = plan(shared);
  if (!files.length && !lines.length) throw new HttpError(400, "Nothing to save: share a link, some text or a photo");

  const at = when();
  const entries: string[] = [];
  for (const [i, file] of files.entries()) {
    const path = await saveAttachment(vaultId, user.id, await preparePhoto(await named(file)), "attachments");
    const words = (shared.fileTexts[i] ?? "").trim();
    if (words) await setFileText(vaultId, path, words);
    // A voice note's transcript goes under it, quoted, so the Inbox reads without playing it.
    const heard = words && /\.(m4a|mp3|wav|ogg)$/i.test(path) ? `\n> ${words.slice(0, MAX_TEXT).replace(/\n+/g, " ")}` : "";
    entries.push(entryFor(`![[${path}]]${heard}`, at));
  }
  for (const line of lines) {
    // A shared link becomes a Weblink note (title, summary, picture), and the inbox links to it.
    const link = /^\[([^\]]*)\]\((https?:\/\/\S+)\)$/.exec(line);
    if (link) {
      try {
        const w = await saveWeblink(vaultId, user.id, decodeURI(link[2]!), link[1]!);
        entries.push(entryFor(`[[${w.path.replace(/\.md$/, "")}|${w.title}]]`, at));
        continue;
      } catch {
        // an address it may not fetch, or a failure: keep the plain link, as before
      }
    }
    entries.push(entryFor(line, at));
  }

  let note = await findByPath(vaultId, notePath);
  if (!note) {
    const intro = `# ${notePath.replace(/\.md$/, "").split("/").pop()}\n\nShared from your phone. Tick things off as you file them.\n\n`;
    try {
      const created = await createNote(vaultId, user.id, notePath, appendEntries(intro, entries));
      return { ok: true, message: saved(entries.length, created.title), note: { id: created.id, path: created.path }, added: entries.length };
    } catch (e) {
      // Two shares at once: the other one created it; append to it instead.
      if (!(e instanceof HttpError && e.status === 409)) throw e;
      note = await findByPath(vaultId, notePath);
      if (!note) throw e;
    }
  }
  await overwriteContent(note.id, (cur) => appendEntries(cur, entries), user.id);
  return { ok: true, message: saved(entries.length, note.path.replace(/\.md$/, "").split("/").pop()!), note: { id: note.id, path: note.path }, added: entries.length };
}

const EXT: Record<string, string> = { "image/jpeg": "jpg", "image/png": "png", "image/heic": "heic", "image/gif": "gif", "image/webp": "webp", "application/pdf": "pdf", "video/quicktime": "mov", "video/mp4": "mp4", "audio/mp4": "m4a", "audio/x-m4a": "m4a" };

/** The file's type from its first bytes, for uploads that arrive without a name or type. */
function sniff(b: Uint8Array): string | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b[0] === 0x89 && ascii(1, 4) === "PNG") return "png";
  if (ascii(0, 3) === "GIF") return "gif";
  if (ascii(0, 4) === "%PDF") return "pdf";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "webp";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (/^(heic|heix|mif1|msf1)$/.test(brand)) return "heic";
    if (brand.startsWith("qt")) return "mov";
    if (/^M4A/.test(brand)) return "m4a";
    return "mp4";
  }
  return null;
}

/** Shortcuts sometimes send a photo as "image" or "file" with no extension: name it by its type. */
async function named(file: File): Promise<File> {
  if (/\.[a-z0-9]{2,4}$/i.test(file.name)) return file;
  const ext = EXT[file.type.split(";")[0]!.trim()] ?? sniff(new Uint8Array(await file.slice(0, 16).arrayBuffer())) ?? "bin";
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  // Copy the bytes: wrapping the File itself sometimes keeps its old name in Bun.
  return new File([await file.arrayBuffer()], `${file.name && file.name !== "blob" ? file.name : `Shared ${stamp}`}.${ext}`, { type: file.type });
}

const saved = (n: number, where: string) => `Saved ${n === 1 ? "it" : `${n} items`} to ${where}`;
