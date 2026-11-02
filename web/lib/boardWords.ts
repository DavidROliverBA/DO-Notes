// A board in words (F31): what a card is called and what an arrow says, for the arrows list,
// the picker that draws an arrow without dragging, and what a screen reader hears.

import type { CanvasItem } from "../../src/canvas";

/** What a card is called in a sentence: the note's title, the group's name, the first words. */
export function cardName(item: CanvasItem | undefined, notes: { path: string; title: string }[]): string {
  if (!item) return "a card";
  const file = typeof item.file === "string" ? item.file : "";
  if (file) {
    const note = notes.find((n) => n.path.toLowerCase() === file.toLowerCase());
    return note?.title ?? file.split("/").pop()!.replace(/\.(md|markdown|canvas)$/i, "");
  }
  if (item.type === "group") return typeof item.label === "string" && item.label ? `the group ${item.label}` : "a group";
  if (item.type === "link" && typeof item.url === "string") {
    try {
      return new URL(item.url).hostname.replace(/^www\./, "");
    } catch {
      return item.url;
    }
  }
  const text = typeof item.text === "string" ? item.text.replace(/[#*_`>[\]]/g, "").trim().split("\n")[0]!.trim() : "";
  return text ? (text.length > 40 ? `${text.slice(0, 39)}…` : text) : "an empty text card";
}

/** An arrow in words: "Roof → comes before → Loft", "Roof ↔ Loft", "Roof — Loft". */
export function arrowSentence(e: CanvasItem, byId: Map<string, CanvasItem>, notes: { path: string; title: string }[]): string {
  const from = cardName(byId.get(e.fromNode as string), notes);
  const to = cardName(byId.get(e.toNode as string), notes);
  const head = e.toEnd !== "none";
  const tail = e.fromEnd === "arrow";
  const label = typeof e.label === "string" && e.label.trim() ? e.label.trim() : "";
  if (head && !tail) return label ? `${from} → ${label} → ${to}` : `${from} → ${to}`;
  if (tail && !head) return label ? `${to} → ${label} → ${from}` : `${to} → ${from}`;
  const join = head ? "↔" : "—";
  return label ? `${from} ${join} ${label} ${join} ${to}` : `${from} ${join} ${to}`;
}
