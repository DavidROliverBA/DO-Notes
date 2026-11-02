// The parts of the graph (src/graph.ts) that need no database, shared with the standalone file,
// which builds the same graph from the folder it has open: which properties are relations, and
// when a note is, for the timeline.

import { findWikiLinks, normaliseTarget } from "./markdown";

/** Properties that aren't relations, even when they hold a link. */
export const NOT_RELATIONS = new Set(["type", "tags", "tag", "aliases", "alias", "id", "cssclasses"]);
export const DAILY = /^Daily\/\d{4}-\d{2}-\d{2}\.md$/;

/** Properties that say when a note is, in the order they're looked for. */
const DATE_KEYS = ["date", "created", "day"];
/** Date properties that say something about a note's subject, not when the note is. */
export const NOT_WHEN = /^(birthday|born|died|anniversary|dob|date of birth)$/i;
const DAY = /^(\d{4}-\d{2}-\d{2})/;

/** A real calendar day from year 1000 on: not 2025-13-01 or 2025-02-30, nor a 0001-01-01
 *  placeholder, which would stretch the timeline across two thousand years. */
const realDay = (d: string) => d >= "1000" && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const isReal = (d: string) => {
  try {
    return realDay(d);
  } catch {
    return false; // Invalid Date
  }
};

/** The day a property's value names ("2025-03-04", or the start of "2025-03-04T09:30"), or null. */
const dayIn = (v: unknown) => {
  const d = typeof v === "string" ? (DAY.exec(v.trim())?.[1] ?? null) : null;
  return d && isReal(d) ? d : null;
};

/** When a note is, for the timeline: a daily note's day, else a date property (date, created, day,
 *  then the type's own: the one it names with `timeline:`, or its first date property that isn't a
 *  birthday), else the day it was made here. */
export function noteWhen(n: { path: string; frontmatter: Record<string, unknown>; made: string }, typeDateProp: string | null): { when: string; whenFrom: "daily" | "property" | "made" } {
  const daily = DAILY.test(n.path) ? /(\d{4}-\d{2}-\d{2})\.md$/.exec(n.path)![1]! : null;
  if (daily && isReal(daily)) return { when: daily, whenFrom: "daily" };
  const fm = Object.fromEntries(Object.entries(n.frontmatter ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  for (const k of [...DATE_KEYS, ...(typeDateProp ? [typeDateProp.toLowerCase()] : [])]) {
    const d = dayIn(fm[k]);
    if (d) return { when: d, whenFrom: "property" };
  }
  return { when: n.made, whenFrom: "made" };
}

/** Link targets in a property's value (a string, or a list of them), normalised as links are. */
export function targetsIn(value: unknown): string[] {
  const parts = Array.isArray(value) ? value : [value];
  return parts.filter((v): v is string => typeof v === "string").flatMap((v) => findWikiLinks(v).map((l) => normaliseTarget(l.target)));
}
