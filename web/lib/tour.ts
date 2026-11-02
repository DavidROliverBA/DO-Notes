// The guided tour: a step at a time over the real screen, each step pointing at the thing it
// talks about (web/ui/Tour.tsx draws it). Two paths, laptop and iPhone, and "What's new": the
// steps for features added since this device last looked. Every step is listed here, so a new
// feature adds its step (with `since`, its release) and appears in What's new by itself.
//
// Offered once, on the collection's home page; then from Help, ⌘K "Take the tour" and "What's
// new". What's been seen is kept on this device (cp:tour), never in a note.

import { useSyncExternalStore } from "react";
import pkg from "../../package.json" with { type: "json" };
import { inIPhoneApp } from "./iphoneApp";

export const APP_VERSION: string = pkg.version;

/** What a step may do first: open a note, show a panel. Supplied by App. */
export interface TourEnv {
  narrow: boolean;
  /** Open the most recently changed note; false if there's none. */
  openRecentNote(): Promise<boolean>;
  showLeft(open: boolean): void;
  showRight(open: boolean): void;
  home(): void;
  /** Put the panels back as they were before the tour. */
  finish(): void;
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** What to point at; none (or not on screen) puts the card in the middle. */
  target?: string;
  /** Laptop, phone, or both (the default). */
  on?: "laptop" | "phone";
  /** Only when this holds (for example, not already on the Home Screen). */
  when?: (env: TourEnv) => boolean;
  /** Run before the step shows; may open a note or a panel. */
  before?: (env: TourEnv) => Promise<unknown> | void;
  /** The release that added it: What's new shows steps newer than this device has seen. */
  since?: string;
}

const onNote = (env: TourEnv) => env.openRecentNote();
const inHomeScreenApp = () => inIPhoneApp() || matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;

export const TOUR: TourStep[] = [
  {
    id: "welcome",
    title: "Welcome to DO Notes",
    body: "A quick look round: about a minute. **Next** and **Back** move through it, and Escape stops. You can take it again any time from Help or ⌘K.",
  },
  {
    id: "home-screen",
    on: "phone",
    when: () => !inHomeScreenApp(),
    title: "Put it on your Home Screen",
    body: "In Safari, tap **Share**, then **Add to Home Screen**. Opened from its icon, DO Notes has the whole screen, with no address bar, and works best offline. Using Safari instead? Settings → Apps → Safari → Tabs → **Top** keeps the address bar out of the way of the keyboard.",
  },
  {
    id: "make",
    on: "laptop",
    before: (env) => env.showLeft(true),
    target: ".sidebar .sidebar-actions",
    title: "Make something",
    body: "**New** note, a folder, **Today** for today's journal entry, and the **Graph** of how your notes link up.",
  },
  {
    id: "files",
    before: (env) => env.showLeft(!env.narrow),
    target: '.sidebar-scroll, button[aria-label="Files"]',
    title: "Your notes",
    body: "Folders, your **types** (Person, Meeting…) and **Tasks** and **Journal** pages. Drag a note onto a folder to move it.",
  },
  {
    id: "find",
    on: "phone",
    target: "button.fab",
    title: "Find a note",
    body: "Search by name, or type a new name to make that note.",
  },
  {
    id: "note",
    before: onNote,
    target: ".note-view .note-title-wrap",
    title: "A note",
    body: "Click the title to rename it; links to it follow. Above it, the folder it's in.",
  },
  {
    id: "properties",
    before: onNote,
    target: ".note-view .cm-lp-props",
    title: "Properties",
    body: "What the note is (its **type**), its tags, dates and links to other notes. **Add relationship…** says how it relates to another: part of, depends on, supersedes.",
  },
  {
    id: "writing",
    before: onNote,
    target: ".note-view .cm-content",
    title: "Writing",
    body: "Type **/** for headings, tables, callouts and more; **[[** to link a note; **#** for a tag; **//** for a date. Select words for bold, links and colour. Rest on a heading for **›** to fold it away.",
  },
  {
    id: "format-bar",
    on: "phone",
    before: onNote,
    target: ".format-bar",
    title: "The bar above the keyboard",
    body: "Links, tags, bold, colour, a picture, a task. The ˄ ˅ ✓ bar under it is the iPhone's own: a web page can't hide it.",
  },
  {
    id: "views",
    before: onNote,
    target: '.note-view .segmented[aria-label="View"], .note-view button[aria-label="Reading view"], .note-view button[aria-label="Edit"]',
    title: "Ways to see it",
    body: "Live Preview as you write, the plain Markdown, side by side, or **reading view**.",
  },
  {
    id: "width",
    on: "laptop",
    before: onNote,
    target: 'button[aria-label="Full-width editor"]',
    title: "Room to write",
    body: "Let notes fill the space between the panels. They follow the panels as you open, close or drag them.",
    since: "0.0.65",
  },
  {
    id: "more",
    before: onNote,
    target: '.note-view button[aria-label="More"]',
    title: "Everything about this note",
    body: "Version history, an icon and cover picture, move, download, bookmark, and Trash.",
  },
  {
    id: "side",
    before: (env) => (env.narrow ? undefined : env.showRight(true)),
    target: '.right-panel .right-tabs, button[aria-label="Side panel"]',
    title: "Links, graph and AI",
    body: "What links here, what this links to, the outline, notes like this one, the note's corner of the graph, and your AI assistant (⌘J).",
  },
  {
    id: "help",
    on: "laptop",
    target: '.sidebar-foot button[aria-label="Help"]',
    before: (env) => env.showLeft(true),
    title: "Help",
    body: "How each part works, the keyboard shortcuts, and this tour again.",
  },
  {
    id: "commands",
    title: "One more thing: ⌘K",
    body: "Every action is in **⌘K** (or **⌘P**), and **⌘O** finds a note. On the iPhone, the **⋯** menus have the same. That's the tour.",
  },
];

/** What's new: one step per release's headline, each pointing where it lives. */
export const WHATS_NEW: TourStep[] = [
  { id: "new-rel", since: "0.0.62", before: onNote, target: ".note-view .cm-lp-props", title: "Relationships", body: "**Add relationship…** under the properties says how this note relates to another (part of, depends on, supersedes), and the other note shows it the other way round." },
  { id: "new-blocks", since: "0.0.63", before: onNote, target: ".note-view .cm-content", title: "Writing blocks", body: "Callouts that fold (`> [!note]-`), status labels (`/status`), a table of contents (`[TOC]`) and `//` for a date." },
  { id: "new-look", since: "0.0.64", before: onNote, target: '.note-view button[aria-label="More"]', title: "Icons, covers and link cards", body: "**Icon…**, **Cover picture…** and **Wide page** are in ⋯. `:rocket` types an emoji, and a web address on its own line shows as a card." },
  { id: "new-width", since: "0.0.65", on: "laptop", before: onNote, target: 'button[aria-label="Full-width editor"]', title: "Full-width editor", body: "Notes can fill the space between the panels." },
  { id: "new-r1", since: "0.0.66", before: onNote, target: ".note-view .cm-content", title: "Writing, smoother", body: "`[[Note#` lists its headings, code is coloured with a Copy button, a click on a picture shows it large, notes reopen where you left them, and the word count is at the bottom." },
  { id: "new-r2", since: "0.0.67", on: "laptop", before: onNote, target: ".note-view .cm-content", title: "Folding and previews", body: "Rest on a heading for **›** to fold it, or on a `[[link]]` to see that note without leaving this one." },
  { id: "new-r3", since: "0.0.68", on: "laptop", before: onNote, target: ".note-view .cm-content", title: "The format bar", body: "Select words for bold, italic, highlight, code, a link and colour; ⌘B, ⌘I, ⌘⇧X and ⌘E too." },
  { id: "new-tour", since: "0.0.69", title: "This tour", body: "Take the whole tour any time from Help or ⌘K **Take the tour**; What's new shows up after each release." },
  { id: "new-tables", since: "0.0.71", before: onNote, target: ".note-view .cm-content", title: "Easier tables", body: "Click a cell for **Row** and **Column** menus: insert, move, delete and **sort**. Paste cells copied from a spreadsheet to make a table, or to fill one." },
];

/** Compare dotted versions: negative when a is older. */
export function versionCompare(a: string, b: string): number {
  const x = a.split(".").map(Number);
  const y = b.split(".").map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

export function stepsFor(kind: "full" | "new", env: TourEnv, seen: string | null): TourStep[] {
  const device = env.narrow ? "phone" : "laptop";
  const fits = (s: TourStep) => (!s.on || s.on === device) && (!s.when || s.when(env));
  if (kind === "full") return TOUR.filter(fits);
  const all = WHATS_NEW.filter(fits);
  const fresh = all.filter((s) => !seen || versionCompare(s.since ?? "0", seen) > 0);
  // Nothing new since you looked: the latest few, so What's new always shows something.
  return fresh.length ? fresh : all.slice(-3);
}

// ── What this device has seen ─────────────────────────────────────────────────────────────
const KEY = "cp:tour";
interface Seen {
  /** Taken or turned down: don't offer the tour again. */
  done: boolean;
  /** The release whose What's new has been seen (or dismissed). */
  version: string;
}
function readSeen(): Seen | null {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return null;
  }
}
/** Take it or turn it down: the tour isn't offered again, and What's new starts from here. */
export function markSeen(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ done: true, version: APP_VERSION } satisfies Seen));
  } catch {}
  emit();
}

/** What the home page offers: the tour (never seen), What's new (seen, and newer steps), or nothing. */
export function offer(narrow: boolean): "tour" | "new" | null {
  const s = readSeen();
  if (!s?.done) return "tour";
  return WHATS_NEW.some((w) => versionCompare(w.since ?? "0", s.version) > 0 && (!w.on || w.on === (narrow ? "phone" : "laptop"))) ? "new" : null;
}
export const seenVersion = () => readSeen()?.version ?? null;

// ── The running tour ──────────────────────────────────────────────────────────────────────
export interface Running {
  steps: TourStep[];
  at: number;
  env: TourEnv;
}
let running: Running | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function startTour(kind: "full" | "new", env: TourEnv): void {
  const steps = stepsFor(kind, env, seenVersion());
  if (!steps.length) return;
  running = { steps, at: 0, env };
  emit();
}
export function goTo(at: number): void {
  if (!running) return;
  if (at >= running.steps.length) return endTour();
  running = { ...running, at: Math.max(0, at) };
  emit();
}
export function endTour(): void {
  if (!running) return;
  const { env } = running;
  running = null;
  env.finish();
  markSeen();
}
export const useTour = () =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => running,
  );
export const useTourOffer = (narrow: boolean) =>
  useSyncExternalStore(
    (l) => (listeners.add(l), () => void listeners.delete(l)),
    () => offer(narrow),
  );
