// Landscapes from Floe, kept up to date (F41, docs/design/F41.md): the pure part. Every part of a
// brought-in note belongs to Floe or to the person, and an update only ever rewrites Floe's:
//
//   - Floe's keys: the frontmatter keys its folder-of-notes export writes (FLOE_KEYS, and any other
//     key the export writes), plus `floe-landscape`, which DO Notes adds so a note can be found again.
//   - Floe's region: the body between `<!-- floe -->` and `<!-- /floe <hash> -->`.
//
// Everything else is the person's and is kept as written. The end marker carries a short hash of
// Floe's part as it was written, so the next update can tell whether the person changed it (Floe
// wins, and the preview names the note). The markers are HTML comments: other editors hide them.
// No server imports: the tests run this directly.

export const FLOE_KEYS = [
  "type",
  "technologies",
  "tags",
  "owner",
  "status",
  "external",
  "classification",
  "personal-data",
  "payment-data",
  "criticality",
  "part-of",
  "floe-id",
  "floe-landscape",
];
/** The overview note's keys: what it is, which landscape, when it was last updated and from what. */
export const OVERVIEW_KEYS = ["type", "floe-landscape", "floe-updated", "floe-hash"];

export const OPEN = "<!-- floe -->";
const REGION = /<!-- floe -->[ \t]*\n?([\s\S]*?)\n?<!-- \/floe(?:[ \t]+([0-9a-z]+))?[ \t]*-->/;
const FM = /^---\r?\n([\s\S]*?)\r?\n?---[ \t]*(?:\r?\n|$)/;
const KEY = /^(?:"([^"]+)"|'([^']+)'|([^\s#'"-][^:]*?))[ \t]*:(?:[ \t]|$)/;

interface Entry {
  key: string | null;
  text: string;
}

/** Frontmatter as top-level entries: a key's line with the indented or list lines under it. */
export function entries(yaml: string): Entry[] {
  const out: Entry[] = [];
  for (const line of yaml.split(/\r?\n/)) {
    const m = KEY.exec(line);
    if (m) out.push({ key: (m[1] ?? m[2] ?? m[3])!.trim(), text: line });
    else if (out.length && out[out.length - 1]!.key && (/^[ \t]/.test(line) || /^-(\s|$)/.test(line)) && line.trim()) out[out.length - 1]!.text += "\n" + line;
    else if (line.trim()) out.push({ key: null, text: line });
  }
  return out;
}

function split(md: string): { yaml: string; body: string } {
  const m = FM.exec(md);
  return m ? { yaml: m[1]!, body: md.slice(m[0].length) } : { yaml: "", body: md };
}

/** FNV-1a, 32 bits, as 8 hex digits: short enough for a marker, enough to notice a change. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** A value as a YAML scalar, quoted unless it's plainly a word, a date or an id. */
export function scalar(v: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  return /^[A-Za-z0-9][\w.:-]*$/.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) && !/^[\d.e+-]+$/i.test(v) ? v : JSON.stringify(v);
}

/** Floe's part, as text to hash: its keys (sorted, so moving one doesn't count) and its region. */
function partText(keys: string[], region: string): string {
  return [...keys.map((k) => k.trim())].sort().join("\n") + "\n\n" + region.trim();
}

const block = (region: string, hash: string) => `${OPEN}\n${region.trim() ? region.trim() + "\n" : ""}<!-- /floe ${hash} -->`;

export interface Merged {
  content: string;
  /** The person had changed Floe's part since the last update, and Floe's now replaces it. */
  edited: boolean;
  /** The note had no Floe region yet (an earlier plain import): Floe's text went on top, and what
   *  was there is kept below it. */
  adopted: boolean;
  /** It has writing or properties of the person's own, which the update kept. */
  personal: boolean;
}

/**
 * A note as Floe's file says, keeping the person's keys and writing from `cur` (null: a new note).
 * `extra` are keys DO Notes adds (`floe-landscape`, and the overview's date and hash); `owned` are the
 * keys that are Floe's even when this file doesn't write them (so a key Floe dropped goes too).
 */
export function mergeNote(cur: string | null, floe: string, extra: Record<string, string> = {}, owned: string[] = FLOE_KEYS): Merged {
  const f = split(floe.replace(/\r\n/g, "\n"));
  const fe = entries(f.yaml).filter((e) => e.key && !(e.key in extra));
  const floeLines = [...fe.map((e) => e.text), ...Object.entries(extra).map(([k, v]) => `${k}: ${scalar(v)}`)];
  const ours = new Set([...owned, ...fe.map((e) => e.key!), ...Object.keys(extra)]);
  const region = f.body.trim();
  const hash = shortHash(partText(floeLines, region));
  if (cur === null) return { content: `---\n${floeLines.join("\n")}\n---\n${block(region, hash)}\n`, edited: false, adopted: false, personal: false };

  const c = split(cur.replace(/\r\n/g, "\n"));
  const ce = entries(c.yaml);
  const theirs = ce.filter((e) => e.key && ours.has(e.key));
  const mine = ce.filter((e) => !(e.key && ours.has(e.key)));
  const yaml = [...floeLines, ...mine.map((e) => e.text)].join("\n");
  const m = REGION.exec(c.body);
  let body: string;
  let edited = false;
  let adopted = false;
  let outside: string;
  if (m) {
    const was = partText(
      theirs.map((e) => e.text),
      m[1]!,
    );
    edited = !!m[2] && shortHash(was) !== m[2] && was !== partText(floeLines, region);
    body = c.body.slice(0, m.index) + block(region, hash) + c.body.slice(m.index + m[0].length);
    outside = c.body.slice(0, m.index) + c.body.slice(m.index + m[0].length);
  } else {
    // An earlier plain import: Floe's text on top, what was there below, unless it's only Floe's.
    const rest = c.body.trim();
    adopted = rest !== "" && rest !== region;
    body = block(region, hash) + (adopted ? `\n\n${rest}` : "");
    outside = adopted ? rest : "";
  }
  const content = `---\n${yaml}\n---\n${body.replace(/^\n+/, "").replace(/\s*$/, "")}\n`;
  return { content, edited, adopted, personal: mine.length > 0 || outside.trim() !== "" };
}

/** Floe's keys and region of a note, if it has a region: for the out-of-date check and tests. */
export function regionOf(md: string): string | null {
  const m = REGION.exec(split(md).body);
  return m ? m[1]!.trim() : null;
}

/**
 * An object removed from Floe: the note stays, with `status: removed` and a line at the top of its
 * region saying when. The person's writing is untouched; nothing is deleted.
 */
export function markRemoved(cur: string, day: string): string {
  const c = split(cur.replace(/\r\n/g, "\n"));
  const ce = entries(c.yaml);
  const at = ce.findIndex((e) => e.key === "status");
  const status = { key: "status", text: "status: removed" };
  if (at >= 0) ce[at] = status;
  else ce.push(status);
  const theirs = ce.filter((e) => e.key && FLOE_KEYS.includes(e.key)).map((e) => e.text);
  const m = REGION.exec(c.body);
  const said = `_Removed from Floe on ${day}._`;
  let body: string;
  if (m) {
    const region = /^_Removed from Floe on /.test(m[1]!.trim()) ? m[1]!.trim() : `${said}\n\n${m[1]!.trim()}`.trim();
    body = c.body.slice(0, m.index) + block(region, shortHash(partText(theirs, region))) + c.body.slice(m.index + m[0].length);
  } else {
    body = block(said, shortHash(partText(theirs, said))) + "\n\n" + c.body.trim();
  }
  return `---\n${ce.map((e) => e.text).join("\n")}\n---\n${body.replace(/^\n+/, "").replace(/\s*$/, "")}\n`;
}

/** Is it already marked removed? */
export const isRemoved = (fm: Record<string, unknown>) => String(fm.status ?? "") === "removed";

/** "3 Nov 2026", as people read it. */
export function dayLabel(d: Date): string {
  return d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Europe/London" });
}

/** A Floe file's path without its landscape folder: "Payments/Payments API/Ledger.md" → "Payments API/Ledger.md". */
export const insideLandscape = (path: string) => path.slice(path.indexOf("/") + 1);
