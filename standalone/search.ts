// Search over a folder's notes, for the Search tab and the graph's search scope: every word must
// appear (a #tag must be one of the note's tags); notes with the words in their title come first.

import type { NoteSummary } from "../web/lib/api";
import * as vault from "./vault";

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

export interface Hit {
  n: NoteSummary;
  /** HTML: the text around the first word, the word marked. */
  snippet: string;
}

export function searchNotes(notes: NoteSummary[], query: string, limit = 100): Hit[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: { n: NoteSummary; score: number; snippet: string }[] = [];
  for (const n of notes) {
    const lower = vault.lowerOf(n.id);
    const title = n.title.toLowerCase();
    if (!words.every((w) => (w.startsWith("#") ? n.tags.includes(w.slice(1)) : lower.includes(w) || title.includes(w)))) continue;
    const first = words.find((w) => !w.startsWith("#"));
    const at = first ? lower.indexOf(first) : -1;
    let snippet = "";
    if (at >= 0) {
      const start = Math.max(0, at - 40);
      const raw = (vault.getNote(n.id)?.content ?? "").slice(start, at + 80).replace(/\s+/g, " ");
      snippet = (start ? "…" : "") + escHtml(raw).replace(new RegExp(first!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), (m) => `<mark>${m}</mark>`);
    }
    out.push({ n, score: words.filter((w) => title.includes(w)).length, snippet });
  }
  return out.sort((a, b) => b.score - a.score || b.n.updated_at.localeCompare(a.n.updated_at)).slice(0, limit);
}
