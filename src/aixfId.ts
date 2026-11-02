// AI-XF ids (F9 step 1): the stable name a note keeps for ever, whatever it's called later. Shared
// with the browser. The rule is Longview's, the spec's strictest reading: lowercase words joined
// by "-" (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), unique in the collection, never changed once given.

export const ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** "Café table & chairs" → "cafe-table-and-chairs"; "" if nothing Latin is left. */
export function kebabId(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80)
    .replace(/-+$/, "");
}

/** A short, stable hash for titles with no Latin letters ("日本の庭" → "note-3f9a1c"). */
function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (const ch of s) h = Math.imul(h ^ ch.codePointAt(0)!, 0x01000193) >>> 0;
  return h.toString(16).padStart(8, "0").slice(0, 6);
}

/** An id for a title, not one of `taken` (lowercase): "plan", then "plan-2", "plan-3". */
export function idFor(title: string, taken: Set<string>): string {
  const base = kebabId(title) || `note-${shortHash(title)}`;
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

/** "Untitled", "Untitled 3": a new note not yet named, which gets its id when it is. */
export const isUntitled = (title: string) => /^untitled( \d+)?$/i.test(title.trim());
